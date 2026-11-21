import * as THREE from 'three';
import type { Model, Neighbour } from '../model';
import { globals, PALETTE } from '../shaders/common';
import { hex } from '../types';
import type { City } from './city';
import { LabelField, type LabelSpec } from './labels';
import { Ribbons, arcPoints, type RibbonSpec } from './ribbons';
import { NO_REFLECT_LAYER } from './callgraph';
import type { ImportRing } from './satellites';

const C_IN = new THREE.Color(0x10f4ff);
const C_OUT = new THREE.Color(0xff2bd6);
const C_IMP = new THREE.Color(0xffe14d);
const C_STR = new THREE.Color(0xe6fbff);
const C_REF = new THREE.Color(0xa070ff);

export interface FocusSite {
  tag: number;
  site: number;
  caller: number;
  callee: number;
  dir: 'in' | 'out';
  pos: THREE.Vector3;
}

/**
 * In-city call-graph inspection around one function: exact per-call-site arcs,
 * call-site rings on the towers, N-hop expansion, neighbour labels and the strings
 * the function references (threads run from each string to the instruction using it).
 */
export class FocusLayer {
  group = new THREE.Group();
  fi: number;
  depth: number;
  nb: Map<number, Neighbour>;
  sites: FocusSite[] = [];
  private bySite = new Map<number, FocusSite>();
  private arcs: Ribbons | null = null;
  private threads: Ribbons | null = null;
  private rings: THREE.InstancedMesh | null = null;
  private ringMat: THREE.ShaderMaterial | null = null;
  private labels: LabelField | null = null;
  private strLabels: LabelField | null = null;
  strings: { vaddr: number; text: string; sites: number[] }[] = [];

