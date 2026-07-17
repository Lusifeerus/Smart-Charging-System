/************************************************************
 * PV Eco — Power Assembler  (v1.1)
 *
 * Sensing layer for the PV Eco strategy. Runs every ~10 s from
 * the inject; reads all sensors via global.get (no Join needed).
 *
 * v1.1 CHANGES (architecture review F1/F3/F4):
 *  - SURPLUS-SOURCE MODE selection now lives HERE, not in the
 *    tracker. The assembler decides which signal is "the surplus"
 *    and every downstream consumer (tracker, status publisher,
 *    CSV logger) sees the same truth:
 *      surplus_source = "battery"  → surplus = solar_to_battery
 *                       "export"   → surplus = solar_to_grid
 *                                    (battery full; PV routes to grid)
 *      "defer_sell" → sustained P1 export during a high-sell
 *                     price slot: the operator is selling (or selling
 *                     is economically right) → car defers (v1.2, §6b)
 *  - Window-quantised reading stamp: the Kotiakku API aggregates
 *    5-minute clock-aligned windows, so the stamp is the window
 *    bucket of last_updated, NOT raw last_updated. One-step-per-
 *    reading correctness now follows from documented API behaviour,
 *    independent of HA poll frequency or state-write semantics.
 *  - Config reads use Number.isFinite (a helper set to 0 is a
 *    legitimate value, not "unset").
 ************************************************************/

const VOLTAGE       = 230;
const MIN_PV_KW     = 0.5;   // below this, "not producing" → car off
const SUM_TOLERANCE = 0.5;   // kW tolerance, solar-sum consistency check
const API_WINDOW_MS = 300000; // Kotiakku API: 5-min clock-aligned windows

// ---- Read HA state ----
const H = global.get("homeassistant.homeAssistant.states");
if (!H) { node.warn("PV assembler: HA states not available yet"); return null; }

function num(entity) {
    const v = Number(H[entity]?.state);
    return Number.isFinite(v) ? v : null;
}
function str(entity) {
    return H[entity]?.state ?? null;
}
function hlp(name, dflt) {
    const v = Number(H[`input_number.${name}`]?.state);
    return Number.isFinite(v) ? v : dflt;
}

const solarToBattery = num("sensor.kotiakku_solar_to_battery_kw");
const pvTotal        = num("sensor.kotiakku_solar_power_kw");
const solarToGrid    = num("sensor.kotiakku_solar_to_grid_kw")  ?? 0;
const solarToHouse   = num("sensor.kotiakku_solar_to_house_kw") ?? 0;
const battSoc        = num("sensor.kotiakku_state_of_charge_percent");
const battStateRaw   = str("sensor.kotiakku_battery_state");
const gridToBattery  = num("sensor.kotiakku_grid_to_battery_kw") ?? 0;

const p1PowerW       = num("sensor.p1_meter_power");   // +import / −export, ~10 s local

const carAmp         = num("sensor.garage_go_echarger_allowed_charge_current") ?? 0;
const carStateStr    = str("sensor.garage_go_echarger_car_state");
const carPowerW      = num("sensor.garage_go_echarger_power_total");
// Bridge's own string enum (value_template output) — map on STRINGS, not
// numbers. This bridge's numeric err/car codes do NOT match go-e's
// official API numbering past a certain index (verified against
// goecharger/go-eCharger-API-v2 — diverges from position 11 in err, and
// adds car states the official spec doesn't have). Strings are the only
// safe common ground between this bridge and the official spec.
const errStateStr    = str("sensor.garage_go_echarger_error_state");

if (solarToBattery === null || pvTotal === null) {
    node.warn("PV assembler: solar_to_battery or solar_power unavailable — skipping cycle");
    return null;
}

