// script.js — Headwind A330neo Browser Flight Sim
// Ultra-extended, fully patched build with:
// - Login and loading flow
// - Enforced motion (no sideways drift, no stuck-on-ground), accurate HUD
// - Controls: Left Shift = thrust up, Left Ctrl = thrust down; WASD + QE
// - Basic autopilot (ALT hold), toggle button + programmatic
// - Passenger tab setup panel (press 2 or onscreen button), opens IFE tab with Leaflet map
// - Weather (Open-Meteo) clouds, rain/snow particles, sky tint; wind drift toggle
// - Onscreen joystick (pitch/roll) and throttle slider (maps to thrust)
// - OSM buildings with outlines disabled (silences draping warning)
// - Safe Gemini ATC placeholder via REST (no broken CDN imports)
// - Debug overlay toggleable (` or F8)
// - Many safety guards (key handlers, popup checks, model loading fallbacks)
//
// IMPORTANT:
//   - Replace CONFIG.CESIUM_TOKEN and CONFIG.MODEL.AIRCRAFT_ASSET_ID
//   - If you use Gemini ATC in the browser, your key is exposed. Prefer a backend proxy in production.
//   - This file is intentionally verbose and heavily commented, matching your request for a 1000+ line script.
//
// -----------------------------------------------------------------------------
// 0) Login flow
// -----------------------------------------------------------------------------

const PASSWORD = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (document.getElementById('password')?.value || '').trim();
  if (val === PASSWORD) {
    const loginDiv = document.getElementById('login');
    if (loginDiv) loginDiv.style.display = 'none';
    loadingOverlay?.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init error:', err);
      alert('Failed to initialize. See console for details.');
      loadingOverlay?.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});


// -----------------------------------------------------------------------------
// 1) Configuration
// -----------------------------------------------------------------------------

const CONFIG = {
  // Cesium
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ', // <- replace with your Cesium ion token
  USE_FLAT_TERRAIN: false,

  // Spawn (LPPT runway 03 threshold-ish)
  SPAWN: {
    LON_DEG: -9.13580,
    LAT_DEG: 38.78120,
    HEADING_DEG: 30.0 // ~030°
  },

  // Model (Cesium ion asset)
  MODEL: {
    AIRCRAFT_ASSET_ID: 3713684, // <- replace with ion asset ID
    SCALE: 1.0,
    MIN_PIXEL_SIZE: 96,
    RUN_ANIMATIONS: false
  },

  // Viewer
  VIEWER: {
    BASE_LAYER_PICKER: true,
    REQUEST_RENDER_MODE: true,
    MAXIMUM_RENDER_TIME_CHANGE: Infinity,
    DEPTH_TEST_TERRAIN: true,
    OSM_BUILDINGS: true
  },

  // Physics
  PHYSICS: {
    G: 9.81,
    MAX_THRUST_ACCEL: 14.0,     // stronger push to guarantee ground roll
    DRAG_COEFF: 0.006,          // tunable linear drag
    LIFT_COEFF: 0.95,           // naive lift vs pitch and speed
    GEAR_HEIGHT: 2.8,           // meters above terrain
    TAKEOFF_SPEED: 75.0,        // m/s (~145 kts)
    MAX_BANK_RATE: 0.9,         // rad/s
    MAX_PITCH_RATE: 0.75,       // rad/s
    MAX_YAW_RATE: 0.9,          // rad/s
    GROUND_STEER_RATE: 0.8,     // rad/s (yaw) when on ground
    THRUST_RAMP: 1.6,           // per second
    THRUST_DECAY: 1.8,          // per second
    SIDE_DRIFT_DAMP: 0.92,      // damp sideways slippage on ground
    ROLL_DAMP_AIR: 0.995,       // air damping
    PITCH_DAMP_AIR: 0.995,      // air damping
    GROUND_STICTION_PUSH: 0.6,  // m/s^2 kick if thrust>0 but speed~0 (overcome "static friction")
    GROUND_STICTION_THRESH: 0.12
  },

  // Camera
  CAMERA: {
    CHASE_BACK: 220.0,
    CHASE_UP: 72.0,
    FP_AHEAD: 8.0,
    FP_UP: 2.4,
    SMOOTH_FACTOR: 0.02
  },

  // Weather (Open-Meteo)
  WEATHER: {
    ENABLED: true,
    UPDATE_SECONDS: 180,
    CLOUDS_OVERCAST_THRESHOLD: 75,
    CLOUD_LAYER_ALT_M: 1800,
    CLOUD_RADIUS_M: 2000,
    CLOUD_SPRITES_MAX: 40,
    PRECIP_MIN: 0.05,
    HEAVY_MM_H: 3.5,
    SNOW_TEMP_C: 0.0,
    ENABLE_WIND: false,
    WIND_SCALE: 0.14
  },

  // Debug
  DEBUG: {
    ENABLED: false,
    ELEMENT_ID: 'debugOverlay'
  },

  // Sampling
  SAMPLING: {
    TERRAIN_STEPS: 8 // sample ground every N frames
  },

  // Passenger tab
  PASSENGER: {
    PANEL_ID: 'passengerPanel',
    BTN_ID: 'passengerCreateBtn',
    DEFAULT_AIRLINE: 'Headwind',
    DEFAULT_AIRCRAFT: 'Airbus A330-900neo',
    DEFAULT_FLIGHT: 'HW123',
    DEFAULT_ORIGIN: 'LPPT',
    DEFAULT_DEST: 'EGLL',
    DEFAULT_ORIGIN_NAME: 'Lisbon',
    DEFAULT_DEST_NAME: 'London Heathrow',
    DEFAULT_DEPARTURE_TIME_LOCAL: '',
    DEFAULT_ARRIVAL_TIME_LOCAL: '',
    LEAFLET_CSS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    LEAFLET_JS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
  },

  // ATC (Gemini REST placeholder)
  ATC: {
    ENABLED: true,
    GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    GEMINI_API_KEY: '' // WARNING: client-side only for testing. Use a backend proxy in production.
  }
};


// -----------------------------------------------------------------------------
// 2) Utilities
// -----------------------------------------------------------------------------

const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const nmFromMeters = (m) => m / 1852;
const ms2kts = (ms) => ms * 1.94384;
const m2ft = (m) => m * 3.28084;

function hprQuaternion(position, heading, pitch, roll) {
  return Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(heading, pitch, roll)
  );
}

function normalize3(out, v) {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m > 1e-9) {
    out.x = v.x / m; out.y = v.y / m; out.z = v.z / m;
  } else {
    out.x = 1; out.y = 0; out.z = 0;
  }
  return out;
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadExternalStyle(href) {
  return new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = resolve;
    l.onerror = reject;
    document.head.appendChild(l);
  });
}


// -----------------------------------------------------------------------------
// 3) State
// -----------------------------------------------------------------------------

