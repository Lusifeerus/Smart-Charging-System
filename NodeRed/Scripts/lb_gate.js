/************************************************************
 * Load Balancing Gate
 * Place between Assembler and Coordinator.
 *
 * Two outputs:
 *   1 → Coordinator     (automatic: pass message through)
 *   2 → (unused now — was the old manual-mode evaluator trigger)
 *
 * ev_charging_lb is the "Charging control" axis:
 *
 * automatic → message goes to coordinator (output 1). The coordinator's
 *             own third output then triggers the evaluator, so the
 *             evaluator runs only after the coordinator has finished and
 *             the lb_wants_stop flags are fresh.
 *
 * manual    → KILL SWITCH. Emit nothing on either output. No coordinator
 *             (no amp), no evaluator (no frc). The whole smart layer lets
 *             go; the user drives the chargers from the go-e/Shelly app.
 *             The Fuse Guard (independent path) stays active as the sole
 *             stop-only authority. The PV tracker stands down on the same
 *             flag via its own gate. See DESIGN_percar_strategy_killswitch.
 *
 *             (This REPLACES the old manual behaviour, which skipped the
 *             coordinator but still ran the evaluator — that let the
 *             system fight manual app changes. Output 2 is now unused.)
 ************************************************************/

const lbMode = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_charging_lb'].state"
) || "automatic";

// ═══ KILL SWITCH ═══════════════════════════════════════════════════════
// "Charging control: Manual" (ev_charging_lb == "manual") is the system
// kill switch: the whole smart layer LETS GO so the user can drive the
// chargers from the go-e/Shelly app with zero interference. Emit NOTHING
// — no coordinator (no amp), no evaluator (no frc). The fast flow goes
// completely silent. The Fuse Guard is unaffected (its own independent
// inject/path) and remains the sole active authority — stop-only, never
// competing for control. The PV tracker stands down on the same flag via
// its own first gate.
//
// This is a genuine behaviour change from the old "manual" here, which
// only skipped the coordinator but STILL triggered the evaluator (still
// wrote frc every cycle) — that was why manual app changes got
// overridden. "Manual" now means the system does not run at all.
if (lbMode === "manual") {
    node.status({ fill: "grey", shape: "ring", text: "kill switch — system paused" });
    return [null, null];   // emit nothing: no amp, no frc
}

// "Charging control: Automatic" — normal operation.
// Output 1 → coordinator; evaluator is triggered by coordinator output 3.
node.status({});
return [msg, null];
