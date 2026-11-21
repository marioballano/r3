import * as THREE from 'three';
import { globals } from '../shaders/common';

export interface RibbonSpec {
  points: THREE.Vector3[];
  color0: THREE.Color;
  color1: THREE.Color;
  /** width in CSS pixels */
  width: number;
  alpha: number;
  /** pulse speed in world units per second along the curve (0 = none, direction start→end) */
  flow: number;
  /** id used for hover highlighting */
  tag: number;
  /** optional endpoint ids: the ribbon also highlights when either end is the hovered node */
  ends?: [number, number];
}

/**
 * Screen-space "fat" polylines rendered as instanced segments. Every segment knows
 * its arc-length so pulses travel at a constant world-space speed from the start of
 * the curve to its end (i.e. caller → callee). Near-plane crossing segments are clipped.
 */
export class Ribbons {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  readonly count: number;
  private geo: THREE.InstancedBufferGeometry;

  constructor(specs: RibbonSpec[], opts: { pulseSpacing?: number; depthTest?: boolean; renderOrder?: number; glow?: number } = {}) {
    let n = 0;
    for (const s of specs) n += Math.max(0, s.points.length - 1);
    this.count = n;
    const A = new Float32Array(n * 3);
    const B = new Float32Array(n * 3);
    const T = new Float32Array(n * 2);
    const C0 = new Float32Array(n * 3);
    const C1 = new Float32Array(n * 3);
    const P = new Float32Array(n * 4);
    const Q = new Float32Array(n * 2);
    const E = new Float32Array(n * 2).fill(-1);
    let k = 0;
    const phaseOf = (tag: number) => ((tag * 0.6180339) % 1 + 1) % 1;
    for (const s of specs) {
      const pts = s.points;
      if (pts.length < 2) continue;
      let total = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push((total += pts[i].distanceTo(pts[i - 1])));
      for (let i = 0; i < pts.length - 1; i++) {
        A.set([pts[i].x, pts[i].y, pts[i].z], k * 3);
        B.set([pts[i + 1].x, pts[i + 1].y, pts[i + 1].z], k * 3);
        T.set([cum[i], cum[i + 1]], k * 2);
        C0.set([s.color0.r, s.color0.g, s.color0.b], k * 3);
        C1.set([s.color1.r, s.color1.g, s.color1.b], k * 3);
        P.set([s.width, s.alpha, s.flow, phaseOf(s.tag)], k * 4);
        Q.set([Math.max(total, 1e-3), s.tag], k * 2);
        if (s.ends) E.set(s.ends, k * 2);
        k++;
      }
    }
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 3));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 3));
    geo.setAttribute('aT', new THREE.InstancedBufferAttribute(T, 2));
    geo.setAttribute('aC0', new THREE.InstancedBufferAttribute(C0, 3));
    geo.setAttribute('aC1', new THREE.InstancedBufferAttribute(C1, 3));
    geo.setAttribute('aP', new THREE.InstancedBufferAttribute(P, 4));
    geo.setAttribute('aQ', new THREE.InstancedBufferAttribute(Q, 2));
    geo.setAttribute('aE', new THREE.InstancedBufferAttribute(E, 2));
    geo.instanceCount = n;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...globals,
        uRes: globals.uRes, // shared: the engine keeps it in step with the window / XR
        uSpacing: { value: opts.pulseSpacing ?? 28 },
        uHi: { value: -1 },
        uNode: { value: -1 },
        uDim: { value: 0 },
        uOpacity: { value: 1 },
        uReveal: { value: 1e9 },
        uGlow: { value: opts.glow ?? 1 },
      },
      vertexShader: /* glsl */ `
        uniform vec2 uRes;
        uniform float uHi;
        uniform float uNode;
        attribute vec2 aE;
        attribute vec3 aA;
        attribute vec3 aB;
        attribute vec2 aT;
        attribute vec3 aC0;
        attribute vec3 aC1;
        attribute vec4 aP;
        attribute vec2 aQ;
        varying float vS;
        varying float vAcross;
        varying vec3 vCol;
        varying vec4 vP;
        varying float vLen;
        varying float vHi;
        varying float vDist;
        void main() {
          mat4 pv = projectionMatrix * viewMatrix;
          vec4 ca = pv * vec4(aA, 1.0);
          vec4 cb = pv * vec4(aB, 1.0);
          float near = 0.05;
          if (ca.w < near && cb.w < near) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float ta = aT.x, tb = aT.y;
          if (ca.w < near) { float f = (near - ca.w) / (cb.w - ca.w); ca = mix(ca, cb, f); ta = mix(ta, tb, f); }
          if (cb.w < near) { float f = (near - cb.w) / (ca.w - cb.w); cb = mix(cb, ca, f); tb = mix(tb, ta, f); }
          vec2 sa = ca.xy / ca.w * uRes;
          vec2 sb = cb.xy / cb.w * uRes;
          vec2 d = sb - sa;
          float L = length(d);
          vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          float hi = (abs(aQ.y - uHi) < 0.5 || (uNode >= 0.0 && (abs(aE.x - uNode) < 0.5 || abs(aE.y - uNode) < 0.5))) ? 1.0 : 0.0;
          float w = aP.x * (1.0 + hi * 1.2);
          vec4 c = mix(ca, cb, position.x);
          // extend slightly along the segment so consecutive segments overlap (no gaps at joints)
          c.xy += dir * (position.x * 2.0 - 1.0) * 0.5 * w / uRes * c.w;
          c.xy += nrm * position.y * w / uRes * c.w;
          gl_Position = c;
          vS = mix(ta, tb, position.x);
          vAcross = position.y;
          vCol = mix(aC0, aC1, clamp(vS / aQ.x, 0.0, 1.0));
          vP = aP;
          vLen = aQ.x;
          vHi = hi;
          vDist = c.w / length(viewMatrix[0].xyz); // world units, also under a scaled XR rig
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uSpacing;
        uniform float uDim;
        uniform float uOpacity;
        uniform float uReveal;
        uniform float uGlow;
        uniform float uFogDensity;
        varying float vS;
        varying float vAcross;
        varying vec3 vCol;
        varying vec4 vP;
        varying float vLen;
        varying float vHi;
        varying float vDist;
        void main() {
          if (vS > uReveal) discard;
          float a = abs(vAcross);
          float edge = 1.0 - smoothstep(0.35, 1.0, a);
          float core = 1.0 - smoothstep(0.0, 0.4, a);
          float pulse = 0.0;
          if (vP.z != 0.0) {
            float ph = fract(vS / uSpacing - uTime * vP.z / uSpacing + vP.w);
            pulse = smoothstep(0.82, 0.98, ph) * (1.0 - smoothstep(0.98, 1.0, ph));
          }
          float alpha = vP.y * edge * (1.0 + pulse * 1.5 + vHi * 1.5);
          alpha *= mix(1.0, 0.12, uDim * (1.0 - vHi));
          vec3 col = vCol * (0.9 + core * 0.9 + pulse * 3.0 + vHi * 1.5) * uGlow;
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 0.45);
          gl_FragColor = vec4(col, clamp(alpha * uOpacity * fog, 0.0, 1.0));
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    if (opts.renderOrder !== undefined) this.mesh.renderOrder = opts.renderOrder;
  }

  highlight(tag: number) {
    this.material.uniforms.uHi.value = tag;
  }

  highlightNode(id: number) {
    this.material.uniforms.uNode.value = id;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** Quadratic arc between two points, lifted proportionally to their distance. */
export function arcPoints(a: THREE.Vector3, b: THREE.Vector3, lift = 0.45, segs = 24, minLift = 6): THREE.Vector3[] {
  const d = a.distanceTo(b);
  const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  c.y = Math.max(a.y, b.y) + minLift + d * lift;
  const curve = new THREE.QuadraticBezierCurve3(a.clone(), c, b.clone());
  return curve.getPoints(segs);
}
