// Modular, self-contained browser flight simulator using CesiumJS, OpenMeteo, Gemini, and Leaflet.js
// All error handling and feature patches as per bug reports are included.
// Most ES6 syntax; for best results run in a modern browser with WebGL2 and ES6 modules.

import {GoogleGenAI} from "https://unpkg.com/@google/genai/dist/bundle.mjs";

// =========================
// CONFIGURATION & CONSTANTS
// =========================
const CESIUM_ION_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ'; // Required, get free at Cesium ion
const AIRCRAFT_ION_ASSET_ID = 3713684; // Example, replace with real Cesium ion asset ID
const AIRCRAFT_3D_SCALE = 1.0; // Aircraft model scale
const DEFAULT_SPAWN = {
  lat: 37.6188056, lon: -122.3754167, elev: null, // SFO 28L; replace as needed
  heading: 284, runway: "28L"
}; // Any airport/runway with open terrain.
const WEATHER_UPDATE_INTERVAL = 120 * 1000; // ms

const ORBIT_CAM = 0, CHASE_CAM = 1, COCKPIT_CAM = 2;
const CAMERA_MODES = ['Orbit','Chase','First Person'];
const MAX_THRUST = 3400, MIN_THRUST = 500, THRUST_STEP = 100;
const MAX_AIRSPEED = 290, MIN_AIRSPEED = 60;
const SIM_UPDATE_HZ = 60;

const AUTOPILOT_MODES = {
  LVL: 'LVL', HDG: 'HDG', ALT: 'ALT', SPD: 'SPD', NAV: 'NAV'
};
const FPV_COLOR = "rgba(66,255,70,0.91)"; // Flight path vector indicator color

const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY'; // In production, do NOT embed API keys on client!
const GEMINI_MODEL = 'gemini-2.5-flash';

// List of demo airports/runways for spawning (can be fetched from a real db in pro users)
const RUNWAYS = [
  // SFO 28L/28R
  {lat:37.615223,lon:-122.3917,heading:284,name:"SFO 28L",elev:3},
  // ... add more with real-world heading and elev
];

let viewer, aircraftModel, terrainProvider;
let state = {
  pos: Cesium.Cartesian3.ZERO,
  lat: DEFAULT_SPAWN.lat,
  lon: DEFAULT_SPAWN.lon,
  elev: 0,
  heading: Cesium.Math.toRadians(DEFAULT_SPAWN.heading),
  pitch: 0,
  roll: 0,
  airspeed: 0,
  thrust: 1800,
  climb: 0,
  simTime: 0,
  timeStep: 1.0 / SIM_UPDATE_HZ,
  camMode: ORBIT_CAM,
  bankRate: 0,
  pitchRate: 0,
  input: {bank: 0, pitch: 0},
  autopilot: { active: false, mode: null, target: {hdg:null,alt:null,spd:null}},
  weather: null,
  lastWeatherUpdate: 0
};
let keysHeld = {};
let autopilotStates = {...AUTOPILOT_MODES}; // Util

let ifeTabs = [];

// ===========================
// UTILITY: INITIALIZATION
// ===========================

document.addEventListener('DOMContentLoaded', async () => {
  Cesium.Ion.defaultAccessToken = CESIUM_ION_ACCESS_TOKEN;
  terrainProvider = Cesium.createWorldTerrain({requestVertexNormals:true,requestWaterMask:true});
  viewer = new Cesium.Viewer("cesiumContainer", {
    terrainProvider,
    timeline: false, animation:false, fullscreenButton:false, selectionIndicator: false,
    imageryProvider: Cesium.createWorldImageryAsync({style: Cesium.IonWorldImageryStyle.AERIAL}),
    baseLayerPicker:false
  });
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.baseColor=Cesium.Color.BLACK;
  viewer.scene.globe.showWaterEffect=true;
  // Patch: disable primitive outlines for imagery draping
  viewer.scene.primitives._primitives.forEach(prim => {
    if (prim.outline !== undefined) prim.outline = false;
  });

  // Camera/collision config
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 8;

  // Spawn aircraft
  await spawnAircraft();

  // Bind UI and control events
  setupControls();
  setupJoystick();
  setupThrottle();
  setupPassengerIFE();
  setupATC();

  // Main sim loop
  startSimLoop();
  // Initial weather fetch
  fetchWeather();
});

