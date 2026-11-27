import * as THREE from 'three';
import { FOG_PARS, globals } from '../shaders/common';

/** Rasterize a panel or sign that is attached to 3D geometry. */
export function textTexture(lines: { text: string; color: string }[], bg: string, fontSize = 28, border?: string) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `500 ${fontSize}px "JetBrains Mono", monospace`;
  const row = Math.ceil(fontSize * 1.4);
  ctx.font = font;
  canvas.width = Math.ceil(Math.max(1, ...lines.map(({ text }) => ctx.measureText(text).width))) + 36;
  canvas.height = row * lines.length + 26;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (border) {
    ctx.fillStyle = border;
    ctx.fillRect(0, 0, 4, canvas.height);
    ctx.fillRect(0, canvas.height - 2, canvas.width, 2);
  }
  ctx.font = font;
  ctx.textBaseline = 'middle';
  lines.forEach(({ text, color }, i) => {
    ctx.fillStyle = color;
    ctx.fillText(text, 18, 13 + row * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export interface LabelSpec {
  text: string;
  color: THREE.Color;
  position: THREE.Vector3;
  size: number; // world height
  font?: string;
}

/**
 * Many text labels in one draw call: rasterise every label into a shared
 * canvas atlas (shelf packing), render as instanced camera-facing quads.
 */
export class LabelField {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aHi: THREE.InstancedBufferAttribute;
  readonly count: number;
  readonly specs: LabelSpec[];

  constructor(
    specs: LabelSpec[],
    opts: { atlas?: number; px?: number; fadeNear?: number; fadeFar?: number; drift?: number; depthTest?: boolean; shrink?: number; floor?: number } = {},
  ) {
    const W = opts.atlas ?? 2048;
    const px = opts.px ?? 36;
    const pad = 6;
    const rowH = px + pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = W;
    const g = canvas.getContext('2d')!;
    g.textBaseline = 'middle';
    const uvRect = new Float32Array(specs.length * 4);
    const sizeArr = new Float32Array(specs.length * 2);
    const posArr = new Float32Array(specs.length * 4);
    const colArr = new Float32Array(specs.length * 3);
    let x = 0;
    let y = 0;
    let kept = 0;
    const keptSpecs: LabelSpec[] = [];
    for (const s of specs) {
      g.font = s.font ?? `600 ${px}px "JetBrains Mono", monospace`;
      const text = s.text.length > 64 ? s.text.slice(0, 63) + '…' : s.text;
      const w = Math.min(W - pad * 2, Math.ceil(g.measureText(text).width) + pad * 2);
      if (x + w > W) {
        x = 0;
        y += rowH;
      }
      if (y + rowH > W) break;
      g.fillStyle = '#fff';
      g.shadowColor = 'rgba(255,255,255,0.9)';
      g.shadowBlur = 4;
      g.fillText(text, x + pad, y + rowH / 2, w - pad * 2);
      uvRect.set([x / W, 1 - (y + rowH) / W, w / W, rowH / W], kept * 4);
      sizeArr.set([(w / rowH) * s.size, s.size], kept * 2);
      posArr.set([s.position.x, s.position.y, s.position.z, Math.random()], kept * 4);
      colArr.set([s.color.r, s.color.g, s.color.b], kept * 3);
      keptSpecs.push(s);
      kept++;
      x += w;
    }
    this.count = kept;
    this.specs = keptSpecs;
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;

    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(uvRect.subarray(0, kept * 4), 4));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizeArr.subarray(0, kept * 2), 2));
    this.aPos = new THREE.InstancedBufferAttribute(posArr.subarray(0, kept * 4), 4);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colArr.subarray(0, kept * 3), 3));
    this.aHi = new THREE.InstancedBufferAttribute(new Float32Array(kept), 1);
    this.aHi.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHi', this.aHi);
    geo.instanceCount = kept;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        ...globals,
        uMap: { value: tex },
        uFadeNear: { value: opts.fadeNear ?? 0 },
        uFadeFar: { value: opts.fadeFar ?? 900 },
        uDrift: { value: opts.drift ?? 0 },
        uOpacity: { value: 1 },
        uPulse: { value: 0 },
        uReveal: { value: 1 },
        uShrink: { value: opts.shrink ?? 0.0001 },
        uFloor: { value: opts.floor ?? 0.55 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uDrift;
        uniform float uReveal;
        uniform float uShrink;
        attribute vec4 aRect;
        attribute vec2 aSize;
        attribute vec4 aPos;
        attribute vec3 aColor;
        attribute float aHi;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vDist;
        varying float vHi;
        varying float vSeed;
        void main() {
          vec3 c = aPos.xyz;
          c.y += sin(uTime * 0.4 + aPos.w * 30.0) * uDrift;
          c.x += cos(uTime * 0.3 + aPos.w * 20.0) * uDrift * 0.6;
          // normalised: a scaled WebXR rig puts a uniform scale into the view matrix
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          float vs = length(right);
          right /= vs;
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) / vs;
          float dc = -(viewMatrix * vec4(c, 1.0)).z / vs;
          float s = (1.0 + aHi * 0.35) * clamp(dc / uShrink, 0.28, 1.0);
          vec3 p = c + right * position.x * aSize.x * s + up * position.y * aSize.y * s;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDist = -mv.z / length(viewMatrix[0].xyz); // world units, also under a scaled XR rig
          gl_Position = projectionMatrix * mv;
          vUv = aRect.xy + uv * aRect.zw;
          vColor = aColor;
          vHi = aHi;
          vSeed = aPos.w;
          if (aPos.w > uReveal) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform sampler2D uMap;
        uniform float uFadeNear;
        uniform float uFadeFar;
        uniform float uOpacity;
        uniform float uPulse;
        uniform float uTime;
        uniform float uFloor;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vDist;
        varying float vHi;
        varying float vSeed;
        void main() {
          float a = texture2D(uMap, vUv).a;
          float fade = smoothstep(uFadeFar, uFadeFar * 0.6, vDist) * smoothstep(uFadeNear, uFadeNear + 8.0, vDist);
          float flick = 0.85 + 0.15 * step(0.04, fract(sin(floor(uTime * 12.0) + vSeed * 91.0) * 437.5));
          float b = (1.0 + vHi * 2.2 + uPulse * 1.6) * flick;
          vec3 col = mix(vColor, vec3(1.0), vHi * 0.45);
          float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 0.5);
          gl_FragColor = vec4(col * b, a * fade * uOpacity * fog * max(uFloor, vHi));
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  setHighlight(i: number, v: number) {
    if (i < 0 || i >= this.count) return;
    this.aHi.setX(i, v);
    this.aHi.needsUpdate = true;
  }

  clearHighlights() {
    (this.aHi.array as Float32Array).fill(0);
    this.aHi.needsUpdate = true;
  }

  setPosition(i: number, p: THREE.Vector3) {
    this.aPos.setXYZ(i, p.x, p.y, p.z);
    this.aPos.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.material.uniforms.uMap.value as THREE.Texture).dispose();
    this.material.dispose();
  }
}
