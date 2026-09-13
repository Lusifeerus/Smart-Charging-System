# =============================================================================
# ev_strategy.py — EV charging strategy derivation, cascade & Boost
# Place in <config>/pyscript/ev_strategy.py
#
# Follows the preheater pattern: HA helpers are the sole state store, the
# logic here is a stateless evaluation that can run at any time and always
# converges to the correct state. No internal memory survives a reload.
#
# Responsibilities:
#   1. DERIVE  input_select.ev_charging_strategy (global, flow-facing) from
#              per-car strategies + car↔charger assignment + capability +
#              boost state. The global helper is derived-only: manual edits
#              to it are overwritten on the next evaluation.
#   2. (CASCADE REMOVED) Strategy no longer forces ev_charging_mode /
#              ev_charging_lb. Those are independent user-set global
#              advanced controls now ("Charging schedule" / "Charging
#              control" — the latter being the system kill switch). The
#              derived global ev_charging_strategy is kept ONLY as a
#              posture summary for observer consumers; it no longer
#              cascades anything and is no longer read by the tracker for
#              control (the tracker reads per-charger assigned-car
#              strategy).
#   3. BOOST   per-car temporary full-power charging:
#                ends at target SoC (car's current mode target) OR at the
#                configured duration timeout, whichever comes first.
#              The Evaluator reads input_boolean.ev_carN_boost and ORs it
#              with the allowed_map — nothing global is touched, the other
#              car's schedule and load balancing are unaffected. The only
#              indirect effect: a boosting car never counts toward pv_eco
#              in the derivation, so boosting the PV car flips the global
#              strategy to fast for the duration and reverts automatically.
#
# Services exposed:
#   pyscript.ev_apply_strategy(car=1|2, strategy="fast"|"pv_eco")
#       — card entry point: writes the per-car helper AND re-derives
#         unconditionally (also re-asserts the canonical cascade when the
#         user taps the already-active option to clear a Custom state)
#   pyscript.ev_boost_start(car=1|2)
#   pyscript.ev_boost_cancel(car=1|2)
# =============================================================================

from datetime import datetime, timedelta

# ── Site configuration ────────────────────────────────────────────────────
PV_CAPABLE_CHARGERS = {1}          # charger 1 = go-e (phase switching)

CAR_SOC_SENSORS = {
    1: "sensor.car1_battery_soc",
    2: "sensor.car2_battery_soc",
}

# SoC-while-charging watchdog: per-charger power sensors, as
# (entity_id, unit). A charger without a configured sensor is skipped.
#
# THE UNITS GENUINELY DIFFER — go-e reports W, the Shelly reports kW. Read
# naively that is a silent 1000x error in the worst possible direction: an
# 11 kW session reads as "11", never crosses the 1000 W "really charging"
# threshold, and the charger simply looks idle forever. No error, no flag,
# the watchdog just quietly never runs for it. Hence the unit is declared
# per sensor and every read goes through _charger_power_w().
CHARGER_POWER_SENSORS = {
    1: ("sensor.garage_go_echarger_power_total", "W"),
    2: ("sensor.ev_charger_power", "kW"),
}
SOC_WATCHDOG_MIN_POWER_W = 1000    # "really charging" threshold

_power_unit_warned = set()


def _charger_power_w(charger_n):
    """Charger power in WATTS regardless of the sensor's own unit, or None
    if no sensor is configured. Cross-checks the declared unit against
    Home Assistant's own unit_of_measurement and warns once per entity on
    disagreement — a unit that silently changes under us is exactly the
    failure this indirection exists to prevent."""
    entry = CHARGER_POWER_SENSORS.get(charger_n)
    if not entry:
        return None
    entity, unit = entry
    try:
        raw = float(_get(entity, 0) or 0)
    except (TypeError, ValueError):
        return 0.0

    ha_unit = None
    try:                                   # attribute read must never break
        attrs = state.getattr(entity)      # the watchdog itself
        if attrs:
            ha_unit = attrs.get("unit_of_measurement")
    except Exception:
        pass
    if ha_unit and ha_unit != unit and entity not in _power_unit_warned:
        _power_unit_warned.add(entity)
        log.warning(f"ev_strategy: {entity} declared as {unit} but Home "
                    f"Assistant reports {ha_unit} — power readings for "
                    f"charger {charger_n} may be off by 1000x; fix "
                    f"CHARGER_POWER_SENSORS")

    return raw * 1000.0 if unit == "kW" else raw

