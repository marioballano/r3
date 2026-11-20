import * as THREE from 'three';
import { FOG_PARS, globals } from '../shaders/common';

/** Drifting luminous data motes filling the volume around the city. */
export function createMotes(count = 5000, radius = 900, height = 420) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const col = new Float32Array(count * 3);
  const palette = [new THREE.Color(0x00f0ff), new THREE.Color(0xff2bd6), new THREE.Color(0xfff200), new THREE.Color(0x8a3dff)];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * height;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random();
    const c = palette[Math.random() < 0.55 ? 0 : Math.random() < 0.6 ? 1 : Math.random() < 0.5 ? 2 : 3];
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...globals, uHeight: { value: height }, uPixel: { value: window.devicePixelRatio }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uHeight;
      uniform float uPixel;
      attribute float aSeed;
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vDist;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (2.0 + aSeed * 6.0), uHeight);
        p.x += sin(uTime * 0.2 + aSeed * 40.0) * 6.0;
        p.z += cos(uTime * 0.17 + aSeed * 30.0) * 6.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
        float tw = 0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 4.0) + aSeed * 60.0);
        gl_PointSize = (1.2 + aSeed * 2.6) * uPixel * (300.0 / max(vDist, 1.0)) * (0.6 + tw * 0.6);
        vColor = aColor;
        vAlpha = (0.35 + 0.65 * tw) * smoothstep(0.0, 30.0, p.y) * smoothstep(uHeight, uHeight - 60.0, p.y);
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_PARS}
      uniform float uIntensity;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vDist;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        a = a * a;
        float fog = exp(-uFogDensity * uFogDensity * vDist * vDist);
        gl_FragColor = vec4(vColor * 2.2 * uIntensity, a * vAlpha * fog);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, material: mat };
}

/** Falling glyph columns (hex digits), "data rain". */
export function createHexRain(columns = 70, perColumn = 26, radius = 700) {
  const glyphs = '0123456789ABCDEF';
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff';
  g.font = 'bold 52px "JetBrains Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 16; i++) g.fillText(glyphs[i], i * 64 + 32, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;

  const n = columns * perColumn;
  const geo = new THREE.InstancedBufferGeometry();
  const base = new THREE.PlaneGeometry(1, 1);
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const off = new Float32Array(n * 4);
  const prm = new Float32Array(n * 2);
  for (let c = 0; c < columns; c++) {
    const a = Math.random() * Math.PI * 2;
    const r = radius * (0.35 + Math.random() * 0.65);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const speed = 8 + Math.random() * 22;
    const top = 120 + Math.random() * 220;
    for (let k = 0; k < perColumn; k++) {
      const i = c * perColumn + k;
      off.set([x, z, k, c], i * 4);
      prm.set([speed, top], i * 2);
    }
  }
  // (x, z, index in column, column id) + (speed, top)
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(prm, 2));
  geo.instanceCount = n;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...globals, uMap: { value: tex }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec4 aOff;
      attribute vec2 aParam;
      varying vec2 vUv;
      varying float vGlyph;
      varying float vBright;
      varying float vDist;
      varying float vHue;
      void main() {
        float top = aParam.y;
        float speed = aParam.x;
        float cid = aOff.w;
        float k = aOff.z;
        float glyphH = 3.2;
        float colLen = 26.0 * glyphH;
        float head = mod(uTime * speed + cid * 13.0, top + colLen) ;
        float y = top - head + k * glyphH;
        vec3 center = vec3(aOff.x, y, aOff.y);
        // camera-facing billboard
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 p = center + right * position.x * 2.6 + up * position.y * 2.6;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
        vUv = uv;
        float t = floor(uTime * (4.0 + mod(cid, 5.0)) + k * 7.0 + cid);
        vGlyph = mod(floor(fract(sin(t * 12.9898 + k * 78.233) * 43758.5453) * 16.0), 16.0);
        vBright = (k < 0.5 ? 2.5 : 1.0) * (1.0 - k / 26.0) * step(0.0, y);
        vHue = mod(cid, 3.0);
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_PARS}
      uniform sampler2D uMap;
      uniform float uIntensity;
      varying vec2 vUv;
      varying float vGlyph;
      varying float vBright;
      varying float vDist;
      varying float vHue;
      void main() {
        vec2 uv = vec2((vGlyph + vUv.x) / 16.0, vUv.y);
        float a = texture2D(uMap, uv).a;
        vec3 c = vHue < 1.0 ? vec3(0.1, 1.0, 0.7) : vHue < 2.0 ? vec3(1.0, 0.2, 0.85) : vec3(0.0, 0.8, 1.0);
        if (vBright > 2.0) c = vec3(0.9, 1.0, 1.0);
        float fog = exp(-uFogDensity * uFogDensity * vDist * vDist * 0.6);
        gl_FragColor = vec4(c * vBright * uIntensity, a * fog * 0.85);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, material: mat };
}
