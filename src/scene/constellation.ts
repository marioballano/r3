import * as THREE from 'three';
import gsap from 'gsap';
import type { Model, Role } from '../model';
import { FOG_PARS, globals, heat, PALETTE } from '../shaders/common';
import { LabelField, type LabelSpec } from './labels';
import { Ribbons, type RibbonSpec } from './ribbons';

const C_FOCUS = new THREE.Color(0xfff200);
const C_CALLER = new THREE.Color(0x10f4ff);
const C_CALLEE = new THREE.Color(0xff2bd6);
const C_IMPORT = new THREE.Color(0xffb02e);
const C_BOTH = new THREE.Color(0xe8e6ff);

export interface CNode {
  fi: number;
  role: Role | 'import';
  hop: number;
  pos: THREE.Vector3;
  radius: number;
  color: THREE.Color;
}

const RING_CAP = [0, 36, 48];

/**
 * Call-graph constellation centred on one function: callers orbit above, callees
 * below, imports on their own ring, second-hop neighbours further out. Clicking a
 * node re-centres the whole graph on it (nodes that persist glide to their new place).
 */
export class Constellation {
  group = new THREE.Group();
  nodes: CNode[] = [];
  fi = -1;
  private mesh: THREE.InstancedMesh | null = null;
  private mat: THREE.ShaderMaterial;
  private edges: Ribbons | null = null;
  private labels: LabelField | null = null;
  private more: LabelField | null = null;
  private rings = new THREE.Group();
  private hovered = -1;
  private anim: gsap.core.Tween | null = null;

