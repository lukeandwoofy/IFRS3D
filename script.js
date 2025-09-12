// script.js
// Comprehensive Cesium flight sim with:
// - LPPT runway spawn on ground (Runway 03 threshold, aligned ~030°)
// - Stable camera modes: Orbit (mouse), Chase, First-person
// - Working thrust and flight physics in ENU/ECEF
// - Ground handling: rotation only above Vr, terrain clamping with gear height
// - Weather API integration (OpenWeatherMap/Weatherbit-ready): clouds, overcast tint, rain/snow particles
// - Simple cloud sprites layer (billboards) at ceiling altitude
// - Flat-terrain testing toggle
// - HUD updates, error handling, requestRenderMode-friendly
//
// IMPORTANT: Replace YOUR_TOKEN_HERE, YOUR_ASSET_ID, and YOUR_WEATHER_API_KEY with your actual keys/IDs.
// If you prefer Weatherbit, switch the fetchWeather() URL and mapping as noted in comments.

// ========== Login ==========
const PASSWORD = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (document.getElementById('password').value || '').trim();
  if (val === PASSWORD) {
    document.getElementById('login').style.display = 'none';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init error:', err);
      alert('Failed to initialize. Check the console for details.');
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});

// ========== Global Config ==========
const CONFIG = {
  // Cesium
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ',
  OSM_BUILDINGS: true,

  // Terrain
  USE_FLAT_TERRAIN: false, // true = perfectly flat ellipsoid (useful for ground testing)

  // Start position (LPPT Runway 03 threshold, approx)
  START_LON_DEG: -9.1358,
  START_LAT_DEG: 38.7812,
  RUNWAY_HEADING_DEG: 30.0,

  // Model
  AIRCRAFT_ASSET_ID: '3713684', // <-- replace with actual ion asset id (number or string)
  MODEL_SCALE: 1.0,
  MODEL_MIN_PIXEL: 96,

  // Physics
  G: 9.81,
  MAX_THRUST_ACCEL: 10.0, // m/s^2 at full thrust
  DRAG_COEFF: 0.005, // linear
  LIFT_COEFF: 0.9, // simplistic coupling from speed and pitch
  GEAR_HEIGHT: 2.5, // terrain clearance when on ground
  TAKEOFF_SPEED: 75, // Vr m/s (~145 kts)

  // Camera
  CAMERA: {
    CHASE_BACK: 190.0,
    CHASE_UP: 65.0,
    FP_AHEAD: 7.0,
    FP_UP: 2.0
  },

  // Weather
  WEATHER: {
    ENABLED: true,
    PROVIDER: 'openweathermap', // 'openweathermap' | 'weatherbit'
    API_KEY: 'YOUR_WEATHER_API_KEY',
    UPDATE_SECONDS: 180, // fetch every 3 minutes
    // Visual thresholds
    OVERCAST_CLOUDS: 75, // percentage to consider overcast
    LIGHT_PRECIP_MM_H: 0.2, // rain int threshold
    HEAVY_PRECIP_MM_H: 3.0,
    SNOW_TEMP_C: 0.0, // temp threshold for snow
    CLOUD_LAYER_ALT_M: 1500, // cloud billboard altitude AGL
    CLOUD_RADIUS_M: 1500, // ring radius around aircraft
    CLOUD_SPRITES: 28 // number of cloud sprites in layer
  }
};

// ========== Utilities ==========
const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;

// ========== Weather State ==========
const WeatherState = {
  lastUpdate: 0,
  data: null,
  // Derived visuals
  cloudiness: 0, // 0..100
  precipRate: 0, // mm/h (approx)
  tempC: 20,
  condition: '', // 'Rain','Snow','Clouds','Clear', etc.
  // Primitives
  cloudBillboards: null,
  rainSystem: null,
  snowSystem: null
};

// ========== Sim State ==========
const SimState = {
  viewer: null,
  planeEntity: null,

  // Kinematics
  heading: deg2rad(CONFIG.RUNWAY_HEADING_DEG),
  pitch: 0.0, // NEGATIVE pitch moves nose UP (by design here)
  roll: 0.0,
  speed: 0, // m/s
  verticalSpeed: 0, // m/s
  thrustInput: 0, // 0..1
  onGround: true,

  // Position (kept cartographic)
  lon: deg2rad(CONFIG.START_LON_DEG),
  lat: deg2rad(CONFIG.START_LAT_DEG),
  height: 0,

  // Time
  lastTime: undefined,

  // Camera
  viewMode: 'orbit', // 'orbit' | 'chase' | 'first'
  canToggleView: true,
  camPosSmooth: null,

  // Input
  keys: {},

  // Terrain sampling control
  sampleCounter: 0,
  sampling: false
};

