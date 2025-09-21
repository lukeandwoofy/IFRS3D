// main.js — WebFS2025 bootstrap
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

export const CONFIG = {
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ', // ← insert your Cesium Ion token here
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
    SERVER_URL: '', // ← set if using multiplayer
    callsign: 'WEBFS'
  },
  ATC: {
    COHERE_API_KEY: '' // ← optional
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

export const App = {
  lonRad: 0,
  latRad: 0,
  heightM: 1000,
  heading: 0,
  pitch: 0,
  roll: 0,
  speedMS: 0,
  vSpeedMS: 0,
  thrustInput: 0,
  onGround: false,
  viewMode: 'orbit',
  keys: {},
  viewer: null,
  planeEntity: null,
  camPosSmooth: null,
  autopilot: null
};

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

function attachAll() {
  for (const name in Modules) {
    try {
      Modules[name].attach?.(App, CONFIG, U, Modules);
      console.log(`[WebFS2025] Loaded module: ${name}`);
    } catch (e) {
      console.warn(`[WebFS2025] Failed to attach ${name}:`, e);
    }
  }
}

async function initAll() {
  for (const name in Modules) {
    try {
      await Modules[name].init?.();
    } catch (e) {
      console.warn(`[WebFS2025] Init failed: ${name}`, e);
    }
  }
}

function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if (k) App.keys[k] = true;
    if (e.code) App.keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => {
    const k = (e.key || '').toLowerCase();
    if (k) App.keys[k] = false;
    if (e.code) App.keys[e.code] = false;
  });
}

async function createViewer() {
  if (CONFIG.CESIUM_TOKEN) Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN;

  let terrainProvider;
  try {
    terrainProvider = await Cesium.createWorldTerrainAsync?.();
  } catch {
    terrainProvider = new Cesium.EllipsoidTerrainProvider();
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
    creditContainer: document.getElementById(CONFIG.VIEWER.CREDIT_CONTAINER_ID)
  });

  App.viewer = viewer;
  return viewer;
}

// --- boot, loop, and lifecycle (second half of main.js) ---

export async function boot() {
  try {
    initKeyboard();

    const viewer = await createViewer();

    // initial position cartesian (use radians inputs stored in App)
    const startPos = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM || 1000);
    App.planeEntity = viewer.entities.add({
      id: 'player-plane',
      position: startPos,
      model: {
        uri: '', // optional: set to a mesh or Ion asset if available
        scale: 1.0,
        minimumPixelSize: 48
      }
    });

    // initialize smooth camera storage
    App.camPosSmooth = viewer.camera.position.clone?.() || new Cesium.Cartesian3();

    // attach modules now that viewer exists
    attachAll();

    // init modules (some may be async)
    await initAll();

    // try a single terrain sample to place aircraft on ground if terrain exists
    try {
      if (typeof Cesium.sampleTerrainMostDetailed === 'function' && viewer && viewer.terrainProvider) {
        const carto = new Cesium.Cartographic(App.lonRad, App.latRad);
        const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
        const height = samples?.[0]?.height;
        if (typeof height === 'number') {
          const minH = height + (CONFIG.PHYSICS.GEAR_HEIGHT || 1.2);
          if (App.heightM < minH) {
            App.heightM = minH;
            App.onGround = true;
          }
        }
      }
    } catch (e) {
      console.warn('[WebFS2025] Terrain sample at spawn failed:', e);
    }

    // Start main loop
    lastTime = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    console.error('[WebFS2025] Boot failed:', err);
  }
}

let lastTime = 0;

// safeCall helper to isolate module errors
function safeCall(mod, fnName, ...args) {
  try {
    if (!mod) return;
    const fn = mod[fnName];
    if (typeof fn === 'function') return fn(...args);
  } catch (e) {
    console.warn(`[WebFS2025] Module ${mod?.name || fnName} ${fnName} error:`, e);
  }
}

function loop(now) {
  const dt = Math.min(0.1, ((now || performance.now()) - lastTime) / 1000 || 0.016);
  lastTime = now || performance.now();

  // update pipeline (order matters)
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

export async function shutdown() {
  try {
    for (const name in Modules) {
      try {
        await Modules[name].dispose?.();
      } catch (e) {
        console.warn(`[WebFS2025] Dispose failed for ${name}:`, e);
      }
    }
    if (App.viewer && typeof App.viewer.destroy === 'function') {
      try { App.viewer.destroy(); } catch (e) { /* ignore */ }
    }
    App.viewer = null;
  } catch (e) {
    console.warn('[WebFS2025] Shutdown error:', e);
  }
}

// auto-start on import
boot().catch((e) => console.error('[WebFS2025] Boot exception:', e));