const SimState = {
  viewer: null,
  planeEntity: null,

  // Pose
  heading: deg2rad(CONFIG.SPAWN.HEADING_DEG),
  pitch: 0.0, // negative = nose up (convention used in integration)
  roll: 0.0,

  // Speeds
  speed: 0.0,          // forward m/s along heading
  verticalSpeed: 0.0,  // m/s
  thrustInput: 0.0,    // 0..1

  onGround: true,

  // Position (radians + meters)
  lon: deg2rad(CONFIG.SPAWN.LON_DEG),
  lat: deg2rad(CONFIG.SPAWN.LAT_DEG),
  height: 0.0,

  // Time
  lastTime: undefined,

  // Camera
  viewMode: 'orbit',
  canToggleView: true,
  camPosSmooth: null,

  // Input keys
  keys: {},

  // Terrain sampling
  sampleCounter: 0,
  sampling: false,

  // Passenger tab / IFE
  passengerWin: null,
  paxConfig: {
    airline: CONFIG.PASSENGER.DEFAULT_AIRLINE,
    aircraft: CONFIG.PASSENGER.DEFAULT_AIRCRAFT,
    flight: CONFIG.PASSENGER.DEFAULT_FLIGHT,
    origin: CONFIG.PASSENGER.DEFAULT_ORIGIN,
    destination: CONFIG.PASSENGER.DEFAULT_DEST,
    originName: CONFIG.PASSENGER.DEFAULT_ORIGIN_NAME,
    destinationName: CONFIG.PASSENGER.DEFAULT_DEST_NAME,
    departureLocal: CONFIG.PASSENGER.DEFAULT_DEPARTURE_TIME_LOCAL,
    arrivalLocal: CONFIG.PASSENGER.DEFAULT_ARRIVAL_TIME_LOCAL
  },

  // Route (optional)
  routePositions: [],
  routeEntity: null,

  // Autopilot
  autopilot: { enabled: false, targetAltM: null }
};

const WeatherState = {
  lastUpdate: 0,
  data: null,
  cloudiness: 0,
  precipRate: 0,
  tempC: 20,
  windDirDeg: 0,
  windSpeed: 0,
  condition: 'Clear',

  cloudBillboards: null,
  rainSystem: null,
  snowSystem: null
};

const DebugState = {
  enabled: CONFIG.DEBUG.ENABLED,
  el: null
};


// -----------------------------------------------------------------------------
// 4) Input (with guards) + onscreen UI wiring
// -----------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key) SimState.keys[e.key.toLowerCase()] = true;
  if (e.code) SimState.keys[e.code] = true;
  if (e.key === '`' || e.key === 'F8') toggleDebug();
  if (e.key === '2') togglePassengerPanel();
});

document.addEventListener('keyup', (e) => {
  if (e.key) SimState.keys[e.key.toLowerCase()] = false;
  if (e.code) SimState.keys[e.code] = false;
});

document.getElementById('passengerBtn')?.addEventListener('click', () => togglePassengerPanel());
document.getElementById('autopilotBtn')?.addEventListener('click', () => toggleAutopilot());
document.getElementById('resetBtn')?.addEventListener('click', () => resetToRunway());
document.getElementById('atcBtn')?.addEventListener('click', () => openATCPrompt());


// -----------------------------------------------------------------------------
// 5) Debug overlay
// -----------------------------------------------------------------------------

function createDebugOverlay() {
  if (!DebugState.enabled) return;
  let el = document.getElementById(CONFIG.DEBUG.ELEMENT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONFIG.DEBUG.ELEMENT_ID;
    Object.assign(el.style, {
      position: 'absolute',
      left: '10px',
      bottom: '10px',
      background: 'rgba(0,0,0,0.6)',
      color: 'white',
      padding: '8px 10px',
      font: '12px/1.4 monospace',
      borderRadius: '6px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      zIndex: 9999
    });
    document.body.appendChild(el);
  }
  DebugState.el = el;
}

function updateDebugOverlay() {
  if (!DebugState.enabled || !DebugState.el) return;
  const lines = [
    `Thrust: ${SimState.thrustInput.toFixed(2)}  AP: ${SimState.autopilot.enabled ? 'ON' : 'OFF'}`,
    `Speed: ${SimState.speed.toFixed(2)} m/s (${ms2kts(SimState.speed).toFixed(0)} kts)`,
    `V/S: ${SimState.verticalSpeed.toFixed(2)} m/s`,
    `Pitch: ${rad2deg(SimState.pitch).toFixed(1)}°  Roll: ${rad2deg(SimState.roll).toFixed(1)}°`,
    `Heading: ${rad2deg(SimState.heading).toFixed(1)}°  OnGround: ${SimState.onGround}`,
    `Lon/Lat: ${rad2deg(SimState.lon).toFixed(6)}, ${rad2deg(SimState.lat).toFixed(6)} Alt: ${SimState.height.toFixed(1)} m`,
    WeatherState.data ? `WX: ${WeatherState.condition} Clouds:${WeatherState.cloudiness}% P:${WeatherState.precipRate.toFixed(2)}mm/h T:${WeatherState.tempC.toFixed(0)}°C` : 'WX: n/a'
  ];
  DebugState.el.textContent = lines.join('\n');
}

function toggleDebug() {
  DebugState.enabled = !DebugState.enabled;
  if (DebugState.enabled && !DebugState.el) createDebugOverlay();
  if (!DebugState.enabled && DebugState.el) { DebugState.el.remove(); DebugState.el = null; }
}


// -----------------------------------------------------------------------------
// 6) Initialization
// -----------------------------------------------------------------------------

