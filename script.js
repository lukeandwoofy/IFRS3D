// script.js

// ====== Simple login gate ======
const password = 'A330';
const form = document.getElementById('loginForm');
const loadingOverlay = document.getElementById('loading');
const viewLabel = document.getElementById('viewmode');

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
    requestRenderMode: true, // reduces unnecessary re-renders (helps stability)
    maximumRenderTimeChange: Infinity
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;

  // 2) Load OSM Buildings (await required)
  try {
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
  } catch (e) {
    console.warn('OSM Buildings failed to load:', e);
  }

  // 3) Initial aircraft state (near KSFO)
  let longitude = -122.375;
  let latitude = 37.619;
  let altitude = 120; // meters
  let heading = Cesium.Math.toRadians(0);
  let pitch = 0;
  let roll = 0;

  // 4) Simple physics
  let velocity = 0; // m/s forward
  let verticalVelocity = 0; // m/s up/down
  const gravity = 9.81 / 60; // approximated per tick
  const liftFactor = 0.0005;
  const dragFactor = 0.0001;
  const thrust = 0.5;
  let currentThrust = 0;

  // 5) Controls with key debouncing for 'v'
  const keys = {};
  let canToggleView = true;
  document.addEventListener('keydown', (e) => {
    keys[e.key] = true;
  });
  document.addEventListener('keyup', (e) => {
    keys[e.key] = false;
    if (e.key === 'v') canToggleView = true;
  });

  // 6) Load aircraft model from ion
  // NOTE: replace YOUR_ASSET_ID with your Cesium ion assetId of a .glb/.gltf model
  const airplaneUri = await Cesium.IonResource.fromAssetId(3701524);
  const planeEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
    model: {
      uri: airplaneUri,
      scale: 10.0,               // make it visible
      minimumPixelSize: 256,
      runAnimations: false,
      clampAnimations: false
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    )
  });

  // 7) Camera modes
  let viewMode = 'third'; // 'third' or 'first'
  viewLabel.textContent = 'Third';

  // A helper to reset to world frame when switching from lookAtTransform usage
  function resetCameraTransform() {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  // Initial fly/zoom to the plane once some bounding info is available
  try {
    await viewer.flyTo(planeEntity, {
      duration: 1.8,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 800)
    });
  } catch (e) {
    console.warn('Initial flyTo failed (entity not ready yet); retrying...', e);
    try {
      await new Promise((res) => setTimeout(res, 800));
      await viewer.zoomTo(planeEntity);
    } catch (e2) {
      console.warn('zoomTo retry failed:', e2);
    }
  }

  loadingOverlay.classList.add('hidden');

  // 8) Tick loop
  let terrainSampleCounter = 0;

  viewer.clock.onTick.addEventListener(() => {
    // --- Controls ---
    if (keys['w']) pitch = Math.max(pitch - 0.01, -Math.PI / 2);
    if (keys['s']) pitch = Math.min(pitch + 0.01,  Math.PI / 2);
    if (keys['a']) roll -= 0.01;
    if (keys['d']) roll += 0.01;
    if (keys['q']) heading -= 0.01;
    if (keys['e']) heading += 0.01;
    if (keys['ArrowUp']) currentThrust = Math.min(currentThrust + 0.01, 1);
    if (keys['ArrowDown']) currentThrust = Math.max(currentThrust - 0.01, 0);

    if (keys['v'] && canToggleView) {
      canToggleView = false; // debounce
      viewMode = viewMode === 'third' ? 'first' : 'third';
      viewLabel.textContent = viewMode === 'third' ? 'Third' : 'First';
      resetCameraTransform(); // prevent transform accumulation flicker
    }

    // --- Dampening ---
    roll *= 0.985;
    pitch *= 0.985;

    // --- Physics ---
    velocity += currentThrust * thrust - velocity * dragFactor;
    verticalVelocity += Math.sin(pitch || 0) * (velocity || 0) * liftFactor - gravity;

    // Sanity checks (avoid NaNs)
    if (!Number.isFinite(velocity)) velocity = 0;
    if (!Number.isFinite(verticalVelocity)) verticalVelocity = 0;

    // Convert forward velocity to degrees per frame (rough, OK for demo)
    const distance = (velocity || 0) / 3600;
    const cosLat = Math.cos(latitude);
    longitude += Math.cos(heading) * distance * Math.max(0.1, Math.abs(cosLat)) * Math.cos(pitch);
    latitude  += Math.sin(heading) * distance * Math.cos(pitch);
    altitude  += verticalVelocity;

    // Keep heading bounded to avoid overflow
    if (heading > Math.PI) heading -= Math.PI * 2;
    if (heading < -Math.PI) heading += Math.PI * 2;

    // --- Terrain collision (throttled) ---
    terrainSampleCounter = (terrainSampleCounter + 1) % 12;
    if (terrainSampleCounter === 0) {
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
        Cesium.Cartographic.fromDegrees(longitude, latitude)
      ]).then((samples) => {
        if (samples && samples[0] && Number.isFinite(samples[0].height)) {
          altitude = Math.max(altitude, samples[0].height + 15);
        } else {
          altitude = Math.max(altitude, 15);
        }
      }).catch(() => {
        // ignore sampling errors, keep current altitude
      });
    } else {
      altitude = Math.max(altitude, 5); // small safety
    }

    // --- Update entity pose ---
    const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
    planeEntity.position = position;
    planeEntity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
      position,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    );

    // --- Camera control (no flicker) ---
    // Use local frame chase camera via lookAtTransform with offset.
    // - X: forward, Y: right, Z: up (local aircraft frame)
    const hpr = new Cesium.HeadingPitchRoll(heading, pitch, roll);
    const localFrame = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr);

    if (viewMode === 'third') {
      // Behind and above the aircraft, looking at it
      const chaseOffset = new Cesium.Cartesian3(-180, 0, 70); // back along -X, up along +Z
      viewer.camera.lookAtTransform(localFrame, chaseOffset);
    } else {
      // First-person-ish: just above the nose, looking at aircraft origin (close enough to feel forward)
      const cockpitOffset = new Cesium.Cartesian3(6, 0, 2);
      viewer.camera.lookAtTransform(localFrame, cockpitOffset);
    }

    // --- HUD ---
    document.getElementById('speed').textContent = Math.round((velocity || 0) * 1.944);  // m/s -> knots
    document.getElementById('altitude').textContent = Math.round((altitude || 0) * 3.281); // m -> ft
    document.getElementById('heading').textContent = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);

    // Request a render for requestRenderMode
    viewer.scene.requestRender();
  });
}