// ========== Input ==========
document.addEventListener('keydown', (e) => (SimState.keys[e.key] = true));
document.addEventListener('keyup', (e) => (SimState.keys[e.key] = false));

// ========== Main Init ==========
async function initSim() {
  Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: CONFIG.USE_FLAT_TERRAIN
      ? new Cesium.EllipsoidTerrainProvider()
      : Cesium.Terrain.fromWorldTerrain(),
    timeline: false,
    animation: false,
    sceneModePicker: false,
    baseLayerPicker: true,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    selectionIndicator: false,
    infoBox: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity
  });
  SimState.viewer = viewer;
  viewer.scene.globe.depthTestAgainstTerrain = true;

  if (CONFIG.OSM_BUILDINGS) {
    try {
      const osmBuildings = await Cesium.createOsmBuildingsAsync();
      viewer.scene.primitives.add(osmBuildings);
    } catch (e) {
      console.warn('OSM Buildings load failed:', e);
    }
  }

  // Get precise terrain height for on-ground spawn
  const startCarto = new Cesium.Cartographic(SimState.lon, SimState.lat);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
  } catch {
    terrainH = 0;
  }
  SimState.height = terrainH + CONFIG.GEAR_HEIGHT;

  // Load aircraft model
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const airplaneUri = await Cesium.IonResource.fromAssetId(CONFIG.AIRCRAFT_ASSET_ID);
  const planeEntity = viewer.entities.add({
    position: pos,
    model: {
      uri: airplaneUri,
      scale: CONFIG.MODEL_SCALE,
      minimumPixelSize: CONFIG.MODEL_MIN_PIXEL,
      runAnimations: false
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      pos,
      new Cesium.HeadingPitchRoll(SimState.heading, SimState.pitch, SimState.roll)
    )
  });
  SimState.planeEntity = planeEntity;

  // Initial camera: fly to and enable orbit tracking
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 420)
    });
  } catch {}
  viewer.trackedEntity = planeEntity;
  if (viewLabel) viewLabel.textContent = 'Orbit';

  if (loadingOverlay) loadingOverlay.classList.add('hidden');

  // Camera smoothing init
  SimState.camPosSmooth = viewer.camera.positionWC.clone();

  // Start weather system if enabled
  if (CONFIG.WEATHER.ENABLED) {
    await initWeather();
  }

  // Start main loop
  viewer.clock.onTick.addEventListener(onTick);
}

// ========== Weather Integration ==========
async function initWeather() {
  // Pre-create cloud billboard set
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  // Pre-warm with placeholder sprites (hidden until first weather applies)
  createOrUpdateCloudSprites({ cloudiness: 0, altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M, radius: CONFIG.WEATHER.CLOUD_RADIUS_M });
  // Initial fetch
  await updateWeather(true);
}

async function fetchWeather(latDeg, lonDeg) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDeg}&longitude=${lonDeg}&current=temperature_2m,precipitation,cloudcover&timezone=auto`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Open-Meteo fetch failed');
    const j = await res.json();
    const current = j.current;
    return {
      clouds: current.cloudcover || 0,
      tempC: current.temperature_2m || 15,
      precipRate: current.precipitation || 0,
      condition: current.precipitation > 0 ? 'Rain' : current.cloudcover > 50 ? 'Clouds' : 'Clear'
    };
  } catch (e) {
    console.warn('Weather fetch error:', e);
    return null;
  }
}
      // Weatherbit example mapping (uncomment to use Weatherbit)
      // const url = `https://api.weatherbit.io/v2.0/current?lat=${latDeg}&lon=${lonDeg}&key=${key}`;
      // const res = await fetch(url);
      // if (!res.ok) throw new Error('Weatherbit fetch failed');
      // const j = await res.json();
      // const d = j.data && j.data[0] ? j.data[0] : {};
      // const clouds = typeof d.clouds === 'number' ? d.clouds : 0;
      // const temp = typeof d.temp === 'number' ? d.temp : 15;
      // const precip = typeof d.precip === 'number' ? d.precip : 0; // mm/h
      // const mainCond = d.weather && d.weather.description ? d.weather.description : 'Clear';
      // return { clouds, tempC: temp, precipRate: precip, condition: mainCond };

      throw new Error('Unknown provider');
    
  } catch (e) {
    console.warn('Weather fetch error:', e);
    return null;
  }
}

