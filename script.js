// script.js
// =====================================================================================
// Comprehensive Cesium flight sim with live Open‑Meteo weather, aircraft physics,
// camera modes, clouds, rain/snow particles, HUD, performance safeguards, and debugging.
//
// Highlights:
// - LPPT runway spawn on ground (Runway 03 threshold, aligned ~030°)
// - Real-time physics (thrust, drag, lift) with forward motion on ground guaranteed
// - Three camera modes: Orbit (mouse drag via trackedEntity), Chase, First-person
// - Terrain clamping with gear clearance to prevent sinking into terrain
// - Open‑Meteo weather integration (no API key): cloud cover, precipitation,
//   condition mapping (Clear/Clouds/Rain/Snow), optional wind
// - Procedural cloud sprites (billboards) centered around aircraft
// - Rain/snow particle systems that follow the camera for “local weather” feel
// - HUD updates for speed (kts), altitude (ft), heading (deg), camera mode, ground state
// - Flat terrain toggle for runway testing
// - Framerate‑friendly updates using requestRenderMode and throttled weather/terrain sampling
// - Optional debug overlay you can toggle at runtime
//
// Integration notes:
// - You must configure: CESIUM_TOKEN and AIRCRAFT_ASSET_ID in CONFIG below.
// - Open‑Meteo does not need an API key.
// - Your HTML should include login (with #loginForm, #password), a #loading overlay,
//   a #cesiumContainer, and HUD spans: #speed, #altitude, #heading, #viewmode, #ground.
// - Keyboard controls:
//   Thrust: ArrowUp/ArrowDown
//   Pitch: W/S (nose up/down; note: negative pitch is nose-up in our sim convention)
//   Roll: A/D
//   Yaw: Q/E
//   View mode: V (cycles orbit → chase → first)
//
// =====================================================================================


// =====================================================================================
// 0) Login wiring
// =====================================================================================

const PASSWORD = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');

// Form submit gate
form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (document.getElementById('password')?.value || '').trim();
  if (val === PASSWORD) {
    const loginDiv = document.getElementById('login');
    if (loginDiv) loginDiv.style.display = 'none';
    loadingOverlay?.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init error:', err);
      alert('Failed to initialize. Check the console for details.');
      loadingOverlay?.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});


// =====================================================================================
// 1) Global configuration
// =====================================================================================

const CONFIG = {
  // Cesium access
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ', // <-- paste your Cesium ion token here

  // Viewer options
  VIEWER: {
    BASE_LAYER_PICKER: true,
    REQUEST_RENDER_MODE: true,
    MAXIMUM_RENDER_TIME_CHANGE: Infinity,
    DEPTH_TEST_TERRAIN: true
  },

  // Terrain setup
  USE_FLAT_TERRAIN: false, // true = perfectly flat planet for taxi/takeoff testing

  // Spawn location (LPPT Runway 03 threshold approx)
  SPAWN: {
    LON_DEG: -9.1358,
    LAT_DEG: 38.7812,
    RUNWAY_HEADING_DEG: 30.0 // ~030°
  },

  // Aircraft model (Cesium ion glTF/glb asset)
  MODEL: {
    AIRCRAFT_ASSET_ID: '3713684', // <-- replace with your Cesium ion asset id (number or string)
    SCALE: 1.0,
    MIN_PIXEL_SIZE: 96,
    RUN_ANIMATIONS: false
  },

  // Physics parameters (SI units)
  PHYSICS: {
    G: 9.81,
    MAX_THRUST_ACCEL: 12.0,   // boosted for snappier acceleration
    DRAG_COEFF: 0.006,        // small drag; tune to taste
    LIFT_COEFF: 0.95,         // lift coupling; simplistic
    GEAR_HEIGHT: 2.5,         // how high above terrain when on ground (prevents burying)
    TAKEOFF_SPEED: 75,        // Vr m/s (~145 kts)
    MAX_BANK_RATE: 0.9,       // rad/s
    MAX_PITCH_RATE: 0.75,     // rad/s
    MAX_YAW_RATE: 0.9,        // rad/s
    THRUST_RAMP: 2.0,         // how fast thrust input ramps per second
    THRUST_DECAY: 2.0         // how fast thrust decreases per second
  },

  // Camera offsets and behavior
  CAMERA: {
    CHASE_BACK: 195.0,
    CHASE_UP: 65.0,
    FP_AHEAD: 7.0,
    FP_UP: 2.0,
    SMOOTH_FACTOR: 0.02 // higher = more smoothing
  },

  // Weather (Open‑Meteo; no API key required)
  WEATHER: {
    ENABLED: true,
    UPDATE_SECONDS: 180, // fetch every 3 minutes
    CLOUDS_OVERCAST_THRESHOLD: 75, // >= this considered overcast
    CLOUD_LAYER_ALT_M: 1500, // sprites altitude above aircraft
    CLOUD_RADIUS_M: 1600,
    CLOUD_SPRITES_MAX: 32,
    PRECIP_MIN: 0.05, // mm/h threshold to trigger particles
    HEAVY_MM_H: 3.0,  // heavy precip threshold for particle tuning
    SNOW_TEMP_C: 0.0, // temp <= this => snow
    ENABLE_WIND: false // Open‑Meteo wind handling is optional here
  },

  // Debug overlay options
  DEBUG: {
    ENABLED: false,
    ID: 'debugOverlay'
  }
};


