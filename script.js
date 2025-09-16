// script.js
// ==================================================================================================
// Headwind A330-900neo Cesium flight sim — extended build with:
// - Fixed thrust and forward motion aligned to heading (no sideways drift)
// - Accurate runway-aligned spawn using terrain sampling (LPPT RWY 03 default)
// - Open‑Meteo live weather (no API key): clouds, rain/snow particles, sky tint
// - Camera modes (Orbit/Chase/First), HUD, debug overlay, performance throttles
// - Passenger tab system:
//     * Press "2" to open a right-side setup panel inside the sim
//     * Choose Airline, Aircraft, Destination/Arrival details
//     * Press "Create Tab" to open a separate browser tab with IFE-style passenger page
//     * Passenger page shows live map (Leaflet.js), route progress, air data
//
// Integration reminders:
//   - Replace CONFIG.CESIUM_TOKEN and CONFIG.MODEL.AIRCRAFT_ASSET_ID
//   - Ensure HTML contains: #login, #loginForm, #password, #loading, #cesiumContainer, #hud + spans
//   - This script lazy-loads Leaflet for the IFE tab automatically
//
// Keyboard:
//   - Throttle: ArrowUp/ArrowDown
//   - Pitch: W/S (negative pitch = nose up)
//   - Roll: A/D
//   - Yaw: Q/E
//   - View: V (Orbit -> Chase -> First)
//   - Toggle Passenger setup panel: 2
//   - Debug overlay toggle: ` (backtick) or F8
//
// ==================================================================================================



// ==================================================================================================
// 0) Login flow
// ==================================================================================================

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
      alert('Failed to initialize. See console.');
      loadingOverlay?.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});



// ==================================================================================================
// 1) Configuration
// ==================================================================================================

const CONFIG = {
  // Cesium ion access
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ', // <-- paste your Cesium ion token here

  // Terrain
  USE_FLAT_TERRAIN: false,

  // Spawn (LPPT runway 03 threshold; adjust to your runway if desired)
  SPAWN: {
    LON_DEG: -9.13580,
    LAT_DEG: 38.78120,
    HEADING_DEG: 30.0 // runway 03 ~030°
  },

  // Model (Cesium ion asset)
  MODEL: {
    AIRCRAFT_ASSET_ID: '3713684', // <-- replace with your Cesium ion asset ID (number)
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
    MAX_THRUST_ACCEL: 12.0,
    DRAG_COEFF: 0.006,
    LIFT_COEFF: 0.95,
    GEAR_HEIGHT: 2.8,
    TAKEOFF_SPEED: 75.0,
    MAX_BANK_RATE: 0.9,
    MAX_PITCH_RATE: 0.75,
    MAX_YAW_RATE: 0.9,
    GROUND_STEER_RATE: 0.8,
    THRUST_RAMP: 2.0,
    THRUST_DECAY: 2.0,
    SIDE_DRIFT_DAMP: 0.9,
    ROLL_DAMP_AIR: 0.995,
    PITCH_DAMP_AIR: 0.995
  },

  // Camera
  CAMERA: {
    CHASE_BACK: 200.0,
    CHASE_UP: 65.0,
    FP_AHEAD: 8.0,
    FP_UP: 2.4,
    SMOOTH_FACTOR: 0.02
  },

  // Weather (Open-Meteo)
  WEATHER: {
    ENABLED: true,
    UPDATE_SECONDS: 180,
    CLOUDS_OVERCAST_THRESHOLD: 75,
    CLOUD_LAYER_ALT_M: 1600,
    CLOUD_RADIUS_M: 1700,
    CLOUD_SPRITES_MAX: 34,
    PRECIP_MIN: 0.05,
    HEAVY_MM_H: 3.5,
    SNOW_TEMP_C: 0.0,
    ENABLE_WIND: false,
    WIND_SCALE: 0.14
  },

  // Debug overlay
  DEBUG: {
    ENABLED: false,
    ELEMENT_ID: 'debugOverlay'
  },

  // Sampling
  SAMPLING: {
    TERRAIN_STEPS: 8
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
  }
};



// ==================================================================================================
// 2) Utilities
// ==================================================================================================

const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const nmFromMeters = (m) => m / 1852;

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



