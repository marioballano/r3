import * as THREE from 'three';

export const STREET_ARCH = { halfWidth: 0.67, height: 2.08 };

export function archHalfWidthAt(y: number, halfWidth: number, height: number) {
  if (y < 0 || y >= height) return 0;
  const rise = Math.max(0, y - (height - halfWidth));
  return Math.sqrt(halfWidth * halfWidth - rise * rise);
}

export function archFrameGeometry(halfWidth: number, height: number) {
  const spring = height - halfWidth;
  const outer = halfWidth + 0.08;
  const shape = new THREE.Shape();
  shape.moveTo(-outer, 0);
  shape.lineTo(-outer, spring);
  shape.absarc(0, spring, outer, Math.PI, 0, true);
  shape.lineTo(outer, 0);
  shape.lineTo(halfWidth, 0);
  shape.lineTo(halfWidth, spring);
  shape.absarc(0, spring, halfWidth, 0, Math.PI, false);
  shape.lineTo(-halfWidth, 0);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -0.06);
}

export function wallAboveArch(halfWidth: number, height: number, wallHeight: number) {
  const spring = height - halfWidth;
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth, spring);
  shape.absarc(0, spring, halfWidth, Math.PI, 0, true);
  shape.lineTo(halfWidth, wallHeight);
  shape.lineTo(-halfWidth, wallHeight);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -0.09);
}
