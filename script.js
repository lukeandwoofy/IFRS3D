const password = 'A330';
const form = document.getElementById('loginForm');

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.getElementById('password').value === password) {
        document.getElementById('login').style.display = 'none';
        initSim();
    } else {
        alert('Incorrect password');
    }
});

async function initSim() {
    Cesium.Ion.defaultAccessToken = 'YOUR_TOKEN_HERE';

    const viewer = new Cesium.Viewer('cesiumContainer', {
        terrain: Cesium.Terrain.fromWorldTerrain(),
    });

    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);

    let longitude = -122.375;
    let latitude = 37.619;
    let altitude = 100;
    let heading = Cesium.Math.toRadians(0);
    let pitch = 0;
    let roll = 0;

    let velocity = 0;
    let verticalVelocity = 0;
    const gravity = 9.81 / 60;
    const liftFactor = 0.0005;
    const dragFactor = 0.0001;
    const thrust = 0.5;
    let currentThrust = 0;

    const airplaneUri = await Cesium.IonResource.fromAssetId(3701524);
    const planeEntity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
        model: {
            uri: airplaneUri,
            scale: 10.0,
            minimumPixelSize: 256,
        },
        orientation: new Cesium.HeadingPitchRoll(heading, pitch, roll),
    });

    planeEntity.model.readyPromise.then(() => {
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude + 500),
            orientation: {
                heading: heading,
                pitch: Cesium.Math.toRadians(-30),
                roll: 0,
            },
        });
    });

    const keys = {};
    document.addEventListener('keydown', (e) => keys[e.key] = true);
    document.addEventListener('keyup', (e) => keys[e.key] = false);
    let viewMode = 'third';

    viewer.clock.onTick.addEventListener(() => {
        if (keys['w']) pitch = Math.max(pitch - 0.01, -Math.PI / 2);
        if (keys['s']) pitch = Math.min(pitch + 0.01, Math.PI / 2);
        if (keys['a']) roll -= 0.01;
        if (keys['d']) roll += 0.01;
        if (keys['q']) heading -= 0.01;
        if (keys['e']) heading += 0.01;
        if (keys['ArrowUp']) currentThrust = Math.min(currentThrust + 0.01, 1);
        if (keys['ArrowDown']) currentThrust = Math.max(currentThrust - 0.01, 0);
        if (keys['v']) viewMode = viewMode === 'third' ? 'first' : 'third';

        roll *= 0.98;
        pitch *= 0.98;

        velocity += currentThrust * thrust - velocity * dragFactor;
        verticalVelocity += Math.sin(pitch) * velocity * liftFactor - gravity;
        const distance = velocity / 3600;
        longitude += Math.cos(heading) * distance * Math.cos(pitch);
        latitude += Math.sin(heading) * distance * Math.cos(pitch);
        altitude += verticalVelocity;

        Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
            Cesium.Cartographic.fromDegrees(longitude, latitude)
        ]).then((samples) => {
            const terrainHeight = samples[0].height || 0;
            altitude = Math.max(altitude, terrainHeight + 10);
        });

        planeEntity.position = Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude);
        planeEntity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
            planeEntity.position,
            new Cesium.HeadingPitchRoll(heading, pitch, roll)
        );

        if (viewMode === 'third') {
            viewer.camera.lookAt(
                planeEntity.position,
                new Cesium.HeadingPitchRange(heading, -Cesium.Math.PI_OVER_FOUR, 500)
            );
        } else {
            const offset = new Cesium.Cartesian3(0, 0, 5);
            const transform = Cesium.Matrix4.fromRotationTranslation(
                Cesium.Transforms.headingPitchRollToFixedFrame(
                    planeEntity.position,
                    new Cesium.HeadingPitchRoll(heading, pitch, roll)
                ),
                offset
            );
            viewer.camera.lookAtTransform(transform, new Cesium.HeadingPitchRange(0, 0, 0));
        }

        document.getElementById('speed').textContent = Math.round(velocity * 1.944);
        document.getElementById('altitude').textContent = Math.round(altitude * 3.281);
        document.getElementById('heading').textContent = Math.round((Cesium.Math.toDegrees(heading) + 360) % 360);
    });
}
