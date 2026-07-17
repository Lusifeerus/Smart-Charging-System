/************************************************************
 * HA Sensor Formatter — EV Slot Visualisation
 * Wire after debug_slots.js
 * Output → mqtt-out node  (topic: homeassistant/sensor/ev_slots/state)
 *
 * Creates one MQTT discovery + state message that HA ingests as
 * a sensor whose attributes contain the full slot series for
 * both cars. ApexCharts reads directly from the attributes.
 ************************************************************/

const data = msg.payload;
if (!data || !data.car1 || !data.car2) {
    node.warn("HA formatter: missing slot data");
    return null;
}

/**
 * Convert decoded slots into a compact series for ApexCharts.
 * ApexCharts timeline / bar expects: [{ x: label, y: [start, end], ... }]
 * We produce two parallel arrays instead — easier to handle in
 * ApexCharts card YAML with data_generator:
 *   timestamps: [ts, ts, ...]   Unix ms, for x-axis
 *   prices:     [p, p, ...]     for secondary y-axis
 *   allowed:    [0/1, 0/1, ...] for bar colour / series
 */
function buildSeries(carData) {
    if (!carData || !Array.isArray(carData.slots)) return null;

    // Slot duration in ms (detect from data, default 15 min)
    const slots = carData.slots;
    let slotMs = 15 * 60 * 1000;
    if (slots.length >= 2) {
        // Reconstruct ts from nordpool_slots via flow for duration detection;
        // here we just store duration hint in output so card can use it
        const s = flow.get("nordpool_slots");
        if (Array.isArray(s) && s.length >= 2) {
            slotMs = s[1].ts - s[0].ts;
        }
    }

    return {
        slot_duration_ms: slotMs,
        summary: {
            scheduled_slots: carData.scheduled_slots,
            avg_price:        carData.avg_price,
            min_price:        carData.min_price,
            max_price:        carData.max_price
        },
        // Parallel arrays — compact, easy to iterate in ApexCharts data_generator
        timestamps: slots.map(s => {
            // Reconstruct Unix ms from nordpool_slots by index
            const ns = flow.get("nordpool_slots");
            return Array.isArray(ns) && ns[s.idx] ? ns[s.idx].ts : null;
        }),
        prices:  slots.map(s => s.price),
        allowed: slots.map(s => s.allowed ? 1 : 0),
        status:  slots.map(s => s.status)   // "past" | "current" | "future"
    };
}

const car1Series = buildSeries(data.car1);
const car2Series = buildSeries(data.car2);

// HA sensor state payload (MQTT)
// State = number of scheduled slots for car1 (simple scalar HA can display)
// All detail lives in attributes for ApexCharts to consume
const statePayload = {
    state: data.car1 ? data.car1.scheduled_slots : 0,
    attributes: {
        friendly_name:   "EV Charging Schedule",
        unit_of_measurement: "slots",
        generated_at:    data.generated_at,
        car1:            car1Series,
        car2:            car2Series
    }
};

// MQTT topic — use HA MQTT discovery or a plain state topic
// If using HA MQTT discovery, send config message first (see REFACTOR_NOTES)
msg.topic   = "homeassistant/sensor/ev_slots/state";
msg.payload = JSON.stringify(statePayload);
msg.retain  = true;   // HA should see last value on restart

return msg;
