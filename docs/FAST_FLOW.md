# Fast Flow — Nord Pool Scheduling, SoC-Aware Load Balancing

Price and SoC-aware charging for two heterogeneous chargers, with real-time load balancing against the household's main fuse. This is the original core of the system; see [INTEGRATION.md](INTEGRATION.md) for how it now interacts with PV Eco and the shared safety/UI layer.

---

## Architecture

```
Nord Pool prices (HA sensor)
  └─► Parser (on price change) ──► nordpool_slots [flow context]
        └─► Planner Car 1 (every 15 min) ──► car1.allowed_slots
        └─► Planner Car 2 (every 15 min) ──► car2.allowed_slots
              └─► Slots Decoder ──► HA Formatter ──► MQTT ──► HA sensor

Cron trigger (every minute, on the minute — node-red-contrib-cron-plus)
  ├─► Grid sensor (L1/L2/L3) ──► Grid Join ──► MaxAmpsGrid ──┐
  ├─► go-e poll                ──────────────────────────────┤
  └─► Shelly poll (single request) ──► Shelly Assembler ─────┤
                                                             ▼
                                                     Coordinator Join
                                                             │
                                                          LB Gate
                                          automatic │                │ manual
                                                    ▼                ▼
                                               Coordinator      (skip allocation,
                                              /     |      \     clear lb_wants_stop)
                                  go-e amp ──/    diag(3)   \── Shelly amp handler
                                  HTTP → go-e       │            HTTP → Shelly
                                             \      ▼           /
                                              ▼  (debug)       ▼
                                              Evaluator (triggered, not timed)
                                              reads: allowed_map, lb_wants_stop_N,
                                                     ev_carN_boost, ev_fuse_stop
                                              writes: frc for both chargers
                                              ├─► HTTP frc ──► go-e
                                              ├─► Shelly frc handler ──► [1s delay] ──► HTTP frc ──► Shelly
                                              └─► Status Publisher ──► MQTT ──► sensor.ev_charging_status ──► dashboard
```

The Coordinator and Evaluator run **sequentially in the same cycle**, not on independent timers. In automatic LB mode, the Coordinator's third output triggers the Evaluator immediately after `lb_wants_stop` flags are written — zero delay between a load-balancing decision and its enforcement. In manual LB mode the Coordinator is skipped, so the LB Gate's second output triggers the Evaluator directly, ensuring schedule-based charging (frc) still runs every cycle even without load balancing.

The Coordinator's third output also carries a `msg.diag` diagnostics payload — see [Coordinator Diagnostics](#coordinator-diagnostics) below.

### Separation of concerns

| Script | Runs | Owns | Does NOT write |
|--------|------|------|----------------|
| `coordinator.js` | Every minute (cron, automatic LB mode) | `amp` setpoints for both chargers, `lb_wants_stop` flags, `msg.diag` | `frc` |
| `evaluator.js` | Triggered by coordinator or LB gate, same cycle | `frc` for both chargers | `amp` |
| `planner_car1/2.js` | Every 15 min | `car1/2.allowed_slots` | `frc`, `amp` |
| `parser.js` | On price change | `nordpool_slots` | — |
| `lb_gate.js` | Every minute (pre-coordinator) | Routes to coordinator (automatic) or triggers evaluator directly (manual) | — |
| `shelly_assembler.js` | Per Shelly poll (single request) | Normalises Shelly state to go-e shape | — |

The strict ownership model — **evaluator owns `frc`, coordinator owns `amp`** — eliminates the race condition where overload stops could be cancelled prematurely by the scheduler re-enabling the charger.

