// controls.js — input handling for WebFS2025
// Exports: attach, init, update, dispose
// Integrates joystick, throttle, and keyboard with App state
// Expects DOM elements from index.html: joystick, stick, throttleSlider

let App, CONFIG, U;
let elems = {};
let pointers = { dragging: false, pointerId: null, center: { x: 0, y: 0 }, radius: 40 };
let lastThrottleValue = 0;
let keyboardRepeat = {};

// Attach references from main
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

// Initialize DOM wiring and defaults
export function init() {
  // Cache elements (safe if missing)
  elems.joystick = document.getElementById('joystick');
  elems.stick = document.getElementById('stick');
  elems.throttle = document.getElementById('throttleSlider');

  // Setup joystick if present
  if (elems.joystick && elems.stick) {
    setupJoystick();
    window.addEventListener('resize', updateJoystickCenter);
    updateJoystickCenter();
  }

  // Setup throttle if present
  if (elems.throttle) {
    setupThrottle();
    // initialize App.thrustInput from slider
    lastThrottleValue = Number(elems.throttle.value || 0);
    App.thrustInput = lastThrottleValue / 100;
  }

  // Keyboard handling (pitch/roll/yaw/thrust)
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// Per-frame update (called by main loop)
export function update(_app, dt) {
  // Apply keyboard continuous inputs (if keys held)
  applyKeyboard(dt);

  // Optional smoothing on thrust to avoid abrupt changes
  if (typeof App.thrustInput === 'number') {
    // Smooth toward slider value (lastThrottleValue/100) for nicer acceleration
    const target = lastThrottleValue / 100;
    const alpha = Math.min(1, 6 * dt); // ~6s ramp if extreme, but responsive
    App.thrustInput += (target - App.thrustInput) * alpha;
    App.thrustInput = U.clamp01(App.thrustInput);
  } else {
    App.thrustInput = 0;
  }

  // Limit attitude rates to configured maxs
  const maxRoll = CONFIG.PHYSICS?.MAX_BANK_RATE ?? 0.9;
  const maxPitch = CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75;
  const maxYaw = CONFIG.PHYSICS?.MAX_YAW_RATE ?? 0.9;

  // Clamp rates
  App.roll = U.clamp(App.roll, -Math.PI, Math.PI);
  App.pitch = U.clamp(App.pitch, -Math.PI/2, Math.PI/2);
  App.heading = ((App.heading % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
}

// Cleanup
export function dispose() {
  if (elems.joystick && elems.stick) {
    elems.joystick.removeEventListener('pointerdown', joystickPointerDown);
    window.removeEventListener('pointermove', joystickPointerMove);
    window.removeEventListener('pointerup', joystickPointerUp);
    window.removeEventListener('pointercancel', joystickPointerUp);
  }
  if (elems.throttle) {
    elems.throttle.removeEventListener('input', onThrottleInput);
  }
  window.removeEventListener('resize', updateJoystickCenter);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}

// ---------------------
// Joystick implementation
// ---------------------
function updateJoystickCenter() {
  if (!elems.joystick) return;
  const r = elems.joystick.getBoundingClientRect();
  pointers.center.x = r.left + r.width / 2;
  pointers.center.y = r.top + r.height / 2;
  pointers.radius = Math.max(24, Math.min(r.width, r.height) / 2 - 12);
  // center stick visually
  if (elems.stick) {
    elems.stick.style.left = `${Math.round(r.width/2 - 10)}px`;
    elems.stick.style.top = `${Math.round(r.height/2 - 10)}px`;
  }
}

function setupJoystick() {
  elems.joystick.style.touchAction = 'none';
  elems.joystick.addEventListener('pointerdown', joystickPointerDown);
  // global pointer handlers
  window.addEventListener('pointermove', joystickPointerMove);
  window.addEventListener('pointerup', joystickPointerUp);
  window.addEventListener('pointercancel', joystickPointerUp);
}

function joystickPointerDown(e) {
  if (pointers.dragging) return;
  pointers.dragging = true;
  pointers.pointerId = e.pointerId;
  elems.joystick.setPointerCapture && elems.joystick.setPointerCapture(e.pointerId);
  handleJoystickMove(e.clientX, e.clientY);
}

function joystickPointerMove(e) {
  if (!pointers.dragging || e.pointerId !== pointers.pointerId) return;
  handleJoystickMove(e.clientX, e.clientY);
}

function joystickPointerUp(e) {
  if (!pointers.dragging || e.pointerId !== pointers.pointerId) return;
  pointers.dragging = false;
  pointers.pointerId = null;
  // release capture
  elems.joystick.releasePointerCapture && elems.joystick.releasePointerCapture(e.pointerId);
  // reset visual stick to center
  if (elems.joystick && elems.stick) {
    const r = elems.joystick.getBoundingClientRect();
    elems.stick.style.left = `${Math.round(r.width/2 - 10)}px`;
    elems.stick.style.top = `${Math.round(r.height/2 - 10)}px`;
  }
}

// Translate pointer coords into pitch/roll commands
function handleJoystickMove(clientX, clientY) {
  if (!elems.joystick || !elems.stick) return;
  const dx = clientX - pointers.center.x;
  const dy = clientY - pointers.center.y;
  const dist = Math.hypot(dx, dy);
  const max = pointers.radius;
  const clamped = Math.min(dist, max);
  const ang = Math.atan2(dy, dx);

  // position stick visually relative to joystick element
  const xPos = Math.cos(ang) * clamped;
  const yPos = Math.sin(ang) * clamped;
  const r = elems.joystick.getBoundingClientRect();
  elems.stick.style.left = `${Math.round(r.width/2 + xPos - 10)}px`;
  elems.stick.style.top = `${Math.round(r.height/2 + yPos - 10)}px`;

  // normalized controls (-1..1)
  const nx = (Math.cos(ang) * clamped) / max;
  const ny = (Math.sin(ang) * clamped) / max;

  // apply exponential curve for finer control near center
  const expo = (v, e = 0.5) => Math.sign(v) * (Math.abs(v) ** (1 + e));

  const rollCmd = expo(nx, 0.5);   // left/right
  const pitchCmd = -expo(ny, 0.5); // up/down (invert so pushing up pitches down if desired)

  // scale commands to rates
  const rollRate = (CONFIG.PHYSICS?.MAX_BANK_RATE ?? 0.9) * 0.6;
  const pitchRate = (CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75) * 0.6;

  // integrate into App state (small increments)
  App.roll += rollCmd * rollRate * (1/60);  // assume joystick moves per-frame; safe small step
  App.pitch += pitchCmd * pitchRate * (1/60);

  // clamp to reasonable ranges
  App.roll = U.clamp(App.roll, -Math.PI/2, Math.PI/2);
  App.pitch = U.clamp(App.pitch, -Math.PI/3, Math.PI/3);
}

// ---------------------
// Throttle implementation
// ---------------------
function setupThrottle() {
  elems.throttle.style.writingMode = 'vertical-lr';
  elems.throttle.style.direction = 'rtl';
  elems.throttle.addEventListener('input', onThrottleInput, { passive: true });
  // set initial value if missing
  if (!elems.throttle.value) elems.throttle.value = '0';
  lastThrottleValue = Number(elems.throttle.value || 0);
  App.thrustInput = lastThrottleValue / 100;
}

function onThrottleInput(e) {
  const v = Number(e.target.value || 0);
  lastThrottleValue = U.clamp(v, 0, 100);
  // map slider to realistic detents (simple)
  // 0-4: REV/idle -> 0, 5-25: idle -> 0.05, 26-60: climb -> 0.5, 61-80: climb MCT -> 0.8, 81-100: TOGA -> 1.0
  let t = 0;
  if (lastThrottleValue < 5) t = 0;
  else if (lastThrottleValue < 25) t = 0.05;
  else if (lastThrottleValue < 60) t = 0.5;
  else if (lastThrottleValue < 80) t = 0.8;
  else t = 1.0;
  // assign immediately (update() will smooth)
  App.thrustInput = t;
}

// ---------------------
// Keyboard controls
// ---------------------
function onKeyDown(e) {
  const key = (e.key || '').toLowerCase();
  // Prevent hold repeat flood
  if (keyboardRepeat[key]) return;
  keyboardRepeat[key] = true;

  // Primary controls
  // w/s pitch down/up
  if (key === 'w') App.pitch -= (CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75) * 0.02;
  if (key === 's') App.pitch += (CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75) * 0.02;
  // a/d roll left/right
  if (key === 'a') App.roll -= (CONFIG.PHYSICS?.MAX_BANK_RATE ?? 0.9) * 0.02;
  if (key === 'd') App.roll += (CONFIG.PHYSICS?.MAX_BANK_RATE ?? 0.9) * 0.02;
  // q/e yaw left/right
  if (key === 'q') App.heading -= (CONFIG.PHYSICS?.MAX_YAW_RATE ?? 0.9) * 0.02;
  if (key === 'e') App.heading += (CONFIG.PHYSICS?.MAX_YAW_RATE ?? 0.9) * 0.02;

  // Thrust nudges
  if (key === 'arrowup') {
    lastThrottleValue = U.clamp(lastThrottleValue + 5, 0, 100);
    App.thrustInput = lastThrottleValue / 100;
  }
  if (key === 'arrowdown') {
    lastThrottleValue = U.clamp(lastThrottleValue - 5, 0, 100);
    App.thrustInput = lastThrottleValue / 100;
  }

  // Toggle debug overlay (backtick)
  if (key === '`' || e.code === 'F8') {
    const dbg = document.getElementById('debugOverlay');
    if (dbg) dbg.classList.toggle('hidden');
  }
}

function onKeyUp(e) {
  const key = (e.key || '').toLowerCase();
  keyboardRepeat[key] = false;
}

// apply continuous keyboard inputs (held keys)
function applyKeyboard(dt) {
  // small continuous adjustments if keys are held
  if (App.keys['w'] || App.keys['s']) {
    const sign = App.keys['w'] ? -1 : (App.keys['s'] ? 1 : 0);
    App.pitch += sign * (CONFIG.PHYSICS?.MAX_PITCH_RATE ?? 0.75) * dt;
  }
  if (App.keys['a'] || App.keys['d']) {
    const sign = App.keys['a'] ? -1 : (App.keys['d'] ? 1 : 0);
    App.roll += sign * (CONFIG.PHYSICS?.MAX_BANK_RATE ?? 0.9) * dt;
  }
  if (App.keys['q'] || App.keys['e']) {
    const sign = App.keys['q'] ? -1 : (App.keys['e'] ? 1 : 0);
    App.heading += sign * (CONFIG.PHYSICS?.MAX_YAW_RATE ?? 0.9) * dt;
  }
}
