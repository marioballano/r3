import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { globals } from '../shaders/common';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';

/** Final-stage "cyberdeck" lens: chromatic aberration, slice glitch, scanlines, grain, vignette, flash. */
class CyberEffect extends Effect {
  constructor() {
    super(
      'CyberEffect',
      /* glsl */ `
      uniform float uTime;
      uniform float uGlitch;
      uniform float uAberration;
      uniform float uScan;
      uniform float uGrain;
      uniform float uVignette;
      uniform float uFlash;
      uniform vec3 uTint;

      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 st = uv;
        // slice glitch
        float g = uGlitch;
        if (g > 0.001) {
          float ft = floor(uTime * 24.0);
          float band = floor(st.y * (12.0 + 30.0 * h21(vec2(ft, 1.0))));
          float r = h21(vec2(band, ft));
          if (r < g * 0.55) st.x += (h21(vec2(band, ft + 7.0)) - 0.5) * 0.22 * g;
          if (h21(vec2(ft, 3.0)) < g * 0.25) st.y += (h21(vec2(ft, 9.0)) - 0.5) * 0.03 * g;
        }
        vec2 d = st - 0.5;
        float r2 = dot(d, d);
        vec2 off = d * (uAberration * (0.35 + r2 * 3.0)) + vec2(g * 0.012, 0.0);
        vec3 c;
        c.r = texture2D(inputBuffer, st + off).r;
        c.g = texture2D(inputBuffer, st).g;
        c.b = texture2D(inputBuffer, st - off).b;
        // scanlines + slow rolling refresh band
        float s = 0.5 + 0.5 * sin(st.y * resolution.y * 1.5707);
        c *= 1.0 - uScan * (1.0 - s);
        float roll = smoothstep(0.0, 0.08, fract(st.y * 0.35 - uTime * 0.07)) * smoothstep(0.16, 0.08, fract(st.y * 0.35 - uTime * 0.07));
        c *= 1.0 + 0.05 * roll;
        // grain
        c += (h21(st * resolution + fract(uTime) * 100.0) - 0.5) * uGrain;
        // vignette
        float v = smoothstep(0.95, 0.25, length(d * vec2(1.0, 1.15)));
        c *= mix(1.0, v, uVignette);
        // grade: lift blacks into indigo, tint
        c = c * uTint + vec3(0.010, 0.003, 0.028) * (1.0 - clamp(c, 0.0, 1.0));
        c += uFlash * vec3(0.85, 0.9, 1.0);
        outputColor = vec4(c, inputColor.a);
      }`,
      {
        attributes: EffectAttribute.CONVOLUTION,
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, THREE.Uniform>([
          ['uTime', new THREE.Uniform(0)],
          ['uGlitch', new THREE.Uniform(0)],
          ['uAberration', new THREE.Uniform(0.006)],
          ['uScan', new THREE.Uniform(0.12)],
          ['uGrain', new THREE.Uniform(0.045)],
          ['uVignette', new THREE.Uniform(0.85)],
          ['uFlash', new THREE.Uniform(0)],
          ['uTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ]),
      },
    );
  }
  u(name: string): THREE.Uniform {
    return this.uniforms.get(name)!;
  }
}

export type Updater = (dt: number, t: number) => void;

/** Installed by the WebXR layer: runs around the frame while an immersive session is presenting. */
export interface XRHooks {
  /** headset camera to render with (a child of the XR rig) */
  camera: THREE.PerspectiveCamera;
  /** before the updaters: controller input, locomotion, sync the virtual camera from the head */
  before(dt: number): void;
  /** after the updaters: move the rig to follow camera flights */
  after(dt: number): void;
}

/** Headsets have no use for a desktop-sized MSAA backbuffer, but the XR layer inherits the context's antialias flag. */
const XR_BROWSER = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);

export class Engine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  bloom: BloomEffect;
  cyber: CyberEffect;
  private updaters = new Set<Updater>();
  private clock = new THREE.Clock();
  time = 0;
  private lastInput = performance.now();
  private readingView = false;
  private frameTimes: number[] = [];
  quality = 2; // 2 high, 1 medium, 0 low
  autoQuality = true;
  idleOrbit = true;
  rig: { update(dt: number): void } | null = null;
  xr: XRHooks | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: XR_BROWSER, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.xr.enabled = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 9000);
    this.camera.position.set(0, 260, 520);

