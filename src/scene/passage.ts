import * as THREE from 'three';
import { EYE_HEIGHT, LiftDoors, WALK_RADIUS } from './interior';

export interface PassageEnd {
  eye: THREE.Vector3;
  outward: THREE.Vector3;
  radius?: number;
}

const HALF_WIDTH = 0.9;
const HEIGHT = 2.62;
const RAIL_BRIGHTNESS = 0.78;

export function isDirectPassage(start: PassageEnd, end: PassageEnd) {
  return start.eye.distanceToSquared(end.eye) < 0.01;
}

function passagePath(start: PassageEnd, end: PassageEnd, slide: boolean, reverse: boolean) {
  if (reverse) [start, end] = [end, start];
  const distance = start.eye.distanceTo(end.eye);
  const handle = Math.min(3.8, Math.max(0.25, distance * 0.28));
  const join = end.eye.clone().addScaledVector(end.outward, handle);
  if (slide) join.y += 1.3;
  const curve = new THREE.CatmullRomCurve3([
    start.eye, start.eye.clone().addScaledVector(start.outward, handle), join, end.eye,
  ]);
  const segments = Math.max(8, Math.min(320, Math.ceil(distance / 0.36)));
  const points = curve.getSpacedPoints(segments);
  if (reverse) points.reverse();
  const length = curve.getLength();
  return { points, length, samplesPerUnit: segments / length };
}

function passageSides(points: THREE.Vector3[], count = points.length) {
  return points.slice(0, count).map((point, i) => {
    const tangent = points[Math.min(i + 1, points.length - 1)].clone().sub(points[Math.max(0, i - 1)]).setY(0).normalize();
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(HALF_WIDTH);
    const floor = raise(point, -EYE_HEIGHT);
    return [floor.clone().sub(side), floor.add(side)];
  });
}

function raise(point: THREE.Vector3, height: number) {
  const raised = point.clone();
  raised.y += height;
  return raised;
}

function appendRibbon(positions: number[], rows: THREE.Vector3[][]) {
  for (let i = 1; i < rows.length; i++) {
    const [a, b] = rows[i - 1], [c, d] = rows[i];
    for (const p of [a, b, c, c, b, d]) positions.push(p.x, p.y, p.z);
  }
}

function appendRails(positions: number[], sides: THREE.Vector3[][]) {
  for (const side of [0, 1]) {
    for (const height of [0.12, HEIGHT - 0.14]) {
      appendRibbon(positions, sides.map((pair) => {
        const inset = pair[side].clone().lerp(pair[1 - side], 0.007);
        return [raise(inset, height), raise(inset, height + 0.04)];
      }));
    }
  }
}

