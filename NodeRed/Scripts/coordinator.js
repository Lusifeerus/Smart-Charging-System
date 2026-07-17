/************************************************************
 * EV Load Balancing Coordinator
 * Replaces go-e-1.js and go-e-2.js
 *
 * Wiring in Node-RED:
 *   - One Inject node triggers this script (e.g. every 60s,
 *     or triggered after both charger poll results arrive)
 *   - msg.payload must contain both charger states:
 *       msg.payload.c1 = { frc, car, lmo, amp, grid }  ← charger 1 API response
 *       msg.payload.c2 = { frc, car, lmo, amp, grid }  ← charger 2 API response
 *       msg.payload.gridMax = <max phase current from grid sensor>
 *   - Output 1 → HTTP request node for charger 1 amp
 *   - Output 2 → HTTP request node for charger 2 amp
 *
 * frc is NOT written here. The evaluator owns frc exclusively.
 * This script only signals lb_wants_stop_1 / lb_wants_stop_2
 * into flow context for the evaluator to act on.
 ************************************************************/

const GRID_LIMIT = 35;   // Main fuse limit (A)
const CHARGER_MAX = 16;   // go-e hardware max (A)
const MIN_CURRENT = 6;    // go-e hardware min (A)
const SOC_DIFF_SEQ = 10;   // SoC gap → sequential mode
const SOC_DIFF_WEIGHT = 5;  // SoC gap → weighted mode

const CHARGER_IPS = {
    c1: "192.168.1.XX",  // CHANGE ME: your go-e IP
    c2: "192.168.1.YY"   // CHANGE ME: your Shelly IP
    // This IP is never used directly — the Shelly Output
    // Handler intercepts coordinator out2 and translates
    // the URL to the Shelly API format.
};

const CAR_SOC_SENSORS = {
    1: "sensor.car1_battery_soc",   // CHANGE ME: your Car 1 SoC sensor
    2: "sensor.car2_battery_soc"    // CHANGE ME: your Car 2 SoC sensor
};

// ═══ MAPPING RESOLVER v1 — DO NOT EDIT IN ISOLATION ═══════════
// Byte-identical copies live in: coordinator.js, evaluator.js,
// planner_car1.js, planner_car2.js, ev_status_publisher.js.
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

// ── Per-charger strategy (PV Eco ownership) ──────────────────────────
// A PV-capable charger whose assigned car is on PV Eco is owned by the PV
// Tracker, which commands its amp/frc directly from surplus. The
// Coordinator MUST NOT also allocate amp to it — two writers to one
// charger in the same cycle produce an oscillation (confirmed live: the
// tracker commands stop-for-no-surplus while the coordinator commands
// full grid-headroom amp, fighting every cycle).
//
// This mirrors the identical per-charger strategy gate in evaluator.js.
// Before the strategy cascade was removed, PV Eco forced lb=manual, which
// made the LB gate skip the coordinator entirely — so this conflict was
// impossible by side effect. With the cascade gone, the coordinator can
// run alongside the tracker (lb=automatic during PV Eco), so the
// exclusion must be explicit here. {1} today → {1,2} with a 2nd go-e.
const PV_CAPABLE_CHARGERS = [1];
function carStrategy(carNum) {
    if (carNum == null) return "fast";   // unassigned/guest → never PV Eco
    return global.get(
        `homeassistant.homeAssistant.states['input_select.ev_car${carNum}_strategy'].state`
    ) || "fast";
}
function pvOwnedCharger(chargerN, carNum) {
    // Boost overrides PV ownership: a boosting car wants full power now,
    // which is a fast-flow (coordinator/evaluator) action — mirror the
    // evaluator's boost carve-out so behaviour is symmetric.
    const boosting = carNum != null && global.get(
        `homeassistant.homeAssistant.states['input_boolean.ev_car${carNum}_boost'].state`
    ) === "on";
    return PV_CAPABLE_CHARGERS.includes(chargerN)
        && carStrategy(carNum) === "pv_eco"
        && !boosting;
}