  constructor(model: Model, city: City, sats: ImportRing | null, fi: number, depth: number, side = new THREE.Vector3(-1, 0, 0)) {
    this.fi = fi;
    this.depth = depth;
    this.nb = model.neighbourhood(fi, depth, 500);
    const entry = (g: number): THREE.Vector3 | null => {
      const t = city.towerOfFn(g);
      if (t) return new THREE.Vector3(t.pos.x, t.height + 0.3, t.pos.z);
      return sats?.posOfFn(g)?.clone() ?? null;
    };
    const surface = (g: number, addr: number, toward: THREE.Vector3): THREE.Vector3 | null => {
      const t = city.towerOfFn(g);
      if (!t) return sats?.posOfFn(g)?.clone() ?? null;
      const p = city.floor(t, model.frac(g, addr));
      const d = new THREE.Vector3(toward.x - p.x, 0, toward.z - p.z);
      if (d.lengthSq() > 1e-6) p.add(d.normalize().multiplyScalar(t.width * 0.5 + 0.05));
      return p;
    };

    // ------------------------------------------------ arcs
    const specs: RibbonSpec[] = [];
    const addSite = (c: { site: number; caller: number; callee: number }, dir: 'in' | 'out') => {
      const b0 = entry(c.callee);
      const a0 = entry(c.caller);
      if (!a0 || !b0) return;
      const a = surface(c.caller, c.site, b0);
      if (!a) return;
      const tag = this.sites.length;
      const imp = model.fns[c.callee]?.imp;
      const col = dir === 'in' ? C_IN : imp ? C_IMP : C_OUT;
      const fs: FocusSite = { tag, site: c.site, caller: c.caller, callee: c.callee, dir, pos: a.clone() };
      this.sites.push(fs);
      if (!this.bySite.has(c.site)) this.bySite.set(c.site, fs);
      const self = c.caller === c.callee;
      specs.push({
        points: self ? loop(a, b0) : arcPoints(a, b0, 0.38, 28, 3),
        color0: col.clone().multiplyScalar(dir === 'in' ? 0.9 : 1.2),
        color1: col,
        width: 2.4,
        alpha: 0.75,
        flow: 22,
        tag,
      });
    };
    for (const c of model.out[fi]) addSite(c, 'out');
    for (const c of model.in[fi]) if (c.caller !== fi) addSite(c, 'in');

    // address-taken references (function pointers): violet arcs from the loading
    // instruction in the referrer to the target's roof, both directions
    for (const r of [...model.refIn[fi], ...model.refOut[fi]]) {
      const b = entry(r.to);
      const a = b ? surface(r.from, r.site, b) : null;
      if (!a || !b) continue;
      specs.push({ points: arcPoints(a, b, 0.3, 24, 3), color0: C_REF, color1: C_REF, width: 1.8, alpha: 0.6, flow: 8, tag: -20 });
    }

    // further hops: aggregated pair arcs inside the BFS tree
    if (depth > 1) {
      const seen = new Set<string>();
      for (const [g, n] of this.nb) {
        if (n.hop < 1) continue;
        const list = n.role === 'callee' || n.role === 'both' ? model.out[g] : [];
        const inl = n.role === 'caller' || n.role === 'both' ? model.in[g] : [];
        for (const c of [...list, ...inl]) {
          if (c.caller === fi || c.callee === fi || c.caller === c.callee) continue;
          const nc = this.nb.get(c.caller);
          const nd = this.nb.get(c.callee);
          if (!nc || !nd) continue;
          const k = `${c.caller}>${c.callee}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const b = entry(c.callee);
          const a = b ? surface(c.caller, c.site, b) : null;
          if (!a || !b) continue;
          const col = nd.role === 'caller' ? C_IN : C_OUT;
          specs.push({ points: arcPoints(a, b, 0.4, 20, 3), color0: col, color1: col, width: 1.4, alpha: 0.32, flow: 14, tag: -10 });
          if (seen.size > 2500) break;
        }
      }
    }
    this.arcs = new Ribbons(specs, { pulseSpacing: 26, renderOrder: 5 });
    this.group.add(this.arcs.mesh);

    // ------------------------------------------------ call-site rings
    const ringGeo = new THREE.TorusGeometry(1, 0.07, 6, 40);
    ringGeo.rotateX(Math.PI / 2);
    const aCol = new Float32Array(this.sites.length * 3);
    const aTag = new Float32Array(this.sites.length);
    this.ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uHi: { value: -1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aCol;
        attribute float aTag;
        uniform float uHi;
        uniform float uTime;
        varying vec3 vCol;
        varying float vHi;
        void main() {
          vHi = abs(aTag - uHi) < 0.5 ? 1.0 : 0.0;
          vCol = aCol;
          vec3 p = position * (1.0 + vHi * (0.6 + 0.2 * sin(uTime * 10.0)));
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vHi;
        void main() { gl_FragColor = vec4(mix(vCol, vec3(1.0), vHi * 0.5) * (1.6 + vHi * 3.0), 0.8); }`,
    });
    this.rings = new THREE.InstancedMesh(ringGeo, this.ringMat, Math.max(1, this.sites.length));
    const m = new THREE.Matrix4();
    this.sites.forEach((s, i) => {
      const t = city.towerOfFn(s.caller);
      const r = t ? t.width * 0.5 + 0.35 : 1.2;
      const p = t ? city.floor(t, model.frac(s.caller, s.site)) : s.pos;
      m.makeScale(r, r, r).setPosition(p);
      this.rings!.setMatrixAt(i, m);
      const c = s.dir === 'in' ? C_IN : model.fns[s.callee]?.imp ? C_IMP : C_OUT;
      aCol.set([c.r, c.g, c.b], i * 3);
      aTag[i] = s.tag;
    });
    ringGeo.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 3));
    ringGeo.setAttribute('aTag', new THREE.InstancedBufferAttribute(aTag, 1));
    this.rings.count = this.sites.length;
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.frustumCulled = false;
    this.group.add(this.rings);

    // ------------------------------------------------ labels for neighbours
    const lab: LabelSpec[] = [];
    const ft = city.towerOfFn(fi);
    for (const [g, n] of this.nb) {
      const t = city.towerOfFn(g);
      if (!t) continue;
      if (g !== fi && n.hop > 1 && this.nb.size > 120) continue;
      const col = g === fi ? PALETTE.yellow : n.role === 'caller' ? C_IN : n.role === 'callee' ? C_OUT : PALETTE.ice;
      lab.push({
        text: (g === fi ? '◆ ' : n.role === 'caller' ? '▲ ' : n.role === 'callee' ? '▼ ' : '◇ ') + model.fns[g].name.replace(/^sym\./, ''),
        color: col,
        position: new THREE.Vector3(t.pos.x, t.height + (g === fi ? 4.5 : 2.6), t.pos.z),
        size: g === fi ? 2.6 : 1.5,
      });
      if (lab.length > 220) break;
    }
    this.labels = new LabelField(lab, { fadeFar: 700, fadeNear: 3, px: 34, shrink: 120, depthTest: false, floor: 0.95 });
    this.labels.material.uniforms.uOpacity.value = 1;
    this.labels.mesh.renderOrder = 20;
    this.group.add(this.labels.mesh);

