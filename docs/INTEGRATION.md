# Integration Layer

[Fast Flow](FAST_FLOW.md) and [PV Eco Flow](PV_ECO_FLOW.md) evolved independently and remain independent Node-RED flow tabs — neither imports or calls the other. What ties them into one system is this layer: a pyscript module, one Node-RED safety node, and an HA template sensor, none of which existed when either flow was first designed. Read this doc if you're touching strategy switching, chargers, Boost, or anything safety-related — those concerns live here, not in either flow's own file.

---

## Car ↔ Charger Mapping

**The problem:** Fast Flow's SoC-aware planning, priority, and slot calculation all originally hardcoded car 1 ↔ charger 1 (go-e), car 2 ↔ charger 2 (Shelly). PV Eco is inherently single-charger (only go-e supports the phase switching its surplus tracking needs). Both flows need to know, authoritatively, which car sits on which charger — and that pairing needs to be changeable at runtime without code edits.

**The design:** two HA helpers are the single source of truth —

```yaml
input_select.ev_charger1_car:  ["Car 1", "Car 2", "None"]
input_select.ev_charger2_car:  ["Car 1", "Car 2", "None"]
```

`"None"` is a real state, not just an empty default — it enables a guest-car mode: an unrecognised car on that charger gets no schedule enforcement (charges whenever plugged in, subject to LB/Fuse Guard), and its SoC is treated as neutral (50) rather than unavailable.

An automation enforces exclusivity — assigning a car to one charger clears it from the other, last action wins.

### The resolver, duplicated deliberately

