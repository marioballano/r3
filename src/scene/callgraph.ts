import * as THREE from 'three';
import { globals } from '../shaders/common';

/**
 * Call graph as luminous bezier arcs. Each arc is a polyline with a per-vertex
 * parameter t (0 caller -> 1 callee); the shader runs energy pulses along it.
 */
export class CallArcs {
  mesh: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  edges: [number, number][];

  constructor(edges: [number, number][], nodePos: (fnIndex: number) => THREE.Vector3 | null, colorOf: (fnIndex: number) => THREE.Color, maxEdges = 12000) {
    const SEG = 18;
    const kept: [number, number][] = [];
    for (const e of edges) {
      if (kept.length >= maxEdges) break;
      if (nodePos(e[0]) && nodePos(e[1])) kept.push(e);
    }
    this.edges = kept;
    const nv = kept.length * SEG * 2;
    const pos = new Float32Array(nv * 3);
    const t = new Float32Array(nv);
    const col = new Float32Array(nv * 3);
    const ends = new Float32Array(nv * 2);
    const seed = new Float32Array(nv);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const curve = new THREE.QuadraticBezierCurve3(a, c, b);
    const ca = new THREE.Color();
    let v = 0;
    kept.forEach(([from, to]) => {
      a.copy(nodePos(from)!);
      b.copy(nodePos(to)!);
      const d = a.distanceTo(b);
      c.addVectors(a, b).multiplyScalar(0.5);
      c.y = Math.max(a.y, b.y) + 6 + d * 0.45;
      const s = Math.random();
      const c0 = colorOf(from);
      const c1 = colorOf(to);
      for (let i = 0; i < SEG; i++) {
        for (const k of [i, i + 1]) {
          const u = k / SEG;
          curve.getPoint(u, p);
          pos.set([p.x, p.y, p.z], v * 3);
          t[v] = u;
          ca.copy(c0).lerp(c1, u);
          col.set([ca.r, ca.g, ca.b], v * 3);
          ends[v * 2] = from;
          ends[v * 2 + 1] = to;
          seed[v] = s;
          v++;
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aEnds', new THREE.BufferAttribute(ends, 2));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uSel: { value: -1 }, uBase: { value: Math.min(0.08, 0.08 * Math.sqrt(1500 / Math.max(1, kept.length))) }, uReveal: { value: 0 }, uFlow: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute vec3 aColor;
        attribute vec2 aEnds;
        attribute float aSeed;
        uniform float uSel;
        varying float vT;
        varying vec3 vColor;
        varying float vSeed;
        varying float vRole;
        varying float vDist;
        void main() {
          vT = aT;
          vColor = aColor;
          vSeed = aSeed;
          vRole = uSel < 0.0 ? 0.0 : (abs(aEnds.x - uSel) < 0.5 ? 1.0 : (abs(aEnds.y - uSel) < 0.5 ? 2.0 : -1.0));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uBase;
        uniform float uReveal;
        uniform float uFlow;
        uniform float uFogDensity;
        varying float vT;
        varying vec3 vColor;
        varying float vSeed;
        varying float vRole;
        varying float vDist;
        void main() {
          if (vT > uReveal + vSeed * 0.0001) discard;
          float ph = fract(vT * 1.0 - uTime * (0.25 + vSeed * 0.35) * uFlow + vSeed * 10.0);
          float pulse = smoothstep(0.92, 1.0, ph) * 1.0;
          vec3 c = vColor;
          float a = uBase + pulse * 0.6;
          if (vRole > 0.5) {
            c = vRole < 1.5 ? vec3(1.0, 0.25, 0.9) : vec3(0.1, 0.95, 1.0);
            a = 0.55 + pulse * 2.5;
          } else if (vRole < -0.5) {
            a *= 0.12;
          }
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 0.5);
          gl_FragColor = vec4(c * (1.2 + pulse * 2.0), a * fog);
        }`,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  select(fnIndex: number) {
    this.material.uniforms.uSel.value = fnIndex;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
