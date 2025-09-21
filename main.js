// main.js — WebFS2025 modular bootstrap
// Orchestrates: Cesium init, global app state, dynamic module loading, main loop.

// ==============================
// 0) Configuration
// ==============================
export const CONFIG = {
  CESIUM_TOKEN: 'PASTE_YOUR_CESIUM_ION_TOKEN',
  MODEL: {
    AIRCRAFT_ASSET_ID: 3713684, // replace if needed
    SCALE: 1.0,
    MIN_PIXEL_SIZE: 96,
    RUN_ANIMATIONS: false
  },
  SPAWN: {
    LON_DEG: -9.1358, // Lisbon area
    LAT_DEG: 38.7812,
    HEADING_DEG: 30.0
  },
  VIEWER: {
    BASE_LAYER_PICKER: true,
    REQUEST_RENDER_MODE: true,
    MAXIMUM_RENDER_TIME_CHANGE: Infinity,
    DEPTH_TEST_TERRAIN: true,
    OSM_BUILDINGS: true,
    CREDIT_CONTAINER_ID: 'cesiumCreditContainer'
  },
  CAMERA: {
    CHASE_BACK: 220,
    CHASE_UP: 72,
    FP_AHEAD: 8,
    FP_UP: 2.4,
    SMOOTH_FACTOR: 0.02
  },
  PHYSICS: {
    G: 9.81,
    MAX_THRUST_ACCEL: 14.0,
    DRAG_COEFF: 0.006,
    LIFT_COEFF: 0.95,
    GEAR_HEIGHT: 2.8
  },
  WEATHER: {
    ENABLED: true,
    UPDATE_SECONDS: 180
  },
  DEBUG: {
    ENABLED: false
  }
};

// ==============================
// 1) Global app state
// ==============================
export const App = {
  // Cesium
  viewer: null,
  planeEntity: null,

  // Pose
  lonRad: 0,
  latRad: 0,
  heightM: 0,
  heading: 0,
  pitch: 0,
  roll: 0,

  // Kinematics
  speedMS: 0,
  vSpeedMS: 0,
  thrustInput: 0,
  onGround: true,

  // Time
  lastTs: 0,
  dt: 0,

  // View
  viewMode: 'orbit', // 'orbit' | 'chase' | 'first'
  camPosSmooth: null,

  // Input
  keys: {},

  // Hooks registry for modules
  hooks: {
    init: [],
    update: [],
    lateUpdate: [],
    dispose: []
  },

  // Utility to register hooks
  onInit(fn){ this.hooks.init.push(fn); },
  onUpdate(fn){ this.hooks.update.push(fn); },
  onLateUpdate(fn){ this.hooks.lateUpdate.push(fn); },
  onDispose(fn){ this.hooks.dispose.push(fn); }
};

// ==============================
// 2) Utilities
// ==============================
export const U = {
  deg2rad: (d) => Cesium.Math.toRadians(d),
  rad2deg: (r) => Cesium.Math.toDegrees(r),
  ms2kts: (ms) => ms * 1.94384,
  m2ft: (m) => m * 3.28084,
  clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
  clamp01: (x) => Math.max(0, Math.min(1, x)),
  hprQuat(position, h, p, r) {
    return Cesium.Transforms.headingPitchRollQuaternion(
      position, new Cesium.HeadingPitchRoll(h, p, r)
    );
  }
};

// ==============================
// 3) Optional module loader
// ==============================
// Modules are optional. If a file is missing, we keep going.
// Create files with these names to plug systems in.
const Modules = {};
async function tryLoadModule(name, path) {
  try {
    const mod = await import(path);
    Modules[name] = mod;
    if (typeof mod.attach === 'function') {
      await mod.attach(App, CONFIG, U);
    }
    if (typeof mod.init === 'function') {
      App.onInit(() => mod.init(App, CONFIG, U));
    }
    if (typeof mod.update === 'function') {
      App.onUpdate((dt) => mod.update(App, dt, CONFIG, U));
    }
    if (typeof mod.lateUpdate === 'function') {
      App.onLateUpdate((dt) => mod.lateUpdate(App, dt, CONFIG, U));
    }
    if (typeof mod.dispose === 'function') {
      App.onDispose(() => mod.dispose(App));
    }
    console.log(`[WebFS2025] Loaded module: ${name}`);
  } catch (e) {
    console.warn(`[WebFS2025] Module not available: ${name} (${path})`, e?.message || e);
  }
}

// ==============================
// 4) Boot: DOM ready
// ==============================
document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error('Boot error:', err);
    alert('Initialization failed. See console for details.');
  });
});