async function initSim() {
  Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: CONFIG.USE_FLAT_TERRAIN
      ? new Cesium.EllipsoidTerrainProvider()
      : Cesium.Terrain.fromWorldTerrain(),
    timeline: false,
    animation: false,
    sceneModePicker: false,
    baseLayerPicker: CONFIG.VIEWER.BASE_LAYER_PICKER,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    selectionIndicator: false,
    infoBox: false,
    requestRenderMode: CONFIG.VIEWER.REQUEST_RENDER_MODE,
    maximumRenderTimeChange: CONFIG.VIEWER.MAXIMUM_RENDER_TIME_CHANGE
  });

  SimState.viewer = viewer;

  // Graphics polish
  viewer.scene.shadowMap.enabled = true;
  viewer.scene.shadowMap.darkness = 0.6;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.skyAtmosphere.saturationShift = -0.05;

  if (CONFIG.VIEWER.DEPTH_TEST_TERRAIN) {
    viewer.scene.globe.depthTestAgainstTerrain = true;
  }

  // OSM buildings with outlines disabled (silences the draping warning)
  if (CONFIG.VIEWER.OSM_BUILDINGS) {
    try {
      const osm = await Cesium.createOsmBuildingsAsync();
      osm.showOutline = false;
      viewer.scene.primitives.add(osm);
    } catch (e) {
      console.warn('OSM buildings failed to load:', e);
    }
  }

  // Sample terrain to place aircraft on ground + gear clearance
  const startCarto = new Cesium.Cartographic(SimState.lon, SimState.lat);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples?.[0]?.height ?? 0;
  } catch {
    terrainH = 0;
  }
  SimState.height = terrainH + CONFIG.PHYSICS.GEAR_HEIGHT;

  // Load aircraft model entity
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  let modelUri = null;
  try {
    if (CONFIG.MODEL.AIRCRAFT_ASSET_ID && CONFIG.MODEL.AIRCRAFT_ASSET_ID !== 0) {
      modelUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
    }
  } catch (e) {
    console.warn('Failed to load model via ion asset id:', e);
  }

  const planeEntity = viewer.entities.add({
    position: pos,
    model: modelUri ? {
      uri: modelUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: CONFIG.MODEL.RUN_ANIMATIONS,
      silhouetteSize: 1.0,
      silhouetteColor: Cesium.Color.fromBytes(255, 64, 64, 100)
    } : undefined,
    point: modelUri ? undefined : {
      color: Cesium.Color.CYAN,
      pixelSize: 12
    },
    orientation: hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll)
  });
  SimState.planeEntity = planeEntity;

  // Camera
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 500)
    });
  } catch {}
  viewer.trackedEntity = planeEntity;
  if (viewLabel) viewLabel.textContent = 'Orbit';

  // Hide loading overlay
  loadingOverlay?.classList.add('hidden');

  // Camera smoothing
  SimState.camPosSmooth = viewer.camera.positionWC.clone();

  // Init weather (optional)
  if (CONFIG.WEATHER.ENABLED) {
    await initWeather();
  }

  // Build panels/UI
  buildPassengerPanel();
  setupJoystick();
  setupThrottle();
  createDebugOverlay();

  // Start loop
  viewer.clock.onTick.addEventListener(onTick);
}


// -----------------------------------------------------------------------------
// 7) Weather (Open-Meteo): clouds, precip, atmosphere tint
// -----------------------------------------------------------------------------

async function initWeather() {
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  createOrUpdateCloudSprites({
    cloudiness: 0,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });
  await updateWeather(true);
}