// Called periodically to pull weather and apply visuals
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
  WeatherState.tempC = typeof data.tempC === 'number' ? data.tempC : 15;
  WeatherState.condition = data.condition || 'Clear';

  applyWeatherVisuals();
}

// Applies sky tints, cloud sprites, and precipitation based on WeatherState
function applyWeatherVisuals() {
  const v = SimState.viewer;
  const clouds = WeatherState.cloudiness;
  const precip = WeatherState.precipRate;
  const tempC = WeatherState.tempC;

  // 1) Sky/Atmosphere tint for overcast feel
  const sa = v.scene.skyAtmosphere;
  const overcast = clouds >= CONFIG.WEATHER.OVERCAST_CLOUDS;
  sa.hueShift = overcast ? -0.02 : 0.0;
  sa.saturationShift = overcast ? -0.2 : 0.0;
  sa.brightnessShift = overcast ? -0.1 : 0.0;

  // 2) Cloud sprites layer
  createOrUpdateCloudSprites({
    cloudiness: clouds,
    altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M,
    radius: CONFIG.WEATHER.CLOUD_RADIUS_M
  });

  // 3) Precipitation particles
  const isSnow = tempC <= CONFIG.WEATHER.SNOW_TEMP_C && precip > 0.05;
  const isRain = tempC > CONFIG.WEATHER.SNOW_TEMP_C && precip > 0.05;

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

  // Render update
  v.scene.requestRender();
}

// Create or update cloud billboard sprites positioned around the aircraft
function createOrUpdateCloudSprites({ cloudiness, altitudeAGL, radius }) {
  const v = SimState.viewer;
  if (!WeatherState.cloudBillboards) {
    WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  }
  const bbs = WeatherState.cloudBillboards;

  // Determine how many sprites based on cloudiness (0..100)
  const maxSprites = CONFIG.WEATHER.CLOUD_SPRITES;
  const targetCount = Math.round((cloudiness / 100) * maxSprites);

  // Add/remove to match target
  while (bbs.length < targetCount) {
    bbs.add({
      image: generateCloudSprite(), // canvas-based soft cloud sprite
      color: Cesium.Color.WHITE.withAlpha(0.85),
      scale: 1.0,
      pixelOffset: new Cesium.Cartesian2(0, 0),
      sizeInMeters: true // treat "width/height" as meters (approx)
    });
  }
  while (bbs.length > targetCount) {
    bbs.remove(bbs.get(bbs.length - 1));
  }

  // Position sprites around aircraft in a ring, jittered
  if (targetCount > 0) {
    const center = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height + altitudeAGL);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const spriteSize = 180 + (cloudiness / 100) * 200; // meters

    for (let i = 0; i < bbs.length; i++) {
      const angle = (i / bbs.length) * Math.PI * 2;
      const r = radius * (0.75 + Math.random() * 0.5);
      const local = new Cesium.Cartesian3(
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        (Math.random() - 0.5) * 120 // slight vertical jitter
      );
      // Transform local ENU to ECEF
      const ecef = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.width = spriteSize;
      bb.height = spriteSize * 0.5;
      bb.position = ecef;
      bb.alignedAxis = Cesium.Cartesian3.UNIT_Z; // keep mostly upright
    }
  }
}

// Generate a cloud sprite (canvas -> dataURL) for soft billboard blobs
function generateCloudSprite() {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Gradient blobs
  function blob(cx, cy, rx, ry, alpha) {
    const grd = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry));
    grd.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  blob(80, 70, 70, 40, 0.9);
  blob(120, 60, 60, 35, 0.85);
  blob(160, 72, 55, 30, 0.8);
  blob(110, 85, 90, 35, 0.7);

  return c.toDataURL('image/png');
}

