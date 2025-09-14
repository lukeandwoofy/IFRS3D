// script.js
// ==================================================================================================
// Headwind A330-900neo browser flight sim for CesiumJS — ultra-extended version with:
// - Accurate runway spawn and heading alignment (LPPT Runway 03 threshold by default)
// - Robust physics loop with ground roll, thrust, lift, drag, and attitude dynamics
// - Fixed forward motion on thrust, preventing sideways drift bugs
// - Open-Meteo live weather (no API key) with clouds, rain/snow particles, overcast sky tint
// - Cloud billboard ring system that follows the aircraft
// - Wind drift (optional) with proper meteorological direction handling
// - Camera modes: Orbit (trackedEntity), Chase, and First-Person with smoothing
// - HUD for speed/altitude/heading + status labels for view mode and ground contact
// - Debug overlay for deep inspection (toggleable)
// - Terrain clamping with gear clearance to avoid sinking or floating
// - RequestRenderMode-friendly updates and throttled weather/terrain sampling
// - Heavy inline documentation, sanitized for browser delivery
//
// Replace the placeholders:
//   - CONFIG.CESIUM_TOKEN with your Cesium ion token
//   - CONFIG.MODEL.AIRCRAFT_ASSET_ID with your uploaded aircraft GLB/GTLF asset ID
//
// Keyboard:
//   - Throttle: ArrowUp/ArrowDown
//   - Pitch: W/S
//   - Roll: A/D
//   - Yaw: Q/E
//   - View: V
//   - Debug toggle (optional wiring): backtick ` or F8 (if wired below)
//
// HTML expected IDs:
//   - #login #loginForm #password
//   - #loading
//   - #cesiumContainer
//   - #hud with spans #speed #altitude #heading #viewmode #ground
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
    LON_DEG: -9.13580,  // approx LPPT RWY03 threshold longitudinal coordinate
    LAT_DEG: 38.78120,  // approx LPPT RWY03 threshold latitudinal coordinate
    HEADING_DEG: 30.0,  // runway 03 magnetic approx; for visual alignment
    // If you want to spawn mid-runway or at another airport, change these
  },

  // Model (Cesium ion asset)
  MODEL: {
    AIRCRAFT_ASSET_ID: 3713684, // <-- replace with your Cesium ion asset ID (number)
    SCALE: 1.0,
    MIN_PIXEL_SIZE: 96
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
    MAX_THRUST_ACCEL: 12.0,     // higher value for snappy ground roll
    DRAG_COEFF: 0.006,          // tuned linear-ish drag
    LIFT_COEFF: 0.95,           // naive lift proportional to speed * sin(-pitch)
    GEAR_HEIGHT: 2.8,           // gear clearance above terrain
    TAKEOFF_SPEED: 75.0,        // ~145 kts
    MAX_BANK_RATE: 0.9,         // rad/s
    MAX_PITCH_RATE: 0.75,       // rad/s
    MAX_YAW_RATE: 0.9,          // rad/s
    THRUST_RAMP: 2.0,           // thrust increase per second
    THRUST_DECAY: 2.0,          // thrust decrease per second
    GROUND_STEER_RATE: 0.8,     // yaw rate while on ground using Q/E
    SIDE_DRIFT_DAMP: 0.9,       // damping factor to reduce unintended lateral drift
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
    UPDATE_SECONDS: 180,           // every 3 minutes
    CLOUDS_OVERCAST_THRESHOLD: 75, // %
    CLOUD_LAYER_ALT_M: 1600,       // AGL offset
    CLOUD_RADIUS_M: 1700,
    CLOUD_SPRITES_MAX: 34,
    PRECIP_MIN: 0.05,              // mm/h
    HEAVY_MM_H: 3.5,               // heavy rain scaling
    SNOW_TEMP_C: 0.0,
    ENABLE_WIND: false,            // enable simple wind drift model
    WIND_SCALE: 0.14               // drift scale factor
  },

  // Debug overlay
  DEBUG: {
    ENABLED: false,
    ELEMENT_ID: 'debugOverlay'
  },

  // Sampling
  SAMPLING: {
    TERRAIN_STEPS: 8 // every N frames we sample terrain
  }
};



