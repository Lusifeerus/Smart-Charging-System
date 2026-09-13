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
 * This script only signals lb_wants_stop_N (no room) and lb_hold_N
 * (not scheduled — do not release until room is carved) into flow
 * context for the evaluator to act on. See the allocation model
 * header below for why both exist.
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
 * ═══ Allocation model (v2 — draw-based, start-safe) ═══════════════════
 *
 * Confirmed defect in v1 (found before the first two-car winter, not in
 * production — but it would have been): the reactive formula credited a
 * charger with its reported amp SETPOINT as "what it is already using".
 * That is only true while the charger is delivering. With frc=1 the
 * charger delivers 0 A and still reports amp=16, so v1 held BOTH stopped
 * chargers' setpoints at 16 A right up to the slot boundary, then the
 * evaluator released both in the same tick: 32 A of EV on top of a
 * winter house load, fuse guard trip at 30 s, coordinator severe-overload
 * with a 10-minute cooldown, release, repeat. A 30 s on / 10 min off
 * limit cycle through the cheapest slots of the night, with a ~54 A pulse
 * into the main fuse every cycle. The old amp=0-on-disallowed scheme had
 * masked this by accident; moving to frc-only ownership exposed it.
 *
 * Second v1 defect, same root: the two-charger split divided `available`
 * — headroom AFTER the chargers' own draw — so two running chargers could
 * never grow (6+6 with 11 A spare → share 5 → 0 → stuck).
 *
 * v2 model:
 *   draw_i   what charger i is actually delivering (setpoint iff running)
 *   pool     available + draw1 + draw2 — the current the chargers may
 *            divide among themselves. Shares are computed on the pool.
 *   A not-running charger the scheduler WANTS to run gets a MIN_CURRENT
 *   reservation carved out of the pool (in priority order, only where it
 *   fits without pushing a running charger below MIN_CURRENT). It starts
 *   at 6 A; the next cycle rebalances on the real pool. A not-running
 *   charger the scheduler does NOT want gets no reservation and an
 *   `lb_hold` flag: the evaluator must not release it until room has
 *   been carved — otherwise a release at a saturated pool lands on the
 *   fuse guard before this loop can react.
 *
 * Reservations are 6 A rather than a fair share by decision: the running
 * car yields the minimum needed for a safe start, and one 60 s cycle of
 * rebalancing is fast enough.
 */

const PHASE = Object.freeze({
    INACTIVE:  "inactive",   // no car / lmo≠3 / PV-owned — excluded
    RUNNING:   "running",    // commanded frc=0, car charging, setpoint>0
    STOPPED:   "stopped",    // commanded frc=1 (scheduler / LB / fuse)
    OFFERED:   "offered",    // commanded frc=0, car NOT charging, setpoint>0
    BOOTSTRAP: "bootstrap",  // commanded frc=0, setpoint 0 — WaitCar w/ nothing to draw
});

/**
 * Classify one charger. Uses the evaluator's COMMANDED frc from flow
 * context rather than the reported one: the Shelly assembler derives frc
 * from work_state, so a car that finished on the Shelly reports frc=1
 * exactly like a scheduler stop, and the two must not be confused (a
 * reservation carved for a full car starves the other one all night).
 *
 * OFFERED is the "car has an offer and is not taking it" bucket: complete,
 * paused, preconditioning, or the first poll after a release. It gets no
 * reservation, and its setpoint is parked at MIN_CURRENT so a spontaneous
 * resume (e.g. after battery preconditioning) starts gently. That resume
 * is the one path that can overshoot — by at most 6 A for one cycle.
 */
function classify(chargerN, state, active) {
    if (!active) return { phase: PHASE.INACTIVE, draw: 0 };
    const cmdFrc  = flow.get(`charger${chargerN}.frc`);
    const frc     = Number.isFinite(Number(cmdFrc)) ? Number(cmdFrc) : Number(state.frc);
    const car     = Number(state.car);
    const amp     = Number.isFinite(Number(state.amp)) ? Number(state.amp) : 0;
    if (frc === 1)             return { phase: PHASE.STOPPED,   draw: 0 };
    if (car === 2 && amp > 0)  return { phase: PHASE.RUNNING,   draw: amp };
    if (amp > 0)               return { phase: PHASE.OFFERED,   draw: 0 };
    return                            { phase: PHASE.BOOTSTRAP, draw: 0 };
}

