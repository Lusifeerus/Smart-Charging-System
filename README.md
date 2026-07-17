# Smart Charging System

Automated two-car EV charging for Home Assistant and Node-RED, combining two complementary strategies under one dashboard: **Fast** (Nord Pool dynamic pricing, SoC-aware scheduling, real-time load balancing) and **PV Eco** (solar-surplus tracking, tightly integrated with a home battery). A shared safety, mapping, and monitoring layer couples the two into one system without merging their code.

**What it does**
- Real-time load balancing across two heterogeneous chargers (go-e + Shelly TopAC), keeping total household current within the main fuse
- Nord Pool dynamic pricing — schedules Fast charging into the cheapest 15-minute slots, per car, respecting a deadline
- SoC-aware allocation — prioritises whichever car needs it more when both are charging
- PV surplus tracking — charges from solar surplus with a home-battery-aware reserve, deferring to grid sell during high-price export windows
- One-tap Fast / PV Eco switching per car, with automatic go-e phase switching (3-phase for Fast, 1-phase for PV Eco surplus tracking)
- Boost — temporary full-power charging in either mode, ends at target SoC or timeout, never disturbs the other car's schedule
- Independent main-fuse protection (Fuse Guard) that supervises current regardless of which mode either charger is in
- Aggregated system health monitoring with a dashboard badge that stays silent when everything is fine
- Custom iOS-style Lovelace dashboard: per-car strategy, Boost, charger assignment, live status, and system health

**Design philosophy**, carried through every layer: stateless per-minute/per-tick evaluation loops, Home Assistant helpers as the sole state store, independent dumb safety watchdogs that don't trust the smart layer to be alive, declarative config as the single source of truth, fail-safe behaviour on unavailable sensors, and evidence-first validation (execution-tested, not just reviewed) before anything ships.

---

## A note on using this

This is a personal hobby project, built for one specific setup — my two cars, my chargers, my battery, my grid tariff. It isn't a polished product or a general-purpose add-on, and it doesn't try to be. It's shared in case it's useful to you: as a working blueprint, a source of ideas, or a starting point to bend toward your own needs.