    this.scene.background = new THREE.Color(0x05020c);
    this.scene.fog = new THREE.FogExp2(0x12052a, 0.0016);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 2400;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.autoRotateSpeed = 0.25;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', () => this.touch());

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 1.35, luminanceThreshold: 0.4, luminanceSmoothing: 0.3, radius: 0.78 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, tone));
    this.cyber = new CyberEffect();
    this.composer.addPass(new EffectPass(this.camera, this.cyber));

    window.addEventListener('resize', () => this.resize());
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(ev, () => this.touch(), { passive: true });
  }

  touch() {
    this.lastInput = performance.now();
    this.controls.autoRotate = false;
  }

  setReadingView(reading: boolean) {
    this.readingView = reading;
    if (reading) {
      this.cyber.u('uGlitch').value = 0;
      this.cyber.u('uFlash').value = 0;
    }
    this.cyber.u('uAberration').value = reading ? 0 : 0.006;
    this.cyber.u('uGrain').value = reading ? 0.008 : 0.045;
    this.cyber.u('uScan').value = reading ? 0.055 : 0.12;
    this.cyber.u('uVignette').value = reading ? 0.50 : 0.85;
  }

  get idleSeconds() {
    return (performance.now() - this.lastInput) / 1000;
  }

  add(fn: Updater) {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  private centerShift = 0;
  private shiftTween: { v: number } = { v: 0 };

  /** Shift the projection centre left by `px` (keeps the subject clear of a docked panel). */
  setCenterShift(px: number) {
    if (this.centerShift === px) return;
    this.centerShift = px;
    const o = this.shiftTween;
    const start = o.v;
    const t0 = this.time;
    const off = this.add(() => {
      const k = Math.min(1, (this.time - t0) / 0.45);
      o.v = start + (px - start) * (1 - Math.pow(1 - k, 3));
      this.applyShift();
      if (k >= 1) off();
    });
  }

  private applyShift() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (Math.abs(this.shiftTween.v) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, this.shiftTween.v, 0, w, h);
  }

  /** an immersive WebXR session is rendering */
  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  resize() {
    if (this.presenting) return; // the XR layer owns the framebuffer size
    globals.uRes.value.set(window.innerWidth, window.innerHeight);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.applyShift();
    void this.centerShift;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  setQuality(q: number) {
    this.quality = Math.max(0, Math.min(2, q));
    const dpr = [0.65, 1, Math.min(window.devicePixelRatio, 2)][this.quality];
    this.renderer.setPixelRatio(dpr);
    this.composer.multisampling = this.quality === 2 ? 4 : 0;
    this.resize();
  }

  /** Brief glitch burst; `amount` 0..1. */
  glitch(amount = 0.6, duration = 0.35) {
    const u = this.cyber.u('uGlitch');
    u.value = Math.max(u.value as number, amount * (this.readingView ? 0.13 : 1));
    const start = this.time;
    const off = this.add(() => {
      const k = 1 - (this.time - start) / duration;
      u.value = Math.max(0, amount * k * (this.readingView ? 0.13 : 1));
      if (k <= 0) off();
    });
  }

  flash(amount = 0.8, duration = 0.5) {
    const u = this.cyber.u('uFlash');
    const start = this.time;
    const off = this.add(() => {
      const k = 1 - (this.time - start) / duration;
      u.value = Math.max(0, amount * k * k) * (this.readingView ? 0.16 : 1);
      if (k <= 0) off();
    });
  }

  start() {
    // setAnimationLoop runs on window rAF on the desktop and on the XR session's rAF in a headset
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.1);
      this.time += dt;
      this.cyber.u('uTime').value = this.time;
      const xr = this.presenting ? this.xr : null;
      if (xr) {
        // the browser stops window rAF during an immersive session, which would freeze every gsap flight
        gsap.ticker.tick();
        xr.before(dt);
      } else if (this.idleOrbit && this.controls.enabled && this.idleSeconds > 45) this.controls.autoRotate = true;
      for (const u of this.updaters) u(dt, this.time);
      if (xr) {
        xr.after(dt);
        // postprocessing can't target the XR framebuffer: render straight to it (tone mapping moves into the materials)
        this.renderer.render(this.scene, xr.camera);
        return;
      }
      if (this.rig) this.rig.update(dt);
      else this.controls.update(dt);
      this.composer.render(dt);
      this.trackPerf(dt);
    });
  }

  private trackPerf(dt: number) {
    if (!this.autoQuality) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 34 && this.quality > 0) this.setQuality(this.quality - 1);
  }
}
