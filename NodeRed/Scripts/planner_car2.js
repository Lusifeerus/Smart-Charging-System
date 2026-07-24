/************************************************************
 * Slot Planner Car 2
 * Runs every 15 minutes via Inject node
 *
 * Changes vs original:
 *   - 3-phase kW calculation: kW = A × 0.230 × 3
 *   - Slot energy based on ACTUAL recent allocated amps
 *     (flow.get("charger2.allocatedAmp") written by coordinator),
 *     falling back to charger max_kw only when no data exists
 *   - Slot time resolution uses slot duration from data when
 *     available, defaults to 0.25 h (15 min)
 ************************************************************/

const PHASES      = 3;
const VOLTAGE_KV  = 0.230;   // kV per phase (230 V)

// Hard-coded battery-health floor (%). Below this SoC the car charges
// immediately in every slot regardless of price or charging mode.
// This is a safety net only — set to 0 to disable.
const EMERGENCY_MIN_SOC = 10;

const slots = flow.get("nordpool_slots");
if (!Array.isArray(slots) || slots.length === 0) return null;

// ---- HA inputs ----
const socEnt = global.get("homeassistant.homeAssistant.states['sensor.car2_battery_soc']") || {};   // CHANGE ME: your Car 2 SoC sensor
const soc = Number(socEnt.state);
if (!Number.isFinite(soc)) {
    node.warn("Planner car2: SoC sensor unavailable — skipping run");
    return null;
}
// Freshness: REPORTED, never blocking (v1.5). The car's SoC sensor
// publishes only on change, so a parked car's reading legitimately ages
// while remaining perfectly correct — "old" is not "wrong" for a
// change-driven sensor, only for a polling one.
//
// Blocking on age was SELF-SEALING: stale → no plan → no charge → the car
// never wakes → still stale, indefinitely, until the owner happened to
// drive it. The guard manufactured the very condition it was meant to
// protect against (observed live: 34 h old reading, planner skipping every
// run, car sitting at 74% against a 90% trip target).
//
// Trusting the value costs at worst a slightly undersized plan — a stale
// reading is stale-HIGH if the car was driven since, so we under-request
// rather than over-request — and that self-corrects on the next run: once
// charging starts the car wakes, SoC moves, the sensor publishes, and the
// plan is recomputed against the truth.
//
// The genuinely alarming case is a reading frozen WHILE charging (a
// different car on the charger, or a dead integration). That needs its own
// rate-aware detector; sensor age alone cannot distinguish it from a
// parked car. last_updated missing → treated as fresh.
let soc_age_h = null;
let soc_stale = false;
{
    const maxAgeH = Number(global.get(
        "homeassistant.homeAssistant.states['input_number.ev_soc_max_age_hours'].state"
    ));
    const lu = Date.parse(socEnt.last_updated);
    if (Number.isFinite(lu)) {
        soc_age_h = Math.round((Date.now() - lu) / 3600000);
        if (Number.isFinite(maxAgeH) && (Date.now() - lu) > maxAgeH * 3600 * 1000) {
            soc_stale = true;
            node.warn(`Planner car2: SoC reading ${soc_age_h} h old — planning from it anyway (sensor updates on change; a parked car keeps its value)`);
        }
    }
}
const battery_kwh = Number(flow.get("car2.battery_kwh") || 75);
const mode = global.get(
    "homeassistant.homeAssistant.states['input_select.ev_car2_mode'].state"
) || "normal";
const target_normal = Number(
    global.get("homeassistant.homeAssistant.states['input_number.ev_car2_target_soc_normal'].state") || 60
);
const target_trip = Number(
    global.get("homeassistant.homeAssistant.states['input_number.ev_car2_target_soc_trip'].state") || 90
);
const target_minimal = Number(
    global.get("homeassistant.homeAssistant.states['input_number.ev_car2_target_soc_minimal'].state") || 40
);
const deadlineStr = global.get(
    "homeassistant.homeAssistant.states['input_text.ev_car2_deadline_time'].state"
) || "07:00";
const super_cheap = Number(
    global.get("homeassistant.homeAssistant.states['input_number.ev_super_cheap_threshold'].state") || 0
);

// ---- Deadline ----
function computeDeadlineTs(deadline) {
    const [h, m] = deadline.split(":").map(Number);
    const now = new Date();
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
}
const deadlineTs = computeDeadlineTs(deadlineStr);

// ---- Filter usable slots ----
// Must exclude slots that have ALREADY ELAPSED, not just those past the
// deadline. nordpool_slots is pruned only when the hourly Nord Pool parser
// runs, so between prunes the array still carries slots that came and went.
// Ranking those by price let them consume the slots_needed budget below —
// the planner "spending" charging capacity on time that no longer exists,
// and under-scheduling the slots that remain. Observed live: at a :30 slot
// boundary the current slot lost its place to ~4 cheaper-but-expired slots
// and was denied; three minutes later the hourly parser pruned them, the
// budget freed up, and the same slot was allowed — a 3-minute charging gap
// with no cause visible anywhere in the schedule.
//
// A slot still counts while it is in progress (its END is in the future),
// so the current slot survives this filter. It is counted whole even when
// partially elapsed — energy_per_slot already carries enough margin that
// prorating would add a partial-slot concept downstream for no real gain.
const SLOT_MS = 15 * 60 * 1000;
const nowTs = Date.now();
const usableSlots = slots.filter(s => (s.ts + SLOT_MS) > nowTs && s.ts <= deadlineTs);
if (usableSlots.length === 0) return null;

// ---- Target SoC ----
let target_soc = target_normal;
if (mode === "trip")    target_soc = target_trip;
if (mode === "minimal") target_soc = target_minimal;

