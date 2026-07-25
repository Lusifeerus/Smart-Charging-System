/************************************************************
 * PV Eco — Smart Slow Planner v1
 *
 * The outer loop. Runs every ~10 min. Computes the battery
 * reserve (kW) the Fast Tracker uses to split surplus between
 * the home battery and the car, plus the phase preference.
 *
 * DESIGN: see pv_eco_smart_planner_design.md. Summary:
 *   1. evening_target  ← f(forecast_tomorrow, nordpool_tomorrow)
 *   2. battery_need_kwh = (target − soc) × usable_capacity
 *   3. surplus_budget  = forecast_remaining_today − battery_need − house_remaining
 *   4. computed_reserve_kw ← scaled from surplus_budget
 *   5. write pv.computed_reserve_kw + pv.car_phases
 *
 * The Fast Tracker and assembler are UNCHANGED. The assembler still
 * takes max(user_reserve, computed_reserve), so the user's manual
 * floor can raise but never be undercut by this logic.
 *
 * FORECAST SOURCE (v1.3): FMI primary, Solcast fallback.
 * The FMI logger (fmi_forecast_logger.py, hourly cron) publishes retained
 * MQTT → sensor.fmi_pv_remaining_today_kwh / sensor.fmi_pv_tomorrow_kwh,
 * each with an issued_at attribute. FMI measured more accurate same-day
 * and much better on cloudy days (design note §6). If the FMI value is
 * missing or STALE (issued_at older than ev_pv_fmi_max_age_hours, default
 * 6 h — e.g. the logger container is down), the planner falls back to the
 * Solcast sensors automatically and reports which source it used in the
 * diagnostics (forecastSource).
 *
 * CONSERVATISM (from measured accuracy, design note §6 & §6c):
 *  - Forecasts run optimistic (~+4.5 kWh/day), concentrated in the
 *    shaded morning/evening hours. We apply a blanket optimism
 *    haircut to remaining-today, and treat tomorrow with extra caution.
 *  - The tomorrow-target adjustment only LOWERS the target when tomorrow
 *    is *confidently* high (forecast well above threshold), because
 *    day-ahead forecasts can be ~2× wrong (the cloudy-day miss).
 ************************************************************/

const VOLTAGE = 230;

// ---- Helpers ----
const H = global.get("homeassistant.homeAssistant.states");
if (!H) { node.warn("PV smart planner: HA states unavailable"); return null; }
function num(entity) {
    const v = Number(H[entity]?.state);
    return Number.isFinite(v) ? v : null;
}
function hlp(name, dflt) {
    const v = Number(H[`input_number.${name}`]?.state);
    return Number.isFinite(v) ? v : dflt;
}
function round(v){ return (typeof v==="number" && isFinite(v)) ? Math.round(v*100)/100 : null; }

// ---- Battery config (operator keeps SoC in 15%..96%) ----
// kWh per SoC-% measured directly from data (energy-in vs SoC rise, pooled over
// 4 days: 0.344). This is the exact conversion the need formula wants — charge-
// side losses are already included, no separate capacity/efficiency factors.
const KWH_PER_SOC_PCT  = hlp("ev_pv_kwh_per_soc_percent", 0.34);
const BATT_MAX_RATE_KW = hlp("ev_pv_battery_max_rate_kw", 10);
const SOC_FULL         = 96;   // operator's effective "full" (target clamp)

// ---- Tunable policy helpers ----
const BASE_EVENING_TARGET = hlp("ev_pv_evening_target_soc", 80);   // % baseline
const SUNNY_DISCOUNT      = hlp("ev_pv_tomorrow_sunny_discount", 20); // % to lower target
const PRICE_PREMIUM       = hlp("ev_pv_tomorrow_price_premium", 15);  // % to raise target
const MIN_NIGHT_SOC       = hlp("ev_pv_min_night_soc", 40);  // floor on evening target
const TOMORROW_HIGH_KWH   = hlp("ev_pv_tomorrow_high_kwh", 45);  // "confidently sunny" bar
const TOMORROW_LOW_KWH    = hlp("ev_pv_tomorrow_low_kwh", 25);   // "poor day" bar
const GENEROUS_KWH        = hlp("ev_pv_surplus_generous_kwh", 10); // budget → low reserve
const LOW_FLOOR_KW        = hlp("ev_pv_reserve_low_floor_kw", 1.0);// reserve when generous
const HOUSE_BASELOAD_KW   = hlp("ev_pv_house_baseload_kw", 1.3);   // measured median
const FORECAST_HAIRCUT    = hlp("ev_pv_forecast_haircut", 0.9);    // optimism correction ×

