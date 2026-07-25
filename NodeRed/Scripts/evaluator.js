/************************************************************
 * EV Slot Evaluator — sole owner of frc for both chargers
 * Runs every 1 minute via Inject node
 *
 * Combines:
 *   - Scheduler gate  (allowed_slots from planner)
 *   - LB stop flag    (lb_wants_stop_N set by coordinator)
 *
 * frc=0 → normal operation (coordinator controls amp)
 * frc=1 → hard stop
 *
 * Output 1 → go-e charger 1 frc HTTP request node
 *   msg.url is set directly (go-e uses plain HTTP GET)
 *
 * Output 2 → shelly_output_frc.js handler
 *   msg.payload.frc is set (handler builds the Shelly URL)
 ************************************************************/

const GOE_C1_IP = "192.168.1.XX";   // CHANGE ME: your go-e IP

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

// ---- Read shared inputs ----
const chargingMode = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_charging_mode'].state"
) || "scheduled";

// PV-capable chargers (go-e = charger 1 today). A charger whose assigned
// car is on PV Eco AND that is PV-capable is driven by the PV tracker, not
// this evaluator — see evalCharger. {1} today → {1,2} when a 2nd go-e is
// added; kept in sync with the same constant in ev_strategy.py / tracker.
const PV_CAPABLE_CHARGERS = [1];

// Per-car strategy read (mapping-aware, uses the resolver twin above).
function carStrategy(carNum) {
    if (carNum == null) return "fast";   // unassigned/guest → never PV Eco
    return global.get(
        `homeassistant.homeAssistant.states['input_select.ev_car${carNum}_strategy'].state`
    ) || "fast";
}

const slots = flow.get("nordpool_slots");

if (!Array.isArray(slots) || slots.length === 0) {
    node.warn("Evaluator: no nordpool_slots available");
    return [null, null];
}

// ---- Find current slot index ----
// A slot covers [ts, ts + SLOT_DURATION_MS). Find the slot we are inside.
// If no current slot exists in the data (gap in Nord Pool data), stop both
// chargers rather than peek ahead at a future slot and charge prematurely.
const SLOT_DURATION_MS = 15 * 60 * 1000;
const nowTs = Date.now();

const idx = slots.findIndex(s => s.ts <= nowTs && (s.ts + SLOT_DURATION_MS) > nowTs);
if (idx === -1) {
    // No current slot found — could be a transient parser gap during data refresh.
    // Allow a 2-minute grace window before hard-stopping chargers, to avoid
    // unnecessary stop/start cycles caused by brief Nord Pool data delays.
    const NO_SLOT_GRACE_MS = 2 * 60 * 1000;
    let noSlotSince = flow.get('evaluator.noSlotSince') || 0;

    if (!noSlotSince) {
        flow.set('evaluator.noSlotSince', Date.now());
        node.warn("Evaluator: no current slot found — entering grace window");
        return [null, null];  // leave chargers in current state this cycle
    }

    if (Date.now() - noSlotSince < NO_SLOT_GRACE_MS) {
        node.warn("Evaluator: no current slot found — grace window active");
        return [null, null];  // still within grace, leave chargers as-is
    }

    // Grace expired — stop chargers
    node.warn("Evaluator: no current slot found — grace expired, stopping both chargers");
    flow.set('evaluator.noSlotSince', 0);
    // Keep status flow keys in sync so the status publisher shows the stop
    flow.set('charger1.frc', 1);
    flow.set('charger2.frc', 1);
    return [
        { url: `http://${GOE_C1_IP}/api/set?frc=1`, payload: { frc: 1, reason: "no_current_slot" } },
        { payload: { frc: 1, reason: "no_current_slot" } }
    ];
}

// Current slot found — clear any grace counter
flow.set('evaluator.noSlotSince', 0);

