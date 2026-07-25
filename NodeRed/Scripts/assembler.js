/************************************************************
 * Coordinator Input Assembler
 * Runs after Join node collects c1, c2, and grid readings.
 *
 * Join node config:
 *   - Mode: manual
 *   - Combine into: key/value object using msg.topic as key
 *   - Send after: all topics received  (c1, c2, grid)
 *   - Or send after timeout (e.g. 10s) so a missing charger
 *     doesn't block the coordinator indefinitely
 *
 * Each upstream branch must set msg.topic before the join:
 *   Charger 1 poll result  → set msg.topic = "c1"
 *   Charger 2 poll result  → set msg.topic = "c2"
 *   Grid sensor            → set msg.topic = "grid"
 *
 * go-e poll returns: { grid, lmo, amp, frc, car }
 * Grid sensor returns a number (max phase current in amps)
 *   — your existing max-phase logic already produces this.
 *
 * Note: the individual charger `grid` field (house load seen by
 * that charger) is intentionally dropped here. The coordinator
 * uses only gridMax from the dedicated grid sensor, which gives
 * the true maximum phase load across all phases.
 ************************************************************/

const parts = msg.payload;   // joined object from Join node

// Validate all parts arrived
if (!parts.c1 && !parts.c2) {
    node.warn("Assembler: no charger data in joined payload");
    return null;
}
if (parts.grid == null) {
    node.warn("Assembler: grid reading missing from joined payload");
    return null;
}

function pickChargerFields(raw) {
    if (!raw) return null;
    return raw;
}

msg.payload = {
    c1: pickChargerFields(parts.c1),
    c2: pickChargerFields(parts.c2),
    gridMax: parts.grid
};

// Store car states here so the status publisher always has current data
// regardless of whether LB mode is automatic or manual. The coordinator
// is gated by lb_gate.js and does not run in manual LB mode, so carState
// must be written before that gate.
if (parts.c1) flow.set('charger1.carState', parts.c1.car ?? null);
if (parts.c2) flow.set('charger2.carState', parts.c2.car ?? null);
if (parts.c1) flow.set('charger1.reportedAmp', parts.c1.amp ?? 0);
if (parts.c2) flow.set('charger2.reportedAmp', parts.c2.amp ?? 0);

// Polled force-charge state — same lesson as reportedAmp above, one field
// over. The status publisher must read the CHARGER's own frc, not the
// evaluator's COMMANDED frc: the per-car PV-ownership gate makes the
// evaluator skip writing charger1.frc while the PV Tracker owns that
// charger, so the commanded value freezes at its last Fast value and the
// badge lies ("Scheduled ... From 11:30" while the car charges on solar).
// go-e reports frc natively; shelly_assembler.js synthesises it from
// work_state, so both chargers supply it.
if (parts.c1) flow.set('charger1.reportedFrc', parts.c1.frc ?? null);
if (parts.c2) flow.set('charger2.reportedFrc', parts.c2.frc ?? null);

// go-e "err" (poll filter must include it — see README). null/0 = no fault.
// Shelly (charger 2) has no equivalent field; c2.err is simply absent,
// so this stores null there — harmless, the fault check treats null as
// "not faulted" same as 0.
if (parts.c1) flow.set('charger1.errState', parts.c1.err ?? null);
if (parts.c2) flow.set('charger2.errState', parts.c2.err ?? null);

return msg;
