/************************************************************
 * Fuse Guard — independent, stop-only overload authority
 *
 * PURPOSE
 *   Last-resort main-fuse protection that is NEVER disabled by any
 *   mode. It exists because in PV Eco (LB manual) the LB Gate skips
 *   the Coordinator and actively clears lb_wants_stop_1/2 — leaving
 *   the fuse unsupervised — and because the Coordinator itself can
 *   die. This node is deliberately dumb, deliberately separate:
 *   it never allocates current and never sends resume commands.
 *
 * BAND STRUCTURE (no fighting with LB by construction)
 *   LB manages *to* GRID_LIMIT = 35 A as its budget; a fully loaded
 *   phase legitimately sits at ~34-35 A in Fast mode. The guard
 *   trips only ABOVE that envelope (default 39 A sustained 30 s) —
 *   inside a 35 A gG fuse's tolerance at that duration, but beyond
 *   anything correct LB operation allows. If this guard ever fires
 *   while LB is automatic, that is a defect signal for LB itself.
 *   Release (default 31 A) sits below LB's operating point so the
 *   guard actually lets go after shedding settles.
 *
 * INDEPENDENCE
 *   - Own input path: reads the P1 phase-current entities straight
 *     from global context on a 10 s inject — not the Assembler/join
 *     chain, so a dead fast-flow does not blind the guard.
 *   - Own trivial state: breach/clear timers only. Never touches
 *     didwestop/stopUntil (Coordinator's) or pv.* (tracker's).
 *   - Two action channels while active:
 *       1. DIRECT stop commands to both chargers, re-sent every
 *          tick (works even if Evaluator/tracker are dead)
 *       2. global "ev_fuse_stop" flag, ORed in by the Evaluator and
 *          the PV tracker (works even if HTTP requests drop)
 *   - Release = clearing the flag ONLY. Normal controllers resume
 *     on their own terms (evaluator tick, tracker start hysteresis,
 *     charger internal logic). Stop-only ⇒ conflicts impossible;
 *     worst overlap is two authorities agreeing on "stop".
 *
 * KNOWN LIMIT
 *   Shedding both EVs removes what EVs draw — if a phase is still
 *   breached afterwards it is non-EV load (sauna + stove). The guard
 *   holds its (now moot) stop and the notification is the remedy;
 *   the physical fuse remains the final authority, as it should.
 *
 * WIRING (new nodes, NOT in the Assembler→Coordinator chain)
 *   inject (repeat 10 s) → THIS NODE →
 *     out 1 → http request (GET, ignore payload)  [go-e stop]
 *     out 2 → http request (GET, ignore payload)  [Shelly stop]
 *     out 3 → mqtt out, topic ev/fuse_guard, retain=true
 *
 * Sensors already in amps; helpers below are created by
 * ev_fuse_guard_package.yaml (defaults used if missing).
 ************************************************************/

const GOE_IP    = "192.168.1.XX";   // CHANGE ME: your go-e IP — this is the safety path, verify independently
const SHELLY_IP = "192.168.1.YY";   // CHANGE ME: your Shelly IP — this is the safety path, verify independently

const PHASE_ENTITIES = [
    "sensor.p1_meter_current_phase_1",
    "sensor.p1_meter_current_phase_2",
    "sensor.p1_meter_current_phase_3",
];

// ---- Tunables (HA helpers, safe defaults if missing) ----
function hlp(name, dflt) {
    const raw = global.get(
        `homeassistant.homeAssistant.states['input_number.${name}'].state`
    );
    const v = Number(raw);
    return Number.isFinite(v) ? v : dflt;
}
const TRIP_A       = hlp("ev_fuse_guard_trip_a", 39);
const RELEASE_A    = hlp("ev_fuse_guard_release_a", 31);
const TRIP_SECONDS = hlp("ev_fuse_guard_trip_seconds", 30);
const HOLD_MINUTES = hlp("ev_fuse_guard_hold_minutes", 5);

// ---- Read phases (own path — straight from HA global context) ----
const phases = PHASE_ENTITIES.map(e => {
    const raw = global.get(`homeassistant.homeAssistant.states['${e}'].state`);
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
});
const valid = phases.filter(v => v !== null);
const now   = Date.now();

// ---- State (node context; cleared on redeploy — re-converges in one
//      trip window, acceptable for a backstop) ----
let s = context.get("guard") || {
    active: false, breachSince: 0, clearSince: 0, activatedAt: 0, lastMqtt: 0
};

// ---- Sensor loss: cannot protect; do NOT trip on blindness (an
//      availability failure must not strand the cars), but say so
//      loudly on the status topic so the health badge catches it ----
const blind = valid.length === 0;
const maxA  = blind ? null : Math.max(...valid);

let statusChanged = false;

if (!blind) {
    if (!s.active) {
        // ---- Trip detection: sustained breach on any phase ----
        if (maxA >= TRIP_A) {
            if (!s.breachSince) s.breachSince = now;
            if (now - s.breachSince >= TRIP_SECONDS * 1000) {
                s.active = true;
                s.activatedAt = now;
                s.clearSince = 0;
                statusChanged = true;
                node.warn(`FUSE GUARD TRIP: max phase ${maxA} A ≥ ${TRIP_A} A ` +
                          `sustained ${TRIP_SECONDS}s — shedding both chargers`);
            }
        } else {
            s.breachSince = 0;
        }
    } else {
        // ---- Release: sustained calm below RELEASE_A for HOLD_MINUTES.
        //      Clears the flag only — never sends resume commands. ----
        if (maxA <= RELEASE_A) {
            if (!s.clearSince) s.clearSince = now;
            if (now - s.clearSince >= HOLD_MINUTES * 60 * 1000) {
                s.active = false;
                s.breachSince = 0;
                statusChanged = true;
                node.warn(`Fuse guard released: max phase ${maxA} A ≤ ${RELEASE_A} A ` +
                          `for ${HOLD_MINUTES} min`);
            }
        } else {
            s.clearSince = 0;
        }
    }
}

// ---- Cooperative flag (read by Evaluator + PV tracker via global) ----
global.set("ev_fuse_stop", s.active);

// ---- Node status ----
node.status(blind
    ? { fill: "grey",  shape: "ring", text: "phase sensors unavailable" }
    : s.active
        ? { fill: "red",    shape: "dot",  text: `SHEDDING — max ${maxA} A` }
        : { fill: "green",  shape: "dot",  text: `ok — max ${maxA} A` });

// ---- Outputs ----
// While active: re-send direct stops every tick (self-healing heartbeat;
// also re-stops anything another controller re-enabled meanwhile).
const goeStop = s.active
    ? { url: `http://${GOE_IP}/api/set?frc=1` }
    : null;
const shellyStop = s.active
    ? { url: `http://${SHELLY_IP}/rpc/Boolean.Set?owner=%22service:0%22&role=%22start_charging%22&value=false` }
    : null;

// Retained MQTT status: on change, and refreshed every 60 s
let mqttMsg = null;
if (statusChanged || now - (s.lastMqtt || 0) >= 60 * 1000) {
    s.lastMqtt = now;
    mqttMsg = {
        topic: "ev/fuse_guard",
        retain: true,
        payload: JSON.stringify({
            active:  s.active,
            blind:   blind,
            max_a:   maxA,
            phases:  phases,
            trip_a:  TRIP_A,
            release_a: RELEASE_A,
            since:   s.active ? new Date(s.activatedAt).toISOString() : null,
            ts:      new Date(now).toISOString()
        })
    };
}

context.set("guard", s);
return [goeStop, shellyStop, mqttMsg];
