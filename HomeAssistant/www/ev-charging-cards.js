// =============================================================================
// ev-charging-cards.js  v3
// EV Charging System — Custom Lovelace Cards
//
// Four components in one file:
//   ev-charging-common-card    — priority + advanced (charging mode, LB)
//   ev-charging-car-card       — per-car strategy (Fast/PV Eco), Boost,
//                                charger assignment, status, target, deadline
//   ev-charging-settings-card  — advanced numeric settings (SoC targets, price threshold)
//   ev-charging-plan-card      — per-car computed charging-plan summary
//
// Style exactly matches car-heater-card.js:
//   - Same font stack, badge classes, stat tiles, section labels
//   - Same time picker component (identical HTML/CSS/interaction)
//   - New: iOS-style segmented control for multi-option settings
// =============================================================================

function _evPad(v) { return String(v).padStart(2, '0'); }

function _evIconBtn(id, icon, variant) {
  const bg = variant === 'confirm' ? 'var(--success-color)' : 'var(--error-color)';
  return `<button id="${id}" style="width:44px;height:44px;border-radius:50%;border:none;background:${bg};color:var(--text-primary-color);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
    <ha-icon icon="${icon}" style="--mdi-icon-size:24px;"></ha-icon>
  </button>`;
}

// Shared CSS injected into both cards — mirrors car-heater-card.js verbatim
// where components are shared, extends with segmented control.
const _EV_CSS = `
  ha-card {
    padding: 1rem 1.25rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  /* ── Badges ── identical to car-heater-card */
  .badge { font-size:11px; padding:3px 9px; border-radius:20px; font-weight:600; }
  .badge-off  { background:rgba(var(--rgb-primary-text-color,0,0,0),0.12); color:var(--secondary-text-color); }
  .badge-ok   { background:rgba(var(--rgb-success-color,15,157,88),0.15);  color:var(--success-color); }
  .badge-warn { background:rgba(var(--rgb-warning-color,255,152,0),0.15);  color:var(--warning-color); }
  .badge-err  { background:rgba(var(--rgb-error-color,219,68,55),0.15);    color:var(--error-color); }

  /* ── Status row stats ── identical to car-heater-card */
  .status-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 10px 0 4px;
  }
  .stat { background:var(--secondary-background-color); border-radius:8px; padding:8px 10px; }
  .stat-label { font-size:11px; color:var(--secondary-text-color); margin-bottom:2px; display:flex; align-items:center; gap:3px; }
  .stat-value { font-size:15px; font-weight:600; color:var(--primary-text-color); }

  /* ── Section labels ── identical to car-heater-card */
  .section-label {
    font-size: 12px;
    color: var(--secondary-text-color);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
    opacity: 0.6;
  }
  .divider { border:none; border-top:1px solid var(--divider-color); margin:14px 0; }

  /* ── iOS-style segmented control ── */
  .seg {
    display: flex;
    background: var(--secondary-background-color);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
  }
  .seg-btn {
    flex: 1;
    padding: 7px 6px;
    font-size: 13px;
    font-weight: 500;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    background: transparent;
    color: var(--primary-text-color);
    transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn.active {
    background: var(--card-background-color);
    color: var(--primary-text-color);
    box-shadow: 0 1px 3px rgba(var(--rgb-primary-text-color,0,0,0),0.12);
    font-weight: 600;
  }

  /* ── Time picker sub-panel ── identical to car-heater-card */
  .sub-panel {
    display: none;
    background: var(--secondary-background-color);
    border-radius: 12px;
    padding: 14px 12px 12px;
    margin: 2px 0 8px;
  }
  .sub-panel.open { display: block; }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .panel-title { font-size:13px; font-weight:600; color:var(--secondary-text-color); }
  .time-picker-inner { display:flex; align-items:center; justify-content:center; gap:8px; }
  .time-spinner { display:flex; flex-direction:column; align-items:center; gap:6px; }
  .spin-btn {
    width: 44px; height: 32px;
    border: 1px solid var(--divider-color);
    background: var(--card-background-color);
    border-radius: 6px;
    font-size: 16px;
    cursor: pointer;
    color: var(--primary-text-color);
    display: flex; align-items: center; justify-content: center;
  }
  .spin-val {
    font-size: 34px; font-weight: 700;
    color: var(--primary-text-color);
    min-width: 52px; text-align: center;
  }
  .t-colon {
    font-size: 34px; font-weight: 300;
    color: var(--secondary-text-color);
    align-self: center;
  }

  /* ── Deadline row ── */
  .deadline-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0 8px;
    cursor: pointer;
    border-radius: 8px;
  }
  .deadline-row:active { opacity: 0.7; }
  .deadline-time {
    font-size: 28px; font-weight: 600;
    color: var(--primary-text-color); line-height: 1.1;
  }
  .deadline-hint { font-size:11px; color:var(--secondary-text-color); margin-top:1px; }

  /* ── v3: strategy / boost / advanced / assignment ── */
  .seg-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .hint-line {
    font-size: 11px;
    color: var(--secondary-text-color);
    margin: 6px 2px 0;
    min-height: 13px;
  }
  .adv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    margin: 16px 0 8px;
    user-select: none;
  }
  .adv-header .section-label { margin: 0; }
  .adv-chevron {
    --mdi-icon-size: 18px;
    color: var(--secondary-text-color);
    opacity: 0.6;
    transition: transform 0.15s;
  }
  .adv-open .adv-chevron { transform: rotate(90deg); }
  .adv-body { display: none; }
  .adv-open .adv-body { display: block; }
  /* Effective-strategy chip in the collapsed Strategy header: shows what the
     car will ACTUALLY do, so the section can stay collapsed and still be
     verifiable at a glance. .unmet = a stored PV Eco intent the current
     charger can't honour. */
  .strat-effective {
    font-size: 12px;
    font-weight: 600;
    color: var(--secondary-text-color);
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .strat-effective.unmet { color: var(--warning-color); }
  .kill-note {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(var(--rgb-error-color,219,68,55),0.10);
    border: 1px solid rgba(var(--rgb-error-color,219,68,55),0.35);
    color: var(--error-color);
    font-size: 13px;
    line-height: 1.4;
  }
  /* System-paused: greys per-car controls in place (visible, disabled) */
  .system-paused {
    opacity: 0.45;
    pointer-events: none;
    filter: grayscale(0.6);
  }
  .paused-hint {
    color: var(--error-color) !important;
    font-weight: 600;
  }
  .boost-btn {
    width: 100%;
    padding: 10px;
    font-size: 14px;
    font-weight: 600;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    background: rgba(var(--rgb-warning-color,255,152,0),0.15);
    color: var(--warning-color);
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .boost-btn.active {
    background: var(--warning-color);
    color: var(--text-primary-color);
  }
  .assign-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 2px;
    cursor: pointer;
    font-size: 12px;
    color: var(--secondary-text-color);
  }
  .assign-row:active { opacity: 0.7; }
  .assign-value { font-weight: 600; color: var(--primary-text-color); }
  .chooser-btn {
    width: 100%;
    padding: 10px;
    margin: 3px 0;
    font-size: 13px;
    font-weight: 500;
    border: 1px solid var(--divider-color);
    border-radius: 8px;
    cursor: pointer;
    background: var(--card-background-color);
    color: var(--primary-text-color);
  }
  .chooser-btn.current { border-color: var(--primary-color); font-weight: 600; }
`;

