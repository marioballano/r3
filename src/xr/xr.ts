import * as THREE from 'three';
import type { World, Pick } from '../scene/world';
import { globals } from '../shaders/common';
import { audio } from '../audio/audio';
import { hex } from '../types';
import { TextPanel } from './panel';

/**
 * WebXR: fly through the binary in a headset (VR) or over a table in your room (MR passthrough).
 *
 * The desktop camera (`engine.camera`) stays the "virtual" viewpoint every view already drives:
 * flights, warps, focus framing. The headset camera sits in a scaled rig that follows it during
 * flights and drives it the rest of the time, so the app logic needs no XR special cases.
 */

type Mode = 'vr' | 'mr';
type Scale = 'life' | 'giant' | 'table';
const SCALES: Scale[] = ['life', 'giant', 'table'];
/** stick speed in metres per second at each scale (multiplied by the rig scale into world units) */
const SPEED: Record<Scale, number> = { life: 25, giant: 4, table: 0.5 };
const GIANT = 12;
/** nominal eye-buffer size that screen-space line widths are measured against in the headset */
const EYE_PX = 1400;

export interface XRAppHooks {
  /** run a desktop shortcut (same path as the keyboard) */
  key(k: string): void;
  status(): { sel: number | null; seek: number | null; depth: number; ready: boolean };
}

interface Hand {
  ctl: THREE.Group;
  grip: THREE.Group;
  source: XRInputSource | null;
  laser: THREE.Mesh;
  dot: THREE.Mesh;
  pressed: boolean[];
  snapArmed: boolean;
  flickArmed: boolean;
}

// -------------------------------------------------------------------- tone mapping
// On the desktop, ACES + sRGB happen in the postprocessing chain. In a headset the scene renders
// straight into the XR framebuffer, so our own ShaderMaterials need the two chunks three adds to
// its built-in materials. Both are no-ops when rendering into a linear render target (the
// composer's input buffer, the ground reflection), so desktop output is unchanged.
const baseCompile = THREE.ShaderMaterial.prototype.onBeforeCompile;
THREE.ShaderMaterial.prototype.onBeforeCompile = function (this: THREE.ShaderMaterial, shader, renderer) {
  baseCompile.call(this, shader, renderer);
  // only plain ShaderMaterials: postprocessing's subclasses do their own output encoding
  if (this.constructor !== THREE.ShaderMaterial) return;
  const fs = shader.fragmentShader;
  const end = fs.lastIndexOf('}');
  if (end < 0 || !/gl_FragColor/.test(fs)) return;
  shader.fragmentShader = `${fs.slice(0, end)}\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n${fs.slice(end)}`;
};

// -------------------------------------------------------------------- helpers
const UP = new THREE.Vector3(0, 1, 0);
const yawOf = (q: THREE.Quaternion) => {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-f.x, -f.z);
};
const yawToward = (d: THREE.Vector3) => Math.atan2(-d.x, -d.z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function comfortSphere() {
  // head-locked: a peripheral vignette during flights, and a full blink for snap turns
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: { uVig: { value: 0 }, uBlink: { value: 0 } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uVig;
      uniform float uBlink;
      varying vec3 vP;
      void main() {
        float fwd = -normalize(vP).z;
        float a = max(uBlink, uVig * smoothstep(0.86, 0.45, fwd));
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 16), mat);
  m.renderOrder = 2000;
  m.frustumCulled = false;
  return m;
}

function laserMesh() {
  const g = new THREE.CylinderGeometry(0.0012, 0.004, 1, 6, 1, true);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -0.5); // spans z ∈ [-1, 0]: scale.z is the length
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  m.frustumCulled = false;
  return m;
}

function dotMesh() {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 24), new THREE.MeshBasicMaterial({ color: 0xff2bd6, transparent: true, depthTest: false, side: THREE.DoubleSide, toneMapped: false }));
  m.renderOrder = 1500;
  m.visible = false;
  return m;
}

