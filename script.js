// script.js

// Simple login gate
const password = 'A330';
const form = document.getElementById('loginForm');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (document.getElementById('password').value === password) {
    document.getElementById('login').style.display = 'none';
    initSim().catch((err) => console.error('Init error:', err));
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
    baseLayerPicker: true
  });

  // Load OSM Buildings (await required)
  const osmBuildings = await Cesium.createOsmBuildingsAsync();
  viewer.scene.primitives.add(osmBuildings);

  // 2) Initial aircraft state (near KSFO)
  let longitude = -122.375;
  let latitude = 37.619;
  let altitude = 100; // meters
  let heading = Cesium.Math.toRadians(0);
  let pitch = 0;
  let roll = 0;

  // 3) Simple physics
  let velocity = 0; // m/s forward
  let verticalVelocity = 0; // m/s up/down
  const gravity = 9.81 / 60; // approximated per tick
  const liftFactor = 0.0005;
  const dragFactor = 0.0001;
  const thrust = 0.5;
  let currentThrust = 0;

  // 4) Controls
  const keys = {};
  document.addEventListener('keydown', (e) => (keys[e.key] = true));
  document.addEventListener('keyup', (e) => (keys[e.key] = false));
  let viewMode = 'third'; // 'third' or 'first'
  let terrainSampleCounter = 0;

  // 5) Load aircraft model from ion
  // Replace YOUR_ASSET_ID with your Cesium ion assetId of a .glb/.gltf model
  const airplaneUri = await Cesium.IonResource.fromAssetId(3701524);
  const planeEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
    model: {
      uri: airplaneUri,
      scale: 10.0, // make it visible
      minimumPixelSize: 256
    },
    // HPR will be converted to a quaternion internally
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    )
  });

  // Let Cesium compute a bounding sphere and fly the camera once the entity is ready enough
  try {
    await viewer.flyTo(planeEntity, {
      duration: 2.0,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 800)
    });
  } catch (e) {
    console.warn('flyTo failed (entity not ready yet), retrying shortly...', e);
    setTimeout(() => {
      viewer.zoomTo(planeEntity);
    }, 1000);
  }

  // 6) Main tick
  viewer.clock.onTick.addEventListener(() => {
    // Controls
    if (keys['w']) pitch = Math.max(pitch - 0.01, -Math.PI / 2);
    if (keys['s']) pitch = Math.min(pitch + 0.01, Math.PI / 2);
    if (keys['a']) roll -= 0.01;
    if (keys['d']) roll += 0.01;
    if (keys['q']) heading -= 0.01;
    if (keys['e']) heading += 0.01;
    if (keys['ArrowUp']) currentThrust = Math.min(currentThrust + 0.01, 1);
    if (keys['ArrowDown']) currentThrust = Math.max(currentThrust - 0.01, 0);

    // Toggle view mode on key press (edge-detect)
    if (keys['v']) {
      keys['v'] = false; // prevent rapid toggling
      viewMode = viewMode === 'third' ? 'first' : 'third';
      if (viewMode === 'first') {
        // Use entity tracking for a stable first-person-ish view
        viewer.trackedEntity = planeEntity;
      } else {
        viewer.trackedEntity = undefined;
      }
    }

    // Dampen roll/pitch
    roll *= 0.98;
    pitch *= 0.98;

    // Physics integration (very simplified)
    velocity += currentThrust * thrust - velocity * dragFactor;
    verticalVelocity += Math.sin(pitch) * velocity * liftFactor - gravity;

    // Convert forward velocity to degrees per frame (very rough, ok for demo)
    const distance = velocity / 3600;
    longitude += Math.cos(heading) * distance * Math.cos(pitch);
    latitude += Math.sin(heading) * distance * Math.cos(pitch);
    altitude += verticalVelocity;

    // Terrain collision: sample every few ticks to avoid promise pile-up
    terrainSampleCounter = (terrainSampleCounter + 1) % 10;
    if (terrainSampleCounter === 0) {
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
        Cesium.Cartographic.fromDegrees(longitude, latitude)
      ]).then((samples) => {
        const terrainHeight = (samples && samples[0] && Number.isFinite(samples[0].height))
          ? samples[0].height
          : 0;
        altitude = Math.max(altitude, terrainHeight + 15); // 15m safety buffer
      }).catch(() => {
        // ignore sampling errors
      });
    }

    // Update entity pose
    const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
    planeEntity.position = position;
    planeEntity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
      position,
      new Cesium.HeadingPitchRoll(heading, pitch, roll)
    );

    // Camera behavior
    if (viewMode === 'third') {
      // Keep camera behind/above the plane
      viewer.camera.lookAt(
        position,
        new Cesium.HeadingPitchRange(heading, -Cesium.Math.PI_OVER_FOUR, 500)
      );
    } else {
      // First-person via trackedEntity; minor nudge by setting view each tick (optional)
      // You can fine-tune by adjusting defaultOffset with viewer.trackedEntity settings if needed.
    }

    // HUD
    document.getElementById('speed').textContent = Math.round(velocity * 1.944); // m/s -> knots
    document.getElementById('altitude').textContent = Math.round(altitude * 3.281); // m -> ft
    document.getElementById('heading').textContent = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);
  });
}