function socOfCar(carN) {
    // Unknown car (guest) → neutral 50, same default as a failed sensor read.
    if (carN == null) return 50;
    const ent = global.get(
        `homeassistant.homeAssistant.states['${CAR_SOC_SENSORS[carN]}']`
    ) || {};
    const v = Number(ent.state);
    if (!Number.isFinite(v)) return 50;
    // Freshness (Finding 5): a reading older than ev_soc_max_age_hours is
    // treated as fiction and demoted to the same neutral fallback as an
    // unavailable sensor. last_updated missing → assume fresh (defensive).
    const maxAgeH = Number(global.get(
        "homeassistant.homeAssistant.states['input_number.ev_soc_max_age_hours'].state"
    ));
    const lu = Date.parse(ent.last_updated);
    if (Number.isFinite(lu) && Number.isFinite(maxAgeH) &&
        (Date.now() - lu) > maxAgeH * 3600 * 1000) {
        return 50;
    }
    return v;
}

/*************** Pure helper functions ***************/

function evenAmp(a) {
    return Math.floor(a / 2) * 2;
}

/**
 * Clamp a raw amp value to [MIN_CURRENT..CHARGER_MAX] on even steps,
 * or 0 if below minimum. Does NOT enforce even-only when returning 0.
 */
function clampAmp(val) {
    if (val <= 0) return 0;
    let v = evenAmp(Math.floor(val));
    if (v < MIN_CURRENT) return 0;
    if (v > CHARGER_MAX) return CHARGER_MAX;
    return v;
}

function getSocMode(soc1, soc2) {
    const diff = soc1 - soc2;
    const adiff = Math.abs(diff);

    if (soc1 > 90 && soc2 < 90) return "h2";   // Car2 prioritised (Car1 high, coasting)
    if (soc2 > 90 && soc1 < 90) return "h1";   // Car1 prioritised (Car2 high, coasting)
    if (soc1 > 90 && soc2 > 90) return "hb";   // Both high → equal share

    if (adiff >= SOC_DIFF_SEQ) return diff < 0 ? "seq1" : "seq2";
    if (adiff >= SOC_DIFF_WEIGHT) return diff < 0 ? "w1" : "w2";
    return "eq";
}

/**
 * Priority allocation: takes as much as possible up to CHARGER_MAX.
 */
function allocPriority(available) {
    return clampAmp(available);
}

/**
 * Non-priority allocation: gets what's left after the priority charger
 * takes its capped share.
 *
 * FIX vs original: we subtract the *actual capped* priority allocation,
 * not allocPriority(available) on the full pool. Previously this would
 * undercount remaining current when available > CHARGER_MAX.
 */
function allocNonPriority(available) {
    const priorityGets = allocPriority(available);   // capped at CHARGER_MAX
    const remaining = available - priorityGets;
    return clampAmp(remaining);
}

/**
 * 60/40 weighted split. Priority car gets ~60%, non-priority ~40%.
 * Both must meet MIN_CURRENT or drop to 0.
 */
function allocWeighted(available) {
    let p = clampAmp(available * 0.60);
    let n = clampAmp(available * 0.40);

    // If both landed at zero but pool has enough, give priority the minimum
    if (p === 0 && n === 0 && available >= MIN_CURRENT) {
        p = MIN_CURRENT;
    }
    return { p, n };
}

/**
 * Equal share: both chargers get the same amount.
 */
function allocEqual(available) {
    return clampAmp(Math.floor(available / 2));
}

/**
 * Compute both chargers' max allowed current for the given
 * priorityMode and SoC values.
 *
 * c1Active / c2Active: whether each charger has a car actively charging.
 * c1Curr  / c2Curr:   current amp setpoints reported by each charger.
 *
 * For a single active charger the ceiling is CHARGER_MAX — the reactive
 * formula in calcCharger handles the correct value. No pre-splitting needed.
 *
 * For two active chargers the ceiling is max(currentAmps, fairShare) so a
 * running charger is never stopped solely because available headroom dropped
 * below MIN_CURRENT. The fair-share term prevents an idle charger from
 * grabbing more than its allocation on startup.
 *
 * Returns { max1, max2 } — the cap for charger 1 and charger 2.
 */
