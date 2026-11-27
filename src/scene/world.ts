import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import gsap from 'gsap';
import { Engine } from './engine';
import { createSky } from './sky';
import { createGround } from './ground';
import { createHexRain, createMotes } from './particles';
import { CELL, WALK_CELL, City, type Tower } from './city';
import { CityArcs, NO_REFLECT_LAYER } from './callgraph';
import { EntropyHalo, HALO_GAP } from './entropy';
import { ImportRing, IMPORT_GAP, StringCloud } from './satellites';
import { FuncView } from './funcview';
import { FocusLayer } from './focus';
import { Constellation } from './constellation';
import { CameraRig } from './camera';
import { BlockRoom, EYE_HEIGHT, WALK_RADIUS, type InteriorPlan, type RoomArrival, type RoomDoorway, type RoomExit } from './interior';
import { DoorNames } from './doornames';
import { archFrameGeometry, archHalfWidthAt, STREET_ARCH } from './doorway';
import { DoorSightline, EntranceVista, FacadeStrings, PassageRoomView } from './entryvista';
import { corridorEntrances, isDirectPassage, WalkPassage, type PassageEnd } from './passage';
import { globals } from '../shaders/common';
import type { Fn, FnGraph, InfoMsg } from '../types';
import type { Model } from '../model';
import { audio } from '../audio/audio';

