import * as THREE from 'three';
import { FOG_PARS, globals, PALETTE } from '../shaders/common';
import type { Fn, ImportEntry, StringEntry } from '../types';
import { LabelField } from './labels';

export const IMPORT_GAP = 26;

export interface Satellite {
  name: string;
  fnIndex: number | null;
  pos: THREE.Vector3;
}

/** Imports as an orbital ring of glowing relays tethered to the ground. */
export class ImportRing {
  group = new THREE.Group();
  sats: Satellite[] = [];
  private mesh: THREE.InstancedMesh;
  private mat: THREE.ShaderMaterial;
  labels: LabelField;
  private byFn = new Map<number, Satellite>();
  radius: number;

  constructor(imports: ImportEntry[], functions: Fn[], innerRadius: number) {
    this.radius = innerRadius + IMPORT_GAP;
    const fnByName = new Map<string, number>();
    functions.forEach((f, i) => {
      if (f.imp) fnByName.set(f.name.replace(/^sym\.imp\./, '').replace(/^imp\./, ''), i);
    });
    const names = new Set<string>();
    for (const im of imports) if (im.name) names.add(im.name);
    for (const k of fnByName.keys()) names.add(k);
    const list = [...names].slice(0, 600);
    const N = Math.max(1, list.length);
    const R = this.radius;
    list.forEach((name, i) => {
      const a = (i / N) * Math.PI * 2 + 0.013;
      const y = 62 + Math.sin(i * 0.9) * 10 + (i % 2) * 8;
      const sat: Satellite = { name, fnIndex: fnByName.get(name) ?? null, pos: new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R) };
      this.sats.push(sat);
      if (sat.fnIndex !== null) this.byFn.set(sat.fnIndex, sat);
    });

    const geo = new THREE.OctahedronGeometry(1.6, 0);
    const aSeed = new Float32Array(N);
    const aLinked = new Float32Array(N);
    this.sats.forEach((s, i) => {
      aSeed[i] = Math.random();
      aLinked[i] = s.fnIndex !== null ? 1 : 0;
    });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    geo.setAttribute('aLinked', new THREE.InstancedBufferAttribute(aLinked, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...globals, uPulse: { value: 0 }, uSel: { value: -1 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float aSeed;
        attribute float aLinked;
        varying vec3 vN;
        varying vec3 vW;
        varying float vSeed;
        varying float vLinked;
        varying float vDist;
        varying float vId;
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
        void main() {
          mat3 r = rotY(uTime * (0.6 + aSeed) + aSeed * 6.28);
          vec3 p = r * position;
          p.y *= 1.6;
          vN = r * normal;
          vSeed = aSeed;
          vLinked = aLinked;
          vId = float(gl_InstanceID);
          vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
          w.y += sin(uTime * 0.7 + aSeed * 20.0) * 1.2;
          vW = w.xyz;
          vec4 mv = viewMatrix * w;
          vDist = -mv.z / length(viewMatrix[0].xyz); // world units, also under a scaled XR rig
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform float uTime;
        uniform float uPulse;
        uniform float uSel;
        varying vec3 vN;
        varying vec3 vW;
        varying float vSeed;
        varying float vLinked;
        varying float vDist;
        varying float vId;
        void main() {
          vec3 V = normalize(cameraPosition - vW);
          float fr = pow(1.0 - abs(dot(V, normalize(vN))), 2.0);
          vec3 c = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.95, 0.2), step(0.5, vLinked) * 0.0 + vSeed * 0.15);
          float sel = 1.0 - step(0.5, abs(vId - uSel));
          float b = 0.25 + fr * 2.4 + uPulse * 2.0 + sel * 4.0;
          b *= 0.8 + 0.2 * sin(uTime * 3.0 + vSeed * 30.0);
          vec3 col = applyFog(c * b, vDist * 0.8);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, N);
    const m = new THREE.Matrix4();
    this.sats.forEach((s, i) => this.mesh.setMatrixAt(i, m.makeTranslation(s.pos.x, s.pos.y, s.pos.z)));
    this.mesh.count = this.sats.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.group.add(this.mesh);

    // tethers
    const tpos = new Float32Array(this.sats.length * 6);
    this.sats.forEach((s, i) => tpos.set([s.pos.x, 0, s.pos.z, s.pos.x, s.pos.y - 2, s.pos.z], i * 6));
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
    const tmat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals },
      vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying float vY;
        void main(){
          float p = smoothstep(0.85, 1.0, fract(vY * 0.02 - uTime * 0.4));
          gl_FragColor = vec4(vec3(0.0, 0.8, 1.0) * (0.6 + p * 3.0), 0.12 + p * 0.5);
        }`,
    });
    this.group.add(new THREE.LineSegments(tgeo, tmat));

    this.labels = new LabelField(
      this.sats.map((s) => ({
        text: s.name,
        color: s.fnIndex !== null ? PALETTE.cyan : PALETTE.violet,
        position: s.pos.clone().add(new THREE.Vector3(0, -4.5, 0)),
        size: 1.9,
      })),
      { fadeFar: 300, px: 30 },
    );
    this.group.add(this.labels.mesh);
  }

  posOfFn(fnIndex: number): THREE.Vector3 | null {
    return this.byFn.get(fnIndex)?.pos.clone().multiply(this.group.scale) ?? null;
  }

  satOfFn(fnIndex: number): number {
    const s = this.byFn.get(fnIndex);
    return s ? this.sats.indexOf(s) : -1;
  }

  select(i: number) {
    this.mat.uniforms.uSel.value = i;
    this.labels.clearHighlights();
    if (i >= 0) this.labels.setHighlight(i, 1);
  }

  pulse(v: number) {
    this.mat.uniforms.uPulse.value = v;
    this.labels.material.uniforms.uPulse.value = v;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.labels.dispose();
  }
}

/** Strings as a drifting holographic cloud above the city. */
export class StringCloud {
  labels: LabelField;
  constructor(strings: StringEntry[], cityRadius: number, max = 260) {
    const pick = strings
      .filter((s) => s.string && s.string.trim().length >= 4)
      .sort((a, b) => (b.string.length > 40 ? 0 : b.string.length) - (a.string.length > 40 ? 0 : a.string.length))
      .slice(0, max);
    const R = cityRadius * 1.15 + 20;
    this.labels = new LabelField(
      pick.map((s) => {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * R;
        const txt = s.string.replace(/\s+/g, ' ');
        const col = /https?:|@|\.(so|dll)|\//.test(txt)
          ? PALETTE.yellow
          : /error|fail|invalid|denied|cannot|unable/i.test(txt)
            ? PALETTE.red
            : /%[0-9.]*[sdxpluf]/.test(txt)
              ? PALETTE.magenta
              : PALETTE.ice;
        return {
          text: `"${txt}"`,
          color: col,
          position: new THREE.Vector3(Math.cos(a) * r, 110 + cityRadius * 0.3 + Math.random() * 120, Math.sin(a) * r),
          size: 1.6 + Math.random() * 1.2,
        };
      }),
      { fadeFar: 560, fadeNear: 40, drift: 3, px: 34, atlas: 4096 },
    );
    this.labels.material.uniforms.uOpacity.value = 0.5;
  }

  pulse(v: number) {
    this.labels.material.uniforms.uPulse.value = v;
  }

  dispose() {
    this.labels.dispose();
  }
}
