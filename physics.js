// physics.js — robust flight physics for WebFS2025
// Exports: attach, init, update, sampleTerrainAt, dispose
// Fixes applied:
//  - Guard terrain API calls (sampleTerrainMostDetailed may be unavailable)
//  - Safer forward-vector computation in ENU to avoid lateral drift
//  - Ground clamping, vSpeed damping, and steering friction on ground
//  - Reduced reliance on viewer APIs before viewer exists

let App, CONFIG, U;
let viewer = null;
let lastPosCarto = null;
let disposed = false;

export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

export function init() {
  viewer = App && App.viewer ? App.viewer : null;
  // initialize a few defaults if missing
  App.speedMS = App.speedMS || 0;
  App.vSpeedMS = App.vSpeedMS || 0;
  App.thrustInput = typeof App.thrustInput === 'number' ? App.thrustInput : 0;
  lastPosCarto = null;
}

// Public: robust terrain sampling wrapper
export async function sampleTerrainAt(lonRad, latRad) {
  if (!viewer || !viewer.terrainProvider || typeof Cesium.sampleTerrainMostDetailed !== 'function') {
    return 0;
  }
  try {
    const carto = new Cesium.Cartographic(lonRad, latRad);
    const samples = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]);
    const h = samples?.[0]?.height;
    return typeof h === 'number' ? h : 0;
  } catch (e) {
    console.warn('[physics] Terrain sample failed:', e);
    return 0;
  }
}

// Per-frame physics update
export function update(_app, dt) {
  if (disposed) return;
  if (!App) return;

  // Ensure viewer reference (may be set after attach/init)
  viewer = App.viewer || viewer || null;

  // Basic physics parameters
  const g = CONFIG.PHYSICS?.G ?? 9.81;
  const dragCoeff = CONFIG.PHYSICS?.DRAG_COEFF ?? 0.02;
  const liftCoeff = CONFIG.PHYSICS?.LIFT_COEFF ?? 0.0025;

  // Apply throttle -> accelerate forward (very simple engine model)
  const thrustAccel = (CONFIG.PHYSICS?.MAX_THRUST_ACCEL || 8.0) * U.clamp01(App.thrustInput || 0);
  App.speedMS += thrustAccel * dt;

  // Aerodynamic drag (quadratic-ish simplified)
  const drag = dragCoeff * App.speedMS * App.speedMS * dt;
  App.speedMS = Math.max(0, App.speedMS - drag);

  // Compute forward vector in local East-North-Up (ENU) frame using heading & pitch
  // ENU forward (east, north, up): x = sin(h)*cos(p), y = cos(h)*cos(p), z = sin(p)
  const ch = Math.cos(App.heading || 0);
  const sh = Math.sin(App.heading || 0);
  const cp = Math.cos(App.pitch || 0);
  const sp = Math.sin(App.pitch || 0);

  const forwardENU = new Cesium.Cartesian3(sh * cp, ch * cp, sp);
  Cesium.Cartesian3.normalize(forwardENU, forwardENU);

  // Convert current geodetic position to ECEF
  const posCartographic = Cesium.Cartographic.fromRadians(App.lonRad || 0, App.latRad || 0, App.heightM || 0);
  const currentECEF = Cesium.Ellipsoid.WGS84.cartographicToCartesian(posCartographic);

  // Build eastNorthUpToFixedFrame and extract rotation (Matrix3)
  let enuFixed = null;
  try {
    enuFixed = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  } catch (e) {
    // Fallback: create a rotation matrix from heading only (less accurate but safe)
    enuFixed = Cesium.Matrix4.IDENTITY;
  }

  // Extract 3x3 rotation matrix (Matrix4 -> Matrix3)
  const rot3 = new Cesium.Matrix3();
  try {
    Cesium.Matrix4.getMatrix3(enuFixed, rot3);
  } catch (e) {
    // If getMatrix3 isn't available, zero-rotation fallback
    Cesium.Matrix3.clone(Cesium.Matrix3.IDENTITY, rot3);
  }

  // Transform forward vector ENU -> ECEF
  const forwardECEF = Cesium.Matrix3.multiplyByVector(rot3, forwardENU, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(forwardECEF, forwardECEF);

  // Compute displacement in ECEF for this frame
  const disp = Cesium.Cartesian3.multiplyByScalar(forwardECEF, App.speedMS * dt, new Cesium.Cartesian3());
  const nextECEF = Cesium.Cartesian3.add(currentECEF, disp, new Cesium.Cartesian3());

  // Convert back to Cartographic (lon/lat/height)
  const nextCarto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(nextECEF);
  const nextLon = nextCarto.longitude;
  const nextLat = nextCarto.latitude;
  let nextH = nextCarto.height;

  // Terrain / ground handling: sample terrain if available and clamp to ground + gear height
  if (viewer && viewer.terrainProvider && typeof Cesium.sampleTerrainMostDetailed === 'function') {
    // asynchronous sampling risk: sample only intermittently to avoid heavy calls; here we do a quick protective sample if height reduces below plausible ground
    // Use a fast sync-ish approach: if we predict below zero or very low altitude, attempt sample and clamp (best-effort)
    if (nextH < 2000) {
      // fire-and-forget sample (do not await here to avoid stalling frame)
      sampleTerrainAt(nextLon, nextLat).then((groundH) => {
        const minH = groundH + (CONFIG.PHYSICS?.GEAR_HEIGHT || 1.2);
        if (App.heightM <= minH + 0.1 || nextH <= minH + 0.1) {
          App.heightM = Math.max(App.heightM, minH);
          App.onGround = true;
          App.vSpeedMS = 0;
          // zero lateral tendencies on ground by damping speed
          App.speedMS *= 0.98;
        }
      }).catch(() => {});
    }
  }

  // Apply the computed next position (immediate)
  App.lonRad = nextLon;
  App.latRad = nextLat;
  App.heightM = nextH;

  // Vertical speed approximation (smoothed)
  const newV = (nextH - (lastPosCarto ? lastPosCarto.height : App.heightM)) / Math.max(dt, 1e-6);
  App.vSpeedMS = App.vSpeedMS * 0.85 + newV * 0.15;

  // Ground friction and steering: if on ground, damp lateral motion and reduce speed to taxi speeds
  if (App.onGround) {
    App.vSpeedMS = 0;
    // Apply stronger speed damping when on ground
    App.speedMS *= 0.995;
    // Slightly reduce roll/pitch to level
    App.roll *= 0.9;
    App.pitch *= 0.95;
  } else {
    // In-air damping to stabilize attitude
    App.roll *= CONFIG.PHYSICS?.ROLL_DAMP_AIR ?? 0.995;
    App.pitch *= CONFIG.PHYSICS?.PITCH_DAMP_AIR ?? 0.995;
  }

  // Keep angles within sane bounds
  App.roll = U.clamp(App.roll, -Math.PI / 2, Math.PI / 2);
  App.pitch = U.clamp(App.pitch, -Math.PI / 2, Math.PI / 2);
  App.heading = ((App.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Store last cartographic for vSpeed calc next frame
  lastPosCarto = { longitude: nextLon, latitude: nextLat, height: nextH };
}

// Dispose/cleanup
export function dispose() {
  disposed = true;
  viewer = null;
  lastPosCarto = null;
}
