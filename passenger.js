// passenger.js — Passenger IFE module (fixed popup, correct lon, robust postMessage)
// Exports: attach, init, openIFE, sendUpdate, update, dispose
// Purpose:
//  - Open a passenger IFE popup showing a Leaflet map and minimal flight stats
//  - Periodically post position updates to the IFE window
//  - Provide a UI hook for the passenger panel in index.html
// Fixes applied:
//  - Corrected longitude bug (used App.lonRad instead of App.latRad)
//  - Robust popup open detection and feature string
//  - Safe postMessage with try/catch and popup alive checks
//  - Exposed small public API for manual update triggers

let App, CONFIG, U;
let paxWindow = null;
let updateTimer = null;
const UPDATE_MS = 1000; // send updates every second

export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

export function init() {
  // Wire passenger panel buttons if present
  const passengerBtn = document.getElementById('passengerBtn');
  const createIFE = document.getElementById('createIFE');
  const closeBtn = document.getElementById('closePassenger');

  if (passengerBtn) passengerBtn.addEventListener('click', togglePassengerPanel);
  if (createIFE) createIFE.addEventListener('click', openIFE);
  if (closeBtn) closeBtn.addEventListener('click', () => {
    const panel = document.getElementById('passengerPanel');
    if (panel) panel.classList.add('hidden');
  });
}

// Lightweight per-frame check
export function update(_app, dt) {
  // Clear timer if popup closed or navigated away
  if (paxWindow && paxWindow.closed) {
    stopUpdates();
    paxWindow = null;
  }
}

// Open or focus the IFE popup and start updates
export function openIFE() {
  // Popup features for consistent size and no toolbar
  const features = 'noopener,noreferrer,width=900,height=700,scrollbars=yes';
  try {
    if (paxWindow && !paxWindow.closed) {
      paxWindow.focus();
      return;
    }
    paxWindow = window.open('', '_blank', features);
  } catch (e) {
    paxWindow = null;
  }

  if (!paxWindow) {
    // Popup blocked; inform user via UI if available
    const panel = document.getElementById('passengerPanel');
    if (panel) {
      panel.classList.remove('hidden');
    }
    alert('Pop-up blocked. Allow pop-ups for this site to open the Passenger IFE.');
    return;
  }

  writeIFE(paxWindow);
  startUpdates(true);
}

// Write the HTML into the popup
function writeIFE(win) {
  const leafletCss = (CONFIG.PASSENGER && CONFIG.PASSENGER.LEAFLET_CSS) || 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const leafletJs = (CONFIG.PASSENGER && CONFIG.PASSENGER.LEAFLET_JS) || 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const lat = U.rad2deg(App.latRad || 0);
  const lon = U.rad2deg(App.lonRad || 0);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebFS2025 Passenger IFE</title>
<link rel="stylesheet" href="${leafletCss}">
<style>
  body{margin:0;background:#071423;color:#fff;font-family:system-ui,Segoe UI,Roboto,Arial}
  header{padding:8px;background:#04101a;font-weight:600}
  #map{height:60vh}
  #stats{padding:8px}
  .stat{margin:6px 0}
</style>
</head>
<body>
<header>Passenger Map — WebFS2025</header>
<div id="map"></div>
<div id="stats">
  <div class="stat">Lat: <span id="lat">${lat.toFixed(4)}</span></div>
  <div class="stat">Lon: <span id="lon">${lon.toFixed(4)}</span></div>
  <div class="stat">Alt: <span id="alt">--</span> ft</div>
  <div class="stat">Speed: <span id="spd">--</span> kts</div>
  <div class="stat">Heading: <span id="hdg">--</span>°</div>
</div>

<script src="${leafletJs}"></script>
<script>
  let map, marker, tail;
  function initMap(lat, lon) {
    try {
      map = L.map('map').setView([lat, lon], 7);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      marker = L.marker([lat, lon]).addTo(map);
      tail = L.polyline([[lat,lon]], { color: '#0ff' }).addTo(map);
    } catch (e) {
      document.getElementById('map').innerText = 'Map failed to load';
    }
  }
  function update(lat, lon, altFt, kts, hdg) {
    if (!map) initMap(lat, lon);
    try {
      marker.setLatLng([lat, lon]);
      tail.addLatLng([lat, lon]);
      if (tail.getLatLngs().length > 2000) {
        const pts = tail.getLatLngs();
        pts.shift();
        tail.setLatLngs(pts);
      }
      document.getElementById('lat').textContent = lat.toFixed(4);
      document.getElementById('lon').textContent = lon.toFixed(4);
      document.getElementById('alt').textContent = Math.round(altFt);
      document.getElementById('spd').textContent = Math.round(kts);
      document.getElementById('hdg').textContent = Math.round(hdg);
    } catch (e) {
      // ignore errors if page navigated or DOM changed
    }
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m && m.type === 'pax:pos') {
      update(m.lat, m.lon, m.altFt, m.kts, m.hdgDeg);
    }
  }, false);
</script>
</body>
</html>`;

  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (e) {
    // writing into popup may fail if cross-origin navigated; close it to be safe
    try { win.close(); } catch {}
    paxWindow = null;
  }
}

// Start periodic updates (force = send immediate)
function startUpdates(force) {
  stopUpdates();
  if (force) sendUpdate();
  updateTimer = setInterval(sendUpdate, UPDATE_MS);
}

// Stop updates
function stopUpdates() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

// Send a single update to the IFE popup
export function sendUpdate() {
  if (!paxWindow || paxWindow.closed) {
    stopUpdates();
    paxWindow = null;
    return;
  }
  const lat = U.rad2deg(App.latRad || 0);
  const lon = U.rad2deg(App.lonRad || 0); // FIX: use lonRad
  const altFt = Math.round(U.m2ft(App.heightM || 0));
  const kts = Math.round(U.ms2kts(App.speedMS || 0));
  const hdg = Math.round((U.rad2deg(App.heading || 0) + 360) % 360);

  try {
    paxWindow.postMessage({
      type: 'pax:pos',
      lat, lon, altFt, kts, hdgDeg: hdg
    }, '*');
  } catch (e) {
    // popup may have navigated away or disallowed messages; close and stop updates
    try { paxWindow.close(); } catch {}
    paxWindow = null;
    stopUpdates();
  }
}

export function dispose() {
  stopUpdates();
  if (paxWindow && !paxWindow.closed) {
    try { paxWindow.close(); } catch {}
  }
  paxWindow = null;

  // Remove any DOM listeners added in init (best-effort)
  const passengerBtn = document.getElementById('passengerBtn');
  const createIFE = document.getElementById('createIFE');
  if (passengerBtn) passengerBtn.removeEventListener('click', togglePassengerPanel);
  if (createIFE) createIFE.removeEventListener('click', openIFE);
}

// Helper to toggle the passenger panel in the main UI
function togglePassengerPanel() {
  const panel = document.getElementById('passengerPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
}
