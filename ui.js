// ui.js — UI wiring for WebFS2025
// Exports: attach, init, lateUpdate, dispose
// Responsibilities:
//  - Hook DOM elements (HUD, debug overlay, ATC panel, passenger panel)
//  - Update HUD values each frame
//  - Wire ATC input UI to an external atc module if present
//  - Open passenger IFE window and post aircraft updates
//
// Expects main.js to provide App, CONFIG, U and optional atc module via Modules.atc

let App, CONFIG, U;
let atcModule = null;
let elems = {};
let paxWindow = null;
let ifeTimer = null;

// Attach references
export function attach(app, config, util, modules = {}) {
  App = app;
  CONFIG = config;
  U = util;
  atcModule = modules.atc || null;
}

// Init: cache DOM elements and wire buttons
export function init() {
  elems.speed = document.getElementById('speed');
  elems.alt = document.getElementById('altitude');
  elems.hdg = document.getElementById('heading');
  elems.view = document.getElementById('viewmode');
  elems.ground = document.getElementById('ground');
  elems.debug = document.getElementById('debugOverlay');

  elems.passengerBtn = document.getElementById('passengerBtn');
  elems.passengerPanel = document.getElementById('passengerPanel');
  elems.createIFE = document.getElementById('createIFE');
  elems.closePassenger = document.getElementById('closePassenger');

  elems.atcOutput = document.getElementById('atcOutput');
  elems.atcInput = document.getElementById('atcInput');
  elems.atcSend = document.getElementById('atcSend');

  // Wire passenger buttons
  elems.passengerBtn && elems.passengerBtn.addEventListener('click', togglePassengerPanel);
  elems.createIFE && elems.createIFE.addEventListener('click', openIFE);
  elems.closePassenger && elems.closePassenger.addEventListener('click', () => {
    elems.passengerPanel && elems.passengerPanel.classList.add('hidden');
  });

  // Wire ATC UI (if present)
  if (elems.atcSend && elems.atcInput && elems.atcOutput) {
    elems.atcSend.addEventListener('click', onATCSend);
    elems.atcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onATCSend(); });
  }

  // Debug toggle (backtick)
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.code === 'F8') {
      if (!elems.debug) return;
      elems.debug.classList.toggle('hidden');
    }
  });

  // start IFE timer if paxWindow exists
  if (paxWindow && !paxWindow.closed) startIFEUpdates();
}

// Per-frame lateUpdate: refresh HUD and debug info
export function lateUpdate(dt) {
  if (!App) return;

  // HUD
  if (elems.speed) elems.speed.textContent = Math.round(U.ms2kts(App.speedMS || 0));
  if (elems.alt) elems.alt.textContent = Math.round(U.m2ft(App.heightM || 0));
  if (elems.hdg) elems.hdg.textContent = Math.round(((U.rad2deg(App.heading || 0) + 360) % 360));
  if (elems.view) elems.view.textContent = (App.viewMode || 'orbit').charAt(0).toUpperCase() + (App.viewMode || 'orbit').slice(1);
  if (elems.ground) elems.ground.textContent = App.onGround ? 'Yes' : 'No';

  // Debug overlay
  if (elems.debug && !elems.debug.classList.contains('hidden')) {
    const lines = [
      `Thrust: ${(App.thrustInput ?? 0).toFixed(2)}  AP: ${App.autopilot?.enabled ? 'ON' : 'OFF'}`,
      `Speed: ${(App.speedMS ?? 0).toFixed(2)} m/s (${U.ms2kts(App.speedMS || 0).toFixed(0)} kts)`,
      `V/S: ${(App.vSpeedMS ?? 0).toFixed(2)} m/s`,
      `Pitch: ${U.rad2deg(App.pitch || 0).toFixed(1)}°  Roll: ${U.rad2deg(App.roll || 0).toFixed(1)}°`,
      `Heading: ${U.rad2deg(App.heading || 0).toFixed(1)}°  Ground: ${App.onGround}`,
      `Lon/Lat: ${U.rad2deg(App.lonRad || 0).toFixed(6)}, ${U.rad2deg(App.latRad || 0).toFixed(6)} Alt: ${(App.heightM || 0).toFixed(1)} m`
    ];
    elems.debug.textContent = lines.join('\n');
  }

  // Send periodic pax updates
  if (paxWindow && !paxWindow.closed && ifeTimer == null) startIFEUpdates();
  if (paxWindow && paxWindow.closed) {
    clearInterval(ifeTimer); ifeTimer = null; paxWindow = null;
  }
}