function computeAllocation(available, priorityMode, soc1, soc2, c1Active, c2Active, c1Curr, c2Curr) {
    // Single-charger case: CHARGER_MAX ceiling, reactive formula does the rest
    if (c1Active && !c2Active) return { max1: CHARGER_MAX, max2: 0 };
    if (c2Active && !c1Active) return { max1: 0, max2: CHARGER_MAX };
    // Neither active
    if (!c1Active && !c2Active) return { max1: 0, max2: 0 };

    // Both active — apply priority/SoC splitting with current-aware ceilings.
    // ceiling(curr, share): a running charger keeps at least its current amps;
    // an idle charger is limited to its fair share of available headroom.
    function ceiling(curr, share) {
        return Math.max(curr, clampAmp(share));
    }

    let max1 = CHARGER_MAX;
    let max2 = CHARGER_MAX;

    if (priorityMode === "Manual Car 1" || priorityMode === "Manual Car 2") {
        const car1Priority = (priorityMode === "Manual Car 1");
        const pCurr = car1Priority ? c1Curr : c2Curr;
        const nCurr = car1Priority ? c2Curr : c1Curr;
        const pAlloc = ceiling(pCurr, available);
        const nAlloc = ceiling(nCurr, available - Math.min(CHARGER_MAX, available));
        max1 = car1Priority ? pAlloc : nAlloc;
        max2 = car1Priority ? nAlloc : pAlloc;

    } else {
        // SoC Smart
        const mode = getSocMode(soc1, soc2);

        switch (mode) {
            case "seq1":   // Car1 lower SoC → Car1 priority
                max1 = ceiling(c1Curr, available);
                max2 = ceiling(c2Curr, available - Math.min(CHARGER_MAX, available));
                break;

            case "seq2":   // Car2 lower SoC → Car2 priority
                max1 = ceiling(c1Curr, available - Math.min(CHARGER_MAX, available));
                max2 = ceiling(c2Curr, available);
                break;

            case "w1": {   // Car1 lower SoC → Car1 priority (60/40)
                const { p, n } = allocWeighted(available);
                max1 = ceiling(c1Curr, p); max2 = ceiling(c2Curr, n);
                break;
            }
            case "w2": {   // Car2 lower SoC → Car2 priority (60/40)
                const { p, n } = allocWeighted(available);
                max1 = ceiling(c1Curr, n); max2 = ceiling(c2Curr, p);
                break;
            }

            case "eq":
            case "hb": {
                const share = Math.floor(available / 2);
                max1 = ceiling(c1Curr, share);
                max2 = ceiling(c2Curr, share);
                break;
            }

            case "h1":  // Car1 >90 → Car2 gets priority
                max1 = ceiling(c1Curr, available - Math.min(CHARGER_MAX, available));
                max2 = ceiling(c2Curr, available);
                break;

            case "h2":  // Car2 >90 → Car1 gets priority
                max1 = ceiling(c1Curr, available);
                max2 = ceiling(c2Curr, available - Math.min(CHARGER_MAX, available));
                break;
        }
    }

    return { max1, max2 };
}

/*************** Per-charger calculation ***************/

/**
 * Given a charger's current state and its allocated max, compute
 * the new amp setpoint.
 *
 * Returns { newAmp, wantsStop, didwestop, stopUntil }
 */
