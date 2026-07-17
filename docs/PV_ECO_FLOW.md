# PV Eco Flow — Solar Surplus Tracking

Charges from solar surplus rather than the price schedule, aware of a home battery's own charging needs and able to defer to grid export during genuinely favourable sell conditions. Independent Node-RED flow tab from [Fast Flow](FAST_FLOW.md); coupled to it only through the [integration layer](INTEGRATION.md) — strategy selection, Boost, and phase switching.

Built and tuned against **Elisa Kotiakku** (Huawei LUNA2000 home battery, operator-managed SoC 15–96%) via the [`elisa_kotiakku`](https://github.com/Jarauvi/elisa_kotiakku) Home Assistant integration, but the design is adaptable: everything battery-specific is isolated to the sensor names in Power Assembler and the reserve-planning constants in Slow Planner. Adapting to a different battery/inverter integration is a matter of repointing a handful of sensor names — see [Adapting to other integrations and data sources](#adapting-to-other-integrations-and-data-sources) below. If you don't have a home battery at all, see [Alternative: go-e Built-in Eco Mode](#alternative-go-e-built-in-eco-mode-no-home-battery) instead — a genuinely simpler approach for that case.

---

## Installation

Assumes [Fast Flow's installation](FAST_FLOW.md#installation) is already done — PV Eco
shares its Node-RED instance, its `packages/` helpers, and its MQTT broker
config, and is genuinely optional on top of it (see the
[alternative](#alternative-go-e-built-in-eco-mode-no-home-battery) if you
don't want this layer at all).

### Step 1 — Home Assistant helpers

Add the contents of `ev_pv_helpers.yaml` to your `packages/` folder (or
paste under the top-level `input_number:` / `input_boolean:` keys) alongside
the Fast Flow helpers from [FAST_FLOW.md Step 1](FAST_FLOW.md#step-1--home-assistant-helpers).
Restart Home Assistant.

### Step 2 — Battery and forecast sensors

Install the [Elisa Kotiakku](https://github.com/Jarauvi/elisa_kotiakku)
integration (or your own battery/inverter integration — see
[Adapting to other integrations](#adapting-to-other-integrations-and-data-sources))
and [ha-solcast-solar](https://github.com/BJReplay/ha-solcast-solar) (or the
optional FMI container — see
[Forecast source](#forecast-source-fmi-primary-solcast-fallback)). Confirm
the sensors listed in
[Adapting to other integrations](#adapting-to-other-integrations-and-data-sources)
are populated before continuing.

### Step 3 — Import Node-RED flow

Node-RED hamburger menu → Import → select `pv_eco_flows_template.json` →
Import as a **new flow tab** (this is a separate tab from Fast Flow's, not
merged into it — see [Architecture](#architecture)).

### Step 4 — Paste scripts

| Node-RED function node | Script file |
|---|---|
| `Power Assembler` | `power_assembler.js` |
| `Fast Tracker` | `fast_tracker.js` |
| `Slow Planner` | `slow_planner.js` |
| `Status Publisher` | `pv_status_publisher.js` |
| `CSV Logger` | `csv_logger.js` |
| `Solcast Logger` | `solcast_logger.js` |

### Step 5 — Update entity IDs, IP address, and file paths

**Battery/forecast sensor entity IDs** — in `power_assembler.js` and
`slow_planner.js`; see the tables in
[Adapting to other integrations](#adapting-to-other-integrations-and-data-sources)
for exactly which ones and what each must provide.

**go-e IP address** — `fast_tracker.js`'s `GO_E_IP` constant. Same charger,
same address as [Fast Flow's Step 5](FAST_FLOW.md#step-5--update-entity-ids-and-ip-addresses)
— keep the two in sync.

**CSV log file paths** — the `CSV Logger` and `Solcast Logger` nodes' `file`
nodes default to `/data/*.csv`; point them at a path your Node-RED instance
can write to (the `/data` add-on volume works out of the box on Home
Assistant OS).

### Step 6 — Deploy and verify

1. Deploy in Node-RED.
2. Set a car's strategy to PV Eco (via the [card](UI.md) or
   `input_select.ev_carN_strategy` directly) on a charger listed in
   `PV_CAPABLE_CHARGERS` (go-e only, by default — see
   [go-e charger sensors](#go-e-charger-sensors)).
3. Watch the Power Assembler and Fast Tracker nodes' status lines
   (the small text under each node in the Node-RED editor) — `Fast Tracker`
   should show a stop reason if surplus is short, or start charging once
   sustained surplus clears the threshold.
4. Confirm `sensor.ev_pv_eco_status` appears under Settings → Entities.

---

## Why this is a separate control philosophy from Fast Flow

Fast Flow answers "when is it cheapest to charge, given a deadline and target SoC" — a scheduling problem solved once every 15 minutes from Nord Pool data. PV Eco answers "is there surplus right now, and should the car or the battery get it" — a real-time tracking problem with no schedule at all, solved by a fast inner control loop plus a slower planning loop that only adjusts the *target* the inner loop tracks.

They share the same charger hardware and the same Evaluator/frc mechanism (via the [strategy derivation](INTEGRATION.md#strategy-derivation--charging-control)), which is why the flows can stay independent rather than merged: PV Eco never touches Nord Pool pricing logic, Fast Flow never touches solar sensors.

---

## Architecture

```
Every ~10 s (inject)                          Every ~10 min (inject)
           │                                              │
           ▼                                              ▼
┌────────────────────┐                         ┌───────────────────────┐
│ Power Assembler    │                         │ Slow Planner          │
│                    │                         │                       │
│ reads: Kotiakku    │                         │ reads: battery SoC,   │
│ sensors, P1        │                         │ FMI/Solcast forecast, │
│ meter, go-e        │                         │ Nord Pool tomorrow    │
│ state, Nord Pool   │                         │                       │
│ shared ranking     │                         │ writes: pv.computed_  │
│                    │                         │ reserve_kw            │
│ decides surplus-   │                         └───────────────────────┘
│ source mode:       │                                    │
│ battery/export/    │◄───────────────────────────────────┘
│ defer_sell         │      (reserve feeds into error calc)
│                    │
│ writes:            │
│ surplusKw, error,  │
│ surplusStamp       │
└──────────┬─────────┘
           │
           ▼
┌─────────────────────┐
│ Fast Tracker        │
│                     │
│ reads: strategy     │
│ gate, ev_fuse_stop, │
│ assembler payload   │
│                     │
│ control law:        │
│ target = draw +     │
│   GAIN × error      │
│                     │
│ start/continue      │
│ hysteresis,         │
│ cloud-bridge hold   │
│                     │
│ writes: go-e amp/frc│
└──────────┬──────────┘
           │
           ▼
   ┌───────────────┐        ┌─────────────────────┐
   │ go-e charger  │        │ Status Publisher    │
   │ (Charger 1)   │───────►│ → MQTT → sensor.ev_ │
   └───────────────┘        │ pv_status (+ health)│
                            └─────────────────────┘
```

Power Assembler is the **sensing layer** — it decides *what surplus means right now* and every downstream consumer (Fast Tracker, CSV logger, status publisher) sees the same answer. Fast Tracker is a pure control loop that never re-derives anything the assembler already decided.

---

## Power Assembler

Runs every ~10 s. Reads Kotiakku battery sensors, the P1 meter, go-e state, and the shared Nord Pool ranking (published by the Fast Flow Parser — a genuine cross-flow read, the one place PV Eco touches Nord Pool data at all).

### Surplus-source mode selection

The assembler decides which physical signal *is* "the surplus" this cycle, so the mode-selection logic lives in exactly one place:

| Mode | Condition | Surplus signal | Reserve |
|---|---|---|---|
| `battery` | Battery meaningfully charging (`solar_to_battery` ≥ `ev_pv_batt_idle_kw`, default 0.3 kW) | `solar_to_battery` | `max(user_reserve, computed_reserve)` |
| `idle` | Battery flow near zero (`solar_to_battery` < `ev_pv_batt_idle_kw`) — battery idle, not really charging | 0 | `max(user_reserve, computed_reserve)` |
| `export` | Battery full (SoC ≥ `ev_pv_battery_full_threshold`, default 96%) | `solar_to_grid` | 0 |
| `defer_sell` | Sustained P1 export during a high-sell price slot | 0 (car defers) | 0 |

`defer_sell` overrides even a full battery — exported energy during a genuinely high-price slot is worth more sold than driven.

The `idle` classification exists because a battery trickle of ~0.05–0.17 kW is idle noise, not real charging — reporting it as `battery` mode with that value as "surplus" was misleading (the battery's own state sensor reads `idle` in exactly this condition). `idle` reports `surplus_kw = 0` so telemetry and the CSV/debug are honest. It does **not** change the start/stop decision: such a trickle is already far below the 2 kW start threshold, so the car neither starts nor is stopped differently — the classification is about truthful state, not control behaviour.

### Sustained-export price-aware sell gate

The fast local P1 meter (not the cloud-lagged Kotiakku sensors) detects sustained export: every sample in a configurable window (`ev_pv_export_sustain_seconds`, default 120 s) at or beyond `ev_pv_export_detect_kw` (default 1.0 kW). This window was sized against measured behaviour — grid-balancing events are single ~10 s pulses around 10 kW; deliberate sells run 15+ minutes at 1–4 kW — so even a 60 s sustain fully excludes balancing noise.

"High-sell" reuses the Nord Pool ranking, inverted: the current slot must be among the top-X most expensive slots of the local day (`ev_pv_sell_rank_slots`, default 12 = top 3 hours) **and** above a grid-premium floor (`ev_pv_sell_price_floor_cents`, default 5.0 c/kWh — selling below the grid fee to buy back later is a guaranteed loss). A stale or absent ranking (Fast Flow Parser not running) gates this off entirely — no defer without live price data.

### Consistency check

Every cycle verifies `solar_to_battery + solar_to_grid + solar_to_house ≈ solar_power` (0.5 kW tolerance). A failed check skips the cycle rather than acting on a self-contradictory sensor snapshot.

### Window-quantised reading stamp

The Kotiakku API serves 5-minute clock-aligned windows. Rather than trusting HA's `last_updated` (which can update more often than the underlying data actually changes), the assembler quantises the timestamp into the same 5-minute grid the API itself uses — so "one step per fresh reading" downstream is correct by construction, independent of HA's poll cadence.

**The stamp is taken from whichever sensor actually drives the current surplus signal** — `solar_to_battery` in `battery`/`idle` mode, `solar_to_grid` in `export` mode — not always the battery sensor. This matters because Kotiakku only pushes a new state (and a new `last_updated`) when a sensor's *value* changes: while the battery sits full, `solar_to_battery` is pinned at exactly 0 and its clock never advances, even though real, changing surplus is flowing via `solar_to_grid` the whole time. A version that always read the battery sensor's clock left PV Eco permanently unable to *start* during export mode — surplus visibly present and above threshold, but the "distinct reading" count frozen at zero forever, because the clock behind it never ticked. Confirmed live via a battery-full session that sat at "0/2 readings" for 20+ minutes while `solarToGrid` moved 0.96 → 1.19 → 2.56 → 2.91 kW.

---

## Fast Tracker

The inner control loop, runs every ~10 s immediately after the assembler.

### Control law

```
error      = surplus_kw − battery_reserve      (from the assembler)
car_target = car_draw + GAIN × error            (GAIN default 0.4)
```

Within a deadband (`ev_pv_deadband_kw`, default 0.7 kW) the target simply holds — no correction for noise-sized errors.

### Start / continue hysteresis

Deliberately asymmetric: **hard to start, easy to keep going.**

- **Start** requires sustained surplus — `ev_pv_start_sustain_readings` (default 2) consecutive *distinct* API readings all above `ev_pv_start_threshold_kw` (default 2.0 kW, set above the car's 1-phase minimum draw so starting never immediately pulls from the battery). Two readings suffice because each Kotiakku reading is itself a **5-minute average** — one window is already sustained-production evidence, so two agreeing windows ≈ 10 minutes of proven surplus. (The original default of 3 treated averaged readings like instantaneous samples needing extra corroboration — ~15 min to start, needlessly slow.)
- **Continue** only needs instantaneous surplus above a much lower floor (`ev_pv_continue_threshold_kw`, default 0.3 kW), with a **cloud-bridge hold**: a brief dip below that floor holds at minimum amp for `ev_pv_min_hold_minutes` (default 4 min) before actually stopping, covering the Kotiakku API's inherent lag rather than reacting to every momentary dip

The reading-accumulation itself runs unconditionally every cycle, even while the car is disconnected — so a car plugged in midday into already-sustained surplus starts immediately instead of waiting through a fresh 15-minute sustain window.

### Rate limiting

The car must not chase surplus faster than the Kotiakku API can reflect its own change (~300 s lag), or it overshoots and limit-cycles. The structural guard is the **fresh-reading gate**: at most one adjustment per *distinct* API window, holding steady in between — re-stepping against the same frozen reading was the original oscillation mechanism. Because amps are held constant for the whole window, each fresh reading is a clean 5-minute *steady-state average* at the held setpoint — high-quality feedback — so per-window steps can be substantial: `GAIN` (0.4) damps each step proportionally, and `ev_pv_max_amp_step` (default 4) is only a safety cap on top. (An earlier default of 1 A stacked a third damper on the two that matter, turning a 6→16 A ramp into ~10 windows / 50–75 min of exported surplus; at 4 A the controller converges in ~3 windows.)

### Command emission

go-e HTTP commands are sent only when the command changes, plus a periodic refresh (`COMMAND_REFRESH_S`, 300 s) as a self-healing measure against dropped requests — not every 10 s regardless of change, which would be ~8000 near-identical requests per idle day.

### Gates (in order)

1. **Kill switch** — `ev_charging_lb === "manual"` → stand down completely, emit nothing at all (not even a stop command — a stop is still a command that would fight the operator's direct control). Checked first, ahead of everything else. See [INTEGRATION.md](INTEGRATION.md#strategy-derivation--charging-control).
2. **Strategy** — the strategy of the car assigned to *this tracker's own charger* (go-e, charger 1 today) is read directly, not the global posture summary; if it isn't `pv_eco`, the tracker does nothing and Fast Flow owns the charger
3. Fuse Guard active (`ev_fuse_stop`) → stop, cooperative with the [independent Fuse Guard](INTEGRATION.md#fuse-guard)
4. Charger fault, unknown charger state, or car not connected → stop (each with its own distinct reason string). **Fault detection requires positive evidence:** the go-e `error_state` is read as the bridge's own *string* (the bridge's numeric codes diverge from go-e's official API and 60.5 beta has no published table, so strings are the only safe common ground). Home Assistant's own sentinel values for a missing reading — lowercase `"unknown"` / `"unavailable"` / empty — are **not** treated as a fault (an earlier version did, and a non-retained MQTT topic sitting at `"unknown"` after a restart then blocked all charging until the go-e next published). The check is deliberately **case-sensitive** so the bridge's legitimate capital-`"Unknown"` error name still registers as a real fault while HA's lowercase sentinel does not. When the reading is a sentinel, the assembler flags `charger1FaultUnknown` (surfaced for debug, never used to block charging) rather than inventing a fault.
5. No PV production → stop
6. Operator charging battery from grid → yield entirely (any PV the car took would be backfilled from grid at a conversion loss)
7. Operator selling (sustained export + high-sell slot) → defer

---

## Slow Planner

The outer loop, runs every ~10 min. Computes `pv.computed_reserve_kw` — the battery-need-driven floor the assembler folds into its reserve calculation (`max(user_reserve, computed_reserve)`, so a manual floor can raise but never be undercut by this logic).

### Evening target computation

1. `evening_target` starts at a baseline (`ev_pv_evening_target_soc`, default 80%), adjusted by tomorrow's outlook:
   - Confidently sunny tomorrow (forecast above `ev_pv_tomorrow_high_kwh`) → lower the target (`ev_pv_tomorrow_sunny_discount`, default 20%) — no need to hold as much back
   - Poor forecast or expensive tomorrow (below `ev_pv_tomorrow_low_kwh`, or mean price above `ev_pv_tomorrow_price_high_cents`) → raise it (`ev_pv_tomorrow_price_premium`, default 15%)
   - Floored at `ev_pv_min_night_soc` (default 40%)
2. `battery_need_kwh = (target − soc) × kWh_per_soc_percent` (measured conversion, `ev_pv_kwh_per_soc_percent`, default 0.34 — includes charge-side losses already, no separate efficiency factor needed)
3. `surplus_budget = forecast_remaining_today − battery_need − house_remaining`
4. `computed_reserve_kw` scales from the budget: a generous budget (above `ev_pv_surplus_generous_kwh`, default 10 kWh) relaxes the reserve toward a low floor (`ev_pv_reserve_low_floor_kw`); a tight budget raises it toward whatever rate is actually required to hit the target in the time remaining, capped at `ev_pv_battery_max_rate_kw`

### Forecast source: FMI primary, Solcast fallback

Two forecast sources are supported, with automatic fallback between them:

- **FMI (primary, optional).** Uses the Finnish Meteorological Institute's open PV forecast — [`fmi-open-pv-forecast-packaged`](https://github.com/fmidev/fmi-open-pv-forecast-packaged). In this setup it runs as a separate scheduled Docker container (`fmi_forecast_logger.py`, out of scope for this repo) that publishes retained MQTT → `sensor.fmi_pv_remaining_today_kwh` / `sensor.fmi_pv_tomorrow_kwh`, each with an `issued_at` attribute. FMI measured more accurate same-day and substantially better on cloudy days than Solcast in this location.
- **Solcast (fallback, and a good primary if you'd rather not run FMI).** The [`ha-solcast-solar`](https://github.com/BJReplay/ha-solcast-solar) HACS integration provides `sensor.solcast_pv_forecast_forecast_remaining_today` / `sensor.solcast_pv_forecast_forecast_tomorrow`. It's a straightforward HACS install with no container to maintain — if you're not comfortable running the FMI container, Solcast alone is entirely sufficient; the planner works identically with it.

If the FMI value is missing or stale (`issued_at` older than `ev_pv_fmi_max_age_hours`, default 6 h — e.g. the container is down), the planner falls back to Solcast automatically and records which source it used (`forecastSource` in diagnostics). To run Solcast-only, simply don't provide the FMI sensors; the planner uses Solcast directly.

### Conservatism

Both forecasters measured optimistic (~+10%), concentrated in shaded morning/evening hours — a blanket haircut (`ev_pv_forecast_haircut`, default ×0.9) applies to remaining-today. Tomorrow gets extra caution: the target is only ever *lowered* when tomorrow is confidently sunny (day-ahead forecasts can be roughly 2× wrong on a cloudy-day miss), never raised on an uncertain-but-not-poor forecast.

### Phase preference: designed, currently disabled

The planner computes a `pv.car_phases` preference (30-minute trend hysteresis around 3.7/4.5 kW target-power bounds) intended to widen surplus tracking beyond the ~3.7 kW ceiling of 1-phase charging on genuinely high-surplus days. **This is currently disabled** (`phases` pinned to `1`) — the decision logic was never wired to an actual `psm` command, and the [transition-based phase switch](INTEGRATION.md#go-e-phase-switching) added alongside Boost independently owns `psm` today. Reviving this would mean the trend logic calling the same `rest_command.goe_set_psm` the transition switch uses, and reconciling the two so they can't disagree about phase state — tracked as a future option, not a currently-working feature. Do not re-enable by simply restoring the trend block without that reconciliation; the two mechanisms fighting over `psm` would be worse than the current fixed-1-phase state.

---

## Adapting to other integrations and data sources

Everything integration-specific in PV Eco is a sensor entity ID in one of two files. Nothing about the control logic assumes a particular vendor — repoint these and the flow works with any battery/inverter and any forecast source that can expose equivalent values.

### Home battery / inverter sensors (in `power_assembler.js`)

Built against the [`elisa_kotiakku`](https://github.com/Jarauvi/elisa_kotiakku) integration. To adapt to another battery integration (Huawei FusionSolar, SolarEdge, Victron, etc.), replace these entity IDs with your integration's equivalents:

| Purpose | This setup's sensor (Kotiakku) | What it must provide |
|---|---|---|
| Solar power → battery | `sensor.kotiakku_solar_to_battery_kw` | kW currently charging the battery from solar |
| Total solar production | `sensor.kotiakku_solar_power_kw` | kW total PV generation |
| Solar → grid (export) | `sensor.kotiakku_solar_to_grid_kw` | kW currently exported |
| Solar → house | `sensor.kotiakku_solar_to_house_kw` | kW consumed directly by the house |
| Battery SoC | `sensor.kotiakku_state_of_charge_percent` | battery charge, % |
| Battery state | `sensor.kotiakku_battery_state` | charging / idle / discharging (string) |
| Grid → battery | `sensor.kotiakku_grid_to_battery_kw` | kW charging battery *from grid* (operator-charge detection) |
| Fast local grid meter | `sensor.p1_meter_power` | whole-house grid power, W (fast, un-lagged — used for the sell gate) |

Two things to preserve when adapting, because the logic depends on them:
- The **consistency check** (`solar_to_battery + solar_to_grid + solar_to_house ≈ solar_power`) assumes these four are internally consistent kW readings from the same source. If your integration splits them differently, adjust the check accordingly.
- The **window-quantised reading stamp** assumes the underlying API updates on a fixed clock-aligned cadence (Kotiakku: 5-minute windows) — and, since v1.4, that it's taken from whichever sensor is actually driving the current surplus mode (`solar_to_battery` vs `solar_to_grid`; see `surplusStamp` in `power_assembler.js`), not a single hardcoded sensor. If your integration updates continuously, updates only-on-change like Kotiakku does, or has a different export-mode sensor, revisit this logic — the start/rate-limit gates count "distinct readings," so they need to know when a reading is genuinely new, for *every* mode your surplus signal can come from.

The battery's usable SoC band (Kotiakku 15–96%) and the measured conversion factor (`ev_pv_kwh_per_soc_percent`, 0.34 kWh per SoC %) are specific to this battery — re-measure both for yours.

### Forecast sensors (in `slow_planner.js`)

| Purpose | FMI sensor | Solcast sensor |
|---|---|---|
| Remaining generation today | `sensor.fmi_pv_remaining_today_kwh` | `sensor.solcast_pv_forecast_forecast_remaining_today` |
| Tomorrow's total | `sensor.fmi_pv_tomorrow_kwh` | `sensor.solcast_pv_forecast_forecast_tomorrow` |

The planner reads FMI first, falls back to Solcast on staleness (see [Forecast source](#forecast-source-fmi-primary-solcast-fallback)). For a different forecast provider, expose "remaining today (kWh)" and "tomorrow total (kWh)" sensors and repoint these IDs. The optimism haircut (`ev_pv_forecast_haircut`, 0.9) was calibrated for FMI/Solcast in this location — re-tune it for a different provider or climate.

### go-e charger sensors

Shared with Fast Flow — see [charger adaptation in FAST_FLOW.md](FAST_FLOW.md#adapting-to-other-charger-brands). PV Eco additionally requires a charger that supports **phase switching** (1-phase for surplus tracking), which is why it's go-e-only in this build; a charger without it can still do Fast, just not PV Eco surplus tracking.

---

## Configuration Reference

| Entity | Purpose | Default |
|---|---|---|
| `input_number.ev_pv_battery_reserve_kw` | Manual reserve floor | 0.5 kW |
| `input_number.ev_pv_batt_idle_kw` | Battery flow below this → `idle` mode (not `battery`) | 0.3 kW |
| `input_number.ev_pv_battery_full_threshold` | SoC ≥ this → export mode | 96% |
| `input_number.ev_pv_grid_charge_threshold_kw` | Operator-charging-battery detection | 0.8 kW |
| `input_number.ev_pv_gain` | Control law gain | 0.4 |
| `input_number.ev_pv_deadband_kw` | Error deadband | 0.7 kW |
| `input_number.ev_pv_min_hold_minutes` | Cloud-bridge hold | 4 min |
| `input_number.ev_pv_start_threshold_kw` | Start-sustain surplus bar | 2.0 kW |
| `input_number.ev_pv_start_sustain_readings` | Distinct readings required to start (each is a 5-min average) | 2 |
| `input_number.ev_pv_continue_threshold_kw` | Continue floor | 0.3 kW |
| `input_number.ev_pv_max_amp_step` | Max amp change per fresh reading (safety cap; GAIN does the damping) | 4 A |
| `input_number.ev_pv_adjust_interval_seconds` | Min seconds between adjustments | 60 s |
| `input_number.ev_pv_export_detect_kw` | Sustained-export threshold | 1.0 kW |
| `input_number.ev_pv_export_sustain_seconds` | Sustain window | 120 s |
| `input_number.ev_pv_sell_price_floor_cents` | Grid-premium floor for selling | 5.0 c/kWh |
| `input_number.ev_pv_sell_rank_slots` | Top-X slots/day counted as "sell" | 12 |
| `input_number.ev_pv_nordpool_max_age_hours` | Ranking staleness gate | 2 h |
| `input_number.ev_pv_evening_target_soc` | Baseline evening battery target | 80% |
| `input_number.ev_pv_min_night_soc` | Floor on evening target | 40% |
| `input_number.ev_pv_tomorrow_sunny_discount` / `_price_premium` | Target adjustment | 20% / 15% |
| `input_number.ev_pv_tomorrow_high_kwh` / `_low_kwh` | Forecast thresholds | 45 / 25 kWh |
| `input_number.ev_pv_kwh_per_soc_percent` | Measured battery conversion | 0.34 kWh/% |
| `input_number.ev_pv_battery_max_rate_kw` | Battery max charge rate | 10 kW |
| `input_number.ev_pv_house_baseload_kw` | Measured house baseload | 1.3 kW |
| `input_number.ev_pv_forecast_haircut` | Optimism correction factor | 0.9 |
| `input_number.ev_pv_fmi_max_age_hours` | FMI staleness → Solcast fallback | 6 h |

`input_select.ev_charging_strategy` (`fast`/`pv_eco`) is documented in [INTEGRATION.md](INTEGRATION.md) — PV Eco reads it but does not own it; it's derived from per-car strategy selections.

---

## Alternative: go-e Built-in Eco Mode (no home battery)

If you have solar but no home battery — or simply want the go-e to self-manage from surplus without the reserve-planning layer above — the go-e charger has a built-in **Eco mode** (`lmo=4`) that adjusts current from live grid power data on its own, no custom control loop required.

The companion flow `go-e_PV_Surplus.json` implements the feed:

1. Every 5 s, polls a grid power sensor (e.g. `sensor.p1_meter_power`)
2. Sends it to the go-e via `/api/set?ids={"pGrid": <watts>, "pPv": 0, "pAkku": 0}`
3. go-e's own Eco-mode logic maximises car charging from surplus within grid limits

> The go-e must be manually switched to Eco mode (`lmo=4`) for this to activate. Fast Flow's Coordinator automatically skips any charger in `lmo=4` (it only acts on `lmo=3`), so the two approaches cannot conflict even if both are present — but note this also means `lmo=4` is **outside** the strategy-derivation/Boost/phase-switching layer entirely: switching to this mode is a manual go-e app action, not a dashboard one-tap action, and Boost has no effect on it.

**Setup:** import `go-e_PV_Surplus.json` as a separate flow tab, update the grid power sensor entity ID and go-e IP, switch the charger to Eco mode in the go-e app. Fully independent of both Fast Flow and the custom PV Eco flow above — enable or disable without affecting either.

This is the right choice if you want solar-aware charging with zero additional configuration and don't need the reserve-vs-car tradeoff, the price-aware sell deferral, or dashboard integration the custom flow provides.

---

## File Reference

See the [top-level README](../README.md#file-reference). PV-Eco-specific scripts (`power_assembler.js`, `fast_tracker.js`, `slow_planner.js`, `pv_status_publisher.js`, `csv_logger.js`, `solcast_logger.js`) live under `NodeRed/Scripts/` alongside the Fast Flow scripts, since both flows run in the same Node-RED instance.
