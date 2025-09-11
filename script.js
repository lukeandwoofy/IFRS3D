// script.js
// Complete sim logic with: LPPT runway spawn (on ground), working physics, and three camera modes
// Modes: Orbit (mouse-drag), Chase, First-person (toggle with V)
// Controls: W/S (pitch), A/D (roll), Q/E (yaw), ArrowUp/Down (thrust)

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
      alert('Failed to initialize. Check the console for details.');
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
    });
  } else {
    alert('Incorrect password');
  }
});

async function initSim() {
  // 1) Cesium setup
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

  // 2) OSM Buildings (optional)
  try {
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
  } catch (e) {
    console.warn('OSM Buildings failed to load:', e);
  }

  // 3) Spawn at LPPT (Lisbon) Runway 03 threshold, on the ground, aligned ~030°
  const startLonDeg = -9.1358;
  const startLatDeg = 38.7812;
  const runwayHeadingDeg = 30.0; // Runway 03 ≈ 030°
  const startLon = Cesium.Math.toRadians(startLonDeg);
  const startLat = Cesium.Math.toRadians(startLatDeg);
  let heading = Cesium.Math.toRadians(runwayHeadingDeg);
  let pitch = 0.0;
  let roll = 0.0;

  // Physics (meters/seconds)
  let speed = 0;              // forward speed (m/s)
  let verticalSpeed = 0;      // climb rate (m/s)
  let thrustInput = 0;        // 0..1
  const g = 9.81;             // gravity
  const maxThrustAccel = 3.0; // m/s^2 at full thrust (simple)
  const dragCoeff = 0.02;     // linear drag
  const liftCoeff = 0.9;      // lift coupling from pitch & speed

  // Ground handling
  const gearHeight = 2.5;     // meters above terrain when on ground
  const takeoffSpeed = 75;    // Vr ~145 kts ≈ 75 m/s
  let onGround = true;

  // Controls
  const keys = {};
  document.addEventListener('keydown', (e) => (keys[e.key] = true));
  document.addEventListener('keyup', (e) => (keys[e.key] = false));

  // Camera modes: 'orbit' (mouse-drag with trackedEntity), 'chase', 'first'
  let viewMode = 'orbit';
  let canToggleView = true;
  if (viewLabel) viewLabel.textContent = 'Orbit';

  // 4) Load aircraft model
  const airplaneUri = await Cesium.IonResource.fromAssetId(3709634); // <- replace with your .glb/.gltf ion assetId

  // Get initial terrain height at LPPT and set start height
  const startSamples = await Cesium.sampleTerrainMostDetailed(
    viewer.terrainProvider,
    [Cesium.Cartographic.fromRadians(startLon, startLat)]
  ).catch(() => null);

  const terrainH0 = startSamples && startSamples[0] && Number.isFinite(startSamples[0].height)
    ? startSamples[0].height
    : 0;

  let height = terrainH0 + gearHeight;

  const startPos = Cesium.Cartesian3.fromRadians(startLon, startLat, height);

  const planeEntity = viewer.entities.add({
    position: startPos,
    model: {
      uri: airplaneUri,
      scale: 1.0,            // realistic default; adjust if your model needs it
      minimumPixelSize: 96,  // keeps it visible at distance
      runAnimations: false
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      startPos,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    )
  });

  // 5) Camera initial framing and orbit attachment
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 400)
    });
  } catch {}
  viewer.trackedEntity = planeEntity; // enable mouse-drag orbit in Orbit mode

  if (loadingOverlay) loadingOverlay.classList.add('hidden');

  // 6) Helpers for chase/first-person camera
  const X = new Cesium.Cartesian3(1, 0, 0);
  const Y = new Cesium.Cartesian3(0, 1, 0);
  const Z = new Cesium.Cartesian3(0, 0, 1);
  const forward = new Cesium.Cartesian3();
  const right = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  const camPos = new Cesium.Cartesian3();
  const camPosSmooth = viewer.camera.positionWC.clone();
  const toTarget = new Cesium.Cartesian3();

  function getPlaneAxes(quat) {
    const m3 = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
    Cesium.Matrix3.multiplyByVector(m3, X, forward);
    Cesium.Matrix3.multiplyByVector(m3, Y, right);
    Cesium.Matrix3.multiplyByVector(m3, Z, up);
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  // 7) Time/terrain sampling
  let lastTime = undefined;
  let sampleCounter = 0;
  let sampling = false;

  // 8) Main simulation loop
  viewer.clock.onTick.addEventListener((clock) => {
    // dt in seconds
    const now = clock.currentTime;
    const dt = lastTime ? Math.max(0.001, Math.min(0.1, Cesium.JulianDate.secondsDifference(now, lastTime))) : 1 / 60;
    lastTime = now;

    // Thrust control
    if (keys['ArrowUp'])   thrustInput = Math.min(1, thrustInput + 0.8 * dt);
    if (keys['ArrowDown']) thrustInput = Math.max(0, thrustInput - 0.8 * dt);

    // Yaw always allowed (rudder / steering)
    if (keys['q']) heading -= 0.8 * dt;
    if (keys['e']) heading += 0.8 * dt;

    // Pitch/Roll handling
    if (onGround) {
      // Ground: limit roll; no pitch until rotation speed
      if (keys['a']) roll -= 0.25 * dt;
      if (keys['d']) roll += 0.25 * dt;

      // Snap to level on ground
      roll *= Math.pow(0.1, dt);
      pitch *= Math.pow(0.05, dt);

      // Allow gentle rotate at/above Vr
      if (speed >= takeoffSpeed) {
        if (keys['w']) pitch = Math.max(pitch - 0.5 * dt, -Cesium.Math.PI_OVER_TWO * 0.4);
      }
      if (pitch > 0) pitch *= Math.pow(0.05, dt);
    } else {
      // In the air
      if (keys['a']) roll -= 0.9 * dt;
      if (keys['d']) roll += 0.9 * dt;
      if (keys['w']) pitch = Math.max(pitch - 0.7 * dt, -Cesium.Math.PI_OVER_TWO * 0.6);
      if (keys['s']) pitch = Math.min(pitch + 0.7 * dt,  Cesium.Math.PI_OVER_TWO * 0.6);

      // Gentle damping
      roll *= Math.pow(0.995, 60 * dt);
      pitch *= Math.pow(0.995, 60 * dt);
    }

    // View mode toggle (V cycles: orbit -> chase -> first -> orbit)
    if (keys['v'] && canToggleView) {
      canToggleView = false;
      setTimeout(() => (canToggleView = true), 250);
      viewMode = viewMode === 'orbit' ? 'chase' : viewMode === 'chase' ? 'first' : 'orbit';
      if (viewLabel) viewLabel.textContent = viewMode.charAt(0).toUpperCase() + viewMode.slice(1);

      if (viewMode === 'orbit') {
        viewer.trackedEntity = planeEntity; // mouse-drag orbit
      } else {
        viewer.trackedEntity = undefined;   // manual camera
      }
    }

    // Normalize heading
    if (heading > Math.PI) heading -= Math.PI * 2;
    if (heading < -Math.PI) heading += Math.PI * 2;

    // Current cartographic and ENU frame
    const cartNow = Cesium.Cartographic.fromCartesian(planeEntity.position.getValue(clock.currentTime));
    let lon = cartNow.longitude;
    let lat = cartNow.latitude;
    let hNow = cartNow.height;

    // Accelerations
    const accel = thrustInput * maxThrustAccel - dragCoeff * speed;
    speed = Math.max(0, speed + accel * dt);

    // Lift vs gravity (negative pitch is nose-up by our control convention)
    const lift = liftCoeff * speed * Math.sin(-pitch);
    verticalSpeed += (lift - g) * dt;

    if (onGround) {
      verticalSpeed = Math.max(0, verticalSpeed);
    }

    // Advance position using local ENU
    const forwardENU = new Cesium.Cartesian3(
      Math.cos(pitch) * Math.cos(heading),
      Math.cos(pitch) * Math.sin(heading),
      Math.sin(pitch)
    );

    const ecef = Cesium.Cartesian3.fromRadians(lon, lat, hNow);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ecef);
    const enuRot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
    const fECEF = Cesium.Matrix3.multiplyByVector(enuRot, forwardENU, new Cesium.Cartesian3());
    const disp = Cesium.Cartesian3.multiplyByScalar(fECEF, speed * dt, new Cesium.Cartesian3());
    const newECEF = Cesium.Cartesian3.add(ecef, disp, new Cesium.Cartesian3());
    const newCarto = Cesium.Cartographic.fromCartesian(newECEF);

    // Apply vertical speed
    let newHeight = (newCarto.height || 0) + verticalSpeed * dt;
    lon = newCarto.longitude;
    lat = newCarto.latitude;

    // Terrain clamp (throttled)
    let willCommitNow = true;
    sampleCounter = (sampleCounter + 1) % 8;
    if (sampleCounter === 0 && !sampling) {
      sampling = true;
      willCommitNow = false;
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [new Cesium.Cartographic(lon, lat)])
        .then((samples) => {
          const th = samples && samples[0] && Number.isFinite(samples[0].height) ? samples[0].height : 0;
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
          onGround = false;
          if (groundLabel) groundLabel.textContent = 'Unknown';
          commitPose(lon, lat, newHeight);
        })
        .finally(() => {
          sampling = false;
        });
    }

    if (willCommitNow) {
      newHeight = Math.max(newHeight, 1.0); // quick floor between samples
      commitPose(lon, lat, newHeight);
    }

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
        // Do nothing per frame — Cesium handles mouse orbit while trackedEntity is set
      } else {
        // Compute plane axes for camera placement
        getPlaneAxes(quat);

        if (viewMode === 'chase') {
          // World-space chase camera behind/above plane, smooth
          const back = 180.0;
          const rise = 60.0;
          camPos.x = pos.x - forward.x * back + up.x * rise;
          camPos.y = pos.y - forward.y * back + up.y * rise;
          camPos.z = pos.z - forward.z * back + up.z * rise;
        } else {
          // First-person cockpit offset
          const ahead = 7.0;
          const rise = 2.0;
          camPos.x = pos.x + forward.x * ahead + up.x * rise;
          camPos.y = pos.y + forward.y * ahead + up.y * rise;
          camPos.z = pos.z + forward.z * ahead + up.z * rise;
        }

        // Smooth camera for chase/first
        const t = 1 - Math.pow(0.02, 60 * dt);
        camPosSmooth.x = lerp(camPosSmooth.x, camPos.x, t);
        camPosSmooth.y = lerp(camPosSmooth.y, camPos.y, t);
        camPosSmooth.z = lerp(camPosSmooth.z, camPos.z, t);

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
      document.getElementById('speed').textContent = Math.round(speed * 1.94384);       // m/s -> knots
      document.getElementById('altitude').textContent = Math.round(hR * 3.28084);       // m -> ft
      document.getElementById('heading').textContent = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);

      // Render for requestRenderMode
      viewer.scene.requestRender();
    }
  });
}
