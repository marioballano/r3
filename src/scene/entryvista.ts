import * as THREE from 'three';
import type { Model } from '../model';
import type { Tower } from './city';
import { DOOR_HEIGHT, DOOR_WIDTH, EYE_HEIGHT, type BlockRoom } from './interior';
import type { PassageEnd } from './passage';
import { textTexture } from './labels';
import { STREET_ARCH } from './doorway';

export function functionStrings(summary: string, model: Model, fi: number) {
  const strings = new Set<string>();
  const flags = new Set<string>();
  for (const line of summary.split('\n')) {
    const text = line.match(/^\s*0x[\da-f]+\s+(.*)$/i)?.[1];
    if (!text) continue;
    for (const [literal] of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      try {
        strings.add(JSON.parse(literal) as string);
      } catch {
        strings.add(literal.slice(1, -1));
      }
    }
    for (const [, flag] of text.matchAll(/(?:^|\s)(str\.[\w.]+)(?=\s|$)/gi)) flags.add(flag);
  }
  for (const ref of model.strOut[fi] ?? []) {
    const value = model.strings.get(ref.vaddr)?.string;
    if (value) {
      strings.add(value);
      flags.delete('str.' + value.replace(/[^a-z0-9]+/gi, '_'));
    }
  }
  return [...new Set([...strings, ...flags].map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

export class DoorSightline {
  readonly planes = Array.from({ length: 5 }, () => new THREE.Plane());
  private corners: THREE.Vector3[];
  private center: THREE.Vector3;
  private viewer = new THREE.Vector3();

  constructor(base: THREE.Vector3, private direction: THREE.Vector3, halfWidth: number, height: number, padding: number) {
    const across = new THREE.Vector3(-direction.z, 0, direction.x);
    this.center = base.clone().add(new THREE.Vector3(0, height / 2, 0));
    this.corners = [[-halfWidth, 0], [halfWidth, 0], [halfWidth, height], [-halfWidth, height]]
      .map(([side, y]) => base.clone().addScaledVector(across, side).add(new THREE.Vector3(0, y, 0)));
    this.planes[4].set(direction, -direction.dot(base) + padding);
  }

  aim(eye: THREE.Vector3) {
    const delta = this.viewer.copy(eye).sub(this.center).dot(this.direction);
    this.viewer.copy(eye).addScaledVector(this.direction, Math.min(0, -0.02 - delta));
    for (let i = 0; i < this.corners.length; i++) {
      const plane = this.planes[i].setFromCoplanarPoints(this.viewer, this.corners[i], this.corners[(i + 1) % 4]);
      if (plane.distanceToPoint(this.center) < 0) plane.negate();
    }
  }
}

function clipRoom(room: BlockRoom, sightline: DoorSightline) {
  const originals = new Map<THREE.Material, THREE.Plane[] | null>();
  room.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite || object instanceof THREE.LineSegments)) return;
    const mat = object.material as THREE.Material;
    if (originals.has(mat)) return;
    originals.set(mat, mat.clippingPlanes);
    mat.clippingPlanes = sightline.planes;
  });
  return () => { for (const [mat, planes] of originals) mat.clippingPlanes = planes; };
}

/** From a corridor, each room is only visible through its own opening. */
export class PassageRoomView {
  private sightline: DoorSightline;
  private unclip: (() => void) | null = null;

  constructor(private room: BlockRoom, private door: PassageEnd) {
    const base = door.eye.clone();
    base.y -= door.radius ?? EYE_HEIGHT;
    this.sightline = new DoorSightline(base, door.outward.clone().negate(), door.radius ?? DOOR_WIDTH / 2,
      door.radius ? door.radius * 2 : DOOR_HEIGHT, 0.02);
  }

  update(eye: THREE.Vector3, nearDoor: boolean) {
    const { eye: gate, outward } = this.door;
    const outside = (eye.x - gate.x) * outward.x + (eye.z - gate.z) * outward.z >= 0;
    this.room.group.visible = outside || nearDoor;
    if (outside) {
      this.sightline.aim(eye);
      this.unclip ??= clipRoom(this.room, this.sightline);
    } else this.releaseClip();
  }