// =============================================================================
// ev-charging-common-card
// Shows: charging mode (scheduled/manual), load balancing (auto/manual),
//        priority (Car 1 / SoC Smart / Car 2)
//
// config:
//   car1_name_entity: input_text.ev_car1_name   (default)
//   car2_name_entity: input_text.ev_car2_name   (default)
// =============================================================================
class EvChargingCommonCard extends HTMLElement {

  setConfig(config) {
    this._config          = config;
    this._car1NameEntity  = config.car1_name_entity || 'input_text.ev_car1_name';
    this._car2NameEntity  = config.car2_name_entity || 'input_text.ev_car2_name';
    this._healthEntity    = config.health_entity    || 'sensor.ev_system_health';
  }

  getCardSize() { return 4; }

  set hass(h) {
    this._hass = h;
    if (!this._built) { this._build(); this._built = true; }
    this._syncFromHass();
  }

  _build() {
    this.innerHTML = `
      <ha-card>
        <style>${_EV_CSS}</style>

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
          <span style="font-size:22px;font-weight:600;color:var(--primary-text-color);">EV Charging</span>
          <span style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span class="badge" id="healthBadge" style="display:none;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
            <ha-icon icon="mdi:ev-station" style="--mdi-icon-size:22px;color:var(--secondary-text-color);opacity:0.5;flex-shrink:0;"></ha-icon>
          </span>
        </div>

        <div class="section-label">Priority</div>
        <div class="seg" id="segPriority">
          <button class="seg-btn" id="prioCar1" data-val="Manual Car 1">Car 1</button>
          <button class="seg-btn" data-val="SoC Smart">SoC Smart</button>
          <button class="seg-btn" id="prioCar2" data-val="Manual Car 2">Car 2</button>
        </div>

        <!-- Advanced: two INDEPENDENT global controls (no cascade, no
             Custom pill — strategy no longer drives these).
             • Charging schedule (ev_charging_mode): scheduler bypass.
               Manual = ignore the price schedule, system still fully
               engaged (load balancing on, still commanding chargers).
             • Charging control (ev_charging_lb): the KILL SWITCH.
               Manual = the whole smart layer lets go; the user drives the
               chargers from the go-e/Shelly app with zero interference.
               Only the Fuse Guard stays active. When engaged, the card
               shows a system-paused state (per-car controls greyed). -->
        <div id="advWrap">
          <div class="adv-header" id="advHeader">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="section-label">Advanced</span>
            </div>
            <ha-icon icon="mdi:chevron-right" class="adv-chevron"></ha-icon>
          </div>
          <div class="adv-body">
            <div class="section-label">Charging schedule</div>
            <div class="seg" id="segMode">
              <button class="seg-btn" data-val="scheduled">Automatic</button>
              <button class="seg-btn" data-val="manual">Manual</button>
            </div>

            <div class="section-label">Charging control</div>
            <div class="seg" id="segLb">
              <button class="seg-btn" data-val="automatic">Automatic</button>
              <button class="seg-btn" data-val="manual">Manual</button>
            </div>
            <div id="killSwitchNote" class="kill-note" style="display:none;">
              System paused — chargers under manual control (go-e / Shelly app).
              Fuse Guard remains active.
            </div>
          </div>
        </div>
      </ha-card>`;

    this._bindSeg('segMode',     'input_select.ev_charging_mode');
    this._bindSeg('segLb',       'input_select.ev_charging_lb');
    this._bindSeg('segPriority', 'input_select.ev_priority');

    this.querySelector('#advHeader').addEventListener('click', () => {
      this._advUserOpen = !this.querySelector('#advWrap').classList.contains('adv-open');
      this.querySelector('#advWrap').classList.toggle('adv-open');
    });
  }

  _bindSeg(segId, entityId) {
    this.querySelector(`#${segId}`).addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      this._hass.callService('input_select', 'select_option', {
        entity_id: entityId,
        option: btn.dataset.val
      });
    });
  }

  _syncFromHass() {
    const h = this._hass;

    // Update car names in priority control
    const c1Name = h.states[this._car1NameEntity]?.state || 'Car 1';
    const c2Name = h.states[this._car2NameEntity]?.state || 'Car 2';
    const p1 = this.querySelector('#prioCar1');
    const p2 = this.querySelector('#prioCar2');
    if (p1) p1.textContent = c1Name;
    if (p2) p2.textContent = c2Name;

    // Sync all segments
    this._syncSeg('segMode',     h.states['input_select.ev_charging_mode']?.state);
    this._syncSeg('segLb',       h.states['input_select.ev_charging_lb']?.state);
    this._syncSeg('segPriority', h.states['input_select.ev_priority']?.state);

    // Health badge (sensor.ev_system_health): silent when ok — the badge
    // exists to name the worst problem, not to report normality.
    const health = h.states[this._healthEntity];
    const hb = this.querySelector('#healthBadge');
    if (hb) {
      const st = health?.state;
      if (st === 'fault' || st === 'degraded') {
        hb.style.display = '';
        hb.className = 'badge ' + (st === 'fault' ? 'badge-err' : 'badge-warn');
        hb.textContent = health.attributes?.summary || st;
        hb.title = ((health.attributes?.faults || [])
          .concat(health.attributes?.degraded || [])).join('\n');
      } else {
        hb.style.display = 'none';
      }
    }

    // Kill-switch detection: "Charging control" (ev_charging_lb) == manual
    // means the whole smart layer has stood down — the user drives the
    // chargers from the go-e/Shelly app. Show the system-paused note,
    // auto-expand Advanced so the cause is visible, and let the common
    // card broadcast a paused state the car cards grey themselves on.
    // (There is no longer a "Custom" concept — strategy no longer cascades
    // to these controls, so nothing can diverge.)
    const killSwitch = h.states['input_select.ev_charging_lb']?.state === 'manual';
    const note = this.querySelector('#killSwitchNote');
    if (note) note.style.display = killSwitch ? '' : 'none';
    const wrap = this.querySelector('#advWrap');
    if (killSwitch) {
      wrap.classList.add('adv-open');
    } else if (!this._advUserOpen) {
      wrap.classList.remove('adv-open');
    }
  }

  _syncSeg(segId, currentValue) {
    if (currentValue == null) return;
    this.querySelector(`#${segId}`)?.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === currentValue);
    });
  }
}

