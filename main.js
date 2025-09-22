// main.js — WebFS2025 bootstrap (complete, robust version)
// - Safe keyboard handling
// - Robust Cesium viewer + terrain initialization with fallbacks
// - Module attach/init lifecycle with guarded main loop
// - Spawn terrain sampling guarded to avoid runtime errors

import * as physics from './physics.js';
import * as controls from './controls.js';
import * as camera from './camera.js';
import * as weather from './weather.js';
import * as ui from './ui.js';
import * as autopilot from './autopilot.js';
import * as atc from './atc.js';
import * as passenger from './passenger.js';
import * as persistence from './persistence.js';
import * as multiplayer from './multiplayer.js';

// --------------------
// Config and utilities
// --------------------
export const CONFIG = {
  CESIUM_TOKEN: '', // set at build/injection time; do not commit secrets
  VIEWER: {
    BASE_LAYER_PICKER: false,
    REQUEST_RENDER_MODE: true,
    MAXIMUM_RENDER_TIME_CHANGE: 16,
    CREDIT_CONTAINER_ID: 'cesiumCreditContainer'
  },
  PHYSICS: {
    MAX_THRUST_ACCEL: 8.0,
    DRAG_COEFF: 0.02,
    LIFT_COEFF: 0.0025,
    G: 9.81,
    GEAR_HEIGHT: 1.2,
    GROUND_STICTION_THRESH: 1.0,
    GROUND_STICTION_PUSH: 0.5,
    MAX_BANK_RATE: 0.9,
    MAX_PITCH_RATE: 0.75,
    MAX_YAW_RATE: 0.9,
    ROLL_DAMP_AIR: 0.995,
    PITCH_DAMP_AIR: 0.995
  },
  WEATHER: {
    ENABLED: true,
    UPDATE_SECONDS: 180,
    CLOUDS_OVERCAST_THRESHOLD: 75,
    CLOUD_SPRITES_MAX: 28,
    CLOUD_LAYER_ALT_M: 1800,
    CLOUD_RADIUS_M: 2000,
    SNOW_TEMP_C: 0,
    PRECIP_MIN: 0.05,
    HEAVY_MM_H: 3.5
  },
  CAMERA: {
    CHASE_BACK: 220,
    CHASE_UP: 72,
    FP_AHEAD: 8,
    FP_UP: 2.4,
    SMOOTH_FACTOR: 0.08
  },
  MULTIPLAYER: {
    SERVER_URL: '', // set if using multiplayer server
    callsign: 'WEBFS'
  },
  ATC: {
    COHERE_API_KEY: '' // optional; leave empty to use fallback
  },
  PASSENGER: {
    LEAFLET_JS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    LEAFLET_CSS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
  }
};

export const U = {
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  clamp01: (v) => Math.min(1, Math.max(0, v)),
  deg2rad: (d) => (d * Math.PI) / 180,
  rad2deg: (r) => (r * 180) / Math.PI,
  ms2kts: (m) => m * 1.943844,
  m2ft: (m) => m * 3.28084,
  hprQuat: (pos, heading, pitch, roll) => {
    const hpr = new Cesium.HeadingPitchRoll(heading, pitch, roll);
    return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
  }
};

// --------------------
// App state
// --------------------
export const App = {
  lonRad: 0,     // radians
  latRad: 0,     // radians
  heightM: 1000, // meters
  heading: 0,    // radians
  pitch: 0,      // radians
  roll: 0,       // radians
  speedMS: 0,
  vSpeedMS: 0,
  thrustInput: 0,
  onGround: false,
  viewMode: 'orbit',
  keys: {},
  viewer: null,
  planeEntity: null,
  camPosSmooth: null,
  autopilot: null,
  _localId: null
};

// --------------------
// Modules registry
// --------------------
const Modules = {
  physics,
  controls,
  camera,
  weather,
  ui,
  autopilot,
  atc,
  passenger,
  persistence,
  multiplayer
};

// --------------------
// Module attach & init
// --------------------
function attachAll() {
  for (const name of Object.keys(Modules)) {
    const mod = Modules[name];
    try {
      if (typeof mod.attach === 'function') mod.attach(App, CONFIG, U, Modules);
      console.log(`[WebFS2025] Loaded module: ${name}`);
    } catch (e) {
      console.warn(`[WebFS2025] Failed to attach ${name}:`, e);
    }
  }
}

async function initAll() {
  for (const name of Object.keys(Modules)) {
    const mod = Modules[name];
    try {
      if (typeof mod.init === 'function') await mod.init();
    } catch (e) {
      console.warn(`[WebFS2025] Module ${name} init failed:`, e);
    }
  }
}

// --------------------
// Keyboard guards
// --------------------
function initKeyboardGuards() {
  window.addEventListener('keydown', (e) => {
    const k = (e && e.key) ? String(e.key).toLowerCase() : '';
    const c = e && e.code ? String(e.code) : '';
    if (k) App.keys[k] = true;
    if (c) App.keys[c] = true;
  });
  window.addEventListener('keyup', (e) => {
    const k = (e && e.key) ? String(e.key).toLowerCase() : '';
    const c = e && e.code ? String(e.code) : '';
    if (k) App.keys[k] = false;
    if (c) App.keys[c] = false;
  });
}

