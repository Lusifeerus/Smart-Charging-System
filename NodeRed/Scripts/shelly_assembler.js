/************************************************************
 * Shelly TopAC EV Charger — Poll Normaliser
 *
 * Replaces the go-e single poll for charger 2.
 * Runs directly after the Shelly work_state HTTP request — no
 * Join node needed (single poll only).
 *
 * Upstream HTTP request (Shelly Gen2 RPC, returns JSON object):
 *   GET /rpc/Enum.GetStatus?owner="service:0"&role="work_state"
 *
 * The phase_info poll was removed: measured current is no longer
 * used anywhere (we trust the amp setpoint, exactly as with go-e),
 * so the second request, its delay node, and the Join are all gone.
 * This also eliminates the Shelly's concurrent-request sensitivity.
 *
 * Output: sets msg.topic = "c2" and msg.payload = normalised
 * charger state in go-e compatible shape, ready for the main
 * coordinator Join node.
 *
 * go-e car states (what coordinator expects):
 *   1 = no car connected
 *   2 = charging
 *   3 = complete / stopped by car
 *   4 = connected, not drawing (coordinator keeps it recoverable)
 ************************************************************/

// Shelly work_state response — JSON object (or string) from the HTTP node.
// Shape: { "id": 0, "src": "...", "result": { "value": "charger_charging" } }
// Some Node-RED HTTP configs deliver msg.payload already parsed.
let resp = msg.payload;
try {
    if (typeof resp === "string") resp = JSON.parse(resp);
} catch (e) {
    node.warn("Shelly assembler: JSON parse error — " + e.message);
    return null;
}

// The work_state value can sit at result.value (RPC) or value depending
// on how the request node is configured. Handle both.
const state = resp?.result?.value ?? resp?.value;

if (!state) {
    node.warn("Shelly assembler: missing work_state in poll response");
    return null;
}

/**
 * Map Shelly work_state to go-e car state equivalent.
 *
 * The coordinator acts on car=2 (charging) and car=4 (connected, not drawing).
 * car=4 is critical for recovery — it tells the coordinator the car is still
 * connected and waiting, so lb_wants_stop can be cleared after cooldown.
 *
 * Mapping (states per EVCC's Shelly TopAC driver):
 *   charger_charging                          → 2  (charging — trust set amp)
 *   charger_end/wait/pause/complete           → 4  (connected, recoverable)
 *   charger_free                              → 1  (no car)
 *   charger_error                             → 1  (fault — do not allocate)
 */
function mapCarState(state) {
    switch (state) {
        case "charger_charging":
            // Always car=2 when charging, consistent with how we treat go-e:
            // we set the amp and trust the car ramps up to it. We do not gate
            // on measured current (no equivalent check exists for go-e).
            return 2;
        case "charger_end":
        case "charger_wait":
        case "charger_pause":
        case "charger_complete":
            // Car connected, not charging — coordinator keeps it active (car=4)
            // so charging can recover after an overload cooldown or when the
            // next allowed slot begins.
            return 4;
        case "charger_free":
            return 1;  // No car connected
        case "charger_error":
            return 1;  // Fault — treat as inactive, do not allocate current
        default:
            node.warn(`Shelly assembler: unknown work_state "${state}", treating as inactive`);
            return 1;
    }
}

// Read last amp setpoint we sent — coordinator wrote this to flow context.
// Falls back to 16 (charger max) if no setpoint has been sent yet.
const lastAmp = flow.get("charger2.lastSetAmp") || 16;

// Normalised go-e compatible shape.
// lmo=3 hardcoded: Shelly has no logic mode, always externally controlled.
const normalised = {
    lmo: 3,
    amp: lastAmp,
    frc: state === "charger_charging" ? 0 : 1,
    car: mapCarState(state),
    meta: {
        shelly_state: state
    }
};

msg.topic = "c2";
msg.payload = normalised;

return msg;
