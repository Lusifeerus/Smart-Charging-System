/************************************************************
 * EV Charging — Status Publisher
 * Publishes per-car charging status to MQTT every 15 s.
 *
 * Wiring:
 *   Wire from Evaluator output 1 → this node → mqtt out
 *   (fires every 15 s when the evaluator runs)
 *
 * Requires coordinator.js to store charger1/2.carState and
 * evaluator.js to store charger1/2.frc + charger1/2.schedulerAllows
 * (small additions documented below).
 *
 * Publishes to: homeassistant/sensor/ev_charging_status/state
 * Creates:      sensor.ev_charging_status  (via MQTT discovery)
 ************************************************************/

const SLOT_MS = 15 * 60 * 1000;

function evPad(v) { return String(v).padStart(2, '0'); }

/**
 * Derive status label + badge class from raw charger data.
 *
 * Badge classes match ev-charging-cards.js and car-heater-card.js:
 *   ok   → green  (#1D9E75)
 *   warn → orange (#EA580C)
 *   off  → grey
 */
// go-e "err" — deliberately not name-mapped, same reasoning as
// coordinator.js: the numeric→name enum differs between firmware
// versions and this charger runs an undocumented beta (60.5). The raw
// code is shown verbatim rather than asserting a translation that can't
// be verified for this firmware.

function deriveStatus(carState, frc, lbWantsStop, didwestop, hasUpcoming, fault, pvOwned) {
    // Fault takes priority over every other label — a broken charger is
    // not "Not Connected" or "Paused", it needs attention. Independent
    // of carState/lmo: a charger can fault while otherwise looking idle.
    if (fault)
        return { label: `Fault (err=${fault.code})`, badge: 'err' };
    if (carState === 1 || carState == null)
        return { label: 'Not Connected', badge: 'off' };
    // car=3 is WaitCar — the charger is unlocked and offering current,
    // the car simply hasn't started drawing yet (often because it has
    // just been unlocked this same cycle). NOT a paused/complete state;
    // treating it as one previously caused a real allocation deadlock
    // (see coordinator.js ACTIVE_CAR_STATES). Once allocated current,
    // this is normally transient — shown as Scheduled/Charging like any
    // other connected-and-eligible state rather than a distinct pause.
    // didwestop / lbWantsStop are COORDINATOR state, written only inside its
    // `if (cNActive)` blocks. A PV-owned charger is excluded from coordinator
    // allocation, so both flags freeze at their last fast-flow values — reading
    // them for a PV car would pin a stale "Grid Limit"/"Paused (Overload)"
    // badge indefinitely. Skip them when the tracker owns the charger; the
    // Fuse Guard's independent stop still shows up via the polled frc below.
    if (!pvOwned) {
        if (didwestop === 1)
            return { label: 'Paused (Overload)', badge: 'warn' };
        if (lbWantsStop)
            return { label: 'Grid Limit', badge: 'warn' };
    }
    if ((carState === 2 || carState === 3) && frc === 0)
        return { label: 'Charging', badge: 'ok' };
    if (carState === 4 && frc === 0)
        return { label: 'Paused (Car)', badge: 'off' };
    // Car connected, frc=1, no overload.
    // A PV-owned charger has no price schedule driving it — "Scheduled" /
    // "Not Scheduled" would be answering a question nobody asked.
    if (pvOwned)
        return { label: 'Waiting for sun', badge: 'off' };
    if (hasUpcoming)
        return { label: 'Scheduled', badge: 'ok' };
    return { label: 'Not Scheduled', badge: 'warn' };
}

/**
 * Compute slot display time.
 *
 * When charging:     find end of consecutive allowed window → "Until HH:MM"
 * When not charging: find next allowed slot start          → "From HH:MM"
 * When nothing:      "—"
 */
