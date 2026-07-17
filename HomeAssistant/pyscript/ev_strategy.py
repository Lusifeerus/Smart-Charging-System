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
    1: "sensor.car1_battery_soc",   # CHANGE ME: your Car 1 SoC sensor
    2: "sensor.car2_battery_soc",   # CHANGE ME: your Car 2 SoC sensor
}

# SoC-while-charging watchdog (Finding 5): per-charger power sensors.
# A charger without a configured sensor is skipped by the watchdog.
CHARGER_POWER_SENSORS = {
    1: "sensor.garage_go_echarger_power_total",   # W
    2: None,   # TopAC / Shelly power sensor — CHANGE-ME when known
}
SOC_WATCHDOG_MIN_POWER_W = 1000    # "really charging" threshold
SOC_WATCHDOG_MINUTES = 60          # frozen this long while charging → flag

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
    """Age of the SoC reading in hours, or None if undeterminable."""
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
    state.set(
        "sensor.ev_strategy_heartbeat",
        datetime.now().astimezone().isoformat(),
        attrs,
    )


@time_trigger("startup")
def _on_startup():
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
    """Finding 5 / roadmap 'SoC-mismatch watchdog': while a charger is
    demonstrably delivering power to its assigned car, that car's SoC must
    rise within SOC_WATCHDOG_MINUTES. If the reading stays frozen, flag
    binary_sensor.ev_carN_soc_stale — the health sensor surfaces it as
    degraded. Detection only; NEVER acts on charging."""
    flagged = {1: False, 2: False}

    for charger_n, power_sensor in CHARGER_POWER_SENSORS.items():
        if not power_sensor:
            continue
        try:
            power_w = float(_get(power_sensor, 0) or 0)
        except (TypeError, ValueError):
            power_w = 0
        car_n = _assigned_car(charger_n)
        soc = _soc_raw(car_n) if car_n else None

        if not car_n or power_w < SOC_WATCHDOG_MIN_POWER_W or soc is None:
            _soc_watch.pop(charger_n, None)
            continue

        sess = _soc_watch.get(charger_n)
        if sess is None or sess["car"] != car_n:
            _soc_watch[charger_n] = {"car": car_n, "since": datetime.now(),
                                     "start_soc": soc}
            continue
        if soc > sess["start_soc"]:
            # SoC moving — healthy; slide the window forward
            sess["since"] = datetime.now()
            sess["start_soc"] = soc
            continue
        mins = (datetime.now() - sess["since"]).total_seconds() / 60
        if mins >= SOC_WATCHDOG_MINUTES:
            flagged[car_n] = True

    for car_n in (1, 2):
        entity = f"binary_sensor.ev_car{car_n}_soc_stale"
        new_state = "on" if flagged[car_n] else "off"
        if _get(entity) != new_state:
            if flagged[car_n]:
                log.warning(f"ev_strategy: car{car_n} SoC frozen ≥ "
                            f"{SOC_WATCHDOG_MINUTES} min while charging")
            state.set(entity, new_state, {
                "friendly_name": f"EV Car {car_n} SoC stale while charging",
                "device_class": "problem",
                "icon": "mdi:battery-alert-variant-outline",
            })


@time_trigger("cron(* * * * *)")
def _boost_watchdog():
    """Every-minute boost end-condition check (stateless, preheater pattern)."""
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
