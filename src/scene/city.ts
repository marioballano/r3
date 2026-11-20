import * as THREE from 'three';
import { FOG_PARS, NOISE, globals, heat } from '../shaders/common';
import type { Fn } from '../types';
import { LabelField } from './labels';

/** Hilbert curve index -> (x, y) on an n x n grid (n power of two). */
function d2xy(n: number, d: number): [number, number] {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

export const CELL = 7;

export interface Tower {
  fn: Fn;
  fnIndex: number; // index into the full functions[] list
  pos: THREE.Vector3; // base centre
  height: number;
  width: number;
  color: THREE.Color;
}

/** The function city: one holographic tower per function, Hilbert-ordered by address. */
export class City {
  group = new THREE.Group();
  mesh: THREE.InstancedMesh;
  material: THREE.ShaderMaterial;
  towers: Tower[] = [];
  radius = 60;
  labels: LabelField | null = null;
  private aHi: THREE.InstancedBufferAttribute;
  private sorted: Tower[];
  private sweepT = -1;
  private growT = 0;
  pillar: THREE.Mesh | null = null;
  maxHeight = 10;

  /** Contiguous Hilbert cells (compact blob, address locality), centred on their centroid. */
  static layout(n: number): [number, number][] {
    let side = 1;
    while (side * side < Math.max(1, n)) side *= 2;
    const pts: [number, number][] = [];
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const p = d2xy(side, i);
      pts.push(p);
      cx += p[0];
      cy += p[1];
    }
    cx /= Math.max(1, n);
    cy /= Math.max(1, n);
    return pts.map(([x, y]) => [x - cx, y - cy]);
  }

  static radiusFor(functions: Fn[]): number {
    const pts = City.layout(functions.filter((f) => !f.imp).length);
    let r = 60;
    for (const [x, y] of pts) r = Math.max(r, Math.hypot(x, y) * CELL + CELL);
    return r;
  }

  constructor(functions: Fn[], entry: number | null) {
    functions.forEach((fn, i) => {
      if (!fn.imp) this.towers.push({ fn, fnIndex: i, pos: new THREE.Vector3(), height: 1, width: 1, color: new THREE.Color() });
    });
    this.towers.sort((a, b) => a.fn.addr - b.fn.addr);
    // colour by complexity percentile: mostly cyan/violet, only the gnarliest go hot
    const ccSorted = this.towers.map((t) => t.fn.cc).sort((a, b) => a - b);
    const pct = (cc: number) => {
      let lo = 0;
      let hi = ccSorted.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (ccSorted[m] < cc) lo = m + 1;
        else hi = m;
      }
      return ccSorted.length > 1 ? lo / (ccSorted.length - 1) : 0;
    };
    const cells = City.layout(this.towers.length);
    this.towers.forEach((t, i) => {
      t.pos.set(cells[i][0] * CELL, 0, cells[i][1] * CELL);
      const sz = Math.max(4, t.fn.size);
      t.height = Math.min(150, 2 + Math.sqrt(sz) * 0.42);
      t.width = Math.min(CELL * 0.8, 1.6 + Math.log2(1 + t.fn.nbbs) * 0.5);
      heat(Math.pow(pct(t.fn.cc), 2.2) * (t.fn.cc > 1 ? 1 : 0.3), t.color);
      this.radius = Math.max(this.radius, t.pos.length() + CELL);
      this.maxHeight = Math.max(this.maxHeight, t.height);
    });
    this.sorted = [...this.towers];

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const count = Math.max(1, this.towers.length);
    const aColor = new Float32Array(count * 3);
    const aSize = new Float32Array(count * 3);
    const aSeed = new Float32Array(count * 2);
    const hi = new Float32Array(count);
    this.towers.forEach((t, i) => {
      aColor.set([t.color.r, t.color.g, t.color.b], i * 3);
      aSize.set([t.width, t.height, t.width], i * 3);
      aSeed.set([Math.random(), t.pos.length() / this.radius], i * 2);
    });
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 2));
    this.aHi = new THREE.InstancedBufferAttribute(hi, 1);
    this.aHi.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHi', this.aHi);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...globals,
        uGrow: { value: 0 },
        uSweep: { value: 0 },
        uCityR: { value: this.radius },
        uFocus: { value: 0 },
      },
      vertexShader: /* glsl */ `
        uniform float uGrow;
        attribute vec3 aColor;
        attribute vec3 aSize;
        attribute vec2 aSeed;
        attribute float aHi;
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec3 vSize;
        varying vec3 vColor;
        varying vec3 vWorld;
        varying float vHi;
        varying float vSeed;
        varying float vDist;
        varying float vGrow;
        void main() {
          float g = clamp(uGrow * 1.7 - aSeed.y * 0.7, 0.0, 1.0);
          g = 1.0 - pow(1.0 - g, 3.0);
          vGrow = g;
          vec3 p = position;
          p.y *= max(g, 0.001);
          vLocal = position;
          vN = normal;
          vSize = aSize;
          vColor = aColor;
          vHi = aHi;
          vSeed = aSeed.x;
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vWorld = w.xyz;
          vec4 mv = viewMatrix * w;
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${NOISE}
        ${FOG_PARS}
        uniform float uTime;
        uniform float uSweep;
        uniform float uCityR;
        uniform float uFocus;
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec3 vSize;
        varying vec3 vColor;
        varying vec3 vWorld;
        varying float vHi;
        varying float vSeed;
        varying float vDist;
        varying float vGrow;
        void main() {
          vec3 n = normalize(vN);
          bool top = n.y > 0.5;
          vec2 f; vec2 sz;
          if (top || n.y < -0.5) { f = vLocal.xz + 0.5; sz = vSize.xz; }
          else if (abs(n.x) > 0.5) { f = vec2(vLocal.z + 0.5, vLocal.y); sz = vSize.zy; }
          else { f = vec2(vLocal.x + 0.5, vLocal.y); sz = vSize.xy; }
          vec2 w = f * sz;
          vec2 e = min(w, sz - w);
          float ew = 0.07 + vDist * 0.0006;
          float edge = 1.0 - smoothstep(0.0, ew, min(e.x, e.y));

          // windows
          vec2 cell = vec2(0.62, 0.95);
          vec2 gid = floor(w / cell);
          vec2 gf = fract(w / cell);
          float win = step(0.22, gf.x) * step(gf.x, 0.78) * step(0.3, gf.y) * step(gf.y, 0.72);
          float rnd = h21(gid + vSeed * 173.0);
          float lit = step(0.58, rnd) * (0.55 + 0.45 * sin(uTime * (0.4 + rnd * 2.5) + rnd * 60.0));
          lit *= step(0.02, h21(gid + floor(uTime * 0.7 + rnd * 9.0)));
          if (top) win = 0.0;
          // window detail fades at distance to avoid shimmer
          win *= smoothstep(420.0, 160.0, vDist);

          float y = vLocal.y * vSize.y;
          float scan = mod(uTime * (6.0 + vSeed * 10.0) + vSeed * 300.0, vSize.y + 30.0);
          float band = exp(-pow((y - scan) / 0.7, 2.0));

          float focus = vHi < -0.5 ? 0.22 : 1.0;
          float hi = max(vHi, 0.0);

          vec3 col = vColor * 0.035 + vec3(0.008, 0.004, 0.02);
          col += vColor * 0.06 * smoothstep(0.0, 1.0, vLocal.y);
          col += vColor * edge * (1.5 + hi * 2.5);
          col += mix(vColor, vec3(1.0), 0.25) * win * lit * 0.85;
          col += vColor * band * 1.4 * (1.0 - float(top));
          if (top) col += vColor * (0.5 + 0.35 * sin(uTime * 2.0 + vSeed * 20.0));
          vec3 V = normalize(cameraPosition - vWorld);
          float fr = pow(1.0 - abs(dot(V, n)), 3.0);
          col += vColor * fr * 0.3;

          col *= focus;
          col *= 1.0 + hi * (0.8 + 0.5 * sin(uTime * 7.0));
          if (vHi > 1.5) col += vec3(1.0) * edge * 0.8;

          // radial sweep
          float sw = uSweep > 0.0 && uSweep < 1.0 ? exp(-pow((length(vWorld.xz) / uCityR - (uSweep * 1.3 - 0.15)) * 9.0, 2.0)) : 0.0;
          col += mix(vColor, vec3(1.0), 0.5) * sw * 2.0;

          // materialisation shimmer while growing
          col += vColor * (1.0 - vGrow) * 2.0 * step(0.5, h21(vec2(floor(y * 3.0), floor(uTime * 20.0))));

          col = applyFog(col, vDist);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, count);
    const m = new THREE.Matrix4();
    this.towers.forEach((t, i) => {
      m.makeScale(t.width, t.height, t.width).setPosition(t.pos);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.count = this.towers.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.computeBoundingBox();
    this.group.add(this.mesh);

    // labels above the most significant towers
    const ranked = [...this.towers].sort((a, b) => b.fn.size * (1 + b.fn.indeg) - a.fn.size * (1 + a.fn.indeg));
    const top = ranked.slice(0, 140);
    const entryT = entry !== null ? this.towerAt(entry) : null;
    if (entryT && !top.includes(entryT)) top.push(entryT);
    this.labels = new LabelField(
      top.map((t) => ({
        text: t.fn.name.replace(/^sym\./, ''),
        color: t.color,
        position: new THREE.Vector3(t.pos.x, t.height + 2.4, t.pos.z),
        size: 1.6 + Math.min(2.4, t.height / 30),
      })),
      { fadeFar: 360, fadeNear: 6, px: 34, shrink: 140 },
    );
    this.group.add(this.labels.mesh);

    if (entryT) this.addPillar(entryT);
  }

  private addPillar(t: Tower) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { ...globals },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          float stripes = 0.6 + 0.4 * sin(vUv.y * 240.0 - uTime * 14.0);
          float flick = 0.85 + 0.15 * sin(uTime * 31.0);
          float a = (1.0 - vUv.y) * stripes * flick;
          a *= 0.55 + 0.45 * pow(abs(sin(vUv.x * 3.14159 * 2.0)), 0.3);
          vec3 c = mix(vec3(1.0, 0.2, 0.85), vec3(0.6, 1.0, 1.0), pow(1.0 - vUv.y, 6.0));
          gl_FragColor = vec4(c * 2.2, a * 0.55);
        }`,
    });
    const pillar = new THREE.Mesh(geo, mat);
    pillar.scale.set(t.width * 0.45, 900, t.width * 0.45);
    pillar.position.set(t.pos.x, t.height, t.pos.z);
    this.pillar = pillar;
    this.group.add(pillar);
  }

  /** Tower containing (or nearest below) a virtual address. */
  towerAt(addr: number): Tower | null {
    const s = this.sorted;
    if (!s.length) return null;
    let lo = 0;
    let hi = s.length - 1;
    if (addr < s[0].fn.addr) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].fn.addr <= addr) lo = mid;
      else hi = mid - 1;
    }
    const t = s[lo];
    return addr < t.fn.addr + Math.max(t.fn.size, 1) + 64 ? t : null;
  }

  indexOf(t: Tower) {
    return this.towers.indexOf(t);
  }

  top(t: Tower) {
    return new THREE.Vector3(t.pos.x, t.height, t.pos.z);
  }

  /** hi: -1 dim, 0 normal, 1 related, 2 selected */
  setStates(states: Map<number, number> | null) {
    const arr = this.aHi.array as Float32Array;
    arr.fill(states ? -1 : 0);
    if (states) for (const [i, v] of states) arr[i] = v;
    this.aHi.needsUpdate = true;
  }

  sweep() {
    this.sweepT = 0;
  }

  rise() {
    this.growT = 0.0001;
  }

  update(dt: number) {
    if (this.growT > 0 && this.growT < 1) {
      this.growT = Math.min(1, this.growT + dt / 3.2);
      this.material.uniforms.uGrow.value = this.growT;
    }
    if (this.sweepT >= 0) {
      this.sweepT += dt / 1.6;
      this.material.uniforms.uSweep.value = Math.min(this.sweepT, 1);
      if (this.sweepT >= 1) {
        this.sweepT = -1;
        this.material.uniforms.uSweep.value = 0;
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.labels?.dispose();
    if (this.pillar) {
      this.pillar.geometry.dispose();
      (this.pillar.material as THREE.Material).dispose();
    }
  }
}