Since the [car↔charger mapping layer](INTEGRATION.md#car--charger-mapping) was introduced, Coordinator/Evaluator/Planners/Status Publisher all resolve *which car is on which charger* before reading SoC, priority, or plans — this file's diagrams and tables describe the logical roles (car 1's plan, charger 1's current) which the mapping layer keeps correctly paired to physical hardware even when a car is moved between chargers.

---

## Prerequisites

See the [top-level README](../README.md#prerequisites) for the full list. Fast-flow-specific: go-e and Shelly TopAC local HTTP APIs, the 3-phase grid current sensor, and a Nord Pool integration.

---

## Installation

### Step 1 — Home Assistant helpers

Add the contents of `ev_helpers.yaml` to your Home Assistant `configuration.yaml`, either as a package include or pasted directly under the top-level `input_number:` / `input_select:` / `input_text:` keys. Restart Home Assistant.

If you plan to use the custom dashboard cards, also add the mapping and strategy helpers from [INTEGRATION.md](INTEGRATION.md) — the cards read both.

### Step 2 — Nord Pool sensor

The system requires a custom template sensor merging yesterday's, today's, and tomorrow's Nord Pool prices into one array — the Finnish Nord Pool day runs 01:00–01:00 local time, so the 00:00–01:00 slots belong to yesterday's dataset.

Add the contents of `nordpool.yaml` to `configuration.yaml` under the `template:` key. **Update the `config_entry` value** to match your Nord Pool integration config entry ID (Settings → Devices & Services → Nord Pool → Configure). Restart HA and verify `sensor.nordpool_prices` shows a `data` attribute with an array of price slots.

### Step 3 — Import Node-RED flow

1. Install `node-red-contrib-cron-plus` via Manage palette → Install if not already present
2. Node-RED hamburger menu → Import → select `flows_template.json` → Import

### Step 4 — Paste scripts

| Node-RED function node | Script file |
|---|---|
| `Coordinator` | `coordinator.js` |
| `Evaluator` | `evaluator.js` |
| `Planner Car 1` / `Planner Car 2` | `planner_car1.js` / `planner_car2.js` |
| `Nordpool Parser` | `parser.js` |
| `Assembler` | `assembler.js` |
| `LB Gate` | `lb_gate.js` |
| `Shelly Assembler` | `shelly_assembler.js` |
| `Shelly Output Handler` | `shelly_output_amp.js` |
| `Shelly frc Output Handler` | `shelly_output_frc.js` |
| `Slots Decoder` | `debug_slots.js` |
| `HA Formatter` | `ha_formatter.js` |
| `MQTT Discovery` | `mqtt_discovery.js` |
| `Status Publisher` | `ev_status_publisher.js` |

`MaxAmpsGrid` already contains its full script in the template.

**New node for the safety layer** (see [INTEGRATION.md](INTEGRATION.md#fuse-guard)): `Fuse Guard`, wired independently — a 10 s inject → `fuse_guard.js` → direct stop commands + `ev/fuse_guard` MQTT status. Not part of the Assembler → Coordinator → Evaluator chain.

### Step 5 — Update entity IDs and IP addresses

**SoC sensor entity IDs** — update in `planner_car1.js`, `planner_car2.js`, `coordinator.js` (the `CAR_SOC_SENSORS` table), **and** `pyscript/ev_strategy.py` (same table name — see [INTEGRATION.md](INTEGRATION.md), keeping these in sync matters for the SoC-staleness watchdog and Boost end-condition).

**Charger power sensor entity IDs** (`pyscript/ev_strategy.py`, `CHARGER_POWER_SENSORS`) — feeds the [frozen-SoC and mapping-mismatch watchdog](INTEGRATION.md#soc-staleness--availability-handling). Each entry is `(entity_id, unit)` — **the unit is not a formality**: go-e and Shelly-style power sensors commonly disagree (W vs kW), and reading the wrong one is a silent 1000× error that makes a charger look permanently idle to the watchdog, with no error anywhere. `_charger_power_w()` cross-checks the declared unit against Home Assistant's own `unit_of_measurement` and warns once on mismatch — watch the log after changing this. A charger left as `None` (the public-repo default for charger 2) is simply excluded from both watchdogs, not an error.

**Per-car battery capacity** (`pyscript/ev_strategy.py`, `CAR_BATTERY_KWH`) — usable kWh per car, used to convert energy delivered into expected SoC % gain for the same watchdog. Get this wrong and the watchdog's judgement of "behind schedule" is wrong in the same direction — worth setting to your actual usable capacity, not the advertised gross figure.

**Grid sensor entity IDs** — the three `server-state-changed`/`api-current-state` nodes feeding the Grid Join, and the Fuse Guard's own independent read of the same three sensors.

**IP addresses:**

| File | Constant | Notes |
|---|---|---|
| `coordinator.js` | `CHARGER_IPS.c1` | go-e |
| `evaluator.js` | `GOE_C1_IP` | go-e |
| `fuse_guard.js` | `GOE_IP`, `SHELLY_IP` | both — this is the safety path, verify it independently after any network change |
| `shelly_assembler.js`, `shelly_output_amp.js`, `shelly_output_frc.js` | — / `SHELLY_IP` | Shelly |
| `pyscript/ev_phase_switch.yaml` | `rest_command.goe_set_psm` URL | go-e — easy to miss since it's YAML, not JS |

> If your chargers sit behind VLAN segmentation or any network change, the Fuse Guard's direct-stop URLs are worth a deliberate bench test afterward (see [INTEGRATION.md](INTEGRATION.md#fuse-guard)) — a silently blocked command path only reveals itself during an actual overload.

### Step 6 — Configure MQTT broker

Set the `mqtt-broker` config node's address/port/credentials, matching what's configured in HA under Settings → Devices & Services → MQTT.

### Step 7 — Set vehicle parameters

```js
// Run once via an Inject node wired to a Function node
flow.set('car1.battery_kwh', 75);
flow.set('car1.max_kw', 11);
flow.set('car2.battery_kwh', 75);
flow.set('car2.max_kw', 11);
```

Defaults to 75 kWh / 11 kW if unset.

### Step 8 — Deploy and initialise

1. Deploy in Node-RED
2. Fire the MQTT Discovery inject once manually (also fires automatically on deploy) — registers the HA MQTT sensors. See [INTEGRATION.md](INTEGRATION.md#mqtt-discovery-entity-naming) for a naming pitfall worth knowing about before your first deploy, not after.
3. Verify `sensor.ev_charging_schedule` and `sensor.ev_charging_status` appear under Settings → Entities
4. Within 15 minutes, the planners will have run — check Node-RED debug output for scheduled slots

### Step 9 — Dashboard cards

See [UI.md](UI.md).

---

## Configuration Reference

| Entity | Purpose | Default |
|---|---|---|
| `input_select.ev_charging_mode` | `scheduled` / `manual` | `scheduled` |
| `input_select.ev_priority` | `SoC Smart` / `Manual Car 1` / `Manual Car 2` | `SoC Smart` |
| `input_select.ev_charging_lb` | `automatic` / `manual` load balancing | `automatic` |
| `input_select.ev_car1_mode` / `ev_car2_mode` | `normal` / `trip` / `minimal` | `normal` |
| `input_number.ev_carN_target_soc_{minimal,normal,trip}` | Target SoC per mode | 40 / 80 / 90 (car1), 40/80/100 (car2) |
| `input_text.ev_carN_deadline_time` | Latest completion time (`HH:MM`) | `07:00` |
| `input_number.ev_super_cheap_threshold` | Price (c/kWh) for unconditional charging | 1.0 |

> **Emergency battery-health floor:** independent of the helpers above, the planners contain a hard-coded `EMERGENCY_MIN_SOC` constant (default 10%). Below this, the car charges immediately in every slot regardless of price or mode. Set to `0` in both planners to disable. The minimal/normal/trip selection never bypasses price optimisation — it only sets the target.

`Charging Mode` (dashboard label "Charging schedule") and `Load Balancing` (dashboard label "Charging control" — also the system kill switch) are independent global controls, set directly by the operator — they are **not** cascaded from the per-car strategy selector. See [INTEGRATION.md](INTEGRATION.md#strategy-derivation--charging-control) for the full mechanism, including why `Load Balancing = manual` now means the whole smart layer stands down rather than just skipping the Coordinator.

---

## Load Balancing

```
available = 35 A (GRID_LIMIT) - gridMax
```

`gridMax` is the maximum current across all three phases from the grid sensor.

| Priority mode | Trigger | Allocation |
|---|---|---|
| Sequential | SoC difference ≥ 10% | Lower-SoC car up to 16 A; other gets remainder if ≥ 6 A |
| Weighted | SoC difference 5–9% | Lower-SoC car 60%, other 40% of available |
| Equal | SoC difference < 5% | Each car gets half |
| High SoC | Either car SoC > 90% | High-SoC car coasts; other takes full available |
| Both high | Both SoC > 90% | Equal split |
| Manual Car 1/2 | Operator selection | Priority car up to 16 A; other gets remainder |

When only one car is active, it gets the full available pool. All amp values round to even numbers and clamp to [6 A, 16 A] or 0.

### Draw-based allocation and start-safe reservations (v2)

Shares are computed on the **pool** — `available + draw₁ + draw₂` — where `draw` is what a charger is actually delivering (its setpoint while running, 0 otherwise). v1 divided `available` alone and credited each charger with its *setpoint* as "what it is already using". Two consequences, both found by simulation before the first two-car winter:

- A stopped charger (`frc=1`, delivering 0 A) still reports `amp=16`, so v1 held both parked setpoints at 16 A until the slot boundary and then released both at once — up to 32 A of EV on top of the winter house load, a fuse-guard trip at 30 s, a coordinator 10-minute cooldown, release, repeat. The old amp=0-on-disallowed scheme had masked this; frc-only ownership exposed it.
- Two running chargers could never grow: 6+6 A with 11 A spare gave `share = 5 → 0`, and the ceiling kept both at 6.

Each charger is classified per cycle from the **evaluator's commanded `frc`** (not the reported one — the Shelly derives `frc` from work state, so a finished car there looks like a scheduler stop) and the reported car state:

| Phase | Meaning | Allocation |
|---|---|---|
| `running` | commanded `frc=0`, car charging, setpoint > 0 | Share of the pool; reactive formula on **draw** |
| `stopped` | commanded `frc=1` | If the scheduler wants it: a **6 A reservation** carved from the pool, in priority order, only where every running charger can keep ≥ 6 A. Otherwise `lb_hold` and parked at 6 A |
| `offered` | `frc=0`, car not charging, setpoint > 0 — complete, paused, preconditioning | No reservation; parked at 6 A so a spontaneous resume starts gently |
| `bootstrap` | `frc=0`, setpoint 0 (WaitCar with nothing to draw) | As `stopped`+wanted, so it can receive an allocation |

Reservations are 6 A rather than a fair share by decision: the running car yields the minimum for a safe start and one 60 s cycle rebalances on the real pool. The carve *can* reduce a running charger (down to 6 A) — the v1 ceiling protection is what made a second car unable to start against a saturated pool.

**`lb_hold` vs `lb_wants_stop`.** `lb_wants_stop` means "no room"; `lb_hold` means "not yet allocated — do not release". The hold exists because the coordinator only sees the evaluator's `schedulerAllows` one cycle late (it runs before the evaluator): at a slot boundary the plan flips, the evaluator holds the charger for one cycle, the coordinator carves room, then releases. Without it the release would land on a saturated pool a minute before the running car has been reduced. Cost: one 60 s cycle at every slot start.

**A deadband sits in front of the reactive formula.** gridMax hovering at the 35 A line made a charger at its cap dither 16→15→16 every ~12 minutes all night (2026-09-12 log). The coordinator now sheds only at headroom ≤ −1 A and grows only at ≥ +2 A (`LB_SHED_AT_A` / `LB_RESTORE_AT_A`); in between, running chargers hold their draw. The fuse guard is unaffected.

**Shared overload is shed by priority, not twice.** v1 applied the full negative headroom to each running charger, so a 12 A house step against 12+12 A charging computed 1 A for both and stopped both for 10 minutes. Now the excess is taken from the non-priority charger down to 6 A, then the priority one down to 6 A, then the non-priority off, then the priority — 12+12 with a 12 A step settles at 7+6, no stop.

`chargerN.allocatedAmp` (fed to the planner) is the charger's **sustainable** share of the pool, not the 6 A start value — planning slot energy at 6 A would roughly triple `slots_needed` for every parked car.

A charger only receives an allocation if the Coordinator considers it **active**: `lmo === 3` (auto mode) and `car ∈ {2, 3, 4}` (charging, WaitCar, or paused/complete-recoverable). `car=1` (no car connected) is the only excluded state.

> **`car=3` (WaitCar) inclusion is important, not incidental.** WaitCar is what the car reports when the charger is unlocked (`frc=0`) but currently offering 0 A — i.e. exactly the state a freshly-unlocked charger sits in before it has any allocation. Excluding it (an earlier version did) creates a bootstrap deadlock: the Coordinator only allocates current to an active charger, but a charger at amp=0 reports the very state that gets it excluded from ever receiving the allocation that would let it leave. If you ever see a charger stuck at 0 A despite `frc=0`, check this gate first.

### Overload protection

If available current drops below 6 A, the Coordinator sets a 10-minute cooldown (`lb_wants_stop = true`), which the Evaluator translates into `frc=1`. After the cooldown, the flag clears and the Evaluator re-enables on the next allowed slot.

This is the Coordinator's own reactive protection, always active while Charging control (`ev_charging_lb`) is `automatic` — and *only* then, since the Coordinator doesn't run at all in `manual` (the [system kill switch](INTEGRATION.md#strategy-derivation--charging-control)). It is complemented, not replaced, by the [Fuse Guard](INTEGRATION.md#fuse-guard) — a separate, always-on backstop that supervises the fuse regardless of Charging control's state, which matters whenever an operator hands control back to the go-e/Shelly app directly by engaging the kill switch. (Running PV Eco does *not* require the kill switch — the Coordinator yields the PV charger to the tracker automatically; see [INTEGRATION.md](INTEGRATION.md#per-charger-not-per-strategy-where-frc-and-amp-ownership-actually-live-now).)

---

## Scheduling

### Planner

Each planner runs every 15 minutes independently per car:

1. Resolve SoC: live sensor → last known good → configured fallback. **The run is never skipped** for a stale or unavailable reading; `soc_source` in the plan payload records which tier was used. See [INTEGRATION.md](INTEGRATION.md#soc-staleness--availability-handling)
2. Determine target SoC from active mode
3. Compute energy needed: `(target_soc - soc) / 100 × battery_kwh`
4. Estimate effective charging power from recent actual allocated amps on **the charger this car is actually assigned to** (mapping-aware), falling back to 70% of `max_kw` if no allocation data exists yet
5. Compute `slots_needed = ⌈energy_needed / (effective_kw × 0.25 h)⌉`
6. Sort usable slots (before deadline) by price, mark the cheapest `slots_needed` as allowed
7. Apply overrides: super-cheap threshold (mark all slots at/below it), emergency battery-health floor

### Evaluator

Runs once per minute, triggered immediately after the Coordinator or LB Gate — not its own timer, so a slot change or LB decision is enforced within the same cycle. Finds the current 15-minute slot; if none found, a 2-minute grace window precedes stopping (avoids false stops during Nord Pool data refresh).

For each charger, charging is allowed if the scheduler permits **AND** `lb_wants_stop` is false **AND** `ev_fuse_stop` is false, **OR** the car is boosting (`ev_carN_boost`, bypasses the scheduler gate only — LB and Fuse Guard still apply). In `manual` charging mode the scheduler gate is bypassed entirely; only `lb_wants_stop`/`ev_fuse_stop` can block.

### Coordinator Diagnostics

The Coordinator's third output carries `msg.diag` alongside the Evaluator trigger — attach a debug node to see, per cycle: the resolved car↔charger mapping, each charger's SoC (of the car actually on it), the priority translation (car-space → charger-space), grid headroom math, the allocation, and each charger's active/idle state with a reason code when idle (`car=1`, `lmo=4`, etc.). A `node.status` line on the Coordinator itself shows a one-glance summary (`c1:14A c2:6A | soc 63/41 | avail 15.0A`, red when shedding) without opening the debug pane at all.

---

## Shelly Charger Integration

### API mapping

| Concept | go-e (Charger 1) | Shelly (Charger 2) |
|---|---|---|
| Set amp limit | `/api/set?amp=N` | `/rpc/Number.Set?owner=%22service:0%22&role=%22current_limit%22&value=N` |
| Force stop | `/api/set?frc=1` | `/rpc/Boolean.Set?owner=%22service:0%22&role=%22start_charging%22&value=false` |
| Force start | `/api/set?frc=0` | `/rpc/Boolean.Set?owner=%22service:0%22&role=%22start_charging%22&value=true` |
| Poll | Single HTTP request | Single HTTP request: `Enum.GetStatus` (work_state) |

### Work state mapping

| Shelly `work_state` | go-e `car` equivalent | Notes |
|---|---|---|
| `charger_charging` | `2` | Coordinator allocates current; setpoint trusted, not gated on measured current |
| `charger_end`, `charger_wait`, `charger_pause`, `charger_complete` | `4` | Connected, not charging — mapped to `4` not `1`, essential for overload recovery |
| `charger_free` | `1` | No car — Coordinator skips |
| `charger_error` | `1` | Treated as inactive |

> Mapping stopped states to `car=4` (not `car=1`) is what lets `lb_wants_stop` clear correctly after a cooldown — the same principle behind including go-e's `car=3` in the active-state gate above. Cross-referenced against the [evcc](https://github.com/evcc-io/evcc) Shelly TopAC driver.

### Single poll, no phase data

The Shelly is polled once per cycle (`work_state` only) — measured current is never used anywhere in the system, matching go-e's own trust-the-setpoint approach, so a second phase-info poll was removed along with its delay node and join. Shelly is fixed 3-phase and does not support phase switching, which is why PV Eco is go-e-only (see [INTEGRATION.md](INTEGRATION.md#car--charger-mapping)).

> Disable the Shelly's built-in `auto_balance` — it conflicts with the Coordinator's load balancing.

### Power sensor for the SoC watchdog

Separately from the poll above, `pyscript/ev_strategy.py`'s `CHARGER_POWER_SENSORS[2]` wants the Shelly's own power-measurement entity (not `work_state`) so the [SoC and mapping-mismatch watchdog](INTEGRATION.md#soc-staleness--availability-handling) can tell when charger 2 is actually delivering current. **Check its unit before assuming W** — this integration's own Shelly power sensor reports **kW**, not W like go-e's; `CHARGER_POWER_SENSORS` records the unit explicitly per charger for exactly this reason. Left as `None`, charger 2 is simply excluded from that watchdog — not broken, just unmonitored.

---

## Changing a Vehicle

Update the SoC sensor entity ID in **four** places (was three — pyscript is new):

1. `planner_car1.js` / `planner_car2.js`
2. `coordinator.js` (`CAR_SOC_SENSORS`)
3. `pyscript/ev_strategy.py` (`CAR_SOC_SENSORS` — same table, kept in sync manually; see [INTEGRATION.md](INTEGRATION.md))
4. Vehicle parameters (`flow.set('car1.battery_kwh', ...)`) and HA helpers (target SoC, deadline) if changed

If the car is also changing which physical charger it uses, that's a runtime UI action now, not a code change — see [car↔charger mapping](INTEGRATION.md#car--charger-mapping).

---

## Hardware Configuration Variants

### Two go-e chargers

The Coordinator is already go-e-shaped. Replacing the Shelly with a second go-e is the simplest variant.

**Remove:** `shelly_assembler.js`, `shelly_output_amp.js`, `shelly_output_frc.js`, the Shelly poll branch.

**Add:** a second go-e poll (same pattern as charger 1, `msg.topic = "c2"`), HTTP nodes on Coordinator output 2 and Evaluator output 2 (no delay node needed for go-e, unlike Shelly).

**Update:** `CHARGER_IPS.c2` in `coordinator.js`, the Car 2 frc URL in `evaluator.js`.

No changes to allocation logic, planners, or the Coordinator → Evaluator trigger chain. This variant also unlocks PV Eco on both chargers — see [INTEGRATION.md](INTEGRATION.md#car--charger-mapping) for the documented seam (`PV_CAPABLE_CHARGERS`) and the sequential-handover design note for running PV Eco on two cars.

### Two Shelly chargers

**Remove:** the go-e poll branch.

**Add:** a second Shelly poll branch for Car 1 (duplicate the Car 2 branch, update IP and topic), `shelly_output_amp_car1.js` / `shelly_output_frc_car1.js` (copies with updated IP and flow context key), wired the same way as the existing Car 2 Shelly branch — keep the 1s delay on the frc write.

No changes to allocation logic, planners, or the trigger chain. Note: PV Eco requires phase switching, which no Shelly variant supports — this configuration is Fast-only.

---

## Adapting to other charger brands

The system talks to two very different chargers already — go-e (native JSON API) and Shelly TopAC (RPC API) — so the code is not go-e-specific; it just needs each charger mapped to a small common contract. The **Shelly integration is the worked example of a port**: see the [API mapping](#api-mapping) and [work state mapping](#work-state-mapping) tables above for exactly how a non-go-e charger was adapted. To add a third brand (Easee, Wallbox, Zaptec, a Tesla Wall Connector, etc.), replicate that pattern.

### The contract a charger must satisfy

A charger needs to expose three things the system can read/write over its local API:

| Capability | go-e | Shelly TopAC | What your charger needs |
|---|---|---|---|
| **Set current limit** | `GET /api/set?amp=N` | `GET /rpc/Number.Set?...role="current_limit"&value=N` | any call that sets the amp limit to an integer N |
| **Start / stop charging** | `GET /api/set?frc=0` (start) / `frc=1` (stop) | `GET /rpc/Boolean.Set?...role="start_charging"&value=true/false` | a force-start and force-stop command |
| **Report connection/charge state** | `car` field (1 = no car, 2 = charging, 3 = waiting, 4 = complete) | `work_state` enum (mapped to the go-e `car` numbers) | a way to tell "no car" / "charging" / "connected-but-idle" apart |

Everything else the system needs (measured current, phase count) it deliberately does **not** use — it trusts its own setpoint (see [Single poll, no phase data](#single-poll-no-phase-data)), which keeps the contract small.

### How to port, step by step

1. **Normalise state to the go-e `car` numbering.** The Coordinator's active-state check is written against go-e's `car` values (`{2,3,4}` = active, `1` = no car). Write a small assembler (like `shelly_assembler.js`) that polls your charger and maps its state enum to those numbers. **Critical:** map "connected but not currently charging" (paused, complete, waiting) to `4` or `3`, **not** `1` — mapping it to `1` (no car) breaks overload recovery, since the Coordinator excludes `car=1` from allocation entirely. This exact subtlety is why the Shelly maps four different idle-ish states to `4`.
2. **Write the amp output handler** (like `shelly_output_amp.js`) — translate the Coordinator's `amp` setpoint into your charger's set-current call.
3. **Write the frc output handler** (like `shelly_output_frc.js`) — translate the Evaluator's `frc` (0 = charge, 1 = stop) into your charger's start/stop call. If your charger needs a moment between commands (the Shelly needs ~1 s between a current-set and a start), keep a delay node on this path.
4. **Wire it in** on the Coordinator and Evaluator outputs for that charger, replacing the go-e or Shelly HTTP nodes.
5. **Optional but worth doing: add it to `CHARGER_POWER_SENSORS`** in `pyscript/ev_strategy.py` so the [SoC and mapping-mismatch watchdog](INTEGRATION.md#soc-staleness--availability-handling) covers the new charger. Record `(entity_id, unit)` — check the sensor's actual unit rather than assuming W; a wrong unit fails silently (the watchdog just never triggers, with no error) rather than loudly.

### Fault detection and PV Eco caveats

- **Fault field:** Fast Flow reads go-e's numeric `err` field for [charger-fault detection](#coordinator-diagnostics). A different brand exposes faults differently (or not over local API) — if yours has an equivalent, map it into the assembler's fault field; if not, fault detection simply won't fire for that charger (not dangerous, just less diagnostic).
- **PV Eco requires phase switching.** PV Eco's surplus tracking switches the charger between 1-phase and 3-phase (via `rest_command.goe_set_psm` for go-e). A charger without controllable phase switching can still do **Fast** charging perfectly, but not PV Eco surplus tracking — the same reason the Shelly TopAC is Fast-only here. If your charger supports phase switching through a different call, adapt `HomeAssistant/packages/ev_phase_switch.yaml` and the `GOE_PSM` mapping in `ev_strategy.py`.

---

## Diagnostic Log (Fast CSV Logger)

Fast Flow had no persistent, after-the-fact log until a real incident made
the gap obvious: charging was allowed for a few minutes outside a scheduled
slot, twice overnight, self-correcting at the next slot boundary each time.
Node-RED's debug pane isn't persisted, and HA's own entity history only
covers a handful of coarse, discrete-state helpers (mode, kill switch,
boost, mapping) — none of which show what the Evaluator actually computed
on a given cycle. Diagnosing it meant reconstructing partial context from
HA history alone, after ruling out every toggle-based cause one at a time.

`fast_csv_logger.js` closes that gap: a comprehensive, per-cycle CSV row —
one line per Evaluator run (currently every 1 minute) — written to
`/data/ev_charging_log.csv`. Wired from Evaluator's **output 3**, the same
unconditional trigger Status Publisher uses (not output 1/2, which go null
for a PV-owned charger by design — wiring a logger to those would silently
stop logging that charger the moment PV Eco engages, the same class of bug
the Status Publisher output-3 fix addressed).

**Columns**, per charger (`c1_`/`c2_` prefix):

| Column | Meaning |
|---|---|
| `car` | assigned car number (mapping-resolved) |
| `carState` | polled connection state |
| `frc_commanded` | what the Evaluator last commanded |
| `frc_polled` | what the charger itself reports (ground truth) |
| `amp_reported` | polled current draw |
| `scheduler_allows` | **the Evaluator's own decision this cycle** — the single most diagnostic field for "was charging allowed outside the schedule" |
| `lb_wants_stop` | Coordinator's load-balancing stop flag |
| `didwestop` | Coordinator's own stop reason code |
| `boost` | Boost active for the assigned car |
| `strategy` | assigned car's strategy (fast / pv_eco) |
| `pv_owned` | true if the PV Tracker owns this charger this cycle |
| `fault` | polled charger fault state |

Plus global columns: `charging_mode`, `charging_lb`, `fuse_stop`, and the
current Nord Pool slot's `slot_ts`/`slot_price`/`slots_count` for context.

`scheduler_allows` is newly exposed to flow context by `evaluator.js`
specifically for this logger — it was previously computed and used
internally but never written anywhere another node could read it.

---

## File Reference

See the [top-level README](../README.md#file-reference) for the full-system file table. Fast-flow-specific files are grouped under `NodeRed/Scripts/` there.