function controllerModel() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.1, 6), new THREE.MeshBasicMaterial({ color: 0x00f0ff, wireframe: true, transparent: true, opacity: 0.6, toneMapped: false }));
  body.rotation.x = -Math.PI / 2.6;
  const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.008), new THREE.MeshBasicMaterial({ color: 0xff2bd6, toneMapped: false }));
  tip.position.set(0, 0.012, -0.05);
  g.add(body, tip);
  return g;
}

// -------------------------------------------------------------------- XR mode
export class XRMode {
  private engine;
  private renderer;
  private rig = new THREE.Group();
  private head = new THREE.PerspectiveCamera(70, 1, 0.05, 40000);
  private lodCam = new THREE.PerspectiveCamera(95, 1, 0.5, 9000);
  private comfort = comfortSphere();
  private hands: Hand[] = [];
  private active = 1; // index into hands: the pointing controller
  private wrist = new TextPanel(512, 400, 0.17);
  private tip = new TextPanel(640, 220, 1);
  private mode: Mode = 'vr';
  private scaleMode: Scale = 'life';
  private S = 1;
  private needsPlace = false;
  private lastView = '';
  // head pose in the rig's local (unscaled) space, refreshed each frame
  private headLocal = new THREE.Vector3(0, 1.6, 0);
  private headLocalQ = new THREE.Quaternion();
  // flight following
  private follow = false;
  private followHead = new THREE.Vector3();
  private blink: { t: number; turn: number; done: boolean } | null = null;
  private vig = 0;
  private vel = new THREE.Vector3();
  private bar: HTMLElement | null = null;
  private tipKey = '';
  private wristKey = '';
  private frame = 0;

  constructor(
    private world: World,
    private app: XRAppHooks,
  ) {
    this.engine = world.engine;
    this.renderer = this.engine.renderer;
    const { rig, head } = this;
    rig.name = 'xr-rig';
    rig.visible = false;
    head.layers.mask = this.engine.camera.layers.mask;
    head.add(this.comfort);
    rig.add(head);
    this.tip.mesh.visible = false;
    rig.add(this.tip.mesh);
    this.engine.scene.add(rig);

    for (let i = 0; i < 2; i++) {
      const ctl = this.renderer.xr.getController(i);
      const grip = this.renderer.xr.getControllerGrip(i);
      const hand: Hand = { ctl, grip, source: null, laser: laserMesh(), dot: dotMesh(), pressed: [], snapArmed: true, flickArmed: true };
      ctl.add(hand.laser);
      hand.laser.visible = false;
      rig.add(ctl, grip, hand.dot);
      ctl.addEventListener('connected', (e) => {
        const src = (e as unknown as { data: XRInputSource }).data;
        hand.source = src;
        hand.laser.visible = src.targetRayMode === 'tracked-pointer';
        if (src.gamepad) grip.add(controllerModel());
        if (src.handedness === 'left' && src.gamepad) {
          // wrist display: above the left controller, tilted towards the eyes
          grip.add(this.wrist.mesh);
          this.wrist.mesh.position.set(0, 0.085, 0.01);
          this.wrist.mesh.rotation.x = -0.75;
        }
        if (src.handedness === 'right') this.active = i;
      });
      ctl.addEventListener('disconnected', () => {
        hand.source = null;
        hand.laser.visible = false;
        hand.dot.visible = false;
        grip.clear();
      });
      ctl.addEventListener('select', () => this.onSelect(i));
      this.hands.push(hand);
    }

    this.engine.xr = { camera: head, before: (dt) => this.before(dt), after: (dt) => this.after(dt) };
    // we update the XR cameras ourselves (see cullingFrustum)
    this.renderer.xr.cameraAutoUpdate = false;
    world.rig.onFlight = (pos, target) => this.onFlight(pos, target);
    this.renderer.xr.addEventListener('sessionstart', () => this.onStart());
    this.renderer.xr.addEventListener('sessionend', () => this.onEnd());
    void this.mountButtons();
  }