// ==================================================================================================
// 3) State
// ==================================================================================================

const SimState = {
  viewer: null,
  planeEntity: null,

  // Pose
  heading: deg2rad(CONFIG.SPAWN.HEADING_DEG),
  pitch: 0.0, // negative = nose up
  roll: 0.0,

  // Speeds
  speed: 0.0,          // forward m/s
  verticalSpeed: 0.0,  // m/s
  thrustInput: 0.0,    // 0..1

  onGround: true,

  // Position
  lon: deg2rad(CONFIG.SPAWN.LON_DEG),
  lat: deg2rad(CONFIG.SPAWN.LAT_DEG),
  height: 0.0,

  // Time
  lastTime: undefined,

  // Camera
  viewMode: 'orbit',
  canToggleView: true,
  camPosSmooth: null,

  // Input
  keys: {},

  // Terrain sampling throttle
  sampleCounter: 0,
  sampling: false,

  // Passenger tab bridge
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

  // Route (optional): can be populated from SimBrief later
  routePositions: [], // array of Cesium.Cartesian3 for route polyline
  routeEntity: null
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



// ==================================================================================================
// 4) Input
// ==================================================================================================

document.addEventListener('keydown', (e) => {
  SimState.keys[e.key] = true;
  if (e.key === '`' || e.key === 'F8') {
    toggleDebug();
  }
  if (e.key === '2') {
    togglePassengerPanel();
  }
});
document.addEventListener('keyup', (e) => (SimState.keys[e.key] = false));



// ==================================================================================================
// 5) Debug overlay
// ==================================================================================================

function createDebugOverlay() {
  if (!DebugState.enabled) return;
  let el = document.getElementById(CONFIG.DEBUG.ELEMENT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONFIG.DEBUG.ELEMENT_ID;
    el.style.position = 'absolute';
    el.style.left = '10px';
    el.style.bottom = '10px';
    el.style.background = 'rgba(0,0,0,0.5)';
    el.style.color = 'white';
    el.style.padding = '8px 10px';
    el.style.font = '12px/1.4 monospace';
    el.style.borderRadius = '6px';
    el.style.whiteSpace = 'pre';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
  }
  DebugState.el = el;
}

function updateDebugOverlay() {
  if (!DebugState.enabled || !DebugState.el) return;
  const lines = [
    `Thrust: ${SimState.thrustInput.toFixed(2)}`,
    `Speed: ${SimState.speed.toFixed(1)} m/s  (${(SimState.speed * 1.94384).toFixed(0)} kts)`,
    `V/S: ${SimState.verticalSpeed.toFixed(2)} m/s`,
    `Pitch: ${rad2deg(SimState.pitch).toFixed(1)}°  Roll: ${rad2deg(SimState.roll).toFixed(1)}°`,
    `Heading: ${rad2deg(SimState.heading).toFixed(1)}°`,
    `Ground: ${SimState.onGround ? 'Yes' : 'No'}`,
    `Lon/Lat: ${rad2deg(SimState.lon).toFixed(6)}, ${rad2deg(SimState.lat).toFixed(6)}  Alt: ${SimState.height.toFixed(1)} m`,
    WeatherState.data ? `WX: ${WeatherState.condition}  Clouds: ${WeatherState.cloudiness}%  P(mm/h): ${WeatherState.precipRate.toFixed(2)}` : 'WX: n/a',
    WeatherState.data && CONFIG.WEATHER.ENABLE_WIND ? `Wind: ${WeatherState.windSpeed.toFixed(1)} m/s @ ${WeatherState.windDirDeg.toFixed(0)}° (FROM)` : ''
  ];
  DebugState.el.textContent = lines.join('\n');
}

function toggleDebug() {
  DebugState.enabled = !DebugState.enabled;
  if (DebugState.enabled && !DebugState.el) createDebugOverlay();
  if (!DebugState.enabled && DebugState.el) {
    DebugState.el.remove();
    DebugState.el = null;
  }
}



// ==================================================================================================
// 6) Initialization
// ==================================================================================================

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

  if (CONFIG.VIEWER.DEPTH_TEST_TERRAIN) {
    viewer.scene.globe.depthTestAgainstTerrain = true;
  }

  if (CONFIG.VIEWER.OSM_BUILDINGS) {
    try {
      const osm = await Cesium.createOsmBuildingsAsync();
      viewer.scene.primitives.add(osm);
    } catch (e) {
      console.warn('OSM buildings failed:', e);
    }
  }

  // Sample terrain to place the aircraft on ground + gear height
  const startCarto = new Cesium.Cartographic(SimState.lon, SimState.lat);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples?.[0]?.height ?? 0;
  } catch {
    terrainH = 0;
  }
  SimState.height = terrainH + CONFIG.PHYSICS.GEAR_HEIGHT;

  // Load aircraft model
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const modelUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
  const planeEntity = viewer.entities.add({
    position: pos,
    model: {
      uri: modelUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: CONFIG.MODEL.RUN_ANIMATIONS
    },
    orientation: hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll)
  });
  SimState.planeEntity = planeEntity;

  // Initial camera: orbit around entity
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 450)
    });
  } catch {}
  viewer.trackedEntity = planeEntity;
  viewLabel && (viewLabel.textContent = 'Orbit');

  // Loading overlay off
  loadingOverlay?.classList.add('hidden');

  // Camera smoothing seed
  SimState.camPosSmooth = viewer.camera.positionWC.clone();

  // Weather init
  if (CONFIG.WEATHER.ENABLED) {
    await initWeather();
  }

  // Build passenger setup panel (hidden by default)
  buildPassengerPanel();

  // Debug overlay
  createDebugOverlay();

  // Main loop
  viewer.clock.onTick.addEventListener(onTick);
}



