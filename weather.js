// weather.js — WebFS2025 weather system
// Provides: attach, init, update, dispose
// Depends on: Cesium (global), main.js providing App, CONFIG, U

let App, CONFIG, U;

// Internal state
const WX = {
  lastUpdate: 0,
  data: null,
  cloudBillboards: null,
  rainSystem: null,
  snowSystem: null
};

export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

export async function init() {
  if (!CONFIG.WEATHER || !CONFIG.WEATHER.ENABLED) return;

  // Billboard collection for clouds
  WX.cloudBillboards = App.viewer.scene.primitives.add(
    new Cesium.BillboardCollection({ scene: App.viewer.scene })
  );

  // Initial fetch
  await fetchWeather(true);
}

export function update(_app, dt) {
  if (!CONFIG.WEATHER || !CONFIG.WEATHER.ENABLED) return;

  WX.lastUpdate += dt;
  if (WX.lastUpdate >= (CONFIG.WEATHER.UPDATE_SECONDS || 180)) {
    WX.lastUpdate = 0;
    fetchWeather(false);
  }

  // Keep precipitation systems positioned with the camera
  updatePrecipSystems();
}

export function dispose() {
  if (WX.cloudBillboards) {
    App.viewer.scene.primitives.remove(WX.cloudBillboards);
    WX.cloudBillboards = null;
  }
  if (WX.rainSystem) {
    App.viewer.scene.primitives.remove(WX.rainSystem);
    WX.rainSystem = null;
  }
  if (WX.snowSystem) {
    App.viewer.scene.primitives.remove(WX.snowSystem);
    WX.snowSystem = null;
  }
}