function computeSlotInfo(allowedMap, slots, isCharging) {
    if (!allowedMap || !slots || slots.length === 0)
        return { time: '—', label: 'Next slot' };

    const nowTs = Date.now();

    if (isCharging) {
        // Walk forward from the current slot and find where the consecutive
        // run of allowed slots ends.
        let endTs    = null;
        let inWindow = false;

        for (const s of slots) {
            const allowed = !!allowedMap[String(s.ts)];
            if (!inWindow) {
                // Look for the slot we're currently inside
                if (s.ts <= nowTs && (s.ts + SLOT_MS) > nowTs && allowed) {
                    inWindow = true;
                    endTs    = s.ts + SLOT_MS;
                }
            } else {
                // Extend window while consecutive slots are allowed
                if (allowed) {
                    endTs = s.ts + SLOT_MS;
                } else {
                    break;  // first gap — stop here
                }
            }
        }

        if (endTs) {
            const d = new Date(endTs);
            return { time: `${evPad(d.getHours())}:${evPad(d.getMinutes())}`, label: 'Until' };
        }
        return { time: '—', label: 'Until' };

    } else {
        // Find first future allowed slot
        const next = slots.find(s => s.ts > nowTs && !!allowedMap[String(s.ts)]);
        if (next) {
            const d = new Date(next.ts);
            return { time: `${evPad(d.getHours())}:${evPad(d.getMinutes())}`, label: 'From' };
        }
        return { time: '—', label: 'Next slot' };
    }
}

function hasUpcomingSlots(allowedMap, slots) {
    if (!allowedMap || !slots) return false;
    const nowTs = Date.now();
    return slots.some(s => s.ts > nowTs && !!allowedMap[String(s.ts)]);
}

// ═══ MAPPING RESOLVER v1 — DO NOT EDIT IN ISOLATION ═══════════
// Byte-identical copies live in: coordinator.js, evaluator.js,
// planner_car1.js, planner_car2.js, ev_status_publisher.js.
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

// ── Per-charger strategy (PV Eco ownership) ──────────────────────────
// Mirrors the identical gate in coordinator.js and evaluator.js. A
// PV-capable charger whose assigned car is on PV Eco is driven by the PV
// Tracker, not the fast flow — so fast-flow semantics (price slots,
// "Scheduled", coordinator stop flags) are meaningless for it and must not
// be reported. Boost overrides ownership symmetrically (a boosting PV car
// is a fast-flow action). {1} today → {1,2} with a 2nd go-e.
const PV_CAPABLE_CHARGERS = [1];
function carStrategy(carNum) {
    if (carNum == null) return "fast";   // unassigned/guest → never PV Eco
    return global.get(
        `homeassistant.homeAssistant.states['input_select.ev_car${carNum}_strategy'].state`
    ) || "fast";
}
function pvOwnedCharger(chargerN, carNum) {
    const boosting = carNum != null && global.get(
        `homeassistant.homeAssistant.states['input_boolean.ev_car${carNum}_boost'].state`
    ) === "on";
    return PV_CAPABLE_CHARGERS.includes(chargerN)
        && carStrategy(carNum) === "pv_eco"
        && !boosting;
}

// Live surplus for a PV-owned charger's slot tile. Reads
// sensor.ev_pv_eco_status (PV Eco's own MQTT-discovered status sensor) —
// same cross-flow pattern as every other HA-state read in this file.
// Missing/unavailable (PV Eco flow not deployed, or a fresh boot before its
// first publish) falls back to "—" rather than showing 0 kW, which would
// misleadingly imply zero surplus instead of "no data yet".
function pvSolarTile() {
    const attrs = global.get(
        "homeassistant.homeAssistant.states['sensor.ev_pv_eco_status'].attributes"
    );
    const kw = attrs?.surplus_kw;
    if (typeof kw !== 'number' || !isFinite(kw)) {
        return { time: '—', label: 'Solar' };
    }
    return { time: `${kw.toFixed(1)} kW`, label: 'Solar' };
}