// ==================================================================================================
// 7) Weather (Open-Meteo)
// ==================================================================================================

async function initWeather() {
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  createOrUpdateCloudSprites({ cloudiness: 0, altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M, radius: CONFIG.WEATHER.CLOUD_RADIUS_M });
  await updateWeather(true);
}

async function fetchOpenMeteo(latDeg, lonDeg) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDeg}&longitude=${lonDeg}&current=temperature_2m,precipitation,cloudcover,wind_direction_10m,wind_speed_10m&timezone=auto`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const j = await res.json();
    const c = j.current || {};
    const clouds = Number.isFinite(c.cloudcover) ? c.cloudcover : 0;
    const tempC = Number.isFinite(c.temperature_2m) ? c.temperature_2m : 15;
    const precip = Number.isFinite(c.precipitation) ? c.precipitation : 0;
    const windDir = Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : 0;
    const windSpd = Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : 0;
    const condition = precip > CONFIG.WEATHER.PRECIP_MIN
      ? (tempC <= CONFIG.WEATHER.SNOW_TEMP_C ? 'Snow' : 'Rain')
      : (clouds >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD ? 'Clouds' : 'Clear');
    return { clouds, tempC, precipRate: precip, windDirDeg: windDir, windSpeed: windSpd, condition };
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
  const clouds = WeatherState.cloudiness;
  const precip = WeatherState.precipRate;
  const tempC = WeatherState.tempC;

  // Overcast atmosphere tint
  const atm = v.scene.skyAtmosphere;
  const overcast = clouds >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD;
  atm.hueShift = overcast ? -0.02 : 0.0;
  atm.saturationShift = overcast ? -0.2 : 0.0;
  atm.brightnessShift = overcast ? -0.1 : 0.0;

  // Cloud sprites
  createOrUpdateCloudSprites({
    cloudiness: clouds,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });

  // Precipitation
  const isSnow = (tempC <= CONFIG.WEATHER.SNOW_TEMP_C) && (precip > CONFIG.WEATHER.PRECIP_MIN);
  const isRain = (tempC > CONFIG.WEATHER.SNOW_TEMP_C) && (precip > CONFIG.WEATHER.PRECIP_MIN);

  if (isRain) {
    ensureRainSystem(true);
    ensureSnowSystem(false);
    tuneRainIntensity(precip);
  } else if (isSnow) {
    ensureRainSystem(false);
    ensureSnowSystem(true);
    tuneSnowIntensity(precip);
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
      color: Cesium.Color.WHITE.withAlpha(0.88),
      sizeInMeters: true
    });
  }
  while (bbs.length > target) {
    bbs.remove(bbs.get(bbs.length - 1));
  }

  if (target > 0) {
    const center = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height + altitudeAGL);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const spriteBase = 200;
    const spriteSize = spriteBase + (cloudiness / 100) * 240;
    for (let i = 0; i < bbs.length; i++) {
      const angle = i / bbs.length * Math.PI * 2;
      const r = radius * (0.8 + Math.random() * 0.4);
      const local = new Cesium.Cartesian3(
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        (Math.random() - 0.5) * 150
      );
      const world = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.position = world;
      bb.width = spriteSize;
      bb.height = spriteSize * 0.55;
      bb.alignedAxis = Cesium.Cartesian3.UNIT_Z;
    }
  }
}

function generateCloudSprite() {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  function blob(cx, cy, rx, ry, a) {
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  blob(70, 70, 70, 40, 0.92);
  blob(120, 60, 60, 36, 0.88);
  blob(160, 75, 60, 32, 0.84);
  blob(110, 85, 100, 36, 0.78);
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
      emissionRate: 3200,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(15.0)),
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
      startScale: 0.8,
      endScale: 0.8,
      minimumParticleLife: 1.2,
      maximumParticleLife: 2.2,
      minimumSpeed: 0.6,
      maximumSpeed: 2.2,
      emissionRate: 1600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(25.0)),
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
  ps.emissionRate = 1600 + 6400 * t;
  ps.minimumSpeed = 35 + 25 * t;
  ps.maximumSpeed = 70 + 50 * t;
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
  grd.addColorStop(1, 'rgba(255,255,255,0.0)');
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



// ==================================================================================================
// 8) Passenger setup panel + IFE tab
// ==================================================================================================

function buildPassengerPanel() {
  // Create panel container
  let panel = document.getElementById(CONFIG.PASSENGER.PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = CONFIG.PASSENGER.PANEL_ID;
    panel.style.position = 'absolute';
    panel.style.top = '60px';
    panel.style.right = '16px';
    panel.style.width = '340px';
    panel.style.maxHeight = '80vh';
    panel.style.overflow = 'auto';
    panel.style.background = 'rgba(0,0,0,0.85)';
    panel.style.color = '#fff';
    panel.style.padding = '12px 14px';
    panel.style.borderRadius = '8px';
    panel.style.fontFamily = 'system-ui, sans-serif';
    panel.style.fontSize = '14px';
    panel.style.display = 'none';
    panel.style.zIndex = '9999';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:600;font-size:16px;">Passenger tab setup</div>
        <button id="paxCloseBtn" style="background:#444;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;">✕</button>
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
        <button id="${CONFIG.PASSENGER.BTN_ID}" style="flex:1;background:#198754;color:#fff;border:none;padding:8px;border-radius:6px;cursor:pointer;">Create Tab</button>
        <button id="paxRefreshBtn" style="flex:1;background:#0d6efd;color:#fff;border:none;padding:8px;border-radius:6px;cursor:pointer;">Reconnect</button>
      </div>
      <p style="margin-top:8px;color:#aaa;">Tip: Press "2" anytime to show/hide this panel.</p>
    `;
    document.body.appendChild(panel);
  }

  // Close button
  panel.querySelector('#paxCloseBtn')?.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  // Create Tab button
  document.getElementById(CONFIG.PASSENGER.BTN_ID)?.addEventListener('click', async () => {
    // Update config from inputs
    SimState.paxConfig.airline = document.getElementById('paxAirline').value.trim();
    SimState.paxConfig.aircraft = document.getElementById('paxAircraft').value.trim();
    SimState.paxConfig.flight = document.getElementById('paxFlight').value.trim();
    SimState.paxConfig.origin = document.getElementById('paxOrigin').value.trim().toUpperCase();
    SimState.paxConfig.destination = document.getElementById('paxDestination').value.trim().toUpperCase();
    SimState.paxConfig.originName = document.getElementById('paxOriginName').value.trim();
    SimState.paxConfig.destinationName = document.getElementById('paxDestinationName').value.trim();
    SimState.paxConfig.departureLocal = document.getElementById('paxDepLocal').value.trim();
    SimState.paxConfig.arrivalLocal = document.getElementById('paxArrLocal').value.trim();

    // Lazy-load Leaflet in the main page as well (for icon CSS reuse if needed)
    await ensureLeafletLoaded();

    // Open or reuse passenger window
    if (!SimState.passengerWin || SimState.passengerWin.closed) {
      SimState.passengerWin = window.open('', '_blank', 'noopener,noreferrer');
    } else {
      SimState.passengerWin.focus();
    }

    // Inject IFE HTML
    writePassengerWindow(SimState.passengerWin, SimState.paxConfig);

    // Start messaging loop to the passenger tab
    startPassengerMessaging();
  });

  // Reconnect button
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
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function ensureLeafletLoaded() {
  // If L exists, assume loaded
  if (typeof window.L !== 'undefined') return;
  await loadExternalStyle(CONFIG.PASSENGER.LEAFLET_CSS);
  await loadExternalScript(CONFIG.PASSENGER.LEAFLET_JS);
}

