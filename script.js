// script.js — Headwind A330neo Web Flight Sim (Patrick build) — Part 1/2
// Fully patched; integrates Cesium + Ion model 3713684, Cohere ATC, weather, IFE, autopilot, joystick.
// Note: Replace CONFIG.ATC.COHERE_API_KEY with your Cohere key before using ATC.
// Global state objects
const SimState = {};
const WeatherState = {};
const DebugState = {};

document.addEventListener('DOMContentLoaded', () => {

// ==============================
// 0) Configuration
// ==============================
const CONFIG = {
  CESIUM_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ',
  MODEL: {
    AIRCRAFT_ASSET_ID: 3713684,     // your Ion asset id
    SCALE: 1.0,
    MIN_PIXEL_SIZE: 96,
    RUN_ANIMATIONS: false
  },
  SPAWN: { LON_DEG: -9.1358, LAT_DEG: 38.7812, HEADING_DEG: 30.0 },
  VIEWER: {
    BASE_LAYER_PICKER: true,
    REQUEST_RENDER_MODE: true,
    MAXIMUM_RENDER_TIME_CHANGE: Infinity,
    DEPTH_TEST_TERRAIN: true,
    OSM_BUILDINGS: true,
    CREDIT_CONTAINER_ID: 'cesiumCreditContainer'
  },
  PHYSICS: {
    G: 9.81,
    MAX_THRUST_ACCEL: 14.0,
    DRAG_COEFF: 0.006,
    LIFT_COEFF: 0.95,
    GEAR_HEIGHT: 2.8,
    TAKEOFF_SPEED: 75.0,
    MAX_BANK_RATE: 0.9,
    MAX_PITCH_RATE: 0.75,
    MAX_YAW_RATE: 0.9,
    GROUND_STEER_RATE: 0.8,
    THRUST_RAMP: 1.6,
    THRUST_DECAY: 1.8,
    SIDE_DRIFT_DAMP: 0.92,
    ROLL_DAMP_AIR: 0.995,
    PITCH_DAMP_AIR: 0.995,
    GROUND_STICTION_PUSH: 0.6,
    GROUND_STICTION_THRESH: 0.12
  },
  CAMERA: { CHASE_BACK: 220, CHASE_UP: 72, FP_AHEAD: 8, FP_UP: 2.4, SMOOTH_FACTOR: 0.02 },
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
  DEBUG: { ENABLED: false, ELEMENT_ID: 'debugOverlay' },
  SAMPLING: { TERRAIN_STEPS: 8 },
  PASSENGER: {
    LEAFLET_CSS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    LEAFLET_JS: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
  },
  ATC: {
    ENABLED: true,
    COHERE_ENDPOINT: 'https://api.cohere.ai/v1/chat',
    COHERE_API_KEY: '' // <- paste your Cohere API key here
  }
};

// ==============================
// 1) Utilities
// ==============================
const deg2rad = (d) => Cesium.Math.toRadians(d);
const rad2deg = (r) => Cesium.Math.toDegrees(r);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const nmFromMeters = (m) => m / 1852;
const ms2kts = (ms) => ms * 1.94384;
const m2ft = (m) => m * 3.28084;

function hprQuaternion(position, heading, pitch, roll) {
  return Cesium.Transforms.headingPitchRollQuaternion(
    position, new Cesium.HeadingPitchRoll(heading, pitch, roll)
  );
}

function normalize3(out, v) {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m > 1e-9) { out.x = v.x/m; out.y = v.y/m; out.z = v.z/m; }
  else { out.x = 1; out.y = 0; out.z = 0; }
  return out;
}

// ==============================
// 2) DOM handles
// ==============================
const loginDiv = document.getElementById('login');
const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('password');
const loadingOverlay = document.getElementById('loading');

const speedEl = document.getElementById('speed');
const altEl = document.getElementById('altitude');
const hdgEl = document.getElementById('heading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');
const debugOverlay = document.getElementById('debugOverlay');

const passengerBtn = document.getElementById('passengerBtn');
const passengerPanel = document.getElementById('passengerPanel');
const createIFEBtn = document.getElementById('createIFE');
const ifeTabs = document.getElementById('ifeTabs');
const closePassenger = document.getElementById('closePassenger');

const autopilotBtn = document.getElementById('autopilotBtn');
const resetBtn = document.getElementById('resetBtn');

const joystick = document.getElementById('joystick');
const stick = document.getElementById('stick');
const throttleSlider = document.getElementById('throttleSlider');

const cameraPanel = document.getElementById('cameraPanel');

const atcOutput = document.getElementById('atcOutput');
const atcInput = document.getElementById('atcInput');
const atcSend = document.getElementById('atcSend');

// Explicit credit container (optional)
const creditContainer = document.getElementById(CONFIG.VIEWER.CREDIT_CONTAINER_ID);

// ==============================
// 3) Global state
// ==============================
const SimState = {
  viewer: null, planeEntity: null,
  heading: deg2rad(CONFIG.SPAWN.HEADING_DEG), pitch: 0, roll: 0,
  speed: 0, verticalSpeed: 0, thrustInput: 0, onGround: true,
  lon: deg2rad(CONFIG.SPAWN.LON_DEG), lat: deg2rad(CONFIG.SPAWN.LAT_DEG), height: 0,
  lastTime: undefined,
  viewMode: 'orbit', canToggleView: true, camPosSmooth: null,
  keys: {}, sampleCounter: 0, sampling: false,
  autopilot: { enabled: false, targetAltM: null },
  paxWindow: null,
  routePositions: []
};

const WeatherState = {
  lastUpdate: 0, data: null,
  cloudiness: 0, precipRate: 0, tempC: 20, windDirDeg: 0, windSpeed: 0, condition: 'Clear',
  cloudBillboards: null, rainSystem: null, snowSystem: null
};

const DebugState = { enabled: CONFIG.DEBUG.ENABLED };

// ==============================
// 4) Login
// ==============================
loginForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (passwordInput?.value || '').trim();
  if (val === 'A330') {
    loginDiv && (loginDiv.style.display = 'none');
    loadingOverlay?.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init failed:', err);
      alert('Initialization failed. Check console.');
      loadingOverlay?.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});

