// physics.js — WebFS2025 flight dynamics and terrain handling
// Exports: attach, init, update, dispose
// Depends on: Cesium (global), main.js providing App, CONFIG, U

let App, CONFIG, U;

// Internal state for terrain clamping
const Terrain = {
  lastSampleTime: 0,
  sampleInterval: 0.15,   // seconds between async samples
  pending: false,
  groundH: 0,             // latest ground height (MSL) at aircraft
  gearClearance: 0,       // cached from CONFIG.PHYSICS.GEAR_HEIGHT
  hadFirstSample: false
};

// Attach references from main
export function attach(app, config, util) {
  App = app;
  CONFIG = config;
  U = util;
}

// Initialize physics state
export async function init() {
  // Cache gear clearance
  Terrain.gearClearance = CONFIG.PHYSICS.GEAR_HEIGHT;

  // Kick an initial terrain sample so clamping is correct from the start
  await sampleTerrainAt(App.lonRad, App.latRad, true);
}

// Per-frame update
export function update(_app, dt) {
  // 1) Compute thrust and drag
  // Thrust input should be set by controls module (0..1). We defensively clamp it.
  const thrust = U.clamp(App.thrustInput || 0, 0, 1) * CONFIG.PHYSICS.MAX_THRUST_ACCEL;

  // Quadratic-ish drag model (linearized to keep it simple)
  const drag = CONFIG.PHYSICS.DRAG_COEFF * App.speedMS;

  // Ground stiction: give a small push to break static friction
  let accel = thrust - drag;
  if (App.onGround && App.thrustInput > 0.02 && App.speedMS < CONFIG.PHYSICS.GROUND_STICTION_THRESH) {
    accel += CONFIG.PHYSICS.GROUND_STICTION_PUSH;
  }

  // Integrate forward speed
  App.speedMS = Math.max(0, App.speedMS + accel * dt);

  // 2) Vertical dynamics: lift vs gravity
  // A simple lift model that scales with airspeed and angle of attack (approx via -pitch)
  const lift = CONFIG.PHYSICS.LIFT_COEFF * App.speedMS * Math.sin(-App.pitch);
  const gravity = CONFIG.PHYSICS.G;

  // Update vertical speed; avoid negative vSpeed when firmly on ground
  App.vSpeedMS += (lift - gravity) * dt;
  if (App.onGround) App.vSpeedMS = Math.max(0, App.vSpeedMS);

  // 3) Integrate position in ECEF using forward vector defined by heading/pitch
  const currentECEF = Cesium.Cartesian3.fromRadians(App.lonRad, App.latRad, App.heightM);

  // Forward vector in local ENU (x=east, y=north, z=up)
  const cp = Math.cos(App.pitch);
  const sp = Math.sin(App.pitch);
  const ch = Math.cos(App.heading);
  const sh = Math.sin(App.heading);

  // On ground, keep forward vector horizontal to prevent nose-diving into terrain at rest
  const forwardENU = new Cesium.Cartesian3(
    cp * ch,
    cp * sh,
    App.onGround ? 0.0 : sp
  );
  normalize3(forwardENU);

  // Transform ENU forward into ECEF and move by speed*dt
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(currentECEF);
  const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const forwardECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
  const dispECEF = Cesium.Cartesian3.multiplyByScalar(forwardECEF, App.speedMS * dt, new Cesium.Cartesian3());
  const newECEF = Cesium.Cartesian3.add(currentECEF, dispECEF, new Cesium.Cartesian3());
  const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

  App.lonRad = newCarto.longitude;
  App.latRad = newCarto.latitude;

  // Height integration
  let newHeight = (newCarto.height || 0) + App.vSpeedMS * dt;

  // 4) Terrain sampling (async) and clamping
  // Periodically refresh ground height under the aircraft
  Terrain.lastSampleTime += dt;
  if (!Terrain.pending && Terrain.lastSampleTime >= Terrain.sampleInterval) {
    Terrain.lastSampleTime = 0;
    sampleTerrainAt(App.lonRad, App.latRad, false);
  }

  // Clamp to terrain using the latest known groundH
  const minAllowed = (Terrain.groundH || 0) + Terrain.gearClearance;
  if (newHeight <= minAllowed) {
    newHeight = minAllowed;
    App.vSpeedMS = 0;
    App.onGround = true;
  } else {
    App.onGround = false;
  }

  // 5) Gentle angular damping (prevents runaway rotations if controls are noisy)
  if (!App.onGround) {
    App.roll *= CONFIG.PHYSICS.ROLL_DAMP_AIR ?? 0.995;
    App.pitch *= CONFIG.PHYSICS.PITCH_DAMP_AIR ?? 0.995;
  }

  // 6) Commit height for the frame
  App.heightM = newHeight;
}

// Cleanup if needed
export function dispose() {
  // No resources allocated here that require manual disposal
}

// --------------------------
// Helpers
// --------------------------
function normalize3(v) {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m > 1e-8) {
    v.x /= m; v.y /= m; v.z /= m;
  } else {
    v.x = 1; v.y = 0; v.z = 0;
  }
  return v;
}

async function sampleTerrainAt(lonRad, latRad, first) {
  if (!App.viewer || !App.viewer.terrainProvider) return;
  Terrain.pending = true;
  try {
    const samples = await Cesium.sampleTerrainMostDetailed(
      App.viewer.terrainProvider,
      [new Cesium.Cartographic(lonRad, latRad)]
    );
    const th = samples?.[0]?.height ?? 0;
    Terrain.groundH = th;
    Terrain.hadFirstSample = Terrain.hadFirstSample || first;

    // If this is the first sample (e.g., on init) or we somehow dipped below,
    // snap the aircraft above ground immediately.
    const minAllowed = th + Terrain.gearClearance;
    if (App.heightM < minAllowed) {
      App.heightM = minAllowed;
      App.vSpeedMS = 0;
      App.onGround = true;
    }
  } catch (e) {
    console.warn('[physics] Terrain sample failed:', e?.message || e);
  } finally {
    Terrain.pending = false;
  }
}
