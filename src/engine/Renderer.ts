import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Full-resolution renderer: native device pixel ratio, 8x-MSAA HalfFloat scene
 * target (true hardware AA — no post-blur), GTAO contact shadows, gentle bloom,
 * ACES filmic output.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private gtao!: GTAOPass;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 3));
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.82;
    container.appendChild(this.gl.domElement);
  }

  attach(scene: THREE.Scene, camera: THREE.PerspectiveCamera, worldSize: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = this.gl.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(w * dpr, h * dpr, { samples: 8, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.gl, target);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(scene, camera));
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: worldSize * 0.004,
      distanceExponent: 1,
      thickness: 1,
      scale: 1.0,
      samples: 16,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
    this.composer.addPass(this.gtao);
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.12, 0.5, 0.9));
    this.composer.addPass(new OutputPass());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h);
    this.composer?.setSize(w, h);
    this.gtao?.setSize(w, h);
  }

  render(): void {
    this.composer.render();
  }
}