// ==================================================================================================
// 2) Utilities
// ==================================================================================================

const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function hprQuaternion(position, heading, pitch, roll) {
  return Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(heading, pitch, roll)
  );
}

// Ensure a unit vector (avoids NaNs in corner cases)
function normalize3(out, v) {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m > 1e-9) {
    out.x = v.x / m; out.y = v.y / m; out.z = v.z / m;
  } else {
    out.x = 1; out.y = 0; out.z = 0;
  }
  return out;
}



// ==================================================================================================
// 3) State
// ==================================================================================================

const SimState = {
  viewer: null,
  planeEntity: null,

  // Pose
  heading: deg2rad(CONFIG.SPAWN.HEADING_DEG),
  pitch: 0.0, // negative is nose up
  roll: 0.0,

  // Speeds
  speed: 0.0,          // forward m/s
  verticalSpeed: 0.0,  // climb m/s
  thrustInput: 0.0,    // 0..1

  onGround: true,

  // Position
  lon: deg2rad(CONFIG.SPAWN.LON_DEG),
  lat: deg2rad(CONFIG.SPAWN.LAT_DEG),
  height: 0.0,

  // Time
  lastTime: undefined,

  // Camera
  viewMode: 'orbit', // orbit | chase | first
  canToggleView: true,
  camPosSmooth: null,

  // Input
  keys: {},

  // Terrain sampling throttle
  sampleCounter: 0,
  sampling: false,

  // Internal to reduce sideways drift
  lastENUForward: new Cesium.Cartesian3(1, 0, 0)
};