// =====================================================================================
// 2) Utility functions
// =====================================================================================

const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

function safeGet(obj, path, defVal) {
  try {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return defVal;
      cur = cur[p];
    }
    return cur == null ? defVal : cur;
  } catch {
    return defVal;
  }
}

function hprQuaternion(position, heading, pitch, roll) {
  return Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(heading, pitch, roll)
  );
}


// =====================================================================================
// 3) Simulation state containers
// =====================================================================================

const SimState = {
  viewer: null,
  planeEntity: null,

  // Kinematics
  heading: deg2rad(CONFIG.SPAWN.RUNWAY_HEADING_DEG),
  pitch: 0.0,  // negative is nose-up in our convention
  roll: 0.0,

  // Speeds
  speed: 0,          // forward m/s
  verticalSpeed: 0,  // m/s climb rate
  thrustInput: 0,    // 0..1

  // Flags
  onGround: true,

  // Position (cartographic radians and meters)
  lon: deg2rad(CONFIG.SPAWN.LON_DEG),
  lat: deg2rad(CONFIG.SPAWN.LAT_DEG),
  height: 0,

  // Time
  lastTime: undefined,

  // Camera
  viewMode: 'orbit', // orbit | chase | first
  canToggleView: true,
  camPosSmooth: null,

  // Input map
  keys: {},

  // Terrain sampling throttle
  sampleCounter: 0,
  sampling: false
};

const WeatherState = {
  lastUpdate: 0,
  data: null,
  cloudiness: 0,     // 0..100
  precipRate: 0,     // mm/h
  tempC: 20,
  windSpeed: 0,      // m/s (optional)
  windDirDeg: 0,     // degrees meteorological (optional)
  condition: 'Clear',

  // Visual primitives
  cloudBillboards: null,
  rainSystem: null,
  snowSystem: null
};

const DebugState = {
  enabled: CONFIG.DEBUG.ENABLED,
  el: null
};


// =====================================================================================
// 4) Input handlers
// =====================================================================================

document.addEventListener('keydown', (e) => (SimState.keys[e.key] = true));
document.addEventListener('keyup', (e) => (SimState.keys[e.key] = false));


// =====================================================================================
// 5) Debug overlay (optional)
// =====================================================================================