  constructor(private model: Model) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...globals, uHover: { value: -1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aCol;
        attribute float aFocus;
        uniform float uHover;
        uniform float uTime;
        varying vec3 vN;
        varying vec3 vW;
        varying vec3 vCol;
        varying float vHi;
        varying float vFocus;
        varying float vDist;
        void main() {
          vHi = abs(float(gl_InstanceID) - uHover) < 0.5 ? 1.0 : 0.0;
          vFocus = aFocus;
          vCol = aCol;
          vec3 p = position * (1.0 + vHi * 0.25 + aFocus * 0.08 * sin(uTime * 3.0));
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vW = w.xyz;
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          vec4 mv = viewMatrix * w;
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform float uTime;
        varying vec3 vN;
        varying vec3 vW;
        varying vec3 vCol;
        varying float vHi;
        varying float vFocus;
        varying float vDist;
        void main() {
          vec3 V = normalize(cameraPosition - vW);
          float fr = pow(1.0 - abs(dot(V, vN)), 2.2);
          float bands = 0.6 + 0.4 * sin(vW.y * 6.0 - uTime * 3.0);
          vec3 c = vCol * (0.12 + fr * (1.1 + vHi * 2.0) + vFocus * 0.6 * bands);
          c += vec3(1.0) * vHi * fr;
          gl_FragColor = vec4(applyFog(c, vDist * 0.5), 1.0);
        }`,
    });
  }

  /** Lay out the neighbourhood of `fi`. Returns once the transition has finished. */
  center(fi: number, from?: THREE.Vector3): Promise<void> {
    const m = this.model;
    const prev = new Map(this.nodes.map((n) => [n.fi, n.pos.clone()]));
    const origin = from ?? prev.get(fi) ?? new THREE.Vector3();
    this.fi = fi;
    const nb = m.neighbourhood(fi, 2, 900);
    const groups: Record<string, number[]> = { up1: [], up2: [], dn1: [], dn2: [], imp: [], both: [] };
    for (const [g, n] of nb) {
      if (g === fi) continue;
      const imp = m.fns[g].imp;
      if (n.role === 'both') groups.both.push(g);
      else if (n.role === 'caller') groups[n.hop === 1 ? 'up1' : 'up2'].push(g);
      else if (imp && n.hop === 1) groups.imp.push(g);
      else if (!imp) groups[n.hop === 1 ? 'dn1' : 'dn2'].push(g);
    }
    // keep the most connected ones when a ring overflows
    const weight = (g: number) => m.in[g].length + m.out[g].length;
    const overflow: { text: string; pos: THREE.Vector3; color: THREE.Color }[] = [];
    const nodes: CNode[] = [];
    const fnF = m.fns[fi];
    nodes.push({ fi, role: 'focus', hop: 0, pos: new THREE.Vector3(), radius: 2.4 + Math.log2(2 + fnF.size) * 0.18, color: C_FOCUS });
    const ring = (list: number[], y: number, cap: number, role: CNode['role'], hop: number, color: THREE.Color, rMin: number) => {
      const sorted = [...list].sort((a, b) => weight(b) - weight(a));
      const shown = sorted.slice(0, cap).sort((a, b) => m.fns[a].addr - m.fns[b].addr);
      const r = Math.max(rMin, (shown.length * 8.5) / (2 * Math.PI));
      shown.forEach((g, i) => {
        const a = (i / Math.max(1, shown.length)) * Math.PI * 2 + hop * 0.3 + (y > 0 ? 0 : 0.15);
        const f = m.fns[g];
        const col = role === 'import' ? C_IMPORT : role === 'both' ? C_BOTH : color.clone().lerp(heat(Math.min(1, Math.log2(1 + f.cc) / 7)), 0.25);
        nodes.push({ fi: g, role, hop, pos: new THREE.Vector3(Math.cos(a) * r, y + Math.sin(i * 1.7) * 1.2, Math.sin(a) * r), radius: 0.7 + Math.log2(2 + f.size) * 0.11, color: col });
      });
      if (sorted.length > cap) overflow.push({ text: `+${sorted.length - cap} more`, pos: new THREE.Vector3(r + 6, y, 0), color });
      return r;
    };
    const r1 = ring(groups.up1, 30, RING_CAP[1], 'caller', 1, C_CALLER, 16);
    ring(groups.up2, 62, RING_CAP[2], 'caller', 2, C_CALLER, r1 + 14);
    const d1 = ring(groups.dn1, -30, RING_CAP[1], 'callee', 1, C_CALLEE, 16);
    ring(groups.imp, -48, 40, 'import', 1, C_IMPORT, d1 + 10);
    ring(groups.dn2, -76, RING_CAP[2], 'callee', 2, C_CALLEE, d1 + 18);
    ring(groups.both, 0, 24, 'both', 1, C_BOTH, 20);
    this.nodes = nodes;
    this.build(prev, origin, overflow);
    return new Promise((res) => {
      const o = { t: 0 };
      this.anim?.kill();
      const starts = nodes.map((n) => prev.get(n.fi) ?? origin.clone());
      const ends = nodes.map((n) => n.pos.clone());
      const mtx = new THREE.Matrix4();
      this.anim = gsap.to(o, {
        t: 1,
        duration: 1.3,
        ease: 'power3.inOut',
        onUpdate: () => {
          nodes.forEach((n, i) => {
            const p = starts[i].clone().lerp(ends[i], o.t);
            const s = n.radius * (prev.has(n.fi) ? 1 : o.t);
            mtx.makeScale(s, s, s).setPosition(p);
            this.mesh!.setMatrixAt(i, mtx);
          });
          this.mesh!.instanceMatrix.needsUpdate = true;
        },
        onComplete: () => {
          this.buildEdges();
          res();
        },
      });
    });
  }

  private build(_prev: Map<number, THREE.Vector3>, _origin: THREE.Vector3, overflow: { text: string; pos: THREE.Vector3; color: THREE.Color }[]) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.edges && (this.group.remove(this.edges.mesh), this.edges.dispose(), (this.edges = null));
    this.labels && (this.group.remove(this.labels.mesh), this.labels.dispose());
    this.more && (this.group.remove(this.more.mesh), this.more.dispose(), (this.more = null));
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const n = this.nodes.length;
    const aCol = new Float32Array(n * 3);
    const aFocus = new Float32Array(n);
    this.nodes.forEach((nd, i) => {
      aCol.set([nd.color.r, nd.color.g, nd.color.b], i * 3);
      aFocus[i] = nd.role === 'focus' ? 1 : 0;
    });
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 3));
    geo.setAttribute('aFocus', new THREE.InstancedBufferAttribute(aFocus, 1));
    this.mesh = new THREE.InstancedMesh(geo, this.mat, Math.max(1, n));
    this.mesh.count = n;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    const m = this.model;
    const specs: LabelSpec[] = this.nodes.map((nd) => ({
      text: (nd.role === 'focus' ? '◆ ' : '') + m.fns[nd.fi].name.replace(/^sym\.(imp\.)?/, ''),
      color: nd.role === 'focus' ? PALETTE.yellow : nd.color,
      position: nd.pos.clone().add(new THREE.Vector3(0, nd.radius + (nd.role === 'focus' ? 2.6 : 1.4), 0)),
      size: nd.role === 'focus' ? 3.2 : 1.7,
    }));
    this.labels = new LabelField(specs, { fadeFar: 900, fadeNear: 2, px: 32, shrink: 90, depthTest: false, floor: 0.95 });
    this.labels.mesh.renderOrder = 20;
    this.labels.material.uniforms.uOpacity.value = 0;
    gsap.to(this.labels.material.uniforms.uOpacity, { value: 1, duration: 0.8, delay: 1.0 });
    this.group.add(this.labels.mesh);
    if (overflow.length) {
      this.more = new LabelField(
        overflow.map((o) => ({ text: o.text, color: o.color, position: o.pos, size: 1.4 })),
        { fadeFar: 600, px: 30 },
      );
      this.group.add(this.more.mesh);
    }
    // orbit guides
    this.rings.clear();
    const levels = new Map<number, number>();
    for (const nd of this.nodes) if (nd.role !== 'focus') levels.set(Math.round(nd.pos.y / 4) * 4, Math.max(levels.get(Math.round(nd.pos.y / 4) * 4) ?? 0, Math.hypot(nd.pos.x, nd.pos.z)));
    for (const [y, r] of levels) {
      const g = new THREE.RingGeometry(r - 0.06, r + 0.06, 160);
      g.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: y > 0 ? 0x0b6f88 : 0x7a1466, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      ring.position.y = y;
      this.rings.add(ring);
    }
    this.group.add(this.rings);
  }

  private buildEdges() {
    const m = this.model;
    const idx = new Map(this.nodes.map((n, i) => [n.fi, i]));
    const pairs = new Map<string, { a: number; b: number; n: number }>();
    for (const nd of this.nodes) {
      for (const c of m.out[nd.fi]) {
        const j = idx.get(c.callee);
        if (j === undefined || c.callee === nd.fi) continue;
        const k = `${nd.fi}>${c.callee}`;
        const p = pairs.get(k) ?? pairs.set(k, { a: idx.get(nd.fi)!, b: j, n: 0 }).get(k)!;
        p.n++;
      }
    }
    const specs: RibbonSpec[] = [];
    let tag = 0;
    for (const p of pairs.values()) {
      const A = this.nodes[p.a];
      const B = this.nodes[p.b];
      const direct = A.role === 'focus' || B.role === 'focus';
      const a = A.pos.clone();
      const b = B.pos.clone();
      const mid = a.clone().lerp(b, 0.5);
      mid.multiplyScalar(direct ? 0.55 : 1.1);
      mid.y = (a.y + b.y) / 2;
      const pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(22);
      specs.push({
        points: pts,
        color0: A.color,
        color1: B.color,
        width: direct ? 1.6 + Math.min(3, Math.log2(1 + p.n)) : 1.0,
        alpha: direct ? 0.7 : 0.1,
        flow: 14,
        tag: tag++,
        ends: [p.a, p.b],
      });
    }
    this.edges = new Ribbons(specs, { pulseSpacing: 14, renderOrder: 3 });
    this.edges.material.uniforms.uReveal.value = 0;
    gsap.to(this.edges.material.uniforms.uReveal, { value: 400, duration: 1.2, ease: 'power1.in', onComplete: () => this.edges && (this.edges.material.uniforms.uReveal.value = 1e9) });
    this.group.add(this.edges.mesh);
  }

  pick(ray: THREE.Raycaster): number {
    if (!this.mesh) return -1;
    const h = ray.intersectObject(this.mesh, false)[0];
    return h?.instanceId ?? -1;
  }

  hover(i: number) {
    if (i === this.hovered) return;
    this.hovered = i;
    this.mat.uniforms.uHover.value = i;
    this.edges?.highlightNode(i);
    this.labels?.clearHighlights();
    if (i >= 0) this.labels?.setHighlight(i, 1);
  }

  /** Fit the whole constellation (all rings + labels) into view. */
  overview(fov = 55, aspect = window.innerWidth / window.innerHeight): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const box = new THREE.Box3();
    for (const n of this.nodes) box.expandByPoint(n.pos);
    box.expandByScalar(6);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vfov = THREE.MathUtils.degToRad(fov) / 2;
    const hfov = Math.atan(Math.tan(vfov) * aspect);
    const dist = (sphere.radius / Math.sin(Math.min(vfov, hfov))) * 0.8;
    const dir = new THREE.Vector3(0.48, 0.24, 0.84).normalize();
    return { pos: sphere.center.clone().addScaledVector(dir, dist), target: sphere.center.clone() };
  }

  dispose() {
    this.anim?.kill();
    this.mesh?.geometry.dispose();
    this.mat.dispose();
    this.edges?.dispose();
    this.labels?.dispose();
    this.more?.dispose();
  }
}
