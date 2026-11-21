import * as THREE from 'three';
import gsap from 'gsap';
import { Engine } from './engine';
import { createSky } from './sky';
import { createGround } from './ground';
import { createHexRain, createMotes } from './particles';
import { CELL, City, type Tower } from './city';
import { CityArcs, NO_REFLECT_LAYER } from './callgraph';
import { EntropyHalo } from './entropy';
import { ImportRing, StringCloud } from './satellites';
import { FuncView } from './funcview';
import { FocusLayer } from './focus';
import { Constellation } from './constellation';
import { CameraRig } from './camera';
import { globals } from '../shaders/common';
import type { Fn, FnGraph, InfoMsg } from '../types';
import type { Model } from '../model';
import { audio } from '../audio/audio';

export type View = 'city' | 'constellation' | 'function';

export type Pick =
  | { kind: 'tower'; fi: number; addr: number; tower: Tower }
  | { kind: 'sat'; fi: number | null; name: string }
  | { kind: 'node'; fi: number; index: number }
  | { kind: 'op'; addr: number }
  | { kind: 'ring'; site: number; caller: number; callee: number };

export interface WorldEvents {
  hover?: (p: Pick | null, screen: { x: number; y: number }) => void;
  click?: (p: Pick | null) => void;
  dbl?: (p: Pick | null) => void;
  caption?: (text: string, sub?: string) => void;
}

function fakeFunctions(n: number): Fn[] {
  const out: Fn[] = [];
  let addr = 0x1000;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(Math.pow(Math.random(), 3) * 6000) + 16;
    out.push({ addr, name: `fcn.${addr.toString(16).padStart(8, '0')}`, size, nbbs: 1 + Math.floor(size / 40), cc: 1 + Math.floor(Math.pow(Math.random(), 2) * 40), ninstrs: size / 4, indeg: 0, outdeg: 0, nargs: 0, nlocals: 0, stack: 0, imp: false, min: addr, max: addr + size, sig: '' });
    addr += size + 16;
  }
  return out;
}

export class World {
  engine: Engine;
  rig: CameraRig;
  ev: WorldEvents = {};
  view: View = 'city';
  model: Model | null = null;
  city: City | null = null;
  arcs: CityArcs | null = null;
  halo: EntropyHalo | null = null;
  sats: ImportRing | null = null;
  strings: StringCloud | null = null;
  func: FuncView | null = null;
  constel: Constellation | null = null;
  focus: FocusLayer | null = null;
  info: InfoMsg | null = null;
  private cityGroup = new THREE.Group();
  private ground: ReturnType<typeof createGround>;
  private sky: ReturnType<typeof createSky>;
  private tunnel: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private pointerDirty = false;
  private hoverKey = '';
  hovered: Pick | null = null;
  private placeholder = true;
  private savedCityCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  transitioning = false;
  private touring = false;
  private grid = new Map<string, Tower[]>();
  /** WebXR: pick along this ray instead of the mouse pointer */
  xrRay: THREE.Ray | null = null;
  /** world point of the last successful pick (WebXR laser length, tooltip anchor) */
  hitPoint: THREE.Vector3 | null = null;
  /** WebXR: the camera and eye-buffer height that the CFG text LOD is judged from */
  lod: { camera: THREE.PerspectiveCamera; viewH: number } | null = null;
  private fogRadius = 160;
  private fogOn = true;
  private lastXrSelect: { pick: Pick | null; t: number } = { pick: null, t: 0 };