# Per-car usable capacity — converts delivered kWh into expected SoC %.
CAR_BATTERY_KWH = {1: 78, 2: 75}

# Progress is judged against ENERGY DELIVERED, not a wall clock. A fixed
# timer cannot serve both a 16 A grid session (1% in ~4 min) and a 6 A PV
# Eco session (1% in ~32 min) — it is necessarily twitchy on one or blind
# on the other. Accumulating delivered kWh and comparing owed-vs-actual SoC
# gain holds both to the same standard, and additionally catches a car
# gaining at the WRONG RATE: the both-chargers-swapped case, where nothing
# is ever frozen but each car climbs at the other charger's speed.
SOC_WATCHDOG_MIN_MINUTES      = 20     # never judge sooner (SoC report lag)
SOC_WATCHDOG_MIN_EXPECTED_PCT = 3.0    # nor before this much gain is owed
SOC_WATCHDOG_PROGRESS_RATIO   = 0.35   # actual < 35% of owed → "behind"
SOC_WATCHDOG_MATCH_RATIO      = 0.50   # other car ≥ 50% of owed → it is the
                                       # car actually on this charger

# ── go-e phase switching ─────────────────────────────────────────────
# Phase mode was historically a manual seasonal setting; the one-tap
# strategy UI and Boost made transitions frequent, so it must follow the
# derived strategy automatically. go-e local API v2: psm 1 = 1-phase,
# psm 2 = 3-phase (0 = charger's own auto — deliberately not used; this
# system is the authority). Issued ONLY on derived-strategy transitions
# and at startup — never re-issued on unchanged derivations, so contactor
# wear stays at user-action frequency.
# Delivery is via rest_command.goe_set_psm (see ev_phase_switch.yaml).
PHASE_SWITCH_ENABLED = True
GOE_PSM = {"fast": 2, "pv_eco": 1}    # 3-phase for fast/boost, 1-phase for surplus tracking

STRATEGY_GLOBAL = "input_select.ev_charging_strategy"
# NOTE: the strategy → mode/lb CASCADE has been removed (see
# DESIGN_percar_strategy_killswitch.md). ev_charging_mode and
# ev_charging_lb are now independent user-set global advanced controls:
#   - ev_charging_mode  = "Charging schedule" (scheduler bypass)
#   - ev_charging_lb    = "Charging control"  (kill switch)
# Strategy selection no longer touches either. The global
# ev_charging_strategy remains as a derived-only POSTURE SUMMARY for
# observer consumers (health template, CSV logger, PV status publisher,
# card badge) — it is NOT read by the tracker for control any more (the
# tracker reads per-charger assigned-car strategy). Retained because
# "is the system in a PV posture at all" is a legitimately global
# question those observers ask.


# ── Small helpers ─────────────────────────────────────────────────────────

def _get(entity, default=None):
    try:
        v = state.get(entity)
        if v in (None, "unknown", "unavailable"):
            return default
        return v
    except Exception:
        return default


# ── MAPPING RESOLVER TWIN v1 (see check_resolver_sync.py) ──
# Same rules as the byte-identical JS resolver block in the Node-RED
# scripts: "Car 1"/"Car 2"/"None"; missing/unexpected → legacy N→N.
def _assigned_car(charger_n):
    """Which car is on charger N. Falls back to legacy mapping (N→N)."""
    s = _get(f"input_select.ev_charger{charger_n}_car")
    if s == "Car 1":
        return 1
    if s == "Car 2":
        return 2
    if s == "None":
        return None
    return charger_n            # helper missing → legacy mapping


def _charger_of_car(car_n):
    for charger_n in (1, 2):
        if _assigned_car(charger_n) == car_n:
            return charger_n
    return None


