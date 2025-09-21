// camera.js — camera modes for WebFS2025
// Exports: attach, init, lateUpdate, dispose
// Integrates with main.js App, CONFIG, U
// Modes: orbit (Cesium trackedEntity), chase (smooth behind), first (cockpit view)

let App, CONFIG, U;
let viewer;
let lastMode = null;

// Attach references
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
  viewer = null;
}

// Init called after viewer is available
export function init() {
  if (!App || !App.viewer) return;
  viewer = App.viewer;

  // Ensure camera smoothing storage
  if (!App.camPosSmooth) {
    App.camPosSmooth = viewer.camera.positionWC ? viewer.camera.positionWC.clone() : new Cesium.Cartesian3();
  }

  // Wire camera buttons if present
  const camPanel = document.getElementById('cameraPanel');
  if (camPanel) {
    camPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const mode = btn.dataset.cam;
      if (!mode) return;
      setViewMode(mode);
    });
  }

  // keep Cesium trackedEntity sync for orbit
  setViewMode(App.viewMode || 'orbit');
}

// Per-frame lateUpdate to position camera when not using Cesium trackedEntity
export function lateUpdate(dt) {
  if (!viewer || !App.planeEntity) return;

  const mode = App.viewMode || 'orbit';
  if (mode === 'orbit') {
    // Let Cesium handle orbit via trackedEntity
    if (lastMode !== 'orbit') {
      viewer.trackedEntity = App.planeEntity;
      lastMode = 'orbit';
    }
    return;
  }

  // For chase/first, we stop Cesium trackedEntity and manually set camera
  if (lastMode === 'orbit') {
    viewer.trackedEntity = undefined;
  }
  lastMode = mode;

  // Build aircraft pose matrix
  const pos = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM);
  const quat = U.hprQuat(pos, App.heading, App.pitch, App.roll);
  const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());

  // axes in body frame
  const fwd = Cesium.Matrix3.multiplyByVector(m3, new Cesium.Cartesian3(1,0,0), new Cesium.Cartesian3());
  const upb = Cesium.Matrix3.multiplyByVector(m3, new Cesium.Cartesian3(0,0,1), new Cesium.Cartesian3());

  // desired camera position
  const desired = new Cesium.Cartesian3();
  if (mode === 'chase') {
    // position behind and above the aircraft
    desired.x = pos.x - fwd.x * (CONFIG.CAMERA?.CHASE_BACK ?? 220) + upb.x * (CONFIG.CAMERA?.CHASE_UP ?? 72);
    desired.y = pos.y - fwd.y * (CONFIG.CAMERA?.CHASE_BACK ?? 220) + upb.y * (CONFIG.CAMERA?.CHASE_UP ?? 72);
    desired.z = pos.z - fwd.z * (CONFIG.CAMERA?.CHASE_BACK ?? 220) + upb.z * (CONFIG.CAMERA?.CHASE_UP ?? 72);
  } else {
    // first-person: slightly ahead and above pilot eye point
    desired.x = pos.x + fwd.x * (CONFIG.CAMERA?.FP_AHEAD ?? 8) + upb.x * (CONFIG.CAMERA?.FP_UP ?? 2.4);
    desired.y = pos.y + fwd.y * (CONFIG.CAMERA?.FP_AHEAD ?? 8) + upb.y * (CONFIG.CAMERA?.FP_UP ?? 2.4);
    desired.z = pos.z + fwd.z * (CONFIG.CAMERA?.FP_AHEAD ?? 8) + upb.z * (CONFIG.CAMERA?.FP_UP ?? 2.4);
  }

  // initialize smooth if missing
  if (!App.camPosSmooth) App.camPosSmooth = desired.clone();

  // Smooth the camera position
  const smoothFactor = CONFIG.CAMERA?.SMOOTH_FACTOR ?? 0.02;
  App.camPosSmooth.x += (desired.x - App.camPosSmooth.x) * smoothFactor;
  App.camPosSmooth.y += (desired.y - App.camPosSmooth.y) * smoothFactor;
  App.camPosSmooth.z += (desired.z - App.camPosSmooth.z) * smoothFactor;

  // Compute camera direction (look at aircraft position)
  const dir = Cesium.Cartesian3.subtract(pos, App.camPosSmooth, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(dir, dir);

  // Use aircraft up vector as camera up (gives stable roll)
  const up = upb;

  // Set view
  try {
    viewer.camera.setView({
      destination: App.camPosSmooth,
      orientation: { direction: dir, up: up }
    });
  } catch (e) {
    // ignore transient camera errors
  }
}

// Change view mode helper
function setViewMode(mode) {
  mode = mode || 'orbit';
  App.viewMode = mode;

  const viewLabel = document.getElementById('viewmode');
  if (viewLabel) viewLabel.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);

  // If orbit, enable trackedEntity; otherwise disable it and let lateUpdate handle camera
  if (viewer) {
    if (mode === 'orbit') {
      viewer.trackedEntity = App.planeEntity;
    } else {
      viewer.trackedEntity = undefined;
    }
  }
}

// Cleanup
export function dispose() {
  const camPanel = document.getElementById('cameraPanel');
  if (camPanel) camPanel.removeEventListener('click', this);
}