// ---- Helper: decide frc for one charger ----
// chargerN: which charger we are deciding frc for (owns the lb flag)
// carNum:   which car's plan applies (null = unassigned, no plan)
function evalCharger(chargerN, carNum) {
    const lbWantsStop = flow.get(`lb_wants_stop_${chargerN}`) || false;

    if (carNum == null) {
        // Unassigned charger. FAIL-SAFE DEFAULT: do not charge.
        //
        // This branch is NOT rare in practice — the exclusivity automation
        // (see mapping helpers) routinely sets a charger to "None" as a
        // side effect of a completely ordinary reassignment on the OTHER
        // charger. A family member fixing which charger their own car is
        // on can, as a pure side effect, vacate the other charger — if
        // that charger still has a real car physically plugged in, an
        // "always allow" default here would silently start it charging
        // at full/unscheduled price with zero visibility on any car card
        // (this state belongs to no car, so no card shows it happening).
        // Confirmed live — this used to be the actual production
        // behaviour, was originally believed to be a dormant corner case.
        //
        // A genuine unknown-guest-car use case still exists and is
        // supported, but now requires deliberate opt-in per charger via
        // input_boolean.ev_chargerN_guest_charge (default off) — an
        // explicit decision, never an incidental side effect of touching
        // an unrelated assignment.
        const guestChargeAllowed = global.get(
            `homeassistant.homeAssistant.states['input_boolean.ev_charger${chargerN}_guest_charge'].state`
        ) === "on";
        return {
            slot_index:        idx,
            slot_ts:           slots[idx].ts,
            scheduler_allows:  guestChargeAllowed,
            lb_wants_stop:     lbWantsStop,
            charging_mode:     chargingMode,
            guest:             true,
            guest_charge_allowed: guestChargeAllowed,
            fuse_stop:         fuseStop,
            frc:               (guestChargeAllowed && !lbWantsStop && !fuseStop) ? 0 : 1
        };
    }

    const allowedMap  = flow.get(`car${carNum}.allowed_map`) || null;

    // allowed_map is a timestamp-keyed object: { "<ts>": true/false, ... }
    // Using timestamps as keys means the map is immune to nordpool_slots
    // changing size — no index alignment issues possible.
    if (!allowedMap || typeof allowedMap !== 'object' || Object.keys(allowedMap).length === 0) {
        node.warn(`Evaluator: no allowed_map for car${carNum}`);
        return null;
    }

    // Per-car Boost flag (Phase 2, set by pyscript ev_strategy.py):
    // ORed with the plan so Boost never touches global charging mode and
    // never affects the other car's schedule. LB stop still wins below.
    const boostActive = global.get(
        `homeassistant.homeAssistant.states['input_boolean.ev_car${carNum}_boost'].state`
    ) === "on";

    // ---- PER-CAR STRATEGY: PV Eco charger is owned by the PV tracker ----
    // If this charger's assigned car is on PV Eco AND this charger is
    // PV-capable AND the car is not boosting, the PV tracker owns frc/amp
    // for it — the evaluator must NOT write frc, or the two fight (exactly
    // the global-cascade bug, but per-charger). Returning null here means
    // "no fast-flow command for this charger this cycle". Boost overrides:
    // a boosting PV-Eco car wants full power now, which is a fast-flow
    // action (the tracker's derived-global flip to fast already reflects
    // this; here we let the scheduler gate run so Boost is honoured).
    const thisCarStrategy = carStrategy(carNum);
    const pvOwned = (thisCarStrategy === "pv_eco")
        && PV_CAPABLE_CHARGERS.includes(chargerN)
        && !boostActive;
    if (pvOwned) {
        return {
            slot_index:        idx,
            slot_ts:           slots[idx].ts,
            scheduler_allows:  false,
            lb_wants_stop:     lbWantsStop,
            charging_mode:     chargingMode,
            strategy:          "pv_eco",
            pv_owned:          true,
            boost:             false,
            fuse_stop:         fuseStop,
            frc:               null    // ← null = evaluator emits no command; tracker owns it
        };
    }

    let schedulerAllows;
    if (chargingMode === "manual" || boostActive) {
        schedulerAllows = true;
    } else {
        const currentSlotTs = String(slots[idx].ts);
        schedulerAllows = !!allowedMap[currentSlotTs];
    }

    const frc = (schedulerAllows && !lbWantsStop && !fuseStop) ? 0 : 1;

    return {
        slot_index:        idx,
        slot_ts:           slots[idx].ts,
        scheduler_allows:  schedulerAllows,
        lb_wants_stop:     lbWantsStop,
        charging_mode:     chargingMode,
        strategy:          thisCarStrategy,
        pv_owned:          false,
        boost:             boostActive,
        fuse_stop:         fuseStop,
        frc
    };
}

