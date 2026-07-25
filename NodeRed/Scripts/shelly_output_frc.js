/************************************************************
 * Shelly TopAC EV Charger — frc Output Handler
 * Replaces the go-e HTTP frc request for charger 2.
 *
 * Receives msg from evaluator output 2.
 * Reads frc from msg.payload.frc:
 *   frc=0 → start_charging = true
 *   frc=1 → start_charging = false
 *
 * Wire:
 *   Evaluator output 2 → this node → HTTP request node
 ************************************************************/

const SHELLY_IP = "192.168.1.YY";   // CHANGE ME: your Shelly IP

const frc = msg.payload?.frc;

if (frc == null) {
    node.warn("Shelly frc handler: no frc value in msg.payload");
    return null;
}

const startCharging = frc === 0 ? "true" : "false";

msg.url = `http://${SHELLY_IP}/rpc/Boolean.Set?owner=%22service:0%22&role=%22start_charging%22&value=${startCharging}`;

return msg;
