# Dashboard UI

Four custom Lovelace card types in `ev-charging-cards.js`, designed around one principle: the common case (switch a car between Fast and PV Eco, boost when needed) should be one tap, while the advanced controls needed for edge cases stay reachable, not hidden — see [INTEGRATION.md](INTEGRATION.md#strategy-derivation--charging-control) for the mechanism behind this.

---

## Installation

1. Copy `ev-charging-cards.js` to `/config/www/ev-charging-cards.js`
2. Settings → Dashboards → ⋮ → Resources → Add Resource — URL `/local/ev-charging-cards.js`, type JavaScript module
3. Set car display names via `ev_car1_name` / `ev_car2_name` helpers
4. Add cards via the dashboard YAML editor (see the per-card sections below — [Common Card](#common-card-ev-charging-common-card), [Car Card](#car-card-ev-charging-car-card), etc. — for options)

> **Cache-busting:** append `?v=N` to the resource URL and bump it on every update. Browsers/HA frontend can otherwise run a stale cached copy alongside a freshly fetched one after an edit, which can throw a harmless-but-alarming `CustomElementRegistry` "already defined" console error on the next load. Cosmetic if it happens — the first successfully-registered copy keeps working — but the cache-bust avoids it entirely.

---

## Common Card (`ev-charging-common-card`)

**Priority** — Car 1 / SoC Smart / Car 2 segmented control, always visible; doubles as PV Eco queue order if a second PV-capable charger is ever added.

**Health badge** — in the header, next to the title. Hidden entirely when `sensor.ev_system_health` is `ok` (silence is the design goal). Orange with the health sensor's summary text when degraded, red when fault — e.g. "PV tracker silent 6 min". See [INTEGRATION.md](INTEGRATION.md#system-health-monitoring).

**Advanced** (collapsed by default) — two independent global controls, set directly by the operator, no cascade or badge:

- **Charging schedule** (`ev_charging_mode`, Automatic/Manual) — scheduler bypass. Manual ignores the Nord Pool price schedule; the system stays fully engaged.
- **Charging control** (`ev_charging_lb`, Automatic/Manual) — **the system kill switch.** Manual stands the entire smart layer down; the operator drives both chargers from the go-e/Shelly app directly.

These no longer relate to the per-car Fast/PV Eco selector at all — there's nothing for either to diverge from, so there's no "Custom" indicator any more (an earlier design had one; see [INTEGRATION.md](INTEGRATION.md#strategy-derivation--charging-control) if you're comparing against older notes). When Charging control is Manual, the section shows a **"System paused"** note explaining chargers are under manual control with the Fuse Guard still active, and auto-expands so the cause is always visible; the per-car controls on every Car Card grey out in place (visible, disabled) while this is active — see below.

Config: `health_entity` (default `sensor.ev_system_health`), `car1_name_entity` / `car2_name_entity`.

---

## Car Card (`ev-charging-car-card`)

One instance per car.

**Header** — car name, live status badge.

**Charger row** — shows which physical charger this car is assigned to (`go-e` / `TopAC` / `Not assigned`, names configurable), tap to open a chooser writing `ev_chargerN_car`. See [INTEGRATION.md](INTEGRATION.md#car--charger-mapping).

**Strategy** — **collapsed by default**, like Advanced on the common card. For a car that lives on a non-PV-capable charger there is nothing to choose, and a permanently greyed-out PV Eco button is just noise; collapsing keeps it available for checking without spending card real estate on it.

The collapsed header carries the **effective** strategy — what the car will actually do — so nothing that matters is hidden:

| Header | Situation |
|---|---|
| `☀️ PV Eco` | On a PV-capable charger with PV Eco selected — honoured |
| `⚡ Fast` | Fast selected (or the charger isn't PV-capable and Fast is chosen) |
| `⚡ Fast (PV Eco needs go-e)` *(orange)* | Stated intent is PV Eco, but the current charger can't honour it |
| `⚡ Fast (no charger)` *(orange)* | Stated intent is PV Eco, but no charger is assigned |

Expanding reveals the Fast / PV Eco segmented control and a hint line. PV Eco is disabled when the car's charger isn't PV-capable *and* the stored intent isn't already PV Eco.

**Intent is never silently reset.** If a car's stated strategy is PV Eco but it's swapped onto a non-capable charger, the helper keeps `pv_eco` and the header reports the truth (`Fast (PV Eco needs go-e)`). Resetting the helper would be worse than it looks: swap the car back to the go-e and it would silently charge from the grid on the next sunny day, because a swap days earlier had wiped the preference. Intent persists; the display is what tells the truth. When PV Eco is active and honoured, the hint shows the live solar forecast ("~14 kWh solar remaining today", or a low-sun warning below a configurable threshold).

**Boost button** — one label regardless of Fast/PV Eco context (see [INTEGRATION.md](INTEGRATION.md#boost)):

| State | Label |
|---|---|
| Idle | `Boost — full power, max N h` (N from the configured Boost duration) |
| Active | `Boosting — until HH:MM or target · tap to cancel` |

An earlier design gave Fast and PV Eco genuinely different wording ("Charge now — skip price schedule" vs. "Boost — full power") to reflect that "full power" means something different in each mode. That distinction isn't in the current card — both contexts share the single label above.

**Stat tiles** — SoC, allocated current, slot time (`Until HH:MM` while charging, `From HH:MM` while waiting). These stay fully visible and live even when the card's other controls are greyed out (see below) — the operator still wants to see state, just can't act on it from here.

**Charging Target** — Minimal / Normal / Trip segmented control.

**Deadline** — tap-to-edit time picker.

**System-paused state** — while Charging control (`ev_charging_lb`) is Manual (the kill switch — see [Common Card](#common-card-ev-charging-common-card) above), this card's interactive controls (charger assignment, Strategy, Boost, Charging Target, Deadline) are greyed and disabled in place, and the strategy hint line (inside the collapsed Strategy section) is replaced with "System paused — manual control via app." The Strategy header stays clickable so the effective strategy can still be inspected. The status badge and stat tiles are unaffected.

Config: `car` (1 or 2, required), `soc_entity` (required), `status_entity`, `car_name_entity`, `charger1_name` / `charger2_name` (default "Charger 1"/"Charger 2"), `pv_capable_chargers` (default `[1]`), `pv_forecast_entity` (default `sensor.fmi_pv_remaining_today_kwh`), `pv_low_kwh` (default 5).

---

## Plan Card (`ev-charging-plan-card`)

One instance per car — compact summary of the computed Fast-flow charging plan: scheduled slot count, total scheduled time, average price, min–max price range. Shows `0` slots / "Not charging" when nothing is scheduled, a clear signal current settings would leave the car uncharged.

Config: `car` (1 or 2, required).

---

## Settings Card (`ev-charging-settings-card`)

Advanced numeric settings via the reusable spinner picker: Super Cheap price threshold, per-car Minimal/Normal/Trip SoC targets, and Boost duration.

---

## Status Badges

| Badge | Meaning |
|---|---|
| **Charging** (green) | Actively charging |
| **Scheduled** (green) | Connected, waiting for a scheduled slot (Fast only) |
| **Not Scheduled** (orange) | Connected, no upcoming slots planned (Fast only) |
| **Waiting for sun** (grey) | PV Eco: connected, surplus not yet sufficient to start |
| **Grid Limit** (orange) | Load balancer limiting due to grid headroom |
| **Paused — Overload** (orange) | Stopped by the 10-minute overload cooldown |
| **Paused — Car** (grey) | Car stopped drawing (full, or car-side schedule) |
| **Not Connected** (grey) | No car plugged in, **or** this car has no charger assignment |

Live data comes from the Fast Flow Status Publisher (MQTT → `sensor.ev_charging_status`), mapping-aware since the [car↔charger mapping layer](INTEGRATION.md#car--charger-mapping) — a car's status always reflects whichever physical charger it's actually assigned to, not a fixed one.

The publisher is also **strategy-aware**: for a car the PV Tracker owns, price-schedule concepts don't apply, so `Scheduled` / `Not Scheduled` are replaced by `Waiting for sun`, and the slot tile reads **Solar / N.N kW** — the live surplus the PV Tracker is working with — instead of `From HH:MM` (there is no scheduled slot — the car follows surplus). Reads `sensor.ev_pv_eco_status`'s `surplus_kw` attribute (PV Eco's own status sensor, published from the separate PV Eco flow); shows **—** only when that sensor has no data yet (PV Eco flow not deployed, or before its first publish) — a genuine 0.0 kW surplus is shown as such, not hidden behind a dash. `Charging`, `Not Connected` and `Fault` mean the same thing under either strategy. Boost temporarily returns a PV Eco car to Fast semantics, since Boost is a fast-flow action.

---

## Example Dashboard YAML

```yaml
type: custom:ev-charging-common-card

type: custom:ev-charging-car-card
car: 1
soc_entity: sensor.YOUR_CAR1_SOC_SENSOR
charger1_name: go-e
charger2_name: TopAC

type: custom:ev-charging-plan-card
car: 1

type: custom:ev-charging-car-card
car: 2
soc_entity: sensor.YOUR_CAR2_SOC_SENSOR
charger1_name: go-e
charger2_name: TopAC

type: custom:ev-charging-plan-card
car: 2

type: custom:ev-charging-settings-card
```

Cards are independent — one view, or paired with each car's cards on separate tabs. Adapt automatically to HA light/dark themes.

---

## Dashboard Visualisation (ApexCharts)

Separate from the custom cards above — `apexcharts_car1.yaml` / `apexcharts_car2.yaml` show the 24-hour Fast-flow schedule per vehicle (scheduled slots highlighted), reading from `sensor.ev_charging_schedule`'s `timestamps`/`prices`/`allowed`/`status` attribute arrays. `nordpool_apex.yaml` shows raw prices independently of the charging automation. Requires [apexcharts-card](https://github.com/RomRider/apexcharts-card) ≥ 2.2.3 via HACS.