/** Which charger the current priority mode favours (1 or 2). */
function priorityCharger(priorityMode, soc1, soc2) {
    if (priorityMode === "Manual Car 1") return 1;
    if (priorityMode === "Manual Car 2") return 2;
    const m = getSocMode(soc1, soc2);
    return (m === "seq2" || m === "w2" || m === "h1") ? 2 : 1;
}

/**
 * Split a pool between two RUNNING chargers by priority mode.
 * ceiling(draw, share): a running charger keeps at least its current draw
 * so a dip in the pool never stops it outright — reduction below draw is
 * the reactive formula's job, and only under real overload.
 */
function splitRunning(pool, priorityMode, soc1, soc2, d1, d2) {
    const ceiling = (draw, share) => Math.max(draw, clampAmp(share));
    const prioTake = Math.min(CHARGER_MAX, pool);
    let max1, max2;
    if (priorityMode === "Manual Car 1") {
        max1 = ceiling(d1, pool); max2 = ceiling(d2, pool - prioTake);
    } else if (priorityMode === "Manual Car 2") {
        max1 = ceiling(d1, pool - prioTake); max2 = ceiling(d2, pool);
    } else {
        switch (getSocMode(soc1, soc2)) {
            case "seq1": case "h2":
                max1 = ceiling(d1, pool); max2 = ceiling(d2, pool - prioTake); break;
            case "seq2": case "h1":
                max1 = ceiling(d1, pool - prioTake); max2 = ceiling(d2, pool); break;
            case "w1": { const { p, n } = allocWeighted(pool); max1 = ceiling(d1, p); max2 = ceiling(d2, n); break; }
            case "w2": { const { p, n } = allocWeighted(pool); max1 = ceiling(d1, n); max2 = ceiling(d2, p); break; }
            default:   { const s = Math.floor(pool / 2);       max1 = ceiling(d1, s); max2 = ceiling(d2, s); }
        }
    }
    return { 1: max1, 2: max2 };
}

/**
 * Compute per-charger { max, hold, planAmp }.
 *
 *   max      allocation ceiling this cycle (0 = no room / not wanted)
 *   hold     not running and not wanted → evaluator must not release
 *   planAmp  what this charger could SUSTAIN — fed to the planner as
 *            chargerN.allocatedAmp. Deliberately not the 6 A start value:
 *            planning slot energy at 6 A would ~triple slots_needed for
 *            every stopped car.
 *
 * ch[n] = { active, phase, draw, wanted }
 */
function computeAllocation(available, priorityMode, soc1, soc2, ch) {
    const out = { 1: { max: 0, hold: false, planAmp: 0 },
                  2: { max: 0, hold: false, planAmp: 0 } };
    const a1 = ch[1].active, a2 = ch[2].active;
    if (!a1 && !a2) return out;

    const isRunning = n => ch[n].phase === PHASE.RUNNING;
    const pool = available + ch[1].draw + ch[2].draw;

    // ── Single active charger: flat CHARGER_MAX ceiling, as in v1. ──────
    // A not-running one is pre-positioned by calcCharger at clampAmp(available).
    if (a1 !== a2) {
        const n = a1 ? 1 : 2;
        const running = isRunning(n);
        const wanted  = ch[n].wanted;
        out[n].planAmp = CHARGER_MAX;
        if (running)      { out[n].max = CHARGER_MAX; }
        else if (wanted)  { out[n].max = (available >= MIN_CURRENT) ? CHARGER_MAX : 0; }
        else              { out[n].max = 0; out[n].hold = true; }
        return out;
    }

    // ── Both active ──────────────────────────────────────────────────────
    // 1. Reservations for not-running, wanted chargers, priority first.
    //    Fits iff every running charger can keep ≥ MIN_CURRENT after it.
    const prio  = priorityCharger(priorityMode, soc1, soc2);
    const order = prio === 1 ? [1, 2] : [2, 1];
    const runningMin = [1, 2].reduce((s, n) => s + (isRunning(n) ? MIN_CURRENT : 0), 0);
    let reserved = 0;
    for (const n of order) {
        if (isRunning(n)) continue;
        if (!ch[n].wanted) { out[n].hold = true; continue; }   // parked, no room needed
        if (ch[n].phase === PHASE.OFFERED) continue;            // has an offer, not taking it
        if (pool - reserved - runningMin >= MIN_CURRENT) {
            out[n].max = MIN_CURRENT; reserved += MIN_CURRENT;
        }                                                       // else max stays 0 → wantsStop
    }

    // 2. Running chargers share what is left of the pool.
    const R = pool - reserved;
    if (isRunning(1) && isRunning(2)) {
        const s = splitRunning(R, priorityMode, soc1, soc2, ch[1].draw, ch[2].draw);
        out[1].max = s[1]; out[2].max = s[2];
    } else for (const n of [1, 2]) {
        if (!isRunning(n)) continue;
        // The carve must be able to REDUCE a running charger — the ceiling
        // protection is what defeated it in v1 — but never below MIN_CURRENT.
        const carve = reserved > 0 ? Math.max(MIN_CURRENT, clampAmp(R)) : CHARGER_MAX;
        out[n].max = Math.min(Math.max(ch[n].draw, clampAmp(R)), carve, CHARGER_MAX);
    }

    // 3. planAmp: sustainable share if both ran on the whole pool.
    const plan = splitRunning(pool, priorityMode, soc1, soc2, 0, 0);
    out[1].planAmp = isRunning(1) ? out[1].max : plan[1];
    out[2].planAmp = isRunning(2) ? out[2].max : plan[2];
    return out;
}