// Rain particles
function ensureRainSystem(enabled) {
  const v = SimState.viewer;
  if (enabled && !WeatherState.rainSystem) {
    WeatherState.rainSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: rainDropSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.6),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.5,
      endScale: 0.5,
      minimumParticleLife: 0.6,
      maximumParticleLife: 0.9,
      minimumSpeed: 40.0,
      maximumSpeed: 65.0,
      emissionRate: 3000,
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

// Snow particles
function ensureSnowSystem(enabled) {
  const v = SimState.viewer;
  if (enabled && !WeatherState.snowSystem) {
    WeatherState.snowSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: snowFlakeSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.9),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.7,
      endScale: 0.7,
      minimumParticleLife: 1.2,
      maximumParticleLife: 2.2,
      minimumSpeed: 1.0,
      maximumSpeed: 2.5,
      emissionRate: 1500,
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

// Adjust rain intensity by precip mm/h
function tuneRainIntensity(mmPerHour) {
  const ps = WeatherState.rainSystem;
  if (!ps) return;
  const mm = Math.max(0, mmPerHour);
  // Map to emission and speed
  const t = Math.min(1, mm / CONFIG.WEATHER.HEAVY_PRECIP_MM_H);
  ps.emissionRate = 1500 + 6000 * t;
  ps.minimumSpeed = 30 + 35 * t;
  ps.maximumSpeed = 50 + 60 * t;
}

// Adjust snow intensity by precip mm/h
function tuneSnowIntensity(mmPerHour) {
  const ps = WeatherState.snowSystem;
  if (!ps) return;
  const mm = Math.max(0, mmPerHour);
  const t = Math.min(1, mm / CONFIG.WEATHER.HEAVY_PRECIP_MM_H);
  ps.emissionRate = 800 + 3000 * t;
  ps.minimumSpeed = 0.5 + 1.0 * t;
  ps.maximumSpeed = 1.5 + 2.0 * t;
}

// Simple rain drop sprite (canvas)
function rainDropSprite() {
  const w = 8, h = 36;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const grd = ctx.createLinearGradient(w/2, 0, w/2, h);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.strokeStyle = grd;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w/2, 2);
  ctx.lineTo(w/2, h-2);
  ctx.stroke();
  return c.toDataURL('image/png');
}

// Simple snowflake sprite (canvas)
function snowFlakeSprite() {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,s,s);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2;
  ctx.translate(s/2, s/2);
  for (let i=0;i<6;i++){
    ctx.rotate(Math.PI/3);
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.lineTo(0, s/2 - 2);
    ctx.stroke();
  }
  return c.toDataURL('image/png');
}

// Update particle system transforms to follow camera (for local "weather" feel)
function updatePrecipModelMatrix() {
  const v = SimState.viewer;
  const camera = v.camera;

  // Keep emitter around camera so particles appear near viewer
  const m = Cesium.Matrix4.clone(camera.viewMatrix, new Cesium.Matrix4());
  Cesium.Matrix4.inverse(m, m);

  if (WeatherState.rainSystem) {
    WeatherState.rainSystem.modelMatrix = m;
  }
  if (WeatherState.snowSystem) {
    WeatherState.snowSystem.modelMatrix = m;
  }
}

