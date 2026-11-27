import * as THREE from 'three';
import gsap from 'gsap';
import type { Engine } from './engine';

export type CamMode = 'orbit' | 'drone' | 'walk';

const WALK_LOOK_SPEED = 0.0068;
const DRONE_LOOK_SPEED = 0.0022;
const WALK_SPEED = 6;
const SPRINT_SPEED = 16;
const JUMP_SPEED = 8.9;
const JUMP_GRAVITY = 29;

/**
 * Camera rig:
 *  - orbit: OrbitControls + authored flights that arc over the skyline
 *  - drone: free flight (WASD / QE / Shift, mouse-look via pointer lock or drag)
 *  - walk: first-person ground movement and wall collisions
 */
export class CameraRig {
  mode: CamMode = 'orbit';
  private yaw = 0;
  private pitch = 0;
  private vel = new THREE.Vector3();
  private keys = new Set<string>();
  private jumpSpeed = 0;
  private jump = 0;
  private jumpQueued = false;
  walkFloor = 1.55;
  walkBlocked = false;
  private floating = false;

  get zeroGravity() { return this.floating; }

  set zeroGravity(active: boolean) {
    if (active === this.floating) return;
    this.floating = active;
    this.jump = this.jumpSpeed = 0;
    this.jumpQueued = false;
    this.vel.y = 0;
  }
  walkCollision: (p: THREE.Vector3, from: THREE.Vector3) => void = () => {};
  walkHeading: (eye: THREE.Vector3, direction: 1 | -1) => THREE.Vector3 | undefined = () => undefined;
  corridorSpeed: () => number | undefined = () => undefined;
  speed = 40;
  /** world hook: resolve collisions (push out of buildings, keep above ground) */
  collide: (p: THREE.Vector3) => void = (p) => {
    p.y = Math.max(p.y, 1.5);
  };
  onMode: (m: CamMode) => void = () => {};
  /** a flight is starting (the WebXR layer re-aims the headset towards `target`) */
  onFlight: (pos: THREE.Vector3, target: THREE.Vector3) => void = () => {};
  private tween: gsap.core.Tween | null = null;
  private inFlight = false;
  private flight: object | null = null;
  private dragging = false;
  private lastMouse: { x: number; y: number } | null = null;
  private lastMouseLook = -Infinity;
  private lockingPointer = false;
  private corridorActive = false;
  private corridorFacing: 1 | -1 = 1;
  private corridorYawOffset = 0;
  minY = 1.5;
  /** direction long flights arc towards: up in the city, out of the graph plane in the core */
  liftAxis = new THREE.Vector3(0, 1, 0);

