import * as THREE from 'three';
import gsap from 'gsap';
import { Engine } from './engine';
import { createSky } from './sky';
import { createGround } from './ground';
import { createHexRain, createMotes } from './particles';
import { City, type Tower } from './city';
import { CallArcs } from './callgraph';
import { EntropyHalo } from './entropy';
import { ImportRing, StringCloud } from './satellites';
import { FuncView } from './funcview';
import { globals } from '../shaders/common';
import type { Fn, FnGraph, FunctionsMsg, InfoMsg } from '../types';
import { audio } from '../audio/audio';

export type View = 'city' | 'function';

export interface WorldEvents {
  hoverTower?: (t: Tower | null, screen: { x: number; y: number }) => void;
  clickTower?: (t: Tower) => void;
  dblTower?: (t: Tower) => void;
  clickOp?: (addr: number) => void;
  hoverSat?: (name: string | null, screen: { x: number; y: number }) => void;
  caption?: (text: string, sub?: string) => void;
}

function fakeFunctions(n: number): Fn[] {
  const out: Fn[] = [];
  let addr = 0x1000;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(Math.pow(Math.random(), 3) * 6000) + 16;
    out.push({ addr, name: `fcn.${addr.toString(16).padStart(8, '0')}`, size, nbbs: 1 + Math.floor(size / 40), cc: 1 + Math.floor(Math.pow(Math.random(), 2) * 40), ninstrs: size / 4, indeg: 0, outdeg: 0, nargs: 0, nlocals: 0, stack: 0, imp: false });
    addr += size + 16;
  }
  return out;
}

export class World {
  engine: Engine;
  ev: WorldEvents = {};
  view: View = 'city';
  city: City | null = null;
  arcs: CallArcs | null = null;
  halo: EntropyHalo | null = null;
  sats: ImportRing | null = null;
  strings: StringCloud | null = null;
  func: FuncView | null = null;
  info: InfoMsg | null = null;
  functions: Fn[] = [];
  private cityGroup = new THREE.Group();
  private ground: ReturnType<typeof createGround>;
  private sky: ReturnType<typeof createSky>;
  private tunnel: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(9, 9);
  private pointerPx = { x: 0, y: 0 };
  private pointerDirty = false;
  private hovered: Tower | null = null;
  private hoveredSat = -1;
  selected: Tower | null = null;
  private placeholder = true;
  private savedCityCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private transitioning = false;
  private touring = false;
  private tourTimeline: gsap.core.Timeline | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const engine = (this.engine = new Engine(canvas));
    const scene = engine.scene;
    this.sky = createSky();
    scene.add(this.sky.mesh);
    this.ground = createGround(engine);
    scene.add(this.ground.mesh);
    const motes = createMotes();
    scene.add(motes.points);
    const rain = createHexRain();
    this.cityGroup.add(rain.mesh);
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

    // placeholder skyline for the boot / picker screens
    this.buildCity(fakeFunctions(900), [], null);
    this.city!.rise();