// --------------------
// Viewer & terrain creation (robust)
// --------------------
async function createViewer() {
  // Set Cesium token if provided
  if (CONFIG.CESIUM_TOKEN) {
    try { Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN; } catch (e) {}
  }

  // Try to create world terrain; fallback to ellipsoid terrain if unavailable or fails
  let terrainProvider = undefined;
  try {
    if (typeof Cesium.createWorldTerrainAsync === 'function') {
      terrainProvider = await Cesium.createWorldTerrainAsync();
    } else if (typeof Cesium.createWorldTerrain === 'function') {
      terrainProvider = Cesium.createWorldTerrain();
    }
  } catch (e) {
    console.warn('[main] createWorldTerrain failed, falling back to EllipsoidTerrainProvider', e);
    terrainProvider = undefined;
  }

  if (!terrainProvider && Cesium.EllipsoidTerrainProvider) {
    try {
      terrainProvider = new Cesium.EllipsoidTerrainProvider();
    } catch (e) {
      terrainProvider = undefined;
    }
  }

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider,
    sceneModePicker: false,
    timeline: false,
    animation: false,
    baseLayerPicker: CONFIG.VIEWER.BASE_LAYER_PICKER,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    selectionIndicator: false,
    infoBox: false,
    requestRenderMode: CONFIG.VIEWER.REQUEST_RENDER_MODE,
    maximumRenderTimeChange: CONFIG.VIEWER.MAXIMUM_RENDER_TIME_CHANGE,
    creditContainer: document.getElementById(CONFIG.VIEWER.CREDIT_CONTAINER_ID) || undefined
  });

  App.viewer = viewer;
  return viewer;
}

// --------------------
// Boot sequence
// --------------------
export async function boot() {
  try {
    initKeyboardGuards();

    const viewer = await createViewer();

    // initial position Cartesian (from radians stored in App)
    const startPos = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM);
    // If you have a valid glTF URL or Cesium Ion asset, set model.uri to that.
    // Leave empty to skip model loading (avoids glTF errors).
    App.planeEntity = viewer.entities.add({
      id: 'player-plane',
      position: startPos,
      model: {
        uri: '', // set to a valid .glb URL or IonResource.fromAssetId(...) if available
        scale: 1.0,
        minimumPixelSize: 48
      }
    });

    // camera smoothing storage
    App.camPosSmooth = viewer.camera.position.clone ? viewer.camera.position.clone() : viewer.camera.position;

    // Attach and init modules
    attachAll();
    await initAll();

    // Attempt a single terrain sample at spawn (guarded)
    try {
      if (typeof Cesium.sampleTerrainMostDetailed === 'function' && viewer && viewer.terrainProvider) {
        const carto = new Cesium.Cartographic(App.lonRad, App.latRad);
        try {
          const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
          const h = samples?.[0]?.height;
          if (typeof h === 'number') {
            const minH = h + (CONFIG.PHYSICS.GEAR_HEIGHT || 1.2);
            if (App.heightM < minH) {
              App.heightM = minH;
              App.onGround = true;
            }
          }
        } catch (e) {
          console.warn('Terrain sample failed at spawn:', e);
        }
      }
    } catch (e) {
      console.warn('Spawn terrain check skipped:', e);
    }

    // Start main loop
    lastTime = performance.now();
    requestAnimationFrame(loop);

  } catch (err) {
    console.error('[WebFS2025] Boot failed:', err);
  }
}

// --------------------
// Main loop and helpers
// --------------------
let lastTime = 0;

function safeCall(mod, fnName, ...args) {
  try {
    if (!mod) return;
    const fn = mod[fnName];
    if (typeof fn === 'function') return fn(...args);
  } catch (e) {
    console.warn(`[WebFS2025] Module ${mod && mod.name ? mod.name : fnName} ${fnName} failed:`, e);
  }
}

function loop(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000 || 0.016);
  lastTime = now;

  // update pipeline
  safeCall(controls, 'update', App, dt);
  safeCall(physics, 'update', App, dt);
  safeCall(camera, 'lateUpdate', dt);
  safeCall(weather, 'update', App, dt);
  safeCall(ui, 'lateUpdate', dt);
  safeCall(autopilot, 'update', App, dt);
  safeCall(atc, 'update', App, dt);
  safeCall(passenger, 'update', App, dt);
  safeCall(persistence, 'update', App, dt);
  safeCall(multiplayer, 'update', App, dt);

  requestAnimationFrame(loop);
}

// --------------------
// Shutdown
// --------------------
export async function shutdown() {
  try {
    for (const name of Object.keys(Modules)) {
      const mod = Modules[name];
      if (mod && typeof mod.dispose === 'function') {
        try { await mod.dispose(); } catch (e) { /* ignore */ }
      }
    }
    if (App.viewer && typeof App.viewer.destroy === 'function') {
      try { App.viewer.destroy(); } catch (e) {}
    }
    App.viewer = null;
  } catch (e) {
    console.warn('Shutdown error', e);
  }
}

// Auto-start
boot().catch((e) => console.error('Boot exception:', e));