  // ------------------------------------------------------------------ session
  private async mountButtons() {
    const xr = navigator.xr;
    if (!xr) return;
    const [vr, ar] = await Promise.all([xr.isSessionSupported('immersive-vr').catch(() => false), xr.isSessionSupported('immersive-ar').catch(() => false)]);
    if (!vr && !ar) return;
    const bar = (this.bar = document.createElement('div'));
    bar.className = 'xrbar';
    const btn = (label: string, title: string, mode: Mode) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = () => void this.enter(mode);
      bar.append(b);
    };
    if (vr) btn('◢ ENTER VR', 'fly through the binary in your headset', 'vr');
    if (ar) btn('◢ MR', 'passthrough: the binary on a table in your room', 'mr');
    document.getElementById('ui')!.append(bar);
  }

  async enter(mode: Mode) {
    if (this.renderer.xr.isPresenting) return;
    if (this.world.rig.mode === 'walk' || this.world.roomMap) {
      this.world.ev.caption?.('EXIT WALK MODE FOR XR', 'X to exit the building · G to return to orbit');
      return;
    }
    const type = mode === 'mr' ? 'immersive-ar' : 'immersive-vr';
    try {
      const session = await navigator.xr!.requestSession(type, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      this.mode = mode;
      await this.renderer.xr.setSession(session);
    } catch (e) {
      console.warn('[r3] WebXR session failed', e);
    }
  }

  private onStart() {
    const { world, engine } = this;
    if (world.rig.mode === 'drone') world.rig.setMode('orbit');
    engine.controls.enabled = false;
    engine.controls.autoRotate = false;
    engine.touch();
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    globals.uRes.value.set(EYE_PX, EYE_PX);
    const mr = this.mode === 'mr';
    world.setPassthrough(mr);
    world.setFogOn(!mr);
    if (mr) this.renderer.setClearAlpha(0);
    world.lod = { camera: this.lodCam, viewH: 1800 };
    this.setScale(mr ? 'table' : 'life', false);
    this.rig.visible = true;
    this.needsPlace = true;
    this.lastView = world.view;
    this.follow = false;
    this.bar?.classList.add('hidden');
    audio.blip(880, 0.12, 'triangle', 0.05);
  }

  private onEnd() {
    const { world, engine } = this;
    this.rig.visible = false;
    this.tip.mesh.visible = false;
    world.xrRay = null;
    world.lod = null;
    world.setPassthrough(false);
    world.setFogOn(true);
    world.ev.hover?.(null, { x: 0, y: 0 });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearAlpha(1);
    // hand the head's viewpoint back to the orbit controls, levelled
    const cam = engine.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    engine.controls.target.copy(cam.position).addScaledVector(fwd, 40);
    cam.up.set(0, 1, 0);
    cam.lookAt(engine.controls.target);
    cam.fov = 55;
    engine.controls.enabled = true;
    engine.resize();
    this.bar?.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ rig placement
  private headWorld(out = new THREE.Vector3()) {
    return out.copy(this.headLocal).multiplyScalar(this.S).applyQuaternion(this.rig.quaternion).add(this.rig.position);
  }

  private headYaw() {
    return yawOf(this.rig.quaternion.clone().multiply(this.headLocalQ));
  }

  /** Put the user's eyes at `eye` (world), looking along `yaw`. */
  private place(eye: THREE.Vector3, yaw: number) {
    const rigYaw = yaw - yawOf(this.headLocalQ);
    this.rig.quaternion.setFromAxisAngle(UP, rigYaw);
    this.rig.position.copy(eye).sub(this.headLocal.clone().multiplyScalar(this.S).applyQuaternion(this.rig.quaternion));
    this.rig.updateMatrixWorld(true);
  }

  private setScale(s: Scale, keepEye = true) {
    const eye = this.headWorld();
    const yaw = this.headYaw();
    this.scaleMode = s;
    this.S = s === 'life' ? 1 : s === 'giant' ? GIANT : this.tableAnchor().S;
    this.rig.scale.setScalar(this.S);
    if (s === 'table') this.placeTable();
    else if (keepEye) this.place(eye, yaw);
  }

  /** Where the miniature sits for the current view: its centre, viewing direction and the rig scale that makes it ~1 m across. */
  private tableAnchor() {
    const w = this.world;
    let target = new THREE.Vector3(0, 0, 0);
    let dir = new THREE.Vector3(0.55, 0.62, 0.56).normalize();
    let radius = (w.halo?.radius ?? w.city?.radius ?? 150) * 1.05;
    const o = w.view === 'function' ? w.func?.overview(1, 70) : w.view === 'constellation' ? w.constel?.overview(70, 1) : null;
    if (o) {
      target = o.target.clone();
      dir = o.pos.clone().sub(o.target).normalize();
      radius = o.pos.distanceTo(o.target) * 0.55;
    }
    return { target, dir, S: Math.max(4, radius / 0.5) };
  }

  private placeTable() {
    const a = this.tableAnchor();
    this.S = a.S;
    this.rig.scale.setScalar(this.S);
    // the miniature ~0.85 m away, the eyes a little above its centre for the city (a table), level for the core
    const dir = a.dir.clone();
    if (this.world.view === 'city') dir.setY(0).normalize().multiplyScalar(0.85).add(new THREE.Vector3(0, 0.55, 0));
    else dir.multiplyScalar(0.9);
    const eye = a.target.clone().addScaledVector(dir, this.S);
    this.place(eye, yawToward(a.target.clone().sub(eye)));
  }

  private onFlight(pos: THREE.Vector3, target: THREE.Vector3) {
    if (!this.renderer.xr.isPresenting || this.scaleMode === 'table') return;
    this.follow = true;
    this.followHead.copy(this.headLocal);
    const d = target.clone().sub(pos);
    if (Math.hypot(d.x, d.z) < 1e-3) return;
    const turn = wrap(yawToward(d) - this.headYaw());
    // re-aim behind a blink when the subject would end up well off to the side
    if (Math.abs(turn) > 0.6) this.blink = { t: 0, turn, done: false };
  }

  // ------------------------------------------------------------------ frame
  private before(dt: number) {
    this.frame++;
    this.readHead();
    if (this.needsPlace) {
      this.needsPlace = false;
      if (this.scaleMode === 'table') this.placeTable();
      else {
        const cam = this.engine.camera;
        this.place(cam.position.clone(), yawOf(cam.quaternion));
      }
    }
    if (this.world.view !== this.lastView) {
      this.lastView = this.world.view;
      if (this.scaleMode === 'table') this.placeTable();
    }
    this.updateBlink(dt);
    this.locomotion(dt);
    this.rig.updateMatrixWorld(true);
    // the virtual camera follows the head, except while a flight is driving it
    const cam = this.engine.camera;
    const eye = this.headWorld();
    const q = this.rig.quaternion.clone().multiply(this.headLocalQ);
    if (!this.follow) {
      cam.position.copy(eye);
      this.engine.controls.target.copy(eye).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(q), 40);
    }
    cam.quaternion.copy(q);
    cam.updateMatrixWorld(true);
    this.lodCam.position.copy(eye);
    this.lodCam.quaternion.copy(q);
    this.lodCam.updateMatrixWorld(true);
    this.input();
  }

  private after(dt: number) {
    if (this.follow) {
      // keep the head's offset from the start of the flight: physical head motion still counts.
      // Applied before checking for the end: the tween's last tick lands the camera and ends it at once.
      const off = this.followHead.clone().multiplyScalar(this.S).applyQuaternion(this.rig.quaternion);
      this.rig.position.copy(this.engine.camera.position).sub(off);
      this.rig.updateMatrixWorld(true);
      if (!this.world.rig.flying) this.follow = false;
    }
    this.vig += ((this.follow || this.world.transitioning ? 1 : this.vel.length() > 0.5 * SPEED[this.scaleMode] * this.S ? 0.6 : 0) - this.vig) * Math.min(1, dt * 6);
    this.comfort.material.uniforms.uVig.value = this.vig * 0.85;
    this.updatePointers();
    if (this.frame % 8 === 0) this.updateWrist();
    this.renderer.xr.updateCamera(this.head);
    this.cullingFrustum();
  }

  /**
   * three culls with one frustum around both eyes, but it adds the eye separation (world units) to
   * the near plane (view units): under a scaled rig that pushes the near plane out by the scale
   * and culls everything in front of you. Swap in a conservative wide frustum from the mid-eye.
   */
  private cullingFrustum() {
    const xrCam = this.renderer.xr.getCamera();
    const views: THREE.PerspectiveCamera[] = xrCam.cameras;
    if (!views.length) return;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    views[0].matrixWorld.decompose(p, q, sc);
    if (views.length > 1) p.lerp(new THREE.Vector3().setFromMatrixPosition(views[1].matrixWorld), 0.5);
    xrCam.matrixWorld.compose(p, q, sc);
    xrCam.matrixWorldInverse.copy(xrCam.matrixWorld).invert();
    const n = this.head.near;
    const w = n * Math.tan(THREE.MathUtils.degToRad(70)); // 140° wide covers both eyes' asymmetric FOVs
    xrCam.projectionMatrix.makePerspective(-w, w, w, -w, n, this.head.far);
    xrCam.projectionMatrixInverse.copy(xrCam.projectionMatrix).invert();
  }

  private readHead() {
    const xrCam = this.renderer.xr.getCamera();
    // typed as a stereo pair, but a handheld/passthrough session can have a single view
    const views: THREE.Camera[] = xrCam.cameras;
    if (views.length >= 2) this.headLocal.copy(views[0].position).add(views[1].position).multiplyScalar(0.5);
    else if (views.length === 1) this.headLocal.copy(views[0].position);
    else return;
    this.headLocalQ.copy(views[0].quaternion);
  }

  private updateBlink(dt: number) {
    const b = this.blink;
    const u = this.comfort.material.uniforms.uBlink;
    if (!b) return;
    b.t += dt;
    const OUT = 0.1;
    const IN = 0.18;
    if (b.t < OUT) u.value = b.t / OUT;
    else {
      if (!b.done) {
        b.done = true;
        const eye = this.headWorld();
        this.place(eye, this.headYaw() + b.turn);
      }
      u.value = Math.max(0, 1 - (b.t - OUT) / IN);
      if (b.t > OUT + IN) this.blink = null;
    }
  }

  // ------------------------------------------------------------------ input
  private gamepad(i: number) {
    return this.hands[i]?.source?.gamepad ?? null;
  }

  private stick(gp: Gamepad) {
    const a = gp.axes;
    return a.length >= 4 ? { x: a[2], y: a[3] } : { x: a[0] ?? 0, y: a[1] ?? 0 };
  }

  private side(hand: 'left' | 'right') {
    return this.hands.findIndex((h) => h.source?.handedness === hand && h.source.gamepad);
  }

  private locomotion(dt: number) {
    const want = new THREE.Vector3();
    const L = this.side('left');
    const R = this.side('right');
    const speed = SPEED[this.scaleMode] * this.S;
    const q = this.rig.quaternion.clone().multiply(this.headLocalQ);
    let boost = 1;
    if (L >= 0) {
      const gp = this.gamepad(L)!;
      const s = this.stick(gp);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize();
      const k = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - 0.12) ** 2 * 1.3;
      want.addScaledVector(fwd, -k(s.y)).addScaledVector(right, k(s.x));
      if (gp.buttons[1]?.pressed) boost = 4;
    }
    const gripR = R >= 0 && !!this.gamepad(R)!.buttons[1]?.pressed;
    if (R >= 0 && !(gripR && this.world.view === 'function')) {
      const s = this.stick(this.gamepad(R)!);
      if (Math.abs(s.y) > 0.25) want.y += -Math.sign(s.y) * (Math.abs(s.y) - 0.25) * 1.3;
    }
    want.multiplyScalar(speed * boost);
    this.vel.lerp(want, 1 - Math.exp(-dt * 8));
    if (this.vel.lengthSq() < 1e-6 * speed * speed) return;
    if (this.follow) {
      // the stick takes over from a flight
      this.world.rig.stop();
      this.follow = false;
    }
    this.rig.position.addScaledVector(this.vel, dt);
    if (this.scaleMode !== 'table' && this.world.view === 'city') {
      // the drone's collision rules, applied to the eyes
      const eye = this.headWorld();
      const c = eye.clone();
      this.world.collidePoint(c);
      this.rig.position.add(c.sub(eye));
    }
    this.engine.touch();
  }

  private edge(i: number, b: number) {
    const gp = this.gamepad(i);
    if (!gp) return false;
    const now = !!gp.buttons[b]?.pressed;
    const was = !!this.hands[i].pressed[b];
    this.hands[i].pressed[b] = now;
    return now && !was;
  }

  private input() {
    const L = this.side('left');
    const R = this.side('right');
    const st = this.app.status();
    if (R >= 0) {
      if (this.edge(R, 4)) this.app.key('Enter'); // A: dive into the core
      if (this.edge(R, 5)) this.app.key('Escape'); // B: back out
      if (this.edge(R, 3)) this.app.key('h'); // stick click: overview
      const hand = this.hands[R];
      const s = this.stick(this.gamepad(R)!);
      const grip = !!this.gamepad(R)!.buttons[1]?.pressed;
      if (grip && this.world.view === 'function') {
        // grip + flick: walk the control flow (↓ fall-through, → taken, ↑ predecessor, ← back)
        const m = Math.max(Math.abs(s.x), Math.abs(s.y));
        if (m < 0.3) hand.flickArmed = true;
        else if (m > 0.75 && hand.flickArmed) {
          hand.flickArmed = false;
          this.app.key(Math.abs(s.x) > Math.abs(s.y) ? (s.x > 0 ? 'ArrowRight' : 'ArrowLeft') : s.y > 0 ? 'ArrowDown' : 'ArrowUp');
        }
      } else {
        // snap turn
        if (Math.abs(s.x) < 0.3) hand.snapArmed = true;
        else if (Math.abs(s.x) > 0.75 && hand.snapArmed && !this.blink) {
          hand.snapArmed = false;
          this.blink = { t: 0, turn: -Math.sign(s.x) * (Math.PI / 6), done: false };
        }
      }
    }
    if (L >= 0) {
      if (this.edge(L, 4)) this.app.key('c'); // X: constellation
      if (this.edge(L, 5)) this.cycleScale(); // Y: world scale
      if (this.edge(L, 3) && st.sel !== null && this.world.view === 'city') this.app.key(String((st.depth % 3) + 1)); // stick click: focus depth
    }
    // the pointing hand drives hover
    const h = this.hands[this.active];
    if (h?.source && h.source.targetRayMode !== 'gaze') {
      h.ctl.updateMatrixWorld(true);
      const ray = (this.world.xrRay ??= new THREE.Ray());
      ray.origin.setFromMatrixPosition(h.ctl.matrixWorld);
      ray.direction.set(0, 0, -1).transformDirection(h.ctl.matrixWorld);
    } else this.world.xrRay = null;
  }

  private cycleScale() {
    const next = SCALES[(SCALES.indexOf(this.scaleMode) + 1) % SCALES.length];
    this.world.rig.stop();
    this.follow = false;
    this.setScale(next);
    audio.blip(next === 'life' ? 440 : next === 'giant' ? 660 : 880, 0.1, 'triangle', 0.05);
    this.wristKey = '';
  }

  private onSelect(i: number) {
    if (!this.hands[i]?.source) return;
    if (i !== this.active) {
      // first press of the other hand just takes over pointing
      this.active = i;
      this.hands[i].ctl.updateMatrixWorld(true);
      const ray = (this.world.xrRay ??= new THREE.Ray());
      ray.origin.setFromMatrixPosition(this.hands[i].ctl.matrixWorld);
      ray.direction.set(0, 0, -1).transformDirection(this.hands[i].ctl.matrixWorld);
    }
    this.pulse(i, 0.4, 25);
    this.world.xrSelect();
  }

  private pulse(i: number, v: number, ms: number) {
    const gp = this.gamepad(i) as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): Promise<boolean> }[] }) | null;
    gp?.hapticActuators?.[0]?.pulse(v, ms).catch(() => {});
  }

  // ------------------------------------------------------------------ visuals
  private updatePointers() {
    const eye = this.headWorld();
    const hit = this.world.hitPoint;
    const pick = this.world.hovered;
    this.hands.forEach((h, i) => {
      const on = i === this.active && !!h.source;
      const mat = h.laser.material as THREE.MeshBasicMaterial;
      mat.opacity = on ? 0.8 : 0.22;
      mat.color.set(on && pick ? 0xff2bd6 : 0x00f0ff);
      const origin = new THREE.Vector3().setFromMatrixPosition(h.ctl.matrixWorld);
      h.laser.scale.z = on && hit ? origin.distanceTo(hit) / this.S : 6;
      h.dot.visible = on && !!hit;
      if (on && hit) {
        h.dot.position.copy(this.rig.worldToLocal(hit.clone()));
        const d = hit.distanceTo(eye) / this.S;
        h.dot.scale.setScalar(Math.max(0.004, d * 0.008));
        h.dot.lookAt(eye);
      }
    });
    // hover card, at a constant angular size beside the hit
    const lines = pick ? this.describe(pick) : null;
    const k = lines ? lines.join('\n') : '';
    if (k !== this.tipKey) {
      this.tipKey = k;
      if (lines) {
        this.tip.draw(lines);
        this.pulse(this.active, 0.12, 12);
      }
    }
    this.tip.mesh.visible = !!(lines && hit);
    if (lines && hit) {
      const local = this.rig.worldToLocal(hit.clone());
      const head = this.headLocal;
      const d = local.distanceTo(head);
      const s = d * 0.2;
      this.tip.mesh.scale.setScalar(s);
      const toHead = head.clone().sub(local).normalize();
      this.tip.mesh.position.copy(local).addScaledVector(toHead, d * 0.08).add(new THREE.Vector3(0, s * this.tip.aspect * 0.7, 0));
      this.tip.mesh.lookAt(eye);
    }
  }

  private describe(p: Pick): string[] | null {
    const m = this.world.model;
    if (!m) return null;
    if (p.kind === 'tower' || p.kind === 'node') {
      const f = m.fns[p.fi];
      return [`#${f.name}`, `@${hex(f.min)} – ${hex(f.max)}`, `size ${f.size} · blocks ${f.nbbs} · cc ${f.cc}`, `▲ ${m.callers(p.fi).length} callers   ▼ ${m.callees(p.fi).length} callees`];
    }
    if (p.kind === 'sat') return ['~IMPORT RELAY', `#${p.name}`, p.fi !== null ? `called from ${m.in[p.fi].length} sites` : ''];
    if (p.kind === 'op') {
      const panel = this.world.func?.panelAt(p.addr);
      const op = panel?.block.ops.find((o) => o.addr === p.addr);
      return [`@${hex(p.addr)}`, `#${op?.disasm ?? op?.opcode ?? ''}`];
    }
    return null;
  }

  private updateWrist() {
    const st = this.app.status();
    const m = this.world.model;
    const view = { city: 'CITY', constellation: 'CONSTELLATION', function: 'CORE', interior: 'BUILDING' }[this.world.view];
    const scale = { life: 'LIFE SIZE', giant: `GIANT ×${GIANT}`, table: 'TABLETOP' }[this.scaleMode];
    const f = m && st.sel !== null ? m.fns[st.sel] : null;
    const file = this.world.info?.path?.split('/').pop() ?? '';
    const lines = [
      `~r3 // ${view}`,
      `${file}`,
      f ? `#${f.name}` : 'no selection',
      f ? `size ${f.size} · ${f.nbbs} blocks · ▲${m!.callers(st.sel!).length} ▼${m!.callees(st.sel!).length}` : '',
      st.seek !== null ? `@${hex(st.seek)}` : '',
      `~${scale}`,
      '',
      '!trigger  select · 2× dive in',
      '!A core  B back  X graph  Y scale',
      '!L stick fly · grip boost',
      '!R stick turn · rise / sink',
      this.world.view === 'function' ? '!R grip + flick  walk the flow' : '!L click depth  R click overview',
    ];
    const k = lines.join('\n');
    if (k === this.wristKey) return;
    this.wristKey = k;
    this.wrist.draw(lines);
  }
}
