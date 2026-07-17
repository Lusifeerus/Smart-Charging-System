/************************************************************
 * Shelly TopAC EV Charger — Output Handler
 * Replaces the go-e HTTP amp request for charger 2.
 *
 * Receives msg.url from coordinator output 2 in go-e format:
 *   http://192.168.1.YY/api/set?amp=N     (CHANGE ME: your Shelly IP)
 *
 * Translates to Shelly RPC call:
 *   http://192.168.1.YY/rpc/Number.Set?owner="service:0"&role="current_limit"&value=N   (CHANGE ME: your Shelly IP)
 *
 * Stores the setpoint in flow context so shelly_assembler.js
 * can report it back as the `amp` field on the next poll.
 *
 * Wire:
 *   Coordinator output 2 → this node → HTTP request node
 ************************************************************/

const SHELLY_IP   = "192.168.1.YY";   // CHANGE ME: your Shelly IP
const CHARGER_MAX = 16;  // go-e / Shelly hardware max (A)

const url = msg.url || "";
const match = url.match(/amp=(\d+)/);

if (!match) {
    node.warn("Shelly output handler: could not parse amp from URL: " + url);
    return null;
}

// Clamp defensively — coordinator's clampAmp() should already guarantee this,
// but guard here too in case the value is ever set by another path
const amp = Math.max(0, Math.min(CHARGER_MAX, parseInt(match[1], 10)));

// Store for assembler to read back on next poll
flow.set("charger2.lastSetAmp", amp);

msg.url = `http://${SHELLY_IP}/rpc/Number.Set?owner=%22service:0%22&role=%22current_limit%22&value=${amp}`;

return msg;