def _boost_active(car_n):
    return _get(f"input_boolean.ev_car{car_n}_boost") == "on"


def _target_soc(car_n):
    """Target SoC for the car's CURRENT mode (minimal/normal/trip)."""
    mode = _get(f"input_select.ev_car{car_n}_mode", "normal")
    raw = _get(f"input_number.ev_car{car_n}_target_soc_{mode}")
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _soc_raw(car_n):
    """Numeric SoC regardless of age (the watchdog tests whether it moves)."""
    raw = _get(CAR_SOC_SENSORS.get(car_n, ""))
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _soc_age_hours(car_n):
    """IDLE age of the SoC reading in hours, or None if undeterminable.

    This is quantity A only (how long since the value changed) and it is
    meaningful ONLY while the sensor is readable. `last_updated` resets when
    the sensor drops to "unavailable", so during an outage it reports ~0 and
    means nothing — return None there and let the outage clock in
    _soc_unavailable_minutes() carry quantity B instead."""
    if _soc_raw(car_n) is None:
        return None
    try:
        lu = state.get(CAR_SOC_SENSORS[car_n] + ".last_updated")
    except Exception:
        return None
    if lu is None:
        return None
    if isinstance(lu, str):
        try:
            lu = datetime.fromisoformat(lu.replace("Z", "+00:00"))
        except ValueError:
            return None
    try:
        return (datetime.now(lu.tzinfo) - lu).total_seconds() / 3600
    except Exception:
        return None


def _current_soc(car_n):
    """Freshness-checked SoC (Finding 5): a reading older than
    ev_soc_max_age_hours is fiction — treat as unavailable. For boost this
    fails safe: no SoC → the timeout end condition still applies."""
    v = _soc_raw(car_n)
    if v is None:
        return None
    age = _soc_age_hours(car_n)
    try:
        max_h = float(_get("input_number.ev_soc_max_age_hours", 26))
    except (TypeError, ValueError):
        max_h = 26.0
    if age is not None and age > max_h:
        return None
    return v


# ── SoC availability resolver (v1.6) ──────────────────────────────────────
# A car SoC sensor can sit `unavailable` for DAYS. Expired cloud API auth is
# the common cause and it does not self-correct: no amount of driving fixes
# it, a human has to re-authenticate. That makes it a strictly worse version
# of the stale-reading problem fixed in v1.5.
#
# WHY AGE-BASED DETECTION IS BLIND TO IT: numeric -> "unavailable" IS a state
# change, so `last_updated` RESETS at the exact moment the data stops. The
# staleness sensor then reads ~0 h old and reports healthy while there is no
# data at all. Two different quantities were being conflated:
#
#   A  how long since the VALUE changed  — large is fine (parked car)
#   B  how long since we had ANY valid reading — large is always bad
#
# `last_updated` measures neither once the sensor drops out. B needs someone
# to remember the transition, which is what this block does.
#
# STORED IN HA HELPERS, not pyscript module state or Node-RED flow context:
# those are memory-only and are lost on exactly the restart that happens
# during a multi-day outage — which is when the cached value is the only
# thing keeping the car charging. Helpers as the sole state store, per the
# house convention.
#
# Written on TRANSITIONS only (valid->invalid, invalid->valid) plus a value
# write when the reading actually moves, so this costs a handful of recorder
# rows a day rather than one a minute.

SOC_UNAVAILABLE_GRACE_MIN = 15   # ride out HA restarts and brief blips
SOC_NEVER = "1970-01-01 00:00:00"   # input_datetime has no "unset" state;
                                    # epoch is the explicit "not unavailable"
                                    # sentinel. Never a real outage start.


def _dt_helper(entity):
    """Parse an input_datetime helper to datetime, or None for the sentinel."""
    raw = _get(entity)
    if raw in (None, SOC_NEVER):
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def _soc_unavailable_minutes(car_n):
    """Minutes since the SoC sensor stopped returning a number, or None."""
    since = _dt_helper(f"input_datetime.ev_car{car_n}_soc_unavailable_since")
    if since is None:
        return None
    return max(0.0, (datetime.now() - since).total_seconds() / 60.0)