// ---- Window-quantised reading stamp (v1.1, review F4; v1.4 per-source fix) ----
// The API serves the previous COMPLETE 5-min clock window. Quantise
// last_updated into that window grid: the stamp advances exactly once per
// data window, regardless of how often HA polls or rewrites state.
//
// v1.4: MUST be taken from whichever sensor actually drives the CURRENT
// surplus signal, not always solar_to_battery. Confirmed live bug: while
// the battery sits full (export mode, surplus = solar_to_grid), Kotiakku
// only pushes a new state for solar_to_battery when its VALUE changes —
// and it's pinned at exactly 0.000 the whole time the battery is full, so
// its last_updated never advances. The tracker's start-sustain gate reads
// this stamp to count "distinct readings"; frozen at one value forever, it
// can never accumulate evidence, so PV Eco never starts during export mode
// no matter how much real, fluctuating surplus is available via the grid
// export — the assembler correctly showed "export | surplus 2.6kW" the
// entire time. Fix: compute the stamp for BOTH candidate sensors here;
// pick the one matching the mode actually selected below.
function windowStamp(entity) {
    const raw = H[entity]?.last_updated || H[entity]?.last_changed || null;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? String(Math.floor(ms / API_WINDOW_MS)) : null;
}
const battFlowStamp = windowStamp("sensor.kotiakku_solar_to_battery_kw");
const gridFlowStamp = windowStamp("sensor.kotiakku_solar_to_grid_kw");

// ---- go-e car_state string → numeric code ----
// default changed 1 (Idle) → 0 (Unknown): silently claiming "Idle" for
// an unrecognised string (e.g. a genuine Error/Initializing before this
// fix listed them) hid real charger problems behind a normal-looking
// value. Downstream (fast_tracker.js) already stops on carCar !== 2/3/4
// implicitly via its own gates, so this only changes what gets reported,
// not whether charging correctly stops.
function mapCarState(s) {
    switch ((s || "").toLowerCase()) {
        case "unknown":      return 0;
        case "idle":         return 1;
        case "charging":     return 2;
        case "waitcar":      return 3;
        case "complete":     return 4;
        case "error":        return 5;
        case "initializing": return 6;
        default:              return 0;   // genuinely unrecognised → Unknown, not Idle
    }
}
const carCar = mapCarState(carStateStr);

// Charger fault, from the bridge's own string (not renumbered — see
// note above).
//
// FAULT DETECTION REQUIRES POSITIVE EVIDENCE. Home Assistant's own
// sentinel states for "this entity has no value right now" are the
// lowercase strings "unknown" and "unavailable" — they are NOT go-e
// error codes. The MQTT error_state topic is not retained, so after an
// HA restart this sensor sits at "unknown" until the go-e next
// publishes an err message. An earlier version of this check treated
// any string != "none" as a fault, which made a missing reading
// permanently block PV Eco charging (confirmed live: the tracker
// re-sent frc=1 every 10 s, overriding even a manual 16 A set from the
// go-e app). Wrong fail-safe direction: a charger fault stopping
// charging is safe; an absent sensor doing so is not.
//
// CASE-SENSITIVE ON PURPOSE. The bridge has a legitimate error name
// "Unknown" (capital U) which must still register as a real fault.
// HA's sentinel is lowercase "unknown". Do not "simplify" this with
// toLowerCase() — that reintroduces the bug for a real Unknown fault
// or, worse, for the sentinel.
const HA_NO_VALUE = ["unknown", "unavailable", ""];
const charger1Fault =
    (errStateStr != null &&
     !HA_NO_VALUE.includes(errStateStr) &&   // exact, case-sensitive
     errStateStr !== "None")
        ? errStateStr
        : null;
// Distinct from "no fault": we don't KNOW whether there's a fault.
// Surfaced for the health/debug layers; never used to block charging.
const charger1FaultUnknown =
    (errStateStr == null || HA_NO_VALUE.includes(errStateStr));

// ---- Consistency check: solar_power ≈ to_battery + to_grid + to_house ----
const sumParts   = solarToBattery + solarToGrid + solarToHouse;
const consistent = Math.abs(sumParts - pvTotal) <= SUM_TOLERANCE;
if (!consistent) {
    node.warn(`PV assembler: solar sums inconsistent (Σparts=${sumParts.toFixed(2)} vs total=${pvTotal.toFixed(2)}) — skipping cycle`);
    return null;
}

// ---- Gates ----
const pvProducing = pvTotal >= MIN_PV_KW;

const battFullThreshold = hlp("ev_pv_battery_full_threshold", 96);
const batteryFull = (battSoc != null) && (battSoc >= battFullThreshold);

// Operator deliberately importing to charge the battery (price/forecast prep).
// Noise ceiling measured ~0.57 kW; real charging 3.6+ kW sustained.
const gridChargeThreshold = hlp("ev_pv_grid_charge_threshold_kw", 0.8);
// Below this, battery flow is idle noise, not real charging → surplusSource
// "idle" rather than a phantom "battery" surplus. Measured trickle sits
// ~0.05–0.17 kW; real charging is 3.6+ kW. 0.3 kW cleanly separates them.
const BATT_IDLE_KW = hlp("ev_pv_batt_idle_kw", 0.3);
const operatorChargingBattery = gridToBattery > gridChargeThreshold;

