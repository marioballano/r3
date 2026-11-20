import * as THREE from 'three';

/** Uniforms shared by reference across all custom materials. */
export const globals = {
  uTime: { value: 0 },
  uFogColor: { value: new THREE.Color(0x12052a) },
  uFogDensity: { value: 0.0016 },
};

export const NOISE = /* glsl */ `
float h11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export const FOG_PARS = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
vec3 applyFog(vec3 c, float dist) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}
`;

export const PALETTE = {
  magenta: new THREE.Color(0xff2bd6),
  cyan: new THREE.Color(0x00f0ff),
  yellow: new THREE.Color(0xfff200),
  violet: new THREE.Color(0x8a3dff),
  green: new THREE.Color(0x39ff88),
  red: new THREE.Color(0xff3864),
  orange: new THREE.Color(0xff8a00),
  ice: new THREE.Color(0xc8f6ff),
};

/** cyan → violet → magenta → hot yellow, t in [0,1] */
export function heat(t: number, out = new THREE.Color()): THREE.Color {
  const stops = [PALETTE.cyan, PALETTE.violet, PALETTE.magenta, PALETTE.orange, PALETTE.yellow];
  const x = Math.max(0, Math.min(0.9999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return out.copy(stops[i]).lerp(stops[i + 1], x - i);
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