/**
 * Reactive setpoint targets for RUNNING chargers.
 *
 * Lone charger: draw + headroom (v1 formula, on draw instead of setpoint).
 *
 * Two running chargers: v1 applied the full headroom to EACH, so a shared
 * overload was shed twice. Simulated: 12+12 A running, home battery adds
 * 12 A → headroom −11 → each computes 12−11=1 → both below MIN → both
 * stop for 10 minutes, shedding 24 A where 11 was needed. Here the excess
 * is shed in priority order: non-priority down to MIN, then priority
 * down to MIN, then non-priority off, then priority. Growth (positive
 * headroom) is offered to both; the allocation caps from the pool split
 * keep it from being double-counted.
 */
function reactiveTargets(headroom, ch, prio) {
    const r1 = ch[1].phase === PHASE.RUNNING, r2 = ch[2].phase === PHASE.RUNNING;
    const t = { 1: 0, 2: 0 };
    if (r1 !== r2) { const n = r1 ? 1 : 2; t[n] = ch[n].draw + headroom; return t; }
    if (!r1) return t;
    if (headroom >= 0) { t[1] = ch[1].draw + headroom; t[2] = ch[2].draw + headroom; return t; }
    const p = prio, n = prio === 1 ? 2 : 1;
    let vp = ch[p].draw, vn = ch[n].draw, rem = -headroom;
    let take = Math.min(rem, Math.max(0, vn - MIN_CURRENT)); vn -= take; rem -= take;
    take     = Math.min(rem, Math.max(0, vp - MIN_CURRENT)); vp -= take; rem -= take;
    if (rem > 0) { rem -= vn; vn = 0; }        // non-priority off (cooldown applies)
    if (rem > 0) { vp -= rem; }                // priority below MIN → hysteresis stops it
    t[p] = vp; t[n] = vn;
    return t;
}

/*************** Per-charger calculation ***************/

/**
 * Given a charger's classification and its allocation, compute the new
 * amp setpoint.
 *
 * Returns { newAmp, wantsStop, didwestop, stopUntil }
 */
