import * as THREE from 'three';
import type { City } from './city';

const ATLAS = 1024;
const WIDTH = 256;
const HEIGHT = 40;
const COLUMNS = ATLAS / WIDTH;
const PAGE = COLUMNS * Math.floor(ATLAS / HEIGHT);

/** All street nameplates share compact text atlases and keep their orientation on the facade. */
export class DoorNames {
  readonly group = new THREE.Group();

  constructor(city: City) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ATLAS;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let start = 0; start < city.towers.length; start += PAGE) {
      const towers = city.towers.slice(start, start + PAGE);
      const placements = new Float32Array(towers.length * 4);
      const widths = new Float32Array(towers.length);
      const cells = new Float32Array(towers.length * 2);
      ctx.clearRect(0, 0, ATLAS, ATLAS);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 27px "JetBrains Mono", monospace';
      towers.forEach((tower, i) => {
        const name = tower.fn.name || '0x' + tower.fn.addr.toString(16);
        const x = (i % COLUMNS) * WIDTH;
        const y = Math.floor(i / COLUMNS) * HEIGHT;
        ctx.fillText(name, x + WIDTH / 2, y + HEIGHT / 2, WIDTH - 12);
        const base = city.streetPosition(tower);
        placements.set([base.x, 2.42, base.z + tower.width / 2 + 0.10, 0.36], i * 4);
        widths[i] = Math.min(tower.width - 0.08, 2.14);
        cells.set([x / ATLAS, y / ATLAS], i * 2);
      });
      const rgba = ctx.getImageData(0, 0, ATLAS, ATLAS).data;
      const alpha = new Uint8Array(ATLAS * ATLAS);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      const texture = new THREE.DataTexture(alpha, ATLAS, ATLAS, THREE.RedFormat);
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = quad.index;
      geometry.setAttribute('position', quad.getAttribute('position'));
      geometry.setAttribute('uv', quad.getAttribute('uv'));
      geometry.setAttribute('aPlace', new THREE.InstancedBufferAttribute(placements, 4));
      geometry.setAttribute('aWidth', new THREE.InstancedBufferAttribute(widths, 1));
      geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      geometry.instanceCount = towers.length;
      const material = new THREE.ShaderMaterial({
        uniforms: { uText: { value: texture }, uCell: { value: new THREE.Vector2(WIDTH / ATLAS, HEIGHT / ATLAS) } },
        transparent: true,
        depthWrite: false,
        vertexShader: `
          attribute vec4 aPlace;
          attribute float aWidth;
          attribute vec2 aCell;
          uniform vec2 uCell;
          varying vec2 vUv;
          void main() {
            vUv = aCell + vec2(uv.x, 1.0 - uv.y) * uCell;
            vec3 p = aPlace.xyz + vec3(position.x * aWidth, position.y * aPlace.w, 0.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `
          uniform sampler2D uText;
          varying vec2 vUv;
          void main() {
            float alpha = texture2D(uText, vUv).r;
            if (alpha < 0.016) discard;
            gl_FragColor = vec4(0.70, 0.90, 0.97, alpha);
          }`,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  dispose() {
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
      mesh.geometry.dispose();
      (mesh.material.uniforms.uText.value as THREE.DataTexture).dispose();
      mesh.material.dispose();
    }
  }
}
