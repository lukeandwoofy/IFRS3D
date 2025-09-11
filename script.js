// script.js

// ====== Simple login gate ======
const password = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (document.getElementById('password').value || '').trim();
  if (val === password) {
    document.getElementById('login').style.display = 'none';
    loadingOverlay.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init error:', err);
      alert('Failed to initialize. Check the console for details.');
      loadingOverlay.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});

// ====== Main init ======
async function initSim() {
  Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ';

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
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

  viewer.scene.globe.depthTestAgainstTerrain = true;

  // Load OSM Buildings safely
  try {
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
  } catch (e) {
    console.warn('OSM Buildings failed to load:', e);
  }

  // Initial aircraft state (near KSFO)
  let longitude = Cesium.Math.toRadians(-122.375);
  let latitude = Cesium.Math.toRadians(37.619);
  let height = 8; // meters AGL start; will be clamped to terrain + gearHeight
  let heading = 0.0;
  let pitch = 0.0;
  let roll = 0.0;

  // Physics (meters, seconds)
  let speed = 0; // forward speed (m/s)
  const maxThrustAccel = 4.0; // m/s^2 at full thrust (simple)
  const dragCoeff = 0.015;    // proportional deceleration ~ v * k
  let verticalSpeed = 0;      // m/s climb
  const g = 9.81;             // m/s^2
  const liftCoeff = 0.8;      // couples pitch & speed into climb
  let thrustInput = 0;        // 0..1
  const dtFallback = 1 / 60;  // if clock delta unavailable

  // Takeoff/ground handling
  const gearHeight = 3.0;     // meters above terrain when on ground
  const takeoffSpeed = 75;    // m/s (~145 kts) minimum to rotate
  let onGround = true;

  // Controls
  const keys = {};
  document.addEventListener('keydown', (e) => (keys[e.key] = true));
  document.addEventListener('keyup', (e) => (keys[e.key] = false));

  // View mode
  let viewMode = 'third';
  let canToggleView = true;
  if (viewLabel) viewLabel.textContent = 'Third';

  // Load aircraft model
  const airplaneUri = await Cesium.IonResource.fromAssetId(3701524); // replace
  const startCarto = new Cesium.Cartographic(longitude, latitude, height);
  const startCart = Cesium.Cartesian3.fromRadians(startCarto.longitude, startCarto.latitude, startCarto.height);

  const planeEntity = viewer.entities.add({
    position: startCart,
    model: {
      uri: airplaneUri,
      scale: 1.0,               // realistic model scale (adjust if your model is off)
      minimumPixelSize: 96,     // keeps it visible at distance without giant scaling
      runAnimations: false
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      startCart,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    )
  });

  // Focus camera initially
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 600)
    });
  } catch (e) {
    try { await viewer.zoomTo(planeEntity); } catch {}
  }

  loadingOverlay.classList.add('hidden');

  // Helpers for camera
  const X = new Cesium.Cartesian3(1, 0, 0);
  const Y = new Cesium.Cartesian3(0, 1, 0);
  const Z = new Cesium.Cartesian3(0, 0, 1);
  const forward = new Cesium.Cartesian3();
  const right = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  const camPos = new Cesium.Cartesian3();
  const camPosSmoothed = viewer.camera.positionWC.clone();
  const targetDir = new Cesium.Cartesian3();
  const newPosition = new Cesium.Cartesian3();

  const lerp = (a, b, t) => a + (b - a) * t;

  function getPlaneAxes(quat) {
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    Cesium.Matrix3.multiplyByVector(m3, X, forward);
    Cesium.Matrix3.multiplyByVector(m3, Y, right);
    Cesium.Matrix3.multiplyByVector(m3, Z, up);
  }

  // Time step
  let lastTime = undefined;

  // Terrain sampling throttle
  let sampleCounter = 0;
  let sampling = false;

  // Main loop
  viewer.clock.onTick.addEventListener((clock) => {
    const now = clock.currentTime;
    const dt = lastTime ? Math.max(0.001, Math.min(0.1, Cesium.JulianDate.secondsDifference(now, lastTime))) : dtFallback;
    lastTime = now;

    // Controls
    // Thrust
    if (keys['ArrowUp'])  thrustInput = Math.min(1, thrustInput + 0.5 * dt);
    if (keys['ArrowDown']) thrustInput = Math.max(0, thrustInput - 0.5 * dt);

    // Yaw always allowed
    if (keys['q']) heading -= 0.6 * dt;
    if (keys['e']) heading += 0.6 * dt;

    // Pitch/Roll: restricted on ground
    if (onGround) {
      // Allow small steering via roll on ground? We'll limit it hard.
      if (keys['a']) roll -= 0.2 * dt;
      if (keys['d']) roll += 0.2 * dt;
      // No pitch control until takeoff
      // Auto-straighten quickly on ground
      roll *= Math.pow(0.1, dt);  // strong damping to 0
      pitch *= Math.pow(0.05, dt); // even stronger damping to 0
    } else {
      // In air
      if (keys['a']) roll -= 0.8 * dt;
      if (keys['d']) roll += 0.8 * dt;
      if (keys['w']) pitch = Math.max(pitch - 0.6 * dt, -Cesium.Math.PI_OVER_TWO * 0.6);
      if (keys['s']) pitch = Math.min(pitch + 0.6 * dt,  Cesium.Math.PI_OVER_TWO * 0.6);

      // Gentle damping
      roll *= Math.pow(0.995, 60 * dt);
      pitch *= Math.pow(0.995, 60 * dt);
    }

    // View toggle (debounced)
    if (keys['v'] && canToggleView) {
      canToggleView = false;
      setTimeout(() => (canToggleView = true), 250);
      viewMode = viewMode === 'third' ? 'first' : 'third';
      if (viewLabel) viewLabel.textContent = viewMode === 'third' ? 'Third' : 'First';
    }

    // Normalize heading
    if (heading > Math.PI) heading -= Math.PI * 2;
    if (heading < -Math.PI) heading += Math.PI * 2;

    // Compute local ENU frame at current position for motion integration
    const cart = Cesium.Cartesian3.fromRadians(longitude, latitude, height);
    const enu4 = Cesium.Transforms.eastNorthUpToFixedFrame(cart);
    const enuRot = Cesium.Matrix4.getMatrix3(enu4, new Cesium.Matrix3());

    // Physics (m/s)
    // Acceleration from thrust minus drag
    const accel = thrustInput * maxThrustAccel - dragCoeff * speed;
    speed = Math.max(0, speed + accel * dt);

    // Vertical speed: lift from pitch & speed minus gravity component
    const lift = liftCoeff * speed * Math.sin(pitch);
    verticalSpeed += (lift - g) * dt;

    // If on ground, stick to ground until rotate above Vr (takeoff speed)
    if (onGround) {
      verticalSpeed = Math.max(0, verticalSpeed); // no sinking into ground
      if (speed < takeoffSpeed) {
        pitch = Math.max(pitch, 0); // prevent nose-down digging
      }
    }

    // Advance position in local ENU
    // Forward direction in ENU coordinates (east, north, up)
    const fENU = new Cesium.Cartesian3(
      Math.cos(pitch) * Math.cos(heading),
      Math.cos(pitch) * Math.sin(heading),
      Math.sin(pitch)
    );

    // Convert ENU forward to ECEF using rotation part of ENU frame
    const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, fENU, new Cesium.Cartesian3());

    // Displacement from forward speed (horizontal/along pitch) plus verticalSpeed explicitly
    const dispECEF = Cesium.Cartesian3.multiplyByScalar(fECEF, speed * dt, new Cesium.Cartesian3());

    // Apply displacement
    Cesium.Cartesian3.add(cart, dispECEF, newPosition);

    // Convert back to cartographic and apply vertical component
    const newCarto = Cesium.Cartographic.fromCartesian(newPosition);
    // Update height by vertical speed
    height = Math.max(-100, (newCarto.height || 0) + verticalSpeed * dt); // allow slight below sea at worst
    longitude = newCarto.longitude;
    latitude = newCarto.latitude;

    // Terrain clamp (throttled sampling)
    sampleCounter = (sampleCounter + 1) % 8;
    if (sampleCounter === 0 && !sampling) {
      sampling = true;
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
        new Cesium.Cartographic(longitude, latitude)
      ]).then((samples) => {
        const th = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
        const groundH = th + gearHeight;
        if (height <= groundH) {
          height = groundH;
          verticalSpeed = 0;
          onGround = true;
        } else {
          onGround = false;
        }
        if (groundLabel) groundLabel.textContent = onGround ? 'Yes' : 'No';
      }).catch(() => {
        // ignore sampling errors
      }).finally(() => {
        sampling = false;
      });
    }

    // When on ground and below Vr, force pitch and roll to level and keep height at ground
    if (onGround) {
      pitch *= Math.pow(0.02, dt); // snap level
      roll *= Math.pow(0.1, dt);
    }

    // Update entity pose
    const updatedCart = Cesium.Cartesian3.fromRadians(longitude, latitude, height);
    const planeQuat = Cesium.Transforms.headingPitchRollQuaternion(
      updatedCart,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    );
    planeEntity.position = updatedCart;
    planeEntity.orientation = planeQuat;

    // Camera (no flicker): world-space camera placement from plane axes
    getPlaneAxes(planeQuat);

    // Offsets (meters)
    const chaseBack = 200.0;
    const chaseUp = 60.0;
    const fpAhead = 7.0;
    const fpUp = 2.0;

    if (viewMode === 'third') {
      camPos.x = updatedCart.x - forward.x * chaseBack + up.x * chaseUp;
      camPos.y = updatedCart.y - forward.y * chaseBack + up.y * chaseUp;
      camPos.z = updatedCart.z - forward.z * chaseBack + up.z * chaseUp;
    } else {
      camPos.x = updatedCart.x + forward.x * fpAhead + up.x * fpUp;
      camPos.y = updatedCart.y + forward.y * fpAhead + up.y * fpUp;
      camPos.z = updatedCart.z + forward.z * fpAhead + up.z * fpUp;
    }

    // Smooth camera
    const t = 1 - Math.pow(0.02, 60 * dt); // frame-rate independent smoothing
    camPosSmoothed.x = lerp(camPosSmoothed.x, camPos.x, t);
    camPosSmoothed.y = lerp(camPosSmoothed.y, camPos.y, t);
    camPosSmoothed.z = lerp(camPosSmoothed.z, camPos.z, t);

    // Look at plane with plane's up vector
    const toTarget = Cesium.Cartesian3.subtract(updatedCart, camPosSmoothed, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(toTarget, toTarget);

    if (Cesium.Cartesian3.magnitude(toTarget) > 1e-6) {
      viewer.camera.setView({
        destination: camPosSmoothed,
        orientation: {
          direction: toTarget,
          up: up
        }
      });
    }

    // HUD
    document.getElementById('speed').textContent = Math.round(speed * 1.94384); // m/s -> knots
    document.getElementById('altitude').textContent = Math.round(height * 3.28084); // m -> ft
    document.getElementById('heading').textContent = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);

    // Render when something changes
    viewer.scene.requestRender();
  });
}