customElements.define('ev-charging-common-card', EvChargingCommonCard);


// =============================================================================
// ev-charging-car-card
// Shows: car name + status badge, stats (SoC / amps / slot time),
//        charging target (minimal/normal/trip), deadline time picker.
//
// config:
//   car: 1 or 2                             (required)
//   soc_entity: sensor.car1_battery_soc    (required — CHANGE ME to your car's SoC sensor)
//   status_entity: sensor.ev_charging_status  (default)
//   car_name_entity: input_text.ev_car1_name  (default, based on car number)
//   charger1_name: "go-e"                   (default "Charger 1")
//   charger2_name: "TopAC"                  (default "Charger 2")
//   pv_capable_chargers: [1]                (default; chargers able to run PV Eco)
//   pv_forecast_entity: sensor.fmi_pv_remaining_today_kwh  (default)
//   pv_low_kwh: 5                           (default; below this show "low sun" hint)
// =============================================================================
class EvChargingCarCard extends HTMLElement {

  setConfig(config) {
    if (!config.car || ![1, 2].includes(Number(config.car)))
      throw new Error('ev-charging-car-card: set car: 1 or car: 2');
    if (!config.soc_entity)
      throw new Error('ev-charging-car-card: set soc_entity: <entity_id>');
    this._car            = Number(config.car);
    this._socEntity      = config.soc_entity;
    this._statusEntity   = config.status_entity   || 'sensor.ev_charging_status';
    this._carNameEntity  = config.car_name_entity || `input_text.ev_car${this._car}_name`;
    this._chargerNames   = { 1: config.charger1_name || 'Charger 1',
                             2: config.charger2_name || 'Charger 2' };
    this._pvCapable      = config.pv_capable_chargers || [1];
    this._pvForecast     = config.pv_forecast_entity || 'sensor.fmi_pv_remaining_today_kwh';
    this._pvLowKwh       = config.pv_low_kwh != null ? Number(config.pv_low_kwh) : 5;
    this._tpOpen         = false;
    this._snapshot       = {};
  }

  getCardSize() { return 5; }

  set hass(h) {
    this._hass = h;
    if (!this._built) { this._build(); this._built = true; }
    this._syncFromHass();
  }