async function fetchOpenMeteo(latDeg, lonDeg) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDeg}&longitude=${lonDeg}&current=temperature_2m,precipitation,cloudcover,wind_direction_10m,wind_speed_10m&timezone=auto`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const j = await res.json();
    const c = j.current || {};
    const data = {
      clouds: Number.isFinite(c.cloudcover) ? c.cloudcover : 0,
      tempC: Number.isFinite(c.temperature_2m) ? c.temperature_2m : 15,
      precipRate: Number.isFinite(c.precipitation) ? c.precipitation : 0,
      windDirDeg: Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : 0,
      windSpeed: Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : 0
    };
    data.condition = data.precipRate > CONFIG.WEATHER.PRECIP_MIN
      ? (data.tempC <= CONFIG.WEATHER.SNOW_TEMP_C ? 'Snow' : 'Rain')
      : (data.clouds >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD ? 'Clouds' : 'Clear');
    return data;
  } catch (e) {
    console.warn('Open-Meteo fetch failed:', e);
    return null;
  }
}

async function updateWeather(initial = false) {
  const now = performance.now() / 1000;
  if (!initial && (now - WeatherState.lastUpdate) < CONFIG.WEATHER.UPDATE_SECONDS) return;

  const latDeg = rad2deg(SimState.lat);
  const lonDeg = rad2deg(SimState.lon);
  const data = await fetchOpenMeteo(latDeg, lonDeg);
  if (!data) return;

  WeatherState.lastUpdate = now;
  WeatherState.data = data;
  WeatherState.cloudiness = data.clouds;
  WeatherState.precipRate = data.precipRate;
  WeatherState.tempC = data.tempC;
  WeatherState.windDirDeg = data.windDirDeg;
  WeatherState.windSpeed = data.windSpeed;
  WeatherState.condition = data.condition;

  applyWeatherVisuals();
}

function applyWeatherVisuals() {
  const v = SimState.viewer;
  const c = WeatherState.cloudiness;
  const p = WeatherState.precipRate;
  const t = WeatherState.tempC;

  const atm = v.scene.skyAtmosphere;
  const overcast = c >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD;
  atm.hueShift = overcast ? -0.02 : 0.0;
  atm.saturationShift = overcast ? -0.25 : -0.05;
  atm.brightnessShift = overcast ? -0.12 : 0.0;

  createOrUpdateCloudSprites({
    cloudiness: c,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });

  const isSnow = (t <= CONFIG.WEATHER.SNOW_TEMP_C) && (p > CONFIG.WEATHER.PRECIP_MIN);
  const isRain = (t > CONFIG.WEATHER.SNOW_TEMP_C) && (p > CONFIG.WEATHER.PRECIP_MIN);

  if (isRain) {
    ensureRainSystem(true);
    ensureSnowSystem(false);
    tuneRainIntensity(p);
  } else if (isSnow) {
    ensureRainSystem(false);
    ensureSnowSystem(true);
    tuneSnowIntensity(p);
  } else {
    ensureRainSystem(false);
    ensureSnowSystem(false);
  }

  v.scene.requestRender();
}

function createOrUpdateCloudSprites({ cloudiness, altitudeAGL, radius }) {
  const v = SimState.viewer;
  if (!WeatherState.cloudBillboards) {
    WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  }
  const bbs = WeatherState.cloudBillboards;
  const max = CONFIG.WEATHER.CLOUD_SPRITES_MAX;
  const target = Math.round(clamp01(cloudiness / 100) * max);

  while (bbs.length < target) {
    bbs.add({
      image: generateCloudSprite(),
      color: Cesium.Color.WHITE.withAlpha(0.9),
      sizeInMeters: true
    });
  }
  while (bbs.length > target) {
    bbs.remove(bbs.get(bbs.length - 1));
  }

  if (target > 0) {
    const center = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height + altitudeAGL);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const spriteBase = 240;
    const spriteSize = spriteBase + (cloudiness / 100) * 260;
    for (let i = 0; i < bbs.length; i++) {
      const angle = i / bbs.length * Math.PI * 2;
      const r = radius * (0.85 + Math.random() * 0.35);
      const local = new Cesium.Cartesian3(
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        (Math.random() - 0.5) * 160
      );
      const world = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.position = world;
      bb.width = spriteSize;
      bb.height = spriteSize * 0.58;
      bb.alignedAxis = Cesium.Cartesian3.UNIT_Z;
    }
  }
}

function generateCloudSprite() {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  function blob(cx, cy, rx, ry, a) {
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  blob(70, 72, 74, 42, 0.95);
  blob(120, 60, 64, 38, 0.9);
  blob(162, 78, 66, 34, 0.86);
  blob(112, 86, 108, 38, 0.8);
  return c.toDataURL('image/png');
}

function ensureRainSystem(enabled) {
  const v = SimState.viewer;
  if (enabled && !WeatherState.rainSystem) {
    WeatherState.rainSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: rainDropSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.55),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.5,
      endScale: 0.5,
      minimumParticleLife: 0.5,
      maximumParticleLife: 0.8,
      minimumSpeed: 40.0,
      maximumSpeed: 80.0,
      emissionRate: 3600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14.0)),
      imageSize: new Cesium.Cartesian2(4.0, 18.0),
      sizeInMeters: true,
      lifetime: Number.MAX_VALUE
    }));
  } else if (!enabled && WeatherState.rainSystem) {
    v.scene.primitives.remove(WeatherState.rainSystem);
    WeatherState.rainSystem = null;
  }
}

function ensureSnowSystem(enabled) {
  const v = SimState.viewer;
  if (enabled && !WeatherState.snowSystem) {
    WeatherState.snowSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: snowFlakeSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.95),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.9,
      endScale: 0.9,
      minimumParticleLife: 1.2,
      maximumParticleLife: 2.2,
      minimumSpeed: 0.6,
      maximumSpeed: 2.2,
      emissionRate: 1600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(22.0)),
      imageSize: new Cesium.Cartesian2(12.0, 12.0),
      sizeInMeters: true,
      lifetime: Number.MAX_VALUE
    }));
  } else if (!enabled && WeatherState.snowSystem) {
    v.scene.primitives.remove(WeatherState.snowSystem);
    WeatherState.snowSystem = null;
  }
}

function tuneRainIntensity(mmPerHour) {
  const ps = WeatherState.rainSystem;
  if (!ps) return;
  const t = clamp01(mmPerHour / CONFIG.WEATHER.HEAVY_MM_H);
  ps.emissionRate = 1800 + 6800 * t;
  ps.minimumSpeed = 35 + 25 * t;
  ps.maximumSpeed = 70 + 55 * t;
}

function tuneSnowIntensity(mmPerHour) {
  const ps = WeatherState.snowSystem;
  if (!ps) return;
  const t = clamp01(mmPerHour / CONFIG.WEATHER.HEAVY_MM_H);
  ps.emissionRate = 900 + 2600 * t;
  ps.minimumSpeed = 0.4 + 0.9 * t;
  ps.maximumSpeed = 1.6 + 1.8 * t;
}

function rainDropSprite() {
  const w = 8, h = 36;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grd = ctx.createLinearGradient(w/2, 0, w/2, h);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = grd;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w/2, 2);
  ctx.lineTo(w/2, h - 2);
  ctx.stroke();
  return c.toDataURL('image/png');
}

function snowFlakeSprite() {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2;
  ctx.translate(s/2, s/2);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, s/2 - 2);
    ctx.stroke();
  }
  return c.toDataURL('image/png');
}

function updatePrecipModelMatrix() {
  const cam = SimState.viewer.camera;
  const m = Cesium.Matrix4.clone(cam.viewMatrix, new Cesium.Matrix4());
  Cesium.Matrix4.inverse(m, m);
  if (WeatherState.rainSystem) WeatherState.rainSystem.modelMatrix = m;
  if (WeatherState.snowSystem) WeatherState.snowSystem.modelMatrix = m;
}


// -----------------------------------------------------------------------------
// 8) Passenger setup panel + IFE tab (Leaflet map)
// -----------------------------------------------------------------------------

function buildPassengerPanel() {
  let panel = document.getElementById(CONFIG.PASSENGER.PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = CONFIG.PASSENGER.PANEL_ID;
    Object.assign(panel.style, {
      position: 'absolute',
      top: '60px', right: '16px',
      width: '360px', maxHeight: '80vh',
      overflow: 'auto',
      background: 'rgba(0,0,0,0.85)',
      color: '#fff',
      padding: '12px 14px',
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.1)',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      display: 'none',
      zIndex: 9999,
      backdropFilter: 'blur(4px)'
    });
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:700;font-size:16px;">Passenger tab setup</div>
        <button id="paxCloseBtn" style="background:#333;border:1px solid #555;color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label>Airline<input id="paxAirline" type="text" value="${SimState.paxConfig.airline}" style="width:100%"></label>
        <label>Aircraft<input id="paxAircraft" type="text" value="${SimState.paxConfig.aircraft}" style="width:100%"></label>
        <label>Flight #<input id="paxFlight" type="text" value="${SimState.paxConfig.flight}" style="width:100%"></label>
        <label>Origin ICAO<input id="paxOrigin" type="text" value="${SimState.paxConfig.origin}" style="width:100%"></label>
        <label>Destination ICAO<input id="paxDestination" type="text" value="${SimState.paxConfig.destination}" style="width:100%"></label>
        <label>Origin name<input id="paxOriginName" type="text" value="${SimState.paxConfig.originName}" style="width:100%"></label>
        <label>Destination name<input id="paxDestinationName" type="text" value="${SimState.paxConfig.destinationName}" style="width:100%"></label>
        <label>Sched. Dep (local)<input id="paxDepLocal" type="text" value="${SimState.paxConfig.departureLocal}" placeholder="e.g. 09:30" style="width:100%"></label>
        <label>Sched. Arr (local)<input id="paxArrLocal" type="text" value="${SimState.paxConfig.arrivalLocal}" placeholder="e.g. 11:45" style="width:100%"></label>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button id="${CONFIG.PASSENGER.BTN_ID}" style="flex:1;background:#198754;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;">Create Tab</button>
        <button id="paxRefreshBtn" style="flex:1;background:#0d6efd;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;">Reconnect</button>
      </div>
      <p style="margin-top:8px;color:#aaa;">Press "2" to show/hide this panel anytime.</p>
    `;
    document.body.appendChild(panel);
  }

  panel.querySelector('#paxCloseBtn')?.addEventListener('click', () => panel.style.display = 'none');

  document.getElementById(CONFIG.PASSENGER.BTN_ID)?.addEventListener('click', () => openPassengerTab());
  document.getElementById('paxRefreshBtn')?.addEventListener('click', () => {
    if (SimState.passengerWin && !SimState.passengerWin.closed) {
      startPassengerMessaging(true);
      SimState.passengerWin.focus();
    } else {
      alert('Passenger tab is not open. Click Create Tab first.');
    }
  });
}

function togglePassengerPanel() {
  const panel = document.getElementById(CONFIG.PASSENGER.PANEL_ID);
  if (!panel) return;
  panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
}