    engine.add((dt, t) => {
      globals.uTime.value = t;
      this.sky.update(engine.camera);
      this.city?.update(dt);
      this.halo?.update(dt);
      if (this.arcs) {
        const u = this.arcs.material.uniforms.uReveal;
        if (u.value < 1) u.value = Math.min(1, u.value + dt * 0.5);
      }
      if (this.pointerDirty && !this.transitioning) {
        this.pointerDirty = false;
        this.updateHover();
      }
      const lvl = audio.level();
      this.engine.bloom.intensity = 1.25 + lvl * 0.8;
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerDirty = true;
    });
    canvas.addEventListener('pointerleave', () => this.pointer.set(9, 9));
    let downAt = { x: 0, y: 0 };
    canvas.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
      if (this.touring) this.stopTour();
    });
    canvas.addEventListener('click', (e) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      this.onClick();
    });
    canvas.addEventListener('dblclick', () => {
      if (this.view === 'city' && this.hovered && !this.placeholder) this.ev.dblTower?.(this.hovered);
    });

    this.setFog(160);
    engine.camera.position.set(0, 420, 900);
    engine.controls.target.set(0, 20, 0);
    engine.start();
  }

  private setFog(radius: number) {
    const d = 0.9 / (radius * 2.2 + 380);
    globals.uFogDensity.value = d;
    (this.engine.scene.fog as THREE.FogExp2).density = d;
    this.ground.mesh.material.uniforms.uFogDensity.value = d;
  }

  private setMood(view: View) {
    const city = view === 'city';
    const fogCol = city ? new THREE.Color(0x12052a) : new THREE.Color(0x020814);
    gsap.to(globals.uFogColor.value, { r: fogCol.r, g: fogCol.g, b: fogCol.b, duration: 1 });
    this.sky.material.uniforms.uIntensity.value = city ? 1 : 0.28;
    this.ground.mesh.material.uniforms.uFogColor.value = globals.uFogColor.value;
  }

  private buildCity(functions: Fn[], calls: [number, number][], entry: number | null) {
    if (this.city) {
      this.cityGroup.remove(this.city.group);
      this.city.dispose();
    }
    if (this.arcs) {
      this.cityGroup.remove(this.arcs.mesh);
      this.arcs.dispose();
      this.arcs = null;
    }
    this.city = new City(functions, entry);
    this.cityGroup.add(this.city.group);
    this.ground.setCityRadius(this.city.radius);
    if (calls.length) {
      const towerOf = new Map<number, Tower>();
      for (const t of this.city.towers) towerOf.set(t.fnIndex, t);
      this.arcs = new CallArcs(
        calls,
        (i) => {
          const t = towerOf.get(i);
          if (t) return this.city!.top(t);
          return this.sats?.posOfFn(i) ?? null;
        },
        (i) => towerOf.get(i)?.color ?? new THREE.Color(0x00f0ff),
      );
      this.cityGroup.add(this.arcs.mesh);
    }
  }

  // ------------------------------------------------------------ data
  loadInfo(info: InfoMsg) {
    this.info = info;
    audio.seed(info.hash);
    if (this.halo) {
      this.cityGroup.remove(this.halo.group);
      this.halo.dispose();
    }
    if (this.strings) {
      this.cityGroup.remove(this.strings.labels.mesh);
      this.strings.dispose();
    }
    const r = this.city?.radius ?? 120;
    this.halo = new EntropyHalo(info.entropy, info.sections ?? [], r);
    this.cityGroup.add(this.halo.group);
    this.halo.reveal();
    this.strings = new StringCloud(info.strings ?? [], r);
    this.cityGroup.add(this.strings.labels.mesh);
    this.engine.glitch(0.5, 0.6);
  }

  loadFunctions(msg: FunctionsMsg) {
    this.functions = msg.functions;
    this.placeholder = false;
    const entryAddr = this.info?.entries?.[0]?.vaddr ?? msg.seek ?? null;
    // imports ring must exist before arcs are built
    if (this.sats) {
      this.cityGroup.remove(this.sats.group);
      this.sats.dispose();
    }
    // provisional radius to place the ring; rebuilt below once city is known
    const r = City.radiusFor(msg.functions);
    this.setFog(r);
    // halo + strings depend on the real city radius
    if (this.info) {
      if (this.halo) {
        this.cityGroup.remove(this.halo.group);
        this.halo.dispose();
      }
      this.halo = new EntropyHalo(this.info.entropy, this.info.sections ?? [], r);
      this.cityGroup.add(this.halo.group);
      this.halo.reveal();
      if (this.strings) {
        this.cityGroup.remove(this.strings.labels.mesh);
        this.strings.dispose();
      }
      this.strings = new StringCloud(this.info.strings ?? [], r);
      this.cityGroup.add(this.strings.labels.mesh);
    }
    this.sats = new ImportRing(this.info?.imports ?? [], msg.functions, this.halo?.radius ?? r + 55);
    this.cityGroup.add(this.sats.group);
    this.buildCity(msg.functions, msg.calls, entryAddr);
    this.city!.rise();
    this.ground.pulse();
    this.engine.flash(0.35, 0.8);
    this.engine.glitch(0.8, 0.7);
    audio.impact();
    // establishing shot
    const R = this.city!.radius;
    this.flyTo(new THREE.Vector3(R * 1.25, R * 0.6 + 45, R * 1.7), new THREE.Vector3(0, 12, 0), 4.5);
  }

  // ------------------------------------------------------------ camera
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, duration = 2.2, ease = 'power3.inOut'): Promise<void> {
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    gsap.killTweensOf(cam.position);
    gsap.killTweensOf(ctl.target);
    return new Promise((res) => {
      gsap.to(cam.position, { x: pos.x, y: pos.y, z: pos.z, duration, ease });
      gsap.to(ctl.target, { x: target.x, y: target.y, z: target.z, duration, ease, onComplete: () => res() });
    });
  }

  focusTower(t: Tower, duration = 2) {
    const top = this.city!.top(t);
    const d = Math.max(30, t.height * 1.4 + 25);
    const cam = this.engine.camera.position;
    const dir = new THREE.Vector3(cam.x - top.x, 0, cam.z - top.z).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.1) dir.set(0.6, 0, 0.8);
    const pos = top.clone().add(dir.multiplyScalar(d)).add(new THREE.Vector3(0, d * 0.45 + 6, 0));
    const target = new THREE.Vector3(t.pos.x, t.height * 0.6, t.pos.z);
    return this.flyTo(pos, target, duration);
  }

  select(t: Tower | null) {
    this.selected = t;
    if (!this.city) return;
    if (!t) {
      this.city.setStates(null);
      this.arcs?.select(-1);
      this.sats?.select(-1);
      return;
    }
    const states = new Map<number, number>();
    const idx = this.city.indexOf(t);
    states.set(idx, 2);
    const towerIdxOfFn = new Map(this.city.towers.map((x, i) => [x.fnIndex, i]));
    for (const [a, b] of this.arcs?.edges ?? []) {
      if (a === t.fnIndex && towerIdxOfFn.has(b)) states.set(towerIdxOfFn.get(b)!, 1);
      if (b === t.fnIndex && towerIdxOfFn.has(a)) states.set(towerIdxOfFn.get(a)!, 1);
    }
    this.city.setStates(states);
    this.arcs?.select(t.fnIndex);
  }

  /** Seek changed: move scene focus to the address. */
  seek(addr: number, fly = true) {
    this.halo?.setSeek(addr);
    if (this.halo) audio.setBrightness(this.halo.entropyAt(addr));
    if (this.view === 'function' && this.func) {
      const p = this.func.setSeek(addr);
      if (p && fly) {
        const f = this.func.frame(p);
        this.flyTo(f.pos, f.target, 1.4);
        return true;
      }
      return !!p;
    }
    const t = this.city?.towerAt(addr);
    if (t && !this.placeholder) {
      this.select(t);
      if (fly) this.focusTower(t);
      this.ground.pulse();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ interaction
  private updateHover() {
    if (this.pointer.x > 2) return;
    this.raycaster.setFromCamera(this.pointer, this.engine.camera);
    if (this.view === 'function' && this.func) {
      const hit = this.raycaster.intersectObjects(this.func.pickables(), false)[0];
      this.func.hover(hit?.object ?? null);
      document.body.style.cursor = hit ? 'pointer' : '';
      return;
    }
    if (!this.city || this.placeholder) return;
    const hits = this.raycaster.intersectObject(this.city.mesh, false);
    const t = hits[0]?.instanceId !== undefined ? this.city.towers[hits[0].instanceId!] : null;
    if (t !== this.hovered) {
      this.hovered = t;
      if (t) audio.hover();
      document.body.style.cursor = t ? 'pointer' : '';
    }
    this.ev.hoverTower?.(t, this.pointerPx);
    if (!t && this.sats) {
      this.raycaster.params.Points = { threshold: 2 };
      const sh = this.raycaster.intersectObject(this.sats.group.children[0], false)[0];
      const si = sh?.instanceId ?? -1;
      if (si !== this.hoveredSat) {
        this.hoveredSat = si;
        this.sats.select(si);
        if (si >= 0) audio.hover();
      }
      this.ev.hoverSat?.(si >= 0 ? this.sats.sats[si].name : null, this.pointerPx);
    }
  }

  private onClick() {
    if (this.transitioning) return;
    if (this.view === 'function' && this.func) {
      this.raycaster.setFromCamera(this.pointer, this.engine.camera);
      const hit = this.raycaster.intersectObjects(this.func.pickables(), false)[0];
      if (hit?.uv) {
        const addr = this.func.opAtHit(hit.object, hit.uv);
        if (addr !== null) this.ev.clickOp?.(addr);
      }
      return;
    }
    if (this.hovered && !this.placeholder) this.ev.clickTower?.(this.hovered);
    else if (!this.hovered && this.selected) this.select(null);
  }

  // ------------------------------------------------------------ views
  private setWarp(v: number) {
    this.tunnel.visible = v > 0.001;
    (this.tunnel.material as THREE.ShaderMaterial).uniforms.uOpacity.value = v;
  }

  async enterFunction(graph: FnGraph) {
    if (this.transitioning) return;
    this.stopTour();
    this.transitioning = true;
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    if (this.view === 'city') this.savedCityCam = { pos: cam.position.clone(), target: ctl.target.clone() };
    audio.whoosh(1.3, true);
    this.engine.glitch(0.4, 1.0);
    const warp = { v: 0, fov: cam.fov };
    // dive toward target
    const dir = new THREE.Vector3().subVectors(ctl.target, cam.position).normalize();
    const dive = cam.position.clone().add(dir.multiplyScalar(cam.position.distanceTo(ctl.target) * 0.8));
    await Promise.all([
      new Promise<void>((r) =>
        gsap.to(warp, {
          v: 1,
          fov: 105,
          duration: 1.0,
          ease: 'power2.in',
          onUpdate: () => {
            this.setWarp(warp.v);
            cam.fov = warp.fov;
            cam.updateProjectionMatrix();
          },
          onComplete: () => r(),
        }),
      ),
      this.flyTo(dive, ctl.target.clone(), 1.0, 'power2.in'),
    ]);
    this.engine.flash(1.0, 0.6);
    audio.impact();
    // swap worlds
    if (this.func) {
      this.engine.scene.remove(this.func.group);
      this.func.dispose();
    }
    this.func = new FuncView(graph);
    this.engine.scene.add(this.func.group);
    this.cityGroup.visible = false;
    this.ground.mesh.visible = false;
    this.view = 'function';
    this.setMood('function');
    audio.setMood('function');
    this.engine.controls.maxPolarAngle = Math.PI;
    const entryPanel = this.func.setSeek(graph.addr);
    const f = graph.blocks.length > 3 ? this.func.overview() : this.func.frame(entryPanel);
    cam.position.copy(f.pos).add(new THREE.Vector3(0, 0, 160));
    ctl.target.copy(f.target);
    this.func.reveal((fn) => this.engine.add(fn));
    await Promise.all([
      new Promise<void>((r) =>
        gsap.to(warp, {
          v: 0,
          fov: 55,
          duration: 1.6,
          ease: 'power3.out',
          onUpdate: () => {
            this.setWarp(warp.v);
            cam.fov = warp.fov;
            cam.updateProjectionMatrix();
          },
          onComplete: () => r(),
        }),
      ),
      this.flyTo(f.pos, f.target, 1.8, 'power3.out'),
    ]);
    this.transitioning = false;
  }

  async exitFunction() {
    if (this.view !== 'function' || this.transitioning) return;
    this.transitioning = true;
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    audio.whoosh(1.1, false);
    this.engine.glitch(0.5, 0.8);
    const warp = { v: 0, fov: cam.fov };
    await new Promise<void>((r) =>
      gsap.to(warp, {
        v: 1,
        fov: 30,
        duration: 0.7,
        ease: 'power2.in',
        onUpdate: () => {
          this.setWarp(warp.v);
          cam.fov = warp.fov;
          cam.updateProjectionMatrix();
        },
        onComplete: () => r(),
      }),
    );
    this.engine.flash(0.7, 0.5);
    if (this.func) {
      this.engine.scene.remove(this.func.group);
      this.func.dispose();
      this.func = null;
    }
    this.cityGroup.visible = true;
    this.ground.mesh.visible = true;
    this.view = 'city';
    this.setMood('city');
    audio.setMood('city');
    this.engine.controls.maxPolarAngle = Math.PI * 0.495;
    const back = this.savedCityCam ?? { pos: new THREE.Vector3(200, 200, 300), target: new THREE.Vector3() };
    const start = back.pos.clone().sub(back.target).multiplyScalar(0.35).add(back.target);
    cam.position.copy(start);
    ctl.target.copy(back.target);
    await Promise.all([
      new Promise<void>((r) =>
        gsap.to(warp, {
          v: 0,
          fov: 55,
          duration: 1.4,
          ease: 'power3.out',
          onUpdate: () => {
            this.setWarp(warp.v);
            cam.fov = warp.fov;
            cam.updateProjectionMatrix();
          },
          onComplete: () => r(),
        }),
      ),
      this.flyTo(back.pos, back.target, 1.6, 'power3.out'),
    ]);
    this.transitioning = false;
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
    gsap.fromTo(u.uOpacity, { value: 1 }, { value: 0.7, duration: 3 });
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
    const hub = [...towers].sort((a, b) => b.fn.indeg - a.fn.indeg)[0];
    const complex = [...towers].sort((a, b) => b.fn.cc - a.fn.cc)[0];
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
              const ang = a.t;
              this.engine.camera.position.set(Math.cos(ang) * (H + 60), 45, Math.sin(ang) * (H + 60));
              this.engine.controls.target.set(Math.cos(ang + 0.5) * H, 30, Math.sin(ang + 0.5) * H);
            },
            onComplete: () => res(),
          }),
        );
      },
      async () => {
        if (!biggest) return;
        this.ev.caption?.(`// MEGASTRUCTURE ${biggest.fn.name}`, `${biggest.fn.size} bytes · ${biggest.fn.nbbs} blocks`);
        this.select(biggest);
        await this.focusTower(biggest, 3.5);
        await new Promise((r) => setTimeout(r, 1500));
      },
      async () => {
        if (!hub) return;
        this.ev.caption?.(`// HUB ${hub.fn.name}`, `called from ${hub.fn.indeg} sites`);
        this.select(hub);
        await this.focusTower(hub, 3.5);
        await new Promise((r) => setTimeout(r, 1500));
      },
      async () => {
        if (!complex) return;
        this.ev.caption?.(`// LABYRINTH ${complex.fn.name}`, `cyclomatic complexity ${complex.fn.cc}`);
        this.select(complex);
        await this.focusTower(complex, 3.5);
        await new Promise((r) => setTimeout(r, 1500));
      },
      async () => {
        this.ev.caption?.('// STRING NEBULA', `${this.info?.strings.length ?? 0} strings adrift`);
        this.select(null);
        await this.flyTo(new THREE.Vector3(R * 0.3, 150, R * 0.9), new THREE.Vector3(0, 175, 0), 3.5);
        await new Promise((r) => setTimeout(r, 1200));
      },
      async () => {
        this.ev.caption?.('// IMPORT RELAYS', `${this.sats?.sats.length ?? 0} uplinks to the outside world`);
        const S = this.sats?.radius ?? R + 140;
        await this.flyTo(new THREE.Vector3(S * 0.9, 90, S * 0.6), new THREE.Vector3(S * 0.3, 60, S * 0.9), 4);
      },
      async () => {
        this.ev.caption?.('// END OF LINE', 'press ~ for the shell · click a tower · double-click to dive');
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
    this.tourTimeline?.kill();
    this.ev.caption?.('');
  }

  get isPlaceholder() {
    return this.placeholder;
  }
}
