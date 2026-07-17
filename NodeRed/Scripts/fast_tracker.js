/************************************************************
 * PV Eco — Fast Tracker  (v1.1)
 *
 * Inner control loop. Runs every ~10 s after the Power Assembler.
 * Drives the mode-selected surplus signal toward the battery
 * reserve by giving the car the excess PV.
 *
 * Control law:
 *   error      = surplus_kw − battery_reserve   (from assembler)
 *   car_target = car_draw + GAIN × error
 *
 * v1.1 CHANGES (architecture review F1/F2/F3):
 *  - Consumes the assembler's mode-selected signal (surplusKw /
 *    error / surplusSource). The battery-full remap is GONE from
 *    here — mode selection lives in the assembler, so telemetry
 *    (CSV logger, status publisher) records exactly what this
 *    controller acted on.
 *  - Transition+refresh command pattern: go-e HTTP commands are
 *    sent only when the command CHANGES, plus a periodic refresh
 *    (self-healing against dropped requests) — not every 10 s.
 *    Cuts ~8000 identical requests/idle-day to ~a few hundred.
 *  - Config reads use Number.isFinite (0 is a legitimate value)
 *    and code defaults are synced to the tuned helper initials.
 *
 * Validated behaviours preserved unchanged:
 *  - Distinct-reading start debounce (unconditional accumulation)
 *  - Start/continue hysteresis + cloud-bridge hold
 *  - One-step-per-fresh-reading rate limiting (window-quantised
 *    stamp now supplied by the assembler)
 *  - Operator-charging / no-PV / not-connected gates
 *
 * Output 1 → go-e amp HTTP request
 * Output 2 → go-e frc HTTP request
 ************************************************************/

const VOLTAGE = 230;
const CHARGER_MAX = 16;
const MIN_AMP = 6;
const GO_E_IP = "192.168.1.XX";   // CHANGE ME: your go-e IP
const COMMAND_REFRESH_S = 300;   // resend identical command at most this often

// ---- Config (defaults synced to tuned helper initials, review F3) ----
const H = global.get("homeassistant.homeAssistant.states");
function hlp(name, dflt) {
    const v = Number(H?.[`input_number.${name}`]?.state);
    return Number.isFinite(v) ? v : dflt;
}

const GAIN = hlp("ev_pv_gain", 0.4);
const DEADBAND_KW = hlp("ev_pv_deadband_kw", 0.7);
const MIN_HOLD_MIN = hlp("ev_pv_min_hold_minutes", 4);
const START_THRESHOLD_KW = hlp("ev_pv_start_threshold_kw", 2.0);
const START_SUSTAIN_READINGS = hlp("ev_pv_start_sustain_readings", 2);
const CONTINUE_THRESHOLD_KW = hlp("ev_pv_continue_threshold_kw", 0.3);
const MAX_AMP_STEP = hlp("ev_pv_max_amp_step", 4);
const ADJUST_INTERVAL_S = hlp("ev_pv_adjust_interval_seconds", 60);

let d = msg.payload;
if (!d) { node.warn("PV tracker: no payload"); return null; }

// ═══ MAPPING RESOLVER TWIN v1 (H-bulk-read variant) ═══
// Same rules as the byte-identical JS resolver in coordinator.js et al.,
// but adapted to this file's bulk H = states read (H?.[entity]?.state)
// instead of per-entity global.get(). Edit together with the canonical
// copies and bump the version everywhere; check_resolver_sync.py tracks
// this twin. "Car 1"/"Car 2"/"None"; missing/unexpected → legacy N→N.
function assignedCar(chargerN) {
    const s = H?.[`input_select.ev_charger${chargerN}_car`]?.state;
    if (s === "Car 1") return 1;
    if (s === "Car 2") return 2;
    if (s === "None") return null;
    return chargerN;                  // helper missing → legacy mapping
}
// ═══ END MAPPING RESOLVER TWIN v1 ═══

// ---- KILL SWITCH gate (first — highest authority stand-down) ----
// "Charging control: Manual" (ev_charging_lb == "manual") is the system
// kill switch: the whole smart layer lets go so the user drives the
// charger from the go-e app. Emit NOTHING — do not even command a stop,
// because a stop is still a command that fights the user. Pure stand-down.
// (The LB gate silences the fast flow on the same flag; the Fuse Guard
// stays active on its own independent path.)
const chargingControl = H?.["input_select.ev_charging_lb"]?.state || "automatic";
if (chargingControl === "manual") {
    flow.set("pv.status", "Kill switch (manual control)");
    node.status({ fill: "grey", shape: "ring", text: "kill switch — system paused" });
    return null;   // stand down completely — no amp, no frc, nothing
}