  _build() {
    const n = this._car;
    this.innerHTML = `
      <ha-card>
        <style>${_EV_CSS}</style>

        <!-- Header: car name + status badge -->
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:22px;font-weight:600;color:var(--primary-text-color);" id="carName">Car ${n}</span>
          <span class="badge badge-off" id="statusBadge">Loading…</span>
        </div>

        <!-- Stats row: SoC / amps / slot time -->
        <div class="status-row">
          <div class="stat">
            <div class="stat-label">
              Battery
            </div>
            <div class="stat-value" id="socVal">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">
              Charging
            </div>
            <div class="stat-value" id="ampVal">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">
              <span id="slotLabel">Next slot</span>
            </div>
            <div class="stat-value" id="slotVal">—</div>
          </div>
        </div>

        <!-- Charger assignment (Phase 1 mapping helpers) -->
        <div class="assign-row" id="assignRow">
          <span>Charger</span>
          <span style="display:flex;align-items:center;gap:2px;">
            <span class="assign-value" id="assignVal">—</span>
            <ha-icon icon="mdi:chevron-right" style="--mdi-icon-size:16px;opacity:0.5;"></ha-icon>
          </span>
        </div>
        <div class="sub-panel" id="assignChooser">
          <div class="panel-header">
            <span class="panel-title">Plugged into</span>
          </div>
          <button class="chooser-btn" id="assignC1"></button>
          <button class="chooser-btn" id="assignC2"></button>
          <button class="chooser-btn" id="assignNone">Not assigned</button>
        </div>

        <hr class="divider">

        <!-- Strategy: Fast (Nord Pool scheduling) / PV Eco (solar surplus).
             Collapsed by default — for a car that lives on a non-PV-capable
             charger there is nothing to choose, and a permanently greyed-out
             PV Eco button is just noise. The header carries the EFFECTIVE
             strategy so it stays verifiable without expanding. -->
        <div id="stratWrap">
          <div class="adv-header" id="stratHeader">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span class="section-label">Strategy</span>
              <span class="strat-effective" id="stratEffective"></span>
            </div>
            <ha-icon icon="mdi:chevron-right" class="adv-chevron"></ha-icon>
          </div>
          <div class="adv-body">
            <div class="seg" id="segStrategy">
              <button class="seg-btn" data-val="fast">&#9889; Fast</button>
              <button class="seg-btn" data-val="pv_eco" id="pvEcoBtn">&#9728;&#65039; PV Eco</button>
            </div>
            <div class="hint-line" id="strategyHint"></div>
          </div>
        </div>

        <!-- Boost: temporary full power, ends at target SoC or timeout -->
        <div style="margin-top:10px;">
          <button class="boost-btn" id="boostBtn">
            <ha-icon icon="mdi:flash" style="--mdi-icon-size:18px;"></ha-icon>
            <span id="boostLabel">Boost</span>
          </button>
        </div>

        <hr class="divider">

        <!-- Charging target -->
        <div class="section-label">Charging Target</div>
        <div class="seg" id="segTarget">
          <button class="seg-btn" data-val="minimal">Minimal</button>
          <button class="seg-btn" data-val="normal">Normal</button>
          <button class="seg-btn" data-val="trip">Trip</button>
        </div>

        <!-- Deadline -->
        <div class="section-label">Deadline</div>
        <div class="deadline-row" id="deadlineRow">
          <div>
            <div class="deadline-time" id="deadlineTime">07:00</div>
            <div class="deadline-hint">Charge ready by</div>
          </div>
          <ha-icon icon="mdi:chevron-right" style="--mdi-icon-size:20px;color:var(--secondary-text-color);opacity:0.5;"></ha-icon>
        </div>

        <!-- Time picker sub-panel (identical to car-heater-card) -->
        <div class="sub-panel" id="timepicker">
          <div class="panel-header">
            ${_evIconBtn('tpCancel', 'mdi:close', 'cancel')}
            <span class="panel-title">Deadline</span>
            ${_evIconBtn('tpSet', 'mdi:check', 'confirm')}
          </div>
          <div class="time-picker-inner">
            <div class="time-spinner">
              <button class="spin-btn" id="hUp">
                <ha-icon icon="mdi:chevron-up" style="--mdi-icon-size:18px;"></ha-icon>
              </button>
              <span class="spin-val" id="hv">07</span>
              <button class="spin-btn" id="hDn">
                <ha-icon icon="mdi:chevron-down" style="--mdi-icon-size:18px;"></ha-icon>
              </button>
            </div>
            <span class="t-colon">:</span>
            <div class="time-spinner">
              <button class="spin-btn" id="mUp">
                <ha-icon icon="mdi:chevron-up" style="--mdi-icon-size:18px;"></ha-icon>
              </button>
              <span class="spin-val" id="mv">00</span>
              <button class="spin-btn" id="mDn">
                <ha-icon icon="mdi:chevron-down" style="--mdi-icon-size:18px;"></ha-icon>
              </button>
            </div>
          </div>
        </div>
      </ha-card>`;

    // Segmented: charging target
    this.querySelector('#segTarget').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      this._hass.callService('input_select', 'select_option', {
        entity_id: `input_select.ev_car${this._car}_mode`,
        option: btn.dataset.val
      });
    });

    // Strategy section collapse toggle. No auto-expand: unlike the common
    // card's Advanced (which pops open on the kill switch), there is no
    // condition here urgent enough to override the user's choice — the
    // header already states the effective strategy.
    this.querySelector('#stratHeader').addEventListener('click', () => {
      this.querySelector('#stratWrap').classList.toggle('adv-open');
    });

    // Segmented: strategy — goes through pyscript ev_apply_strategy, which
    // updates the per-car strategy helper and re-derives (posture summary +
    // phase switch). No mode/LB cascade any more (removed); tapping the
    // already-active option is harmless (re-derive is idempotent).
    this.querySelector('#segStrategy').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.disabled) return;
      this._hass.callService('pyscript', 'ev_apply_strategy', {
        car: this._car,
        strategy: btn.dataset.val
      });
    });

    // Boost: start when idle, cancel when active
    this.querySelector('#boostBtn').addEventListener('click', () => {
      const active = this._hass.states[`input_boolean.ev_car${this._car}_boost`]?.state === 'on';
      this._hass.callService('pyscript', active ? 'ev_boost_cancel' : 'ev_boost_start', {
        car: this._car
      });
    });

    // Charger assignment chooser
    this.querySelector('#assignRow').addEventListener('click', () => {
      this.querySelector('#assignChooser').classList.toggle('open');
    });
    const assign = (chargerN) => {
      const h = this._hass;
      if (chargerN == null) {
        // Clear this car from whichever charger currently holds it
        for (const n of [1, 2]) {
          if (h.states[`input_select.ev_charger${n}_car`]?.state === `Car ${this._car}`) {
            h.callService('input_select', 'select_option', {
              entity_id: `input_select.ev_charger${n}_car`, option: 'None'
            });
          }
        }
      } else {
        // Exclusivity automation clears the other charger if it held this car
        h.callService('input_select', 'select_option', {
          entity_id: `input_select.ev_charger${chargerN}_car`,
          option: `Car ${this._car}`
        });
      }
      this.querySelector('#assignChooser').classList.remove('open');
    };
    this.querySelector('#assignC1').addEventListener('click',   () => assign(1));
    this.querySelector('#assignC2').addEventListener('click',   () => assign(2));
    this.querySelector('#assignNone').addEventListener('click', () => assign(null));

    // Deadline row → open picker
    this.querySelector('#deadlineRow').addEventListener('click', () => this._openTP());

    // Time picker buttons
    this.querySelector('#tpSet').addEventListener('click',    () => this._closeTP(true));
    this.querySelector('#tpCancel').addEventListener('click', () => this._closeTP(false));
    this.querySelector('#hUp').addEventListener('click', () => this._spin('h',  1));
    this.querySelector('#hDn').addEventListener('click', () => this._spin('h', -1));
    this.querySelector('#mUp').addEventListener('click', () => this._spin('m',  1));
    this.querySelector('#mDn').addEventListener('click', () => this._spin('m', -1));
  }

  // ── Sync from HA state ──────────────────────────────────────────────────────

  _syncFromHass() {
    const h = this._hass;
    const n = this._car;

    // Car name
    const name = h.states[this._carNameEntity]?.state;
    if (name) this.querySelector('#carName').textContent = name;

    // SoC — read directly from configured entity
    const socState = h.states[this._socEntity];
    const socVal   = socState?.state;
    const socUnit  = socState?.attributes?.unit_of_measurement || '%';
    this.querySelector('#socVal').textContent =
      (socVal != null && socVal !== 'unavailable') ? socVal + ' ' + socUnit : '—';

    // Status, amps, slot time — from MQTT status sensor
    const statusSensor = h.states[this._statusEntity];
    const carData      = statusSensor?.attributes?.[`car${n}`];
    this._applyStatus(carData);

    // Charging target segmented
    const mode = h.states[`input_select.ev_car${n}_mode`]?.state;
    if (mode) {
      this.querySelector('#segTarget').querySelectorAll('.seg-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.val === mode);
      });
    }

    // Deadline time picker display
    const deadline = h.states[`input_text.ev_car${n}_deadline_time`]?.state;
    if (deadline && deadline !== 'unknown') {
      const [hh, mm] = deadline.split(':');
      this.querySelector('#deadlineTime').textContent = `${hh}:${mm}`;
      // Only update spinner if picker is not open (same pattern as car-heater-card)
      if (!this._tpOpen) {
        this.querySelector('#hv').textContent = hh;
        this.querySelector('#mv').textContent = mm;
      }
    }

    this._syncAssignment();
    this._syncStrategy();
    this._syncBoost();
    this._syncPaused();
  }

  // ── Kill-switch paused state: grey interactive controls IN PLACE ───────
  // "Charging control: Manual" (ev_charging_lb == manual) = the system has
  // stood down; the user drives the chargers from the app. The car's
  // interactive controls are greyed + disabled (visible, so the user still
  // sees the config that will resume), while the status/SoC/amp tiles stay
  // fully visible — the user still wants to SEE state, just can't act.
  _syncPaused() {
    const paused = this._hass.states['input_select.ev_charging_lb']?.state === 'manual';
    // Interactive controls to grey (NOT the stat tiles / status badge).
    ['assignRow', 'assignChooser', 'segStrategy', 'boostBtn',
     'segTarget', 'deadlineRow'].forEach(id => {
      const el = this.querySelector('#' + id);
      if (el) el.classList.toggle('system-paused', paused);
    });
    // A small paused hint on the card (reuse the strategy hint line area if
    // present, else skip silently).
    const hint = this.querySelector('#strategyHint');
    if (hint && paused) {
      hint.textContent = 'System paused — manual control via app';
      hint.classList.add('paused-hint');
    } else if (hint) {
      hint.classList.remove('paused-hint');
    }
  }

  // ── v3: assignment / strategy / boost sync ─────────────────────────────

  // ── MAPPING RESOLVER TWIN v1 (see check_resolver_sync.py) ──
  // Which charger this car is assigned to (null = none). Same rules as
  // the byte-identical JS resolver block in the Node-RED scripts:
  // helper missing/unexpected → legacy mapping (charger N holds car N).
  _myCharger() {
    for (const chargerN of [1, 2]) {
      const s = this._hass.states[`input_select.ev_charger${chargerN}_car`]?.state;
      if (s === `Car ${this._car}`) return chargerN;
      if (s == null && chargerN === this._car) return chargerN;
    }
    return null;
  }

  _syncAssignment() {
    const chargerN = this._myCharger();
    this.querySelector('#assignVal').textContent =
      chargerN != null ? this._chargerNames[chargerN] : 'Not assigned';

    // Chooser labels + current highlight
    const b1 = this.querySelector('#assignC1');
    const b2 = this.querySelector('#assignC2');
    const bn = this.querySelector('#assignNone');
    b1.textContent = this._chargerNames[1];
    b2.textContent = this._chargerNames[2];
    b1.classList.toggle('current', chargerN === 1);
    b2.classList.toggle('current', chargerN === 2);
    bn.classList.toggle('current', chargerN == null);
  }

  // Name(s) of the PV-capable charger(s), for "PV Eco needs X" messaging.
  // Derived from _pvCapable rather than hardcoding charger 1, so a second
  // go-e ({1} → {1,2}) reads correctly with no further change.
  _pvChargerLabel() {
    return this._pvCapable.map(cn => this._chargerNames[cn]).join(' or ');
  }

  _syncStrategy() {
    const h = this._hass;
    const n = this._car;
    const strategy = h.states[`input_select.ev_car${n}_strategy`]?.state || 'fast';
    const chargerN = this._myCharger();
    const capable  = chargerN != null && this._pvCapable.includes(chargerN);
    const honoured = capable && strategy === 'pv_eco';

    this.querySelector('#segStrategy').querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === strategy);
    });

    // PV Eco selectable only on a PV-capable charger. The stated intent
    // (strategy helper) persists even when it can't be honoured — the hint
    // explains the gap instead of silently resetting the user's choice.
    // Resetting it would be worse than it looks: a car swapped onto the
    // TopAC and back would silently lose PV Eco and charge from the grid on
    // the next sunny day. Intent survives; the display tells the truth.
    const pvBtn = this.querySelector('#pvEcoBtn');
    pvBtn.disabled = !capable && strategy !== 'pv_eco';

    // Collapsed-header chip: the EFFECTIVE strategy (what the car will
    // actually do), not the stored intent. This is what lets the section
    // stay collapsed without hiding anything that matters.
    const eff = this.querySelector('#stratEffective');
    if (eff) {
      if (honoured) {
        eff.textContent = '\u2600\uFE0F PV Eco';
        eff.classList.remove('unmet');
      } else if (strategy === 'pv_eco') {
        // Intent is PV Eco but this charger can't honour it → the car is on
        // Fast. Say so, and why, right in the header.
        eff.textContent = chargerN == null
          ? '\u26A1 Fast (no charger)'
          : `\u26A1 Fast (PV Eco needs ${this._pvChargerLabel()})`;
        eff.classList.add('unmet');
      } else {
        eff.textContent = '\u26A1 Fast';
        eff.classList.remove('unmet');
      }
    }

    const hint = this.querySelector('#strategyHint');
    if (strategy === 'pv_eco' && !capable) {
      hint.textContent = chargerN == null
        ? 'Charging fast — no charger assigned'
        : `Charging fast — PV Eco needs ${this._pvChargerLabel()}`;
    } else if (strategy === 'pv_eco') {
      // Solar expectation at the moment of choice (FMI forecast)
      const fc = Number(h.states[this._pvForecast]?.state);
      if (Number.isFinite(fc)) {
        hint.textContent = fc < this._pvLowKwh
          ? `Low sun today (~${fc.toFixed(1)} kWh left) — charging may be slow`
          : `~${fc.toFixed(0)} kWh solar remaining today`;
      } else {
        hint.textContent = '';
      }
    } else if (!capable && chargerN != null) {
      hint.textContent = `PV Eco needs ${this._pvChargerLabel()}`;
    } else {
      hint.textContent = '';
    }
  }

  _syncBoost() {
    const h = this._hass;
    const n = this._car;
    const active = h.states[`input_boolean.ev_car${n}_boost`]?.state === 'on';
    const btn    = this.querySelector('#boostBtn');
    const label  = this.querySelector('#boostLabel');

    btn.classList.toggle('active', active);
    if (active) {
      const until = h.states[`input_datetime.ev_car${n}_boost_until`]?.state || '';
      const hhmm  = until.length >= 16 ? until.slice(11, 16) : '';
      label.textContent = hhmm
        ? `Boosting — until ${hhmm} or target · tap to cancel`
        : 'Boosting — tap to cancel';
    } else {
      const hours = Number(h.states['input_number.ev_boost_duration_hours']?.state);
      label.textContent = Number.isFinite(hours)
        ? `Boost — full power, max ${hours} h`
        : 'Boost — full power';
    }
  }

  _applyStatus(carData) {
    const badge      = this.querySelector('#statusBadge');
    const ampEl      = this.querySelector('#ampVal');
    const slotEl     = this.querySelector('#slotVal');
    const slotLblEl  = this.querySelector('#slotLabel');

    if (!carData) {
      badge.className   = 'badge badge-off';
      badge.textContent = 'Loading…';
      ampEl.textContent = slotEl.textContent = '—';
      slotLblEl.textContent = 'Next slot';
      return;
    }

    // Badge
    const cls = carData.badge === 'ok'   ? 'badge-ok'   :
                carData.badge === 'err'  ? 'badge-err'  :
                carData.badge === 'warn' ? 'badge-warn' : 'badge-off';
    badge.className   = `badge ${cls}`;
    badge.textContent = carData.status || '—';

    // Allocated amps
    const amp = carData.allocated_amp;
    ampEl.textContent = (amp != null && amp > 0) ? amp + ' A' : '—';

    // Slot time (Until / From / —)
    slotEl.textContent    = carData.slot_time  || '—';
    slotLblEl.textContent = carData.slot_label || 'Next slot';
  }

  // ── Time picker (identical interaction to car-heater-card) ──────────────────

  _openTP() {
    this._tpOpen = true;
    // Snapshot current spinner values for cancel
    this._snapshot = {
      hh: this.querySelector('#hv').textContent,
      mm: this.querySelector('#mv').textContent
    };
    this.querySelector('#timepicker').classList.add('open');
  }

  _closeTP(save) {
    if (save) {
      const h = parseInt(this.querySelector('#hv').textContent) || 0;
      const m = parseInt(this.querySelector('#mv').textContent) || 0;
      const time = `${_evPad(h)}:${_evPad(m)}`;
      this._hass.callService('input_text', 'set_value', {
        entity_id: `input_text.ev_car${this._car}_deadline_time`,
        value: time
      });
      this.querySelector('#deadlineTime').textContent = time;
    } else {
      // Restore snapshot on cancel
      if (this._snapshot.hh !== undefined) {
        this.querySelector('#hv').textContent = this._snapshot.hh;
        this.querySelector('#mv').textContent = this._snapshot.mm;
      }
    }
    this._tpOpen = false;
    this.querySelector('#timepicker').classList.remove('open');
  }

  _spin(part, dir) {
    const el  = this.querySelector(part === 'h' ? '#hv' : '#mv');
    let   val = parseInt(el.textContent) || 0;
    if (part === 'h') val = (val + dir + 24) % 24;
    else              val = (val + dir * 5 + 60) % 60;
    el.textContent = _evPad(val);
  }
}