export type View = 'city' | 'constellation' | 'function' | 'interior';
export type RoomMotion = 'door' | 'lift' | 'slide' | 'quick' | 'warp';

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
  enterTower?: (tower: Tower) => void;
  previewTower?: (tower: Tower) => void;
  previewStrings?: (tower: Tower) => Promise<void>;
  roomExit?: (exit: RoomExit) => void;
  walkHint?: (tower: Tower | null, exit?: RoomExit) => void;
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
  room: BlockRoom | null = null;
  roomMap = false;
  constel: Constellation | null = null;
  focus: FocusLayer | null = null;
  info: InfoMsg | null = null;
  private cityGroup = new THREE.Group();
  private ground: ReturnType<typeof createGround>;
  private sky: ReturnType<typeof createSky>;
  private tunnel: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private screenCenter = new THREE.Vector2();
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
  private entrances: THREE.InstancedMesh | null = null;
  private doorNames: DoorNames | null = null;
  private previewedTower: Tower | null = null;
  private entranceVista: EntranceVista | null = null;
  private streetSightline: DoorSightline | null = null;
  private facade = new Map<Tower, FacadeStrings>();
  private requestedFacades = new Set<Tower>();
  private fetchingFacade = false;
  private inPltSuburbs = false;
  private beforeWalk: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private mapReturn: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private doorway: Tower | RoomExit | null = null;
  private roomCorridors: THREE.Mesh | null = null;
  private passage: {
    route: WalkPassage | null;
    landing?: BlockRoom;
    move: (p: THREE.Vector3) => { floor: number; arrived?: boolean };
    finish: (arrived: boolean) => void;
    cancel: () => void;
  } | null = null;
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
    engine.renderer.localClippingEnabled = true;
    engine.camera.layers.enable(NO_REFLECT_LAYER);
    this.rig = new CameraRig(engine, canvas);
    engine.rig = this.rig;
    this.rig.collide = (p) => this.collide(p);
    this.rig.walkCollision = (pos, from) => this.collideWalk(pos, from);
    this.rig.walkHeading = (eye, direction) => this.passage?.route?.heading(eye, direction);
    this.rig.corridorSpeed = () => this.passage?.route?.speedScale;
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
      this.streetSightline?.aim(engine.camera.position);
      this.city?.update(dt);
      this.halo?.update(dt);
      if (this.view === 'function') this.func?.updateLod(this.lod?.camera ?? engine.camera, this.lod?.viewH);
      if (this.rig.mode === 'walk' && !this.rig.walkBlocked) {
        if (this.view === 'city' && !this.passage) {
          this.updateStreetVista(t);
          this.updateFacadeStrings(t);
          this.updateSuburbs();
        }
        const aimed = this.view === 'interior' ? this.aimedRoomExit() : undefined;
        if (this.passage) this.room?.animate(t);
        else this.room?.update(t, engine.camera.position, aimed);
        this.ev.walkHint?.(this.view === 'city' ? this.nearEntrance() : null, aimed);
      }
      if (this.xrRay) this.pointerDirty = true; // the controller moves every frame
      if (this.rig.mode !== 'orbit' && this.rig.locked) {
        this.pointer.set(0, 0);
        this.pointerPx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        this.pointerDirty = true;
      }
      if (this.pointerDirty && !this.transitioning) {
        this.pointerDirty = false;
        this.updateHover();
      }
      this.engine.bloom.intensity = this.rig.mode === 'walk' || this.roomMap ? 0.28 + audio.level() * 0.11 : 1.25 + audio.level() * 0.8;
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
      if (this.rig.mode === 'walk') {
        if (!this.rig.locked) this.rig.lock();
        return;
      }
      const pick = this.pickNow();
      if (e.detail === 1) lastClick = { pick, t: performance.now() };
      if (e.detail === 1) this.ev.click?.(pick);
    });
    canvas.addEventListener('dblclick', () => {
      if (this.transitioning || this.placeholder || this.rig.mode === 'walk') return;
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
    const d = this.fogOn && !this.roomMap ? 0.9 / (radius * 2.2 + 380) : 0;
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
    this.ground.mesh.visible = !on && (this.view === 'city' || !!this.streetSightline);
    this.engine.scene.background = on ? null : new THREE.Color(0x05020c);
    this.passthrough = on;
  }
  private passthrough = false;

  private setMood(view: View) {
    const city = view === 'city';
    const fogCol = city ? new THREE.Color(0x12052a) : view === 'function' || view === 'interior'
      ? new THREE.Color(0x020814) : new THREE.Color(0x07031a);
    gsap.to(globals.uFogColor.value, { r: fogCol.r, g: fogCol.g, b: fogCol.b, duration: 1 });
    this.sky.material.uniforms.uIntensity.value = city ? 1 : view === 'function' ? 0.28 : 0.5;
    this.ground.mesh.material.uniforms.uFogColor.value = globals.uFogColor.value;
    audio.setMood(city ? 'city' : 'function');
  }

  private buildCity(functions: Fn[], entry: number | null) {
    this.setStreetSightline(null);
    this.clearFacadeStrings();
    this.clearEntranceVista();
    if (this.doorNames) {
      this.cityGroup.remove(this.doorNames.group);
      this.doorNames.dispose();
      this.doorNames = null;
    }
    if (this.city) {
      this.cityGroup.remove(this.city.group);
      this.city.dispose();
    }
    this.city = new City(functions, entry);
    this.cityGroup.add(this.city.group);
    this.ground.setCityRadius(this.city.radius);
    if (this.entrances) {
      this.cityGroup.remove(this.entrances);
      this.entrances.geometry.dispose();
      (this.entrances.material as THREE.Material).dispose();
      this.entrances.dispose();
    }
    const rim = archFrameGeometry(STREET_ARCH.halfWidth, STREET_ARCH.height);
    const sill = new THREE.BoxGeometry(STREET_ARCH.halfWidth * 2 + 0.12, 0.035, 0.45).translate(0, 0.015, 0.18);
    const flatSill = sill.toNonIndexed();
    const entrance = mergeGeometries([rim, flatSill]);
    rim.dispose();
    sill.dispose();
    flatSill.dispose();
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8be8ff).multiplyScalar(0.82) });
    this.entrances = new THREE.InstancedMesh(entrance, mat, this.city.towers.length);
    this.entrances.name = 'Street arches';
    this.entrances.visible = false;
    this.cityGroup.add(this.entrances);
    this.updateStreetGeometry();
  }

  private updateStreetGeometry() {
    const city = this.city;
    const entrances = this.entrances;
    if (!city || !entrances) return;
    this.grid.clear();
    for (const tower of city.towers) {
      const key = this.streetCell(tower.pos);
      const cell = this.grid.get(key);
      if (cell) cell.push(tower);
      else this.grid.set(key, [tower]);
    }
    const matrix = new THREE.Matrix4();
    for (const [i, tower] of city.towers.entries()) {
      const z = tower.pos.z + tower.width / 2 + 0.055;
      entrances.setMatrixAt(i, matrix.makeTranslation(tower.pos.x, 0, z));
    }
    entrances.instanceMatrix.needsUpdate = true;
    entrances.computeBoundingSphere();
  }

  private streetCell(p: THREE.Vector3) {
    const spacing = this.city?.spacing ?? CELL;
    return `${Math.round(p.x / spacing)},${Math.round(p.z / spacing)}`;
  }

  private setStreetLayout(walking: boolean) {
    const city = this.city;
    if (!city?.setSpacing(walking ? WALK_CELL : CELL)) return;
    this.clearFacadeStrings();
    this.clearEntranceVista();
    this.updateStreetGeometry();
    this.ground.setCityRadius(city.radius);
    this.setFog(city.radius);
    const haloRadius = city.footprintRadius + HALO_GAP;
    if (this.halo) {
      const s = haloRadius / this.halo.radius;
      this.halo.group.scale.set(s, 1, s);
    }
    if (this.sats) {
      const s = (haloRadius + IMPORT_GAP) / this.sats.radius;
      this.sats.group.scale.set(s, 1, s);
    }
    this.arcs?.setLayoutScale(city.spacing / CELL, this.sats?.group.scale.x ?? 1);
    if (this.focus) {
      const { fi, depth } = this.focus;
      this.clearFocus(false);
      this.setFocus(fi, depth);
    }
  }

  private nearbyTowers(p: THREE.Vector3, reach = 1) {
    const spacing = this.city?.spacing ?? CELL;
    const cx = Math.round(p.x / spacing);
    const cz = Math.round(p.z / spacing);
    const towers: Tower[] = [];
    for (let dx = -reach; dx <= reach; dx++)
      for (let dz = -reach; dz <= reach; dz++)
        towers.push(...(this.grid.get(`${cx + dx},${cz + dz}`) ?? []));
    return towers;
  }

  nearEntrance() {
    const eye = this.engine.camera.position;
    return this.nearbyTowers(eye).find((tower) => {
      const dz = eye.z - tower.pos.z - tower.width / 2;
      return dz >= 0 && dz < 1.6 && Math.abs(eye.x - tower.pos.x) < 0.83;
    }) ?? null;
  }

  private clearFacadeStrings() {
    for (const tower of this.facade.keys()) this.removeFacade(tower);
    this.requestedFacades.clear();
  }

  private clearEntranceVista() {
    const active = this.entranceVista;
    if (active) {
      this.cityGroup.remove(active.room.group);
      active.dispose();
      this.entranceVista = null;
    }
    this.previewedTower = null;
    this.city?.setOpenDoor(null);
  }

  private updateStreetVista(t: number) {
    const eye = this.engine.camera.position;
    if (eye.y > 5) return;
    let nearest: Tower | null = null;
    let best = 7;
    for (const tower of this.nearbyTowers(eye)) {
      const z = eye.z - tower.pos.z - tower.width / 2;
      const x = Math.abs(eye.x - tower.pos.x);
      if (z < 0 || x > 3.5) continue;
      const distance = Math.hypot(z, x);
      if (distance < best) {
        nearest = tower;
        best = distance;
      }
    }
    if (nearest !== this.previewedTower) {
      this.clearEntranceVista();
      this.previewedTower = nearest;
      if (nearest) this.ev.previewTower?.(nearest);
    }
    this.entranceVista?.update(eye, t);
  }

  showEntranceVista(tower: Tower, plan: InteriorPlan, model: Model, readSummary: (addr: number) => Promise<string>) {
    if (tower !== this.previewedTower || this.entranceVista || this.view !== 'city' || this.rig.mode !== 'walk') return false;
    this.clipEntrance(tower, new BlockRoom(plan, plan.entry, model, '', null, readSummary));
    return true;
  }

  private clipEntrance(tower: Tower, room: BlockRoom) {
    this.clearEntranceVista();
    this.previewedTower = tower;
    const vista = new EntranceVista(room);
    this.entranceVista = vista;
    this.cityGroup.add(vista.room.group);
    vista.update(this.engine.camera.position, this.engine.time);
    this.city?.setOpenDoor(tower);
  }

  entranceRoom(plan: InteriorPlan) {
    const room = this.entranceVista?.room;
    return room?.plan === plan ? room : null;
  }

  updateEntranceSummary(tower: Tower, summary: string) {
    if (tower === this.previewedTower) this.entranceVista?.setSummary(summary);
  }

  updateEntranceStrings(tower: Tower, strings: string[]) {
    if (this.view !== 'city' || this.rig.mode !== 'walk' || !this.requestedFacades.has(tower) || !strings.length || this.facade.has(tower)) return;
    const text = new FacadeStrings(tower, strings);
    this.facade.set(tower, text);
    this.cityGroup.add(text.group);
    text.update(this.engine.time);
  }

  private removeFacade(tower: Tower) {
    const text = this.facade.get(tower);
    if (!text) return;
    this.facade.delete(tower);
    this.cityGroup.remove(text.group);
    text.dispose();
  }

  private updateFacadeStrings(t: number) {
    const eye = this.engine.camera.position;
    if (this.rig.flying || eye.y > 5) return;
    const nearby = new Set(this.nearbyTowers(eye, 2));
    for (const tower of this.requestedFacades) {
      if (nearby.has(tower)) continue;
      this.requestedFacades.delete(tower);
      this.removeFacade(tower);
    }
    for (const text of this.facade.values()) text.update(t);
    if (this.fetchingFacade) return;
    let nearest: Tower | undefined;
    let best = Infinity;
    for (const tower of nearby) {
      if (this.requestedFacades.has(tower)) continue;
      const d = tower.pos.distanceToSquared(eye);
      if (d < best) { nearest = tower; best = d; }
    }
    if (!nearest || !this.ev.previewStrings) return;
    this.requestedFacades.add(nearest);
    this.fetchingFacade = true;
    void this.ev.previewStrings(nearest).finally(() => { this.fetchingFacade = false; });
  }

  private updateSuburbs() {
    if (this.rig.flying || !this.sats?.sats.length) return;
    const eye = this.engine.camera.position;
    const distance = Math.abs(Math.hypot(eye.x, eye.z) - this.sats.radius * this.sats.group.scale.x);
    const inside = distance < (this.inPltSuburbs ? 10 : 7);
    if (inside && !this.inPltSuburbs) this.ev.caption?.('ENTERING THE PLT SUBURBS', 'Import relays · Procedure Linkage Table');
    this.inPltSuburbs = inside;
  }

  private collideWalk(pos: THREE.Vector3, from: THREE.Vector3) {
    if (this.passage) {
      const result = this.passage.move(pos);
      this.rig.walkFloor = result.floor;
      if (result.arrived !== undefined) {
        this.rig.walkBlocked = true;
        this.passage.finish(result.arrived);
      }
      return;
    }
    let doorway: Tower | RoomExit | null = null;
    if (this.view === 'interior') doorway = this.room?.collide(pos) ?? null;
    if (this.view === 'city') {
      for (const tower of this.nearbyTowers(pos)) {
        const x = tower.pos.x;
        const z = tower.pos.z;
        const boundary = tower.width / 2 + WALK_RADIUS;
        if (from.z >= z + boundary - 0.0001 && pos.z < z + boundary
          && Math.abs(pos.x - x) < archHalfWidthAt(pos.y, STREET_ARCH.halfWidth, STREET_ARCH.height) - WALK_RADIUS) doorway = tower;
        if (Math.abs(pos.x - x) >= boundary || Math.abs(pos.z - z) >= boundary) continue;
        // Resolve against the side the player came from, so diagonal movement slides along it.
        if (Math.abs(from.x - x) >= boundary - 0.0001) pos.x = x + Math.sign(from.x - x) * boundary;
        else if (Math.abs(from.z - z) >= boundary - 0.0001) pos.z = z + Math.sign(from.z - z) * boundary;
        else if (Math.abs(pos.x - x) > Math.abs(pos.z - z)) pos.x = x + Math.sign(pos.x - x || 1) * boundary;
        else pos.z = z + Math.sign(pos.z - z || 1) * boundary;
      }
      // Keep the entry latched until the player steps away or explicitly retries with E.
      if (!doorway && this.doorway && 'fnIndex' in this.doorway && this.nearEntrance() === this.doorway) return;
    }
    if (doorway && this.doorway !== doorway) {
      this.doorway = doorway;
      if ('fnIndex' in doorway) this.ev.enterTower?.(doorway);
      else this.ev.roomExit?.(doorway);
    } else this.doorway = doorway;
  }

  private streetFrame(tower: Tower) {
    const face = tower.pos.clone().add(new THREE.Vector3(0, EYE_HEIGHT, tower.width / 2));
    const spacing = this.city?.spacing ?? CELL;
    const behind = this.nearbyTowers(tower.pos).find((t) => t.pos.x === tower.pos.x && t.pos.z > tower.pos.z && t.pos.z - tower.pos.z < spacing + 0.001);
    const gap = behind ? behind.pos.z - tower.pos.z - (tower.width + behind.width) / 2 : 3;
    return { pos: face.clone().add(new THREE.Vector3(0, 0, Math.min(2.4, gap - WALK_RADIUS - 0.08))), target: face };
  }

  startStreet(tower: Tower, approach = false, preservePosition = false) {
    this.stopTour();
    if (this.rig.mode !== 'walk') this.beforeWalk = this.cameraFrame();
    this.doorway = null;
    this.setStreetLayout(true);
    this.rig.walkFloor = EYE_HEIGHT;
    this.rig.zeroGravity = false;
    this.rig.setMode('walk');
    this.engine.setReadingView(true);
    this.engine.bloom.intensity = 0.28;
    this.city?.setStreetLevel(true);
    this.sky.material.uniforms.uIntensity.value = 0.52;
    this.ev.caption?.('');
    if (this.entrances) this.entrances.visible = true;
    if (!this.doorNames && this.city) {
      this.doorNames = new DoorNames(this.city);
      this.cityGroup.add(this.doorNames.group);
    }
    if (this.doorNames) this.doorNames.group.visible = true;
    const frame = this.streetFrame(tower);
    if (approach) void this.flyTo(frame.pos, frame.target, 2.65, 'sine.inOut');
    else if (!preservePosition) this.rig.place(frame.pos, frame.target);
    this.updateStreetVista(this.engine.time);
  }

  stopWalking(restore = false) {
    const before = this.beforeWalk;
    const wasWalking = this.rig.mode === 'walk';
    this.beforeWalk = null;
    this.inPltSuburbs = false;
    if (this.rig.mode === 'walk') this.rig.setMode('orbit');
    if (!this.roomMap && !this.room) this.engine.setReadingView(false);
    this.city?.setStreetLevel(false);
    if (this.view === 'city') this.sky.material.uniforms.uIntensity.value = 1;
    if (this.entrances) this.entrances.visible = false;
    if (this.doorNames) this.doorNames.group.visible = false;
    this.clearFacadeStrings();
    this.clearEntranceVista();
    this.setStreetLayout(false);
    if (restore && before) this.rig.place(before.pos, before.target);
    else if (wasWalking && this.view === 'city') {
      const { pos, target } = this.cameraFrame();
      const scale = new THREE.Vector3(CELL / WALK_CELL, 1, CELL / WALK_CELL);
      this.rig.place(pos.multiply(scale), target.multiply(scale));
    }
  }

  aimedRoomExit() {
    const camera = this.engine.camera;
    return this.room?.aimExit(camera.position, camera.getWorldDirection(new THREE.Vector3()));
  }

  aimedRoomCall() {
    if (!this.room?.calls.length || this.roomMap || this.passage || this.transitioning) return;
    this.raycaster.setFromCamera(this.screenCenter, this.engine.camera);
    return this.room.aimCall(this.raycaster);
  }

  /** Drone collision: stay above ground, slide off buildings. */
  private collide(p: THREE.Vector3) {
    if (this.view !== 'city' || !this.city) return; // the core / constellation float in open space
    p.y = Math.max(p.y, 1.5);
    for (const t of this.nearbyTowers(p)) {
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
    this.clearRoom();
    this.stopWalking();
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
    const footprint = City.radiusFor(model.fns, 0);
    this.setFog(r);
    for (const o of [this.halo?.group, this.strings?.labels.mesh, this.sats?.group, this.arcs?.mesh]) if (o) this.cityGroup.remove(o);
    this.halo?.dispose();
    this.strings?.dispose();
    this.sats?.dispose();
    this.arcs?.dispose();
    if (this.info) {
      this.halo = new EntropyHalo(this.info.entropy, this.info.sections ?? [], footprint);
      this.cityGroup.add(this.halo.group);
      this.halo.reveal();
      this.strings = new StringCloud(this.info.strings ?? [], r, 260);
      this.cityGroup.add(this.strings.labels.mesh);
    }
    this.sats = new ImportRing(this.info?.imports ?? [], model.fns, this.halo?.radius ?? footprint + HALO_GAP);
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
    if (this.view === 'interior' || this.rig.mode === 'walk') return null;
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
  private async warp(swap: () => Promise<{ pos: THREE.Vector3; target: THREE.Vector3 }>, out = false, fast = false) {
    this.transitioning = true;
    this.ev.hover?.(null, { x: 0, y: 0 });
    try {
      await this.warpInner(swap, out, fast);
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

  private async warpInner(swap: () => Promise<{ pos: THREE.Vector3; target: THREE.Vector3 }>, out: boolean, fast: boolean) {
    this.rig.stop();
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    audio.whoosh(out ? 1.1 : 1.3, !out);
    this.engine.glitch(fast ? 0.03 : 0.45, fast ? 0.3 : 1.0);
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
    if (fast) {
      await tw({ v: 0.34, fov: 64 }, 0.17, 'power2.in');
      const frame = await swap();
      this.rig.place(frame.pos, frame.target);
      await tw({ v: 0, fov: 55 }, 0.21, 'power3.out');
      return;
    }
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
    if (view !== 'city') this.clearEntranceVista();
    if (this.entrances) this.entrances.visible = view === 'city' && this.rig.mode === 'walk';
    this.setStreetSightline(view === 'interior' ? this.entryStreetSightline() : null);
    if (this.func) this.func.group.visible = view === 'function';
    if (this.constel) this.constel.group.visible = view === 'constellation';
    if (this.room) this.room.group.visible = view === 'interior';
    if (this.passage?.route) this.passage.route.group.visible = view === 'interior';
    if (this.passage?.landing) this.passage.landing.group.visible = view === 'interior';
    this.sky.mesh.visible = view !== 'interior' && !this.passthrough;
    this.engine.controls.maxPolarAngle = view === 'city' ? Math.PI * 0.495 : Math.PI;
    this.engine.controls.maxDistance = 2400;
    this.engine.camera.far = 9000;
    this.engine.camera.updateProjectionMatrix();
    this.rig.minY = view === 'city' ? 1.5 : -1e9;
    this.rig.liftAxis.set(0, view === 'function' ? 0 : 1, view === 'function' ? 1 : 0);
    this.setFog(this.fogRadius);
    this.engine.setReadingView(view === 'interior' || this.roomMap);
    this.setMood(view);
  }

  cameraFrame() {
    const cam = this.engine.camera;
    const target = this.rig.mode === 'orbit' ? this.engine.controls.target.clone() : cam.position.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(40));
    return { pos: cam.position.clone(), target };
  }

  get inCorridor() { return !!this.passage?.route; }
  get corridorDirection() { return this.rig.walkDirection * (this.passage?.route?.reverse ? -1 : 1); }
  get corridorDestination() { return this.passage?.landing?.block.addr; }

  cancelCorridor() {
    if (this.passage?.route) this.passage.cancel();
  }

  private rememberCity() {
    if (this.view === 'city') this.savedCityCam = this.beforeWalk ?? this.cameraFrame();
  }

  clearRoom() {
    this.passage?.finish(false);
    if (this.room) {
      this.engine.scene.remove(this.room.group);
      this.room.dispose();
      this.room = null;
    }
    this.roomCorridors = null;
    this.setStreetSightline(null);
    if (this.roomMap) this.func?.clearLocation();
    this.roomMap = false;
    this.mapReturn = null;
    this.doorway = null;
  }

  private roomEnd(room: BlockRoom, exit: RoomDoorway): PassageEnd {
    return { eye: room.doorwayPosition(exit), outward: new THREE.Vector3(exit.nx, 0, exit.nz), radius: exit.radius };
  }

  private streetEnd(tower: Tower): PassageEnd {
    return {
      eye: tower.pos.clone().add(new THREE.Vector3(0, EYE_HEIGHT, tower.width / 2)),
      outward: new THREE.Vector3(0, 0, -1),
    };
  }

  private entryStreetSightline() {
    const room = this.room;
    if (!room || room.block !== room.plan.entry || room.exits.at(-1)?.destination) return null;
    const tower = this.city?.towerOfFn(room.plan.fi);
    if (!tower) return null;
    const base = this.streetEnd(tower).eye.setY(0);
    return new DoorSightline(base, new THREE.Vector3(0, 0, 1), STREET_ARCH.halfWidth, STREET_ARCH.height, -0.035);
  }

  private setStreetSightline(sightline: DoorSightline | null) {
    const city = this.city;
    if (city && sightline !== this.streetSightline) {
      // Reparent the same tower mesh while the rest of the city is hidden.
      (sightline ? this.engine.scene : city.group).add(city.mesh);
      city.material.clippingPlanes = sightline?.planes ?? null;
    }
    this.streetSightline = sightline;
    sightline?.aim(this.engine.camera.position);
    this.ground.mesh.material.clippingPlanes = sightline?.planes ?? null;
    this.ground.mesh.visible = !this.passthrough && (this.view === 'city' || !!sightline);
  }

  private addRoomCorridors(room: BlockRoom) {
    const tower = this.city?.towerOfFn(room.plan.fi);
    const routes = room.exits.flatMap((exit) => {
      const destination = exit.destination;
      let end: PassageEnd;
      if (destination) {
        const { plan, block } = destination;
        const door = destination.doorway ?? plan.returnDoorway(block.addr);
        end = {
          eye: plan.position(block.addr).add(new THREE.Vector3(door.x, door.y, door.z)),
          outward: new THREE.Vector3(door.nx, 0, door.nz),
          radius: door.radius,
        };
      } else if (!exit.edge && tower) end = this.streetEnd(tower);
      else return [];
      return [{ start: this.roomEnd(room, exit), end, color: exit.color,
        slide: exit.slide || !!destination?.slide, reverse: !!destination?.doorway }];
    });
    this.roomCorridors = corridorEntrances(routes);
    this.roomCorridors.position.copy(room.group.position).negate();
    room.group.add(this.roomCorridors);
  }

  private async walkConnection(
    start: PassageEnd, end: PassageEnd, color: THREE.Color, slide: boolean, elevator: boolean, reverse = false, landing?: BlockRoom,
  ) {
    // The street entrance and the entry-room doorway share a plane.
    const direct = isDirectPassage(start, end);
    const space = -this.engine.camera.position.clone().sub(start.eye).dot(start.outward);
    const route = direct ? null : new WalkPassage(start, end, color, slide, elevator, Math.max(WALK_RADIUS + 0.04, space + 0.16), reverse);
    const sourceView = route && this.room ? new PassageRoomView(this.room, start) : null;
    const targetView = route && landing ? new PassageRoomView(landing, end) : null;
    const departure = this.cameraFrame();
    if (route) {
      this.engine.scene.add(route.group);
      if (this.roomCorridors) this.roomCorridors.visible = false;
      sourceView?.update(departure.pos, true);
      targetView?.update(departure.pos, false);
    }
    this.rig.walkBlocked = false;
    if (this.rig.zeroGravity) this.rig.walkFloor = this.engine.camera.position.y;
    this.rig.zeroGravity = false;
    return new Promise<boolean>((resolve) => {
      const finish = (arrived: boolean) => {
        this.passage = null;
        this.doorway = null;
        sourceView?.release();
        targetView?.release();
        if (route) {
          this.engine.scene.remove(route.group);
          route.dispose();
          if (this.roomCorridors) this.roomCorridors.visible = true;
        }
        resolve(arrived);
      };
      this.passage = {
        route,
        landing,
        move: (p) => {
          if (route) {
            const result = route.move(p);
            sourceView?.update(p, route.travelled < 1);
            targetView?.update(p, route.length - route.travelled < 1);
            return result;
          }
          p.x = THREE.MathUtils.clamp(p.x, start.eye.x - 0.35, start.eye.x + 0.35);
          const side = (p.z - start.eye.z) * start.outward.z;
          return { floor: start.eye.y, arrived: Math.abs(side) > WALK_RADIUS + 0.02 ? side > 0 : undefined };
        },
        finish,
        cancel: () => {
          finish(false);
          this.rig.place(departure.pos, departure.target);
        },
      };
    });
  }

  async enterRoom(room: BlockRoom, motion: RoomMotion, exit?: RoomExit, arrival?: RoomArrival) {
    this.stopTour();
    this.rememberCity();
    const source = this.room;
    const land = () => {
      if (this.entranceVista?.room === room) {
        this.entranceVista.release();
        this.entranceVista = null;
      }
      this.clearRoom();
      this.setStreetLayout(true);
      this.room = room;
      this.addRoomCorridors(room);
      this.engine.scene.add(room.group);
      this.showOnly('interior');
      this.rig.setMode('walk');
      this.rig.walkFloor = room.floorY + EYE_HEIGHT;
      this.rig.zeroGravity = room.zeroGravity;
    };
    if (motion === 'warp') {
      await this.warp(async () => {
        land();
        return arrival?.pose ?? room.spawn();
      }, false, true);
      return;
    }
    if (motion === 'quick') {
      land();
      const frame = arrival?.pose ?? room.spawn();
      this.rig.place(frame.pos, frame.target);
      return;
    }

    const tower = this.city?.towerOfFn(room.plan.fi);
    const start = source && exit ? this.roomEnd(source, exit) : tower && this.streetEnd(tower);
    if (!start) { room.dispose(); return; }
    const end = this.roomEnd(room, arrival?.doorway ?? room.exits.at(-1)!);
    if (!source && tower && isDirectPassage(start, end) && this.entranceVista?.room !== room) this.clipEntrance(tower, room);
    if (source) this.engine.scene.add(room.group);
    const arrived = await this.walkConnection(start, end, exit?.color ?? new THREE.Color(0x70d8ff), motion === 'slide' || !!arrival?.slide,
      motion === 'lift', !!arrival?.doorway, source ? room : undefined);
    if (!arrived) {
      if (this.entranceVista?.room !== room) {
        this.engine.scene.remove(room.group);
        room.dispose();
      }
      this.rig.walkFloor = start.eye.y;
      this.rig.zeroGravity = source?.zeroGravity ?? false;
      return;
    }
    land();
  }

  async openRoomMap() {
    const room = this.room;
    if (!room || this.mapReturn) return;
    const frame = this.mapReturn = this.cameraFrame();
    const fv = new FuncView(room.plan.graph);
    await fv.ready;
    if (this.room !== room || this.mapReturn !== frame) {
      fv.dispose();
      return;
    }
    if (this.func) {
      this.engine.scene.remove(this.func.group);
      this.func.dispose();
    }
    this.func = fv;
    this.engine.scene.add(fv.group);
    fv.setSeek(room.block.addr);
    fv.setLocation(room.block.addr);
    fv.reveal();
    this.roomMap = true;
    this.showOnly('function');
    this.rig.setMode('orbit');
    const overview = fv.overview(this.engine.camera.aspect, this.engine.camera.fov, true);
    const distance = overview.pos.distanceTo(overview.target);
    this.engine.controls.maxDistance = Math.max(2400, distance * 1.5);
    this.engine.camera.far = Math.max(9000, distance * 3);
    this.engine.camera.updateProjectionMatrix();
    this.rig.place(overview.pos, overview.target);
  }

  closeRoomMap() {
    const frame = this.mapReturn;
    if (!this.room || !frame) return;
    this.roomMap = false;
    this.mapReturn = null;
    this.func?.clearLocation();
    this.showOnly('interior');
    this.rig.setMode('walk');
    this.rig.zeroGravity = !this.inCorridor && this.room.zeroGravity;
    this.rig.place(frame.pos, frame.target);
  }

  async exitToStreet(tower: Tower, exit?: RoomExit) {
    const source = this.room;
    if (!source) return false;
    if (exit) {
      const start = this.roomEnd(source, exit);
      const arrived = await this.walkConnection(start, this.streetEnd(tower), exit.color, false, false);
      if (!arrived) {
        this.rig.walkFloor = start.eye.y;
        this.rig.zeroGravity = source.zeroGravity;
        this.rig.walkBlocked = false;
        return false;
      }
    }
    this.clearRoom();
    this.showOnly('city');
    this.startStreet(tower, false, !!exit);
    this.rig.walkBlocked = false;
    return true;
  }

  async walkToImport(fi: number) {
    if (!this.sats?.posOfFn(fi)) return false;
    await this.warp(async () => {
      this.clearRoom();
      this.setStreetLayout(true);
      this.showOnly('city');
      this.rig.walkFloor = EYE_HEIGHT;
      this.rig.zeroGravity = false;
      this.rig.setMode('walk');
      this.rig.walkBlocked = false;
      const target = this.sats!.posOfFn(fi)!.setY(EYE_HEIGHT);
      const outward = target.clone().setY(0).normalize();
      return { pos: target.clone().addScaledVector(outward, -3.5), target };
    }, false, true);
    return this.view === 'city';
  }

  async enterFunction(graph: FnGraph, seek?: number) {
    if (this.transitioning) return;
    this.stopTour();
    this.rememberCity();
    this.stopWalking();
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
    this.stopWalking();
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
    this.stopWalking();
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
    if (!this.strings || this.rig.mode === 'walk') return;
    const u = this.strings.labels.material.uniforms;
    gsap.fromTo(u.uPulse, { value: 1.5 }, { value: 0, duration: 3, ease: 'power2.out' });
    gsap.fromTo(u.uOpacity, { value: 1 }, { value: 0.5, duration: 3 });
    const R = this.city?.radius ?? 100;
    this.flyTo(new THREE.Vector3(R * 0.4, 140, R * 1.3), new THREE.Vector3(0, 170, 0), 2.4);
  }

  pulseImports() {
    if (!this.sats || this.rig.mode === 'walk') return;
    const o = { v: 1.5 };
    gsap.to(o, { v: 0, duration: 3, onUpdate: () => this.sats?.pulse(o.v) });
    const R = this.sats.radius;
    this.flyTo(new THREE.Vector3(0, 170, R * 1.25), new THREE.Vector3(0, 60, 0), 2.6);
  }

  focusEntropy() {
    if (!this.halo || this.rig.mode === 'walk') return;
    const o = { v: 1 };
    gsap.to(o, { v: 0, duration: 3, onUpdate: () => this.halo?.setFocus(o.v) });
    const p = this.halo.focusPoint();
    const out = p.clone().setY(0).normalize();
    this.flyTo(p.clone().add(out.clone().multiplyScalar(-90)).setY(70), p.clone().setY(35), 2.4);
  }

  overview() {
    if (this.rig.mode === 'walk') return;
    if (this.view === 'function' && this.func) {
      const o = this.func.overview(undefined, undefined, this.roomMap);
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
    if (!this.city || this.placeholder || this.view !== 'city' || this.rig.mode === 'walk') return;
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
