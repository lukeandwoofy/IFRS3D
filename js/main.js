// Replace with your Cesium ion access token
Cesium.Ion.defaultAccessToken = 'YOUR_TOKEN_HERE';

// Viewer setup
const viewer = new Cesium.Viewer('cesiumContainer', {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  imageryProvider: new Cesium.IonImageryProvider({ assetId: 2 }), // Bing imagery
  // Optionally disable widgets for a cleaner HUD
  animation: false,
  timeline: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false
});

// Optional: Add OSM Buildings for extra realism
(async function() {
  const buildings = await Cesium.createOsmBuildingsAsync();
  viewer.scene.primitives.add(buildings);
})();
// Aircraft position: choose your starting longitude, latitude, altitude (meters)
const startLon = -122.38985;
const startLat = 37.61864;
const startAlt = 200; // meters above ground, safe for testing

// Load the glTF model from Cesium ion by asset ID
(async function() {
  const airplaneURI = await Cesium.IonResource.fromAssetId(3713684);
  const airplaneEntity = viewer.entities.add({
    id: 'aircraft',
    position: Cesium.Cartesian3.fromDegrees(startLon, startLat, startAlt),
    model: { 
      uri: airplaneURI,
      scale: 1.0, // adjust if model is too large/small
      minimumPixelSize: 64
    },
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      Cesium.Cartesian3.fromDegrees(startLon, startLat, startAlt),
      new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(90), 0, 0)
    )
  });
  viewer.trackedEntity = airplaneEntity; // camera follows aircraft by default
})();