  private releaseClip() {
    this.unclip?.();
    this.unclip = null;
  }

  release() {
    this.releaseClip();
    this.room.group.visible = true;
  }
}

/** Clip the live room against the street doorway while the viewer is outside. */
export class EntranceVista {
  private sightline: DoorSightline;
  private unclip: () => void;
  private surround: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  constructor(readonly room: BlockRoom) {
    const exit = room.exits.at(-1)!;
    exit.frame.visible = false;
    const { x, z } = room.doorwayPosition(exit);
    this.sightline = new DoorSightline(new THREE.Vector3(x, 0, z), new THREE.Vector3(0, 0, -1), STREET_ARCH.halfWidth, STREET_ARCH.height, 0.01);
    const { halfWidth, halfDepth, zeroGravity } = room;
    this.surround = new THREE.Mesh(
      zeroGravity ? new THREE.SphereGeometry(halfDepth + 0.08, 36, 24)
        : new THREE.BoxGeometry(halfWidth * 2 + 0.1, 4.83, halfDepth * 2 + 0.1),
      new THREE.MeshBasicMaterial({ color: 0x0d1324, side: THREE.BackSide }),
    );
    this.surround.position.y = zeroGravity ? 1.55 : 2.36;
    room.group.add(this.surround);
    this.unclip = clipRoom(room, this.sightline);
  }

  update(eye: THREE.Vector3, t: number) {
    this.sightline.aim(eye);
    this.room.animate(t);
  }

  setSummary(summary: string) {
    this.unclip();
    this.room.setSummary(summary);
    this.unclip = clipRoom(this.room, this.sightline);
  }

  release() {
    this.unclip();
    this.room.group.remove(this.surround);
    this.surround.geometry.dispose();
    this.surround.material.dispose();
    this.room.exits.at(-1)!.frame.visible = true;
  }

  dispose() {
    this.room.dispose();
  }
}

export class FacadeStrings {
  readonly group = new THREE.Group();
  private page = -1;
  private plane = new THREE.PlaneGeometry(1, 1);
  private labels = new Map<string, THREE.MeshBasicMaterial>();
  private floors: number[];
  private labelHeight: number;

  constructor(private tower: Tower, private strings: string[]) {
    const bottom = 2.64;
    const top = tower.height - 0.05;
    this.labelHeight = Math.min(0.31, top - bottom);
    const last = top - this.labelHeight / 2;
    const first = Math.min(2.91, last);
    const count = Math.max(1, 1 + Math.floor((last - first) / 1.05));
    this.floors = Array.from({ length: count }, (_, i) => count === 1 ? last : THREE.MathUtils.lerp(first, last, i / (count - 1)));
    this.group.position.copy(tower.pos);
    this.group.position.z += tower.width / 2;
  }

  update(t: number) {
    const pages = Math.ceil(this.strings.length / this.floors.length);
    const page = Math.floor(t / 4.5) % pages;
    if (page === this.page) return;
    this.page = page;
    this.clear();
    for (const [i, y] of this.floors.entries()) {
      const offset = page * this.floors.length + i;
      const word = this.strings[offset % this.strings.length];
      let material = this.labels.get(word);
      if (!material) {
        const text = Array.from(word);
        const label = text.length > 58 ? text.slice(0, 57).join('') + '…' : word;
        const map = textTexture([{ text: label, color: '#dbffff' }], 'transparent', 68);
        material = new THREE.MeshBasicMaterial({
          map, transparent: true, depthWrite: false, toneMapped: false, alphaTest: 0.08,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        this.labels.set(word, material);
      }
      const lettering = new THREE.Mesh(this.plane, material);
      const { width, height } = material.map!.image;
      const size = Math.min(this.labelHeight, (this.tower.width - 0.16) * height / width);
      lettering.scale.set(size * width / height, size, 1);
      lettering.position.y = y;
      lettering.name = word;
      this.group.add(lettering);
    }
  }

  private clear() {
    for (const material of this.labels.values()) {
      material.map?.dispose();
      material.dispose();
    }
    this.labels.clear();
    this.group.clear();
  }

  dispose() {
    this.clear();
    this.plane.dispose();
  }
}