// Dispose listeners and timers
export function dispose() {
  elems.passengerBtn && elems.passengerBtn.removeEventListener('click', togglePassengerPanel);
  elems.createIFE && elems.createIFE.removeEventListener('click', openIFE);
  elems.closePassenger && elems.closePassenger.removeEventListener('click', () => {});
  elems.atcSend && elems.atcSend.removeEventListener('click', onATCSend);
  window.removeEventListener('keydown', () => {});
  if (ifeTimer) { clearInterval(ifeTimer); ifeTimer = null; }
}

// ------------------------
// Passenger IFE
// ------------------------
function togglePassengerPanel() {
  if (!elems.passengerPanel) return;
  elems.passengerPanel.classList.toggle('hidden');
}

function openIFE() {
  if (!window || !window.open) { alert('Pop-ups blocked. Allow pop-ups for this site.'); return; }
  if (!paxWindow || paxWindow.closed) {
    paxWindow = window.open('', '_blank', 'noopener');
    if (!paxWindow) { alert('Pop-up blocked. Allow pop-ups.'); return; }
    writeIFE(paxWindow);
  } else {
    paxWindow.focus();
  }
  startIFEUpdates(true);
}

function writeIFE(win) {
  const lat = U.rad2deg(App.latRad || 0);
  const lon = U.rad2deg(App.lonRad || 0);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>WebFS2025 Passenger IFE</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="${CONFIG.PASSENGER?.LEAFLET_CSS || 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'}">
  <style>body{margin:0;font-family:sans-serif;background:#081018;color:#fff}#map{height:60vh}#stats{padding:8px}</style>
  </head><body>
  <h3>Passenger Map</h3><div id="map"></div><div id="stats">
  Lat: <span id="lat">${lat.toFixed(3)}</span> Lon: <span id="lon">${lon.toFixed(3)}</span>
  <p>Alt: <span id="alt">--</span> ft</p><p>Speed: <span id="spd">--</span> kts</p><p>Heading: <span id="hdg">--</span>°</p>
  </div>
  <script src="${CONFIG.PASSENGER?.LEAFLET_JS || 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'}"></script>
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
  }
  window.addEventListener('message',(e)=>{const m=e.data||{}; if(m.type==='pax:pos') update(m.lat,m.lon,m.altFt,m.kts,m.hdgDeg,m.wx);});
  </script>
  </body></html>`;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function startIFEUpdates(force) {
  if (ifeTimer && !force) return;
  sendIFEPos();
  if (ifeTimer) clearInterval(ifeTimer);
  ifeTimer = setInterval(sendIFEPos, 1000);
}

function sendIFEPos() {
  if (!paxWindow || paxWindow.closed) return;
  const lat = U.rad2deg(App.latRad || 0);
  const lon = U.rad2deg(App.lonRad || 0);
  const altFt = Math.round(U.m2ft(App.heightM || 0));
  const kts = Math.round(U.ms2kts(App.speedMS || 0));
  const hdgDeg = Math.round((U.rad2deg(App.heading || 0) + 360) % 360);
  const wx = (typeof window !== 'undefined' && window.WX && window.WX.data) ? `${window.WX.data.condition || ''}` : '';
  paxWindow.postMessage({ type: 'pax:pos', lat, lon, altFt, kts, hdgDeg, wx }, '*');
}

// ------------------------
// ATC UI wiring
// ------------------------
function appendATC(speaker, text) {
  if (!elems.atcOutput) return;
  const d = document.createElement('div');
  d.textContent = `${speaker}: ${text}`;
  elems.atcOutput.appendChild(d);
  elems.atcOutput.scrollTop = elems.atcOutput.scrollHeight;
}

async function onATCSend() {
  if (!elems.atcInput) return;
  const txt = elems.atcInput.value.trim();
  if (!txt) return;
  appendATC('Pilot', txt);
  elems.atcInput.value = '';

  // If an atc module is present and exposes sendATC, use it
  try {
    if (atcModule && typeof atcModule.sendATC === 'function') {
      const reply = await atcModule.sendATC(txt, App);
      appendATC('ATC', reply || 'No reply');
    } else {
      // Fallback: simple canned response
      appendATC('ATC', 'Standby, contact tower on 118.1');
    }
  } catch (e) {
    appendATC('ATC', 'ATC unavailable');
    console.warn('ATC send failed:', e);
  }
}
