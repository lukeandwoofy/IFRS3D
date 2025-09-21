// persistence.js — Save / Load flight state for WebFS2025
// Exports: attach, init, saveState, loadState, listSlots, deleteSlot, dispose
// Purpose:
//  - Snapshot core App flight state to localStorage (position, attitude, kinematics, modules minimal state)
//  - Restore a snapshot and apply it to App
//  - Provide simple slot management (slot0..slot9)
// Dependencies: main.js providing App, CONFIG, U

let App, CONFIG, U;
const PREFIX = 'webfs2025.save.';
const SLOT_COUNT = 10;

// Attach references
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

// Init is optional (keeps API parity)
export function init() {
  // nothing to initialize for localStorage-based persistence
}

// Build a lightweight snapshot of the current flight state
function buildSnapshot() {
  return {
    meta: {
      ts: Date.now(),
      appVersion: 'webfs2025-modular-1'
    },
    pose: {
      lonDeg: U.rad2deg(App.lonRad || 0),
      latDeg: U.rad2deg(App.latRad || 0),
      heightM: App.heightM || 0,
      headingDeg: (U.rad2deg(App.heading || 0) + 360) % 360,
      pitchDeg: U.rad2deg(App.pitch || 0),
      rollDeg: U.rad2deg(App.roll || 0)
    },
    kinematics: {
      speedMS: App.speedMS || 0,
      vSpeedMS: App.vSpeedMS || 0,
      thrustInput: App.thrustInput || 0,
      onGround: !!App.onGround
    },
    autopilot: {
      enabled: !!(App.autopilot && App.autopilot.enabled && typeof App.autopilot.enabled === 'function' ? App.autopilot.enabled() : false)
    },
    // Additional module-friendly slot: modules may add small state objects under `modules` property
    modules: {}
  };
}

// Apply a snapshot object to App state (doesn't attempt deep module restore)
function applySnapshot(snap) {
  if (!snap || !snap.pose) return false;
  const p = snap.pose;
  App.lonRad = U.deg2rad(p.lonDeg);
  App.latRad = U.deg2rad(p.latDeg);
  App.heightM = Number(p.heightM) || 0;
  App.heading = U.deg2rad(p.headingDeg);
  App.pitch = U.deg2rad(p.pitchDeg);
  App.roll = U.deg2rad(p.rollDeg);

  const k = snap.kinematics || {};
  App.speedMS = Number(k.speedMS) || 0;
  App.vSpeedMS = Number(k.vSpeedMS) || 0;
  App.thrustInput = Number(k.thrustInput) || 0;
  App.onGround = !!k.onGround;

  // Allow modules to read their saved state from snap.modules if they choose (not enforced here)
  App._loadedPersistence = snap;

  return true;
}

// Save snapshot to a named slot (0..9)
export function saveState(slotIndex = 0, label = '') {
  const idx = clampSlot(slotIndex);
  const snap = buildSnapshot();
  if (label) snap.meta.label = String(label).slice(0, 64);
  try {
    localStorage.setItem(PREFIX + idx, JSON.stringify(snap));
    return { ok: true, slot: idx, snap };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Load snapshot from slot and apply it
export function loadState(slotIndex = 0) {
  const idx = clampSlot(slotIndex);
  try {
    const raw = localStorage.getItem(PREFIX + idx);
    if (!raw) return { ok: false, error: 'empty' };
    const snap = JSON.parse(raw);
    const applied = applySnapshot(snap);
    if (!applied) return { ok: false, error: 'invalid snapshot' };
    return { ok: true, slot: idx, snap };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// List saved slots with metadata
export function listSlots() {
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const raw = localStorage.getItem(PREFIX + i);
    if (!raw) { out.push({ slot: i, empty: true }); continue; }
    try {
      const snap = JSON.parse(raw);
      out.push({
        slot: i,
        empty: false,
        ts: snap.meta?.ts || null,
        label: snap.meta?.label || null,
        pos: snap.pose ? { latDeg: snap.pose.latDeg, lonDeg: snap.pose.lonDeg, altM: snap.pose.heightM } : null
      });
    } catch (e) {
      out.push({ slot: i, empty: false, corrupted: true });
    }
  }
  return out;
}

// Delete a slot
export function deleteSlot(slotIndex = 0) {
  const idx = clampSlot(slotIndex);
  localStorage.removeItem(PREFIX + idx);
  return { ok: true, slot: idx };
}

// Helper to ensure slot in range
function clampSlot(i) {
  let idx = Number.isFinite(i) ? Math.floor(i) : 0;
  if (idx < 0) idx = 0;
  if (idx >= SLOT_COUNT) idx = SLOT_COUNT - 1;
  return idx;
}

// Expose a convenience API to main/UI via App.hooks if desired
export function attachUIHelpers(uiBridge = {}) {
  // Optional: uiBridge can receive callbacks to display slot lists or confirm saves
  // Not invoked automatically; left for UI module to call if needed
  return {
    save: saveState,
    load: loadState,
    list: listSlots,
    delete: deleteSlot
  };
}

export function dispose() {
  // nothing to clean
}