// ---- Inputs ----
const battSoc = num("sensor.kotiakku_state_of_charge_percent");
if (!Number.isFinite(battSoc)) {
    node.warn("PV smart planner: battery SoC unavailable — leaving reserve unchanged");
    return null;
}

// ---- Forecast source: FMI primary, Solcast fallback (v1.3) ----
const FMI_MAX_AGE_H = hlp("ev_pv_fmi_max_age_hours", 6);

function fmiFresh(entity) {
    // FMI MQTT sensors carry issued_at as an attribute; stale or missing → null
    const st = H[entity];
    const v  = Number(st?.state);
    if (!Number.isFinite(v)) return null;
    const issued = st?.attributes?.issued_at;
    if (!issued) return null;
    const ageMs = Date.now() - Date.parse(issued);
    if (!Number.isFinite(ageMs) || ageMs > FMI_MAX_AGE_H * 3600000) return null;
    return v;
}

const fmiRemaining = fmiFresh("sensor.fmi_pv_remaining_today_kwh");
const fmiTomorrow  = fmiFresh("sensor.fmi_pv_tomorrow_kwh");

let pvRemainingToday, pvTomorrow, forecastSource;
if (fmiRemaining !== null && fmiTomorrow !== null) {
    pvRemainingToday = fmiRemaining;
    pvTomorrow       = fmiTomorrow;
    forecastSource   = "fmi";
} else {
    pvRemainingToday = num("sensor.solcast_pv_forecast_forecast_remaining_today");
    pvTomorrow       = num("sensor.solcast_pv_forecast_forecast_tomorrow");
    forecastSource   = (fmiRemaining !== null || fmiTomorrow !== null)
                       ? "solcast (fmi partial)" : "solcast (fmi stale/missing)";
}

// Apply optimism haircut (both forecasters run ~+4.5 kWh/day optimistic, mostly
// in shaded hours — design note §6c). A blanket × factor is the v1 correction;
// the sun-position shading mask is a v2 refinement.
if (pvRemainingToday != null) pvRemainingToday *= FORECAST_HAIRCUT;
if (pvTomorrow       != null) pvTomorrow       *= FORECAST_HAIRCUT;

// Hours of daylight remaining — for the house-load energy term (small). Prefer
// HA sun.sun's next_setting attribute; fall back to a helper default. The house
// term is a minor correction so precision here is not critical for v1.
let hoursRemaining = hlp("ev_pv_daylight_hours_remaining", 4);  // fallback
const nextSetting = H["sun.sun"]?.attributes?.next_setting;
if (nextSetting) {
    const setMs = Date.parse(nextSetting);
    if (Number.isFinite(setMs)) {
        const hrs = (setMs - Date.now()) / 3600000;
        if (hrs > 0 && hrs < 20) hoursRemaining = hrs;   // sane bound for Finnish summer
    }
}

// ================= 1. EVENING TARGET (tomorrow-aware) =================
// Conservative: only LOWER the target when tomorrow is *confidently* high,
// because day-ahead forecasts can be ~2× wrong (design note §6).
let eveningTarget = BASE_EVENING_TARGET;

