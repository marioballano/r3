import * as THREE from 'three';
import gsap from 'gsap';
import type { Engine } from './engine';

export type CamMode = 'orbit' | 'drone';

/**
 * Camera rig with two modes:
 *  - orbit: OrbitControls + authored flights that arc over the skyline
 *  - drone: free flight (WASD / QE / Shift, mouse-look via pointer lock or drag)
 */
export class CameraRig {
  mode: CamMode = 'orbit';
  private yaw = 0;
  private pitch = 0;
  private vel = new THREE.Vector3();
  private keys = new Set<string>();
  speed = 40;
  /** world hook: resolve collisions (push out of buildings, keep above ground) */
  collide: (p: THREE.Vector3) => void = (p) => {
    p.y = Math.max(p.y, 1.5);
  };
  onMode: (m: CamMode) => void = () => {};
  private tween: gsap.core.Tween | null = null;
  private dragging = false;
  minY = 1.5;
  /** direction long flights arc towards: up in the city, out of the graph plane in the core */
  liftAxis = new THREE.Vector3(0, 1, 0);

  constructor(
    private engine: Engine,
    private canvas: HTMLCanvasElement,
  ) {
    window.addEventListener('keydown', (e) => {
      if (this.mode !== 'drone' || this.typing(e)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', ' ', 'c'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (this.mode !== 'drone') return;
      if (document.pointerLockElement === canvas || this.dragging) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
        this.engine.touch();
      }
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (this.mode === 'drone' && e.button === 2) this.dragging = true;
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('contextmenu', (e) => this.mode === 'drone' && e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'drone') return;
        this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.85 : 1.18), 4, 600);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  private typing(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey;
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  setMode(m: CamMode) {
    if (m === this.mode) return;
    this.tween?.kill();
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    if (m === 'drone') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      ctl.enabled = false;
      this.engine.idleOrbit = false;
      ctl.autoRotate = false;
      this.vel.set(0, 0, 0);
      this.lock();
    } else {
      if (this.locked) document.exitPointerLock();
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      ctl.target.copy(cam.position).addScaledVector(dir, 40);
      ctl.enabled = true;
      this.engine.idleOrbit = true;
    }
    this.mode = m;
    this.keys.clear();
    this.onMode(m);
  }

  lock() {
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      /* not allowed without gesture: fall back to right-drag look */
    }
  }

  update(dt: number) {
    const cam = this.engine.camera;
    if (this.mode === 'orbit') {
      this.engine.controls.update(dt);
      if (cam.position.y < this.minY) cam.position.y = this.minY;
      return;
    }
    if (this.tween?.isActive()) return;
    const k = this.keys;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3();
    if (k.has('w')) want.add(fwd);
    if (k.has('s')) want.sub(fwd);
    if (k.has('d')) want.add(right);
    if (k.has('a')) want.sub(right);
    if (k.has('e') || k.has(' ')) want.y += 1;
    if (k.has('q') || k.has('c')) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * (k.has('shift') ? 4 : 1));
    this.vel.lerp(want, 1 - Math.exp(-dt * 6));
    cam.position.addScaledVector(this.vel, dt);
    this.collide(cam.position);
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw;
    cam.rotation.x = this.pitch;
    if (this.vel.lengthSq() > 1) this.engine.touch();
  }

  /** Smooth flight; long hops arc up over the skyline instead of cutting through it. */
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, duration = 2.2, ease = 'power3.inOut'): Promise<void> {
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    this.tween?.kill();
    gsap.killTweensOf(cam.position);
    gsap.killTweensOf(ctl.target);
    const p0 = cam.position.clone();
    const t0 = this.mode === 'orbit' ? ctl.target.clone() : p0.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
    const dist = p0.distanceTo(pos);
    const mid = p0.clone().lerp(pos, 0.5);
    const lift = Math.min(dist * 0.22, 160) * (dist > 60 ? 1 : 0);
    if (this.liftAxis.y > 0.9) mid.y = Math.max(p0.y, pos.y) + lift;
    else {
      // keep at least the endpoints' standoff from the subject plane, then bow outwards
      const along = Math.max(p0.dot(this.liftAxis), pos.dot(this.liftAxis));
      mid.addScaledVector(this.liftAxis, along - mid.dot(this.liftAxis) + lift * 0.6);
    }
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, pos.clone());
    const look = new THREE.Vector3();
    const o = { t: 0 };
    return new Promise((res) => {
      this.tween = gsap.to(o, {
        t: 1,
        duration,
        ease,
        onUpdate: () => {
          curve.getPoint(o.t, cam.position);
          look.copy(t0).lerp(target, o.t);
          if (this.mode === 'orbit') ctl.target.copy(look);
          else {
            cam.lookAt(look);
            const d = look.clone().sub(cam.position).normalize();
            this.yaw = Math.atan2(-d.x, -d.z);
            this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
          }
        },
        onComplete: () => res(),
        // superseded by a newer flight: settle anyway so awaiting callers never hang
        onInterrupt: () => res(),
      });
    });
  }

  stop() {
    this.tween?.kill();
  }

  get flying() {
    return !!this.tween?.isActive();
  }
}