function calcCharger(id, cls, gridMax, alloc, wanted, storedState, reactiveBase) {
    let { didwestop, stopUntil } = storedState;
    const draw   = cls.draw;
    const myMax  = alloc.max;
    const maxGrid = Number.isFinite(Number(gridMax)) ? Number(gridMax) : GRID_LIMIT;
    const headroom = GRID_LIMIT - maxGrid;

    let newValue;
    if (cls.phase === PHASE.RUNNING) {
        // Grid-reactive target from reactiveTargets(): draw + headroom for
        // a lone charger; for two running chargers an overload is shed
        // across both by priority rather than charged to each in full.
        newValue = Math.floor(reactiveBase);
        if (newValue < 0) newValue = 0;
        if (newValue > myMax) newValue = myMax;
    } else if (cls.phase === PHASE.OFFERED) {
        // Car isn't taking its offer. Park at MIN so any resume is gentle.
        newValue = MIN_CURRENT;
    } else if (alloc.hold) {
        // Stopped and not wanted. Parked; evaluator holds it.
        newValue = MIN_CURRENT;
    } else {
        // Stopped/bootstrap and wanted: PRE-POSITION at what it may start
        // with. A 6 A reservation is taken as-is (room was carved this
        // cycle). A single charger starts at real headroom, even-stepped.
        newValue = (myMax === CHARGER_MAX) ? Math.min(myMax, clampAmp(headroom)) : myMax;
    }

    // wantsStop means "LB has no room for you", never "not scheduled" —
    // that is lb_hold. Keeping them apart keeps the CSV logger honest.
    let wantsStop = wanted && !alloc.hold && cls.phase !== PHASE.OFFERED && newValue === 0;

    // Overload hysteresis — running chargers only; a parked one has
    // nothing to shed and must not enter a cooldown for standing still.
    if (cls.phase === PHASE.RUNNING) {
        if (didwestop === 0) {
            if (newValue > 0 && newValue < MIN_CURRENT) {
                newValue = 0; wantsStop = true; didwestop = 1;
                stopUntil = Date.now() + 600000;
            } else if (newValue === 0 && draw > 0 && myMax > 0) {
                wantsStop = true; didwestop = 1;
                stopUntil = Date.now() + 600000;
            }
        }
    }
    if (didwestop === 1) {
        // Cooldown: hold the stop until headroom exists AND the timer ran out.
        if (headroom < MIN_CURRENT) {
            newValue = 0; wantsStop = true;
        } else if (Date.now() >= stopUntil) {
            didwestop = 0; stopUntil = 0;
        } else {
            newValue = 0; wantsStop = true;
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

// Classify, then read what the evaluator decided LAST cycle for each
// charger (it runs after us, off our output 3). One cycle stale by
// construction: at a slot boundary the reservation lands one minute after
// the plan flips, and the evaluator holds the charger for that minute.
// Missing key (first boot) reads as "not wanted" and converges next cycle.
const cls1 = classify(1, c1State, c1Active);
const cls2 = classify(2, c2State, c2Active);
const ch = {
    1: { active: c1Active, phase: cls1.phase, draw: cls1.draw,
         wanted: flow.get('charger1.schedulerAllows') === true },
    2: { active: c2Active, phase: cls2.phase, draw: cls2.draw,
         wanted: flow.get('charger2.schedulerAllows') === true },
};

const alloc = computeAllocation(available, priorityModeCharger, soc1, soc2, ch);
const max1 = alloc[1].max, max2 = alloc[2].max;
const rt = reactiveTargets(available, ch, priorityCharger(priorityModeCharger, soc1, soc2));

let out1 = null, out2 = null;
let r1 = null, r2 = null;      // kept for the diagnostics block below

if (c1Active) {
    r1 = calcCharger("c1", cls1, gridMax, alloc[1], ch[1].wanted, c1Stored, rt[1]);
    flow.set('charger1.didwestop', r1.didwestop);
    flow.set('charger1.stopUntil', r1.stopUntil);
    flow.set('charger1.allocatedAmp', alloc[1].planAmp);   // fed back to planner (sustainable, not start value)
    flow.set('lb_wants_stop_1', r1.wantsStop);
    flow.set('lb_hold_1', alloc[1].hold);
    out1 = { url: `http://${CHARGER_IPS.c1}/api/set?amp=${r1.newAmp}` };
}

if (c2Active) {
    r2 = calcCharger("c2", cls2, gridMax, alloc[2], ch[2].wanted, c2Stored, rt[2]);
    flow.set('charger2.didwestop', r2.didwestop);
    flow.set('charger2.stopUntil', r2.stopUntil);
    flow.set('charger2.allocatedAmp', alloc[2].planAmp);   // fed back to planner (sustainable, not start value)
    flow.set('lb_wants_stop_2', r2.wantsStop);
    flow.set('lb_hold_2', alloc[2].hold);
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
function chargerDiag(active, state, maxA, r, stored, pvOwned, cls, a, wanted) {
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
        phase:           cls ? cls.phase : null,
        draw_a:          cls ? cls.draw : null,
        wanted:          !!wanted,
        allocated_max_a: maxA,
        plan_amp:        a ? a.planAmp : null,
        lb_hold:         a ? a.hold : null,
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
    grid_pool: { pool_a: available + ch[1].draw + ch[2].draw },
    charger1:  chargerDiag(c1Active, c1State, max1, r1, c1Stored, c1PvOwned, cls1, alloc[1], ch[1].wanted),
    charger2:  chargerDiag(c2Active, c2State, max2, r2, c2Stored, c2PvOwned, cls2, alloc[2], ch[2].wanted)
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