function createDebugOverlay() {
  if (!DebugState.enabled) return;
  let el = document.getElementById(CONFIG.DEBUG.ID);
  if (!el) {
    el = document.createElement('div');
    el.id = CONFIG.DEBUG.ID;
    el.style.position = 'absolute';
    el.style.bottom = '8px';
    el.style.left = '8px';
    el.style.padding = '8px 10px';
    el.style.background = 'rgba(0,0,0,0.45)';
    el.style.color = '#fff';
    el.style.font = '12px/1.3 monospace';
    el.style.borderRadius = '6px';
    el.style.pointerEvents = 'none';
    el.style.whiteSpace = 'pre';
    document.body.appendChild(el);
  }
  DebugState.el = el;
}

function updateDebugOverlay() {
  if (!DebugState.enabled || !DebugState.el) return;
  const txt = [
    `Thrust: ${SimState.thrustInput.toFixed(2)}`,
    `Speed m/s: ${SimState.speed.toFixed(1)}  kts: ${(SimState.speed * 1.94384).toFixed(0)}`,
    `V/S m/s: ${SimState.verticalSpeed.toFixed(2)}`,
    `Pitch: ${rad2deg(SimState.pitch).toFixed(1)}°`,
    `Roll: ${rad2deg(SimState.roll).toFixed(1)}°`,
    `Heading: ${rad2deg(SimState.heading).toFixed(1)}°`,
    `Ground: ${SimState.onGround ? 'Yes' : 'No'}`,
    `Lon: ${rad2deg(SimState.lon).toFixed(6)}  Lat: ${rad2deg(SimState.lat).toFixed(6)}  Alt m: ${SimState.height.toFixed(1)}`,
    WeatherState.data ? `WX: ${WeatherState.condition}  Clouds: ${WeatherState.cloudiness}%  P(mm/h): ${WeatherState.precipRate}` : 'WX: n/a',
    WeatherState.data && CONFIG.WEATHER.ENABLE_WIND ? `Wind: ${WeatherState.windSpeed.toFixed(1)} m/s @ ${WeatherState.windDirDeg.toFixed(0)}°` : ''
  ].join('\n');
  DebugState.el.textContent = txt;
}


// =====================================================================================
// 6) Initialization
// =====================================================================================

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

  // Try to add OSM buildings (optional)
  try {
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
  } catch (e) {
    console.warn('OSM Buildings unavailable:', e);
  }

  // Resolve terrain height at spawn for ground placement
  const startCarto = new Cesium.Cartographic(SimState.lon, SimState.lat);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
  } catch {
    terrainH = 0;
  }
  SimState.height = terrainH + CONFIG.PHYSICS.GEAR_HEIGHT;

  // Load aircraft
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const airplaneUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
  const planeEntity = viewer.entities.add({
    position: pos,
    model: {
      uri: airplaneUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: CONFIG.MODEL.RUN_ANIMATIONS
    },
    orientation: hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll)
  });
  SimState.planeEntity = planeEntity;

  // Initial camera framing
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 420)
    });
  } catch {}
  viewer.trackedEntity = planeEntity;
  viewLabel && (viewLabel.textContent = 'Orbit');

  // Hide loading
  loadingOverlay?.classList.add('hidden');

  // Camera smoothing seed
  SimState.camPosSmooth = viewer.camera.positionWC.clone();

  // Weather init
  if (CONFIG.WEATHER.ENABLED) {
    await initWeather();
  }

  // Debug overlay
  createDebugOverlay();

  // Main loop
  viewer.clock.onTick.addEventListener(onTick);
}


// =====================================================================================
// 7) Weather (Open‑Meteo)
// =====================================================================================

async function initWeather() {
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  createOrUpdateCloudSprites({ cloudiness: 0, altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M, radius: CONFIG.WEATHER.CLOUD_RADIUS_M });
  await updateWeather(true);
}