  constructor(
    private engine: Engine,
    private canvas: HTMLCanvasElement,
  ) {
    window.addEventListener('keydown', (e) => {
      if (this.mode === 'orbit' || this.typing(e) || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (this.mode === 'walk' && k === ' ') {
        if (this.corridorSpeed() === undefined) {
          if (this.floating) this.keys.add(' ');
          else if (!e.repeat && !this.walkBlocked) this.jumpQueued = true;
        }
        e.preventDefault();
        return;
      }
      if (this.mode === 'walk' && !this.walkBlocked && !e.repeat && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown'].includes(k)) this.lock();
      if (this.mode === 'walk' && (k === 'arrowup' || k === 'arrowdown' || (e.shiftKey && (k === 'arrowleft' || k === 'arrowright')))) {
        this.keys.add(k);
        e.preventDefault();
        return;
      }
      if (this.mode === 'walk' && !['w', 'a', 's', 'd', 'shift'].includes(k) && !(this.floating && k === 'q')) return;
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', ' ', 'c'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.lastMouse = null;
      this.dragging = false;
    });
    window.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) this.lastMouse = null;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.mode === 'orbit' || this.walkBlocked || this.flying) return;
      let dx = e.movementX;
      let dy = e.movementY;
      if (!this.locked) {
        if (this.mode === 'drone' && e.target !== canvas && !this.dragging) {
          this.lastMouse = null;
          return;
        }
        dx = this.lastMouse ? e.clientX - this.lastMouse.x : e.movementX;
        dy = this.lastMouse ? e.clientY - this.lastMouse.y : e.movementY;
        this.lastMouse = { x: e.clientX, y: e.clientY };
      }
      if (dx || dy) this.lastMouseLook = performance.now();
      const sensitivity = this.mode === 'walk' ? WALK_LOOK_SPEED : DRONE_LOOK_SPEED;
      const turn = -dx * sensitivity;
      this.yaw += turn;
      if (this.corridorActive) {
        this.corridorYawOffset += turn;
        if (Math.abs(this.corridorYawOffset) > Math.PI * 0.63) {
          this.corridorYawOffset -= Math.sign(this.corridorYawOffset) * Math.PI;
          this.corridorFacing = this.corridorFacing === 1 ? -1 : 1;
        }
      }
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sensitivity, -1.45, 1.45);
      this.engine.touch();
    }, true);
    document.addEventListener('pointerlockchange', () => {
      this.lockingPointer = false;
      this.lastMouse = null;
      if (this.mode === 'orbit' && this.locked) document.exitPointerLock();
      this.canvas.classList.toggle('walk-pointer', this.mode === 'walk' && this.locked);
    });
    document.addEventListener('pointerlockerror', () => { this.lockingPointer = false; });
    canvas.addEventListener('pointerdown', (e) => {
      if (this.mode === 'walk' && !this.walkBlocked && e.button === 0) this.lock();
      if (this.mode === 'drone' && e.button === 2) {
        this.dragging = true;
        this.lastMouse = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('contextmenu', (e) => this.mode !== 'orbit' && e.preventDefault());
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
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || e.ctrlKey || e.metaKey || e.altKey;
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  get walkDirection() {
    const forward = this.keys.has('w') || this.keys.has('arrowup');
    const backward = this.keys.has('s') || this.keys.has('arrowdown');
    return (Number(forward) - Number(backward)) * this.corridorFacing;
  }

  setMode(m: CamMode, lock = true) {
    if (m === this.mode) return;
    this.stop();
    const cam = this.engine.camera;
    const ctl = this.engine.controls;
    if (m !== 'orbit') {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      ctl.enabled = false;
      this.engine.idleOrbit = false;
      ctl.autoRotate = false;
      this.resetMotion();
      if (lock && !this.locked) this.lock();
    } else {
      if (this.locked) document.exitPointerLock();
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      ctl.target.copy(cam.position).addScaledVector(dir, 40);
      ctl.enabled = true;
      this.engine.idleOrbit = true;
    }
    this.mode = m;
    this.canvas.classList.toggle('walk-pointer', m === 'walk' && this.locked);
    cam.near = m === 'walk' ? 0.08 : 0.5;
    cam.updateProjectionMatrix();
    this.keys.clear();
    this.onMode(m);
  }

  resetMotion() {
    this.keys.clear();
    this.vel.set(0, 0, 0);
    this.jump = this.jumpSpeed = 0;
    this.jumpQueued = false;
    this.lastMouse = null;
  }

  place(pos: THREE.Vector3, target: THREE.Vector3) {
    this.stop();
    this.resetMotion();
    const cam = this.engine.camera;
    cam.position.copy(pos);
    cam.lookAt(target);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    if (this.mode === 'orbit') this.engine.controls.target.copy(target);
  }

  lock() {
    if (!this.canvas.requestPointerLock || this.locked || this.lockingPointer) return;
    this.lockingPointer = true;
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => { this.lockingPointer = false; });
    } catch {
      this.lockingPointer = false;
    }
  }

  update(dt: number) {
    const cam = this.engine.camera;
    if (this.mode === 'orbit') {
      this.engine.controls.update(dt);
      if (cam.position.y < this.minY) cam.position.y = this.minY;
      return;
    }
    if (this.flying) return;
    if (this.mode === 'walk' && this.walkBlocked) return;
    const k = this.keys;
    const walking = this.mode === 'walk';
    const sprint = k.has('shift');
    const corridorSpeed = walking ? this.corridorSpeed() : undefined;
    const corridor = corridorSpeed !== undefined;
    if (corridor && !this.corridorActive) {
      const heading = this.walkHeading(cam.position, 1);
      const alignment = heading ? -Math.sin(this.yaw) * heading.x - Math.cos(this.yaw) * heading.z : 0;
      this.corridorFacing = alignment < 0 ? -1 : 1;
      this.corridorYawOffset = 0;
    }
    this.corridorActive = corridor;
    const forward = k.has('w') || (walking && k.has('arrowup'));
    const backward = k.has('s') || (walking && k.has('arrowdown'));
    const input = forward ? 1 : -1;
    const direction = input === this.corridorFacing ? 1 : -1;
    const heading = corridor && forward !== backward ? this.walkHeading(cam.position, direction) : undefined;
    if (heading && performance.now() - this.lastMouseLook > 380) {
      const yaw = Math.atan2(-heading.x * input, -heading.z * input);
      const turn = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
      const damping = Math.exp(-dt * (sprint ? 13 : 8));
      this.yaw += turn * (1 - damping);
      this.corridorYawOffset *= damping;
      const pitch = Math.asin(THREE.MathUtils.clamp(heading.y * input, -0.36, 0.36));
      this.pitch = THREE.MathUtils.damp(this.pitch, pitch, 4, dt);
    }
    const tilt = walking && !this.floating ? 0 : this.pitch;
    const fwd = heading ? heading.setY(0).normalize().multiplyScalar(input)
      : new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(this.yaw) * Math.cos(tilt));
    const right = heading ? new THREE.Vector3(-fwd.z, 0, fwd.x) : new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3();
    if (forward) want.add(fwd);
    if (backward) want.sub(fwd);
    if (k.has('d') || (walking && sprint && k.has('arrowright'))) want.add(right);
    if (k.has('a') || (walking && sprint && k.has('arrowleft'))) want.sub(right);
    if (!walking) {
      if (k.has('e') || k.has(' ')) want.y += 1;
      if (k.has('q') || k.has('c')) want.y -= 1;
    } else if (this.floating) {
      if (k.has(' ')) want.y += 1;
      if (k.has('q')) want.y -= 1;
    }
    if (want.lengthSq() > 0) {
      const speed = walking ? (sprint ? SPRINT_SPEED : WALK_SPEED) * (corridorSpeed ?? 1) : this.speed * (sprint ? 4 : 1);
      want.normalize().multiplyScalar(speed);
    }
    this.vel.lerp(want, 1 - Math.exp(-dt * (walking ? 17 : 6)));
    if (walking) {
      if (corridor) {
        this.jump = this.jumpSpeed = 0;
        this.jumpQueued = false;
        cam.position.y = this.walkFloor;
      } else if (!this.floating) {
        if (this.jumpQueued && this.jump === 0) this.jumpSpeed = JUMP_SPEED;
        this.jumpQueued = false;
        this.jump = Math.max(0, this.jump + (this.jumpSpeed - JUMP_GRAVITY * dt / 2) * dt);
        this.jumpSpeed = this.jump > 0 ? this.jumpSpeed - JUMP_GRAVITY * dt : 0;
        cam.position.y = this.walkFloor + this.jump;
      }
      const steps = Math.max(1, Math.ceil(this.vel.length() * dt / 0.13));
      const from = new THREE.Vector3();
      const velocity = this.vel.clone();
      const longitudinal = velocity.dot(fwd) * input;
      const lateral = velocity.dot(right) * input;
      for (let i = 0; i < steps && !this.walkBlocked; i++) {
        from.copy(cam.position);
        if (heading) {
          const tangent = this.walkHeading(from, direction)?.setY(0).normalize();
          if (tangent) velocity.set(tangent.x * longitudinal - tangent.z * lateral, 0, tangent.z * longitudinal + tangent.x * lateral);
        }
        cam.position.addScaledVector(velocity, dt / steps);
        this.walkCollision(cam.position, from);
      }
      this.vel.copy(velocity);
    } else {
      cam.position.addScaledVector(this.vel, dt);
      this.collide(cam.position);
    }
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
    this.onFlight(pos, target);
    const look = new THREE.Vector3();
    const o = { t: 0 };
    const token = {};
    this.flight = token;
    this.inFlight = true;
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
        onComplete: () => {
          if (this.flight === token) this.inFlight = false;
          res();
        },
        // superseded by a newer flight: settle anyway so awaiting callers never hang
        onInterrupt: () => {
          if (this.flight === token) this.inFlight = false;
          res();
        },
      });
    });
  }

  stop() {
    this.tween?.kill();
    this.tween = null;
    this.flight = null;
    this.inFlight = false;
  }

  /** true from flyTo() on, not just once the tween has ticked (it may be started mid-frame) */
  get flying() {
    return this.inFlight;
  }
}