function corridorGeometry(positions: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function appendShell(positions: number[], colors: number[], sides: THREE.Vector3[][], railColor: THREE.Color) {
  const tint = (color: THREE.Color) => {
    while (colors.length < positions.length) colors.push(color.r, color.g, color.b);
  };
  appendRibbon(positions, sides);
  appendRibbon(positions, sides.map(([a, b]) => [raise(a, HEIGHT), raise(b, HEIGHT)]));
  tint(new THREE.Color(0x202d43));
  for (const side of [0, 1]) {
    appendRibbon(positions, sides.map((pair) => [pair[side], raise(pair[side], HEIGHT)]));
  }
  tint(new THREE.Color(0x26384e));
  appendRails(positions, sides);
  tint(railColor.clone().multiplyScalar(RAIL_BRIGHTNESS));
}

function corridorShell(positions: number[], colors: number[], name: string) {
  const geometry = corridorGeometry(positions);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.name = name;
  return mesh;
}

export function corridorEntrances(routes: { start: PassageEnd; end: PassageEnd; color: THREE.Color; slide: boolean; reverse: boolean }[]) {
  const positions: number[] = [], colors: number[] = [];
  const doors: number[] = [], openings: number[] = [];
  for (const { start, end, color, slide, reverse } of routes) {
    if (isDirectPassage(start, end)) continue;
    const { points, samplesPerUnit } = passagePath(start, end, slide, reverse);
    appendShell(positions, colors, passageSides(points, Math.max(2, Math.ceil(10 * samplesPerUnit) + 1)), color);
    while (doors.length < positions.length) {
      doors.push(start.eye.x, start.radius ? start.eye.y : start.eye.y - EYE_HEIGHT, start.eye.z);
      openings.push(start.outward.x, start.outward.z, start.radius ?? 0);
    }
  }
  const mesh = corridorShell(positions, colors, 'Corridor entrances');
  mesh.geometry.setAttribute('doorBase', new THREE.Float32BufferAttribute(doors, 3));
  mesh.geometry.setAttribute('doorOpening', new THREE.Float32BufferAttribute(openings, 3));
  // Nearby routes can overlap outside a room. Only show a corridor through its own doorway.
  const varyings = 'varying vec3 vDoorBase; varying vec3 vDoorOpening; varying vec3 vCorridorPosition;';
  mesh.material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${varyings}\nattribute vec3 doorBase; attribute vec3 doorOpening;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vDoorBase = doorBase;
        vDoorOpening = doorOpening;
        vCorridorPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${varyings}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        vec2 outward = vDoorOpening.xy;
        float viewerSide = dot(cameraPosition.xz - vDoorBase.xz, outward);
        float corridorSide = dot(vCorridorPosition.xz - vDoorBase.xz, outward);
        if (viewerSide >= 0.0 || corridorSide < 0.0) discard;
        vec3 opening = mix(cameraPosition, vCorridorPosition, -viewerSide / (corridorSide - viewerSide)) - vDoorBase;
        float across = dot(opening.xz, vec2(-outward.y, outward.x));
        float radius = vDoorOpening.z;
        if (radius > 0.0) {
          if (across * across + opening.y * opening.y > radius * radius) discard;
        } else if (opening.y < 0.0 || opening.y > ${HEIGHT} || abs(across) > ${HALF_WIDTH}) discard;`);
  };
  return mesh;
}

/** A corridor follows the doors' world coordinates and constrains normal player movement. */
export class WalkPassage {
  readonly group = new THREE.Group();
  readonly length: number;
  private path: THREE.Vector3[];
  private samplesPerUnit: number;
  private progress = 0;
  private lifts: [LiftDoors, LiftDoors] | null = null;

  constructor(private start: PassageEnd, private end: PassageEnd, color: THREE.Color, slide: boolean, elevator: boolean, private entryDepth: number,
    readonly reverse: boolean) {
    this.group.name = 'Walk passage';
    const { points, length, samplesPerUnit } = passagePath(start, end, slide, reverse);
    this.path = points;
    this.length = length;
    this.samplesPerUnit = samplesPerUnit;
    const positions: number[] = [], colors: number[] = [];
    appendShell(positions, colors, passageSides(points), color);
    this.group.add(corridorShell(positions, colors, 'Corridor shell'));
    this.addChevrons();
    if (elevator) {
      this.lifts = [this.lift(start, color), this.lift(end, color)];
      this.lifts[1].close(1);
    }
  }

  get travelled() { return this.progress / this.samplesPerUnit; }

  get speedScale() {
    const distanceToDoor = Math.min(this.travelled, this.length - this.travelled);
    const scale = THREE.MathUtils.clamp(this.length / 24, 1, 3);
    return THREE.MathUtils.lerp(1, scale, THREE.MathUtils.smoothstep(distanceToDoor, 1, 6));
  }

  private addChevrons() {
    const points: number[] = [];
    const spacing = Math.max(2, Math.round(this.samplesPerUnit * 2.8));
    const path = this.reverse ? this.path.slice().reverse() : this.path;
    for (let i = 1; i < path.length - 1; i += spacing) {
      const direction = path[i + 1].clone().sub(path[i - 1]).normalize();
      const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
      const tail = raise(path[i], 0.045 - EYE_HEIGHT);
      const tip = tail.clone().addScaledVector(direction, 0.48);
      for (const arm of [-1, 1]) {
        const end = tail.clone().addScaledVector(side, arm * 0.35);
        appendRibbon(points, [[end, end.clone().addScaledVector(direction, 0.11)], [tip, tip.clone().addScaledVector(direction, 0.11)]]);
      }
    }
    const arrows = new THREE.Mesh(corridorGeometry(points), new THREE.MeshBasicMaterial({ color: 0x63edff, side: THREE.DoubleSide }));
    arrows.name = 'Corridor direction chevrons';
    this.group.add(arrows);
  }

  private lift(end: PassageEnd, color: THREE.Color) {
    const lift = new LiftDoors(color);
    lift.group.position.copy(end.eye).addScaledVector(end.outward, 0.04);
    lift.group.position.y -= EYE_HEIGHT;
    lift.group.rotation.y = Math.atan2(end.outward.x, end.outward.z);
    this.group.add(lift.group);
    return lift;
  }

  heading(eye: THREE.Vector3, direction: 1 | -1) {
    const last = this.path.length - 1;
    const ahead = this.progress + direction * 1.15 * this.samplesPerUnit;
    const index = Math.floor(THREE.MathUtils.clamp(ahead, 0, last - 1));
    const target = this.path[index].clone().lerp(this.path[index + 1], THREE.MathUtils.clamp(ahead - index, 0, 1));
    // Aim past the threshold so holding the movement key carries you into the room.
    if (ahead < 0) target.addScaledVector(this.start.outward, Math.min(ahead / this.samplesPerUnit, -this.entryDepth - 0.25));
    if (ahead > last) target.addScaledVector(this.end.outward, (last - ahead) / this.samplesPerUnit);
    return target.sub(eye).normalize();
  }

  move(pos: THREE.Vector3): { floor: number; arrived?: boolean } {
    const last = this.path.length - 2;
    let best = Infinity;
    let step = Math.floor(this.progress);
    let along = 0;
    for (let i = Math.max(0, step - 6), end = Math.min(last, step + 6); i <= end; i++) {
      const a = this.path[i], b = this.path[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((pos.x - a.x) * dx + (pos.z - a.z) * dz) / Math.max(dx * dx + dz * dz, 1e-6), 0, 1);
      const d = (pos.x - a.x - dx * t) ** 2 + (pos.z - a.z - dz * t) ** 2;
      if (d >= best) continue;
      best = d;
      step = i;
      along = t;
    }
    this.progress = step + along;
    const center = this.path[step].clone().lerp(this.path[step + 1], along);
    const endpoint = step === 0 && along === 0 ? this.start : step === last && along === 1 ? this.end : null;
    const offset = new THREE.Vector3(pos.x - center.x, 0, pos.z - center.z);
    const forward = endpoint ? Math.min(0, offset.dot(endpoint.outward)) : 0;
    if (endpoint) offset.addScaledVector(endpoint.outward, -forward);
    const width = HALF_WIDTH - WALK_RADIUS;
    if (offset.lengthSq() > width * width) offset.setLength(width);
    if (endpoint) offset.addScaledVector(endpoint.outward, forward);
    pos.x = center.x + offset.x;
    pos.z = center.z + offset.z;
    pos.y = center.y;
    if (this.lifts) {
      const progress = step + along;
      this.lifts[0].close(THREE.MathUtils.smoothstep(progress, 3, 8));
      this.lifts[1].close(1 - THREE.MathUtils.smoothstep(progress, last - 8, last - 3));
    }
    if (endpoint && forward < -(endpoint === this.start ? this.entryDepth : WALK_RADIUS + 0.04)) {
      return { floor: center.y, arrived: endpoint === this.end };
    }
    return { floor: center.y };
  }

  dispose() {
    const materials = new Set<THREE.Material>();
    const geometry = new Set<THREE.BufferGeometry>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      materials.add(object.material as THREE.Material);
      geometry.add(object.geometry);
    });
    for (const mat of materials) mat.dispose();
    for (const geo of geometry) geo.dispose();
  }
}