function calcCharger(id, chargerState, myMax, storedState) {
    let { didwestop, stopUntil } = storedState;

    // Coerce to numbers with safe defaults.
    // requestedCurr: default 0 (assume charger is idle if unknown)
    // maxGrid: default GRID_LIMIT (assume fully loaded if unknown — safer than 0
    //          which would give 35A available and risk over-allocation)
    const requestedCurr = Number.isFinite(Number(chargerState.amp))
        ? Number(chargerState.amp) : 0;
    const maxGrid = Number.isFinite(Number(chargerState.grid))
        ? Number(chargerState.grid) : GRID_LIMIT;

    // Grid-reactive calculation: how much headroom do we have right now?
    // Formula: GRID_LIMIT - gridMax + requestedCurr
    //   = available headroom + what the charger is already using
    //   = total this charger can use given current grid state
    let newValue = GRID_LIMIT - maxGrid + requestedCurr;
    newValue = Math.floor(newValue);

    // Clamp negative values to 0 (severe overload beyond charger's contribution)
    if (newValue < 0) newValue = 0;

    // Apply allocation ceiling from computeAllocation
    if (newValue > myMax) newValue = myMax;

    // If allocation gives nothing, stop immediately (priority decision, not grid)
    if (myMax === 0) newValue = 0;

    let wantsStop = (myMax === 0);

    // Overload hysteresis
    // NOTE: do NOT pre-clamp newValue to MIN_CURRENT here — that would make
    // the hysteresis condition below unreachable (dead code). Instead, let
    // the hysteresis handle the 1–5A range properly with a 10-minute cooldown.
    if (didwestop === 0) {
        if (newValue > 0 && newValue < MIN_CURRENT) {
            // Charger can't operate below 6A — stop with cooldown to prevent
            // rapid cycling while grid load hovers just under the threshold
            newValue = 0;
            wantsStop = true;
            didwestop = 1;
            stopUntil = Date.now() + 600000;
        } else if (newValue === 0 && requestedCurr > 0 && myMax > 0) {
            // Severe overload: grid so loaded that even with charger contributing
            // requestedCurr, the reactive formula gives 0 — stop with cooldown
            wantsStop = true;
            didwestop = 1;
            stopUntil = Date.now() + 600000;
        }
    } else {
        // We previously stopped; wait out the cooldown
        if ((GRID_LIMIT - maxGrid) < MIN_CURRENT) {
            newValue = 0;
            wantsStop = true;
        } else if (Date.now() >= stopUntil) {
            didwestop = 0;      // Cooldown elapsed, let evaluator re-enable
            stopUntil = 0;
        } else {
            newValue = 0;
            wantsStop = true;   // Still in cooldown
        }
    }

    return { newAmp: newValue, wantsStop, didwestop, stopUntil };
}

/*************** Main logic ***************/

const c1State = msg.payload.c1 || null;
const c2State = msg.payload.c2 || null;
const gridMax = msg.payload.gridMax;   // max phase current from grid sensor

// Need at least one charger state and a grid reading to do anything useful
if (!c1State && !c2State) {
    node.warn("Coordinator: no charger state in msg.payload");
    return null;
}
if (gridMax == null) {
    node.warn("Coordinator: missing gridMax in msg.payload");
    return null;
}
// Log individually so it's clear which charger went offline
if (!c1State) node.warn("Coordinator: charger 1 state missing, skipping c1");
if (!c2State) node.warn("Coordinator: charger 2 state missing, skipping c2");

// Read shared state
// Read directly from HA global — same pattern as LB Gate and planners.
// flow.get('ev.priority') / flow.get('car1.soc') are never written by any
// node in the flow, so reading from global is the only correct approach.
const priorityMode = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_priority'].state"
) || "SoC Smart";

// Resolve which car sits on each charger, then work in CHARGER space:
// soc1/soc2 below are "SoC of the car on charger 1/2", not "SoC of car 1/2".
const carOnC1 = assignedCar(1);
const carOnC2 = assignedCar(2);
const soc1 = socOfCar(carOnC1);
const soc2 = socOfCar(carOnC2);

// Translate the car-space priority selection into charger space.
// computeAllocation()'s "Manual Car 1"/"Manual Car 2" strings internally
// mean charger 1 / charger 2 (legacy naming, unchanged to keep the diff
// minimal). If the priority car is not assigned to any charger, fall back
// to SoC Smart — a neutral split — rather than prioritising the wrong car.
let priorityModeCharger = priorityMode;
if (priorityMode === "Manual Car 1" || priorityMode === "Manual Car 2") {
    const prioCar     = (priorityMode === "Manual Car 1") ? 1 : 2;
    const prioCharger = (carOnC1 === prioCar) ? 1
                      : (carOnC2 === prioCar) ? 2
                      : null;
    if      (prioCharger === 1) priorityModeCharger = "Manual Car 1";
    else if (prioCharger === 2) priorityModeCharger = "Manual Car 2";
    else                        priorityModeCharger = "SoC Smart";
}