function openPassengerTab() {
  SimState.paxConfig.airline = document.getElementById('paxAirline').value.trim();
  SimState.paxConfig.aircraft = document.getElementById('paxAircraft').value.trim();
  SimState.paxConfig.flight = document.getElementById('paxFlight').value.trim();
  SimState.paxConfig.origin = document.getElementById('paxOrigin').value.trim().toUpperCase();
  SimState.paxConfig.destination = document.getElementById('paxDestination').value.trim().toUpperCase();
  SimState.paxConfig.originName = document.getElementById('paxOriginName').value.trim();
  SimState.paxConfig.destinationName = document.getElementById('paxDestinationName').value.trim();
  SimState.paxConfig.departureLocal = document.getElementById('paxDepLocal').value.trim();
  SimState.paxConfig.arrivalLocal = document.getElementById('paxArrLocal').value.trim();

  if (!SimState.passengerWin || SimState.passengerWin.closed) {
    SimState.passengerWin = window.open('', '_blank', 'noopener');
  } else {
    SimState.passengerWin.focus();
  }

  if (!SimState.passengerWin || SimState.passengerWin.closed) {
    alert('Pop-up blocked. Please allow pop-ups for this site.');
    return;
  }

  writePassengerWindow(SimState.passengerWin, SimState.paxConfig);
  startPassengerMessaging(true);
}