// ---- Strategy gate (PER-CHARGER, not global) ----
// This tracker drives the go-e = charger 1, the only PV-capable charger
// today. Read the strategy of the car ASSIGNED to charger 1, not the
// global posture summary — so that when a second PV-capable charger is
// added (PV_CAPABLE_CHARGERS {1} → {1,2}) each tracker instance correctly
// keys off its own charger's car. With one go-e this is identical to the
// old global read (the global == this car's strategy when only one PV
// charger exists), so it's a no-op today and correct-by-construction later.
const THIS_CHARGER = 1;                       // go-e
const assignedCarN = assignedCar(THIS_CHARGER);
const carStrategy = (assignedCarN != null)
    ? (H?.[`input_select.ev_car${assignedCarN}_strategy`]?.state || "fast")
    : "fast";                                 // unassigned charger → not PV
if (carStrategy !== "pv_eco") {
    flow.set("pv.status", "Not PV Eco strategy");
    node.status({ fill: "grey", shape: "ring", text: "not PV Eco — fast flow owns charger" });
    return null;   // this charger's car isn't on PV Eco — fast flow owns it
}

// ---- Fuse Guard gate (independent stop-only authority) ----
// Cooperative channel: the guard also direct-commands frc=1 every tick;
// this check keeps the tracker from fighting it in between. stop() goes
// through emit(), so the redundant command is suppressed automatically.
if (global.get("ev_fuse_stop") === true) return stop("Fuse guard active");

// ---- Command emission: transition + periodic refresh (review F2) ----
// State updates (lastAmp, holdSince, status) always happen; the HTTP command
// is emitted only if it differs from the last sent command, or the refresh
// interval has elapsed (self-healing for dropped requests — the reason we
// avoid pure send-on-change, same rationale as the winter flow's RBE removal).
function emit(amp, frc, status) {
    flow.set("pv.status", status);
    // Live debug: green when actually charging, grey when stopped/holding.
    node.status({
        fill: (frc === 0 && amp > 0) ? "green" : "grey",
        shape: (frc === 0 && amp > 0) ? "dot" : "ring",
        text: (frc === 0 && amp > 0)
            ? `charging ${amp}A (${d.phases}ph) | ${status}`
            : `stopped | ${status}`
    });
    const now = Date.now();
    const last = flow.get("pv.lastCmd") || {};
    if (last.amp === amp && last.frc === frc &&
        (now - (last.ts || 0)) < COMMAND_REFRESH_S * 1000) {
        return null;   // identical command sent recently — suppress
    }
    flow.set("pv.lastCmd", { amp: amp, frc: frc, ts: now });
    return [{ url: `http://${GO_E_IP}/api/set?amp=${amp}` },
    { url: `http://${GO_E_IP}/api/set?frc=${frc}` }];
}

function stop(reason) {
    flow.set("pv.holdSince", 0);
    flow.set("pv.lastAmp", 0);
    return emit(0, 1, reason);
}

// ---- Distinct-reading debounce — accumulate UNCONDITIONALLY every cycle ----
// Runs BEFORE the connect / PV / operator gates so the surplus history stays
// current even while the car is DISCONNECTED: a car plugged in midday into
// already-sustained surplus starts immediately instead of re-waiting ~15 min.
//
// One reading per DISTINCT API data window (stamp is window-quantised by the
// assembler). d.surplusKw is the mode-selected signal, so in battery-full mode
// the history tracks grid export automatically.
const stamp = d.surplusStamp || null;   // renamed from solarToBatteryStamp
// (v1.4) — the assembler now picks whichever sensor's clock actually
// reflects the current surplus signal (battery vs grid-export), instead of
// always the battery sensor's — see power_assembler.js for why.
let readings = flow.get("pv.surplusReadings") || [];   // [{stamp, value}]
const lastStamp = readings.length ? readings[readings.length - 1].stamp : null;
if (stamp && stamp !== lastStamp) {
    readings.push({ stamp: stamp, value: d.surplusKw || 0 });
    while (readings.length > START_SUSTAIN_READINGS) readings.shift();
    flow.set("pv.surplusReadings", readings);
}
const sustainedReady = (readings.length >= START_SUSTAIN_READINGS) &&
    readings.every(r => r.value >= START_THRESHOLD_KW);

// ---- Gates ----
// carCar 0/5/6 (Unknown/Error/Initializing) get their own stop reason —
// previously indistinguishable from carCar===1 (Idle/no car), since
// mapCarState defaulted unrecognised strings to 1. Same stop behaviour,
// honest reason: a genuine charger fault reported "not connected" for
// as long as this ran, silently.
if (d.charger1Fault) return stop(`Charger fault: ${d.charger1Fault}`);
if (d.carCar === 0) return stop("Charger state unknown");
if (d.carCar === 1) return stop("Not connected");
if (!d.pvProducing) return stop("No PV production");
// Operator charging battery from grid → yield entirely: any PV the car took
// would be backfilled from grid at a conversion loss.
if (d.operatorChargingBattery) return stop("Battery priority (operator)");
// Operator selling during a high-price slot (v1.2, §6b): sustained P1 export
// + top-ranked slot above the grid-premium floor. Selling is economically
// (and grid-wise) the right call — the car defers rather than competing.
// Note: in defer_sell mode the assembler zeroes surplusKw, so the reading
// history records the sell period as no-surplus — after the sell ends, the
// normal start debounce requires fresh sustained surplus before resuming.
if (d.operatorSelling) return stop("Deferring to sell (high-price slot)");