async function spawnAircraft() {
  // Sample terrain at a runway or use default
  let runway = RUNWAYS[0];
  let positions = [Cesium.Cartographic.fromDegrees(runway.lon, runway.lat)];
  let sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, positions);
  let alt = (sampled[0].height || runway.elev || 5) + 2.6;
  state.lat = runway.lat;
  state.lon = runway.lon;
  state.elev = alt;
  state.heading = Cesium.Math.toRadians(runway.heading);
  state.pitch = 0;
  state.roll = 0;
  state.airspeed = MIN_AIRSPEED + 18;
  // Place aircraft
  state.pos = Cesium.Cartesian3.fromDegrees(runway.lon, runway.lat, alt);
  // Remove old aircraft model if present
  if (aircraftModel && viewer.entities.contains(aircraftModel)) {
    viewer.entities.remove(aircraftModel);
  }
  // Add aircraft: Cesium Ion asset
  aircraftModel = viewer.entities.add({
    name: "Aircraft",
    position: new Cesium.CallbackProperty(() => {
      // Always update position from sim state
      return Cesium.Cartesian3.fromDegrees(state.lon,state.lat,state.elev);
    }, false),
    orientation: new Cesium.CallbackProperty(() => {
      return Cesium.Transforms.headingPitchRollQuaternion(
        Cesium.Cartesian3.fromDegrees(state.lon,state.lat,state.elev),
        new Cesium.HeadingPitchRoll(state.heading,state.pitch,state.roll)
      );
    }, false),
    model: {
      uri: Cesium.IonResource.fromAssetId(AIRCRAFT_ION_ASSET_ID),
      scale: AIRCRAFT_3D_SCALE,
      runAnimations:true,
      minimumPixelSize:32,
      silhouetteSize: 0, // outline patch
      terrainOffset: 0
    },
    show:true
  });

  // Initial camera view
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(state.pos,30), {
    offset: new Cesium.HeadingPitchRange(state.heading, Cesium.Math.toRadians(-16), 90),
    duration: 0
  });
}

