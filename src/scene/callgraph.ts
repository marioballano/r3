import * as THREE from 'three';
import type { Model } from '../model';
import { globals } from '../shaders/common';

export interface NodeGeom {
  /** world position of an address inside a function (its "floor"), or null if not placed */
  site(fi: number, addr: number): THREE.Vector3 | null;
  /** where calls into a function land (its entry / roof) */
  entry(fi: number): THREE.Vector3 | null;
  color(fi: number): THREE.Color;
}

const CALLER_COL = new THREE.Color(0x13d9ff);
const CALLEE_COL = new THREE.Color(0xff2bd6);
const IMPORT_COL = new THREE.Color(0xffc23a);

/** Render layer for heavy translucent geometry that the ground reflection should skip. */
export const NO_REFLECT_LAYER = 2;

/**
 * The ambient global call graph: one arc per distinct caller→callee pair, leaving the
 * caller at the median height of its real call sites and landing on the callee's roof.
 * Rendered as cheap 1px GL lines with travelling pulses (fat ribbons are reserved for
 * the subgraph being inspected).
 */
export class CityArcs {
  mesh: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  pairs: { caller: number; callee: number; sites: number[] }[] = [];

  constructor(model: Model, geom: NodeGeom, max = 30000) {
    const byPair = new Map<string, { caller: number; callee: number; sites: number[] }>();
    for (const list of model.out) {
      for (const c of list) {
        if (c.caller === c.callee) continue;
        const k = `${c.caller}>${c.callee}`;
        const p = byPair.get(k) ?? byPair.set(k, { caller: c.caller, callee: c.callee, sites: [] }).get(k)!;
        p.sites.push(c.site);
      }
    }
    this.pairs = [...byPair.values()].slice(0, max);
    const SEG = this.pairs.length > 6000 ? 12 : 18;
    const nv = this.pairs.length * SEG * 2;
    const pos = new Float32Array(nv * 3);
    const t = new Float32Array(nv);
    const col = new Float32Array(nv * 3);
    const seed = new Float32Array(nv);
    const ca = new THREE.Color();
    const p = new THREE.Vector3();
    let v = 0;
    for (const pr of this.pairs) {
      const med = pr.sites[Math.floor(pr.sites.length / 2)];
      const a = geom.site(pr.caller, med);
      const b = geom.entry(pr.callee);
      if (!a || !b) continue;
      const d = a.distanceTo(b);
      const c = a.clone().add(b).multiplyScalar(0.5);
      c.y = Math.max(a.y, b.y) + 6 + d * 0.42;
      const curve = new THREE.QuadraticBezierCurve3(a, c, b);
      // direction-coded: leaves the caller cyan, arrives at the callee magenta
      const c0 = CALLER_COL;
      const c1 = model.fns[pr.callee]?.imp ? IMPORT_COL : CALLEE_COL;
      const s = Math.random();
      const w = Math.min(1, 0.45 + Math.log2(1 + pr.sites.length) * 0.25);
      for (let i = 0; i < SEG; i++) {
        for (const k of [i, i + 1]) {
          const u = k / SEG;
          curve.getPoint(u, p);
          pos.set([p.x, p.y, p.z], v * 3);
          t[v] = u;
          ca.copy(c0).lerp(c1, u).multiplyScalar(w);
          col.set([ca.r, ca.g, ca.b], v * 3);
          seed[v] = s;
          v++;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(t.subarray(0, v), 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed.subarray(0, v), 1));
    const dense = this.pairs.length > 3000;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uBase: { value: dense ? 0.035 : 0.07 }, uDim: { value: 0 }, uReveal: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute vec3 aColor;
        attribute float aSeed;
        varying float vT;
        varying vec3 vColor;
        varying float vSeed;
        varying float vDist;
        void main() {
          vT = aT; vColor = aColor; vSeed = aSeed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uBase;
        uniform float uDim;
        uniform float uReveal;
        uniform float uFogDensity;
        varying float vT;
        varying vec3 vColor;
        varying float vSeed;
        varying float vDist;
        void main() {
          if (vT > uReveal * (0.6 + vSeed * 0.4) * 1.7) discard;
          float ph = fract(vT - uTime * (0.22 + vSeed * 0.3) + vSeed * 10.0);
          float pulse = smoothstep(0.9, 1.0, ph);
          float a = (uBase + pulse * 0.5) * mix(1.0, 0.08, uDim);
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 0.5);
          gl_FragColor = vec4(vColor * (0.9 + pulse * 2.2), a * fog);
        }`,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(NO_REFLECT_LAYER);
  }

  setDim(v: number) {
    this.material.uniforms.uDim.value = v;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