// ---- Tomorrow price signal (v1.2, shared Nord Pool ranking) ----
// The winter parser publishes {published_at, slots:[{ts,price}]} (c/kWh,
// 15-min slots, rolling 24 h) to global "nordpool_shared". Tomorrow counts as
// "price high" when the MEAN of tomorrow's local-day slots meets the helper
// threshold. Notes:
//  - Tomorrow's slots only exist after Nord Pool's day-ahead publication
//    (~14:15 EET); before that → false. The evening-target decision matters
//    in the evening, by which time they're present.
//  - Stale/absent shared data (winter parser not running) → false, i.e.
//    graceful degradation to forecast-only target logic.
const TOMORROW_PRICE_HIGH_CENTS = hlp("ev_pv_tomorrow_price_high_cents", 10.0);
const NORDPOOL_MAX_AGE_H        = hlp("ev_pv_nordpool_max_age_hours", 2);

function localDayKey(ts) {
    try {
        return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
    } catch (e) {
        return new Date(ts + 3 * 3600000).toISOString().slice(0, 10);  // EEST fallback
    }
}

let tomorrowPriceHigh = false;
let tomorrowMeanCents = null;
{
    const shared = global.get("nordpool_shared");
    const fresh = shared && Array.isArray(shared.slots) &&
        (Date.now() - (shared.published_at || 0)) < NORDPOOL_MAX_AGE_H * 3600000;
    if (fresh) {
        const tomorrowKey = localDayKey(Date.now() + 24 * 3600000);
        const tomSlots = shared.slots.filter(s => localDayKey(s.ts) === tomorrowKey);
        if (tomSlots.length >= 24) {   // require a meaningful chunk of the day
            tomorrowMeanCents = tomSlots.reduce((a, s) => a + s.price, 0) / tomSlots.length;
            tomorrowPriceHigh = tomorrowMeanCents >= TOMORROW_PRICE_HIGH_CENTS;
        }
    }
}

if (pvTomorrow != null && pvTomorrow >= TOMORROW_HIGH_KWH) {
    eveningTarget -= SUNNY_DISCOUNT;   // confidently sunny → free the car today
}
if (pvTomorrow != null && pvTomorrow <= TOMORROW_LOW_KWH) {
    eveningTarget += PRICE_PREMIUM;    // poor tomorrow → hoard
}
if (tomorrowPriceHigh) {
    eveningTarget += PRICE_PREMIUM;    // expensive tomorrow → hoard
}
// Clamp to sane range
if (eveningTarget > SOC_FULL)      eveningTarget = SOC_FULL;
if (eveningTarget < MIN_NIGHT_SOC) eveningTarget = MIN_NIGHT_SOC;

// ================= 2. BATTERY ENERGY NEED =================
const socGap = Math.max(0, eveningTarget - battSoc);          // %
const batteryNeedKwh = socGap * KWH_PER_SOC_PCT;              // kWh (measured 0.344/%)

// ================= 3. SURPLUS ENERGY BUDGET FOR CAR =================
const houseRemainingKwh = HOUSE_BASELOAD_KW * hoursRemaining;
let surplusBudget = null;
if (pvRemainingToday != null) {
    surplusBudget = pvRemainingToday - batteryNeedKwh - houseRemainingKwh;
}

// ================= 4. SCALE TO INSTANTANEOUS RESERVE =================
// Two constraints, take the MINIMUM (least protective that still hits target):
//
// (a) Energy-budget reserve: if the day's total surplus is tight, protect the
//     battery; if generous, let the car be greedy.
// (b) Required-rate cap: the battery only needs to charge fast enough to reach
//     its target over the remaining daylight. A nearly-full battery with hours
//     left needs only a trickle — so cap the reserve at the rate actually
//     required. THIS FIXES the "83% SoC but reserve 2.7 kW starving the car"
//     case: small remaining need ÷ hours left = tiny required rate.
//
// The reserve is the SMALLER of the two: we never reserve more than the battery
// genuinely needs to hit target in time, even if the energy budget looks tight.

let budgetReserve;
if (surplusBudget == null) {
    budgetReserve = 0;                       // no forecast → user floor governs
} else if (surplusBudget >= GENEROUS_KWH) {
    budgetReserve = LOW_FLOOR_KW;
} else if (surplusBudget <= 0) {
    budgetReserve = BATT_MAX_RATE_KW;
} else {
    const frac = surplusBudget / GENEROUS_KWH;
    budgetReserve = BATT_MAX_RATE_KW - frac * (BATT_MAX_RATE_KW - LOW_FLOOR_KW);
}