const WeatherState = {
  lastUpdate: 0,
  data: null,
  cloudiness: 0,   // %
  precipRate: 0,   // mm/h
  tempC: 20,
  windDirDeg: 0,   // meteorological direction (FROM)
  windSpeed: 0,    // m/s
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

document.addEventListener('keydown', (e) => (SimState.keys[e.key] = true));
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

  // Create the model entity aligned to runway heading
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const modelUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
  const planeEntity = viewer.entities.add({
    position: pos,
    model: {
      uri: modelUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: false
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

  // Debug overlay optional
  createDebugOverlay();

  // Start main loop
  viewer.clock.onTick.addEventListener(onTick);
}



// ==================================================================================================
// 7) Weather (Open-Meteo)
// ==================================================================================================

async function initWeather() {
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  // Pre-seed empty cloud ring
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

  // Overcast sky tint
  const atm = v.scene.skyAtmosphere;
  const overcast = clouds >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD;
  atm.hueShift = overcast ? -0.02 : 0.0;
  atm.saturationShift = overcast ? -0.2 : 0.0;
  atm.brightnessShift = overcast ? -0.1 : 0.0;

  // Cloud ring
  createOrUpdateCloudSprites({
    cloudiness: clouds,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });

  // Precip
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

  // adjust count
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
// 8) Main loop
// ==================================================================================================

function onTick(clock) {
  // Delta time
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

  // Controls: yaw (ground uses gentler steering rate)
  if (SimState.onGround) {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.GROUND_STEER_RATE * dt;
  } else {
    if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.MAX_YAW_RATE * dt;
    if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.MAX_YAW_RATE * dt;
  }

  // Controls: pitch/roll
  if (SimState.onGround) {
    // Ground: allow slight roll corrections, heavy damping, and rotate at/after Vr
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

  // Normalize heading to [-PI, PI]
  if (SimState.heading > Math.PI) SimState.heading -= Math.PI * 2;
  if (SimState.heading < -Math.PI) SimState.heading += Math.PI * 2;

  // Physics integration
  const accel = SimState.thrustInput * CONFIG.PHYSICS.MAX_THRUST_ACCEL - CONFIG.PHYSICS.DRAG_COEFF * SimState.speed;
  SimState.speed = Math.max(0, SimState.speed + accel * dt);

  const lift = CONFIG.PHYSICS.LIFT_COEFF * SimState.speed * Math.sin(-SimState.pitch);
  SimState.verticalSpeed += (lift - CONFIG.PHYSICS.G) * dt;
  if (SimState.onGround) SimState.verticalSpeed = Math.max(0, SimState.verticalSpeed);

  // Compute forward direction in local ENU (east, north, up)
  const cp = Math.cos(SimState.pitch);
  const ch = Math.cos(SimState.heading);
  const sh = Math.sin(SimState.heading);
  const sp = Math.sin(SimState.pitch);

  // Critically: while on ground, keep Z=0 so forward is purely horizontal.
  const forwardENU = new Cesium.Cartesian3(
    cp * ch,
    cp * sh,
    SimState.onGround ? 0.0 : sp
  );
  normalize3(forwardENU, forwardENU);
  SimState.lastENUForward = forwardENU; // used to damp sideways drift

  // Current ECEF
  const currentECEF = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);

  // Build ENU frame
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());

  // Lateral drift mitigation: project old forward to current ENU plane if on ground to keep straight roll
  if (SimState.onGround) {
    forwardENU.z = 0.0;
    normalize3(forwardENU, forwardENU);
  }

  // Convert ENU forward to ECEF and integrate displacement
  const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
  // apply speed
  const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, SimState.speed * dt, new Cesium.Cartesian3());
  // sideways drift damping (reduce unintended E/W or N/S slippage)
  disp.x *= SimState.onGround ? CONFIG.PHYSICS.SIDE_DRIFT_DAMP : 1.0;
  disp.y *= SimState.onGround ? CONFIG.PHYSICS.SIDE_DRIFT_DAMP : 1.0;

  const newECEF = Cesium.Cartesian3.add(currentECEF, disp, new Cesium.Cartesian3());
  const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

  // Update lon/lat; track height separately to include climb rate
  SimState.lon = newCarto.longitude;
  SimState.lat = newCarto.latitude;

  let newHeight = (newCarto.height || 0) + SimState.verticalSpeed * dt;

  // Wind drift (optional)
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

  // Terrain clamping (throttled)
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
}



// ==================================================================================================
// 9) Commit pose + camera + HUD
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
    // Compute forward and up vectors from plane orientation
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

    // Smooth camera
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
// 10) Convenience tools
// ==================================================================================================

function resetToRunway() {
  // Reset to spawn location and heading
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

// Optional: wire a debug toggle to a key
document.addEventListener('keydown', (e) => {
  // backtick ` or F8
  if (e.key === '`' || e.key === 'F8') {
    toggleDebug();
  }
});



// ==================================================================================================
// 11) Notes for integration
// ==================================================================================================
//
// - Make sure your HTML includes the expected elements and the CesiumJS script + CSS.
// - Replace CONFIG.CESIUM_TOKEN and CONFIG.MODEL.AIRCRAFT_ASSET_ID.
// - If you want to switch to a different runway/airport, update CONFIG.SPAWN.
// - If sideways motion persists, verify your keyboard layout isn't generating continuous lateral key presses,
//   and consider increasing PHYSICS.SIDE_DRIFT_DAMP slightly (0.92 - 0.96).
// - To increase acceleration, raise PHYSICS.MAX_THRUST_ACCEL (e.g., 14.0 or 16.0).
// - To make takeoff easier, reduce TAKEOFF_SPEED slightly (e.g., 70.0).
// - The weather particle systems are intentionally camera-local; this keeps performance solid while conveying rain/snow.
// - For performance in low-end machines, set WEATHER.CLOUD_SPRITES_MAX to ~16 and reduce emission rates in tuneRainIntensity/tuneSnowIntensity.
//
// ==================================================================================================