// ---- Sustained-export detector (v1.2, design note §6b) ----
// The fast local P1 meter sees operator sells instantly; the cloud sensors
// structurally cannot (5-min smearing). Balancing events are single ~10 s
// pulses at ~10 kW (measured), so a sustain requirement of even 60 s fully
// excludes them; deliberate sells run >=15 min at 1-4 kW (measured).
// Detection: every sample in the sustain window at/beyond the export
// threshold, with the window fully covered. Any single near-zero sample
// releases the gate immediately (fast release at slot end).
const EXPORT_DETECT_KW  = hlp("ev_pv_export_detect_kw", 1.0);
const EXPORT_SUSTAIN_S  = hlp("ev_pv_export_sustain_seconds", 120);

let sustainedExport = false;
{
    const nowMs = Date.now();
    let hist = flow.get("pv.p1History") || [];   // [{t, w}]
    if (p1PowerW !== null) hist.push({ t: nowMs, w: p1PowerW });
    // prune to sustain window (+small margin)
    const cutoff = nowMs - (EXPORT_SUSTAIN_S * 1000 + 15000);
    while (hist.length && hist[0].t < cutoff) hist.shift();
    flow.set("pv.p1History", hist);

    if (p1PowerW === null) {
        // P1 unavailable → fail safe: no defer without data
        sustainedExport = false;
    } else {
        const windowStart = nowMs - EXPORT_SUSTAIN_S * 1000;
        const inWindow = hist.filter(s => s.t >= windowStart);
        const covered  = hist.length > 0 && hist[0].t <= windowStart;
        sustainedExport = covered && inWindow.length > 0 &&
            inWindow.every(s => s.w <= -EXPORT_DETECT_KW * 1000);
    }
}

// ---- High-sell price slot? (shared Nord Pool ranking, v1.2) ----
// Mirrors the winter logic inverted: sell when the current slot is among the
// top-X highest-priced slots of the LOCAL day AND above the grid-premium
// floor (~5 c/kWh: below that, selling to buy back later is a guaranteed
// loss). Stale/absent ranking (winter parser not running) → gate off.
const SELL_FLOOR_CENTS   = hlp("ev_pv_sell_price_floor_cents", 5.0);
const SELL_RANK_SLOTS    = hlp("ev_pv_sell_rank_slots", 12);   // top-12 = 3 h/day
const NORDPOOL_MAX_AGE_H = hlp("ev_pv_nordpool_max_age_hours", 2);

function localDayKey(ts) {
    try {
        return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
    } catch (e) {
        // small-ICU fallback: fixed +3 (EEST — PV Eco is a summer strategy)
        return new Date(ts + 3 * 3600000).toISOString().slice(0, 10);
    }
}

let highSellSlot = false;
let currentPriceCents = null;
{
    const shared = global.get("nordpool_shared");
    const fresh = shared && Array.isArray(shared.slots) &&
        (Date.now() - (shared.published_at || 0)) < NORDPOOL_MAX_AGE_H * 3600000;
    if (fresh) {
        const nowMs = Date.now();
        const SLOT_MS = 15 * 60 * 1000;
        const cur = shared.slots.find(s => s.ts <= nowMs && (s.ts + SLOT_MS) > nowMs);
        if (cur) {
            currentPriceCents = cur.price;
            const todayKey = localDayKey(nowMs);
            const todaySlots = shared.slots.filter(s => localDayKey(s.ts) === todayKey);
            const rankSorted = todaySlots.slice().sort((a, b) => b.price - a.price);
            const rank = rankSorted.findIndex(s => s.ts === cur.ts);   // 0 = most expensive
            highSellSlot = (rank >= 0 && rank < SELL_RANK_SLOTS) &&
                           (cur.price >= SELL_FLOOR_CENTS);
        }
    }
}

// Operator selling (or selling economically right): sustained export during a
// high-sell slot. Price is decisive — this overrides battery-full (even a
// full battery yields to a high enough sell price).
const operatorSelling = sustainedExport && highSellSlot;

// ---- Battery reserve floor ----
const userReserve     = hlp("ev_pv_battery_reserve_kw", 0);
const computedReserve = flow.get("pv.computed_reserve_kw") || 0;