function writePassengerWindow(win, cfg) {
  if (!win || win.closed) return;
  const doc = win.document; if (!doc) return;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Passenger View — ${cfg.flight}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${CONFIG.PASSENGER.LEAFLET_CSS}">
<style>
html,body{margin:0;padding:0;background:#0b0d10;color:#e7e9ec;font-family:system-ui,sans-serif;}
header{padding:12px 16px;background:#11161a;border-bottom:1px solid #1a232b;display:flex;justify-content:space-between;align-items:center;}
.brand{font-size:16px;font-weight:700}.meta{font-size:13px;color:#b8c1ca}
main{display:grid;grid-template-columns:1fr;gap:12px;padding:12px}
.card{background:#0f1418;border:1px solid #182028;border-radius:8px;padding:12px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#map{height:360px;border-radius:8px}
.row{display:flex;justify-content:space-between;padding:4px 0}.label{color:#9aa7b4}.value{color:#e7e9ec;font-weight:700}
footer{padding:8px 16px;color:#95a2ae;font-size:12px}
</style>
</head><body>
<header><div><div class="brand" id="paxTitle">${cfg.airline} — ${cfg.aircraft}</div>
<div class="meta" id="paxSub">${cfg.flight} • ${cfg.origin} (${cfg.originName}) → ${cfg.destination} (${cfg.destinationName})</div></div>
<div class="meta">Dep: <span id="depLocal">${cfg.departureLocal||'--:--'}</span> • Arr: <span id="arrLocal">${cfg.arrivalLocal||'--:--'}</span></div></header>
<main>
  <div class="grid-2">
    <div class="card"><div id="map"></div></div>
    <div class="card">
      <div class="row"><div class="label">Position</div><div class="value"><span id="lat">--</span>, <span id="lon">--</span></div></div>
      <div class="row"><div class="label">Altitude</div><div class="value"><span id="alt">--</span> ft</div></div>
      <div class="row"><div class="label">Speed</div><div class="value"><span id="spd">--</span> kts</div></div>
      <div class="row"><div class="label">Heading</div><div class="value"><span id="hdg">--</span>°</div></div>
      <div class="row"><div class="label">Distance remaining</div><div class="value"><span id="distRem">--</span> nm</div></div>
      <div class="row"><div class="label">Time remaining</div><div class="value"><span id="timeRem">--</span></div></div>
      <div class="row"><div class="label">Weather</div><div class="value"><span id="wx">--</span></div></div>
    </div>
  </div>
  <div class="card" id="routeInfo">Route not loaded</div>
</main>
<footer>Passenger information display • Live position updates from the flight sim</footer>
<script src="${CONFIG.PASSENGER.LEAFLET_JS}"></script>
<script>
let map, aircraftMarker, routePolyline, tail;
function initMap(lat=38.78, lon=-9.13) {
  map = L.map('map', { zoomControl: true }).setView([lat, lon], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
  aircraftMarker = L.marker([lat, lon]).addTo(map);
  tail = L.polyline([], { color:'#0ff', weight:2, opacity:0.7 }).addTo(map);
}
function updateMap(lat, lon) {
  if (!map) initMap(lat, lon);
  aircraftMarker.setLatLng([lat, lon]);
  const pts = tail.getLatLngs(); pts.push([lat, lon]); if (pts.length > 2000) pts.shift(); tail.setLatLngs(pts);
}
function setRoute(coords) {
  if (!map) initMap(); if (routePolyline) routePolyline.remove();
  routePolyline = L.polyline(coords, { color:'#ff0', weight:2 }).addTo(map);
  map.fitBounds(routePolyline.getBounds().pad(0.2));
}
function setStats(data) {
  document.getElementById('lat').textContent = data.lat.toFixed(4);
  document.getElementById('lon').textContent = data.lon.toFixed(4);
  document.getElementById('alt').textContent = Math.round(data.altFt);
  document.getElementById('spd').textContent = Math.round(data.kts);
  document.getElementById('hdg').textContent = Math.round(data.hdgDeg);
  document.getElementById('distRem').textContent = data.distRemainingNm !== null ? Math.round(data.distRemainingNm) : '--';
  document.getElementById('timeRem').textContent = data.timeRemainingStr || '--';
  document.getElementById('wx').textContent = data.wx || '--';
}
function setMeta(cfg) {
  document.getElementById('paxTitle').textContent = cfg.airline + ' — ' + cfg.aircraft;
  document.getElementById('paxSub').textContent = cfg.flight + ' • ' + cfg.origin + ' (' + cfg.originName + ') → ' + cfg.destination + ' (' + cfg.destinationName + ')';
  document.getElementById('depLocal').textContent = cfg.departureLocal || '--:--';
  document.getElementById('arrLocal').textContent = cfg.arrivalLocal || '--:--';
}
function setRouteInfo(text) { document.getElementById('routeInfo').textContent = text; }
window.addEventListener('message',(evt)=>{
  const msg = evt.data||{};
  if (msg.type==='pax:init'){ setMeta(msg.cfg||{}); initMap(msg.lat||38.78,msg.lon||-9.13); }
  else if (msg.type==='pax:pos'){ updateMap(msg.lat,msg.lon); setStats(msg); }
  else if (msg.type==='pax:route'){ setRoute(msg.coords||[]); setRouteInfo(msg.info||'Route loaded'); }
  else if (msg.type==='pax:meta'){ setMeta(msg.cfg||{}); }
},false);
</script>
</body></html>`);
  doc.close();
}

let paxMessengerTimer = null;

function startPassengerMessaging(force = false) {
  if (paxMessengerTimer && !force) return;
  sendPassengerInit();
  if (paxMessengerTimer) clearInterval(paxMessengerTimer);
  paxMessengerTimer = setInterval(() => {
    sendPassengerUpdate();
  }, 1000);
}

function sendPassengerInit() {
  if (!SimState.passengerWin || SimState.passengerWin.closed) return;
  const lat = rad2deg(SimState.lat);
  const lon = rad2deg(SimState.lon);
  SimState.passengerWin.postMessage({
    type: 'pax:init',
    cfg: SimState.paxConfig,
    lat, lon
  }, '*');

  if (SimState.routePositions && SimState.routePositions.length > 1) {
    const coords = SimState.routePositions.map(c => {
      const carto = Cesium.Cartographic.fromCartesian(c);
      return [rad2deg(carto.latitude), rad2deg(carto.longitude)];
    });
    SimState.passengerWin.postMessage({
      type: 'pax:route',
      coords,
      info: `Route points: ${coords.length}`
    }, '*');
  }
}

function sendPassengerUpdate() {
  if (!SimState.passengerWin || SimState.passengerWin.closed) return;

  const latDeg = rad2deg(SimState.lat);
  const lonDeg = rad2deg(SimState.lon);
  const altFt = m2ft(SimState.height);
  const kts = ms2kts(SimState.speed);
  const hdgDeg = (rad2deg(SimState.heading) + 360) % 360;

  let distRemainingNm = null;
  if (SimState.routePositions && SimState.routePositions.length > 0) {
    const last = SimState.routePositions[SimState.routePositions.length - 1];
    const cur = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
    const dMeters = Cesium.Cartesian3.distance(cur, last);
    distRemainingNm = nmFromMeters(dMeters);
  }

  let timeRemainingStr = null;
  if (distRemainingNm !== null && kts > 1) {
    const hr = distRemainingNm / kts;
    const min = Math.round(hr * 60);
    const h = Math.floor(min / 60), m = min % 60;
    timeRemainingStr = `${h}h ${m}m`;
  }

  const wx = WeatherState.data ? `${WeatherState.condition}, ${WeatherState.cloudiness}% clouds, ${WeatherState.tempC.toFixed(0)}°C` : '';

  SimState.passengerWin.postMessage({
    type: 'pax:pos',
    lat: latDeg,
    lon: lonDeg,
    altFt, kts, hdgDeg,
    distRemainingNm,
    timeRemainingStr,
    wx
  }, '*');

  if (Math.random() < 0.05) {
    SimState.passengerWin.postMessage({ type: 'pax:meta', cfg: SimState.paxConfig }, '*');
  }
}


// -----------------------------------------------------------------------------
// 9) ATC (Gemini REST placeholder — no CORS import)
// -----------------------------------------------------------------------------

async function callGeminiATC(prompt) {
  if (!CONFIG.ATC.ENABLED || !CONFIG.ATC.GEMINI_API_KEY) return 'ATC offline (no API key set).';
  try {
    const res = await fetch(`${CONFIG.ATC.GEMINI_ENDPOINT}?key=${encodeURIComponent(CONFIG.ATC.GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }]}] })
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No ATC response.';
  } catch (e) {
    console.warn('Gemini ATC error:', e);
    return 'ATC unavailable.';
  }
}

async function openATCPrompt() {
  const callsign = SimState.paxConfig.flight || 'HW123';
  const posStr = `${rad2deg(SimState.lat).toFixed(3)}, ${rad2deg(SimState.lon).toFixed(3)}`;
  const kts = Math.round(ms2kts(SimState.speed));
  const hdg = Math.round((rad2deg(SimState.heading) + 360) % 360);
  const alt = Math.round(m2ft(SimState.height));
  const user = prompt('ATC request (e.g., "Request IFR clearance"):\nNote: Using client-side key is insecure. For production, use a server proxy.');
  if (!user) return;
  const promptText = `You are ATC. Aircraft: ${callsign}, pos ${posStr}, speed ${kts} kts, heading ${hdg}, altitude ${alt} ft. Pilot message: ${user}. Respond with concise, realistic ATC phraseology.`;
  const reply = await callGeminiATC(promptText);
  alert(`ATC: ${reply}`);
}


// -----------------------------------------------------------------------------
// 10) Joystick & Throttle UI
// -----------------------------------------------------------------------------

function setupJoystick() {
  const area = document.getElementById('joystick'); const stick = document.getElementById('stick');
  if (!area || !stick) return;
  let dragging = false; let center = { x: 0, y: 0 }, radius = 50;

  function setCenter() {
    const r = area.getBoundingClientRect();
    center.x = r.left + r.width / 2; center.y = r.top + r.height / 2;
    radius = Math.min(r.width, r.height) / 2 - 12;
  }
  setCenter(); window.addEventListener('resize', setCenter);

  function onMove(clientX, clientY) {
    const dx = clientX - center.x, dy = clientY - center.y;
    const dist = Math.min(Math.hypot(dx, dy), radius);
    const angle = Math.atan2(dy, dx);
    const px = Math.cos(angle) * dist, py = Math.sin(angle) * dist;
    stick.style.left = (center.x + px - 10) + 'px';
    stick.style.top = (center.y + py - 10) + 'px';

    // Map to controls: X -> roll, Y -> pitch (positive Y = nose down)
    const xNorm = px / radius; const yNorm = py / radius;
    SimState.roll += xNorm * 0.02;
    SimState.pitch += yNorm * 0.02;
  }

  function end(e) {
    dragging = false;
    const r = area.getBoundingClientRect();
    stick.style.left = (r.left + r.width/2 - 10) + 'px';
    stick.style.top = (r.top + r.height/2 - 10) + 'px';
  }

  area.addEventListener('pointerdown', (e) => { dragging = true; area.setPointerCapture(e.pointerId); onMove(e.clientX, e.clientY); });
  window.addEventListener('pointermove', (e) => { if (dragging) onMove(e.clientX, e.clientY); });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function setupThrottle() {
  const slider = document.getElementById('throttleSlider');
  if (!slider) return;
  slider.addEventListener('input', () => {
    SimState.thrustInput = clamp01(slider.value / 100);
  });
}


// -----------------------------------------------------------------------------
// 11) Main simulation loop (enforced motion + accurate HUD)
// -----------------------------------------------------------------------------

function onTick(clock) {
  // delta time
  const now = clock.currentTime;
  const dtRaw = SimState.lastTime ? Cesium.JulianDate.secondsDifference(now, SimState.lastTime) : 1/60;
  const dt = clamp(dtRaw, 0.001, 0.1);
  SimState.lastTime = now;

  // Weather updates (throttled inside)
  if (CONFIG.WEATHER.ENABLED) {
    updateWeather();
    updatePrecipModelMatrix();
  }

  // Thrust (Left Shift/Ctrl)
  if (SimState.keys['shiftleft']) SimState.thrustInput = Math.min(1, SimState.thrustInput + CONFIG.PHYSICS.THRUST_RAMP * dt);
  if (SimState.keys['controlleft']) SimState.thrustInput = Math.max(0, SimState.thrustInput - CONFIG.PHYSICS.THRUST_DECAY * dt);

  // Yaw (ground vs air rates)
  if (SimState.onGround) {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
  } else {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.MAX_YAW_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.MAX_YAW_RATE * dt;
  }

  // Pitch/Roll keys
  if (SimState.onGround) {
    if (SimState.keys['a']) SimState.roll -= 0.25 * dt;
    if (SimState.keys['d']) SimState.roll += 0.25 * dt;
    SimState.roll *= Math.pow(0.1, dt);
    SimState.pitch *= Math.pow(0.05, dt);
    if (SimState.speed >= CONFIG.PHYSICS.TAKEOFF_SPEED && SimState.keys['w']) {
      SimState.pitch = Math.max(SimState.pitch - 0.55 * dt, -Cesium.Math.PI_OVER_TWO * 0.4);
    }
    if (SimState.pitch > 0) SimState.pitch *= Math.pow(0.05, dt);
  } else {
    if (SimState.keys['a']) SimState.roll -= CONFIG.PHYSICS.MAX_BANK_RATE * dt;
    if (SimState.keys['d']) SimState.roll += CONFIG.PHYSICS.MAX_BANK_RATE * dt;
    if (SimState.keys['w']) SimState.pitch = Math.max(SimState.pitch - CONFIG.PHYSICS.MAX_PITCH_RATE * dt, -Cesium.Math.PI_OVER_TWO * 0.6);
    if (SimState.keys['s']) SimState.pitch = Math.min(SimState.pitch + CONFIG.PHYSICS.MAX_PITCH_RATE * dt,  Cesium.Math.PI_OVER_TWO * 0.6);
    SimState.roll *= Math.pow(CONFIG.PHYSICS.ROLL_DAMP_AIR, 60 * dt);
    SimState.pitch *= Math.pow(CONFIG.PHYSICS.PITCH_DAMP_AIR, 60 * dt);
  }

  // View toggle
  if (SimState.keys['v'] && SimState.canToggleView) {
    SimState.canToggleView = false;
    setTimeout(() => (SimState.canToggleView = true), 260);
    SimState.viewMode = SimState.viewMode === 'orbit' ? 'chase' : SimState.viewMode === 'chase' ? 'first' : 'orbit';
    if (viewLabel) viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1);
    SimState.viewer.trackedEntity = SimState.viewMode === 'orbit' ? SimState.planeEntity : undefined;
  }

  // Normalize heading
  if (SimState.heading > Math.PI) SimState.heading -= Math.PI * 2;
  if (SimState.heading < -Math.PI) SimState.heading += Math.PI * 2;

  // Autopilot (ALT hold)
  if (SimState.autopilot.enabled) {
    if (SimState.autopilot.targetAltM == null) SimState.autopilot.targetAltM = SimState.height;
    const err = SimState.autopilot.targetAltM - SimState.height;
    SimState.verticalSpeed += clamp(err * 0.02, -3, 3) * dt;
  }

  // Speed integration + enforced motion
  let accel = SimState.thrustInput * CONFIG.PHYSICS.MAX_THRUST_ACCEL - CONFIG.PHYSICS.DRAG_COEFF * SimState.speed;
  if (SimState.thrustInput > 0.02 && SimState.speed < CONFIG.PHYSICS.GROUND_STICTION_THRESH && SimState.onGround) {
    accel += CONFIG.PHYSICS.GROUND_STICTION_PUSH;
  }
  SimState.speed = Math.max(0, SimState.speed + accel * dt);

  // Lift / gravity
  const lift = CONFIG.PHYSICS.LIFT_COEFF * SimState.speed * Math.sin(-SimState.pitch);
  SimState.verticalSpeed += (lift - CONFIG.PHYSICS.G) * dt;
  if (SimState.onGround) SimState.verticalSpeed = Math.max(0, SimState.verticalSpeed);

  // Forward vector in ENU, horizontal on ground
  const cp = Math.cos(SimState.pitch);
  const ch = Math.cos(SimState.heading);
  const sh = Math.sin(SimState.heading);
  const sp = Math.sin(SimState.pitch);

  const forwardENU = new Cesium.Cartesian3(
    cp * ch,
    cp * sh,
    SimState.onGround ? 0.0 : sp
  );
  normalize3(forwardENU, forwardENU);

  const currentECEF = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
  const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, SimState.speed * dt, new Cesium.Cartesian3());
  disp.x *= SimState.onGround ? CONFIG.PHYSICS.SIDE_DRIFT_DAMP : 1.0;
  disp.y *= SimState.onGround ? CONFIG.PHYSICS.SIDE_DRIFT_DAMP : 1.0;

  const newECEF = Cesium.Cartesian3.add(currentECEF, disp, new Cesium.Cartesian3());
  const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

  SimState.lon = newCarto.longitude;
  SimState.lat = newCarto.latitude;

  let newHeight = (newCarto.height || 0) + SimState.verticalSpeed * dt;

  // Optional wind
  if (CONFIG.WEATHER.ENABLE_WIND && WeatherState.data && WeatherState.windSpeed > 0.05) {
    const toDirRad = deg2rad((WeatherState.windDirDeg + 180) % 360);
    const driftSpeed = WeatherState.windSpeed * CONFIG.WEATHER.WIND_SCALE;
    const driftENU = new Cesium.Cartesian3(
      Math.cos(toDirRad) * driftSpeed * dt,
      Math.sin(toDirRad) * driftSpeed * dt,
      0
    );
    const driftECEF = Cesium.Matrix3.multiplyByVector(enuRot, driftENU, new Cesium.Cartesian3());
    const driftedECEF = Cesium.Cartesian3.add(Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, newHeight), driftECEF, new Cesium.Cartesian3());
    const drifted = Cesium.Cartographic.fromCartesian(driftedECEF);
    SimState.lon = drifted.longitude;
    SimState.lat = drifted.latitude;
    newHeight = drifted.height;
  }

  // Terrain clamp (throttled)
  let willCommit = true;
  SimState.sampleCounter = (SimState.sampleCounter + 1) % CONFIG.SAMPLING.TERRAIN_STEPS;
  if (SimState.sampleCounter === 0 && !SimState.sampling) {
    SimState.sampling = true;
    willCommit = false;
    Cesium.sampleTerrainMostDetailed(SimState.viewer.terrainProvider, [new Cesium.Cartographic(SimState.lon, SimState.lat)])
      .then((s) => {
        const th = s?.[0]?.height ?? 0;
        const groundH = th + CONFIG.PHYSICS.GEAR_HEIGHT;
        if (newHeight <= groundH) {
          newHeight = groundH;
          SimState.verticalSpeed = 0;
          SimState.onGround = true;
        } else {
          SimState.onGround = false;
        }
        if (groundLabel) groundLabel.textContent = SimState.onGround ? 'Yes' : 'No';
        commitPose(newHeight);
      })
      .catch(() => {
        SimState.onGround = false;
        if (groundLabel) groundLabel.textContent = 'Unknown';
        commitPose(newHeight);
      })
      .finally(() => {
        SimState.sampling = false;
      });
  }

  if (willCommit) {
    newHeight = Math.max(newHeight, 1.0);
    commitPose(newHeight);
  }

  updateDebugOverlay();
}