// ========== Main Loop ==========
function onTick(clock) {
  // dt seconds
  const now = clock.currentTime;
  const dt = SimState.lastTime
    ? Math.max(0.001, Math.min(0.1, Cesium.JulianDate.secondsDifference(now, SimState.lastTime)))
    : 1 / 60;
  SimState.lastTime = now;

  // Update weather periodically
  if (CONFIG.WEATHER.ENABLED) {
    updateWeather();
    updatePrecipModelMatrix();
  }

  // Controls: Thrust
  if (SimState.keys['ArrowUp']) SimState.thrustInput = Math.min(1, SimState.thrustInput + 0.9 * dt);
  if (SimState.keys['ArrowDown']) SimState.thrustInput = Math.max(0, SimState.thrustInput - 0.9 * dt);

  // Controls: Yaw
  if (SimState.keys['q']) SimState.heading -= 0.9 * dt;
  if (SimState.keys['e']) SimState.heading += 0.9 * dt;

  // Controls: Pitch/Roll (ground vs air)
  if (SimState.onGround) {
    if (SimState.keys['a']) SimState.roll -= 0.25 * dt;
    if (SimState.keys['d']) SimState.roll += 0.25 * dt;
    // Strong damping to level
    SimState.roll *= Math.pow(0.1, dt);
    SimState.pitch *= Math.pow(0.05, dt);
    // Allow rotate up only at/above Vr
    if (SimState.speed >= CONFIG.TAKEOFF_SPEED && SimState.keys['w']) {
      SimState.pitch = Math.max(SimState.pitch - 0.55 * dt, -Cesium.Math.PI_OVER_TWO * 0.4);
    }
    if (SimState.pitch > 0) SimState.pitch *= Math.pow(0.05, dt);
  } else {
    if (SimState.keys['a']) SimState.roll -= 0.9 * dt;
    if (SimState.keys['d']) SimState.roll += 0.9 * dt;
    if (SimState.keys['w']) SimState.pitch = Math.max(SimState.pitch - 0.75 * dt, -Cesium.Math.PI_OVER_TWO * 0.6);
    if (SimState.keys['s']) SimState.pitch = Math.min(SimState.pitch + 0.75 * dt,  Cesium.Math.PI_OVER_TWO * 0.6);
    // Gentle damping
    SimState.roll *= Math.pow(0.995, 60 * dt);
    SimState.pitch *= Math.pow(0.995, 60 * dt);
  }

  // View Mode Toggle: orbit -> chase -> first
  if (SimState.keys['v'] && SimState.canToggleView) {
    SimState.canToggleView = false;
    setTimeout(() => (SimState.canToggleView = true), 250);
    SimState.viewMode = SimState.viewMode === 'orbit' ? 'chase' : SimState.viewMode === 'chase' ? 'first' : 'orbit';
    if (viewLabel) viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1);
    // trackedEntity for orbit (mouse-drag), detach otherwise
    SimState.viewer.trackedEntity = SimState.viewMode === 'orbit' ? SimState.planeEntity : undefined;
  }

  // Normalize heading
  if (SimState.heading > Math.PI) SimState.heading -= Math.PI * 2;
  if (SimState.heading < -Math.PI) SimState.heading += Math.PI * 2;

  // Physics: forward speed integration
  const accel = SimState.thrustInput * CONFIG.MAX_THRUST_ACCEL - CONFIG.DRAG_COEFF * SimState.speed;
  SimState.speed = Math.max(0, SimState.speed + accel * dt);

  // Lift vs gravity (negative pitch = nose up)
  const lift = CONFIG.LIFT_COEFF * SimState.speed * Math.sin(-SimState.pitch);
  SimState.verticalSpeed += (lift - CONFIG.G) * dt;
  if (SimState.onGround) SimState.verticalSpeed = Math.max(0, SimState.verticalSpeed);

  // Forward direction in ENU (east, north, up)
  const forwardENU = new Cesium.Cartesian3(
    Math.cos(SimState.pitch) * Math.cos(SimState.heading),
    Math.cos(SimState.pitch) * Math.sin(SimState.heading),
    SimState.onGround ? 0 : Math.sin(SimState.pitch) // flat while on ground
  );

  // Current ECEF from stored cartographic
  const currentECEF = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
  const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, SimState.speed * dt, new Cesium.Cartesian3());
  const newECEF = Cesium.Cartesian3.add(currentECEF, disp, new Cesium.Cartesian3());
  const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

  SimState.lon = newCarto.longitude;
  SimState.lat = newCarto.latitude;
  let newHeight = (newCarto.height || 0) + SimState.verticalSpeed * dt;

  // Terrain clamp (throttled)
  let willCommit = true;
  SimState.sampleCounter = (SimState.sampleCounter + 1) % 8;
  if (SimState.sampleCounter === 0 && !SimState.sampling) {
    SimState.sampling = true;
    willCommit = false;
    Cesium.sampleTerrainMostDetailed(SimState.viewer.terrainProvider, [new Cesium.Cartographic(SimState.lon, SimState.lat)])
      .then((samples) => {
        const th = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
        const groundH = th + CONFIG.GEAR_HEIGHT;
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
        // proceed without clamp
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
}

// Finalize position/orientation and drive camera + HUD
function commitPose(h) {
  SimState.height = h;
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const quat = Cesium.Transforms.headingPitchRollQuaternion(
    pos,
    new Cesium.HeadingPitchRoll(SimState.heading, SimState.pitch, SimState.roll)
  );
  SimState.planeEntity.position = pos;
  SimState.planeEntity.orientation = quat;

  // Camera control
  if (SimState.viewMode === 'orbit') {
    // do nothing per-frame; trackedEntity handles mouse orbit
  } else {
    // Compute plane axes for world-space camera placement
    const forward = new Cesium.Cartesian3();
    const up = new Cesium.Cartesian3();
    const AXIS_X = new Cesium.Cartesian3(1, 0, 0);
    const AXIS_Z = new Cesium.Cartesian3(0, 0, 1);
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

    // Smooth camera movement (frame-rate independent)
    const dtSmooth = 1 / 60;
    const t = 1 - Math.pow(0.02, 60 * dtSmooth);
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

  // Update cloud layer position (center around aircraft)
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
  document.getElementById('speed').textContent = speedKts;
  document.getElementById('altitude').textContent = altFt;
  document.getElementById('heading').textContent = hdgDeg;

  // Render for requestRenderMode
  SimState.viewer.scene.requestRender();
}

// ========== Kickoff ==========
/* The HTML must include:
  - #login with #loginForm and #password
  - #loading overlay
  - #cesiumContainer
  - HUD elements: #speed, #altitude, #heading, #viewmode, #ground
*/