async function fetchWeather(latDeg, lonDeg) {
  // Open‑Meteo current fields: temperature_2m, precipitation, cloudcover, wind_direction_10m, wind_speed_10m
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDeg}&longitude=${lonDeg}&current=temperature_2m,precipitation,cloudcover,wind_direction_10m,wind_speed_10m&timezone=auto`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Open-Meteo fetch failed: ${res.status}`);
    const j = await res.json();
    const current = j.current || {};
    const clouds = Number.isFinite(current.cloudcover) ? current.cloudcover : 0;
    const tempC = Number.isFinite(current.temperature_2m) ? current.temperature_2m : 15;
    const precip = Number.isFinite(current.precipitation) ? current.precipitation : 0;
    const windDir = Number.isFinite(current.wind_direction_10m) ? current.wind_direction_10m : 0;
    const windSpd = Number.isFinite(current.wind_speed_10m) ? current.wind_speed_10m : 0;

    const condition = precip > CONFIG.WEATHER.PRECIP_MIN
      ? (tempC <= CONFIG.WEATHER.SNOW_TEMP_C ? 'Snow' : 'Rain')
      : (clouds > 50 ? 'Clouds' : 'Clear');

    return {
      clouds,
      tempC,
      precipRate: precip,
      windDirDeg: windDir,
      windSpeed: windSpd,
      condition
    };
  } catch (e) {
    console.warn('Weather fetch error:', e);
    return null;
  }
}

async function updateWeather(initial = false) {
  const now = performance.now() / 1000;
  if (!initial && now - WeatherState.lastUpdate < CONFIG.WEATHER.UPDATE_SECONDS) return;

  const latDeg = rad2deg(SimState.lat);
  const lonDeg = rad2deg(SimState.lon);

  const data = await fetchWeather(latDeg, lonDeg);
  if (!data) return;

  WeatherState.lastUpdate = now;
  WeatherState.data = data;
  WeatherState.cloudiness = data.clouds || 0;
  WeatherState.precipRate = data.precipRate || 0;
  WeatherState.tempC = Number.isFinite(data.tempC) ? data.tempC : 15;
  WeatherState.windDirDeg = Number.isFinite(data.windDirDeg) ? data.windDirDeg : 0;
  WeatherState.windSpeed = Number.isFinite(data.windSpeed) ? data.windSpeed : 0;
  WeatherState.condition = data.condition || 'Clear';

  applyWeatherVisuals();
}

function applyWeatherVisuals() {
  const v = SimState.viewer;
  const clouds = WeatherState.cloudiness;
  const precip = WeatherState.precipRate;
  const tempC = WeatherState.tempC;

  // Atmosphere tint to simulate overcast
  const sa = v.scene.skyAtmosphere;
  const overcast = clouds >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD;
  sa.hueShift = overcast ? -0.02 : 0.0;
  sa.saturationShift = overcast ? -0.2 : 0.0;
  sa.brightnessShift = overcast ? -0.1 : 0.0;

  // Cloud sprites layer
  createOrUpdateCloudSprites({
    cloudiness: clouds,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });

  // Precipitation
  const isSnow = tempC <= CONFIG.WEATHER.SNOW_TEMP_C && precip > CONFIG.WEATHER.PRECIP_MIN;
  const isRain = tempC > CONFIG.WEATHER.SNOW_TEMP_C && precip > CONFIG.WEATHER.PRECIP_MIN;

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

  const maxSprites = CONFIG.WEATHER.CLOUD_SPRITES_MAX;
  const targetCount = Math.round((clamp01(cloudiness / 100)) * maxSprites);

  while (bbs.length < targetCount) {
    bbs.add({
      image: generateCloudSprite(),
      color: Cesium.Color.WHITE.withAlpha(0.88),
      scale: 1.0,
      pixelOffset: new Cesium.Cartesian2(0, 0),
      sizeInMeters: true
    });
  }
  while (bbs.length > targetCount) {
    bbs.remove(bbs.get(bbs.length - 1));
  }

  if (targetCount > 0) {
    const center = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height + altitudeAGL);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const spriteBase = 200;
    const spriteSize = spriteBase + (cloudiness / 100) * 240;

    for (let i = 0; i < bbs.length; i++) {
      const angle = (i / bbs.length) * Math.PI * 2;
      const r = radius * (0.8 + Math.random() * 0.4);
      const local = new Cesium.Cartesian3(
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        (Math.random() - 0.5) * 150
      );
      const ecef = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.width = spriteSize;
      bb.height = spriteSize * 0.55;
      bb.position = ecef;
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
  ctx.clearRect(0, 0, w, h);
  const grd = ctx.createLinearGradient(w / 2, 0, w / 2, h);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.strokeStyle = grd;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2, h - 2);
  ctx.stroke();
  return c.toDataURL('image/png');
}