  constructor(canvas: HTMLCanvasElement) {
    const engine = (this.engine = new Engine(canvas));
    engine.camera.layers.enable(NO_REFLECT_LAYER);
    this.rig = new CameraRig(engine, canvas);
    engine.rig = this.rig;
    this.rig.collide = (p) => this.collide(p);
    const scene = engine.scene;
    this.sky = createSky();
    scene.add(this.sky.mesh);
    this.ground = createGround(engine);
    scene.add(this.ground.mesh);
    scene.add(createMotes().points);
    this.cityGroup.add(createHexRain().mesh);
    scene.add(this.cityGroup);

    // warp tunnel, parented to the camera
    const tg = new THREE.CylinderGeometry(7, 7, 600, 64, 1, true);
    tg.rotateX(Math.PI / 2);
    const tm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uOpacity: { value: 0 }, uSpeed: { value: 3 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uOpacity;
        uniform float uSpeed;
        varying vec2 vUv;
        float h(float x){ return fract(sin(x * 91.7) * 43758.5453); }
        void main() {
          float lane = floor(vUv.x * 160.0);
          float r = h(lane);
          float y = fract(vUv.y * (2.0 + r * 3.0) + uTime * uSpeed * (0.6 + r));
          float streak = smoothstep(0.0, 0.05, y) * smoothstep(0.35 + r * 0.4, 0.05, y) * step(0.55, r);
          vec3 c = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.15, 0.85), h(lane + 3.0));
          float edge = smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
          gl_FragColor = vec4(c * 2.5, streak * uOpacity * edge);
        }`,
    });
    this.tunnel = new THREE.Mesh(tg, tm);
    this.tunnel.position.z = -250;
    this.tunnel.renderOrder = 100;
    this.tunnel.visible = false;
    engine.camera.add(this.tunnel);
    scene.add(engine.camera);

    this.buildCity(fakeFunctions(900), null);
    this.city!.rise();

    engine.add((dt, t) => {
      globals.uTime.value = t;
      this.sky.update(engine.camera);
      this.city?.update(dt);
      this.halo?.update(dt);
      if (this.view === 'function') this.func?.updateLod(this.lod?.camera ?? engine.camera, this.lod?.viewH);
      if (this.xrRay) this.pointerDirty = true; // the controller moves every frame
      if (this.rig.mode === 'drone' && this.rig.locked) {
        this.pointer.set(0, 0);
        this.pointerPx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        this.pointerDirty = true;
      }
      if (this.pointerDirty && !this.transitioning) {
        this.pointerDirty = false;
        this.updateHover();
      }
      this.engine.bloom.intensity = 1.25 + audio.level() * 0.8;
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer.set(9, 9);
      this.pointerDirty = true;
    });
    let downAt = { x: 0, y: 0, b: 0 };
    canvas.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY, b: e.button };
      if (this.touring) this.stopTour();
    });
    // the first click of a double-click starts a camera flight, so the second click may
    // land on something else: a double-click acts on whatever the first click hit
    let lastClick: { pick: Pick | null; t: number } = { pick: null, t: 0 };
    canvas.addEventListener('click', (e) => {
      if (downAt.b !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      if (this.transitioning || this.placeholder) return;
      const pick = this.pickNow();
      if (e.detail === 1) lastClick = { pick, t: performance.now() };
      if (e.detail === 1) this.ev.click?.(pick);
    });
    canvas.addEventListener('dblclick', () => {
      if (this.transitioning || this.placeholder) return;
      const recent = performance.now() - lastClick.t < 700 && lastClick.pick;
      this.ev.dbl?.(recent ? lastClick.pick : this.pickNow());
    });

    this.setFog(160);
    engine.camera.position.set(0, 420, 900);
    engine.controls.target.set(0, 20, 0);
    engine.start();
  }

  // ------------------------------------------------------------ environment
  private setFog(radius: number) {
    this.fogRadius = radius;
    const d = this.fogOn ? 0.9 / (radius * 2.2 + 380) : 0;
    globals.uFogDensity.value = d;
    (this.engine.scene.fog as THREE.FogExp2).density = d;
    this.ground.mesh.material.uniforms.uFogDensity.value = d;
  }

  /** WebXR passthrough has no fog: it would tint the room. */
  setFogOn(on: boolean) {
    this.fogOn = on;
    this.setFog(this.fogRadius);
  }

  /** WebXR passthrough: drop the sky, ground and background so the room shows through. */
  setPassthrough(on: boolean) {
    this.sky.mesh.visible = !on;
    this.ground.mesh.visible = !on && this.view === 'city';
    this.engine.scene.background = on ? null : new THREE.Color(0x05020c);
    this.passthrough = on;
  }
  private passthrough = false;

  private setMood(view: View) {
    const city = view === 'city';
    const fogCol = city ? new THREE.Color(0x12052a) : view === 'function' ? new THREE.Color(0x020814) : new THREE.Color(0x07031a);
    gsap.to(globals.uFogColor.value, { r: fogCol.r, g: fogCol.g, b: fogCol.b, duration: 1 });
    this.sky.material.uniforms.uIntensity.value = city ? 1 : view === 'function' ? 0.28 : 0.5;
    this.ground.mesh.material.uniforms.uFogColor.value = globals.uFogColor.value;
    audio.setMood(city ? 'city' : 'function');
  }

  private buildCity(functions: Fn[], entry: number | null) {
    if (this.city) {
      this.cityGroup.remove(this.city.group);
      this.city.dispose();
    }
    this.city = new City(functions, entry);
    this.cityGroup.add(this.city.group);
    this.ground.setCityRadius(this.city.radius);
    // spatial hash for drone collisions
    this.grid.clear();
    for (const t of this.city.towers) {
      const k = `${Math.round(t.pos.x / CELL)},${Math.round(t.pos.z / CELL)}`;
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(t);
    }
  }

  /** Drone collision: stay above ground, slide off buildings. */
  private collide(p: THREE.Vector3) {
    if (this.view !== 'city' || !this.city) return; // the core / constellation float in open space
    p.y = Math.max(p.y, 1.5);
    const cx = Math.round(p.x / CELL);
    const cz = Math.round(p.z / CELL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const t of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const m = t.width / 2 + 0.9;
          const ox = p.x - t.pos.x;
          const oz = p.z - t.pos.z;
          if (Math.abs(ox) < m && Math.abs(oz) < m && p.y < t.height + 0.9) {
            const px = m - Math.abs(ox);
            const pz = m - Math.abs(oz);
            const py = t.height + 0.9 - p.y;
            if (py < px && py < pz) p.y = t.height + 0.9;
            else if (px < pz) p.x = t.pos.x + Math.sign(ox || 1) * m;
            else p.z = t.pos.z + Math.sign(oz || 1) * m;
          }
        }
  }

  // ------------------------------------------------------------ data
  loadInfo(info: InfoMsg) {
    this.info = info;
    audio.seed(info.hash);
    this.engine.glitch(0.5, 0.6);
  }

  loadModel(model: Model) {
    this.model = model;
    this.placeholder = false;
    this.clearFocus();
    if (this.constel) {
      this.engine.scene.remove(this.constel.group);
      this.constel.dispose();
      this.constel = null;
    }
    if (this.func) {
      this.engine.scene.remove(this.func.group);
      this.func.dispose();
      this.func = null;
    }
    const entryAddr = this.info?.entries?.[0]?.vaddr ?? null;
    const r = City.radiusFor(model.fns);
    this.setFog(r);
    for (const o of [this.halo?.group, this.strings?.labels.mesh, this.sats?.group, this.arcs?.mesh]) if (o) this.cityGroup.remove(o);
    this.halo?.dispose();
    this.strings?.dispose();
    this.sats?.dispose();
    this.arcs?.dispose();
    if (this.info) {
      this.halo = new EntropyHalo(this.info.entropy, this.info.sections ?? [], r);
      this.cityGroup.add(this.halo.group);
      this.halo.reveal();
      this.strings = new StringCloud(this.info.strings ?? [], r, 260);
      this.cityGroup.add(this.strings.labels.mesh);
    }
    this.sats = new ImportRing(this.info?.imports ?? [], model.fns, this.halo?.radius ?? r + 55);
    this.cityGroup.add(this.sats.group);
    this.buildCity(model.fns, entryAddr);
    const city = this.city!;
    this.arcs = new CityArcs(model, {
      site: (fi, addr) => {
        const t = city.towerOfFn(fi);
        return t ? city.floor(t, model.frac(fi, addr)) : (this.sats?.posOfFn(fi)?.clone() ?? null);
      },
      entry: (fi) => {
        const t = city.towerOfFn(fi);
        return t ? new THREE.Vector3(t.pos.x, t.height, t.pos.z) : (this.sats?.posOfFn(fi)?.clone() ?? null);
      },
      color: (fi) => city.towerOfFn(fi)?.color ?? new THREE.Color(0xffd23a),
    });
    this.arcs.material.uniforms.uReveal.value = 0;
    gsap.to(this.arcs.material.uniforms.uReveal, { value: 1, duration: 4, delay: 1.5, ease: 'power1.in' });
    this.cityGroup.add(this.arcs.mesh);
    city.rise();
    this.ground.pulse();
    this.engine.flash(0.35, 0.8);
    this.engine.glitch(0.8, 0.7);
    audio.impact();
    const R = city.radius;
    this.flyTo(new THREE.Vector3(R * 1.25, R * 0.6 + 45, R * 1.7), new THREE.Vector3(0, 12, 0), 4.5);
  }

  // ------------------------------------------------------------ camera
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, duration = 2.2, ease = 'power3.inOut'): Promise<void> {
    return this.rig.flyTo(pos, target, duration, ease);
  }

  /** Frame a tower; optionally aim at a specific address "floor". */
  focusTower(t: Tower, duration = 2, addr?: number) {
    const top = this.city!.top(t);
    const d = Math.max(34, t.height * 1.3 + 30);
    const cam = this.engine.camera.position;
    const dir = new THREE.Vector3(cam.x - top.x, 0, cam.z - top.z);
    if (dir.lengthSq() < 0.1) dir.set(0.6, 0, 0.8);
    dir.normalize();
    const fy = addr !== undefined && this.model ? this.city!.floor(t, this.model.frac(t.fnIndex, addr)).y : t.height * 0.6;
    const pos = new THREE.Vector3(t.pos.x, fy, t.pos.z).add(dir.multiplyScalar(d)).add(new THREE.Vector3(0, d * 0.35 + 4, 0));
    const target = new THREE.Vector3(t.pos.x, fy, t.pos.z);
    return this.flyTo(pos, target, duration);
  }

  get isPlaceholder() {
    return this.placeholder;
  }

  // ------------------------------------------------------------ focus (in-city call graph)
  setFocus(fi: number | null, depth = 1) {
    const m = this.model;
    const city = this.city;
    if (!m || !city) return;
    if (fi === null) return this.clearFocus();
    if (this.focus && this.focus.fi === fi && this.focus.depth === depth) return;
    this.clearFocus(false);
    // string column goes on the camera's left (the Inspector docks on the right)
    const right = new THREE.Vector3().setFromMatrixColumn(this.engine.camera.matrixWorld, 0);
    this.focus = new FocusLayer(m, city, this.sats, fi, depth, right.negate());
    this.focus.finalize();
    this.cityGroup.add(this.focus.group);
    const states = new Map<number, number>();
    const roles = new Map<number, number>();
    for (const [g, n] of this.focus.nb) {
      const ti = city.byFn.get(g);
      if (ti === undefined) continue;
      states.set(ti, n.hop === 0 ? 2 : n.hop === 1 ? 0.55 : 0.2);
      if (n.hop > 0) roles.set(ti, n.role === 'caller' ? 1 : n.role === 'callee' ? 2 : 3);
    }
    // referrers / referenced functions (address taken) stay lit, untinted
    for (const g of [...m.referrers(fi), ...m.referenced(fi)]) {
      const ti = city.byFn.get(g);
      if (ti !== undefined && !states.has(ti)) states.set(ti, 0.35);
    }
    city.setStates(states, roles);
    this.arcs?.setDim(1);
  }

  clearFocus(restore = true) {
    if (this.focus) {
      this.cityGroup.remove(this.focus.group);
      this.focus.dispose();
      this.focus = null;
    }
    if (restore) {
      this.city?.setStates(null);
      this.arcs?.setDim(0);
    }
  }

  // ------------------------------------------------------------ picking
  private pickNow(): Pick | null {
    this.hitPoint = null;
    if (this.xrRay) this.raycaster.ray.copy(this.xrRay);
    else if (this.pointer.x > 2) return null;
    else this.raycaster.setFromCamera(this.pointer, this.engine.camera);
    const ray = this.raycaster;
    if (this.view === 'function' && this.func) {
      const hit = ray.intersectObjects(this.func.pickables(), false)[0];
      if (hit?.uv) {
        const addr = this.func.opAtHit(hit.object, hit.uv);
        this.hitPoint = hit.point;
        if (addr !== null) return { kind: 'op', addr };
      }
      return null;
    }
    if (this.view === 'constellation' && this.constel) {
      const i = this.constel.pick(ray);
      if (i < 0) return null;
      this.hitPoint = this.constel.nodes[i].pos.clone().applyMatrix4(this.constel.group.matrixWorld);
      return { kind: 'node', fi: this.constel.nodes[i].fi, index: i };
    }
    if (!this.city || this.placeholder || !this.model) return null;
    const hits = ray.intersectObject(this.city.mesh, false);
    const h = hits[0];
    if (h) this.hitPoint = h.point;
    if (h?.instanceId !== undefined) {
      const t = this.city.towers[h.instanceId];
      const f = this.model.fns[t.fnIndex];
      const frac = this.city.fracAtY(t, h.point.y);
      // snap to the nearest real call site on this floor if we're in focus mode
      const addr = Math.round(f.min + frac * (f.max - f.min));
      return { kind: 'tower', fi: t.fnIndex, addr, tower: t };
    }
    if (this.sats) {
      const sh = ray.intersectObject(this.sats.group.children[0], false)[0];
      if (sh?.instanceId !== undefined) {
        const s = this.sats.sats[sh.instanceId];
        this.hitPoint = sh.point;
        return { kind: 'sat', fi: s.fnIndex, name: s.name };
      }
    }
    return null;
  }

  /** WebXR trigger: a click on whatever the controller ray hits; a quick second press is a double-click on the first one's target. */
  xrSelect() {
    if (this.transitioning || this.placeholder) return;
    const now = performance.now();
    const last = this.lastXrSelect;
    if (now - last.t < 450) {
      this.lastXrSelect = { pick: null, t: 0 };
      this.ev.dbl?.(last.pick ?? this.pickNow());
      return;
    }
    const pick = this.pickNow();
    this.lastXrSelect = { pick, t: now };
    this.ev.click?.(pick);
  }

  /** Collision for the WebXR rig (same rules as the drone). */
  collidePoint(p: THREE.Vector3) {
    this.collide(p);
  }

  private updateHover() {
    const p = this.pickNow();
    const key = p ? `${p.kind}:${'fi' in p ? p.fi : ''}:${'index' in p ? p.index : ''}:${p.kind === 'op' ? p.addr : ''}` : '';
    this.hovered = p;
    if (this.view === 'function' && this.func) {
      const hit = p?.kind === 'op' ? this.func.panelAt(p.addr) : null;
      this.func.hover(hit ? hit.mesh : null);
    }
    if (this.view === 'constellation' && this.constel) this.constel.hover(p?.kind === 'node' ? p.index : -1);
    if (this.view === 'city' && this.sats) this.sats.select(p?.kind === 'sat' ? this.sats.sats.findIndex((s) => s.name === p.name) : -1);
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      if (p && p.kind !== 'op') audio.hover();
      document.body.style.cursor = p ? 'pointer' : '';
    }
    this.ev.hover?.(p, this.pointerPx);
  }

  // ------------------------------------------------------------ views
  private setWarp(v: number) {
    this.tunnel.visible = v > 0.001;
    (this.tunnel.material as THREE.ShaderMaterial).uniforms.uOpacity.value = v;
  }

  /** Dive → swap scenes behind a flash → arrive. */
  private async warp(swap: () => Promise<{ pos: THREE.Vector3; target: THREE.Vector3 }>, out = false) {
    this.transitioning = true;
    this.ev.hover?.(null, { x: 0, y: 0 });
    try {
      await this.warpInner(swap, out);
    } finally {
      this.transitioning = false;
      this.setWarp(0);
      const cam = this.engine.camera;
      if (cam.fov !== 55) {
        cam.fov = 55;
        cam.updateProjectionMatrix();
      }
    }
  }

  private async warpInner(swap: () => Promise<{ pos: THREE.Vector3; target: THREE.Vector3 }>, out: boolean) {
    this.rig.stop();
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    audio.whoosh(out ? 1.1 : 1.3, !out);
    this.engine.glitch(0.45, 1.0);
    const warp = { v: 0, fov: cam.fov };
    const tw = (to: { v: number; fov: number }, d: number, ease: string) =>
      new Promise<void>((r) =>
        gsap.to(warp, {
          ...to,
          duration: d,
          ease,
          onInterrupt: () => r(),
          onUpdate: () => {
            this.setWarp(warp.v);
            cam.fov = warp.fov;
            cam.updateProjectionMatrix();
          },
          onComplete: () => r(),
        }),
      );
    const look = this.rig.mode === 'orbit' ? ctl.target.clone() : cam.position.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(40));
    const dive = cam.position.clone().lerp(look, out ? -0.4 : 0.8);
    await Promise.all([tw({ v: 1, fov: out ? 32 : 105 }, out ? 0.7 : 1.0, 'power2.in'), this.flyTo(dive, look, out ? 0.7 : 1.0, 'power2.in')]);
    this.engine.flash(out ? 0.7 : 1.0, 0.6);
    audio.impact();
    const land = await swap();
    cam.position.copy(land.pos).add(land.pos.clone().sub(land.target).normalize().multiplyScalar(out ? -30 : 120));
    if (this.rig.mode === 'orbit') ctl.target.copy(land.target);
    else cam.lookAt(land.target);
    await Promise.all([tw({ v: 0, fov: 55 }, 1.5, 'power3.out'), this.flyTo(land.pos, land.target, 1.7, 'power3.out')]);
  }

  private showOnly(view: View) {
    this.view = view;
    this.cityGroup.visible = view === 'city';
    this.ground.mesh.visible = view === 'city' && !this.passthrough;
    if (this.func) this.func.group.visible = view === 'function';
    if (this.constel) this.constel.group.visible = view === 'constellation';
    this.engine.controls.maxPolarAngle = view === 'city' ? Math.PI * 0.495 : Math.PI;
    this.rig.minY = view === 'city' ? 1.5 : -1e9;
    this.rig.liftAxis.set(0, view === 'function' ? 0 : 1, view === 'function' ? 1 : 0);
    this.setMood(view);
  }

  private rememberCity() {
    if (this.view !== 'city') return;
    const cam = this.engine.camera;
    const target = this.rig.mode === 'orbit' ? this.engine.controls.target.clone() : cam.position.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(40));
    this.savedCityCam = { pos: cam.position.clone(), target };
  }

  async enterFunction(graph: FnGraph, seek?: number) {
    if (this.transitioning) return;
    this.stopTour();
    this.rememberCity();
    const fv = new FuncView(graph);
    await this.warp(async () => {
      await fv.ready;
      if (this.func) {
        this.engine.scene.remove(this.func.group);
        this.func.dispose();
      }
      this.func = fv;
      this.engine.scene.add(fv.group);
      this.showOnly('function');
      const p = fv.setSeek(seek ?? graph.addr);
      fv.reveal((fn) => this.engine.add(fn));
      return seek !== undefined && seek !== graph.addr && p ? fv.frameOf(p) : fv.overview();
    });
  }

  async enterConstellation(fi: number) {
    if (!this.model || this.transitioning) return;
    this.stopTour();
    this.rememberCity();
    if (this.view === 'constellation' && this.constel) {
      await this.recenter(fi);
      return;
    }
    await this.warp(async () => {
      if (!this.constel) {
        this.constel = new Constellation(this.model!);
        this.engine.scene.add(this.constel.group);
      }
      this.showOnly('constellation');
      const done = this.constel.center(fi);
      void done;
      return this.constel.overview();
    });
  }

  async recenter(fi: number) {
    if (!this.constel || this.transitioning) return;
    audio.whoosh(0.9, true);
    this.engine.glitch(0.25, 0.5);
    const from = this.constel.nodes.find((n) => n.fi === fi)?.pos.clone();
    const p = this.constel.center(fi, from);
    const o = this.constel.overview();
    this.flyTo(o.pos, o.target, 1.4);
    await p;
  }

  async backToCity() {
    if (this.view === 'city' || this.transitioning) return;
    await this.warp(async () => {
      this.showOnly('city');
      const back = this.savedCityCam ?? { pos: new THREE.Vector3(200, 200, 300), target: new THREE.Vector3() };
      return back;
    }, true);
  }

  // ------------------------------------------------------------ highlights
  sweep() {
    this.city?.sweep();
    this.ground.pulse();
  }

  pulseStrings() {
    if (!this.strings) return;
    const u = this.strings.labels.material.uniforms;
    gsap.fromTo(u.uPulse, { value: 1.5 }, { value: 0, duration: 3, ease: 'power2.out' });
    gsap.fromTo(u.uOpacity, { value: 1 }, { value: 0.5, duration: 3 });
    const R = this.city?.radius ?? 100;
    this.flyTo(new THREE.Vector3(R * 0.4, 140, R * 1.3), new THREE.Vector3(0, 170, 0), 2.4);
  }

  pulseImports() {
    if (!this.sats) return;
    const o = { v: 1.5 };
    gsap.to(o, { v: 0, duration: 3, onUpdate: () => this.sats?.pulse(o.v) });
    const R = this.sats.radius;
    this.flyTo(new THREE.Vector3(0, 170, R * 1.25), new THREE.Vector3(0, 60, 0), 2.6);
  }

  focusEntropy() {
    if (!this.halo) return;
    const o = { v: 1 };
    gsap.to(o, { v: 0, duration: 3, onUpdate: () => this.halo?.setFocus(o.v) });
    const p = this.halo.focusPoint();
    const out = p.clone().setY(0).normalize();
    this.flyTo(p.clone().add(out.clone().multiplyScalar(-90)).setY(70), p.clone().setY(35), 2.4);
  }

  overview() {
    if (this.view === 'function' && this.func) {
      const o = this.func.overview();
      return this.flyTo(o.pos, o.target, 1.6);
    }
    if (this.view === 'constellation' && this.constel) {
      const o = this.constel.overview();
      return this.flyTo(o.pos, o.target, 1.6);
    }
    const R = this.city?.radius ?? 120;
    return this.flyTo(new THREE.Vector3(R * 1.5, R * 1.1 + 80, R * 2.0), new THREE.Vector3(0, 10, 0), 2.6);
  }

  // ------------------------------------------------------------ tour
  async tour() {
    if (!this.city || this.placeholder || this.view !== 'city') return;
    this.stopTour();
    this.touring = true;
    const R = this.city.radius;
    const towers = this.city.towers;
    const biggest = [...towers].sort((a, b) => b.fn.size - a.fn.size)[0];
    const hub = [...towers].sort((a, b) => (this.model?.in[b.fnIndex].length ?? 0) - (this.model?.in[a.fnIndex].length ?? 0))[0];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const steps: (() => Promise<void>)[] = [
      async () => {
        this.ev.caption?.('// ESTABLISHING UPLINK', this.info?.path);
        await this.flyTo(new THREE.Vector3(0, R * 2.5 + 200, R * 0.2), new THREE.Vector3(0, 0, 0), 4);
      },
      async () => {
        this.ev.caption?.('// ENTROPY HALO', 'byte entropy of the file, ringed by section');
        const a = { t: 0 };
        const H = this.halo?.radius ?? R + 55;
        await new Promise<void>((res) =>
          gsap.to(a, {
            t: Math.PI * 1.2,
            duration: 7,
            ease: 'sine.inOut',
            onUpdate: () => {
              this.engine.camera.position.set(Math.cos(a.t) * (H + 60), 45, Math.sin(a.t) * (H + 60));
              this.engine.controls.target.set(Math.cos(a.t + 0.5) * H, 30, Math.sin(a.t + 0.5) * H);
            },
            onComplete: () => res(),
          }),
        );
      },
      async () => {
        if (!biggest) return;
        this.ev.caption?.(`// MEGASTRUCTURE ${biggest.fn.name}`, `${biggest.fn.size} bytes · ${biggest.fn.nbbs} blocks`);
        await this.focusTower(biggest, 3.5);
        await wait(1500);
      },
      async () => {
        if (!hub || !this.model) return;
        this.ev.caption?.(`// HUB ${hub.fn.name}`, `called from ${this.model.in[hub.fnIndex].length} call sites`);
        this.setFocus(hub.fnIndex, 1);
        await this.focusTower(hub, 3.5);
        await wait(2500);
        this.clearFocus();
      },
      async () => {
        this.ev.caption?.('// STRING NEBULA', `${this.info?.strings.length ?? 0} strings adrift`);
        await this.flyTo(new THREE.Vector3(R * 0.3, 150, R * 0.9), new THREE.Vector3(0, 175, 0), 3.5);
        await wait(1200);
      },
      async () => {
        this.ev.caption?.('// IMPORT RELAYS', `${this.sats?.sats.length ?? 0} uplinks to the outside world`);
        const S = this.sats?.radius ?? R + 140;
        await this.flyTo(new THREE.Vector3(S * 0.9, 90, S * 0.6), new THREE.Vector3(S * 0.3, 60, S * 0.9), 4);
      },
      async () => {
        this.ev.caption?.('// END OF LINE', 'click a tower to focus · C constellation · Enter core · F drone · Ctrl+K search');
        await this.overview();
      },
    ];
    for (const s of steps) {
      if (!this.touring) break;
      await s();
    }
    this.touring = false;
    this.ev.caption?.('');
  }

  stopTour() {
    if (!this.touring) return;
    this.touring = false;
    this.rig.stop();
    this.ev.caption?.('');
  }

  // ------------------------------------------------------------ minimap support
  cameraXZ() {
    const cam = this.engine.camera;
    const d = cam.getWorldDirection(new THREE.Vector3());
    return { x: cam.position.x, z: cam.position.z, dx: d.x, dz: d.z, fov: cam.fov, aspect: cam.aspect };
  }
}
