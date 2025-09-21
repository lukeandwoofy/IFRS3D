// multiplayer.js — simple multiplayer position sync for WebFS2025
// Exports: attach, init, update, dispose
// Features:
//  - Connects to a WebSocket server (CONFIG.MULTIPLAYER.SERVER_URL)
//  - Sends periodic position updates for the local aircraft
//  - Receives other players' positions and renders them as Cesium entities
//  - Basic interpolation for smooth movement
// Notes:
//  - This is a lightweight client stub. A compatible server must accept JSON messages:
//      { type: "hello", callsign }
//      { type: "pos", id, lon, lat, alt, heading, speed, ts }
//    and broadcast peers back as { type: "peer", id, ... } or { type: "leave", id }.
//  - The module tolerates missing CONFIG.MULTIPLAYER and will remain inactive.

let App, CONFIG, U;
let socket = null;
let sendTimer = null;
let peers = {}; // id -> { entity, last, interp }

const SEND_INTERVAL_MS = 500; // how often we send our position

export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

export async function init() {
  // no-op when multiplayer disabled
  const cfg = CONFIG.MULTIPLAYER || {};
  if (!cfg.SERVER_URL) {
    console.warn('[multiplayer] no SERVER_URL configured; multiplayer disabled');
    return;
  }

  try {
    connect(cfg.SERVER_URL, cfg.callsign || 'WEBFS');
  } catch (e) {
    console.warn('[multiplayer] connect failed', e);
  }
}

export function update(_app, dt) {
  // update interpolation for remote peers
  const now = Date.now();
  for (const id in peers) {
    const p = peers[id];
    if (!p || !p.interp || !p.entity) continue;
    // interpolate between last two known samples
    const a = p.interp.a; // older
    const b = p.interp.b; // newer
    if (!a || !b) continue;

    const span = Math.max(1, b.ts - a.ts);
    const t = U.clamp01((now - b.ts) / span + 1); // predict slightly forward
    const lon = lerp(a.lon, b.lon, t);
    const lat = lerp(a.lat, b.lat, t);
    const alt = lerp(a.alt, b.alt, t);

    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    p.entity.position = pos;

    // orientation from heading only (simple)
    const headingRad = U.deg2rad(lerpAngle(a.hdg, b.hdg, t));
    const quat = Cesium.Transforms.headingPitchRollQuaternion(
      pos,
      headingRad,
      0,
      0
    );
    p.entity.orientation = quat;
  }
}

export function dispose() {
  disconnect();
  // remove entities
  if (App && App.viewer) {
    for (const id in peers) {
      try { App.viewer.entities.remove(peers[id].entity); } catch {}
    }
  }
  peers = {};
}

// -------------------------
// Networking
// -------------------------
function connect(url, callsign) {
  if (!App || !App.viewer) throw new Error('multiplayer requires App.viewer');

  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    console.log('[multiplayer] connected to', url);
    // send hello with optional callsign
    socket.send(JSON.stringify({ type: 'hello', callsign: callsign || 'WEBFS' }));
    // start periodic sends
    sendTimer = setInterval(sendPosition, SEND_INTERVAL_MS);
  });

  socket.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    } catch (e) {
      console.warn('[multiplayer] bad message', e);
    }
  });

  socket.addEventListener('close', () => {
    console.warn('[multiplayer] socket closed');
    cleanupSocket();
  });

  socket.addEventListener('error', (e) => {
    console.warn('[multiplayer] socket error', e);
    cleanupSocket();
  });
}

function disconnect() {
  if (socket) {
    try { socket.close(); } catch {}
    cleanupSocket();
  }
}

function cleanupSocket() {
  if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  socket = null;
}

// -------------------------
// Message handling
// -------------------------
function handleMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'peer') {
    // single peer update
    upsertPeer(msg);
  } else if (msg.type === 'peers' && Array.isArray(msg.items)) {
    // batch of peers
    for (const it of msg.items) upsertPeer(it);
  } else if (msg.type === 'leave' && msg.id) {
    removePeer(msg.id);
  } else if (msg.type === 'ping') {
    // optional server ping; reply with pong
    socket && socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
  }
}

// Upsert or update peer record
function upsertPeer(data) {
  const id = data.id;
  if (!id || (App && App._localId && id === App._localId)) return;

  const lon = Number(data.lon || data.lng || data.longitude || 0);
  const lat = Number(data.lat || data.latitude || 0);
  const alt = Number(data.alt || data.alt_m || data.altitude || 0);
  const hdg = Number(data.hdg || data.heading || 0);
  const speed = Number(data.speed || 0);
  const ts = Number(data.ts || Date.now());

  let p = peers[id];
  if (!p) {
    // create new entity for this peer
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    const ent = App.viewer.entities.add({
      id: `peer-${id}`,
      position: pos,
      point: { pixelSize: 10, color: Cesium.Color.YELLOW },
      label: { text: data.callsign || id, font: '12px sans-serif', fillColor: Cesium.Color.WHITE, style: Cesium.LabelStyle.FILL_AND_OUTLINE, outlineWidth: 2 }
    });
    p = { id, entity: ent, last: null, interp: { a: null, b: null } };
    peers[id] = p;
  }

  // shift samples for interpolation
  p.interp.a = p.interp.b || null;
  p.interp.b = { lon, lat, alt, hdg, speed, ts };
  p.last = p.interp.b;
}

// Remove peer
function removePeer(id) {
  const p = peers[id];
  if (!p) return;
  try { App.viewer.entities.remove(p.entity); } catch (e) {}
  delete peers[id];
}

// -------------------------
// Send local position
// -------------------------
function sendPosition() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!App) return;

  const payload = {
    type: 'pos',
    // id is optional; server may assign
    lon: U.rad2deg(App.lonRad || 0),
    lat: U.rad2deg(App.latRad || 0),
    alt: Math.round(App.heightM || 0),
    heading: Math.round((U.rad2deg(App.heading || 0) + 360) % 360),
    speed: Math.round(U.ms2kts(App.speedMS || 0)),
    ts: Date.now()
  };
  try {
    socket.send(JSON.stringify(payload));
  } catch (e) {
    // ignore send failures
  }
}

// -------------------------
// Helpers
// -------------------------
function lerp(a, b, t) { return a + (b - a) * U.clamp01(t); }

// angular lerp handling wraparound (degrees)
function lerpAngle(aDeg, bDeg, t) {
  const a = ((aDeg % 360) + 360) % 360;
  const b = ((bDeg % 360) + 360) % 360;
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return a + diff * U.clamp01(t);
}