// Filter: only act if charger state exists, is in auto mode (lmo=3).
//
// ACTIVE_CAR_STATES: go-e "car" field. 1=idle/no car (never active).
// 2=charging, 4=charging reduced/paused-recoverable were the original
// set — 3=WaitCar was excluded on the assumption it meant "session
// complete". It does not: WaitCar is what the CAR reports when frc=0
// (charger unlocked) but current amp is 0 — i.e. the charger is
// offering nothing yet, so the car has nothing to draw. Excluding it
// created a bootstrap deadlock: Coordinator only allocates current to
// an "active" charger, but a charger sitting at amp=0 after being
// unlocked reports exactly this excluded state — it can never receive
// the allocation that would let it leave that state. Confirmed live:
// manually forcing a nonzero amp recovered it immediately.
//
// This mirrors the Shelly assembler's own design, which already folds
// charger_end/wait/pause/complete into a single "connected, recoverable"
// bucket (mapped to 4) rather than distinguishing them — same principle
// applied here instead of inventing a go-e-specific special case.
// go-e "err" — DELIBERATELY NOT NAME-MAPPED. The numeric→name enum has
// been observed to differ between go-e firmware versions (confirmed:
// 60.4's own docs vs. the current main-branch docs diverge from index
// 12 onward), and this charger runs 60.5 beta, which has no published
// mapping at all. Any hardcoded table here would be confidently wrong
// some of the time with no way to know when. What's certain regardless
// of firmware/version: 0 = no fault, anything else = fault — that's all
// this system needs to know to stop allocating and raise the badge.
// The raw code is shown verbatim so a person can cross-check it against
// their actual go-e app (talks to the same firmware, authoritative for
// what a code currently means) — this system notices something is
// wrong, it does not diagnose what.
function faultInfo(state) {
    const err = state?.err;
    if (err == null || err === 0) return null;
    return { code: err };
}

const ACTIVE_CAR_STATES = new Set([2, 3, 4]);
// A PV-owned charger is excluded from coordinator allocation entirely —
// the PV Tracker owns it. Treated as "not active" here so no amp command
// is computed or emitted for it (see the emission block below).
const c1PvOwned = pvOwnedCharger(1, carOnC1);
const c2PvOwned = pvOwnedCharger(2, carOnC2);
const c1Active = !c1PvOwned && !!c1State && c1State.lmo === 3 && ACTIVE_CAR_STATES.has(c1State.car);
const c2Active = !c2PvOwned && !!c2State && c2State.lmo === 3 && ACTIVE_CAR_STATES.has(c2State.car);

// Read persisted hysteresis state
const c1Stored = {
    didwestop: flow.get('charger1.didwestop') || 0,
    stopUntil: flow.get('charger1.stopUntil') || 0
};
const c2Stored = {
    didwestop: flow.get('charger2.didwestop') || 0,
    stopUntil: flow.get('charger2.stopUntil') || 0
};

// Available current (grid headroom), using max phase
const available = GRID_LIMIT - gridMax;

// Allocate — pass current amp setpoints so running chargers are not
// stopped when available headroom drops below MIN_CURRENT
const c1Curr = (c1Active && c1State) ? (Number(c1State.amp) || 0) : 0;
const c2Curr = (c2Active && c2State) ? (Number(c2State.amp) || 0) : 0;

const { max1, max2 } = computeAllocation(
    available,
    priorityModeCharger,
    soc1,
    soc2,
    c1Active,
    c2Active,
    c1Curr,
    c2Curr
);

// Per-charger calculation
// Pass the charger's own grid reading for the reactive correction term,
// but use gridMax for the allocation ceiling — they're independent concerns.
let out1 = null, out2 = null;
let r1 = null, r2 = null;      // kept for the diagnostics block below