// Required-rate cap: rate needed to add batteryNeedKwh over the remaining
// daylight. If the battery is close to target, this is small → low reserve.
let requiredRate;
if (batteryNeedKwh <= 0) {
    requiredRate = 0;                        // at/above target → no reserve needed
} else if (hoursRemaining > 0.25) {
    requiredRate = batteryNeedKwh / hoursRemaining;   // kW
} else {
    requiredRate = BATT_MAX_RATE_KW;         // almost no time left → charge flat out
}
if (requiredRate > BATT_MAX_RATE_KW) requiredRate = BATT_MAX_RATE_KW;

// Take the smaller: never reserve more than genuinely required to hit target.
let computedReserve = Math.min(budgetReserve, requiredRate);

// If battery already at/above target, it needs nothing → car gets all surplus.
if (battSoc >= eveningTarget) computedReserve = 0;

flow.set("pv.computed_reserve_kw", computedReserve);

// ================= 5. PHASE PREFERENCE — DISABLED =================
// Dynamic mid-session 1↔3 phase switching based on surplus trend was
// designed here (30-min trend hysteresis, 3.7/4.5 kW bounds) but never
// actually wired to a psm command — this block only ever updated
// pv.car_phases in flow context, which the assembler/tracker read for
// amp MATH but nothing ever told the real go-e to match. If surplus had
// ever sustained above 4.5 kW for 30 min, this would have silently
// requested amps assuming 3-phase while the charger stayed on 1-phase —
// roughly a 3x undercharge, invisible without cross-checking the
// physical charger.
//
// Explicitly disabled rather than left dormant: phases is now pinned to
// 1, matching the ONLY phase mode PV Eco actually runs at today (the
// strategy-transition phase switch in ev_strategy.py sets psm=1 for
// pv_eco, psm=2 for fast — see docs/INTEGRATION.md). This keeps the
// assembler/tracker's amp math trustworthy by construction: they can
// never disagree with reality because there is only one reality to
// track while this is off.
//
// To revive dynamic switching later: this trend logic needs to actually
// command the go-e (rest_command.goe_set_psm, same as the transition
// switch) and be reconciled with it — the two must not both believe
// they own psm independently. Tracked as a documented future option,
// not a bug to silently work around.
const phases = 1;
flow.set("pv.car_phases", phases);

// ---- Diagnostics ----
// Published to flow context so the CSV logger can append the strategic layer
// alongside the control layer (review F6): every reserve becomes auditable.
const diag = {
    forecastSource,
    eveningTarget,
    batteryNeedKwh: round(batteryNeedKwh),
    pvRemainingToday: round(pvRemainingToday),
    pvTomorrow: round(pvTomorrow),
    surplusBudget: round(surplusBudget),
    budgetReserve: round(budgetReserve),
    requiredRate: round(requiredRate),
    computedReserve: round(computedReserve),
    tomorrowPriceHigh,
    tomorrowMeanCents: round(tomorrowMeanCents)
};
flow.set("pv.planner_diag", diag);

msg.payload = {
    battSoc,
    eveningTarget,
    batteryNeedKwh: round(batteryNeedKwh),
    pvRemainingToday: round(pvRemainingToday),
    pvTomorrow: round(pvTomorrow),
    houseRemainingKwh: round(houseRemainingKwh),
    surplusBudget: round(surplusBudget),
    budgetReserve: round(budgetReserve),
    requiredRate: round(requiredRate),
    computedReserve: round(computedReserve),
    tomorrowPriceHigh,
    phases,
    version: "smart_v1"
};

// Live debug: reserve decision + which forecast source won + budget sign.
{
    const src = (typeof forecastSource !== "undefined") ? forecastSource : "?";
    node.status({
        fill: surplusBudget > 0 ? "green" : "grey",
        shape: "dot",
        text: `reserve ${round(computedReserve)}kW | target ${eveningTarget}% `
            + `| budget ${round(surplusBudget)}kWh | fc:${src}`
    });
}
return msg;