// -----------------------------------------------------------------------------
// 12) Commit pose + camera + HUD (accurate values)
// -----------------------------------------------------------------------------

function commitPose(h) {
  SimState.height = h;

  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const quat = hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll);

  SimState.planeEntity.position = pos;
  SimState.planeEntity.orientation = quat;

  // Camera
  if (SimState.viewMode === 'orbit') {
    // trackedEntity handles camera
  } else {
    const AXIS_X = new Cesium.Cartesian3(1, 0, 0);
    const AXIS_Z = new Cesium.Cartesian3(0, 0, 1);
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    const forward = Cesium.Matrix3.multiplyByVector(m3, AXIS_X, new Cesium.Cartesian3());
    const up = Cesium.Matrix3.multiplyByVector(m3, AXIS_Z, new Cesium.Cartesian3());

    const camPos = new Cesium.Cartesian3();
    if (SimState.viewMode === 'chase') {
      camPos.x = pos.x - forward.x * CONFIG.CAMERA.CHASE_BACK + up.x * CONFIG.CAMERA.CHASE_UP;
      camPos.y = pos.y - forward.y * CONFIG.CAMERA.CHASE_BACK + up.y * CONFIG.CAMERA.CHASE_UP;
      camPos.z = pos.z - forward.z * CONFIG.CAMERA.CHASE_BACK + up.z * CONFIG.CAMERA.CHASE_UP;
    } else {
      camPos.x = pos.x + forward.x * CONFIG.CAMERA.FP_AHEAD + up.x * CONFIG.CAMERA.FP_UP;
      camPos.y = pos.y + forward.y * CONFIG.CAMERA.FP_AHEAD + up.y * CONFIG.CAMERA.FP_UP;
      camPos.z = pos.z + forward.z * CONFIG.CAMERA.FP_AHEAD + up.z * CONFIG.CAMERA.FP_UP;
    }

    const t = 1 - Math.pow(CONFIG.CAMERA.SMOOTH_FACTOR, 60 * (1/60));
    if (!SimState.camPosSmooth) SimState.camPosSmooth = camPos.clone();
    SimState.camPosSmooth.x += (camPos.x - SimState.camPosSmooth.x) * t;
    SimState.camPosSmooth.y += (camPos.y - SimState.camPosSmooth.y) * t;
    SimState.camPosSmooth.z += (camPos.z - SimState.camPosSmooth.z) * t;

    const toTarget = Cesium.Cartesian3.subtract(pos, SimState.camPosSmooth, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(toTarget, toTarget);

    SimState.viewer.camera.setView({
      destination: SimState.camPosSmooth,
      orientation: {
        direction: toTarget,
        up: up
      }
    });
  }

  // Keep cloud ring centered
  if (WeatherState.cloudBillboards && WeatherState.cloudBillboards.length > 0) {
    createOrUpdateCloudSprites({
      cloudiness: WeatherState.cloudiness || 0,
      altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
      radius: CONFIG.WEATHER.CLOUD_RADIUS_M
    });
  }

  // HUD (accurate)
  const speedEl = document.getElementById('speed');
  const altEl = document.getElementById('altitude');
  const hdgEl = document.getElementById('heading');
  if (speedEl) speedEl.textContent = `${Math.round(ms2kts(SimState.speed))}`;
  if (altEl) altEl.textContent = `${Math.round(m2ft(SimState.height))}`;
  if (hdgEl) hdgEl.textContent = `${Math.round((rad2deg(SimState.heading) + 360) % 360)}`;

  SimState.viewer.scene.requestRender();
}