// --------------------------
// Fetch weather from Open-Meteo
// --------------------------
async function fetchWeather(initial) {
  if (!App || !U) return;
  const lat = U.rad2deg(App.latRad || 0);
  const lon = U.rad2deg(App.lonRad || 0);

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,cloudcover,wind_direction_10m,wind_speed_10m&timezone=auto`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const c = j.current || {};

    WX.data = {
      clouds: Number.isFinite(c.cloudcover) ? c.cloudcover : 0,
      tempC: Number.isFinite(c.temperature_2m) ? c.temperature_2m : 15,
      precip: Number.isFinite(c.precipitation) ? c.precipitation : 0,
      windDir: Number.isFinite(c.wind_direction_10m) ? c.wind_direction_10m : 0,
      windSpd: Number.isFinite(c.wind_speed_10m) ? c.wind_speed_10m : 0
    };

    applyWeatherVisuals();
  } catch (e) {
    console.warn('[weather] fetch failed:', e);
  }
}

// --------------------------
// Apply visuals
// --------------------------
function applyWeatherVisuals() {
  if (!WX.data || !App) return;
  const { clouds, tempC, precip } = WX.data;

  // Atmosphere tint adjustments
  const atm = App.viewer.scene.skyAtmosphere;
  const overcast = clouds >= (CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD || 75);
  atm.hueShift = overcast ? -0.02 : -0.01;
  atm.saturationShift = overcast ? -0.25 : -0.1;
  atm.brightnessShift = overcast ? -0.12 : -0.04;

  // Clouds
  updateClouds(clouds);

  // Precipitation decision
  const isSnow = (tempC <= (CONFIG.WEATHER.SNOW_TEMP_C ?? 0)) && (precip > (CONFIG.WEATHER.PRECIP_MIN ?? 0.05));
  const isRain = (tempC > (CONFIG.WEATHER.SNOW_TEMP_C ?? 0)) && (precip > (CONFIG.WEATHER.PRECIP_MIN ?? 0.05));

  ensureRain(isRain);
  ensureSnow(isSnow);

  // Optional: tune emission rates based on precip intensity
  if (WX.rainSystem) tuneRain(WX.data.precip);
  if (WX.snowSystem) tuneSnow(WX.data.precip);
}

// --------------------------
// Clouds
// --------------------------
function updateClouds(cloudiness) {
  if (!WX.cloudBillboards || !App) return;
  const bbs = WX.cloudBillboards;
  const max = CONFIG.WEATHER.CLOUD_SPRITES_MAX || 36;
  const target = Math.round(U.clamp01((cloudiness || 0) / 100) * max);

  // Add or remove billboards to reach target
  while (bbs.length < target) {
    bbs.add({
      image: cloudSprite(),
      color: Cesium.Color.WHITE.withAlpha(0.9),
      sizeInMeters: true
    });
  }
  while (bbs.length > target) {
    bbs.remove(bbs.get(bbs.length - 1));
  }

  // Position them around the aircraft
  if (target > 0) {
    const center = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, (App.heightM || 0) + (CONFIG.WEATHER.CLOUD_LAYER_ALT_M || 1800));
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    for (let i = 0; i < bbs.length; i++) {
      const ang = (i / bbs.length) * Math.PI * 2;
      const r = (CONFIG.WEATHER.CLOUD_RADIUS_M || 2000) * (0.8 + Math.random() * 0.4);
      const local = new Cesium.Cartesian3(Math.cos(ang) * r, Math.sin(ang) * r, (Math.random() - 0.5) * 200);
      const world = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.position = world;
      bb.width = 300;
      bb.height = 180;
      bb.alignedAxis = Cesium.Cartesian3.UNIT_Z;
    }
  }
}

function cloudSprite() {
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

// --------------------------
// Precipitation (rain/snow) management
// --------------------------
function ensureRain(on) {
  if (!App) return;
  if (on && !WX.rainSystem) {
    WX.rainSystem = App.viewer.scene.primitives.add(new Cesium.ParticleSystem({
      image: rainSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.55),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.5,
      endScale: 0.5,
      minimumParticleLife: 0.5,
      maximumParticleLife: 0.8,
      minimumSpeed: 40,
      maximumSpeed: 80,
      emissionRate: 3600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)),
      imageSize: new Cesium.Cartesian2(4, 18),
      sizeInMeters: true,
      lifetime: Number.MAX_VALUE
    }));
  } else if (!on && WX.rainSystem) {
    App.viewer.scene.primitives.remove(WX.rainSystem);
    WX.rainSystem = null;
  }
}

function ensureSnow(on) {
  if (!App) return;
  if (on && !WX.snowSystem) {
    WX.snowSystem = App.viewer.scene.primitives.add(new Cesium.ParticleSystem({
      image: snowSprite(),
      startColor: Cesium.Color.WHITE.withAlpha(0.95),
      endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.9,
      endScale: 0.9,
      minimumParticleLife: 1.2,
      maximumParticleLife: 2.2,
      minimumSpeed: 0.6,
      maximumSpeed: 2.2,
      emissionRate: 1600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(22)),
      imageSize: new Cesium.Cartesian2(12, 12),
      sizeInMeters: true,
      lifetime: Number.MAX_VALUE
    }));
  } else if (!on && WX.snowSystem) {
    App.viewer.scene.primitives.remove(WX.snowSystem);
    WX.snowSystem = null;
  }
}

function tuneRain(mm) {
  if (!WX.rainSystem) return;
  const t = U.clamp01(mm / (CONFIG.WEATHER.HEAVY_MM_H || 3.5));
  WX.rainSystem.emissionRate = 1800 + 6800 * t;
  WX.rainSystem.minimumSpeed = 35 + 25 * t;
  WX.rainSystem.maximumSpeed = 70 + 55 * t;
}

function tuneSnow(mm) {
  if (!WX.snowSystem) return;
  const t = U.clamp01(mm / (CONFIG.WEATHER.HEAVY_MM_H || 3.5));
  WX.snowSystem.emissionRate = 900 + 2600 * t;
  WX.snowSystem.minimumSpeed = 0.4 + 0.9 * t;
  WX.snowSystem.maximumSpeed = 1.6 + 1.8 * t;
}

// --------------------------
// Particle sprites
// --------------------------
function rainSprite() {
  const w = 8, h = 36;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(w / 2, 0, w / 2, h);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.strokeStyle = g;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, 2);
  ctx.lineTo(w / 2, h - 2);
  ctx.stroke();

  return c.toDataURL('image/png');
}

function snowSprite() {
  const s = 24;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(255,255,255,0.95)';
  x.lineWidth = 2;
  x.translate(s / 2, s / 2);

  for (let i = 0; i < 6; i++) {
    x.rotate(Math.PI / 3);
    x.beginPath();
    x.moveTo(0, 0);
    x.lineTo(0, s / 2 - 2);
    x.stroke();
  }

  return c.toDataURL('image/png');
}

// --------------------------
// Keep precipitation systems attached to camera so they move with view
// --------------------------
function updatePrecipSystems() {
  if (!App || !App.viewer) return;
  const cam = App.viewer.camera;
  const inv = Cesium.Matrix4.clone(cam.viewMatrix, new Cesium.Matrix4());
  Cesium.Matrix4.inverse(inv, inv);

  if (WX.rainSystem) WX.rainSystem.modelMatrix = inv;
  if (WX.snowSystem) WX.snowSystem.modelMatrix = inv;
}