// ==============================
// 5) Cesium init
// ==============================
async function initSim() {
  Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_TOKEN;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: Cesium.Terrain.fromWorldTerrain(),
    timeline: false, animation: false, sceneModePicker: false,
    baseLayerPicker: CONFIG.VIEWER.BASE_LAYER_PICKER,
    geocoder: false, homeButton: false, navigationHelpButton: false,
    selectionIndicator: false, infoBox: false,
    requestRenderMode: CONFIG.VIEWER.REQUEST_RENDER_MODE,
    maximumRenderTimeChange: CONFIG.VIEWER.MAXIMUM_RENDER_TIME_CHANGE,
    creditContainer: creditContainer || undefined
  });
  SimState.viewer = viewer;

  // Restore credit bar visibility
  if (viewer._creditDisplay && viewer._creditDisplay.container) {
    viewer._creditDisplay.container.style.display = 'block';
  }

  // Lighting polish
  viewer.scene.globe.enableLighting = true;
  viewer.scene.shadowMap.enabled = true;
  viewer.scene.shadowMap.darkness = 0.6;
  if (CONFIG.VIEWER.DEPTH_TEST_TERRAIN) viewer.scene.globe.depthTestAgainstTerrain = true;

  // OSM buildings, outlines disabled to silence draping warning
  if (CONFIG.VIEWER.OSM_BUILDINGS) {
    try {
      const osm = await Cesium.createOsmBuildingsAsync();
      osm.showOutline = false;
      viewer.scene.primitives.add(osm);
    } catch (e) { console.warn('OSM buildings failed:', e); }
  }

  // Terrain sample for ground placement
  const startCarto = new Cesium.Cartographic(SimState.lon, SimState.lat);
  let terrainH = 0;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [startCarto]);
    terrainH = samples?.[0]?.height ?? 0;
  } catch {}
  SimState.height = terrainH + CONFIG.PHYSICS.GEAR_HEIGHT;

  // Load aircraft model from Ion asset
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  let modelUri = null;
  try {
    modelUri = await Cesium.IonResource.fromAssetId(CONFIG.MODEL.AIRCRAFT_ASSET_ID);
  } catch (e) {
    console.warn('Ion model load failed, falling back to point:', e);
  }

  SimState.planeEntity = viewer.entities.add({
    position: pos,
    model: modelUri ? {
      uri: modelUri,
      scale: CONFIG.MODEL.SCALE,
      minimumPixelSize: CONFIG.MODEL.MIN_PIXEL_SIZE,
      runAnimations: CONFIG.MODEL.RUN_ANIMATIONS
    } : undefined,
    point: modelUri ? undefined : { color: Cesium.Color.CYAN, pixelSize: 12 },
    orientation: hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll)
  });

  // Camera
  try {
    await viewer.flyTo(SimState.planeEntity, {
      duration: 1.0,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 500)
    });
  } catch {}
  viewer.trackedEntity = SimState.planeEntity;
  viewLabel && (viewLabel.textContent = 'Orbit');

  loadingOverlay?.classList.add('hidden');
  SimState.camPosSmooth = viewer.camera.positionWC.clone();

  // Wire UI and systems
  wireInputs();
  wirePassengerUI();
  wireCameraButtons();
  wireATC();
  setupJoystick();
  setupThrottle();

  if (CONFIG.WEATHER.ENABLED) await initWeather();
  if (DebugState.enabled) showDebugOverlay(true);

  // Start main loop (added in Part 2)
  viewer.clock.onTick.addEventListener(onTick);
}

