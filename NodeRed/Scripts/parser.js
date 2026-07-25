/************************************************************
 * Nordpool rolling 24h parser (supports 96 or 192 slots)
 * Outputs current + future slots up to 24 hours ahead.
 * A slot is included as long as we are still inside it,
 * i.e. its end time (start + 15 min) has not yet passed.
 ************************************************************/

const SLOT_DURATION_MS = 15 * 60 * 1000;  // 15 minutes in ms

const entity = global.get("homeassistant.homeAssistant.states['sensor.nordpool_prices']");
if (!entity || !entity.attributes || !entity.attributes.data) {
    node.warn("Nordpool data missing");
    return null;
}

const raw = entity.attributes.data;  // 96 or 192 slots
if (!Array.isArray(raw) || raw.length < 48) {
    node.warn("Nordpool data invalid");
    return null;
}

const now    = Date.now();
const cutoff = now + 24 * 60 * 60 * 1000;  // 24h ahead

// Include a slot if:
//   - we are still inside it (slot end > now), AND
//   - its start is within the 24h lookahead window
let slots = raw
    .map(slot => ({
        ts:    new Date(slot.start).getTime(),
        price: Number(slot.price)
    }))
    .filter(s => (s.ts + SLOT_DURATION_MS) > now && s.ts < cutoff);

// Sort chronologically
slots.sort((a, b) => a.ts - b.ts);

// Store in flow
flow.set("nordpool_slots", slots);

// v1.2: share slots with the PV Eco flow via GLOBAL context (agreed seam:
// one parser, two consumers). Consumers must check published_at freshness —
// if this parser stops running (winter tab disabled), they degrade gracefully.
global.set("nordpool_shared", { published_at: Date.now(), slots: slots });

msg.payload = {
    total_raw:    raw.length,
    active_slots: slots.length,
    preview:      slots.slice(0, 4)
};

return msg;
