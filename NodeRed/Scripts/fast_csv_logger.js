/************************************************************
 * EV Fast Flow — CSV Logger
 *
 * Persistent, centralised log of everything needed to diagnose a Fast
 * Flow scheduling anomaly after the fact — the gap this closes: Fast
 * Flow had NO equivalent of PV Eco's csv_logger.js. Node-RED's debug
 * pane isn't persisted, and HA's own entity history only captures a
 * handful of coarse, discrete-state helpers — neither shows what the
 * Evaluator actually computed on a given cycle. Investigating one real
 * incident (charging allowed for a few minutes outside the scheduled
 * slot, twice, self-correcting at the next slot boundary) required
 * reconstructing partial context from HA history alone, because no
 * direct record of the Evaluator's per-cycle decision existed anywhere.
 *
 * Wire from Evaluator's OUTPUT 3 (the same unconditional trigger Status
 * Publisher uses) — NOT output 1/2. Those go null for a PV-owned charger
 * by design; a logger wired to them would silently stop logging that
 * charger the moment PV Eco engages, which is exactly the "wired to a
 * conditional output" bug this project has hit before (see
 * STATUS_PUBLISHER output-3 fix). Output 3 fires every cycle regardless.
 *
 * Reads flow-context keys already established by evaluator.js and
 * coordinator.js (reportedFrc/reportedAmp/carState from assembler.js;
 * frc/schedulerAllows from evaluator.js; didwestop/lb_wants_stop from
 * coordinator.js) — same ground truth ev_status_publisher.js uses, so a
 * logged row and the live dashboard badge can never silently disagree.
 *
 * Runs once per Evaluator cycle (currently every 1 minute) — fine
 * resolution for the incident this was built for (a 3-minute anomaly
 * would show as 2-3 consecutive rows).
 ************************************************************/

// ═══ MAPPING RESOLVER v1 — DO NOT EDIT IN ISOLATION ═══════════
// Byte-identical copies live in: coordinator.js, evaluator.js,
// planner_car1.js, planner_car2.js, ev_status_publisher.js,
// fast_csv_logger.js.
// Semantic twins (same rules, other runtimes): ev_strategy.py
// (pyscript), ev-charging-cards.js (_myCharger). Edit all together
// and bump the version everywhere; the repo's check_resolver_sync.py
// fails loudly on divergence.
//
// input_select.ev_chargerN_car: "Car 1" | "Car 2" | "None".
// Missing/unexpected helper state → legacy mapping (charger N → car N).
function assignedCar(chargerN) {
    const s = global.get(
        `homeassistant.homeAssistant.states['input_select.ev_charger${chargerN}_car'].state`
    );
    if (s === "Car 1") return 1;
    if (s === "Car 2") return 2;
    if (s === "None")  return null;
    return chargerN;                  // helper missing → legacy mapping
}
function chargerOfCar(carN) {
    if (assignedCar(1) === carN) return 1;
    if (assignedCar(2) === carN) return 2;
    return null;
}
// ═══ END MAPPING RESOLVER v1 ═══════════════════════════════════

const SLOT_MS = 15 * 60 * 1000;

function carStrategy(carNum) {
    if (carNum == null) return "fast";
    return global.get(
        `homeassistant.homeAssistant.states['input_select.ev_car${carNum}_strategy'].state`
    ) || "fast";
}
function pvOwnedCharger(chargerN, carNum) {
    const boosting = carNum != null && global.get(
        `homeassistant.homeAssistant.states['input_boolean.ev_car${carNum}_boost'].state`
    ) === "on";
    const PV_CAPABLE_CHARGERS = [1];   // {1} today → {1,2} with a 2nd go-e
    return PV_CAPABLE_CHARGERS.includes(chargerN)
        && carStrategy(carNum) === "pv_eco"
        && !boosting;
}

// Safe formatters — never let one bad field break the whole row.
function s(v) { return (v === null || v === undefined) ? "" : String(v); }
function f(v, n = 2) {
    return (typeof v === "number" && isFinite(v)) ? v.toFixed(n) : "";
}
function b(v) { return v === true ? "1" : v === false ? "0" : ""; }

function chargerRow(chargerN) {
    const carN = assignedCar(chargerN);
    return {
        car:              s(carN),
        carState:         s(flow.get(`charger${chargerN}.carState`)),
        frcCommanded:     s(flow.get(`charger${chargerN}.frc`)),
        frcPolled:        s(flow.get(`charger${chargerN}.reportedFrc`)),
        ampReported:      s(flow.get(`charger${chargerN}.reportedAmp`)),
        schedulerAllows:  b(flow.get(`charger${chargerN}.schedulerAllows`)),
        lbWantsStop:      b(flow.get(`lb_wants_stop_${chargerN}`)),
        didwestop:        s(flow.get(`charger${chargerN}.didwestop`)),
        boost:            b(carN != null && global.get(
                              `homeassistant.homeAssistant.states['input_boolean.ev_car${carN}_boost'].state`
                          ) === "on"),
        strategy:         s(carStrategy(carN)),
        pvOwned:          b(pvOwnedCharger(chargerN, carN)),
        fault:            s(flow.get(`charger${chargerN}.errState`)),
    };
}

const nowTs = Date.now();
const slots = flow.get('nordpool_slots') || [];
const curSlot = slots.find(sl => sl.ts <= nowTs && (sl.ts + SLOT_MS) > nowTs);

const chargingMode = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_charging_mode'].state"
) || "";
const chargingLb = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_charging_lb'].state"
) || "";
const fuseStop = b(global.get("ev_fuse_stop") === true);

const c1 = chargerRow(1);
const c2 = chargerRow(2);

const columns = [
    "ts", "charging_mode", "charging_lb", "fuse_stop",
    "c1_car", "c1_carState", "c1_frc_commanded", "c1_frc_polled", "c1_amp_reported",
    "c1_scheduler_allows", "c1_lb_wants_stop", "c1_didwestop", "c1_boost", "c1_strategy",
    "c1_pv_owned", "c1_fault",
    "c2_car", "c2_carState", "c2_frc_commanded", "c2_frc_polled", "c2_amp_reported",
    "c2_scheduler_allows", "c2_lb_wants_stop", "c2_didwestop", "c2_boost", "c2_strategy",
    "c2_pv_owned", "c2_fault",
    "slot_ts", "slot_price", "slots_count"
];

const row = [
    new Date(nowTs).toISOString(), s(chargingMode), s(chargingLb), fuseStop,
    c1.car, c1.carState, c1.frcCommanded, c1.frcPolled, c1.ampReported,
    c1.schedulerAllows, c1.lbWantsStop, c1.didwestop, c1.boost, c1.strategy,
    c1.pvOwned, c1.fault,
    c2.car, c2.carState, c2.frcCommanded, c2.frcPolled, c2.ampReported,
    c2.schedulerAllows, c2.lbWantsStop, c2.didwestop, c2.boost, c2.strategy,
    c2.pvOwned, c2.fault,
    s(curSlot ? curSlot.ts : null), curSlot ? f(curSlot.price, 3) : "", s(slots.length)
];

// Header once, on the file's first-ever write (persisted across restarts
// via a flow-context flag — same pattern as csv_logger.js).
let out = "";
if (!flow.get('fastCsv.headerWritten')) {
    out = columns.join(",") + "\n";
    flow.set('fastCsv.headerWritten', true);
}
out += row.join(",");

msg.payload = out;
return msg;