customElements.define('ev-charging-car-card', EvChargingCarCard);

// =============================================================================
// ev-charging-settings-card
// Advanced settings: super cheap threshold and per-car SoC targets.
//
// Uses a reusable spinner-picker pattern — the same sub-panel expand/confirm
// interaction as the deadline time picker, but generalised to any numeric
// value with configurable step and decimal precision.
//
// Adding a new setting in future: add one entry to this._pickerDefs in
// setConfig(). No other changes needed.
//
// config:
//   car1_name_entity: input_text.ev_car1_name   (default)
//   car2_name_entity: input_text.ev_car2_name   (default)
// =============================================================================

const _EV_SETTINGS_CSS = `
  /* ── Setting rows ── */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    cursor: pointer;
    border-radius: 6px;
    transition: opacity 0.1s;
    user-select: none;
  }
  .setting-row:active { opacity: 0.65; }
  .setting-label { font-size:15px; color:var(--primary-text-color); }
  .setting-right { display:flex; align-items:center; gap:2px; }
  .setting-value { font-size:15px; font-weight:600; color:var(--secondary-text-color); }

  /* ── Single-spinner picker ── */
  .picker-single {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
  }
  .picker-unit {
    font-size: 20px;
    font-weight: 500;
    color: var(--secondary-text-color);
    min-width: 48px;
  }
`;