def _soc_last_good(car_n):
    """Last valid reading persisted by _soc_availability_watch, or None.

    -1 is the 'never recorded' sentinel: 0 % is a real (if rare) SoC and must
    not double as 'no data', which is the mistake that would put a genuinely
    flat car on the fallback path instead of its own last-known value."""
    raw = _get(f"input_number.ev_car{car_n}_soc_last_good")
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if v >= 0 else None


def _soc_availability_watch():
    """Maintain the last-good snapshot and the outage clock for each car.

    Idempotent and safe to call every minute: it writes only when validity
    flips or the value actually moves."""
    for car_n in (1, 2):
        live = _soc_raw(car_n)
        since_ent = f"input_datetime.ev_car{car_n}_soc_unavailable_since"
        was_out = _dt_helper(since_ent) is not None

        if live is not None:
            prev = _soc_last_good(car_n)
            if prev is None or abs(prev - live) >= 0.5:
                input_number.set_value(
                    entity_id=f"input_number.ev_car{car_n}_soc_last_good",
                    value=round(live, 1))
            if was_out:
                log.warning(f"ev_strategy: car{car_n} SoC sensor recovered "
                            f"after {_soc_unavailable_minutes(car_n):.0f} min")
                input_datetime.set_datetime(entity_id=since_ent,
                                            datetime=SOC_NEVER)
        elif not was_out:
            # Transition into the outage — stamp it once, here only.
            input_datetime.set_datetime(
                entity_id=since_ent,
                datetime=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            log.warning(f"ev_strategy: car{car_n} SoC sensor went unavailable "
                        f"— planners will fall back to the last known value")

        # Publish the detector. Debounced so an HA restart does not flap it.
        mins = _soc_unavailable_minutes(car_n)
        on = mins is not None and mins >= SOC_UNAVAILABLE_GRACE_MIN
        lg = _soc_last_good(car_n)
        entity = f"binary_sensor.ev_car{car_n}_soc_unavailable"
        attrs = {
            "friendly_name": f"EV Car {car_n} SoC sensor unavailable",
            "device_class": "problem",
            "icon": "mdi:battery-off-outline",
            "unavailable_min": round(mins, 0) if mins is not None else None,
            "last_good_soc": lg,
            # What the planners are actually computing from right now — the
            # single most useful thing to see when the car charges oddly.
            "planning_from": ("live" if mins is None
                              else "last_good" if lg is not None
                              else "fallback"),
        }
        # Publish unconditionally on the mapping-mismatch pattern: the entity
        # must EXIST before the first fault, or the health template and the
        # card silently reference a missing entity for the life of a healthy
        # system and nobody notices it was never wired up. Refreshed every
        # tick while on, because the duration attribute is what the card and
        # the health summary actually display.
        was = _get(entity)
        if on:
            state.set(entity, "on", attrs)
        elif was != "off":
            state.set(entity, "off", attrs)


# ── Core evaluation ───────────────────────────────────────────────────────

def _derive(force_cascade=False):
    """Compute the derived global strategy POSTURE SUMMARY and, on change,
    fire the go-e phase switch.

    The mode/lb cascade is GONE (per-car strategy no longer forces the
    global advanced controls). What remains:
      - maintain the derived-only ev_charging_strategy posture summary for
        observer consumers (health/logger/publisher/card);
      - fire _set_goe_psm on a genuine change (covers strategy switches AND
        boost start/end, since boost flips the derived value).

    force_cascade is retained as a no-op accepted argument so existing
    call sites (ev_apply_strategy) don't need signature changes; there is
    no longer any cascade to force. It is deliberately ignored.
    """
    derived = "fast"
    for car_n in (1, 2):
        if _get(f"input_select.ev_car{car_n}_strategy") != "pv_eco":
            continue
        if _boost_active(car_n):
            continue                        # boosting car never counts
        charger = _charger_of_car(car_n)
        if charger in PV_CAPABLE_CHARGERS:
            derived = "pv_eco"
            break

    current = _get(STRATEGY_GLOBAL, "fast")
    changed = derived != current

    if changed:
        input_select.select_option(entity_id=STRATEGY_GLOBAL, option=derived)
        log.info(f"ev_strategy: posture summary {current} → {derived}")
        # Covers ALL phase-relevant transitions in one place: strategy
        # switches AND boost start/end (boost flips the derived value).
        _set_goe_psm(derived)


def _set_goe_psm(strategy):
    """Command the go-e's phase mode to match the derived strategy.
    Failure is logged, never raised: a wrong phase mode degrades charging
    speed or surplus tracking, it is never unsafe — LB and the fuse guard
    supervise current regardless of phase count, and the tracker's amp
    math adapts to whatever phase count the charger actually reports."""
    if not PHASE_SWITCH_ENABLED:
        return
    psm = GOE_PSM.get(strategy)
    if psm is None:
        return
    try:
        rest_command.goe_set_psm(psm=psm)
        log.info(f"ev_strategy: go-e psm → {psm} "
                 f"({'3-phase' if psm == 2 else '1-phase'}) for {strategy}")
    except Exception as exc:
        log.warning(f"ev_strategy: go-e psm switch failed: {exc}")


def _end_boost(car_n, reason):
    input_boolean.turn_off(entity_id=f"input_boolean.ev_car{car_n}_boost")
    log.info(f"ev_strategy: boost car{car_n} ended ({reason})")
    _derive()


# ── Services ──────────────────────────────────────────────────────────────

@service
def ev_apply_strategy(car=None, strategy=None):
    """Set a car's strategy and re-derive. Card entry point."""
    car = int(car)
    if car not in (1, 2) or strategy not in ("fast", "pv_eco"):
        log.warning(f"ev_apply_strategy: invalid args car={car} strategy={strategy}")
        return
    entity = f"input_select.ev_car{car}_strategy"
    if _get(entity) != strategy:
        input_select.select_option(entity_id=entity, option=strategy)
    # Force cascade: tapping the already-active option re-asserts the
    # canonical mode/LB combination (clears "Custom").
    _derive()  # (cascade removed; re-derive to refresh posture + psm)


@service
def ev_boost_start(car=None):
    """Start Boost: full power until target SoC or timeout, whichever first."""
    car = int(car)
    if car not in (1, 2):
        return
    try:
        hours = float(_get("input_number.ev_boost_duration_hours", 3))
    except (TypeError, ValueError):
        hours = 3.0
    until = datetime.now() + timedelta(hours=hours)
    input_datetime.set_datetime(
        entity_id=f"input_datetime.ev_car{car}_boost_until",
        datetime=until.strftime("%Y-%m-%d %H:%M:%S"),
    )
    input_boolean.turn_on(entity_id=f"input_boolean.ev_car{car}_boost")
    log.info(f"ev_strategy: boost car{car} started until {until:%H:%M}")
    _derive()


@service
def ev_boost_cancel(car=None):
    car = int(car)
    if car not in (1, 2):
        return
    _end_boost(car, "cancelled")


# ── Triggers ──────────────────────────────────────────────────────────────

@state_trigger(
    "input_select.ev_car1_strategy",
    "input_select.ev_car2_strategy",
    "input_select.ev_charger1_car",
    "input_select.ev_charger2_car",
    "input_boolean.ev_car1_boost",
    "input_boolean.ev_car2_boost",
    # Global is derived-only: revert any manual edit on the next evaluation
    "input_select.ev_charging_strategy",
)
def _on_state_change(**kwargs):
    _derive()


def _heartbeat():
    """Health heartbeat (Finding 4): sensor.ev_system_health checks this
    timestamp's age. Stale > ~3 min means derivation is frozen and the
    boost SoC/timeout watchdog is dead (the independent HA cutoff still
    covers boost — but you want to know)."""
    attrs = {
        "friendly_name": "EV Strategy pyscript heartbeat",
        "device_class": "timestamp",
        "icon": "mdi:heart-pulse",
    }
    for n in (1, 2):
        age = _soc_age_hours(n)
        attrs[f"car{n}_soc_age_h"] = round(age, 1) if age is not None else None
        # Quantity B: None while the sensor is healthy, minutes once it is not.
        out = _soc_unavailable_minutes(n)
        attrs[f"car{n}_soc_unavailable_min"] = round(out, 0) if out is not None else None
        attrs[f"car{n}_soc_last_good"] = _soc_last_good(n)
    state.set(
        "sensor.ev_strategy_heartbeat",
        datetime.now().astimezone().isoformat(),
        attrs,
    )


@time_trigger("startup")
def _on_startup():
    # Before the heartbeat: an HA restart that happens DURING an outage must
    # re-establish the outage clock from the restored helper, not lose it.
    _soc_availability_watch()
    _heartbeat()
    _derive()
    # Derivation above only issues psm on a CHANGE; after a reboot the
    # derived value is usually unchanged but the charger's phase mode is
    # unverified — assert it once explicitly.
    _set_goe_psm(_get(STRATEGY_GLOBAL, "fast"))


# Per-car charging-session tracking for the SoC watchdog. Module-level
# (diagnostic state, not control state): lost on pyscript reload, which
# merely restarts the 60-minute measurement window.
_soc_watch = {}


def _soc_watchdog():
    """Roadmap step 3, 'SoC-mismatch watchdog' — now complete.

    While a charger is demonstrably delivering power, the car the mapping
    says is plugged into it must gain SoC in proportion to the energy
    delivered. Two independent conclusions are drawn:

      1. Assigned car is NOT tracking the delivered energy
         → binary_sensor.ev_carN_soc_stale  (integration dead, car asleep,
           or wrong car on the charger — ambiguous on its own)

      2. ...and the OTHER car gained roughly what this charger delivered
         → binary_sensor.ev_chargerN_mapping_mismatch  (unambiguous: that
           is the car actually plugged in here, the mapping is swapped)

    (2) is the half of the original design that was never built. A frozen
    reading alone cannot distinguish a parked car from a swapped plug; the
    other car's gain matching THIS charger's delivered energy can.

    Detection only. This NEVER reassigns the mapping and NEVER acts on
    charging — the watchdog warns, it does not drive."""
    behind = {1: False, 2: False}          # keyed by CAR
    mismatch = {}                          # keyed by CHARGER
    evidence = {}                          # keyed by CHARGER

    for charger_n in CHARGER_POWER_SENSORS:
        power_w = _charger_power_w(charger_n)   # normalised to W
        if power_w is None:
            continue                            # no sensor configured
        car_n = _assigned_car(charger_n)
        soc = _soc_raw(car_n) if car_n else None

        if not car_n or power_w < SOC_WATCHDOG_MIN_POWER_W or soc is None:
            _soc_watch.pop(charger_n, None)
            continue

        other_car = 2 if car_n == 1 else 1
        other_soc = _soc_raw(other_car)

        sess = _soc_watch.get(charger_n)
        if sess is None or sess["car"] != car_n:
            _soc_watch[charger_n] = {
                "car": car_n, "since": datetime.now(), "start_soc": soc,
                "other_start_soc": other_soc, "energy_kwh": 0.0,
            }
            continue

        # Integrate delivered energy — this function runs once per minute.
        sess["energy_kwh"] += (power_w / 1000.0) / 60.0

        capacity = CAR_BATTERY_KWH.get(car_n, 75)
        owed_pct = (sess["energy_kwh"] / capacity) * 100
        mins = (datetime.now() - sess["since"]).total_seconds() / 60

        # Withhold judgement until there is real evidence: a coarse or
        # laggy SoC report must not be mistaken for a stalled one.
        if mins < SOC_WATCHDOG_MIN_MINUTES or owed_pct < SOC_WATCHDOG_MIN_EXPECTED_PCT:
            continue

        got_pct = soc - sess["start_soc"]
        if got_pct >= owed_pct * SOC_WATCHDOG_PROGRESS_RATIO:
            continue                       # tracking the energy — healthy

        behind[car_n] = True

        # ── Cross-car correlation ──────────────────────────────────────
        if other_soc is None or sess.get("other_start_soc") is None:
            continue
        other_gain = other_soc - sess["other_start_soc"]
        if other_gain < owed_pct * SOC_WATCHDOG_MATCH_RATIO:
            continue                       # neither car tracks us — not a swap

        # Rule out the innocent explanation: the other car is simply
        # charging on its OWN charger at the same time, which would explain
        # its gain without implying anything about our mapping.
        other_charger = _charger_of_car(other_car)
        other_power_w = _charger_power_w(other_charger) if other_charger else None
        if other_power_w is not None and other_power_w >= SOC_WATCHDOG_MIN_POWER_W:
            continue                       # both charging — proves nothing

        mismatch[charger_n] = True
        evidence[charger_n] = {
            "assigned_car": car_n,
            "assigned_car_gain_pct": round(got_pct, 1),
            "rising_car": other_car,
            "rising_car_gain_pct": round(other_gain, 1),
            "energy_delivered_kwh": round(sess["energy_kwh"], 2),
            "expected_gain_pct": round(owed_pct, 1),
            "session_minutes": int(mins),
            # False → the other charger has no power sensor configured, so
            # "both charging simultaneously" could not be positively ruled
            # out; the verdict rests on the energy-magnitude match alone.
            "other_charger_confirmed_idle": other_power_w is not None,
        }

    for car_n in (1, 2):
        entity = f"binary_sensor.ev_car{car_n}_soc_stale"
        new_state = "on" if behind[car_n] else "off"
        if _get(entity) != new_state:
            if behind[car_n]:
                log.warning(f"ev_strategy: car{car_n} SoC not tracking the "
                            f"energy delivered to its charger")
            state.set(entity, new_state, {
                "friendly_name": f"EV Car {car_n} SoC stale while charging",
                "device_class": "problem",
                "icon": "mdi:battery-alert-variant-outline",
            })

    for charger_n in CHARGER_POWER_SENSORS:
        entity = f"binary_sensor.ev_charger{charger_n}_mapping_mismatch"
        on = bool(mismatch.get(charger_n))
        was = _get(entity)
        attrs = {
            "friendly_name": f"EV Charger {charger_n} mapping mismatch",
            "device_class": "problem",
            "icon": "mdi:swap-horizontal-bold",
        }
        attrs.update(evidence.get(charger_n, {}))
        if on:
            if was != "on":                # log the transition, not every tick
                e = evidence.get(charger_n, {})
                log.warning(
                    f"ev_strategy: charger{charger_n} MAPPING MISMATCH? "
                    f"delivered {e.get('energy_delivered_kwh')} kWh; assigned "
                    f"car{e.get('assigned_car')} gained "
                    f"{e.get('assigned_car_gain_pct')}% but car"
                    f"{e.get('rising_car')} gained "
                    f"{e.get('rising_car_gain_pct')}% — check the car↔charger "
                    f"assignment")
            state.set(entity, "on", attrs)  # refresh evidence each cycle
        elif was != "off":
            state.set(entity, "off", attrs)


@time_trigger("cron(* * * * *)")
def _boost_watchdog():
    """Every-minute boost end-condition check (stateless, preheater pattern)."""
    _soc_availability_watch()
    _heartbeat()
    _soc_watchdog()
    for car_n in (1, 2):
        if not _boost_active(car_n):
            continue

        # 1. Target SoC reached? (car's current mode target)
        soc = _current_soc(car_n)
        target = _target_soc(car_n)
        if soc is not None and target is not None and soc >= target:
            _end_boost(car_n, f"target reached: {soc:.0f}% ≥ {target:.0f}%")
            continue

        # 2. Timeout? (missing/invalid until → fail safe: end the boost)
        until_raw = _get(f"input_datetime.ev_car{car_n}_boost_until")
        try:
            until = datetime.strptime(until_raw, "%Y-%m-%d %H:%M:%S")
        except (TypeError, ValueError):
            _end_boost(car_n, "invalid boost_until — failing safe")
            continue
        if datetime.now() >= until:
            _end_boost(car_n, "duration elapsed")