// ==============================
// 6) Input wiring
// ==============================
function wireInputs() {
  document.addEventListener('keydown', (e) => {
    if (e.key) SimState.keys[e.key.toLowerCase()] = true;
    if (e.code) SimState.keys[e.code] = true;
    if (e.key === '`' || e.key === 'F8') showDebugOverlay(!DebugState.enabled);
    if (e.key === '2') togglePassengerPanel();
  });
  document.addEventListener('keyup', (e) => {
    if (e.key) SimState.keys[e.key.toLowerCase()] = false;
    if (e.code) SimState.keys[e.code] = false;
  });

  passengerBtn?.addEventListener('click', togglePassengerPanel);
  autopilotBtn?.addEventListener('click', toggleAutopilot);
  resetBtn?.addEventListener('click', resetToRunway);
}

function wireCameraButtons() {
  if (!cameraPanel) return;
  cameraPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const mode = btn.dataset.cam;
    if (!['orbit','chase','first'].includes(mode)) return;
    SimState.viewMode = mode;
    SimState.viewer.trackedEntity = (mode === 'orbit') ? SimState.planeEntity : undefined;
    viewLabel && (viewLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1));
  });
}

// ==============================
// 7) Passenger UI + IFE
// ==============================
function wirePassengerUI() {
  closePassenger?.addEventListener('click', () => {
    passengerPanel?.classList.add('hidden');
  });
  createIFEBtn?.addEventListener('click', openIFE);
}

function togglePassengerPanel() {
  if (!passengerPanel) return;
  passengerPanel.classList.toggle('hidden');
}

function openIFE() {
  if (!window || !window.open) { alert('Pop-ups blocked.'); return; }
  if (!SimState.paxWindow || SimState.paxWindow.closed) {
    SimState.paxWindow = window.open('', '_blank', 'noopener');
  } else {
    SimState.paxWindow.focus();
  }
  if (!SimState.paxWindow || SimState.paxWindow.closed) {
    alert('Pop-up blocked. Allow pop-ups for this site.');
    return;
  }
  writeIFE(SimState.paxWindow);
  startIFEUpdates(true);
}

function writeIFE(win) {
  const doc = win.document;
  doc.open();
  doc.write(`
<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>Passenger IFE</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${CONFIG.PASSENGER.LEAFLET_CSS}">
<style>
html,body{margin:0;padding:0;background:#0b0d10;color:#e7e9ec;font-family:sans-serif;}
#map{height:420px;}
</style>
</head><body>
<h2>Passenger Map</h2>
<div id="map"></div>
<div id="stats">
  <p>Lat: <span id="lat">--</span>, Lon: <span id="lon">--</span></p>
  <p>Alt: <span id="alt">--</span> ft</p>
  <p>Speed: <span id="spd">--</span> kts</p>
  <p>Heading: <span id="hdg">--</span>°</p>
  <p>Weather: <span id="wx">--</span></p>
</div>
<script src="${CONFIG.PASSENGER.LEAFLET_JS}"></script>
<script>
let map, marker, tail;
function initMap(lat,lon){
  map=L.map('map').setView([lat,lon],8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OSM'}).addTo(map);
  marker=L.marker([lat,lon]).addTo(map);
  tail=L.polyline([], {color:'#0ff'}).addTo(map);
}
function update(lat,lon,alt,spd,hdg,wx){
  if(!map) initMap(lat,lon);
  marker.setLatLng([lat,lon]);
  const pts=tail.getLatLngs(); pts.push([lat,lon]); if(pts.length>2000) pts.shift(); tail.setLatLngs(pts);
  document.getElementById('lat').textContent=lat.toFixed(3);
  document.getElementById('lon').textContent=lon.toFixed(3);
  document.getElementById('alt').textContent=Math.round(alt);
  document.getElementById('spd').textContent=Math.round(spd);
  document.getElementById('hdg').textContent=Math.round(hdg);
  document.getElementById('wx').textContent=wx;
}
window.addEventListener('message',(e)=>{
  const m=e.data||{};
  if(m.type==='pax:pos'){update(m.lat,m.lon,m.altFt,m.kts,m.hdgDeg,m.wx);}
});
</script>
</body></html>`);
  doc.close();
}

