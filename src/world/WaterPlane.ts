import * as THREE from 'three';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { waterNormals } from '../engine/Assets';

/** Planar-reflection water (three.js Water): mirrors the HDRI sky and the terrain. */
export class WaterPlane {
  readonly water: Water;

  constructor(seaLevel: number, size: number, sunDirection: THREE.Vector3) {
    const geo = new THREE.PlaneGeometry(size * 2, size * 2);
    this.water = new Water(geo, {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals: waterNormals(),
      sunDirection: sunDirection.clone().normalize(),
      sunColor: 0xfff3e0,
      waterColor: 0x06343d,
      distortionScale: 2.8,
      fog: false,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = seaLevel;
    const mat = this.water.material as THREE.ShaderMaterial;
    mat.uniforms.size.value = 6.0; // finer ripples
  }

  update(dt: number): void {
    (this.water.material as THREE.ShaderMaterial).uniforms.time.value += dt * 0.6;
  }
}
