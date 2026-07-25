/************************************************************
 * MQTT Discovery Config Publisher
 * Run ONCE on Node-RED startup (wire an Inject node set to
 * "inject once after 5s delay" → this node → mqtt-out)
 *
 * Registers two sensors with HA:
 *   sensor.ev_charging_schedule — slot schedule data for ApexCharts
 *   sensor.ev_charging_status   — per-car live status for dashboard cards
 ************************************************************/

// default_entity_id (full domain-qualified: "sensor.foo") is the correct
// field — object_id is deprecated (removed in HA Core 2026.4) and was
// never reliable before that either; using it here was a mistake, caught
// after it silently failed to rename anything.
//
// ev_pv_status gets a fresh unique_id ("ev_pv_status_v2"). This is
// required, not optional: default_entity_id/object_id only take effect
// the first time a given unique_id is seen. The registry already has
// "ev_pv_status" mapped to the wrongly-named entity from the original
// bug; republishing under the SAME unique_id — regardless of which
// naming field is used — reuses that existing mapping and renames
// nothing. A genuinely new unique_id is the only way to force a clean
// entity_id. The old entity (sensor.ev_pv_eco_status) becomes orphaned
// once this deploys and its retained config is cleared — delete it via
// the UI once it shows as orphaned/restorable (see deployment notes).
//
// ev_slots_schedule hit the SAME slugification bug (unnoticed because
// nothing ever referenced it by name) — it is actually
// sensor.ev_charging_schedule, not sensor.ev_slots. Renaming a live
// entity is more hassle than it's worth here, so instead of forcing a
// migration (new unique_id, orphan cleanup, etc.) the discovery config
// is corrected to DOCUMENT reality: default_entity_id now matches the
// real, already-live name. This keeps the source of truth honest
// without disturbing anything working. If it's ever intentionally
// renamed later, treat it exactly like the PV entity above (fresh
// unique_id required).
//
// ev_charging_status did not hit this bug — its unique_id is unchanged.
const discoveries = [
    {
        topic: "homeassistant/sensor/ev_slots/config",
        payload: {
            name: "EV Charging Schedule",
            unique_id: "ev_slots_schedule",
            default_entity_id: "sensor.ev_charging_schedule",
            state_topic: "homeassistant/sensor/ev_slots/state",
            value_template: "{{ value_json.state }}",
            unit_of_measurement: "slots",
            icon: "mdi:car-electric",
            json_attributes_topic: "homeassistant/sensor/ev_slots/state",
            json_attributes_template: "{{ value_json.attributes | tojson }}"
        }
    },
    {
        topic: "homeassistant/sensor/ev_charging_status/config",
        payload: {
            name: "EV Charging Status",
            unique_id: "ev_charging_status",
            default_entity_id: "sensor.ev_charging_status",
            state_topic: "homeassistant/sensor/ev_charging_status/state",
            value_template: "{{ value_json.state }}",
            icon: "mdi:lightning-bolt",
            json_attributes_topic: "homeassistant/sensor/ev_charging_status/state",
            json_attributes_template: "{{ value_json.attributes | tojson }}"
        }
    },
    {
        topic: "homeassistant/sensor/ev_pv_eco_status/config",
        payload: {
            name: "EV PV Eco Status",
            unique_id: "ev_pv_eco_status",
            default_entity_id: "sensor.ev_pv_eco_status",
            state_topic: "homeassistant/sensor/ev_pv_eco_status/state",
            value_template: "{{ value_json.state }}",
            icon: "mdi:solar-power-variant",
            json_attributes_topic: "homeassistant/sensor/ev_pv_eco_status/state",
            json_attributes_template: "{{ value_json.attributes | tojson }}"
        }
    }
];

// Send each discovery message individually on the single output.
// node.send() pushes immediately; return null suppresses a duplicate
// of the last message that a plain return would cause.
discoveries.forEach(d => {
    node.send({
        topic: d.topic,
        payload: JSON.stringify(d.payload),
        retain: true
    });
});

return null;