// ---- SURPLUS-SOURCE MODE SELECTION (v1.1, review F1) ----
// NORMAL ("battery"): battery accepts charge → surplus is what flows into it.
// EXPORT ("export"):  battery full → surplus appears as grid export instead.
//                     Reserve is zero: the battery needs nothing.
// All downstream consumers see surplus_source + surplus_kw + error — the
// tracker never remaps, the telemetry records what the controller acted on.
let surplusSource, surplusKw, battReserve;
if (operatorSelling) {
    // Selling wins over everything, including battery-full: the exported
    // energy is worth more sold than stored or driven (§6b).
    surplusSource = "defer_sell";
    surplusKw     = 0;
    battReserve   = 0;
} else if (batteryFull) {
    surplusSource = "export";
    surplusKw     = solarToGrid;
    battReserve   = 0;
} else if (solarToBattery < BATT_IDLE_KW) {
    // Battery flow near zero → it's idle, not meaningfully charging.
    // Classifying a ~0.1 kW trickle as "battery" with that value as
    // "surplus" was misleading (confirmed live: battState "idle" but
    // surplusSource "battery", surplusKw 0.05–0.17). Report idle with
    // ~zero surplus so downstream reasoning (and the CSV/debug) is honest.
    // NOTE: this does NOT change the start/stop decision — that surplus is
    // already far below the 2 kW start threshold either way — it only
    // makes the classification and telemetry truthful.
    surplusSource = "idle";
    surplusKw     = 0;
    battReserve   = Math.max(userReserve, computedReserve);
} else {
    surplusSource = "battery";
    surplusKw     = solarToBattery;
    battReserve   = Math.max(userReserve, computedReserve);
}
const error = surplusKw - battReserve;

// The stamp that actually reflects freshness of THIS cycle's surplus
// number. export → solar_to_grid's clock (that's the signal in play);
// everything else → solar_to_battery's clock (battery/idle both read it
// directly; defer_sell forces surplusKw=0 so staleness there is moot).
const surplusStamp = (surplusSource === "export") ? gridFlowStamp : battFlowStamp;

const phases  = flow.get("pv.car_phases") || 1;
const carDrawEstimate = (carAmp * VOLTAGE * phases) / 1000;
const carDrawMeasured = (carPowerW != null) ? carPowerW / 1000 : null;
const carDraw = (carDrawMeasured != null) ? carDrawMeasured : carDrawEstimate;

msg.payload = {
    // Control signal (mode-selected)
    surplusSource,
    surplusKw,
    battReserve,
    error,
    surplusStamp,   // renamed from solarToBatteryStamp (v1.4) — was always
                    // read as "the surplus signal's freshness clock"; now
                    // it actually IS that, mode-dependent, instead of
                    // always being the battery sensor's clock regardless
                    // of which sensor the current surplusKw came from.
    // Raw solar routing (telemetry)
    solarToBattery,
    pvTotal,
    solarToGrid,
    solarToHouse,
    // Battery
    battSoc,
    battState: battStateRaw,
    gridToBattery,
    // Car
    carAmp,
    carCar,
    charger1Fault,
    charger1FaultUnknown,
    carDraw,
    carDrawEstimate,
    carDrawMeasured,
    phases,
    // Gates
    pvProducing,
    batteryFull,
    operatorChargingBattery,
    operatorSelling,
    consistent,
    // v1.2 telemetry
    p1PowerW,
    sustainedExport,
    highSellSlot,
    currentPriceCents
};

// ── Live debug: one-glance node status (Fast-Flow pattern) ──
// Colour: green = surplus available to track, grey = no surplus / gated,
// red = a data problem (inconsistent snapshot, which skips the cycle).
{
    const src = surplusSource || "?";
    const gate =
        !consistent            ? "INCONSISTENT" :
        !pvProducing           ? "no PV" :
        operatorChargingBattery? "batt-charging" :
        operatorSelling        ? "selling" :
        batteryFull            ? "batt full→export" : "ok";
    const fill = !consistent ? "red"
               : (surplusKw > 0.1 && gate === "ok") ? "green" : "grey";
    node.status({
        fill, shape: "dot",
        text: `${src} | surplus ${Number(surplusKw).toFixed(1)}kW `
            + `err ${Number(error).toFixed(1)} | ${gate} `
            + `| batt ${battSoc}% ${charger1Fault ? "| FAULT " + charger1Fault : ""}`
    });
}

return msg;