let ifeTimer=null;
function startIFEUpdates(force=false){
  if(ifeTimer && !force) return;
  sendIFEPos();
  if(ifeTimer) clearInterval(ifeTimer);
  ifeTimer=setInterval(sendIFEPos,1000);
}

function sendIFEPos(){
  if(!SimState.paxWindow || SimState.paxWindow.closed) return;
  const lat=rad2deg(SimState.lat), lon=rad2deg(SimState.lon);
  const altFt=m2ft(SimState.height), kts=ms2kts(SimState.speed);
  const hdgDeg=(rad2deg(SimState.heading)+360)%360;
  const wx=WeatherState.data?`${WeatherState.condition}, ${WeatherState.cloudiness}% clouds, ${WeatherState.tempC.toFixed(0)}°C`:'';
  SimState.paxWindow.postMessage({type:'pax:pos',lat,lon,altFt,kts,hdgDeg,wx},'*');
}

// ==============================
// 8) ATC (Cohere)
// ==============================
function wireATC(){
  if(!atcSend||!atcInput||!atcOutput) return;
  atcSend.addEventListener('click',sendATC);
  atcInput.addEventListener('keydown',(e)=>{if(e.key==='Enter') sendATC();});
}

async function sendATC(){
  const txt=atcInput.value.trim(); if(!txt) return;
  appendATC('Pilot',txt); atcInput.value='';
  const reply=await callCohereATC(buildATCPrompt(txt));
  appendATC('ATC',reply);
}

function appendATC(speaker,text){
  if(!atcOutput) return;
  const div=document.createElement('div');
  div.textContent=`${speaker}: ${text}`;
  atcOutput.appendChild(div);
  atcOutput.scrollTop=atcOutput.scrollHeight;
}

function buildATCPrompt(userText){
  const callsign='HW123';
  const pos=`${rad2deg(SimState.lat).toFixed(3)},${rad2deg(SimState.lon).toFixed(3)}`;
  const hdg=Math.round((rad2deg(SimState.heading)+360)%360);
  const kts=Math.round(ms2kts(SimState.speed));
  const alt=Math.round(m2ft(SimState.height));
  return `You are ATC. Aircraft ${callsign}, pos ${pos}, hdg ${hdg}, spd ${kts}kts, alt ${alt}ft. Pilot: "${userText}". Respond with concise ATC phraseology.`;
}