function snowFlakeSprite() {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2;
  ctx.translate(s / 2, s / 2);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, s / 2 - 2);
    ctx.stroke();
  }
  return c.toDataURL('image/png');
}

function updatePrecipModelMatrix() {
  const v = SimState.viewer;
  const camera = v.camera;
  const m = Cesium.Matrix4.clone(camera.viewMatrix, new Cesium.Matrix4());
  Cesium.Matrix4.inverse(m, m);
  if (WeatherState.rainSystem) WeatherState.rainSystem.modelMatrix = m;
  if (WeatherState.snowSystem) WeatherState.snowSystem.modelMatrix = m;
}


// =====================================================================================
// 8) Main simulation loop
// =====================================================================================

function onTick(clock) {
  // dt
  const now = clock.currentTime;
  const dt = SimState.lastTime
    ? clamp(Cesium.JulianDate.secondsDifference(now, SimState.lastTime), 0.001, 0.1)
    : 1 / 60;
  SimState.lastTime = now;

  // Weather upkeep
  if (CONFIG.WEATHER.ENABLED) {
    updateWeather();
    updatePrecipModelMatrix();
  }

  // Controls: thrust
  if (SimState.keys['ArrowUp']) SimState.thrustInput = Math.min(1, SimState.thrustInput + CONFIG.PHYSICS.THRUST_RAMP * dt);
  if (SimState.keys['ArrowDown']) SimState.thrustInput = Math.max(0, SimState.thrustInput - CONFIG.PHYSICS.THRUST_DECAY * dt);

  // Controls: yaw
  if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.MAX_YAW_RATE * dt;
  if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.MAX_YAW_RATE * dt;

  // Controls: pitch/roll (ground vs air)
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
    SimState.roll *= Math.pow(0.995, 60 * dt);
    SimState.pitch *= Math.pow(0.995, 60 * dt);
  }

  // Camera mode toggle
  if (SimState.keys['v'] && SimState.canToggleView) {
    SimState.canToggleView = false;
    setTimeout(() => (SimState.canToggleView = true), 250);
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
  // Guarantee horizontal progression on ground by forcing Z=0
  const cp = Math.cos(SimState.pitch);
  const ch = Math.cos(SimState.heading);
  const sh = Math.sin(SimState.heading);
  const sp = Math.sin(SimState.pitch);

  const forwardENU = new Cesium.Cartesian3(
    cp * ch,
    cp * sh,
    SimState.onGround ? 0.0 : sp // critically: keep horizontal while on ground
  );

  // Current ECEF and ENU
  const currentECEF = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
  const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, SimState.speed * dt, new Cesium.Cartesian3());
  const newECEF = Cesium.Cartesian3.add(currentECEF, disp, new Cesium.Cartesian3());
  const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

  SimState.lon = newCarto.longitude;
  SimState.lat = newCarto.latitude;

  // Apply vertical speed component
  let newHeight = (newCarto.height || 0) + SimState.verticalSpeed * dt;

  // Optional wind (very light, applied as drift to heading or lateral displacement)
  if (CONFIG.WEATHER.ENABLE_WIND && WeatherState.data) {
    // Simple wind drift: nudge lon/lat slightly based on wind direction/speed
    // Wind direction is where it’s coming FROM (meteorological). Convert to movement TO:
    const toDirRad = deg2rad((WeatherState.windDirDeg + 180) % 360);
    const driftSpeed = WeatherState.windSpeed * 0.15; // scale factor
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
    newHeight = drifted.height; // keep numeric continuity
  }

  // Terrain clamp (throttled)
  let willCommit = true;
  SimState.sampleCounter = (SimState.sampleCounter + 1) % 8;
  if (SimState.sampleCounter === 0 && !SimState.sampling) {
    SimState.sampling = true;
    willCommit = false;
    Cesium.sampleTerrainMostDetailed(SimState.viewer.terrainProvider, [new Cesium.Cartographic(SimState.lon, SimState.lat)])
      .then((samples) => {
        const th = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
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
}


// =====================================================================================
// 9) Pose commit + camera + HUD
// =====================================================================================

function commitPose(h) {
  SimState.height = h;
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const quat = hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll);

  // Update entity
  SimState.planeEntity.position = pos;
  SimState.planeEntity.orientation = quat;

  // Camera
  if (SimState.viewMode === 'orbit') {
    // trackedEntity handles mouse orbit — no per-frame camera work needed
  } else {
    // Plane axes
    const AXIS_X = new Cesium.Cartesian3(1, 0, 0);
    const AXIS_Z = new Cesium.Cartesian3(0, 0, 1);
    const forward = new Cesium.Cartesian3();
    const up = new Cesium.Cartesian3();
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    Cesium.Matrix3.multiplyByVector(m3, AXIS_X, forward);
    Cesium.Matrix3.multiplyByVector(m3, AXIS_Z, up);

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

    // Smooth camera
    const t = 1 - Math.pow(CONFIG.CAMERA.SMOOTH_FACTOR, 60 * (1 / 60));
    SimState.camPosSmooth.x = SimState.camPosSmooth.x + (camPos.x - SimState.camPosSmooth.x) * t;
    SimState.camPosSmooth.y = SimState.camPosSmooth.y + (camPos.y - SimState.camPosSmooth.y) * t;
    SimState.camPosSmooth.z = SimState.camPosSmooth.z + (camPos.z - SimState.camPosSmooth.z) * t;

    const toTarget = Cesium.Cartesian3.subtract(pos, SimState.camPosSmooth, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(toTarget, toTarget);

    if (Cesium.Cartesian3.magnitude(toTarget) > 1e-6) {
      SimState.viewer.camera.setView({
        destination: SimState.camPosSmooth,
        orientation: {
          direction: toTarget,
          up: up
        }
      });
    }
  }

  // Cloud ring re-center
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
  document.getElementById('speed') && (document.getElementById('speed').textContent = `${speedKts}`);
  document.getElementById('altitude') && (document.getElementById('altitude').textContent = `${altFt}`);
  document.getElementById('heading') && (document.getElementById('heading').textContent = `${hdgDeg}`);

  // Render
  SimState.viewer.scene.requestRender();
}


// =====================================================================================
// 10) Optional helpers: reset, pause, and key hints (not wired by default)
// =====================================================================================

function resetToRunway() {
  // Optional: Re-center on spawn location
  SimState.heading = deg2rad(CONFIG.SPAWN.RUNWAY_HEADING_DEG);
  SimState.pitch = 0;
  SimState.roll = 0;
  SimState.speed = 0;
  SimState.verticalSpeed = 0;
  SimState.thrustInput = 0;
  SimState.onGround = true;
  SimState.lon = deg2rad(CONFIG.SPAWN.LON_DEG);
  SimState.lat = deg2rad(CONFIG.SPAWN.LAT_DEG);

  // Sample terrain immediately for height
  Cesium.sampleTerrainMostDetailed(SimState.viewer.terrainProvider, [new Cesium.Cartographic(SimState.lon, SimState.lat)])
    .then((samples) => {
      const th = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
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

function toggleDebug() {
  DebugState.enabled = !DebugState.enabled;
  if (DebugState.enabled && !DebugState.el) createDebugOverlay();
  if (!DebugState.enabled && DebugState.el) {
    DebugState.el.remove();
    DebugState.el = null;
  }
}


// =====================================================================================
// 11) Kickoff
// =====================================================================================

// Note: We rely on the login form to call initSim() after password is accepted.
// If you want to bypass login during development, you can call initSim() directly:
// initSim().catch(console.error);
