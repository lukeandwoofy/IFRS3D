// script.js
// Complete simulator:
// - LPPT runway 03 spawn on ground, aligned to ~030°
// - Working thrust and forward movement (ground and air)
// - Physics in meters/seconds with ENU integration
// - Ground handling (no pitch/roll before Vr, clamp to terrain + gear height)
// - Three camera modes: Orbit (mouse drag), Chase, First-person
// - Stable camera (no flicker), throttled terrain sampling, HUD updates
// - Optional flat terrain toggle for runway testing

// ====== Login ======
const PASSWORD = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');
const groundLabel = document.getElementById('ground');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = (document.getElementById('password').value || '').trim();
  if (val === PASSWORD) {
    document.getElementById('login').style.display = 'none';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    initSim().catch((err) => {
      console.error('Init error:', err);
      alert('Failed to initialize. Check console for details.');
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});

// ====== Simulator ======
async function initSim() {
  Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5NDIwYmNkOS03MTExLTRjZGEtYjI0Yy01ZmIzYzJmOGFjNGEiLCJpZCI6MzM5NTE3LCJpYXQiOjE3NTczNTg4Mzd9.3gkVP8epIlHiy3MtC2GnDgLhvD4XbhfIsWfzuyYjDZQ';

  // Toggle to true for a perfectly flat globe (useful while tuning ground physics/runway flatness)
  const useFlatTerrain = false;

  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: useFlatTerrain
      ? new Cesium.EllipsoidTerrainProvider()
      : Cesium.Terrain.fromWorldTerrain(),
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

  // Optional: buildings
  try {
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
  } catch (e) {
    console.warn('OSM Buildings failed to load:', e);
  }

  // ====== Spawn at LPPT (Lisbon) runway 03 threshold ======
  // Approx threshold coordinates for runway 03 (fine for demo)
  const startLonDeg = -9.1358;
  const startLatDeg = 38.7812;
  const runwayHeadingDeg = 30.0; // ~030°
  const startLon = Cesium.Math.toRadians(startLonDeg);
  const startLat = Cesium.Math.toRadians(startLatDeg);
  let heading = Cesium.Math.toRadians(runwayHeadingDeg);
  let pitch = 0.0; // note: negative pitch = nose up in our control convention below
  let roll = 0.0;

  // ====== Physics state (SI units) ======
  let speed = 0;              // forward speed (m/s)
  let verticalSpeed = 0;      // climb rate (m/s)
  let thrustInput = 0;        // 0..1
  const g = 9.81;             // gravity
  const maxThrustAccel = 10.0; // m/s^2 at full thrust (tuned for responsiveness)
  const dragCoeff = 0.005;     // linear drag factor
  const liftCoeff = 0.9;       // lift coupling from speed and pitch
  const gearHeight = 2.5;      // aircraft sits this high above terrain when on ground
  const takeoffSpeed = 75;     // Vr (~145 kts)
  let onGround = true;

  // ====== Controls ======
  const keys = {};
  document.addEventListener('keydown', (e) => (keys[e.key] = true));
  document.addEventListener('keyup', (e) => (keys[e.key] = false));

  // ====== Camera modes ======
  // 'orbit' (mouse-drag around tracked entity), 'chase' (world-space follow), 'first' (cockpit)
  let viewMode = 'orbit';
  let canToggleView = true;
  if (viewLabel) viewLabel.textContent = 'Orbit';

  // ====== Load aircraft ======
  const airplaneUri = await Cesium.IonResource.fromAssetId(3713667); // <- replace with your glTF/glb assetId

  // Initial terrain height for exact ground spawn
  const startSamples = await Cesium.sampleTerrainMostDetailed(
    viewer.terrainProvider,
    [new Cesium.Cartographic(startLon, startLat)]
  ).catch(() => null);

  const terrainH0 =
    startSamples && startSamples[0] && Number.isFinite(startSamples[0].height)
      ? startSamples[0].height
      : 0;

  let height = terrainH0 + gearHeight;

  const startPos = Cesium.Cartesian3.fromRadians(startLon, startLat, height);

  const planeEntity = viewer.entities.add({
    position: startPos,
    model: {
      uri: airplaneUri,
      scale: 1.0,            // keep real scale; adjust here if your asset is off
      minimumPixelSize: 96,  // visible from afar without looking gigantic
      runAnimations: false
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      startPos,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    )
  });

  // Focus the camera and enable orbit mode by tracking the entity
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 420)
    });
  } catch {}
  viewer.trackedEntity = planeEntity; // mouse orbit active in 'orbit' mode

  if (loadingOverlay) loadingOverlay.classList.add('hidden');

  // ====== Camera helpers for chase/first ======
  const AXIS_X = new Cesium.Cartesian3(1, 0, 0);
  const AXIS_Z = new Cesium.Cartesian3(0, 0, 1);
  const forward = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  const camPos = new Cesium.Cartesian3();
  const camPosSmooth = viewer.camera.positionWC.clone();
  const toTarget = new Cesium.Cartesian3();

  function getPlaneAxes(quat) {
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    Cesium.Matrix3.multiplyByVector(m3, AXIS_X, forward);
    Cesium.Matrix3.multiplyByVector(m3, AXIS_Z, up);
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ====== Timing and terrain sampling ======
  let lastTime = undefined;
  let sampleCounter = 0;
  let sampling = false;

  // ====== Main loop ======
  viewer.clock.onTick.addEventListener((clock) => {
    // dt seconds
    const now = clock.currentTime;
    const dt = lastTime
      ? Math.max(0.001, Math.min(0.1, Cesium.JulianDate.secondsDifference(now, lastTime)))
      : 1 / 60;
    lastTime = now;

    // ---- Controls ----
    // Thrust
    if (keys['ArrowUp']) thrustInput = Math.min(1, thrustInput + 0.9 * dt);
    if (keys['ArrowDown']) thrustInput = Math.max(0, thrustInput - 0.9 * dt);

    // Yaw always allowed
    if (keys['q']) heading -= 0.9 * dt;
    if (keys['e']) heading += 0.9 * dt;

    // Pitch/Roll handling
    if (onGround) {
      // Limited ground steering feel via roll
      if (keys['a']) roll -= 0.25 * dt;
      if (keys['d']) roll += 0.25 * dt;
      // Snap to level while on ground (prevents tilting)
      roll *= Math.pow(0.1, dt);
      pitch *= Math.pow(0.05, dt);
      // Allow rotate only at/above Vr
      if (speed >= takeoffSpeed && keys['w']) {
        pitch = Math.max(pitch - 0.55 * dt, -Cesium.Math.PI_OVER_TWO * 0.4);
      }
      // prevent nose-down dig-in on ground
      if (pitch > 0) pitch *= Math.pow(0.05, dt);
    } else {
      // In the air: standard controls with gentle damping
      if (keys['a']) roll -= 0.9 * dt;
      if (keys['d']) roll += 0.9 * dt;
      if (keys['w']) pitch = Math.max(pitch - 0.75 * dt, -Cesium.Math.PI_OVER_TWO * 0.6);
      if (keys['s']) pitch = Math.min(pitch + 0.75 * dt,  Cesium.Math.PI_OVER_TWO * 0.6);
      roll *= Math.pow(0.995, 60 * dt);
      pitch *= Math.pow(0.995, 60 * dt);
    }

    // View mode toggle (orbit -> chase -> first -> orbit)
    if (keys['v'] && canToggleView) {
      canToggleView = false;
      setTimeout(() => (canToggleView = true), 250);
      viewMode = viewMode === 'orbit' ? 'chase' : viewMode === 'chase' ? 'first' : 'orbit';
      if (viewLabel) viewLabel.textContent = viewMode.charAt(0).toUpperCase() + viewMode.slice(1);
      // Orbit mode uses trackedEntity to enable mouse drag; others detach and we drive camera manually
      viewer.trackedEntity = viewMode === 'orbit' ? planeEntity : undefined;
    }

    // Normalize heading to avoid overflow
    if (heading > Math.PI) heading -= Math.PI * 2;
    if (heading < -Math.PI) heading += Math.PI * 2;

    // ---- Physics ----
    // Forward speed integration
    const accel = thrustInput * maxThrustAccel - dragCoeff * speed;
    speed = Math.max(0, speed + accel * dt);

    // Lift vs gravity; negative pitch represents nose-up in our control mapping
    const lift = liftCoeff * speed * Math.sin(-pitch);
    verticalSpeed += (lift - g) * dt;
    if (onGround) verticalSpeed = Math.max(0, verticalSpeed); // don't sink into ground

    // ---- Motion integration in local ENU ----
    // Forward direction in ENU (east, north, up)
    const forwardENU = new Cesium.Cartesian3(
      Math.cos(pitch) * Math.cos(heading),
      Math.cos(pitch) * Math.sin(heading),
      onGround ? 0 : Math.sin(pitch) // stay flat while on ground
    );

    // Current ECEF
    const currentPos = planeEntity.position.getValue(clock.currentTime);
    const cartoNow = Cesium.Cartographic.fromCartesian(currentPos);
    let lon = cartoNow.longitude;
    let lat = cartoNow.latitude;
    let hNow = cartoNow.height;

    const ecef = Cesium.Cartesian3.fromRadians(lon, lat, hNow);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ecef);
    const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());

    // Convert forward ENU to ECEF and advance
    const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
    const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, speed * dt, new Cesium.Cartesian3());
    const newECEF = Cesium.Cartesian3.add(ecef, disp, new Cesium.Cartesian3());
    const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

    lon = newCarto.longitude;
    lat = newCarto.latitude;
    // Apply vertical component
    let newHeight = (newCarto.height || 0) + verticalSpeed * dt;

    // ---- Terrain clamp (throttled) ----
    let commitImmediately = true;
    sampleCounter = (sampleCounter + 1) % 8; // sample every 8 ticks
    if (sampleCounter === 0 && !sampling) {
      sampling = true;
      commitImmediately = false;
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [new Cesium.Cartographic(lon, lat)])
        .then((samples) => {
          const th =
            samples && samples[0] && Number.isFinite(samples[0].height)
              ? samples[0].height
              : 0;
          const groundH = th + gearHeight;
          if (newHeight <= groundH) {
            newHeight = groundH;
            verticalSpeed = 0;
            onGround = true;
          } else {
            onGround = false;
          }
          if (groundLabel) groundLabel.textContent = onGround ? 'Yes' : 'No';
          commitPose(lon, lat, newHeight);
        })
        .catch(() => {
          // On sampling failure, proceed without clamp
          onGround = false;
          if (groundLabel) groundLabel.textContent = 'Unknown';
          commitPose(lon, lat, newHeight);
        })
        .finally(() => {
          sampling = false;
        });
    }

    if (commitImmediately) {
      // Quick floor to avoid negatives between samples
      newHeight = Math.max(newHeight, 1.0);
      commitPose(lon, lat, newHeight);
    }

    // ---- Apply pose and drive camera/HUD ----
    function commitPose(lonR, latR, hR) {
      const pos = Cesium.Cartesian3.fromRadians(lonR, latR, hR);
      const quat = Cesium.Transforms.headingPitchRollQuaternion(
        pos,
        new Cesium.HeadingPitchRoll(heading, pitch, roll)
      );
      planeEntity.position = pos;
      planeEntity.orientation = quat;

      // Camera control
      if (viewMode === 'orbit') {
        // Do nothing per tick. trackedEntity handles mouse orbit.
      } else {
        // Compute plane axes and position camera accordingly
        getPlaneAxes(quat);

        if (viewMode === 'chase') {
          const back = 190.0;
          const rise = 65.0;
          camPos.x = pos.x - forward.x * back + up.x * rise;
          camPos.y = pos.y - forward.y * back + up.y * rise;
          camPos.z = pos.z - forward.z * back + up.z * rise;
        } else {
          // First person
          const ahead = 7.0;
          const rise = 2.0;
          camPos.x = pos.x + forward.x * ahead + up.x * rise;
          camPos.y = pos.y + forward.y * ahead + up.y * rise;
          camPos.z = pos.z + forward.z * ahead + up.z * rise;
        }

        // Smooth camera movement
        const t = 1 - Math.pow(0.02, 60 * (lastTime ? Cesium.JulianDate.secondsDifference(now, lastTime) : dt));
        const alpha = Number.isFinite(t) && t > 0 && t < 1 ? t : 0.18;
        camPosSmooth.x = camPosSmooth.x + (camPos.x - camPosSmooth.x) * alpha;
        camPosSmooth.y = camPosSmooth.y + (camPos.y - camPosSmooth.y) * alpha;
        camPosSmooth.z = camPosSmooth.z + (camPos.z - camPosSmooth.z) * alpha;

        Cesium.Cartesian3.subtract(pos, camPosSmooth, toTarget);
        Cesium.Cartesian3.normalize(toTarget, toTarget);

        if (Cesium.Cartesian3.magnitude(toTarget) > 1e-6) {
          viewer.camera.setView({
            destination: camPosSmooth,
            orientation: {
              direction: toTarget,
              up: up
            }
          });
        }
      }

      // HUD
      const spdKts = Math.round(speed * 1.94384);  // m/s -> knots
      const altFt = Math.round(hR * 3.28084);      // m -> ft
      const hdgDeg = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);
      document.getElementById('speed').textContent = spdKts;
      document.getElementById('altitude').textContent = altFt;
      document.getElementById('heading').textContent = hdgDeg;

      // Render (requestRenderMode)
      viewer.scene.requestRender();
    }
  });
}