function writePassengerWindow(win, cfg) {
  // Base HTML with Leaflet placeholders
  const doc = win.document;
  doc.open();
  doc.write(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Passenger View — ${cfg.flight}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${CONFIG.PASSENGER.LEAFLET_CSS}">
  <style>
    html, body { margin:0; padding:0; background:#0b0d10; color:#e7e9ec; font-family:system-ui, sans-serif; }
    header { padding:12px 16px; background:#11161a; border-bottom:1px solid #1a232b; display:flex; justify-content:space-between; align-items:center; }
    .brand { font-size:16px; font-weight:600; }
    .meta { font-size:13px; color:#b8c1ca; }
    main { display:grid; grid-template-columns: 1fr; gap:12px; padding:12px; }
    .card { background:#0f1418; border:1px solid #182028; border-radius:8px; padding:12px; }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    #map { height: 360px; border-radius:8px; }
    .row { display:flex; justify-content:space-between; padding:4px 0; }
    .label { color:#9aa7b4; }
    .value { color:#e7e9ec; font-weight:600; }
    footer { padding:8px 16px; color:#95a2ae; font-size:12px; }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="brand" id="paxTitle">${cfg.airline} — ${cfg.aircraft}</div>
      <div class="meta" id="paxSub">${cfg.flight} • ${cfg.origin} (${cfg.originName}) → ${cfg.destination} (${cfg.destinationName})</div>
    </div>
    <div class="meta">
      Dep: <span id="depLocal">${cfg.departureLocal || '--:--'}</span> • Arr: <span id="arrLocal">${cfg.arrivalLocal || '--:--'}</span>
    </div>
  </header>

  <main>
    <div class="grid-2">
      <div class="card">
        <div id="map"></div>
      </div>
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
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
      aircraftMarker = L.marker([lat, lon]).addTo(map);
      tail = L.polyline([], { color:'#0ff', weight:2, opacity:0.7 }).addTo(map);
    }
    function updateMap(lat, lon) {
      if (!map) initMap(lat, lon);
      aircraftMarker.setLatLng([lat, lon]);
      const pts = tail.getLatLngs();
      pts.push([lat, lon]);
      if (pts.length > 2000) pts.shift();
      tail.setLatLngs(pts);
    }
    function setRoute(coords) {
      if (!map) initMap();
      if (routePolyline) { routePolyline.remove(); }
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
    function setRouteInfo(text) {
      document.getElementById('routeInfo').textContent = text;
    }

    // Message bus
    window.addEventListener('message', (evt) => {
      const msg = evt.data || {};
      if (msg.type === 'pax:init') {
        setMeta(msg.cfg || {});
        initMap(msg.lat || 38.78, msg.lon || -9.13);
      } else if (msg.type === 'pax:pos') {
        updateMap(msg.lat, msg.lon);
        setStats(msg);
      } else if (msg.type === 'pax:route') {
        setRoute(msg.coords || []);
        setRouteInfo(msg.info || 'Route loaded');
      } else if (msg.type === 'pax:meta') {
        setMeta(msg.cfg || {});
      }
    }, false);
  </script>
</body>
</html>
  `);
  doc.close();
}

let paxMessengerTimer = null;
function startPassengerMessaging(force = false) {
  // Start periodic postMessage of position and stats
  if (paxMessengerTimer && !force) return;

  // Send initial meta and bootstrap
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

  // Send route if available
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
  const altFt = SimState.height * 3.28084;
  const kts = SimState.speed * 1.94384;
  const hdgDeg = (rad2deg(SimState.heading) + 360) % 360;

  // If route + destination known, compute naive remaining distance to last route point
  let distRemainingNm = null;
  if (SimState.routePositions && SimState.routePositions.length > 0) {
    const last = SimState.routePositions[SimState.routePositions.length - 1];
    const cur = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
    const dMeters = Cesium.Cartesian3.distance(cur, last);
    distRemainingNm = nmFromMeters(dMeters);
  }

  // Naive time remaining (min)
  let timeRemainingStr = null;
  if (distRemainingNm !== null && kts > 1) {
    const hr = distRemainingNm / kts;
    const min = Math.round(hr * 60);
    const h = Math.floor(min / 60), m = min % 60;
    timeRemainingStr = `${h}h ${m}m`;
  }

  // Weather summary
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

  // Periodically resend meta in case of tab refresh
  if (Math.random() < 0.05) {
    SimState.passengerWin.postMessage({ type: 'pax:meta', cfg: SimState.paxConfig }, '*');
  }
}



// ==================================================================================================
// 9) Main simulation loop
// ==================================================================================================

function onTick(clock) {
  // dt
  const now = clock.currentTime;
  const dtRaw = SimState.lastTime ? Cesium.JulianDate.secondsDifference(now, SimState.lastTime) : 1/60;
  const dt = clamp(dtRaw, 0.001, 0.1);
  SimState.lastTime = now;

  // Weather
  if (CONFIG.WEATHER.ENABLED) {
    updateWeather();
    updatePrecipModelMatrix();
  }

  // Controls: thrust
  if (SimState.keys['ArrowUp']) SimState.thrustInput = Math.min(1, SimState.thrustInput + CONFIG.PHYSICS.THRUST_RAMP * dt);
  if (SimState.keys['ArrowDown']) SimState.thrustInput = Math.max(0, SimState.thrustInput - CONFIG.PHYSICS.THRUST_DECAY * dt);

  // Controls: yaw
  if (SimState.onGround) {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
  } else {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.MAX_YAW_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.MAX_YAW_RATE * dt;
  }

  // Controls: pitch/roll
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

  // View mode toggle
  if (SimState.keys['v'] && SimState.canToggleView) {
    SimState.canToggleView = false;
    setTimeout(() => (SimState.canToggleView = true), 260);
    SimState.viewMode = SimState.viewMode === 'orbit' ? 'chase' : SimState.viewMode === 'chase' ? 'first' : 'orbit';
    viewLabel && (viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1));
    SimState.viewer.trackedEntity = SimState.viewMode === 'orbit' ? SimState.planeEntity : undefined;
  }

  // Normalize heading
  if (SimState.heading > Math.PI) SimState.heading -= Math.PI * 2;
  if (SimState.heading < -Math.PI) SimState.heading += Math.PI * 2;

  // Physics: forward speed integration
  const accel = SimState.thrustInput * CONFIG.PHYSICS.MAX_THRUST_ACCEL - CONFIG.PHYSICS.DRAG_COEFF * SimState.speed;
  SimState.speed = Math.max(0, SimState.speed + accel * dt);

  // Lift vs gravity (negative pitch => nose up)
  const lift = CONFIG.PHYSICS.LIFT_COEFF * SimState.speed * Math.sin(-SimState.pitch);
  SimState.verticalSpeed += (lift - CONFIG.PHYSICS.G) * dt;
  if (SimState.onGround) SimState.verticalSpeed = Math.max(0, SimState.verticalSpeed);

  // Motion integration in ENU
  const cp = Math.cos(SimState.pitch);
  const ch = Math.cos(SimState.heading);
  const sh = Math.sin(SimState.heading);
  const sp = Math.sin(SimState.pitch);

  const forwardENU = new Cesium.Cartesian3(
    cp * ch,
    cp * sh,
    SimState.onGround ? 0.0 : sp // keep horizontal while on ground
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

  // Optional wind drift
  if (CONFIG.WEATHER.ENABLE_WIND && WeatherState.data && WeatherState.windSpeed > 0.05) {
    const toDirRad = deg2rad((WeatherState.windDirDeg + 180) % 360);
    const driftSpeed = WeatherState.windSpeed * CONFIG.WEATHER.WIND_SCALE;
    const driftENU = new Cesium.Cartesian3(Math.cos(toDirRad) * driftSpeed * dt, Math.sin(toDirRad) * driftSpeed * dt, 0);
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
        groundLabel && (groundLabel.textContent = SimState.onGround ? 'Yes' : 'No');
        commitPose(newHeight);
      })
      .catch(() => {
        SimState.onGround = false;
        groundLabel && (groundLabel.textContent = 'Unknown');
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

  // Debug overlay
  updateDebugOverlay();

  // Keep passenger tab updated if open
  if (SimState.passengerWin && !SimState.passengerWin.closed) {
    // periodic updates handled by startPassengerMessaging timer
  }
}



// ==================================================================================================
// 10) Commit pose + camera + HUD
// ==================================================================================================

function commitPose(h) {
  SimState.height = h;

  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const quat = hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll);

  // Update entity
  SimState.planeEntity.position = pos;
  SimState.planeEntity.orientation = quat;

  // Camera control
  if (SimState.viewMode === 'orbit') {
    // trackedEntity manages orbit
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
    SimState.camPosSmooth.x = SimState.camPosSmooth.x + (camPos.x - SimState.camPosSmooth.x) * t;
    SimState.camPosSmooth.y = SimState.camPosSmooth.y + (camPos.y - SimState.camPosSmooth.y) * t;
    SimState.camPosSmooth.z = SimState.camPosSmooth.z + (camPos.z - SimState.camPosSmooth.z) * t;

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

  // Re-center cloud ring
  if (WeatherState.cloudBillboards && WeatherState.cloudBillboards.length > 0) {
    createOrUpdateCloudSprites({
      cloudiness: WeatherState.cloudiness || 0,
      altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
      radius: CONFIG.WEATHER.CLOUD_RADIUS_M
    });
  }

  // HUD
  const speedKts = Math.round(SimState.speed * 1.94384);
  const altFt = Math.round(SimState.height * 3.28084);
  const hdgDeg = Math.round((rad2deg(SimState.heading) + 360) % 360);
  const speedEl = document.getElementById('speed');
  const altEl = document.getElementById('altitude');
  const hdgEl = document.getElementById('heading');
  if (speedEl) speedEl.textContent = `${speedKts}`;
  if (altEl) altEl.textContent = `${altFt}`;
  if (hdgEl) hdgEl.textContent = `${hdgDeg}`;

  SimState.viewer.scene.requestRender();
}



// ==================================================================================================
// 11) Convenience tools + optional route drawing
// ==================================================================================================

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
      viewLabel && (viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1));
    })
    .catch(() => {
      SimState.height = CONFIG.PHYSICS.GEAR_HEIGHT;
      commitPose(SimState.height);
    });
}

function drawRoute(positionsCartoDegreesArray) {
  // positionsCartoDegreesArray: [{lat, lon}, ...]
  const positions = positionsCartoDegreesArray.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0));
  SimState.routePositions = positions;
  if (SimState.routeEntity) {
    SimState.viewer.entities.remove(SimState.routeEntity);
    SimState.routeEntity = null;
  }
  SimState.routeEntity = SimState.viewer.entities.add({
    polyline: {
      positions: positions,
      width: 3,
      material: Cesium.Color.CYAN.withAlpha(0.8),
      clampToGround: false
    }
  });

  // Push route to passenger tab
  if (SimState.passengerWin && !SimState.passengerWin.closed) {
    const coords = positions.map(c => {
      const carto = Cesium.Cartographic.fromCartesian(c);
      return [rad2deg(carto.latitude), rad2deg(carto.longitude)];
    });
    SimState.passengerWin.postMessage({ type: 'pax:route', coords, info: `Route points: ${coords.length}` }, '*');
  }
}



// ==================================================================================================
// 12) Kickoff
// ==================================================================================================
//
// Init is triggered after login form acceptance.
// To bypass login for development, uncomment the line below:
// initSim().catch(console.error);
//
