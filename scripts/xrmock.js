// Minimal WebXR device mock (XRWebGLLayer path, as three r171 uses it): a stereo headset rendering
// side by side into the canvas, plus two tracked-pointer controllers with xr-standard gamepads.
(() => {
  const FBW = 1600, FBH = 800;
  const state = { yaw: 0, pitch: 0, x: 0, y: 1.6, z: 0, ctlPitch: 0 };
  const mkPad = () => ({ axes: [0, 0, 0, 0], buttons: Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 })), mapping: 'xr-standard', connected: true, hapticActuators: [{ pulse: () => Promise.resolve(true) }] });
  const sources = ['left', 'right'].map((handedness) => ({ handedness, targetRayMode: 'tracked-pointer', targetRaySpace: { h: handedness, k: 'ray' }, gripSpace: { h: handedness, k: 'grip' }, gamepad: mkPad(), profiles: ['oculus-touch-v3'], hand: null }));

  // column-major 4x4 from yaw (Y) then pitch (X), plus translation
  function mat(yaw, pitch, px, py, pz) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Ry * Rx
    const r = [cy, 0, -sy, 0, sy * sp, cp, cy * sp, 0, sy * cp, -sp, cy * cp, 0];
    return new Float32Array([r[0], r[1], r[2], 0, r[4], r[5], r[6], 0, r[8], r[9], r[10], 0, px, py, pz, 1]);
  }
  function local(dx, dy, dz) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw), cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    // apply Rx then Ry
    const y1 = dy * cp - dz * sp, z1 = dy * sp + dz * cp;
    return [state.x + dx * cy + z1 * sy, state.y + y1, state.z - dx * sy + z1 * cy];
  }
  const xform = (m) => ({ matrix: m, position: { x: m[12], y: m[13], z: m[14], w: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, inverse: null });
  function proj(near, far) {
    const f = 1 / Math.tan((50 * Math.PI) / 180), a = FBW / 2 / FBH;
    return new Float32Array([f / a, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
  }

  class Session extends EventTarget {
    constructor(mode) {
      super();
      this.mode = mode;
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 };
      this.inputSources = sources;
      this.visibilityState = 'visible';
      this.environmentBlendMode = mode === 'immersive-ar' ? 'alpha-blend' : 'opaque';
      this.enabledFeatures = ['local-floor'];
      this.ended = false;
      setTimeout(() => {
        const e = new Event('inputsourceschange');
        e.added = sources;
        e.removed = [];
        this.dispatchEvent(e);
      }, 50);
    }
    updateRenderState(s) { Object.assign(this.renderState, s); }
    requestReferenceSpace() { return Promise.resolve({ ref: true }); }
    requestAnimationFrame(cb) {
      return window.requestAnimationFrame((t) => {
        if (this.ended) return;
        window.__xr.frames++;
        cb(t, new Frame(this));
      });
    }
    cancelAnimationFrame(id) { window.cancelAnimationFrame(id); }
    end() { this.ended = true; this.dispatchEvent(new Event('end')); return Promise.resolve(); }
  }
  class Frame {
    constructor(session) { this.session = session; }
    getViewerPose() {
      const rs = this.session.renderState;
      const views = ['left', 'right'].map((eye, i) => {
        const p = local(i ? 0.032 : -0.032, 0, 0);
        return { eye, projectionMatrix: proj(rs.depthNear, rs.depthFar), transform: xform(mat(state.yaw, state.pitch, ...p)) };
      });
      return { views, transform: xform(mat(state.yaw, state.pitch, state.x, state.y, state.z)), emulatedPosition: false };
    }
    getPose(space) {
      const right = space.h === 'right';
      const p = local(right ? 0.18 : -0.18, -0.25, -0.25);
      return { transform: xform(mat(state.yaw, state.pitch + state.ctlPitch, ...p)), emulatedPosition: false };
    }
  }
  class XRWebGLLayer {
    constructor(session, gl) { this.framebuffer = null; this.framebufferWidth = FBW; this.framebufferHeight = FBH; this.antialias = false; }
    getViewport(view) { return { x: view.eye === 'left' ? 0 : FBW / 2, y: 0, width: FBW / 2, height: FBH }; }
  }
  window.XRWebGLLayer = XRWebGLLayer;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = () => Promise.resolve();
  let current = null;
  const xr = {
    isSessionSupported: () => Promise.resolve(true),
    requestSession: (mode) => Promise.resolve((current = new Session(mode))),
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });

  const src = (h) => sources.find((s) => s.handedness === h);
  window.__xr = {
    state,
    frames: 0,
    get session() { return current; },
    stick(h, x, y) { const a = src(h).gamepad.axes; a[2] = x; a[3] = y; },
    button(h, i, on) { const b = src(h).gamepad.buttons[i]; b.pressed = on; b.value = on ? 1 : 0; },
    select(h) {
      for (const t of ['selectstart', 'select', 'selectend']) {
        const e = new Event(t);
        e.inputSource = src(h);
        e.frame = new Frame(current);
        current.dispatchEvent(e);
      }
    },
  };
})();