// ---- Energy needed (kWh) ----
const soc_diff     = Math.max(0, target_soc - soc);
const energy_needed = (soc_diff / 100) * battery_kwh;

// ---- Realistic charging power estimate ----
// Use the actual average amps the coordinator has been allocating.
// This accounts for load-sharing throttling, grid limits, etc.
// Falls back to the charger's configured max if no data yet.
const charger_max_kw = Number(flow.get("car2.max_kw") || 11);

// ═══ MAPPING RESOLVER v1 — DO NOT EDIT IN ISOLATION ═══════════
// Byte-identical copies live in: coordinator.js, evaluator.js,
// planner_car1.js, planner_car2.js, ev_status_publisher.js,
// fast_csv_logger.js.
// Semantic twins (same rules, other runtimes): ev_strategy.py
// (pyscript), ev-charging-cards.js (_myCharger). Edit all together
// and bump the version everywhere; the repo's check_resolver_sync.py
// fails loudly on divergence.
//
// input_select.ev_chargerN_car: "Car 1" | "Car 2" | "None".
// Missing/unexpected helper state → legacy mapping (charger N → car N).
function assignedCar(chargerN) {
    const s = global.get(
        `homeassistant.homeAssistant.states['input_select.ev_charger${chargerN}_car'].state`
    );
    if (s === "Car 1") return 1;
    if (s === "Car 2") return 2;
    if (s === "None")  return null;
    return chargerN;                  // helper missing → legacy mapping
}
function chargerOfCar(carN) {
    if (assignedCar(1) === carN) return 1;
    if (assignedCar(2) === carN) return 2;
    return null;
}
// ═══ END MAPPING RESOLVER v1 ═══════════════════════════════════
const myCharger = chargerOfCar(2);
const allocatedAmp = (myCharger != null)
    ? flow.get(`charger${myCharger}.allocatedAmp`)   // set by coordinator
    : null;
let effective_kw;

if (allocatedAmp != null && allocatedAmp > 0) {
    // 3-phase: kW = A × V × phases / 1000  (voltage already in kV so ÷1 not ÷1000)
    effective_kw = allocatedAmp * VOLTAGE_KV * PHASES;
} else {
    // No allocation data yet — use charger max but apply a conservative
    // de-rating for likely load sharing (assume 70% of max as a safe guess).
    effective_kw = charger_max_kw * 0.70;
    node.warn("Planner car2: no allocatedAmp data, using de-rated charger max");
}

// Cap at charger hardware max (sanity check)
const HW_MAX_AMP = 16;   // charger hardware max (A)
const hw_max_kw  = HW_MAX_AMP * VOLTAGE_KV * PHASES;   // 16 × 0.230 × 3 ≈ 11.0 kW
if (effective_kw > hw_max_kw) effective_kw = hw_max_kw;

// ---- Slot duration ----
// Detect slot duration from data if possible; default 15 min
let slot_hours = 0.25;
if (slots.length >= 2) {
    const durMs = slots[1].ts - slots[0].ts;
    if (durMs > 0) slot_hours = durMs / 3600000;
}

const energy_per_slot = effective_kw * slot_hours;
const slots_needed = energy_needed > 0
    ? Math.ceil(energy_needed / energy_per_slot)
    : 0;

// ---- Sort usable slots by price, pick cheapest ----
const sorted = usableSlots
    .map(s => ({ ts: s.ts, price: s.price }))
    .sort((a, b) => a.price - b.price);

// Build allowed map keyed by slot timestamp (string).
// Using timestamps as keys instead of positional indices means the map
// remains correct even when nordpool_slots changes size (e.g. when
// tomorrow's prices are added mid-day by the Nord Pool integration).
const allowedMap = {};
for (const slot of slots) allowedMap[String(slot.ts)] = false;

for (let i = 0; i < slots_needed && i < sorted.length; i++) {
    allowedMap[String(sorted[i].ts)] = true;
}

// ---- Lock in current slot ----
// If the planner re-runs mid-slot, preserve the scheduling decision that
// was already made for the current slot. Only keep it allowed if it was
// allowed in the PREVIOUS planner run — do not add it if it was not
// scheduled before. Lookup uses timestamp key, not positional index.
// (SLOT_MS / nowTs declared above, at the usable-slot filter)
const currentSlot = slots.find(s => s.ts <= nowTs && (s.ts + SLOT_MS) > nowTs);
if (currentSlot && currentSlot.ts <= deadlineTs) {
    const previousMap = flow.get("car2.allowed_map") || {};
    if (previousMap[String(currentSlot.ts)] === true) {
        allowedMap[String(currentSlot.ts)] = true;
    }
}

// ---- Super cheap override ----
for (const slot of slots) {
    if (slot.price <= super_cheap) allowedMap[String(slot.ts)] = true;
}

// ---- Emergency battery-health floor ----
// Independent of charging mode and price: below EMERGENCY_MIN_SOC the car
// charges in every slot until the floor is reached. The minimal/normal/trip
// selection only sets the price-optimised target and never bypasses pricing.
if (EMERGENCY_MIN_SOC > 0 && soc < EMERGENCY_MIN_SOC) {
    for (const slot of slots) allowedMap[String(slot.ts)] = true;
}

// ---- Store and return ----
flow.set("car2.allowed_map", allowedMap);

msg.payload = {
    car: 2,
    allowed_map: allowedMap,
    soc,
    soc_age_h,
    soc_stale,
    target_soc,
    mode,
    slots_needed,
    energy_needed,
    effective_kw,
    slot_hours,
    total_slots: slots.length,
    usable_slots: usableSlots.length
};

return msg;
