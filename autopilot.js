// autopilot.js — simple autopilot module for WebFS2025
// Exports: attach, init, update, dispose
// Features:
//  - Altitude hold (ALT) with capture and simple P-controller
//  - Heading hold (HDG) with simple turn-rate control
//  - Basic VNAV stub: follow target altitude and nominal climb/descent rate
//  - UI wiring: toggles via #autopilotBtn and simple keyboard shortcuts (P toggles AP)
// Depends on: main.js App, CONFIG, U, and ui.js for HUD display (optional)

let App, CONFIG, U;
let elems = {};
let state = {
  enabled: false,
  mode: { alt: false, hdg: false, vnav: false },
  targetAltM: null,
  targetHdgDeg: null,
  captureToleranceM: 10,
  altRateMps: 5.0, // default climb/descent target when VNAV active
  hdgTurnRateRadPerS: (Math.PI / 180) * 3.5, // ~3.5 deg/s nominal
  pid: { Kp: 0.6, Ki: 0.0, Kd: 0.12, integral: 0, lastErr: 0 }
};

// Attach references
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

// Init: wire UI button and set defaults
export function init() {
  elems.autopilotBtn = document.getElementById('autopilotBtn');
  if (elems.autopilotBtn) elems.autopilotBtn.addEventListener('click', toggleAP);

  // Keyboard shortcut: "p" toggles autopilot
  window.addEventListener('keydown', onKeyDown);

  // default target altitude = current altitude rounded to 100 ft
  state.targetAltM = App.heightM || 0;
  state.targetHdgDeg = Math.round((U.rad2deg(App.heading || 0) + 360) % 360);

  // Initialize autopilot object on App for other modules to query
  App.autopilot = {
    enabled: () => state.enabled,
    engage: () => engageAll(),
    disengage: () => disengageAll(),
    setAltitudeMeters: (m) => { state.targetAltM = m; state.mode.alt = true; },
    setHeadingDeg: (d) => { state.targetHdgDeg = ((d % 360) + 360) % 360; state.mode.hdg = true; }
  };
}

// Update loop: called each frame with dt seconds
export function update(_app, dt) {
  if (!App) return;

  // If autopilot not enabled, do nothing
  if (!state.enabled) return;

  // ALT mode: simple PID on altitude -> pitch command
  if (state.mode.alt) {
    const err = (state.targetAltM - App.heightM);
    // integrate with windup guard
    state.pid.integral += err * dt;
    state.pid.integral = U.clamp(state.pid.integral, -200, 200);
    const deriv = (err - state.pid.lastErr) / Math.max(dt, 1e-6);
    state.pid.lastErr = err;

    const pitchCmd = (state.pid.Kp * err + state.pid.Ki * state.pid.integral + state.pid.Kd * deriv) * 0.001;
    // apply gentle pitch toward command (limit rate)
    const maxPitchRate = CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75;
    const applied = U.clamp(pitchCmd, -maxPitchRate * dt * 4, maxPitchRate * dt * 4);
    App.pitch += applied;
    App.pitch = U.clamp(App.pitch, -Math.PI / 6, Math.PI / 6);

    // If within tolerance and near zero vertical speed, consider captured
    if (Math.abs(err) <= state.captureToleranceM && Math.abs(App.vSpeedMS) < 1.0) {
      // hold level: zero small pitch nudges
      // reduce integral slowly
      state.pid.integral *= 0.98;
    }
  }

  // HDG mode: compute shortest angular difference and apply heading change via yaw/heading
  if (state.mode.hdg && Number.isFinite(state.targetHdgDeg)) {
    const currentDeg = (U.rad2deg(App.heading) + 360) % 360;
    let diff = ((state.targetHdgDeg - currentDeg + 540) % 360) - 180; // -180..180
    // desired turn rate scales with diff, capped by hdgTurnRateRadPerS
    const desiredRateDegPerS = U.clamp(diff, -45, 45) * 0.12; // scale factor for responsiveness
    const desiredRateRad = U.deg2rad(desiredRateDegPerS);
    // integrate into heading
    App.heading += U.clamp(desiredRateRad * dt, -state.hdgTurnRateRadPerS * dt, state.hdgTurnRateRadPerS * dt);
    // small roll bank to simulate turn visually (max ~15 degrees)
    const bankTarget = U.clamp(U.deg2rad(diff * 0.25), -U.deg2rad(15), U.deg2rad(15));
    // smooth roll toward bankTarget
    App.roll += (bankTarget - App.roll) * U.clamp(6 * dt, 0, 1);
  }

  // VNAV: if active, set alt mode target and small throttle adjustments (simple)
  if (state.mode.vnav) {
    // VNAV aims for targetAltM using fixed altRateMps
    const altErr = state.targetAltM - App.heightM;
    const climbSign = Math.sign(altErr);
    // if within tolerance, disable vertical VNAV action
    if (Math.abs(altErr) > state.captureToleranceM) {
      // nudge pitch slightly based on climb sign (small)
      App.pitch += U.clamp(climbSign * 0.002 * dt * 60, -0.01, 0.01);
      // slightly adjust thrust toward climb/cruise
      if (climbSign > 0) App.thrustInput = U.clamp01((App.thrustInput || 0) + 0.0008 * dt * 60);
      else App.thrustInput = U.clamp01((App.thrustInput || 0) - 0.0006 * dt * 60);
    }
  }

  // Safety: if large bank or pitch while on ground, disengage AP
  if (App.onGround && (Math.abs(App.roll) > U.deg2rad(5) || Math.abs(App.pitch) > U.deg2rad(3))) {
    disengageAll();
  }

  // Update autopilot button label if present
  if (elems.autopilotBtn) {
    elems.autopilotBtn.textContent = state.enabled ? `Autopilot: ON` : `Autopilot: OFF`;
  }
}

// Dispose: remove listeners
export function dispose() {
  if (elems.autopilotBtn) elems.autopilotBtn.removeEventListener('click', toggleAP);
  window.removeEventListener('keydown', onKeyDown);
}

// -----------------
// Helpers & UI
// -----------------
function toggleAP() {
  if (state.enabled) disengageAll();
  else engageAll();
}

function engageAll() {
  state.enabled = true;
  // by default enable ALT and HDG hold using current values
  state.mode.alt = true;
  state.mode.hdg = true;
  state.mode.vnav = false;
  state.targetAltM = App.heightM || state.targetAltM || 0;
  state.targetHdgDeg = Math.round((U.rad2deg(App.heading) + 360) % 360);
  state.pid.integral = 0;
  state.pid.lastErr = 0;
  if (elems.autopilotBtn) elems.autopilotBtn.textContent = 'Autopilot: ON';
}

function disengageAll() {
  state.enabled = false;
  state.mode.alt = false;
  state.mode.hdg = false;
  state.mode.vnav = false;
  if (elems.autopilotBtn) elems.autopilotBtn.textContent = 'Autopilot: OFF';
}

// Keyboard shortcuts
function onKeyDown(e) {
  if (e.key.toLowerCase() === 'p') {
    toggleAP();
  }
  // ALT+ and ALT- to change target altitude (simple)
  if (e.key === '+' || e.key === '=' ) {
    if (state.mode.alt) { state.targetAltM += 100 * 0.3048; } // +100 ft -> meters
  }
  if (e.key === '-' || e.key === '_') {
    if (state.mode.alt) { state.targetAltM -= 100 * 0.3048; }
  }
}