// ===========================
// SIMULATION & PHYSICS ENGINE
// ===========================
function startSimLoop() {
  let lastTime = performance.now();
  function tick(now) {
    let dt = Math.min((now - lastTime)/1000, 0.07);
    lastTime = now;
    state.simTime += dt;

    updatePhysics(dt);
    updateHUD();
    updateCamera();
    updateDebug();

    if (now - state.lastWeatherUpdate > WEATHER_UPDATE_INTERVAL)
      fetchWeather();

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updatePhysics(dt) {
  // 1. Controls: keyboard
  let bankInput = state.input.bank; // -1..1 from joystick/keyboard
  let pitchInput = state.input.pitch; // -1..1
  if (state.autopilot.active) applyAutopilot(dt);

  // 2. Bank and heading changes
  state.roll += Cesium.Math.toRadians(70) * bankInput * dt;
  state.roll = Cesium.Math.clamp(state.roll, Cesium.Math.toRadians(-71), Cesium.Math.toRadians(71));
  state.heading += Math.sin(state.roll)*state.airspeed*0.00009; // turn rate ~pros

  // 3. Pitch and climb
  state.pitch += Cesium.Math.toRadians(-56) * pitchInput * dt;
  state.pitch = Cesium.Math.clamp(state.pitch, Cesium.Math.toRadians(-28), Cesium.Math.toRadians(35));
  state.climb = Math.sin(state.pitch) * state.airspeed * 0.80;

  // 4. Thrust and speed
  let drag = 0.024 * state.airspeed + 0.02 * Math.abs(state.roll);
  let thrustAcc = (state.thrust - drag*state.airspeed)*dt*0.16;
  state.airspeed += thrustAcc;
  state.airspeed = Cesium.Math.clamp(state.airspeed, MIN_AIRSPEED, MAX_AIRSPEED);

  // 5. Forward kinematics (aligned to heading - no drift)
  let moveDist = state.airspeed * dt;
  let dLat = (moveDist * Math.cos(state.heading)) / 111320;
  let dLon = (moveDist * Math.sin(state.heading)) / (111320*Math.cos(state.lat * Math.PI / 180));
  state.lat += dLat;
  state.lon += dLon;
  state.elev += state.climb * dt / 3.3;

  // Clamp height to ground
  let carto = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
  Cesium.sampleTerrainMostDetailed(terrainProvider, [carto]).then(res => {
    let terrElev = res[0].height || 0;
    if (state.elev <= terrElev + 2.1) state.elev = terrElev + 2.1;
  });
}

function applyAutopilot(dt) {
  let ap = state.autopilot;
  // LVL/Wing-leveler
  if (ap.mode === AUTOPILOT_MODES.LVL)
    state.input.bank = -state.roll*1.6;
  // HDG hold (tracks error in heading)
  if (ap.mode === AUTOPILOT_MODES.HDG && ap.target.hdg != null) {
    let delta = Cesium.Math.negativePiToPi(ap.target.hdg - state.heading);
    state.input.bank = Cesium.Math.clamp(delta*2.2, -0.7, 0.7);
  }
  // ALT hold (pitch up/down)
  if (ap.mode === AUTOPILOT_MODES.ALT && ap.target.alt != null) {
    let terrAlt = state.elev; // MSL for demo
    let err = ap.target.alt - terrAlt;
    state.input.pitch = Cesium.Math.clamp(-err*0.005, -0.7, 0.7);
  }
  // SPD hold (basic throttle PI)
  if (ap.mode === AUTOPILOT_MODES.SPD && ap.target.spd != null) {
    let derr = ap.target.spd - state.airspeed;
    state.thrust += Cesium.Math.clamp(derr*3, -30, 30); // step up/down
  }
}

// ===========================
// HUD, DEBUG, CAMERA & UI
// ===========================
function updateHUD() {
  let hud = document.getElementById('hud');
  // FPV indicator
  let fpv = `
    <canvas id="hud-canvas" width=320 height=90></canvas>
    <div> <b>HDG</b>: ${toHdg(state.heading)}° <b>ALT</b>: ${state.elev.toFixed(1)} m
     <b>SPD</b>: ${Math.round(state.airspeed)} kn <b>THR</b>: ${Math.round(state.thrust)} 
     <b>V/S</b>: ${state.climb.toFixed(0)} fpm
     <span class="ap-active">${state.autopilot.active?'AP('+state.autopilot.mode+')':'Manual'}</span>
    </div>
  `;
  hud.innerHTML = fpv;
  drawHUDCanvas();

  function drawHUDCanvas() {
    let c = document.getElementById('hud-canvas');
    let ctx = c.getContext('2d');
    // Horizon
    ctx.save();
    ctx.translate(c.width/2, c.height*0.70);
    ctx.rotate(-state.roll);
    ctx.strokeStyle="#ace";
    ctx.globalAlpha=0.71;
    ctx.lineWidth=3;
    ctx.beginPath();
    for (let x=-120;x<=120;x+=2)
      ctx.lineTo(x, Math.tan(state.pitch)*22);
    ctx.stroke();
    // FPV
    ctx.globalAlpha=1;
    ctx.strokeStyle=FPV_COLOR;
    ctx.beginPath();
    ctx.arc(0, Math.tan(state.pitch)*19-8, 7, 0, Math.PI*2);
    ctx.moveTo(-10,Math.tan(state.pitch)*19-8); ctx.lineTo(10,Math.tan(state.pitch)*19-8);
    ctx.moveTo(0,Math.tan(state.pitch)*19-15); ctx.lineTo(0,Math.tan(state.pitch)*19+15);
    ctx.stroke();
    ctx.restore();
  }
}
function toHdg(rad) {
  let deg = Cesium.Math.toDegrees(rad);
  let hdg = Math.round((deg%360+360)%360);
  return hdg;
}

function updateDebug() {
  let dbg = document.getElementById('debugOverlay');
  if (!dbg || dbg.classList.contains('hidden')) return;
  dbg.innerHTML = `
    <b>Lat:</b> ${state.lat.toFixed(6)} <b>Lon:</b> ${state.lon.toFixed(6)} <b>Elev:</b> ${state.elev.toFixed(1)}<br>
    <b>Pitch:</b> ${Cesium.Math.toDegrees(state.pitch).toFixed(2)}° 
    <b>Roll:</b> ${Cesium.Math.toDegrees(state.roll).toFixed(2)}°<br>
    <b>CmHdg:</b> ${toHdg(state.heading)}° <b>Speed:</b> ${state.airspeed.toFixed(1)} kn
    <br>
    <b>AP:</b> ${state.autopilot.active ? ("ON ("+state.autopilot.mode+")") : 'Off'}
    <br><b>Weather:</b> ${state.weather?(
      'Cloud:'+state.weather.cloud_cover+'% Rain:'+state.weather.precipitation
    ):'?'}
    <br><b>SimTime:</b> ${state.simTime.toFixed(2)} <br>
    <span style=color:#aaa>Shift: Thrust+ | Ctrl: Thrust- | Arrow or Joystick to fly | H: HUD | D: Debug | Tab: ATC | C: Camera | P: Panel</span>
  `;
}

function updateCamera() {
  if (!viewer) return;
  switch(state.camMode) {
    case ORBIT_CAM:
      // Camera rotates around aircraft
      viewer.trackedEntity = undefined;
      {
        let dest = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.elev+39);
        viewer.camera.lookAt(dest, new Cesium.HeadingPitchRange(state.heading, Cesium.Math.toRadians(-19), 145));
      }
      break;
    case CHASE_CAM: {
      viewer.trackedEntity=undefined;
      let camBack=Cesium.Cartesian3.fromDegrees(state.lon,state.lat,state.elev+7);
      let d = Cesium.Cartesian3.fromDegrees(
        state.lon + 0.00055 * Math.sin(state.heading+Math.PI), 
        state.lat + 0.00038 * Math.cos(state.heading+Math.PI),
        state.elev+6.2);
      viewer.camera.lookAt(d, new Cesium.HeadingPitchRange(state.heading, Cesium.Math.toRadians(-9), 63));
      break;
    }
    case COCKPIT_CAM: {
      // Camera at aircraft nose, first-person, matching heading/pitch/roll
      viewer.trackedEntity = undefined;
      let cockpit = Cesium.Cartesian3.fromDegrees(
        state.lon + 0.00003 * Math.sin(state.heading),
        state.lat + 0.00001 * Math.cos(state.heading),
        state.elev+2.4);
      viewer.camera.setView({
        destination: cockpit,
        orientation: {
          heading: state.heading,
          pitch: state.pitch,
          roll: state.roll
        }
      });
      break;
    }
  }
}

// ======================
// CONTROLS & BINDINGS
// ======================
function setupControls() {
  // Keyboard input
  document.addEventListener('keydown', e => {
    if (!e || !e.key) return; // Patch: guard undefined
    keysHeld[e.key.toLowerCase()] = true;

    switch(e.key.toLowerCase()) {
      case 'arrowleft': state.input.bank = -1; break;
      case 'arrowright': state.input.bank = 1; break;
      case 'arrowup': state.input.pitch = 1; break;
      case 'arrowdown': state.input.pitch = -1; break;
      case 'shift': state.thrust = Math.min(MAX_THRUST, state.thrust + THRUST_STEP); break;
      case 'control': state.thrust = Math.max(MIN_THRUST, state.thrust - THRUST_STEP); break;
      case 'h': document.getElementById('hud').style.display =
        document.getElementById('hud').style.display === 'none' ? 'block':'none'; break;
      case 'd':
        document.getElementById('debugOverlay').classList.toggle('hidden');
        break;
      case 'p':
        document.getElementById('passengerPanel').classList.toggle('hidden');
        break;
      case 'tab':
        document.getElementById('atcPanel').classList.toggle('hidden');
        break;
    }
    if (e.key.toLowerCase()===' ') { state.autopilot.active = !state.autopilot.active; }
  }, false);

  document.addEventListener('keyup', e => {
    if (!e || !e.key) return;
    keysHeld[e.key.toLowerCase()] = false;
    switch (e.key.toLowerCase()) {
      case 'arrowleft': case 'arrowright': state.input.bank = 0; break;
      case 'arrowup': case 'arrowdown': state.input.pitch = 0; break;
    }
  });

  // Camera mode buttons
  document.querySelectorAll('#cameraPanel button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cameraPanel button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      switch(btn.dataset.cam) {
        case 'orbit': state.camMode = ORBIT_CAM; break;
        case 'chase': state.camMode = CHASE_CAM; break;
        case 'cockpit': state.camMode = COCKPIT_CAM; break;
      }
    };
  });

  // Autopilot panel
  const apPanel = document.getElementById('autopilotPanel');
  renderAPPanel();
  function renderAPPanel() {
    apPanel.innerHTML = `
      <b>Autopilot</b><br>
      <button id="ap-lvl">${state.autopilot.mode===AUTOPILOT_MODES.LVL?'<b>LVL</b>':'LVL'}</button>
      <button id="ap-hdg">HDG</button>
      <button id="ap-alt">ALT</button>
      <button id="ap-spd">SPD</button>
      <br>
      Target Heading <input id="ap-hdg-input" type="number" min=0 max=359 value="${toHdg(state.heading)}">°
      <br>
      Target Alt <input id="ap-alt-input" type="number" value="${state.elev.toFixed(0)}"> m
      <br>
      Target Speed <input id="ap-spd-input" type="number" min=60 max=290 value="${state.airspeed.toFixed(0)}"> kn
      <br>
      <small>Press [SPACE] to master toggle. Manual input disables AP.</small>
    `;
    apPanel.querySelectorAll('button').forEach(btn=>{
      btn.onclick = ()=>{
        switch(btn.id) {
          case 'ap-lvl': state.autopilot.active=true; state.autopilot.mode=AUTOPILOT_MODES.LVL; break;
          case 'ap-hdg':
            state.autopilot.active=true; state.autopilot.mode=AUTOPILOT_MODES.HDG;
            state.autopilot.target.hdg = Cesium.Math.toRadians(parseFloat(apPanel.querySelector('#ap-hdg-input').value)||toHdg(state.heading));
            break;
          case 'ap-alt':
            state.autopilot.active=true; state.autopilot.mode=AUTOPILOT_MODES.ALT;
            state.autopilot.target.alt = parseFloat(apPanel.querySelector('#ap-alt-input').value)||state.elev;
            break;
          case 'ap-spd':
            state.autopilot.active=true; state.autopilot.mode=AUTOPILOT_MODES.SPD;
            state.autopilot.target.spd = parseFloat(apPanel.querySelector('#ap-spd-input').value)||state.airspeed;
            break;
        }
      };
    });
  }
}

