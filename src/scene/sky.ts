import * as THREE from 'three';
import { NOISE, globals } from '../shaders/common';

/** Camera-centred sky dome: gradient, synth sun, procedural skyline, stars, aurora. */
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: globals.uTime,
      uSunDir: { value: new THREE.Vector3(0, 0.1, -1).normalize() },
      uHorizon: { value: new THREE.Color(0x4a0d5e) },
      uZenith: { value: new THREE.Color(0x020008) },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform float uIntensity;
      varying vec3 vDir;

      float skyline(float az, float scale, float seed, float hmin, float hmax) {
        float x = az * scale;
        float id = floor(x);
        float r = h21(vec2(id, seed));
        float h = mix(hmin, hmax, r * r);
        if (h21(vec2(id, seed + 3.0)) > 0.93) h *= 1.8; // spires
        float f = fract(x);
        float edge = step(0.06, f) * step(f, 0.94);
        return h * mix(0.6, 1.0, edge);
      }

      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        float az = atan(d.z, d.x);

        // base gradient
        float t = clamp(e, 0.0, 1.0);
        vec3 col = mix(uHorizon * 1.15, uZenith, pow(t, 0.38));
        col += vec3(0.55, 0.06, 0.38) * exp(-abs(e) * 18.0) * 0.55; // horizon glow
        col = mix(col, vec3(0.01, 0.0, 0.02), smoothstep(0.0, -0.15, e));

        // aurora ribbons
        if (e > 0.05) {
          vec2 q = vec2(az * 2.0, e * 4.0);
          float n = fbm(q + vec2(uTime * 0.02, 0.0));
          float band = smoothstep(0.1, 0.0, abs(e - 0.35 - 0.12 * sin(az * 3.0 + uTime * 0.05) - (n - 0.5) * 0.2));
          col += mix(vec3(0.0, 0.9, 0.8), vec3(0.9, 0.1, 0.8), n) * band * 0.18 * smoothstep(0.05, 0.3, e);
        }

        // stars
        if (e > 0.02) {
          vec3 sp = d * 420.0;
          vec3 id = floor(sp);
          float r = h21(id.xy + id.z * 17.0);
          if (r > 0.9965) {
            float tw = 0.6 + 0.4 * sin(uTime * (1.0 + r * 5.0) + r * 100.0);
            float dd = length(fract(sp) - 0.5);
            col += vec3(0.8, 0.85, 1.0) * smoothstep(0.45, 0.0, dd) * tw * 1.4 * smoothstep(0.02, 0.25, e);
          }
        }

        // synthwave sun
        float sd = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
        float R = 0.16;
        if (sd < R) {
          float v = (dot(d, vec3(0.0, 1.0, 0.0)) - (uSunDir.y - R)) / (2.0 * R); // 0 bottom .. 1 top
          vec3 sc = mix(vec3(0.85, 0.04, 0.5), vec3(1.25, 0.75, 0.12), smoothstep(0.1, 0.95, v));
          float slit = 1.0;
          if (v < 0.55) {
            float k = (0.55 - v) / 0.55;
            float stripes = fract(v * 16.0 + uTime * 0.15);
            slit = step(k * 0.85, stripes);
          }
          col = mix(col, sc, slit * smoothstep(R, R - 0.004, sd));
        }
        col += vec3(1.0, 0.15, 0.6) * exp(-sd * 6.0) * 0.22;

        // far skyline (two layers)
        float h1 = skyline(az, 70.0, 1.0, 0.012, 0.05);
        float h2 = skyline(az, 150.0, 7.0, 0.006, 0.028);
        if (e < h1 && e > -0.02) {
          vec3 b = vec3(0.04, 0.01, 0.07);
          vec2 w = vec2(az * 900.0, e * 700.0);
          vec2 wi = floor(w);
          float lit = step(0.9, h21(wi)) * step(0.3, fract(w.x)) * step(0.35, fract(w.y));
          float fl = step(0.03, h21(wi + floor(uTime * 0.5)));
          vec3 wc = mix(vec3(0.0, 1.2, 1.4), vec3(1.6, 0.2, 1.2), h21(wi + 5.0));
          b += wc * lit * fl * 0.9;
          col = b;
        }
        if (e < h2 && e > -0.02) col = vec3(0.012, 0.004, 0.022);

        gl_FragColor = vec4(col * uIntensity, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 64, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    material: mat,
    update(camera: THREE.Camera) {
      mesh.position.copy(camera.position);
    },
  };
}
