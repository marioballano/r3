import * as THREE from 'three';
import { FOG_PARS, globals, heat, PALETTE } from '../shaders/common';
import type { EntropyData, Section } from '../types';
import { LabelField } from './labels';

export function sectionColor(s: Section | undefined, out = new THREE.Color()): THREE.Color {
  if (!s) return out.set(0x5a4a7a);
  const p = s.perm ?? '';
  if (p.includes('x')) return out.copy(PALETTE.magenta);
  if (p.includes('w')) return out.copy(PALETTE.cyan);
  if (p.includes('r')) return out.copy(PALETTE.violet);
  return out.set(0x5a4a7a);
}

/**
 * The entropy halo: the file's byte entropy as a ring of light bars around the
 * city, segmented and coloured by section, with floating section names.
 */
export class EntropyHalo {
  group = new THREE.Group();
  radius: number;
  private bars: THREE.InstancedMesh;
  private mat: THREE.ShaderMaterial;
  labels: LabelField | null = null;
  private marker: THREE.Mesh;
  private markerTarget = 0;
  private sections: Section[];
  private data: EntropyData | null;
  private revealT = 0;

  constructor(data: EntropyData | null, sections: Section[], cityRadius: number) {
    this.data = data;
    this.sections = sections.filter((s) => s.size > 0 && s.name);
    this.radius = cityRadius + 55;
    const vals = data?.entropy?.length ? data.entropy : Array.from({ length: 64 }, (_, i) => ({ addr: i, value: 0 }));
    const N = vals.length;
    const R = this.radius;
    const bw = ((2 * Math.PI * R) / N) * 0.5;
    let vmin = 255;
    let vmax = 0;
    for (const e of vals) {
      vmin = Math.min(vmin, e.value);
      vmax = Math.max(vmax, e.value);
    }
    const span = Math.max(24, vmax - vmin);
    const H = Math.min(55, 12 + cityRadius * 0.2);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const aVal = new Float32Array(N);
    const aColor = new Float32Array(N * 3);
    const aIdx = new Float32Array(N);
    const c = new THREE.Color();
    const h = new THREE.Color();
    this.mat = new THREE.ShaderMaterial({
      transparent: false,
      uniforms: { ...globals, uReveal: { value: 0 }, uFocus: { value: 0 }, uMarker: { value: -1 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uReveal;
        uniform float uMarker;
        attribute float aVal;
        attribute vec3 aColor;
        attribute float aIdx;
        varying vec3 vColor;
        varying float vY;
        varying float vVal;
        varying float vDist;
        varying float vMark;
        void main() {
          float shimmer = 1.0 + 0.06 * sin(uTime * 3.0 + aIdx * 0.7) * aVal;
          float rev = clamp(uReveal * 1.8 - aIdx * 0.8, 0.0, 1.0);
          vec3 p = position;
          p.y *= shimmer * rev + 0.0001;
          vY = position.y;
          vColor = aColor;
          vVal = aVal;
          vMark = 1.0 - smoothstep(0.0, 0.012, abs(aIdx - uMarker));
          vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
          vDist = -mv.z / length(viewMatrix[0].xyz); // world units, also under a scaled XR rig
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform float uTime;
        uniform float uFocus;
        varying vec3 vColor;
        varying float vY;
        varying float vVal;
        varying float vDist;
        varying float vMark;
        void main() {
          float seg = step(0.35, fract(vY * 22.0));
          vec3 c = vColor * (0.15 + vY * 1.6) * seg;
          c += vColor * smoothstep(0.92, 1.0, vY) * 3.0;
          c *= 1.0 + uFocus * 0.8;
          c += vec3(1.0) * vMark * 2.5 * seg;
          c = applyFog(c, vDist * 0.7);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.bars = new THREE.InstancedMesh(geo, this.mat, N);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    vals.forEach((e, i) => {
      const a = (i / N) * Math.PI * 2;
      const v = Math.max(0, Math.min(1, e.value / 255));
      const rel = Math.max(0, Math.min(1, (e.value - vmin) / span));
      const height = 2 + Math.pow(rel, 1.6) * H + v * 4;
      q.setFromAxisAngle(up, -a);
      m.compose(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R), q, new THREE.Vector3(bw, height, 1.2));
      this.bars.setMatrixAt(i, m);
      const sec = this.sectionAtPaddr(e.addr);
      sectionColor(sec, c);
      heat(Math.pow(v, 3), h);
      c.lerp(h, Math.pow(v, 6) * 0.9);
      aVal[i] = v;
      aIdx[i] = i / N;
      aColor.set([c.r, c.g, c.b], i * 3);
    });
    geo.setAttribute('aVal', new THREE.InstancedBufferAttribute(aVal, 1));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3));
    geo.setAttribute('aIdx', new THREE.InstancedBufferAttribute(aIdx, 1));
    this.bars.instanceMatrix.needsUpdate = true;
    this.group.add(this.bars);

    // glowing floor rings
    const ringGeo = new THREE.RingGeometry(R - 3.2, R + 3.2, 256, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uR: { value: R } },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uR;
        varying vec3 vW;
        void main() {
          float r = length(vW.xz);
          float d = abs(r - uR);
          float a = atan(vW.z, vW.x);
          float dash = step(0.5, fract(a * 40.0 + uTime * 0.3));
          float line = smoothstep(0.5, 0.0, abs(d - 3.0)) * 1.0 + smoothstep(0.3, 0.0, d) * dash * 0.8;
          gl_FragColor = vec4(vec3(1.0, 0.2, 0.85) * 1.6, line);
        }`,
    });
    this.group.add(new THREE.Mesh(ringGeo, ringMat));

    // section labels
    if (data && this.sections.length) {
      const specs = [];
      const seen = new Set<string>();
      for (const s of this.sections) {
        if (seen.has(s.name) || s.size < (data.size || 1) * 0.004) continue;
        seen.add(s.name);
        const mid = s.paddr + s.size / 2;
        const a = this.angleOfPaddr(mid);
        if (a === null) continue;
        specs.push({
          text: `${s.name}  ${s.perm}`,
          color: sectionColor(s),
          position: new THREE.Vector3(Math.cos(a) * (R + 6), H + 16 + (specs.length % 3) * 6, Math.sin(a) * (R + 6)),
          size: 4.2,
        });
      }
      this.labels = new LabelField(specs, { fadeFar: 1400, px: 40 });
      this.group.add(this.labels.mesh);
    }

    // seek marker: a vertical scanning blade
    const mg = new THREE.PlaneGeometry(1, 1);
    mg.translate(0, 0.5, 0);
    const mm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { ...globals },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float x = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float a = pow(x, 3.0) * (1.0 - vUv.y) * (0.7 + 0.3 * sin(vUv.y * 80.0 - uTime * 12.0));
          gl_FragColor = vec4(vec3(1.0, 1.0, 0.4) * 2.5, a);
        }`,
    });
    this.marker = new THREE.Mesh(mg, mm);
    this.marker.scale.set(6, H * 1.8 + 20, 1);
    this.marker.visible = false;
    this.group.add(this.marker);
  }

  sectionAtPaddr(p: number): Section | undefined {
    return this.sections.find((s) => p >= s.paddr && p < s.paddr + s.size);
  }

  vaddrToPaddr(v: number): number | null {
    const s = this.sections.find((s) => v >= s.vaddr && v < s.vaddr + Math.max(s.vsize, s.size));
    return s ? s.paddr + (v - s.vaddr) : null;
  }

  angleOfPaddr(p: number): number | null {
    const d = this.data;
    if (!d || !d.size) return null;
    const f = (p - d.address) / d.size;
    if (f < 0 || f > 1) return null;
    return f * Math.PI * 2;
  }

  /** Entropy (0..1) near a virtual address. */
  entropyAt(vaddr: number): number {
    const d = this.data;
    const p = this.vaddrToPaddr(vaddr);
    if (!d || p === null || !d.entropy?.length) return 0.5;
    const i = Math.floor((p - d.address) / Math.max(1, d.blocksize));
    return (d.entropy[Math.max(0, Math.min(d.entropy.length - 1, i))]?.value ?? 128) / 255;
  }

  setSeek(vaddr: number) {
    const p = this.vaddrToPaddr(vaddr);
    const a = p === null ? null : this.angleOfPaddr(p);
    if (a === null) {
      this.marker.visible = false;
      this.mat.uniforms.uMarker.value = -1;
      return;
    }
    this.marker.visible = true;
    this.markerTarget = a;
    this.mat.uniforms.uMarker.value = a / (Math.PI * 2);
  }

  focusPoint(): THREE.Vector3 {
    return new THREE.Vector3(Math.cos(this.markerTarget) * this.radius, 30, Math.sin(this.markerTarget) * this.radius);
  }

  reveal() {
    this.revealT = 0.0001;
  }

  update(dt: number) {
    if (this.revealT > 0 && this.revealT < 1) {
      this.revealT = Math.min(1, this.revealT + dt / 2.5);
      this.mat.uniforms.uReveal.value = this.revealT;
    }
    const a = this.markerTarget;
    this.marker.position.set(Math.cos(a) * this.radius, 0, Math.sin(a) * this.radius);
    this.marker.rotation.y = -a + Math.PI / 2;
  }

  setFocus(v: number) {
    this.mat.uniforms.uFocus.value = v;
  }

  dispose() {
    this.bars.geometry.dispose();
    this.mat.dispose();
    this.labels?.dispose();
  }
}