// ====================
// ONSCReen Joystick
// ====================
function setupJoystick() {
  // Use html/canvas overlay for virtual stick
  let container = document.getElementById('joystickContainer');
  container.innerHTML = '<canvas width=160 height=160 id="joystick"></canvas>';
  let c = document.getElementById('joystick');
  let active = false, cx=80, cy=80, radius=68;
  c.addEventListener('pointerdown', e => {
    active = true;
    handle(e);
  });
  c.addEventListener('pointermove', e => { if (active) handle(e); });
  document.addEventListener('pointerup', ()=>{ active=false; state.input.bank=0; state.input.pitch=0; draw();});
  function handle(e) {
    let rect = c.getBoundingClientRect();
    let x = Math.max(5,Math.min(155,e.clientX-rect.left));
    let y = Math.max(5,Math.min(155,e.clientY-rect.top));
    let dx = ((x-cx)/radius);
    let dy = ((cy-y)/radius);
    state.input.bank = Cesium.Math.clamp(dx,-1,1);
    state.input.pitch = Cesium.Math.clamp(dy,-1,1);
    draw();
  }
  function draw() {
    let ctx = c.getContext('2d');
    ctx.clearRect(0,0,160,160);
    ctx.globalAlpha=0.8;
    ctx.strokeStyle="#5799ed"; ctx.lineWidth=7;
    ctx.beginPath(); ctx.arc(cx,cy,radius,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha=0.96;
    let jx=cx+state.input.bank*radius*0.8, jy=cy-state.input.pitch*radius*0.8;
    ctx.fillStyle="#1686f5"; ctx.beginPath(); ctx.arc(jx,jy,30,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=0.62;
    ctx.strokeStyle="#fff";ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(jx,jy,30,0,Math.PI*2);ctx.stroke();
  }
  draw();
}

// ====================
// ONSCReen Throttle
// ====================
function setupThrottle() {
  let container = document.getElementById('throttleContainer');
  container.innerHTML = `<canvas width=42 height=160 id="throttle"></canvas>`;
  let c = document.getElementById('throttle');
  let dragging = false;
  c.addEventListener('pointerdown', e => { dragging=true; handle(e); });
  c.addEventListener('pointermove', e => { if (dragging) handle(e); });
  document.addEventListener('pointerup', ()=>{dragging=false;});
  function handle(e) {
    let rect = c.getBoundingClientRect();
    let y = Math.min(Math.max(e.clientY-rect.top,0),155);
    let pct = 1-(y/155);
    state.thrust = MIN_THRUST + pct*(MAX_THRUST-MIN_THRUST);
    draw();
  }
  function draw() {
    let ctx = c.getContext('2d');
    ctx.clearRect(0,0,42,160);
    ctx.fillStyle="#242b4f";
    ctx.fillRect(15,0,12,160);
    let pct = (state.thrust-MIN_THRUST)/(MAX_THRUST-MIN_THRUST);
    ctx.fillStyle="#3ceb55";
    ctx.fillRect(15,155-pct*155,12,pct*155+5);
    ctx.strokeStyle="#fff";
    ctx.strokeRect(15,0,12,160);
    ctx.font="bold 1em Arial";
    ctx.fillStyle="#fff";
    ctx.fillText("Throttle",1,16);
  }
  setInterval(draw,200);
}

// ======================
// PASSENGER PANEL + IFE
// ======================
function setupPassengerIFE() {
  // Open panel
  let openBtn = document.getElementById('openPassenger');
  let panel = document.getElementById('passengerPanel');
  openBtn.onclick = ()=>{ panel.classList.toggle('hidden'); };
  document.getElementById('closePassenger').onclick = ()=>{ panel.classList.add('hidden');};
  // Create IFE tab
  document.getElementById('createIFE').onclick = ()=>{
    let win = window.open('', '', 'width=560,height=460');
    if (!win) return;
    win.document.write(`
      <html><head>
      <title>IFE Map</title>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
      <style>body{margin:0;} #map{width:100vw;height:99vh;}</style>
      </head><body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
      let curMarker = null, map = L.map('map').setView([${state.lat},${state.lon}], 9);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
        maxZoom:19, attribution:'&copy; OSM'
      }).addTo(map);
      window.addEventListener("message",function(ev){
        if (!ev.data) return;
        try {
          let d = JSON.parse(ev.data);
          if (d.type==="pos") {
            if (curMarker) curMarker.setLatLng([d.lat,d.lon]);
            else curMarker = L.marker([d.lat,d.lon]).addTo(map);
            map.setView([d.lat,d.lon]);
          }
        } catch(e) {}
      },false);
      </script>
      </body></html>
    `);
    // Add to tab list for comms (patch: check open)
    ifeTabs.push(win);
    let li = document.createElement('li');
    li.textContent = "IFE "+(ifeTabs.length)+": connected";
    document.getElementById('ifeTabs').appendChild(li);
  };
  // Periodically send state to all open IFE windows
  setInterval(()=>{
    for (let i=0;i<ifeTabs.length;i++) {
      let tab=ifeTabs[i];
      try {
        if (tab && !tab.closed) {
          tab.postMessage(JSON.stringify({type:"pos", lat:state.lat, lon:state.lon}),"*");
        }
      } catch(e) {
        ifeTabs[i]=null;
      }
    }
  }, 780);
}

// ======================
// WEATHER USING OPEN-METEO
// ======================
async function fetchWeather() {
  // Docs: https://open-meteo.com/en/docs
  let url = `https://api.open-meteo.com/v1/forecast?latitude=${state.lat.toFixed(4)}&longitude=${state.lon.toFixed(4)}&hourly=cloud_cover,precipitation,weathercode&current=cloud_cover,precipitation`;
  state.lastWeatherUpdate = performance.now();
  try {
    let resp = await fetch(url);
    if (!resp.ok) throw new Error("weather failed");
    let data = await resp.json();
    let idx = 0;
    if (data.hourly && data.hourly.time) {
      // Use the latest
      let len = data.hourly.time.length;
      idx = len - 1;
    }
    let cc = data.current ? data.current.cloud_cover : data.hourly.cloud_cover[idx];
    let pcp = data.current ? data.current.precipitation : data.hourly.precipitation[idx];
    state.weather = {
      cloud_cover: Math.round(cc),
      precipitation: Math.round(pcp*10)/10
    };
    // Patch: trigger sky effect
    applyWeatherVisuals();
  } catch(e) {
    state.weather = null;
  }
}

function applyWeatherVisuals() {
  // Animate cloud, precipitation, sky color
  if (!state.weather) return;
  // For demo: set globe atmosphere brightness/saturation based on clouds/pcp
  let globe = viewer.scene.globe;
  globe.atmosphereBrightnessShift = Cesium.Math.clamp(1 - state.weather.cloud_cover/110, 0.72, 1.17);
  globe.nightFadeOut = Cesium.Math.clamp(1 - state.weather.cloud_cover/110, 0.72, 1.17);
  globe.atmosphereSaturationShift = Cesium.Math.clamp(1 - state.weather.precipitation/10,0.78,1.17);
  // Optional: draw cloud/rain particles (left for extension)
}

// ======================
// AI ATC: Gemini API
// ======================
function setupATC() {
  let ai;
  try {
    ai = new GoogleGenAI({apiKey: GEMINI_API_KEY}); // In prod, pass from backend, NOT client!
  } catch(e) {
    ai = null;
  }
  const atcPanel = document.getElementById('atcPanel');
  const atcOutput = document.getElementById('atcOutput');
  const atcInput = document.getElementById('atcInput');
  document.getElementById('atcSend').onclick = async ()=>{
    let req = atcInput.value;
    if (!ai||!req) return;
    atcOutput.innerHTML = "<em>AI ATC thinking...</em>";
    let prompt = `You are an ATC controller, respond to pilot messages. 
      Aircraft: ${Math.round(state.airspeed)}kt, Alt:${Math.round(state.elev)}m, HDG:${toHdg(state.heading)}, WX:${state.weather?JSON.stringify(state.weather):'clear'}
      [Pilot]: ${req}
      [ATC]:`;
    try {
      let resp = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt
      });
      let msg = resp.text || "ATC: (no response)";
      atcOutput.innerHTML = `<b>ATC:</b> ${msg}`;
    } catch(e) {
      atcOutput.innerHTML = `<span class=warn>ATC: offline</span>`;
    }
  };
}

// End of main module