function buildCarStatus(n) {
    const chargerN    = chargerOfCar(n);
    const slots       = flow.get('nordpool_slots')               || [];
    const allowedMap  = flow.get(`car${n}.allowed_map`)          || {};

    if (chargerN == null) {
        // Car not assigned to any charger — show as Not Connected but
        // keep surfacing its next planned slot so the schedule is visible.
        const slotInfo = computeSlotInfo(allowedMap, slots, false);
        return {
            status:        'Not Connected',
            badge:         'off',
            allocated_amp: 0,
            slot_time:     slotInfo.time,
            slot_label:    slotInfo.label
        };
    }

    const pvOwned     = pvOwnedCharger(chargerN, n);
    const lbStop      = flow.get(`lb_wants_stop_${chargerN}`)    || false;
    const didwestop   = flow.get(`charger${chargerN}.didwestop`) || 0;
    // Use charger's own reported amp (from poll) — always current regardless
    // of LB mode. allocatedAmp is stale when coordinator is gated by lb_gate.
    const allocAmp    = flow.get(`charger${chargerN}.reportedAmp`) || 0;
    const carState    = flow.get(`charger${chargerN}.carState`)  ?? null;
    // Polled frc, for the same reason as reportedAmp: the COMMANDED frc
    // (charger${chargerN}.frc, written by the evaluator) freezes whenever a
    // gate suppresses the evaluator's write for that charger — which the
    // per-car PV-ownership gate now does by design. Fall back to the
    // commanded value only if the poll hasn't supplied one yet.
    const polledFrc   = flow.get(`charger${chargerN}.reportedFrc`);
    const frc         = (polledFrc != null)
        ? polledFrc
        : (flow.get(`charger${chargerN}.frc`) ?? 1);
    const errState    = flow.get(`charger${chargerN}.errState`)  ?? null;
    const fault       = (errState != null && errState !== 0)
        ? { code: errState }
        : null;

    const upcoming    = hasUpcomingSlots(allowedMap, slots);
    const isCharging  = (carState === 2 || carState === 3 || carState === 4) && frc === 0 && allocAmp > 0;

    const status      = deriveStatus(carState, frc, lbStop, didwestop, upcoming, fault, pvOwned);
    // Price slots are meaningless for a PV-owned charger — the tracker follows
    // surplus, not the schedule. Show the live surplus instead of a
    // fast-flow slot time. Cross-flow read: PV Eco is a separate Node-RED
    // tab, reached the same way any HA state is — via the MQTT-discovered
    // sensor.ev_pv_eco_status its own Status Publisher maintains, not flow
    // context (which doesn't cross tabs). Was hardcoded to an unconditional
    // "—" when this tile was renamed from the price-slot display; never
    // filled in with a value, so it read "Solar / —" no matter what.
    const slotInfo    = pvOwned
        ? pvSolarTile()
        : computeSlotInfo(allowedMap, slots, isCharging);

    return {
        status:        status.label,
        badge:         status.badge,
        allocated_amp: allocAmp,
        slot_time:     slotInfo.time,
        slot_label:    slotInfo.label
    };
}

// Build payload
// health: consumed by sensor.ev_system_health (Finding 4). ts proves this
// chain (poll → assembler → coordinator/evaluator → publisher) is alive —
// retained MQTT otherwise makes a dead chain look permanently fresh.
// nordpool age is exposed here because nordpool_shared lives in Node-RED
// global context, invisible to HA templates.
const shared = global.get('nordpool_shared') || null;
const payload = {
    state:      'ok',
    attributes: {
        friendly_name: 'EV Charging Status',
        car1: buildCarStatus(1),
        car2: buildCarStatus(2),
        health: {
            ts: new Date().toISOString(),
            nordpool_age_s: (shared && shared.published_at)
                ? Math.round((Date.now() - shared.published_at) / 1000)
                : null,
            slots_count: (flow.get('nordpool_slots') || []).length
        }
    }
};

msg.topic   = 'homeassistant/sensor/ev_charging_status/state';
msg.payload = JSON.stringify(payload);
msg.retain  = true;

return msg;