class EvChargingSettingsCard extends HTMLElement {

  setConfig(config) {
    this._config         = config;
    this._car1NameEntity = config.car1_name_entity || 'input_text.ev_car1_name';
    this._car2NameEntity = config.car2_name_entity || 'input_text.ev_car2_name';
    this._activePickerId = null;
    this._snapshot       = null;
    this._pickerVal      = {};   // pickerId → current value staged in the spinner

    // ── Picker definitions ──────────────────────────────────────────────────
    // Each entry produces one tappable setting row with an expandable spinner.
    //   section:  'price' | 'boost' | 'car1' | 'car2'
    //   step:     spinner increment (10 for SoC, 0.1 for price)
    //   decimals: display decimal places (0 for SoC, 1 for price)
    // ────────────────────────────────────────────────────────────────────────
    this._pickerDefs = [
      { id: 'threshold', section: 'price', label: 'Super Cheap',
        entity:   'input_number.ev_super_cheap_threshold',
        step: 0.1, min: -10, max: 100, unit: 'c/kWh', decimals: 1 },

      { id: 'boostdur', section: 'boost', label: 'Duration',
        entity:   'input_number.ev_boost_duration_hours',
        step: 0.5, min: 0.5, max: 12, unit: 'h', decimals: 1 },

      { id: 'c1min', section: 'car1', label: 'Minimal',
        entity:   'input_number.ev_car1_target_soc_minimal',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },
      { id: 'c1nor', section: 'car1', label: 'Normal',
        entity:   'input_number.ev_car1_target_soc_normal',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },
      { id: 'c1trp', section: 'car1', label: 'Trip',
        entity:   'input_number.ev_car1_target_soc_trip',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },

      { id: 'c2min', section: 'car2', label: 'Minimal',
        entity:   'input_number.ev_car2_target_soc_minimal',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },
      { id: 'c2nor', section: 'car2', label: 'Normal',
        entity:   'input_number.ev_car2_target_soc_normal',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },
      { id: 'c2trp', section: 'car2', label: 'Trip',
        entity:   'input_number.ev_car2_target_soc_trip',
        step: 10,  min: 10,  max: 100, unit: '%', decimals: 0 },
    ];
  }

