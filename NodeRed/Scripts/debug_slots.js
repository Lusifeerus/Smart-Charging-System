/************************************************************
 * Allowed Slots Debug Decoder
 * Triggered manually or on a slow interval (e.g. every 15 min)
 * Outputs a human-readable breakdown of allowed_slots for
 * both cars, with timestamp and price for each slot.
 ************************************************************/

const slots      = flow.get("nordpool_slots");
const allowedMap1 = flow.get("car1.allowed_map");
const allowedMap2 = flow.get("car2.allowed_map");

if (!Array.isArray(slots) || slots.length === 0) {
    node.warn("Debug decoder: no nordpool_slots available");
    return null;
}

/**
 * Decode one car's allowed_map into a readable slot list.
 * allowed_map is a timestamp-keyed object: { "<ts>": true/false, ... }
 * Timestamp lookup is immune to nordpool_slots array size changes.
 */
function decodeAllowed(allowedMap, carLabel) {
    if (!allowedMap || typeof allowedMap !== 'object' || Object.keys(allowedMap).length === 0) {
        node.warn(`Debug decoder: no allowed_map for ${carLabel}`);
        return null;
    }

    const SLOT_MS = 15 * 60 * 1000;
    const now = Date.now();

    return slots.map((slot, idx) => {
        const date      = new Date(slot.ts);
        const slotEnd   = slot.ts + SLOT_MS;
        const isCurrent = slot.ts <= now && slotEnd > now;
        const isPast    = slotEnd <= now;

        return {
            idx,
            time:    date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Helsinki" }),
            date:    date.toLocaleDateString("fi-FI",  { timeZone: "Europe/Helsinki" }),
            price:   slot.price,
            allowed: !!allowedMap[String(slot.ts)],
            status:  isCurrent ? "current" : (isPast ? "past" : "future")
        };
    });
}

// Compute a simple summary for each car
function summarise(decoded, carLabel) {
    if (!decoded) return null;
    const future    = decoded.filter(s => s.status !== "past");
    const scheduled = future.filter(s => s.allowed);
    const prices    = scheduled.map(s => s.price);
    return {
        car:             carLabel,
        total_slots:     decoded.length,
        future_slots:    future.length,
        scheduled_slots: scheduled.length,
        avg_price:       prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(3) : null,
        min_price:       prices.length ? +Math.min(...prices).toFixed(3) : null,
        max_price:       prices.length ? +Math.max(...prices).toFixed(3) : null,
        slots:           decoded
    };
}

const decoded1 = decodeAllowed(allowedMap1, "car1");
const decoded2 = decodeAllowed(allowedMap2, "car2");

msg.payload = {
    generated_at: new Date().toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }),
    car1: summarise(decoded1, "car1"),
    car2: summarise(decoded2, "car2")
};

return msg;