if (c1Active) {
    r1 = calcCharger("c1", { amp: c1State.amp, grid: gridMax }, max1, c1Stored);
    flow.set('charger1.didwestop', r1.didwestop);
    flow.set('charger1.stopUntil', r1.stopUntil);
    flow.set('charger1.allocatedAmp', r1.newAmp);          // fed back to planner
    flow.set('lb_wants_stop_1', r1.wantsStop);
    out1 = { url: `http://${CHARGER_IPS.c1}/api/set?amp=${r1.newAmp}` };
}

if (c2Active) {
    r2 = calcCharger("c2", { amp: c2State.amp, grid: gridMax }, max2, c2Stored);
    flow.set('charger2.didwestop', r2.didwestop);
    flow.set('charger2.stopUntil', r2.stopUntil);
    flow.set('charger2.allocatedAmp', r2.newAmp);          // fed back to planner
    flow.set('lb_wants_stop_2', r2.wantsStop);
    out2 = { url: `http://${CHARGER_IPS.c2}/api/set?amp=${r2.newAmp}` };
}

// Three outputs:
//   1 → go-e amp HTTP request (Car 1)
//   2 → Shelly amp handler  (Car 2)
//   3 → Evaluator trigger — fires AFTER all flow.set calls above complete,
//       so the evaluator always acts on fresh lb_wants_stop flags with no
//       inter-cycle delay. The evaluator reads everything from flow context,
//       so an empty trigger message is sufficient.
const evalTrigger = { payload: "coordinator_done", _src: "coordinator" };

// ── Diagnostics (attach a debug node to OUTPUT 3, set to show msg.diag) ──
// The Evaluator reads everything from flow context and ignores message
// content, so this rides the existing trigger with zero wiring changes.
// This is the observable record of every decision this run made: the
// mapping resolution, charger-space SoCs, the priority translation, the
// allocation, and each charger's overload/hysteresis outcome.
const now = Date.now();
function chargerDiag(active, state, maxA, r, stored, pvOwned) {
    const fault = state ? faultInfo(state) : null;
    if (!active) {
        let reason;
        if (pvOwned) reason = "pv_eco (tracker owns)";
        else if (!state) reason = "no state";
        else if (fault) reason = `fault (err=${fault.code})`;
        else if (state.lmo !== 3) reason = `lmo=${state.lmo}`;
        else reason = `car=${state.car}`;
        return { active: false, reason, fault: fault || null, pv_owned: !!pvOwned };
    }
    return {
        active:          true,
        current_amp:     state.amp,
        allocated_max_a: maxA,
        new_amp:         r ? r.newAmp : null,
        lb_wants_stop:   r ? r.wantsStop : null,
        didwestop:       r ? r.didwestop : null,
        cooldown_left_s: (r && r.stopUntil > now) ? Math.round((r.stopUntil - now) / 1000) : 0,
        fault:           fault || null
    };
}
evalTrigger.diag = {
    ts:        new Date().toISOString(),
    mapping:   { charger1_car: carOnC1, charger2_car: carOnC2 },
    soc:       { charger1: soc1, charger2: soc2 },   // SoC of the car ON that charger
    priority:  { selected: priorityMode, charger_space: priorityModeCharger },
    grid:      { max_phase_a: gridMax, limit_a: GRID_LIMIT, available_a: available },
    allocation:{ max1_a: max1, max2_a: max2 },
    charger1:  chargerDiag(c1Active, c1State, max1, r1, c1Stored, c1PvOwned),
    charger2:  chargerDiag(c2Active, c2State, max2, r2, c2Stored, c2PvOwned)
};

// At-a-glance node status: allocation + stop flags, red when shedding
const stopFlag = (r1 && r1.wantsStop) || (r2 && r2.wantsStop);
node.status({
    fill:  stopFlag ? "red" : "green",
    shape: "dot",
    text:  `c1:${r1 ? r1.newAmp + "A" : "—"} c2:${r2 ? r2.newAmp + "A" : "—"} ` +
           `| soc ${soc1}/${soc2} | avail ${available.toFixed(1)}A`
});

return [out1, out2, evalTrigger];