async function callCohereATC(prompt){
  if(!CONFIG.ATC.ENABLED||!CONFIG.ATC.COHERE_API_KEY) return 'ATC offline (no key).';
  try{
    const res=await fetch(CONFIG.ATC.COHERE_ENDPOINT,{
      method:'POST',
      headers:{
        'Authorization':`Bearer ${CONFIG.ATC.COHERE_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({model:'command-r-plus',messages:[{role:'user',content:prompt}]})
    });
    if(!res.ok) throw new Error(`Cohere ${res.status}`);
    const data=await res.json();
    return data?.text?.trim()||'No ATC response.';
  }catch(e){console.warn('ATC error:',e);return 'ATC unavailable.';}
}

// ==============================
// 9) Joystick + Throttle
// ==============================
function setupJoystick(){
  if(!joystick||!stick) return;
  let dragging=false,center={x:0,y:0},radius=50;
  function setCenter(){
    const r=joystick.getBoundingClientRect();
    center.x=r.left+r.width/2; center.y=r.top+r.height/2;
    radius=Math.min(r.width,r.height)/2-12;
  }
  setCenter(); window.addEventListener('resize',setCenter);
  function onMove(x,y){
    const dx=x-center.x, dy=y-center.y;
    const dist=Math.min(Math.hypot(dx,dy),radius);
    const ang=Math.atan2(dy,dx);
    const px=Math.cos(ang)*dist, py=Math.sin(ang)*dist;
    stick.style.left=`${center.x+px-10}px`;
    stick.style.top=`${center.y+py-10}px`;
    SimState.roll+= (px/radius)*0.02;
    SimState.pitch+= (py/radius)*0.02;
  }
  function end(){dragging=false;const r=joystick.getBoundingClientRect();
    stick.style.left=`${r.left+r.width/2-10}px`;
    stick.style.top=`${r.top+r.height/2-10}px`;
  }
  joystick.addEventListener('pointerdown',(e)=>{dragging=true;joystick.setPointerCapture(e.pointerId);onMove(e.clientX,e.clientY);});
  window.addEventListener('pointermove',(e)=>{if(dragging) onMove(e.clientX,e.clientY);});
  window.addEventListener('pointerup',end);
  window.addEventListener('pointercancel',end);
}

function setupThrottle(){
  if(!throttleSlider) return;
  throttleSlider.addEventListener('input',()=>{ SimState.thrustInput = clamp01(throttleSlider.value/100); });
}

// ==============================
// 10) Weather (Open-Meteo)
// ==============================
async function initWeather() {
  const v = SimState.viewer;
  WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  createOrUpdateClouds({ cloudiness: 0, altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M, radius: CONFIG.WEATHER.CLOUD_RADIUS_M });
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
    console.warn('Weather fetch failed:', e);
    return null;
  }
}

async function updateWeather(initial = false) {
  if (!CONFIG.WEATHER.ENABLED) return;
  const now = performance.now() / 1000;
  if (!initial && (now - WeatherState.lastUpdate) < CONFIG.WEATHER.UPDATE_SECONDS) return;

  const data = await fetchOpenMeteo(rad2deg(SimState.lat), rad2deg(SimState.lon));
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
  const c = WeatherState.cloudiness, p = WeatherState.precipRate, t = WeatherState.tempC;

  const atm = v.scene.skyAtmosphere;
  const overcast = c >= CONFIG.WEATHER.CLOUDS_OVERCAST_THRESHOLD;
  atm.hueShift = overcast ? -0.02 : 0.0;
  atm.saturationShift = overcast ? -0.25 : -0.05;
  atm.brightnessShift = overcast ? -0.12 : 0.0;

  createOrUpdateClouds({ cloudiness: c, altitudeAGL: CONFIG.WEATHER.CLOUD_LAYER_ALT_M, radius: CONFIG.WEATHER.CLOUD_RADIUS_M });

  const isSnow = (t <= CONFIG.WEATHER.SNOW_TEMP_C) && (p > CONFIG.WEATHER.PRECIP_MIN);
  const isRain = (t > CONFIG.WEATHER.SNOW_TEMP_C) && (p > CONFIG.WEATHER.PRECIP_MIN);

  if (isRain) { ensureRain(true); ensureSnow(false); tuneRain(p); }
  else if (isSnow) { ensureRain(false); ensureSnow(true); tuneSnow(p); }
  else { ensureRain(false); ensureSnow(false); }

  v.scene.requestRender();
}

function createOrUpdateClouds({ cloudiness, altitudeAGL, radius }) {
  const v = SimState.viewer;
  if (!WeatherState.cloudBillboards) {
    WeatherState.cloudBillboards = v.scene.primitives.add(new Cesium.BillboardCollection({ scene: v.scene }));
  }
  const bbs = WeatherState.cloudBillboards;
  const max = CONFIG.WEATHER.CLOUD_SPRITES_MAX;
  const target = Math.round(clamp01(cloudiness / 100) * max);

  while (bbs.length < target) bbs.add({ image: cloudSprite(), color: Cesium.Color.WHITE.withAlpha(0.9), sizeInMeters: true });
  while (bbs.length > target) bbs.remove(bbs.get(bbs.length - 1));

  if (target > 0) {
    const center = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height + altitudeAGL);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    const size = 240 + (cloudiness / 100) * 260;
    for (let i = 0; i < bbs.length; i++) {
      const ang = i / bbs.length * Math.PI * 2;
      const r = radius * (0.85 + Math.random() * 0.35);
      const local = new Cesium.Cartesian3(Math.cos(ang) * r, Math.sin(ang) * r, (Math.random() - 0.5) * 160);
      const world = Cesium.Matrix4.multiplyByPoint(enu, local, new Cesium.Cartesian3());
      const bb = bbs.get(i);
      bb.position = world; bb.width = size; bb.height = size * 0.58; bb.alignedAxis = Cesium.Cartesian3.UNIT_Z;
    }
  }
}

function cloudSprite() {
  const w = 256, h = 128, c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  function blob(cx, cy, rx, ry, a) {
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  blob(70,72,74,42,0.95); blob(120,60,64,38,0.9); blob(162,78,66,34,0.86); blob(112,86,108,38,0.8);
  return c.toDataURL('image/png');
}

function ensureRain(on) {
  const v = SimState.viewer;
  if (on && !WeatherState.rainSystem) {
    WeatherState.rainSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: rainSprite(), startColor: Cesium.Color.WHITE.withAlpha(0.55), endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.5, endScale: 0.5, minimumParticleLife: 0.5, maximumParticleLife: 0.8,
      minimumSpeed: 40, maximumSpeed: 80, emissionRate: 3600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)), imageSize: new Cesium.Cartesian2(4, 18), sizeInMeters: true, lifetime: Number.MAX_VALUE
    }));
  } else if (!on && WeatherState.rainSystem) {
    v.scene.primitives.remove(WeatherState.rainSystem); WeatherState.rainSystem = null;
  }
}

function ensureSnow(on) {
  const v = SimState.viewer;
  if (on && !WeatherState.snowSystem) {
    WeatherState.snowSystem = v.scene.primitives.add(new Cesium.ParticleSystem({
      image: snowSprite(), startColor: Cesium.Color.WHITE.withAlpha(0.95), endColor: Cesium.Color.WHITE.withAlpha(0.0),
      startScale: 0.9, endScale: 0.9, minimumParticleLife: 1.2, maximumParticleLife: 2.2,
      minimumSpeed: 0.6, maximumSpeed: 2.2, emissionRate: 1600,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(22)), imageSize: new Cesium.Cartesian2(12, 12), sizeInMeters: true, lifetime: Number.MAX_VALUE
    }));
  } else if (!on && WeatherState.snowSystem) {
    v.scene.primitives.remove(WeatherState.snowSystem); WeatherState.snowSystem = null;
  }
}

function tuneRain(mm) {
  const ps = WeatherState.rainSystem; if (!ps) return;
  const t = clamp01(mm / CONFIG.WEATHER.HEAVY_MM_H);
  ps.emissionRate = 1800 + 6800 * t; ps.minimumSpeed = 35 + 25 * t; ps.maximumSpeed = 70 + 55 * t;
}

function tuneSnow(mm) {
  const ps = WeatherState.snowSystem; if (!ps) return;
  const t = clamp01(mm / CONFIG.WEATHER.HEAVY_MM_H);
  ps.emissionRate = 900 + 2600 * t; ps.minimumSpeed = 0.4 + 0.9 * t; ps.maximumSpeed = 1.6 + 1.8 * t;
}

function rainSprite() {
  const w=8,h=36,c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d');
  const g=x.createLinearGradient(w/2,0,w/2,h); g.addColorStop(0,'rgba(255,255,255,0.95)'); g.addColorStop(1,'rgba(255,255,255,0)');
  x.strokeStyle=g; x.lineWidth=2; x.beginPath(); x.moveTo(w/2,2); x.lineTo(w/2,h-2); x.stroke(); return c.toDataURL('image/png');
}
function snowSprite() {
  const s=24,c=document.createElement('canvas'); c.width=s; c.height=s; const x=c.getContext('2d'); x.strokeStyle='rgba(255,255,255,0.95)'; x.lineWidth=2; x.translate(s/2,s/2);
  for(let i=0;i<6;i++){ x.rotate(Math.PI/3); x.beginPath(); x.moveTo(0,0); x.lineTo(0,s/2-2); x.stroke(); } return c.toDataURL('image/png');
}

function updatePrecipMM() {
  const cam = SimState.viewer.camera;
  const m = Cesium.Matrix4.clone(cam.viewMatrix, new Cesium.Matrix4());
  Cesium.Matrix4.inverse(m, m);
  if (WeatherState.rainSystem) WeatherState.rainSystem.modelMatrix = m;
  if (WeatherState.snowSystem) WeatherState.snowSystem.modelMatrix = m;
}

// ==============================
// Part 2 continues with:
// - Main simulation loop (physics, motion, terrain sampling)
// - Commit pose & camera control
// - HUD updates
// - Autopilot, reset
// - Debug overlay
// ==============================

});
// ==============================
// 11) Main loop
// ==============================
function onTick(clock) {
  const now = clock.currentTime;
  const dtRaw = SimState.lastTime ? Cesium.JulianDate.secondsDifference(now, SimState.lastTime) : 1 / 60;
  const dt = clamp(dtRaw, 0.001, 0.1);
  SimState.lastTime = now;

  if (CONFIG.WEATHER.ENABLED) {
    updateWeather();
    updatePrecipMM();
  }

  if (SimState.keys['shiftleft']) SimState.thrustInput = Math.min(1, SimState.thrustInput + CONFIG.PHYSICS.THRUST_RAMP * dt);
  if (SimState.keys['controlleft']) SimState.thrustInput = Math.max(0, SimState.thrustInput - CONFIG.PHYSICS.THRUST_DECAY * dt);

  if (SimState.keys['q']) SimState.heading -= CONFIG.PHYSICS.MAX_YAW_RATE * dt;
  if (SimState.keys['e']) SimState.heading += CONFIG.PHYSICS.MAX_YAW_RATE * dt;

  if (SimState.keys['a']) SimState.roll -= CONFIG.PHYSICS.MAX_BANK_RATE * dt;
  if (SimState.keys['d']) SimState.roll += CONFIG.PHYSICS.MAX_BANK_RATE * dt;
  if (SimState.keys['w']) SimState.pitch -= CONFIG.PHYSICS.MAX_PITCH_RATE * dt;
  if (SimState.keys['s']) SimState.pitch += CONFIG.PHYSICS.MAX_PITCH_RATE * dt;

  if (SimState.autopilot.enabled) {
    if (SimState.autopilot.targetAltM == null) SimState.autopilot.targetAltM = SimState.height;
    const err = SimState.autopilot.targetAltM - SimState.height;
    SimState.verticalSpeed += clamp(err * 0.02, -3, 3) * dt;
  }

  let accel = SimState.thrustInput * CONFIG.PHYSICS.MAX_THRUST_ACCEL - CONFIG.PHYSICS.DRAG_COEFF * SimState.speed;
  if (SimState.thrustInput > 0.02 && SimState.speed < CONFIG.PHYSICS.GROUND_STICTION_THRESH && SimState.onGround) {
    accel += CONFIG.PHYSICS.GROUND_STICTION_PUSH;
  }
  SimState.speed = Math.max(0, SimState.speed + accel * dt);

  const lift = CONFIG.PHYSICS.LIFT_COEFF * SimState.speed * Math.sin(-SimState.pitch);
  SimState.verticalSpeed += (lift - CONFIG.PHYSICS.G) * dt;
  if (SimState.onGround) SimState.verticalSpeed = Math.max(0, SimState.verticalSpeed);

  const cp = Math.cos(SimState.pitch), ch = Math.cos(SimState.heading), sh = Math.sin(SimState.heading), sp = Math.sin(SimState.pitch);
  const forwardENU = new Cesium.Cartesian3(cp * ch, cp * sh, SimState.onGround ? 0.0 : sp);
  normalize3(forwardENU, forwardENU);

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

  SimState.sampleCounter = (SimState.sampleCounter + 1) % CONFIG.SAMPLING.TERRAIN_STEPS;
  if (SimState.sampleCounter === 0 && !SimState.sampling) {
    SimState.sampling = true;
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
        commitPose(newHeight);
      })
      .finally(() => {
        SimState.sampling = false;
      });
  } else {
    commitPose(newHeight);
  }
}

// ==============================
// 12) Commit pose + camera + HUD
// ==============================
function commitPose(h) {
  SimState.height = h;
  const pos = Cesium.Cartesian3.fromRadians(SimState.lon, SimState.lat, SimState.height);
  const quat = hprQuaternion(pos, SimState.heading, SimState.pitch, SimState.roll);

  SimState.planeEntity.position = pos;
  SimState.planeEntity.orientation = quat;

  if (SimState.viewMode !== 'orbit') {
    const AXIS_X = new Cesium.Cartesian3(1, 0, 0);
    const AXIS_Z = new Cesium.Cartesian3(0, 0, 1);
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    const fwd = Cesium.Matrix3.multiplyByVector(m3, AXIS_X, new Cesium.Cartesian3());
    const up = Cesium.Matrix3.multiplyByVector(m3, AXIS_Z, new Cesium.Cartesian3());
    const camPos = new Cesium.Cartesian3();

    if (SimState.viewMode === 'chase') {
      camPos.x = pos.x - fwd.x * CONFIG.CAMERA.CHASE_BACK + up.x * CONFIG.CAMERA.CHASE_UP;
      camPos.y = pos.y - fwd.y * CONFIG.CAMERA.CHASE_BACK + up.y * CONFIG.CAMERA.CHASE_UP;
      camPos.z = pos.z - fwd.z * CONFIG.CAMERA.CHASE_BACK + up.z * CONFIG.CAMERA.CHASE_UP;
    } else {
      camPos.x = pos.x + fwd.x * CONFIG.CAMERA.FP_AHEAD + up.x * CONFIG.CAMERA.FP_UP;
      camPos.y = pos.y + fwd.y * CONFIG.CAMERA.FP_AHEAD + up.y * CONFIG.CAMERA.FP_UP;
      camPos.z = pos.z + fwd.z * CONFIG.CAMERA.FP_AHEAD + up.z * CONFIG.CAMERA.FP_UP;
    }

    if (!SimState.camPosSmooth) SimState.camPosSmooth = camPos.clone();
    SimState.camPosSmooth.x += (camPos.x - SimState.camPosSmooth.x) * CONFIG.CAMERA.SMOOTH_FACTOR;
    SimState.camPosSmooth.y += (camPos.y - SimState.camPosSmooth.y) * CONFIG.CAMERA.SMOOTH_FACTOR;
    SimState.camPosSmooth.z += (camPos.z - SimState.camPosSmooth.z) * CONFIG.CAMERA.SMOOTH_FACTOR;

    const dir = Cesium.Cartesian3.subtract(pos, SimState.camPosSmooth, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(dir, dir);
    SimState.viewer.camera.setView({ destination: SimState.camPosSmooth, orientation: { direction: dir, up: up } });
  }

  speedEl && (speedEl.textContent = `${Math.round(ms2kts(SimState.speed))}`);
  altEl && (altEl.textContent = `${Math.round(m2ft(SimState.height))}`);
  hdgEl && (hdgEl.textContent = `${Math.round((rad2deg(SimState.heading) + 360) % 360)}`);

  SimState.viewer.scene.requestRender();
}

// ==============================
// 13) Autopilot + reset + debug
// ==============================
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
    .then((s) => {
      const th = s?.[0]?.height ?? 0;
      SimState.height = th + CONFIG.PHYSICS.GEAR_HEIGHT;
      commitPose(SimState.height);
      SimState.viewer.trackedEntity = SimState.viewMode === 'orbit' ? SimState.planeEntity : undefined;
      viewLabel && (viewLabel.textContent = SimState.viewMode.charAt(0).toUpperCase() + SimState.viewMode.slice(1));
    })
    .catch(() => {
      SimState.height = CONFIG.PHYSICS.GEAR_HEIGHT;
      commitPose(SimState.height);
    })
}

function showDebugOverlay(on) {
  DebugState.enabled = !!on;
  if (!debugOverlay) return;
  if (DebugState.enabled) {
    debugOverlay.classList.remove('hidden');
    requestAnimationFrame(updateDebugLoop);
  } else {
    debugOverlay.classList.add('hidden');
  }
}

function updateDebugLoop() {
  if (!DebugState.enabled || !debugOverlay) return;
  const lines = [
    `Thrust: ${SimState.thrustInput.toFixed(2)}  AP: ${SimState.autopilot.enabled ? 'ON' : 'OFF'}`,
    `Speed: ${SimState.speed.toFixed(2)} m/s (${ms2kts(SimState.speed).toFixed(0)} kts)`,
    `V/S: ${SimState.verticalSpeed.toFixed(2)} m/s`,
    `Pitch: ${rad2deg(SimState.pitch).toFixed(1)}°  Roll: ${rad2deg(SimState.roll).toFixed(1)}°`,
    `Heading: ${rad2deg(SimState.heading).toFixed(1)}°  Ground: ${SimState.onGround}`,
    `Lon/Lat: ${rad2deg(SimState.lon).toFixed(6)}, ${rad2deg(SimState.lat).toFixed(6)} Alt: ${SimState.height.toFixed(1)} m`,
    WeatherState.data ? `WX: ${WeatherState.condition} Clouds:${WeatherState.cloudiness}% P:${WeatherState.precipRate.toFixed(2)}mm/h T:${WeatherState.tempC.toFixed(0)}°C` : 'WX: n/a'
  ];
  debugOverlay.textContent = lines.join('\n');
  requestAnimationFrame(updateDebugLoop);


// ==============================
// End of script
// ==============================
}); //end of the DOMcontent rein