const phases = d.phases || 1;
const carDraw = d.carDraw;

// ---- Control law ----
let targetPower;
if (Math.abs(d.error) < DEADBAND_KW) {
    targetPower = carDraw;                    // within deadband → hold
} else {
    targetPower = carDraw + GAIN * d.error;   // slow approach
}
if (targetPower < 0) targetPower = 0;

// ---- Start / continue hysteresis ----
// Asymmetric by design: START requires sustained surplus above a high bar
// (≥ car minimum draw, so starting never pulls from the battery). CONTINUE
// only needs instantaneous surplus above a low floor, with the cloud-bridge
// hold for brief dips. Hard to start, easy to keep going.
const wasCharging = (flow.get("pv.lastAmp") || 0) >= MIN_AMP;
const holdActive = (flow.get("pv.holdSince") || 0) > 0;
const continuing = (d.surplusKw > CONTINUE_THRESHOLD_KW);

if (!wasCharging && !holdActive) {
    // Currently stopped → only start if sustained surplus clears the start bar.
    if (!sustainedReady) {
        const goodCount = readings.filter(r => r.value >= START_THRESHOLD_KW).length;
        flow.set("pv.lastAmp", 0);
        return emit(0, 1,
            `Waiting for surplus (${goodCount}/${START_SUSTAIN_READINGS} readings >= ${START_THRESHOLD_KW} kW, latest ${(d.surplusKw || 0).toFixed(2)})`);
    }
    // sustainedReady → fall through and begin charging
} else {
    // Currently charging (or in a hold) → use the lower continue gate.
    if (!continuing) {
        const now = Date.now();
        const holdSince = flow.get("pv.holdSince") || 0;
        if (holdSince === 0) {
            flow.set("pv.holdSince", now);
            flow.set("pv.lastAmp", MIN_AMP);
            return emit(MIN_AMP, 0, "Holding (cloud bridge)");
        }
        if ((now - holdSince) < MIN_HOLD_MIN * 60000) {
            flow.set("pv.lastAmp", MIN_AMP);
            return emit(MIN_AMP, 0, "Holding (cloud bridge)");
        }
        // Hold expired without surplus returning → stop and LATCH. Clear the
        // reading history so a restart requires a fresh sustained window.
        flow.set("pv.surplusReadings", []);
        return stop("Stopped (no surplus)");
    }
    // continuing → fall through and keep charging
}

// ---- Surplus is present: charge ----
flow.set("pv.holdSince", 0);

// Ideal target amps from the control law
let idealAmp = Math.floor((targetPower * 1000) / (VOLTAGE * phases));
if (idealAmp > CHARGER_MAX) idealAmp = CHARGER_MAX;
if (idealAmp < MIN_AMP) idealAmp = MIN_AMP;

const currentAmp = flow.get("pv.lastAmp") || 0;

// ---- Fresh-reading gate: step at most once per distinct data window ----
// The control variable only carries new information once per API window
// (~300 s). Stepping repeatedly against the SAME frozen reading makes the
// controller "correct" an error its own earlier steps already addressed but
// that the sensor hasn't reflected yet — walking the full range. One step per
// fresh window, holding in between; dwell floor guards against stamp bursts.
const nowMs = Date.now();
const lastAdjustMs = flow.get("pv.lastAdjustMs") || 0;
const lastAdjStamp = flow.get("pv.lastAdjustStamp") || null;
const freshReading = stamp && stamp !== lastAdjStamp;
const dwellOk = (nowMs - lastAdjustMs) >= ADJUST_INTERVAL_S * 1000;
const dueToAdjust = freshReading && dwellOk;

let targetAmp;
if (!dueToAdjust && currentAmp >= MIN_AMP) {
    // No fresh reading yet — hold steady so the previous step can register
    // in the surplus signal before we move again.
    targetAmp = currentAmp;
} else {
    // Time to adjust — step toward the ideal, at most MAX_AMP_STEP amps
    if (currentAmp < MIN_AMP) {
        targetAmp = MIN_AMP;   // just started — jump to minimum, step from there
    } else if (idealAmp > currentAmp) {
        targetAmp = Math.min(idealAmp, currentAmp + MAX_AMP_STEP);
    } else if (idealAmp < currentAmp) {
        targetAmp = Math.max(idealAmp, currentAmp - MAX_AMP_STEP);
    } else {
        targetAmp = currentAmp;
    }
    flow.set("pv.lastAdjustMs", nowMs);
    flow.set("pv.lastAdjustStamp", stamp);
}

if (targetAmp > CHARGER_MAX) targetAmp = CHARGER_MAX;
if (targetAmp < MIN_AMP) targetAmp = MIN_AMP;

flow.set("pv.lastAmp", targetAmp);
flow.set("pv.lastTargetPower", targetPower);

const modeTag = (d.surplusSource === "export") ? ", batt-full/export" : "";
return emit(targetAmp, 0,
    `Charging ${targetAmp} A (${phases}p, ideal ${idealAmp}${modeTag})`);
