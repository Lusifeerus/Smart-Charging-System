/************************************************************
 * PV Eco — Status Publisher
 *
 * Publishes the full control-loop telemetry to MQTT every cycle
 * so the dashboard can show live PV Eco state, and so the data
 * can be captured for tuning and for building the smart planner.
 *
 * Wire from the Fast Tracker's output (a copy/branch) OR run it
 * right after the assembler reading the same flow context. Here
 * it reads everything from flow context + the incoming payload,
 * so wire it from the Power Assembler output (parallel branch to
 * the Fast Tracker) — it sees the same payload the tracker acted on.
 *
 * Publishes to: homeassistant/sensor/ev_pv_eco_status/state
 * Creates:      sensor.ev_pv_eco_status  (via MQTT discovery)
 *
 * State = short human status string.
 * Attributes = full telemetry for graphing and analysis.
 ************************************************************/

const d = msg.payload || {};
const diag = flow.get("pv.planner_diag") || {};

// Status string written by the Fast Tracker (most recent decision)
const status = flow.get("pv.status") || "Idle";

// Strategy (so the card can show whether PV Eco is even active)
const strategy = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_charging_strategy'].state"
) || "fast";

// Last commanded amp + target power from the tracker
const lastAmp         = flow.get("pv.lastAmp") || 0;
const lastTargetPower = flow.get("pv.lastTargetPower") || 0;

// Round helper for clean attribute values
const r = (v, n = 2) => (typeof v === "number" && isFinite(v)) ? Number(v.toFixed(n)) : null;

const payload = {
    state: status,
    attributes: {
        friendly_name:        "EV PV Eco Status",
        strategy:             strategy,
        active:               strategy === "pv_eco",

        // Control variable + target (mode-selected by the assembler, v1.1)
        surplus_source:       d.surplusSource ?? null,
        surplus_kw:           r(d.surplusKw),
        solar_to_battery_kw:  r(d.solarToBattery),
        battery_reserve_kw:   r(d.battReserve),
        control_error_kw:     r(d.error),

        // Car state
        car_amp:              d.carAmp ?? null,
        car_draw_kw:          r(d.carDraw),
        car_power_measured_kw: r(d.carDrawMeasured),
        car_phases:           d.phases ?? null,
        commanded_amp:        lastAmp,
        target_power_kw:      r(lastTargetPower),

        // PV breakdown
        pv_total_kw:          r(d.pvTotal),
        solar_to_house_kw:    r(d.solarToHouse),
        solar_to_grid_kw:     r(d.solarToGrid),

        // Battery
        battery_soc:          d.battSoc ?? null,
        battery_state:        d.battState ?? null,
        grid_to_battery_kw:   r(d.gridToBattery),

        // Gates (why the car is or isn't charging)
        pv_producing:         d.pvProducing ?? null,
        battery_full:         d.batteryFull ?? null,
        operator_charging:    d.operatorChargingBattery ?? null,
        operator_selling:     d.operatorSelling ?? null,
        high_sell_slot:       d.highSellSlot ?? null,
        p1_meter_w:           r(d.p1PowerW),
        current_price_cents:  r(d.currentPriceCents),
        data_consistent:      d.consistent ?? null,

        // Planner diagnostics (v1.1) — why the reserve is what it is
        plan_forecast_source:     diag.forecastSource ?? null,
        plan_evening_target:      diag.eveningTarget ?? null,
        plan_battery_need_kwh:    r(diag.batteryNeedKwh),
        plan_pv_remaining_kwh:    r(diag.pvRemainingToday),
        plan_pv_tomorrow_kwh:     r(diag.pvTomorrow),
        plan_surplus_budget_kwh:  r(diag.surplusBudget),
        plan_required_rate_kw:    r(diag.requiredRate),
        plan_computed_reserve_kw: r(diag.computedReserve),

        // ── Health block (Finding 4) — consumed by sensor.ev_system_health ──
        // ts: this publisher runs from the assembler branch, so its freshness
        //     proves the PV data chain is alive.
        // tracker_cmd_age_s: pv.lastCmd refreshes every COMMAND_REFRESH_S even
        //     when the command is unchanged (incl. repeated stop states), so
        //     it is a genuine tracker heartbeat while strategy is pv_eco.
        // data_age_s: age of the Kotiakku data window stamp (cloud API health).
        health: (() => {
            const lastCmd = flow.get("pv.lastCmd") || {};
            const stampMs = Date.parse(d.surplusStamp);   // renamed (v1.4), see power_assembler.js
            return {
                ts: new Date().toISOString(),
                tracker_cmd_age_s: lastCmd.ts
                    ? Math.round((Date.now() - lastCmd.ts) / 1000)
                    : null,
                data_stamp: d.surplusStamp ?? null,
                data_age_s: Number.isFinite(stampMs)
                    ? Math.round((Date.now() - stampMs) / 1000)
                    : null
            };
        })()
    }
};

msg.topic   = "homeassistant/sensor/ev_pv_eco_status/state";
msg.payload = JSON.stringify(payload);
msg.retain  = true;

return msg;
