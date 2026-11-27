import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { FOG_PARS, NOISE, globals } from '../shaders/common';
import type { Engine } from './engine';

/** Infinite-looking neon grid with blurred real-time reflections and outgoing pulse rings. */
export function createGround(engine: Engine) {
  const shader = {
    name: 'R3Ground',
    uniforms: {
      color: { value: new THREE.Color(0x7f7f7f) },
      tDiffuse: { value: null },
      textureMatrix: { value: new THREE.Matrix4() },
      uTime: { value: 0 },
      uFogColor: { value: globals.uFogColor.value },
      uFogDensity: { value: globals.uFogDensity.value },
      uCityRadius: { value: 120 },
      uReflect: { value: 1 },
      uPulse: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      uniform mat4 textureMatrix;
      varying vec4 vUvR;
      varying vec3 vWorld;
      void main() {
        vUvR = textureMatrix * vec4(position, 1.0);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      ${NOISE}
      ${FOG_PARS}
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uCityRadius;
      uniform float uReflect;
      uniform float uPulse;
      varying vec4 vUvR;
      varying vec3 vWorld;

      float gridLine(vec2 p, float size, float width) {
        vec2 g = abs(fract(p / size - 0.5) - 0.5) * size;
        vec2 fw = fwidth(p);
        vec2 l = 1.0 - smoothstep(vec2(0.0), fw * width, g);
        return max(l.x, l.y);
      }

      void main() {
        #include <clipping_planes_fragment>
        vec2 p = vWorld.xz;
        float dist = length(cameraPosition - vWorld);
        float r = length(p);

        // reflection (5-tap blur, slight ripple)
        vec2 ripple = vec2(vnoise(p * 0.05 + uTime * 0.1), vnoise(p * 0.05 - uTime * 0.1)) - 0.5;
        vec4 ru = vUvR;
        ru.xy += ripple * 0.6 * ru.w * 0.02;
        vec3 refl = vec3(0.0);
        float bl = 0.004 * ru.w;
        refl += texture2DProj(tDiffuse, ru).rgb * 0.4;
        refl += texture2DProj(tDiffuse, ru + vec4(bl, 0.0, 0.0, 0.0)).rgb * 0.15;
        refl += texture2DProj(tDiffuse, ru - vec4(bl, 0.0, 0.0, 0.0)).rgb * 0.15;
        refl += texture2DProj(tDiffuse, ru + vec4(0.0, bl, 0.0, 0.0)).rgb * 0.15;
        refl += texture2DProj(tDiffuse, ru - vec4(0.0, bl, 0.0, 0.0)).rgb * 0.15;

        vec3 base = vec3(0.006, 0.003, 0.016);
        refl = refl / (1.0 + refl * 1.6);
        vec3 col = base + refl * 0.38 * uReflect;

        // grids
        float minor = gridLine(p, 6.0, 1.2);
        float major = gridLine(p, 48.0, 1.6);
        float fade = exp(-dist * 0.0022);
        vec3 lc = mix(vec3(0.0, 0.85, 1.0), vec3(1.0, 0.12, 0.75), smoothstep(uCityRadius * 0.6, uCityRadius * 2.4, r));
        col += lc * (minor * 0.16 + major * 0.75) * fade;

        // city halo
        col += vec3(0.45, 0.05, 0.6) * 0.18 * exp(-pow(r / (uCityRadius * 1.25), 2.0));

        // outgoing pulse rings
        float period = 7.0;
        float ph = mod(uTime, period) / period;
        float ringR = ph * uCityRadius * 6.0;
        float ring = exp(-pow((r - ringR) / 4.0, 2.0)) * (1.0 - ph);
        col += vec3(0.1, 0.9, 1.0) * ring * (major * 3.0 + minor * 1.5 + 0.12) * fade;
        // event pulse (seek / commands)
        float ringE = exp(-pow((r - uPulse * uCityRadius * 4.0) / 5.0, 2.0)) * (1.0 - uPulse) * step(0.001, uPulse);
        col += vec3(1.0, 0.2, 0.9) * ringE * (major * 4.0 + minor * 2.0 + 0.25);

        col = applyFog(col, dist);
        gl_FragColor = vec4(col, 1.0);
      }`,
  };

  const size = 7000;
  const ground = new Reflector(new THREE.PlaneGeometry(size, size), {
    textureWidth: Math.floor(window.innerWidth * 0.5),
    textureHeight: Math.floor(window.innerHeight * 0.5),
    clipBias: 0.003,
    shader,
  }) as Reflector & { material: THREE.ShaderMaterial };
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.material.extensions = { ...(ground.material.extensions ?? {}), derivatives: true } as any;
  ground.material.clipping = true;

  const origBefore = ground.onBeforeRender;
  ground.onBeforeRender = function (this: Reflector, ...args: Parameters<typeof origBefore>) {
    // in a headset the reflection would re-render the whole city once per eye: skip it
    if (engine.quality >= 1 && !engine.presenting && !ground.material.clippingPlanes) origBefore.apply(this, args);
  } as typeof origBefore;

  const u = ground.material.uniforms;
  let pulseT = -1;
  engine.add((dt, t) => {
    u.uTime.value = t;
    u.uReflect.value = engine.quality >= 1 && !engine.presenting && !ground.material.clippingPlanes ? 1 : 0;
    if (pulseT >= 0) {
      pulseT += dt / 2.2;
      u.uPulse.value = Math.min(pulseT, 1);
      if (pulseT >= 1) {
        pulseT = -1;
        u.uPulse.value = 0;
      }
    }
  });

  return {
    mesh: ground,
    setCityRadius(r: number) {
      u.uCityRadius.value = r;
    },
    pulse() {
      pulseT = 0;
    },
  };
}
