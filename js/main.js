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