// -----------------------------------------------------------------------------
// 13) Autopilot + helpers
// -----------------------------------------------------------------------------

function toggleAutopilot() {
  SimState.autopilot.enabled = !SimState.autopilot.enabled;
  if (SimState.autopilot.enabled) {
    SimState.autopilot.targetAltM = SimState.height;
    alert(`Autopilot ALT HOLD enabled at ${Math.round(m2ft(SimState.height))} ft.`);
  } else {
    alert('Autopilot disabled.');
  }
}

function resetToRunway() {
  SimState.heading = deg2rad(CONFIG.SPAWN.HEADING_DEG);
  SimState.pitch = 0;
  SimState.roll = 0;
  SimState.speed = 0;
  SimState.verticalSpeed = 0;
  SimState.thrustInput = 0;
  SimState.onGround = true;
  SimState.lon = deg2rad(CONFIG.SPAWN.LON_DEG);
  SimState.lat = deg2rad(CONFIG.SPAWN.LAT_DEG);

  Cesium.sampleTerrainMostDetailed(SimState.viewer.terrainProvider, [new Cesium.Cartographic(SimState.lon, SimState.lat)])
    .then((samples) => {
      const th = samples?.[0]?.height ?? 0;
      SimState.height = th + CONFIG.PHYSICS.GEAR_HEIGHT;
      commitPose(SimState.height);
      SimState.viewer.trackedEntity = SimState.viewMode === 'orbit' ? SimState.planeEntity : undefined;
      if (viewLabel) viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1);
    })
    .catch(() => {
      SimState.height = CONFIG.PHYSICS.GEAR_HEIGHT;
      commitPose(SimState.height);
    });
}


// -----------------------------------------------------------------------------
// 14) Developer helpers (optional)
// -----------------------------------------------------------------------------

window.A330SIM = {
  resetToRunway,
  toggleAutopilot: () => toggleAutopilot(),
  setThrust: (t) => { SimState.thrustInput = clamp01(t); },
  setView: (mode) => {
    if (!['orbit','chase','first'].includes(mode)) return;
    SimState.viewMode = mode;
    SimState.viewer.trackedEntity = mode === 'orbit' ? SimState.planeEntity : undefined;
    if (viewLabel) viewLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  },
  debug: (on) => { DebugState.enabled = !!on; if (on) createDebugOverlay(); else toggleDebug(); }
};


// -----------------------------------------------------------------------------
// 15) End of script
// -----------------------------------------------------------------------------
//
// Usage notes:
// - Provide a valid Cesium ion token and model asset ID.
// - Use Left Shift/Ctrl for thrust; WASD + QE for attitude/yaw.
// - Press 2 or click Passenger Info to configure and open the IFE tab.
// - Click Autopilot to hold current altitude.
// - If you want SimBrief integration next, we can wire it into the routePositions and the IFE.
// - For production ATC, proxy Gemini requests server-side to hide your API key.
//
// Enjoy the flight.
//
