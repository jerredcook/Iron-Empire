import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type QualityLevel = 'ultra' | 'balanced' | 'performance';

export interface QualityPreset {
  label: string;
  /** Scene-target MSAA sample count (hardware AA, no post-blur). */
  msaa: number;
  /** Device-pixel-ratio cap. */
  dpr: number;
  gtao: boolean;
  gtaoSamples: number;
  bloom: boolean;
  /** Sun shadow map resolution (applied by main to the light). */
  shadowMap: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  ultra: { label: 'Ultra', msaa: 8, dpr: 3, gtao: true, gtaoSamples: 16, bloom: true, shadowMap: 4096 },
  balanced: { label: 'Balanced', msaa: 4, dpr: 2, gtao: true, gtaoSamples: 8, bloom: true, shadowMap: 2048 },
  performance: { label: 'Performance', msaa: 2, dpr: 1.5, gtao: false, gtaoSamples: 8, bloom: false, shadowMap: 2048 },
};

/**
 * Full-resolution renderer with a rebuildable post stack: native (capped) device
 * pixel ratio, an MSAA HalfFloat scene target (true hardware AA — no post-blur),
 * optional GTAO contact shadows, optional bloom, ACES filmic output. The whole
 * pipeline is torn down and rebuilt by setQuality() so the player can trade fidelity
 * for frame rate at runtime.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  quality: QualityLevel = 'ultra';
  private composer?: EffectComposer;
  private gtao?: GTAOPass;
  private bloom?: UnrealBloomPass;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private worldSize = 1;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.82;
    container.appendChild(this.gl.domElement);
  }

  attach(scene: THREE.Scene, camera: THREE.PerspectiveCamera, worldSize: number): void {
    this.scene = scene;
    this.camera = camera;
    this.worldSize = worldSize;
    this.build();
  }

  /** Swap quality tier: re-caps the pixel ratio and rebuilds the post pipeline. */
  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.build();
  }

  /** (Re)assemble the composer for the current quality preset, disposing the old. */
  private build(): void {
    if (!this.scene || !this.camera) return;
    const p = QUALITY[this.quality];
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, p.dpr));

    // Tear down the previous pipeline so swapping tiers doesn't leak GPU targets.
    this.gtao?.dispose?.();
    this.bloom?.dispose?.();
    this.composer?.dispose?.();
    this.gtao = undefined;
    this.bloom = undefined;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = this.gl.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(w * dpr, h * dpr, { samples: p.msaa, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.gl, target);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (p.gtao) {
      this.gtao = new GTAOPass(this.scene, this.camera, w, h);
      this.gtao.output = GTAOPass.OUTPUT.Default;
      this.gtao.updateGtaoMaterial({
        radius: this.worldSize * 0.004,
        distanceExponent: 1,
        thickness: 1,
        scale: 1.0,
        samples: p.gtaoSamples,
        distanceFallOff: 1,
        screenSpaceRadius: false,
      });
      this.composer.addPass(this.gtao);
    }
    if (p.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.12, 0.5, 0.9);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h);
    this.composer?.setSize(w, h);
    this.gtao?.setSize(w, h);
    this.bloom?.setSize(w, h);
  }

  render(): void {
    this.composer?.render();
  }
}