// Fuse Guard (independent stop-only authority) — cooperative check.
// The guard also direct-commands stops; this flag is the second channel.
const fuseStop = global.get("ev_fuse_stop") === true;

const carOnC1 = assignedCar(1);
const carOnC2 = assignedCar(2);
const r1 = evalCharger(1, carOnC1);
const r2 = evalCharger(2, carOnC2);

// A charger owned by the PV tracker (r.frc === null) gets NO command from
// the evaluator — emitting one would fight the tracker. This is the
// per-charger equivalent of the old global "manual mode skips frc", but
// scoped to exactly the PV-Eco charger rather than the whole system.
const c1PvOwned = r1 && r1.frc === null;
const c2PvOwned = r2 && r2.frc === null;

// Output 1: go-e — set msg.url directly for HTTP request node.
// Null r1 (guest/no plan) OR PV-owned → no command.
const out1 = (r1 && !c1PvOwned)
    ? { url: `http://${GOE_C1_IP}/api/set?frc=${r1.frc}`, payload: { car: carOnC1, ...r1 } }
    : null;

// Output 2: Shelly — shelly_output_frc.js reads msg.payload.frc to build URL.
const out2 = (r2 && !c2PvOwned)
    ? { payload: { car: carOnC2, ...r2 } }
    : null;

// Store frc in flow context so the status publisher can derive charging
// state. For a PV-owned charger, DON'T overwrite — the tracker maintains
// its own state and the status publisher reads pv.* for it; writing 1
// here would falsely show "stopped" while the tracker charges. Leave the
// existing value untouched (the tracker/its own path owns it).
if (!c1PvOwned) flow.set('charger1.frc', r1 ? r1.frc : 1);
if (!c2PvOwned) flow.set('charger2.frc', r2 ? r2.frc : 1);

// Expose the evaluator's OWN scheduler_allows decision to flow context —
// previously internal-only (computed in evalCharger, returned in the msg
// payload, but not readable by any other node). This is the single most
// diagnostic fact for "was charging allowed outside the scheduled slot":
// without it, a downstream observer can only see the resulting frc/amp,
// not WHY the evaluator thought it should allow charging. Added for the
// Fast CSV Logger (fast_csv_logger.js) — same "cross-node needs it, so
// flow.set it" pattern already used for didwestop/lb_wants_stop.
flow.set('charger1.schedulerAllows', r1 ? r1.scheduler_allows : null);
flow.set('charger2.schedulerAllows', r2 ? r2.scheduler_allows : null);

// ═══ Output 3 — UNCONDITIONAL Status Publisher trigger ═══════════════
// Bug fixed here (live incident): Status Publisher was wired to output 1
// (the go-e/charger-1 frc command). That was a silent coupling that only
// ever worked because output 1 historically fired on every cycle. The
// per-car PV-ownership logic above makes output 1 correctly null whenever
// charger 1 is PV-Eco-owned — a common, entirely normal state — which
// silently stopped Status Publisher from running AT ALL, freezing BOTH
// cars' status (it publishes car1+car2 together) and the health sensor's
// Fast Flow heartbeat. Confirmed live: "Fast Flow silent Nx min" appeared
// whenever charger 1 entered PV Eco, and cleared when switched back.
//
// Status Publisher reads entirely from flow context (verified — no
// msg.payload dependency), so this is a bare, data-free trigger, exactly
// like the Coordinator's own third-output pattern. MUST be rewired in
// Node-RED: Status Publisher's input moves from Evaluator output 1 to
// this new output 3. See WIRING_CHANGE_status_publisher.txt.
const statusTrigger = { payload: "evaluator_done", _src: "evaluator" };

return [out1, out2, statusTrigger];