  getCardSize() { return 8; }

  set hass(h) {
    this._hass = h;
    if (!this._built) { this._build(); this._built = true; }
    this._syncFromHass();
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  _build() {
    // Section metadata: order, default label, optional element ID for dynamic name
    const SECTIONS = [
      { key: 'price', label: 'Price',  nameId: null        },
      { key: 'boost', label: 'Boost',  nameId: null        },
      { key: 'car1',  label: 'Car 1',  nameId: 'sec-car1'  },
      { key: 'car2',  label: 'Car 2',  nameId: 'sec-car2'  },
    ];

    let html = `
      <ha-card>
        <style>${_EV_CSS}${_EV_SETTINGS_CSS}</style>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
          <span style="font-size:22px;font-weight:600;color:var(--primary-text-color);">Charging Settings</span>
          <ha-icon icon="mdi:tune" style="--mdi-icon-size:22px;color:var(--secondary-text-color);opacity:0.5;"></ha-icon>
        </div>`;

    let firstSection = true;
    for (const sec of SECTIONS) {
      const defs = this._pickerDefs.filter(d => d.section === sec.key);
      if (!defs.length) continue;
      if (!firstSection) html += `<hr class="divider">`;
      firstSection = false;
      const idAttr = sec.nameId ? `id="${sec.nameId}"` : '';
      html += `<div class="section-label" ${idAttr}>${sec.label}</div>`;
      for (const def of defs) html += this._rowHTML(def);
    }

    html += `</ha-card>`;
    this.innerHTML = html;

    // Bind click events for every picker row and its sub-panel buttons
    for (const def of this._pickerDefs) {
      this.querySelector(`#row-${def.id}`)
          .addEventListener('click', () => this._openPicker(def.id));
      this.querySelector(`#btn-up-${def.id}`)
          .addEventListener('click', e => { e.stopPropagation(); this._spin(def.id,  1); });
      this.querySelector(`#btn-dn-${def.id}`)
          .addEventListener('click', e => { e.stopPropagation(); this._spin(def.id, -1); });
      this.querySelector(`#btn-ok-${def.id}`)
          .addEventListener('click', e => { e.stopPropagation(); this._closePicker(true); });
      this.querySelector(`#btn-cx-${def.id}`)
          .addEventListener('click', e => { e.stopPropagation(); this._closePicker(false); });
    }
  }

  // Build HTML for one setting row + its collapsible spinner sub-panel.
  // Reuse _EV_CSS sub-panel, panel-header, spin-btn and spin-val classes
  // so the visual behaviour is identical to the deadline time picker.
  _rowHTML(def) {
    return `
      <div class="setting-row" id="row-${def.id}">
        <span class="setting-label">${def.label}</span>
        <div class="setting-right">
          <span class="setting-value" id="val-${def.id}">—</span>
          <ha-icon icon="mdi:chevron-right"
                   style="--mdi-icon-size:18px;color:var(--secondary-text-color);opacity:0.4;margin-left:2px;">
          </ha-icon>
        </div>
      </div>
      <div class="sub-panel" id="panel-${def.id}">
        <div class="panel-header">
          ${_evIconBtn(`btn-cx-${def.id}`, 'mdi:close', 'cancel')}
          <span class="panel-title">${def.label}</span>
          ${_evIconBtn(`btn-ok-${def.id}`, 'mdi:check', 'confirm')}
        </div>
        <div class="picker-single">
          <div class="time-spinner">
            <button class="spin-btn" id="btn-up-${def.id}">
              <ha-icon icon="mdi:chevron-up" style="--mdi-icon-size:18px;"></ha-icon>
            </button>
            <span class="spin-val" id="sv-${def.id}" style="min-width:80px;">—</span>
            <button class="spin-btn" id="btn-dn-${def.id}">
              <ha-icon icon="mdi:chevron-down" style="--mdi-icon-size:18px;"></ha-icon>
            </button>
          </div>
          <span class="picker-unit">${def.unit}</span>
        </div>
      </div>`;
  }

  // ── Sync from HA state ──────────────────────────────────────────────────────

  _syncFromHass() {
    const h = this._hass;

    // Update car section headings from name helpers
    const c1 = h.states[this._car1NameEntity]?.state || 'Car 1';
    const c2 = h.states[this._car2NameEntity]?.state || 'Car 2';
    const s1 = this.querySelector('#sec-car1');
    const s2 = this.querySelector('#sec-car2');
    if (s1) s1.textContent = c1;
    if (s2) s2.textContent = c2;

    // Update every row's displayed value from HA
    for (const def of this._pickerDefs) {
      const raw = Number(h.states[def.entity]?.state);
      if (!Number.isFinite(raw)) continue;
      // Display value
      this.querySelector(`#val-${def.id}`).textContent =
        `${this._fmt(raw, def)} ${def.unit}`;
      // Keep spinner in sync if its panel is not currently open
      if (this._activePickerId !== def.id) {
        this._pickerVal[def.id] = raw;
      }
    }
  }

  // ── Picker lifecycle ────────────────────────────────────────────────────────

  _openPicker(id) {
    // Quietly cancel any open picker before opening a new one
    if (this._activePickerId && this._activePickerId !== id) {
      this._closePicker(false);
    }
    this._activePickerId = id;

    const def = this._pickerDefs.find(d => d.id === id);
    const raw = Number(this._hass.states[def.entity]?.state);
    const val = Number.isFinite(raw) ? this._snapToStep(raw, def) : def.min;

    this._pickerVal[id] = val;
    this._snapshot      = val;
    this._updateSpinner(id);
    this.querySelector(`#panel-${id}`).classList.add('open');
  }

  _closePicker(save) {
    const id = this._activePickerId;
    if (!id) return;

    const def = this._pickerDefs.find(d => d.id === id);

    if (save) {
      const val = this._pickerVal[id];
      this._hass.callService('input_number', 'set_value', {
        entity_id: def.entity,
        value:     val
      });
      // Optimistic row display update — HA will confirm on next hass cycle
      this.querySelector(`#val-${id}`).textContent = `${this._fmt(val, def)} ${def.unit}`;
    } else {
      // Restore to the value that was showing when the panel opened
      if (this._snapshot !== null) {
        this._pickerVal[id] = this._snapshot;
        this._updateSpinner(id);
      }
    }

    this.querySelector(`#panel-${id}`).classList.remove('open');
    this._activePickerId = null;
    this._snapshot       = null;
  }

  // ── Spinner mechanics ───────────────────────────────────────────────────────

  _spin(id, dir) {
    const def = this._pickerDefs.find(d => d.id === id);
    let val = this._pickerVal[id] ?? def.min;
    // Multiply/divide by 1000 to avoid floating-point drift (e.g. 0.1 + 0.2)
    val = Math.round((val + dir * def.step) * 1000) / 1000;
    val = Math.max(def.min, Math.min(def.max, val));
    this._pickerVal[id] = val;
    this._updateSpinner(id);
  }

  _updateSpinner(id) {
    const def = this._pickerDefs.find(d => d.id === id);
    const val = this._pickerVal[id] ?? def.min;
    this.querySelector(`#sv-${id}`).textContent = this._fmt(val, def);
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  // Format a numeric value for display (spinner and row)
  _fmt(val, def) {
    return def.decimals > 0 ? val.toFixed(def.decimals) : String(Math.round(val));
  }

  // Snap an arbitrary HA value to the nearest valid step
  _snapToStep(val, def) {
    const steps = Math.round((val - def.min) / def.step);
    const snapped = def.min + steps * def.step;
    return Math.round(Math.max(def.min, Math.min(def.max, snapped)) * 1000) / 1000;
  }
}

customElements.define('ev-charging-settings-card', EvChargingSettingsCard);

// =============================================================================
// ev-charging-plan-card
// Compact summary of the computed charging plan for one car, styled to match
// the stat tiles in ev-charging-car-card.
//
// Reads sensor.ev_charging_schedule attributes (published by the Node-RED
// Status/HA Formatter pipeline) — the same data the ApexCharts card uses.
//
// Layout (3-column grid, 1+2 / 1+2):
//   Row 1:  Slots        | Total time (wide)
//   Row 2:  Average c/kWh | Price range (wide)
//
// config:
//   car: 1 or 2                                  (required)
//   schedule_entity: sensor.ev_charging_schedule (default)
//   car_name_entity: input_text.ev_carN_name     (default, by car number)
// =============================================================================

const _EV_PLAN_CSS = `
  .plan-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 10px 0 4px;
  }
  .stat-wide { grid-column: span 2; }
`;

class EvChargingPlanCard extends HTMLElement {

  setConfig(config) {
    if (!config.car || ![1, 2].includes(Number(config.car)))
      throw new Error('ev-charging-plan-card: set car: 1 or car: 2');
    this._car             = Number(config.car);
    this._scheduleEntity  = config.schedule_entity || 'sensor.ev_charging_schedule';
    this._carNameEntity   = config.car_name_entity || `input_text.ev_car${this._car}_name`;
  }

  getCardSize() { return 3; }

  set hass(h) {
    this._hass = h;
    if (!this._built) { this._build(); this._built = true; }
    this._syncFromHass();
  }

  _build() {
    this.innerHTML = `
      <ha-card>
        <style>${_EV_CSS}${_EV_PLAN_CSS}</style>

        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:22px;font-weight:600;color:var(--primary-text-color);" id="planCarName">Car ${this._car}</span>
          <ha-icon icon="mdi:calendar-clock" style="--mdi-icon-size:22px;color:var(--secondary-text-color);opacity:0.5;"></ha-icon>
        </div>

        <div class="section-label">Charging Plan</div>

        <div class="plan-row">
          <div class="stat">
            <div class="stat-label">
              Slots
            </div>
            <div class="stat-value" id="planSlots">—</div>
          </div>
          <div class="stat stat-wide">
            <div class="stat-label">
              Total time
            </div>
            <div class="stat-value" id="planTime">—</div>
          </div>
        </div>

        <div class="plan-row">
          <div class="stat">
            <div class="stat-label">
              Average
            </div>
            <div class="stat-value" id="planAvg">—</div>
          </div>
          <div class="stat stat-wide">
            <div class="stat-label">
              Price (from–to)
            </div>
            <div class="stat-value" id="planPrice">—</div>
          </div>
        </div>
      </ha-card>`;
  }

  _syncFromHass() {
    const h = this._hass;
    const n = this._car;

    // Car name
    const name = h.states[this._carNameEntity]?.state;
    if (name && name !== 'unknown' && name !== 'unavailable') {
      this.querySelector('#planCarName').textContent = name;
    }

    const data = h.states[this._scheduleEntity]?.attributes?.[`car${n}`];
    const slotsEl = this.querySelector('#planSlots');
    const timeEl  = this.querySelector('#planTime');
    const avgEl   = this.querySelector('#planAvg');
    const priceEl = this.querySelector('#planPrice');

    if (!data || !Array.isArray(data.timestamps)) {
      slotsEl.textContent = timeEl.textContent = avgEl.textContent = priceEl.textContent = '—';
      return;
    }

    // Aggregate over future scheduled slots only
    let count = 0;
    const prices = [];
    for (let i = 0; i < data.timestamps.length; i++) {
      if (data.allowed[i] === 1 && data.status[i] !== 'past') {
        count++;
        prices.push(data.prices[i]);
      }
    }

    if (count === 0) {
      slotsEl.textContent = '0';
      timeEl.textContent  = 'Not charging';
      avgEl.textContent   = '—';
      priceEl.textContent = '—';
      return;
    }

    // Slots
    slotsEl.textContent = String(count);

    // Total time — slots are 15 min each
    const totalMin = count * 15;
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    timeEl.textContent = hh > 0 ? `${hh} h ${mm} min` : `${mm} min`;

    // Average price
    const avg = prices.reduce((a, b) => a + b, 0) / count;
    avgEl.textContent = `${avg.toFixed(2)} c/kWh`;

    // Price range
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    priceEl.textContent = (min === max)
      ? `${min.toFixed(2)} c/kWh`
      : `${min.toFixed(2)}–${max.toFixed(2)} c/kWh`;
  }
}

customElements.define('ev-charging-plan-card', EvChargingPlanCard);
