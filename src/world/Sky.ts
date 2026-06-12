import * as THREE from 'three';
import { loadHdri } from '../engine/Assets';

export interface SkyRig {
  sun: THREE.DirectionalLight;
  sunDirection: THREE.Vector3;
}

/**
 * Image-based sky: a 4k Poly Haven HDRI drives both the visible sky dome and the
 * physical ambient light (scene.environment), with a shadow-casting directional sun
 * matched to the HDRI's sun position.
 */
export async function buildSky(scene: THREE.Scene, worldSize: number): Promise<SkyRig> {
  const hdri = await loadHdri('/assets/hdri/kloofendal_48d_partly_cloudy_puresky_4k.hdr');
  scene.background = hdri;
  scene.environment = hdri;
  scene.backgroundIntensity = 1.0;
  scene.environmentIntensity = 0.8;

  // Sun matched to the kloofendal HDRI (~48 deg elevation).
  const elevation = THREE.MathUtils.degToRad(48);
  const azimuth = THREE.MathUtils.degToRad(205);
  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth)
  );

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
  sun.position.copy(dir).multiplyScalar(worldSize);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 1.2;
  const cam = sun.shadow.camera;
  const span = worldSize * 0.62;
  cam.left = -span;
  cam.right = span;
  cam.top = span;
  cam.bottom = -span;
  cam.near = 1;
  cam.far = worldSize * 3;
  cam.updateProjectionMatrix();

  scene.add(sun, sun.target);
  return { sun, sunDirection: dir };
}