    // ------------------------------------------------ data column: referenced strings
    if (ft) {
      const byStr = new Map<number, number[]>();
      for (const r of model.strOut[fi]) (byStr.get(r.vaddr) ?? byStr.set(r.vaddr, []).get(r.vaddr)!).push(r.site);
      this.strings = [...byStr.entries()]
        .map(([vaddr, sites]) => ({ vaddr, sites, text: model.strings.get(vaddr)?.string ?? hex(vaddr) }))
        .sort((a, b) => a.sites[0] - b.sites[0])
        .slice(0, 28);
      if (this.strings.length) {
        // the column stands beside the tower on the side away from the Inspector (screen-left)
        const sd = side.clone().setY(0).normalize();
        const colBase = new THREE.Vector3(ft.pos.x, 0, ft.pos.z).addScaledVector(sd, ft.width / 2 + 18);
        const top = Math.max(ft.height + 6, this.strings.length * 2.4 + 4);
        const specsS: LabelSpec[] = [];
        const threads: RibbonSpec[] = [];
        this.strings.forEach((s, i) => {
          const y = top - i * 2.4;
          const txt = '"' + s.text.replace(/\s+/g, ' ').slice(0, 48) + (s.text.length > 48 ? '…' : '') + '"';
          const pos = colBase.clone().setY(y);
          specsS.push({ text: txt, color: C_STR, position: pos, size: 1.25 });
          for (const site of s.sites.slice(0, 4)) {
            const a = city.floor(ft, model.frac(fi, site)).addScaledVector(sd, ft.width / 2 + 0.05);
            const start = pos.clone().addScaledVector(sd, -1);
            const mid = a.clone().lerp(start, 0.5).add(new THREE.Vector3(0, 1, 0));
            threads.push({
              points: new THREE.QuadraticBezierCurve3(start, mid, a).getPoints(14),
              color0: C_STR,
              color1: PALETTE.yellow,
              width: 1.4,
              alpha: 0.6,
              flow: 10,
              tag: 1e6 + i,
            });
          }
        });
        this.strLabels = new LabelField(specsS, { fadeFar: 500, fadeNear: 2, px: 30, shrink: 90, floor: 1, depthTest: false });
        this.strLabels.mesh.renderOrder = 21;
        this.strLabels.material.uniforms.uOpacity.value = 0.95;
        this.threads = new Ribbons(threads, { pulseSpacing: 8, renderOrder: 6 });
        this.group.add(this.strLabels.mesh, this.threads.mesh);
      }
    }
  }

  /** keep the heavy translucent stuff out of the ground reflection pass */
  finalize() {
    this.group.traverse((o) => o.layers.set(NO_REFLECT_LAYER));
  }

  /** Light up one call site (e.g. hovered in the Inspector). Returns its world position. */
  highlightSite(addr: number | null): THREE.Vector3 | null {
    const s = addr === null ? undefined : this.bySite.get(addr);
    const tag = s ? s.tag : -1;
    this.arcs?.highlight(tag);
    if (this.ringMat) this.ringMat.uniforms.uHi.value = tag;
    return s?.pos ?? null;
  }

  siteAt(addr: number) {
    return this.bySite.get(addr) ?? null;
  }

  dispose() {
    this.arcs?.dispose();
    this.threads?.dispose();
    this.rings?.geometry.dispose();
    this.ringMat?.dispose();
    this.labels?.dispose();
    this.strLabels?.dispose();
  }
}

/** Self-call: a small loop above the tower. */
function loop(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] {
  const c1 = a.clone().add(new THREE.Vector3(6, 4, 0));
  const c2 = b.clone().add(new THREE.Vector3(6, 6, 0));
  return new THREE.CubicBezierCurve3(a.clone(), c1, c2, b.clone()).getPoints(20);
}