For most setups it should adapt fairly cleanly. The docs deliberately call out what actually needs changing — which sensor entity IDs to repoint for a different battery or forecast source (see [PV_ECO_FLOW.md → Adapting to other integrations](docs/PV_ECO_FLOW.md#adapting-to-other-integrations-and-data-sources)), and how to map a different charger brand onto the same small command contract (see [FAST_FLOW.md → Adapting to other charger brands](docs/FAST_FLOW.md#adapting-to-other-charger-brands)). Different hardware, a different electricity market, no home battery at all — all of these are anticipated and documented rather than hard-coded assumptions.

And if you get stuck adapting it: hand this repository to Claude and ask. It knows this system well and will happily walk through the changes with you.

---

## Which document do I need?

| Doc | Covers |
|---|---|
| **[docs/FAST_FLOW.md](docs/FAST_FLOW.md)** | Nord Pool scheduling, SoC-aware planning, two-charger load balancing, the Coordinator/Evaluator split, Shelly integration, hardware variants |
| **[docs/PV_ECO_FLOW.md](docs/PV_ECO_FLOW.md)** | Solar surplus tracking, the home-battery reserve planner, price-aware export deferral, forecast sourcing — and the alternative go-e-only approach for setups without a home battery |
| **[docs/INTEGRATION.md](docs/INTEGRATION.md)** | Everything that only exists because both flows now share one system: car↔charger mapping, strategy derivation, Boost, phase switching, Fuse Guard, health monitoring, SoC staleness handling |
| **[docs/UI.md](docs/UI.md)** | The Lovelace cards: layout, controls, status badges, config options |

Each doc is self-contained enough to read alone if you only care about one part — but the Fast and PV Eco flows are no longer independent in practice, so if you're changing anything touching strategy switching, chargers, or safety, read INTEGRATION.md too.

---

## System Map

```
                         ┌─────────────────────────┐
                         │  Lovelace Dashboard     │   docs/UI.md
                         │  (ev-charging-cards.js) │
                         └────────────┬────────────┘
                                      │ reads/writes HA helpers
                   ┌──────────────────┼────────────────┐
                   ▼                                   ▼
      ┌──────────────────────────┐        ┌──────────────────────────┐
      │  INTEGRATION LAYER       │        │  INTEGRATION LAYER       │
      │  car↔charger mapping     │◄──────►│  strategy derivation &   │
      │  (ev_chargerN_car)       │        │  derivation, Boost, phase│
      │                          │        │  switching (pyscript)    │
      └────────────┬─────────────┘        └────────────┬─────────────┘
                   │                                   │
                   ▼                                   ▼
      ┌──────────────────────────┐        ┌──────────────────────────┐
      │  FAST FLOW (Node-RED)    │        │  PV ECO FLOW (Node-RED)  │
      │  docs/FAST_FLOW.md       │        │  docs/PV_ECO_FLOW.md     │
      │                          │        │                          │
      │  Nord Pool price/SoC     │        │  Solar surplus tracking, │
      │  scheduling, 2-charger   │        │  home-battery reserve    │
      │  load balancing          │        │  planning                │
      └────────────┬─────────────┘        └────────────┬─────────────┘
                   │                                   │
                   └──────────────────┬────────────────┘
                                      ▼
                         ┌─────────────────────────┐
                         │  go-e (Charger 1)       │
                         │  Shelly TopAC           │
                         │  (Charger 2, Fast only) │
                         └────────────┬────────────┘
                                      │ (always active, either mode)
                                      ▼
                         ┌─────────────────────────┐
                         │  FUSE GUARD             │   docs/INTEGRATION.md
                         │  independent stop-only  │
                         │  main-fuse protection   │
                         └─────────────────────────┘

                         ┌─────────────────────────┐
                         │  SYSTEM HEALTH SENSOR   │   docs/INTEGRATION.md
                         │  aggregates heartbeats  │
                         │  from every layer above │
                         └─────────────────────────┘
```

Only Charger 1 (go-e) supports PV Eco today, because only go-e supports the phase switching PV Eco's surplus tracking relies on. Charger 2 (Shelly TopAC) is fixed 3-phase and Fast-only — see [docs/INTEGRATION.md](docs/INTEGRATION.md#car--charger-mapping) for how the UI handles that gracefully.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Home Assistant | With the [Nord Pool integration](https://www.home-assistant.io/integrations/nordpool/) installed |
| Node-RED | As a Home Assistant add-on or standalone, with `node-red-contrib-home-assistant-websocket` and `node-red-contrib-cron-plus` |
| pyscript | For the integration layer (strategy derivation, Boost, phase switching, SoC watchdog) — see docs/INTEGRATION.md |
| MQTT broker | e.g. Mosquitto add-on in HA |
| go-e Charger | Charger 1 — local HTTP API enabled, supports phase switching |
| Shelly TopAC EVE01-11R | Charger 2 — local HTTP API accessible (Fast-only) |
| 3-phase grid current sensor | Reports per-phase current to HA (L1/L2/L3) — used by both the Fast Coordinator and the Fuse Guard |
| Home battery integration | For PV Eco's reserve planning — built against Elisa Kotiakku (Huawei LUNA2000), adaptable to others; see docs/PV_ECO_FLOW.md |
| Solar production data | Local inverter/PV sensors plus an optional FMI or Solcast forecast source |

> **Optional:** [apexcharts-card](https://github.com/RomRider/apexcharts-card) via HACS for dashboard visualisation.

---

## Installation Order

Each doc has its own detailed installation steps for its own layer. Recommended order, since later layers depend on earlier ones:

1. **HA helpers** — start with `docs/FAST_FLOW.md`'s helper set (core per-car config), then add the mapping/strategy/boost/fuse-guard/health helpers from `docs/INTEGRATION.md`
2. **Fast Flow** — import and configure per `docs/FAST_FLOW.md`; verify it works standalone first (Fast mode only, no PV Eco yet)
3. **PV Eco Flow** — import and configure per `docs/PV_ECO_FLOW.md`; verify it works with the strategy helper set manually to `pv_eco`
4. **Integration layer** — pyscript module, Fuse Guard node, health template, resolver sync check — per `docs/INTEGRATION.md`; this is what makes one-tap switching and Boost work
5. **Dashboard** — cards per `docs/UI.md`

Deploying steps 1–3 alone gives you a working system with manual mode-switching via HA helpers, no UI polish. Steps 4–5 add the UI and safety layer on top without touching the flows underneath — the whole design keeps these steps independently useful.

---

## File Reference

| File | Module | Purpose |
|---|---|---|
| `NodeRed/flows_template.json` | Fast Flow | Node-RED flow template |
| `NodeRed/Scripts/coordinator.js` | Fast Flow | Load balancing coordinator |
| `NodeRed/Scripts/evaluator.js` | Fast Flow | Scheduler gate and frc controller (Boost + Fuse Guard aware) |
| `NodeRed/Scripts/planner_car1.js` / `planner_car2.js` | Fast Flow | Per-car slot planner |
| `NodeRed/Scripts/parser.js` | Fast Flow | Nord Pool price data parser |
| `NodeRed/Scripts/assembler.js` | Fast Flow | Combines charger polls and grid reading |
| `NodeRed/Scripts/lb_gate.js` | Fast Flow | Load balancing mode gate |
| `NodeRed/Scripts/shelly_*.js` | Fast Flow | Shelly TopAC integration |
| `NodeRed/Scripts/ha_formatter.js`, `debug_slots.js` | Fast Flow | Schedule formatting / debugging |
| `NodeRed/Scripts/mqtt_discovery.js` | Fast Flow | Registers HA MQTT sensors (also PV status — see below) |
| `NodeRed/Scripts/ev_status_publisher.js` | Fast Flow | Publishes per-car live status + health block |
| `NodeRed/Scripts/fuse_guard.js` | Integration | Independent main-fuse protection |
| `NodeRed/pv_eco_flows_template.json` | PV Eco | Node-RED flow template (separate tab from Fast Flow) |
| `NodeRed/go-e_PV_Surplus.json` | PV Eco | Alternative no-battery flow — feeds grid power to go-e Eco mode, see [PV_ECO_FLOW.md](docs/PV_ECO_FLOW.md#alternative-go-e-built-in-eco-mode-no-home-battery) |
| `NodeRed/Scripts/power_assembler.js` | PV Eco | Sensing layer — surplus source mode selection |
| `NodeRed/Scripts/fast_tracker.js` | PV Eco | Inner loop — surplus tracking control law |
| `NodeRed/Scripts/slow_planner.js` | PV Eco | Outer loop — battery reserve planning |
| `NodeRed/Scripts/pv_status_publisher.js` | PV Eco | Publishes PV status + health block |
| `NodeRed/Scripts/csv_logger.js`, `solcast_logger.js` | PV Eco | Telemetry / forecast logging |
| `HomeAssistant/pyscript/ev_strategy.py` | Integration | Strategy derivation (posture summary), Boost, phase switching, SoC watchdog |
| `HomeAssistant/www/ev-charging-cards.js` | UI | Lovelace cards |
| `HomeAssistant/packages/ev_helpers.yaml` | Fast Flow | Core per-car helpers |
| `HomeAssistant/packages/ev_pv_helpers.yaml` | PV Eco | Surplus tracking / reserve planner helpers |
| `HomeAssistant/packages/ev_mapping_helpers.yaml` | Integration | Car↔charger assignment |
| `HomeAssistant/packages/ev_strategy_helpers.yaml` | Integration | Per-car strategy, Boost |
| `HomeAssistant/packages/ev_fuse_guard_package.yaml` | Integration | Fuse Guard tuning + notifications |
| `HomeAssistant/packages/ev_health_package.yaml` | Integration | System health sensor + notifications |
| `HomeAssistant/packages/ev_phase_switch.yaml` | Integration | go-e psm rest_command |
| `HomeAssistant/packages/nordpool.yaml` | Fast Flow | Nord Pool template sensor |
| `HomeAssistant/packages/apexcharts_*.yaml` | Fast Flow | Dashboard schedule visualisation |
| `tools/check_resolver_sync.py` | Integration | Repo hygiene: catches divergence in the duplicated mapping resolver |
| `go-e_PV_Surplus.json` | PV Eco (alternative) | go-e built-in Eco mode — for setups without a home battery, see docs/PV_ECO_FLOW.md |

---

## Credits

This flow was originally inspired by the [Load balance and prioritise charging over 2 Victron EVCS](https://flows3.nodered.org/flow/52550767074d398183eaad8bd64b62ae) Node-RED flow, though little of the original code remains after the architectural changes described in this documentation.

The Nord Pool template sensor configuration and Nord Pool ApexCharts card are based on the guide [Home Assistant: Migrating to the Official Nord Pool Integration](https://www.creatingsmarthome.com/index.php/2025/09/12/home-assistant-migrating-to-the-official-nord-pool-integration/) by [Toni Korhonen](https://github.com/kotope). The sensor was modified to include the first hour of the day (00:00–01:00) by fetching the previous day's prices, necessary for overnight scheduling in the Finnish Nord Pool price zone.