// ==============================
// 5) Boot sequence
// ==============================
async function boot() {
  // 5.1 Login gate (optional)
  const loginForm = document.getElementById('loginForm');
  const loginDiv = document.getElementById('login');
  const password = document.getElementById('password');
  const loading = document.getElementById('loading');

  if (loginForm && loginDiv) {
    await new Promise((resolve) => {
      loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if ((password?.value || '').trim() === 'A330') {
          loginDiv.style.display = 'none';
          resolve();
        } else {
          alert('Incorrect password');
        }
      }, { once: true });
    });
  }

  loading?.classList.remove('hidden');

  // 5.2 Cesium viewer
  Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN;
  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: Cesium.Terrain.fromWorldTerrain(),
    sceneModePicker: false, timeline: false, animation: false, baseLayerPicker: CONFIG.VIEWER.BASE_LAYER_PICKER,
    geocoder: false, homeButton: false, navigationHelpButton: false,
    selectionIndicator: false, infoBox: false,
    requestRenderMode: CONFIG.VIEWER.REQUEST_RENDER_MODE,
    maximumRenderTimeChange: CONFIG.VIEWER.MAXIMUM_RENDER_TIME_CHANGE,
    creditContainer: document.getElementById(CONFIG.VIEWER.CREDIT_CONTAINER_ID) || undefined
  });
  if (CONFIG.VIEWER.DEPTH_TEST_TERRAIN) viewer.scene.globe.depthTestAgainstTerrain = true;

  // Visual polish
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.dynamicAtmosphereLighting = true;
  viewer.scene.skyAtmosphere.hueShift = -0.015;
  viewer.scene.skyAtmosphere.saturationShift = -0.18;
  viewer.scene.skyAtmosphere.brightnessShift = -0.06;
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0016;

  if (CONFIG.VIEWER.OSM_BUILDINGS) {
    try {
      const osm = await Cesium.createOsmBuildingsAsync();
      viewer.scene.primitives.add(osm);
    } catch (e) {
      console.warn('OSM buildings failed to load:', e);
    }
  }

  App.viewer = viewer;

  // 5.3 Spawn
  App.lonRad = U.deg2rad(CONFIG.SPAWN.LON_DEG);
  App.latRad = U.deg2rad(CONFIG.SPAWN.LAT_DEG);
  App.heading = U.deg2rad(CONFIG.SPAWN.HEADING_DEG);
  App.pitch = 0;
  App.roll = 0;

  // Sample terrain for spawn height
  const startCarto = new Cesium.Cartographic(App.lonRad, App.latRad);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples?.[0]?.height ?? 0;
  } catch (e) {
    console.warn('Terrain sample failed at spawn:', e);
  }
  App.heightM = terrainH + CONFIG.PHYSICS.GEAR_HEIGHT;

  // 5.4 Load aircraft model (fallback to point)
  const pos = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM);
  let modelUri = null;
  try {
    modelUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
  } catch (e) {
    console.warn('Ion model load failed, using point fallback:', e);
  }
  App.planeEntity = viewer.entities.add({
    position: pos,
    model: modelUri ? {
      uri: modelUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: CONFIG.MODEL.RUN_ANIMATIONS
    } : undefined,
    point: modelUri ? undefined : { color: Cesium.Color.CYAN, pixelSize: 12 },
    orientation: U.hprQuat(pos, App.heading, App.pitch, App.roll)
  });

  // 5.5 Camera initial view
  try {
    await viewer.flyTo(App.planeEntity, {
      duration: 1.0,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 500)
    });
  } catch {}
  App.viewMode = 'orbit';
  viewer.trackedEntity = App.planeEntity;

  // 5.6 Load modules (optional, safe if missing)
  await Promise.all([
    tryLoadModule('physics', './physics.js'),
    tryLoadModule('controls', './controls.js'),
    tryLoadModule('camera', './camera.js'),
    tryLoadModule('weather', './weather.js'),
    tryLoadModule('ui', './ui.js'),
    tryLoadModule('autopilot', './autopilot.js'),
    tryLoadModule('atc', './atc.js'),
    tryLoadModule('passenger', './passenger.js'),
    tryLoadModule('persistence', './persistence.js'),
    tryLoadModule('multiplayer', './multiplayer.js')
  ]);

  // 5.7 Run module init hooks
  for (const fn of App.hooks.init) {
    try { await fn(); } catch (e) { console.warn('Init hook error:', e); }
  }

  loading?.classList.add('hidden');

  // 5.8 Start main loop
  App.lastTs = performance.now();
  requestAnimationFrame(loop);
}

// ==============================
// 6) Main loop
// ==============================
function loop(ts) {
  const now = ts || performance.now();
  const dtRaw = (now - App.lastTs) / 1000;
  App.dt = U.clamp(dtRaw, 0.001, 0.05);
  App.lastTs = now;

  // Module updates
  for (const fn of App.hooks.update) {
    try { fn(App.dt); } catch (e) { console.warn('Update hook error:', e); }
  }

  // Commit pose to Cesium
  commitPose();

  // Late updates (camera, UI, etc.)
  for (const fn of App.hooks.lateUpdate) {
    try { fn(App.dt); } catch (e) { console.warn('LateUpdate hook error:', e); }
  }

  // Render request (for requestRenderMode viewers)
  App.viewer?.scene?.requestRender();

  requestAnimationFrame(loop);
}

// ==============================
// 7) Commit pose to Cesium
// ==============================
function commitPose() {
  if (!App.viewer || !App.planeEntity) return;

  // Update entity position/orientation
  const pos = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM);
  const quat = U.hprQuat(pos, App.heading, App.pitch, App.roll);

  App.planeEntity.position = pos;
  App.planeEntity.orientation = quat;
}

// ==============================
// 8) Global keyboard wiring (basic)
// ==============================
window.addEventListener('keydown', (e) => {
  App.keys[e.key.toLowerCase()] = true;
  App.keys[e.code] = true;
});
window.addEventListener('keyup', (e) => {
  App.keys[e.key.toLowerCase()] = false;
  App.keys[e.code] = false;
});

// ==============================
// 9) Cleanup on unload
// ==============================
window.addEventListener('beforeunload', () => {
  for (const fn of App.hooks.dispose) {
    try { fn(); } catch {}
  }
});