Coordinator, Evaluator, both Planners, and the Status Publisher each need this mapping, and — after evaluating a runtime-centralised alternative and rejecting it (see [below](#why-not-centralise-the-resolver)) — each carries its own copy of the same resolver function:

```js
function assignedCar(chargerN) {
    const s = global.get(`homeassistant.homeAssistant.states['input_select.ev_charger${chargerN}_car'].state`);
    if (s === "Car 1") return 1;
    if (s === "Car 2") return 2;
    if (s === "None")  return null;
    return chargerN;   // helper missing → legacy 1:1 mapping
}
```

The pyscript module and the dashboard card carry semantic twins of the same rules (necessarily — different runtimes). **These copies must stay byte-identical (JS) / rule-identical (twins) or the system can disagree with itself about which car is where.** `tools/check_resolver_sync.py` is the guard against that — see [below](#resolver-sync-check).

### Why not centralise the resolver?

Considered and rejected: a single pyscript-published "resolved state" sensor that everything else reads would remove the duplication, but it would also make the Fast Flow's car↔charger mapping — a purely synchronous, stateless read today — depend on pyscript's liveness. If pyscript died, the resolved state would freeze while the underlying helpers kept changing, and the fast flow would silently act on a stale mapping. That's exactly the failure pattern the independent-safety-layer philosophy exists to avoid. The duplication is a **maintenance-time** risk (someone edits one copy in isolation); the sync-check tool is a maintenance-time control for a maintenance-time risk, rather than a runtime architecture change trading a small, contained problem for a bigger, systemic one.

### PV Eco capability gating

PV Eco eligibility is a property of the **charger**, not the car — kept as a separate concept from assignment so a car's stated intent ("charge from surplus") survives being on the wrong charger, rather than being silently reset:

```python
PV_CAPABLE_CHARGERS = {1}   # go-e only — Shelly TopAC has no phase switching
```

A car with strategy `pv_eco` assigned to charger 2 (TopAC) shows as charging fast on the dashboard, with a hint explaining why — see [UI.md](UI.md). When a second phase-switching charger is added, this becomes `{1, 2}` and nothing else in the mapping layer changes.

### Resolver Sync Check

`tools/check_resolver_sync.py` extracts the marked resolver block from every file that should carry it, byte-compares them, verifies the pyscript/card twins carry a matching version marker, and — given a Node-RED flow export via `--flow` — cross-checks production against the repo (catches repo-vs-deployed drift, not just copy-vs-copy drift). Run it whenever the resolver changes or whenever you export a flow to the repo:

```bash
./tools/check_resolver_sync.py --flow exports/EV_Charging.json --flow exports/PV_Eco.json
```

Exits non-zero with a pointed message (file, line, ref vs. got) on any divergence, version skew, or missing marker.

---

## Strategy Derivation & Charging Control

> **This section describes a redesign that superseded the original cascade model.** The per-car strategy selector, Boost, and phase switching are unchanged; what changed is everything downstream of the derived strategy. If your mental model is "picking PV Eco automatically sets Charging Mode and Load Balancing to manual," that model is gone — read on. The design is referenced in code comments as `DESIGN_percar_strategy_killswitch`, but that write-up isn't checked into this repo; this section is now the authoritative description.

**The UI goal is unchanged:** one tap to switch a car between Fast and PV Eco. **The mechanism to get there changed.** The original design cascaded the per-car strategy choice down onto two global HA helpers (`ev_charging_mode`, `ev_charging_lb`), automatically setting both whenever a car's strategy changed, with a "Custom" badge on the dashboard when a manual override diverged from that cascade. That cascade has been **removed entirely** — there's no longer anything for a manual override to diverge from, so there's no more "Custom" concept either.

**What still happens**, in `HomeAssistant/pyscript/ev_strategy.py`:

```
input_select.ev_carN_strategy (per car, user-facing intent, persists)
        │
        ▼ derivation (runs on every relevant state change + startup)
derived = "pv_eco" iff  (some car's strategy = pv_eco)
                    AND (that car is assigned to a PV-capable charger)
                    AND (that car is not currently boosting)
          else "fast"
        │
        ▼ writes only on CHANGE
input_select.ev_charging_strategy   ← POSTURE SUMMARY ONLY. Also fires the
                                       go-e phase switch on change (see below).
```

`input_select.ev_charging_strategy` is still derived-only (a manual edit gets reverted on the next evaluation) and still drives the go-e phase switch on genuine transitions — that part is untouched. What it no longer does is **cascade to anything**. It's read only by observer consumers wanting "is the system in a PV posture at all" as one global signal — the health template, the CSV/Solcast loggers, the PV status publisher. It is **not** read by the Evaluator, the Coordinator, or the PV Fast Tracker for control any more; those resolve strategy per-charger, from whichever car is actually assigned there (see below).

### `ev_charging_mode` and `ev_charging_lb` are now independent global controls

Both survive as global HA helpers with unchanged entity IDs, but each now means something on its own, set directly by the operator — nothing derives or cascades either one:

| Entity | Dashboard label | Meaning |
|---|---|---|
| `input_select.ev_charging_mode` | **Charging schedule** | Scheduler bypass. `manual` = ignore the Nord Pool price schedule; the system stays fully engaged (load balancing on, chargers still actively commanded). |
| `input_select.ev_charging_lb` | **Charging control** | **The system kill switch.** `manual` = the entire smart layer stands down; the operator drives both chargers directly from the go-e/Shelly app with zero interference from this system. Only the Fuse Guard stays active. |

`ev_charging_lb == "manual"` is checked directly, independently, in three places, and each stands down completely rather than issuing any command (a stop is still a command, and would fight a user who's taken manual control):

- **`lb_gate.js`** — emits nothing on either output (no Coordinator trigger, no Evaluator trigger). This *replaces* the old manual-LB behaviour, where the Coordinator was skipped but the Evaluator still ran every cycle and still wrote `frc` — the exact mechanism that let the smart layer silently re-assert itself over a manual override. That's gone; `manual` now means the fast flow goes fully silent.
- **`fast_tracker.js`** — checked first, before even the per-charger strategy gate, and returns without emitting a command.
- **the dashboard card** — greys the per-car interactive controls in place (strategy, Boost, charger assignment, target, deadline — not the status/SoC/amp tiles, which stay visible) and shows a "System paused" note. See [UI.md](UI.md).

The Fuse Guard is deliberately unaffected by any of this — see [below](#fuse-guard).

### Per-charger, not per-strategy: where `frc` and `amp` ownership actually live now

With the cascade gone, whether Fast Flow or the PV Tracker is allowed to command a given *physical charger* is decided independently in each runtime that touches that charger, by reading the assigned car's own strategy helper directly — not by keying off the (now purely observational) global posture:

- **`evaluator.js`** resolves, per charger, which car is assigned and that car's `input_select.ev_carN_strategy`. If the charger is PV-capable and that car's strategy is `pv_eco` (and it isn't boosting), the Evaluator writes **no `frc`** for that charger at all — `pv_owned: true`, `frc: null` — leaving the PV Tracker as sole owner of that command for that cycle. Same "own nothing, emit nothing" principle the resolver duplication uses elsewhere, applied per-charger instead of per-flow.
- **`fast_tracker.js`** resolves its own charger's (go-e, charger 1 today) assigned car and reads that car's strategy directly, rather than the global. With one PV-capable charger this is behaviourally identical to reading the global; it's structured this way so adding a second PV-capable charger (`PV_CAPABLE_CHARGERS` → `{1, 2}`) needs no further change here — each tracker instance already keys off its own charger.

> **`amp` ownership is enforced the same way — resolved.** `coordinator.js` carries the *same* per-charger strategy check `evaluator.js` has: `pvOwnedCharger(chargerN, carN)` treats a PV-capable charger whose assigned car is on `pv_eco` (and not boosting) as **not active**, so the Coordinator allocates and emits **no `amp`** for it — the PV Tracker is left as sole writer. This closes what was, briefly, a real gap: when the cascade was first removed, the Coordinator had no strategy awareness, and under the old cascade it had been harmless only because PV Eco forced `ev_charging_lb = manual`, which silenced the Coordinator entirely via the LB Gate. Once the cascade was gone, leaving Charging control on `automatic` during PV Eco let the Coordinator and PV Tracker contend for the same charger's amp limit every cycle — an observed oscillation (charger hard-cycling 16 A → 0 → 16 A while the tracker's status read "waiting for surplus"). The `pvOwnedCharger` check makes the exclusion structural rather than a manual operational discipline: PV Eco no longer requires the operator to engage the kill switch. The Coordinator's diagnostics report such a charger as inactive with reason `pv_eco (tracker owns)` and a `pv_owned: true` flag, so it is distinguishable from an empty charger. Boost overrides ownership symmetrically (a boosting PV car wants full power, a Fast-flow action), mirroring the Evaluator exactly. `PV_CAPABLE_CHARGERS = [1]` today → `[1, 2]` when a second go-e is added; no logic change needed then.

> **The status publisher is strategy-aware for the same reason — and reads the charger, not the command.** `ev_status_publisher.js` reports each car's badge and slot tile. It reads the charger's **polled** `frc` (`chargerN.reportedFrc`, stored by `assembler.js` from the go-e's own report and synthesised by `shelly_assembler.js` from `work_state`), never the *commanded* `chargerN.frc` the Evaluator writes — because the per-car PV-ownership gate makes the Evaluator skip that write while the Tracker owns a charger, freezing the commanded value at its last fast-flow reading and pinning the badge to a stale "Scheduled … From 11:30" while the car charges on solar. The same staleness applies to `lb_wants_stop_N` and `chargerN.didwestop`, which the Coordinator only writes inside its `if (cNActive)` blocks; for a PV-owned charger the publisher therefore skips those branches entirely and reports `Waiting for sun` with a **live-surplus** slot tile (`Solar / N.N kW`, cross-flow read from `sensor.ev_pv_eco_status`'s `surplus_kw` attribute — PV Eco's own MQTT-discovered status sensor, the same cross-flow pattern as every other HA-state read in this file) instead of price-schedule semantics that don't apply. This is the same lesson the file had already learned once for `reportedAmp`: **read the charger, not the command — a gate can silence the writer.**

### Boost

Temporary full-power charging, in **either** mode, ending at target SoC (the car's current mode's target) **or** a configurable timeout, whichever comes first. This mechanism is unchanged by the kill-switch redesign.

The key design decision: Boost is a **per-car flag** (`input_boolean.ev_carN_boost`) the Evaluator ORs directly into the scheduler gate — `schedulerAllows = allowedMap[slot] || boostActive`. It does **not** flip the global Charging Schedule control. This matters because Charging Schedule is global: an earlier design (temporarily switch to fast + manual) would have silently disabled the *other* car's price schedule for the boost's duration. The per-car flag touches nothing global except one indirect effect — a boosting car never counts toward `pv_eco` in the derivation above, so boosting the PV car flips the *derived* posture-summary to fast for the duration and reverts automatically when boost ends. No stored "previous strategy" is needed; the derivation naturally converges back.

Boost is available in Fast mode too, not just PV Eco — originally by implementation accident rather than deliberate design (the per-car flag is inherently mode-agnostic), but retroactively the right call: it's the per-car, self-reverting equivalent of the global-manual workaround it replaces, useful for unplanned departures when the price scheduler is waiting for a cheaper slot. The dashboard's Boost button carries one label regardless of Fast/PV Eco context today (`Boost — full power, max N h` idle, `Boosting — until HH:MM or target · tap to cancel` active) — see [UI.md](UI.md) for a note on this being a simplification from an earlier, context-aware label design.

**Boost is subordinate to the kill switch.** While Charging control (`ev_charging_lb`) is `manual`, neither the Evaluator nor the Fast Tracker run at all, so a Boost flag has no effect until Charging control is back to `automatic` — Boost governs the *scheduler gate*, and there's no scheduler running to gate while the smart layer has stood down.

**Independent safety cutoff**, following the same philosophy as the original car-preheater pattern (HA helpers as state, independent watchdog that doesn't trust the smart layer to be alive): a plain HA automation force-clears a stuck boost flag after (configured duration + 30 min margin), completely independent of pyscript. If it ever fires, that means the pyscript-side watchdog missed *both* its own end conditions — a pyscript-health bug to investigate, not a normal occurrence.


### go-e Phase Switching

Phase mode was historically a manual seasonal setting. Automatic strategy switching and Boost made mode transitions frequent enough that manual phase switching stopped being viable — boosting the PV car without switching to 3-phase delivers ~3.7 kW while claiming "full power."

One hook covers all four phase-relevant transitions, because they're all instances of the same derived-strategy `changed` event: strategy fast→pv_eco, pv_eco→fast, boost start (derivation flips to fast), boost end (derivation reverts):

```python
GOE_PSM = {"fast": 2, "pv_eco": 1}   # 3-phase / 1-phase
# fired inside _derive()'s "changed" branch (the function predates the
# cascade's removal and was renamed from _derive_and_cascade — the phase
# switch call site didn't need to move, only the cascade code around it):
_set_goe_psm(derived)
```

Issued only on genuine transitions, not on re-taps of an already-active strategy — contactor wear stays at user-action frequency. A failed `rest_command` call is logged, never raised: wrong phase mode degrades charging speed or surplus-tracking granularity, it is never unsafe, since LB and the Fuse Guard supervise actual current regardless of phase count.

**Not built:** dynamic phase switching *within* an ongoing PV Eco session (1↔3 phase based on sustained surplus level, to lift the ~3.7 kW 1-phase ceiling on big-sun days). PV Eco's own Slow Planner has decision logic for this already designed (30-min trend hysteresis) but it was found disconnected from any actual command — see [PV_ECO_FLOW.md](PV_ECO_FLOW.md#phase-preference-designed-currently-disabled) — and deliberately left disabled rather than silently wrong. Reviving it requires reconciling it with the transition-based switch above so the two mechanisms don't independently disagree about `psm`.

---

## Fuse Guard

**The gap it closes:** whenever Charging control (`ev_charging_lb`) is `manual` — the [system kill switch](#ev_charging_mode-and-ev_charging_lb-are-now-independent-global-controls) — the LB Gate emits nothing at all, so the Coordinator doesn't run. Its own overload protection (10-minute cooldown, described in [FAST_FLOW.md](FAST_FLOW.md#overload-protection)) simply isn't in the loop: the `lb_wants_stop` flags aren't actively cleared, they're just frozen at whatever they last were, because nothing is writing them any more. The main fuse has no supervisor from the smart layer at all in this state — whether the operator engaged the kill switch to drive both chargers by hand, or for any other reason. (Running PV Eco no longer requires this — the Coordinator yields the PV charger automatically, [above](#per-charger-not-per-strategy-where-frc-and-amp-ownership-actually-live-now) — so the kill switch is now purely a deliberate operator choice, not a PV-Eco prerequisite.) Either way, the physical fuse doesn't care why control was handed back to the operator.

**The design:** a second, deliberately dumb, stop-only authority — a new Node-RED node, `fuse_guard.js`, completely outside the Assembler → Coordinator → Evaluator chain:

- **Own input path** — reads the P1 phase-current sensors directly from HA global context on its own 10 s inject, not through the fast flow's join chain, so a dead fast flow doesn't blind it
- **Own trivial state** — breach/release timers only, never touches `didwestop`/`stopUntil` (Coordinator's) or `pv.*` (tracker's)
- **Two action channels while active** — direct HTTP stop commands to both chargers re-sent every tick (works even if Evaluator/tracker are dead), plus a cooperative `ev_fuse_stop` global flag the Evaluator and PV Tracker both check
- **Release clears the flag only** — never sends a resume command. Normal controllers (Evaluator's next tick, the tracker's own start hysteresis) resume charging on their own terms. This is what makes fighting with LB structurally impossible: the worst possible overlap is two authorities agreeing to stop.

### Band structure

Trip and release thresholds must sit **outside** the band Load Balancing operates in, or the guard would fire during completely normal Fast-mode operation:

```
LB operates up to:  35 A  (GRID_LIMIT)
Guard trip:         39 A  sustained 30 s   (helper: ev_fuse_guard_trip_a)
Guard release:      31 A  sustained 5 min  (helper: ev_fuse_guard_release_a)
```

39 A is comfortably inside a 35 A gG fuse's tolerance at that duration (conventional non-fusing current is ~1.25×In for an hour) while being unambiguous: sustained current there means either non-EV load stacked on an unmanaged charger, or an LB defect. The trip notification states which — automatic LB mode at trip time means investigate LB; manual (PV Eco) means the backstop worked as designed.

**Known limit, by design:** shedding both EV chargers removes what EVs can draw — if a phase is still breached afterward, that's non-EV load (sauna, stove) the guard has no authority over. The notification is the remedy; the physical fuse remains the final authority.

**Sensor blindness** (all three phases unreadable) does **not** trip the guard — an availability failure must not strand the cars — but is flagged loudly on the health sensor and via notification, since unsupervised PV Eco is exactly the gap this exists to close.

Configuration: `ev_fuse_guard_trip_a` / `_release_a` / `_trip_seconds` / `_hold_minutes` (see `ev_fuse_guard_package.yaml`).

---

## System Health Monitoring

**The gap:** as the system grew — mapping, strategy derivation, Boost, Fuse Guard, phase switching, each running in a different runtime (Node-RED / pyscript / HA) — failure detection didn't keep pace with control sophistication. A dead pyscript process, a stopped PV Eco flow tab, a stale Nord Pool ranking, an unreadable phase sensor: none of these had ever been aggregated into one signal.

**The design:** `sensor.ev_system_health` — an HA template sensor (deliberately not Node-RED or pyscript, since both are things being monitored) — state `ok` / `degraded` / `fault`, built from heartbeats published by every layer:

| Source | Signal | Added |
|---|---|---|
| Fast Flow Status Publisher | `health.ts`, Nord Pool ranking age, slot count | health block in MQTT payload |
| PV Eco Status Publisher | `health.ts`, tracker command age, Kotiakku data age | health block in MQTT payload |
| pyscript | `sensor.ev_strategy_heartbeat`, updated every minute | new sensor |
| Fuse Guard | `binary_sensor.ev_fuse_guard` (state + `ts`/`blind` attributes) | already existed, now consumed |
| SoC watchdog | `binary_sensor.ev_carN_soc_stale`, `binary_sensor.ev_chargerN_mapping_mismatch` | see [SoC Staleness Handling](#soc-staleness-handling) |

### Mode-aware rules

The rules are what keep the badge trustworthy instead of noisy — a health check that fires during normal operation gets ignored within a week:

- PV chain / tracker silence → fault **only while `strategy == pv_eco`** (a silent tracker in Fast mode is correct — it's supposed to be idle)
- pyscript heartbeat staleness → degraded normally, **escalates to fault while a Boost is active** (the independent HA cutoff still covers Boost regardless, but this makes the risk visible sooner)
- FMI forecast staleness → degraded only, never fault (the Solcast fallback working as designed is not a fault)
- Fuse Guard silence, blindness, or active shedding → always fault
- Fast Flow chain silence, missing Nord Pool slots → always fault

### Dashboard integration

The common card shows nothing when `ok` — silence is the design goal, not a missing feature — and a badge naming the worst problem (e.g. "PV tracker silent 6 min") when degraded (orange) or fault (red). Notifications fire only on sustained fault (2 min, absorbing restart transients); degraded is badge-only.

---

## SoC Staleness Handling

Two complementary mechanisms, split by what's actually detectable — and a
hard-won distinction between them: only one of the two should ever *block*
anything.

**Freshness — reported, never blocking (v1.5).** A reading older than
`ev_soc_max_age_hours` (default 26 h) is *visible* everywhere it matters
(Planners report `soc_stale` / `soc_age_h` in the plan payload; Coordinator's
`socOfCar()` still demotes a stale reading to a neutral `50` for priority
mode, since a wrong priority pick is a minor and self-correcting cost; Boost
falls back to timeout-only) — but **no consumer refuses to act because of
it.** The Planners used to skip the run entirely on a stale reading; that
was removed after it produced a live, self-sealing failure: stale → skip →
no charge → car never wakes → still stale, indefinitely, with the only
escape being the owner manually driving the car. The sensor is
change-driven, not polling — "old" means "the car hasn't moved", not "the
value is wrong" — so trusting it and letting the next charge naturally
refresh it is both safer and simpler than refusing to plan. See
`planner_car1.js` / `planner_car2.js` for the full reasoning.

**Frozen-while-charging watchdog** (pyscript, minute cron) — the only case
where staleness is *provable* rather than merely suspicious, and the reason
a block was never needed in the first place: a charger measurably
delivering power to its assigned car, while that car's SoC reading doesn't
rise **in proportion to the energy delivered**. Judged against energy, not
a wall clock (delivered kWh vs. capacity → expected % gain), because a
fixed timer cannot serve both a 16 A grid session and a 6 A PV Eco session
without being either twitchy on one or blind on the other — a session must
clear both a minimum 20 minutes *and* a minimum 3% expected gain before any
verdict is drawn, so a coarse or laggy SoC report is never mistaken for a
stalled one. If the assigned car falls behind (actual gain <35% of owed),
`binary_sensor.ev_carN_soc_stale` is raised. Detection only — never acts on
charging.

**Mapping-mismatch inference** — the same watchdog cycle, extended.
A frozen assigned car alone is ambiguous (dead integration? sleeping car?
wrong plug?). But if the **other** car gained roughly what this charger
delivered (≥50% of owed) — and that car's own charger isn't simultaneously
delivering power, ruling out the innocent explanation of it charging
independently — that is unambiguous: the other car is the one actually
plugged into this charger. `binary_sensor.ev_chargerN_mapping_mismatch`
is raised, carrying the evidence as attributes (`assigned_car`,
`rising_car`, `energy_delivered_kwh`, `expected_gain_pct`,
`other_charger_confirmed_idle`, …) so the health badge can name the
specific, actionable remedy — swap the assignment — rather than a generic
warning. Requires `CHARGER_POWER_SENSORS` configured for **both** chargers
to positively confirm the other charger is idle; with only one configured,
`other_charger_confirmed_idle: false` records that the verdict rests on the
energy-magnitude match alone. See [Step 5](FAST_FLOW.md#step-5--update-entity-ids-and-ip-addresses)
for configuring these, including the **W vs kW trap** — a wrong unit is a
silent 1000× error that makes a charger look permanently idle to this
watchdog, with nothing anywhere reporting an error.

All three surface as **degraded**, never fault — the system continues
safely (or, for the freshness case, simply proceeds using the value it
has); the point is telling you the input needs attention, not that
anything downstream broke.

---

## MQTT Discovery Entity Naming

Worth its own note because it's bitten this system twice. HA's MQTT discovery derives an entity's `entity_id` from **whichever naming field the config payload uses, on the first time HA sees a given `unique_id`.**

**Use `default_entity_id`** (full domain-qualified, e.g. `sensor.ev_pv_status`) — never `object_id`, which is deprecated (removed in HA Core 2026.4) and was unreliable even before that. Without an explicit naming field at all, HA slugifies the `name` field instead, which silently produces the wrong `entity_id` whenever the display name and the intended entity_id diverge (`"EV PV Eco Status"` → `ev_pv_eco_status`, not `ev_pv_status`).

**Critically: this only takes effect the first time a `unique_id` is seen.** If an entity is already registered — even under the wrong name — republishing the discovery config under the *same* `unique_id` will not rename it, regardless of which naming field you use. HA reuses the existing registry mapping. The only fix is a genuinely fresh `unique_id`, combined with `default_entity_id` from the start, plus manually clearing the old registry entry (clear the retained config topic **and** delete the orphaned entity via the UI — retained-message clearing alone does not reliably purge the registry; if the UI won't allow deletion, the entity's likely persisted via `.storage/core.restore_state` rather than the registry, and needs HA stopped to edit that file directly, or simply survives as harmless clutter).

If a live entity is already under a "wrong" but working name and renaming isn't worth the disruption, it's reasonable to instead correct `default_entity_id` to document the name it actually has — a metadata-only update under the existing `unique_id`, no registry disruption — rather than force a migration nobody needs.

---

## Adjacent Project: Surplus Sink Dispatcher

A separate pyscript app (`surplus_sinks.py`, its own project, not part of this repo) routes PV surplus to thermal sinks (water heater, sauna reserve) as a last-resort consumer below the EV chargers in priority. It gates on `binary_sensor.ev_fuse_guard` (must be `off` to activate or remain active — same fail-safe-on-missing convention as its other gates) and reads `sensor.ev_charging_status` to avoid competing with an active EV session. Both are read-only dependencies on this system's public sensors; nothing here depends on the sink dispatcher.

---

## Configuration Reference — Integration Layer

| Entity | Purpose | Default |
|---|---|---|
| `input_select.ev_charger1_car` / `_charger2_car` | Car↔charger assignment | `Car 1` / `Car 2` |
| `input_select.ev_car1_strategy` / `_car2_strategy` | Per-car Fast/PV Eco intent | `fast` |
| `input_boolean.ev_car1_boost` / `_car2_boost` | Boost active flag | `off` |
| `input_datetime.ev_car1_boost_until` / `_car2_boost_until` | Boost end time | — |
| `input_number.ev_boost_duration_hours` | Boost max duration | 3 h |
| `input_number.ev_soc_max_age_hours` | SoC freshness threshold | 26 h |
| `input_number.ev_fuse_guard_trip_a` / `_release_a` | Fuse Guard band | 39 A / 31 A |
| `input_number.ev_fuse_guard_trip_seconds` / `_hold_minutes` | Fuse Guard timing | 30 s / 5 min |
| `binary_sensor.ev_fuse_guard` | Fuse Guard status (MQTT) | — |
| `sensor.ev_system_health` | Aggregated health (`ok`/`degraded`/`fault`) | — |
| `sensor.ev_strategy_heartbeat` | pyscript liveness | — |
| `binary_sensor.ev_car1_soc_stale` / `_car2_soc_stale` | Frozen-while-charging watchdog | — |

---

## File Reference

See the [top-level README](../README.md#file-reference). Integration-layer files: `HomeAssistant/pyscript/ev_strategy.py`, `NodeRed/Scripts/fuse_guard.js`, and under `HomeAssistant/packages/`: `ev_mapping_helpers.yaml`, `ev_mapping_automations.yaml`, `ev_strategy_helpers.yaml`, `ev_fuse_guard_package.yaml`, `ev_health_package.yaml`, `ev_phase_switch.yaml`, `ev_guest_charge_helpers.yaml`; plus `tools/check_resolver_sync.py`.
