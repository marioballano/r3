import * as THREE from 'three';
import { blockCondition, graphEdges, type Edge } from '../flow';
import type { Model } from '../model';
import { hex, type Block, type FnGraph } from '../types';
import { EDGE_COLORS, opColor } from './funcview';
import { textTexture } from './labels';
import { archFrameGeometry, archHalfWidthAt, STREET_ARCH, wallAboveArch } from './doorway';

export const EYE_HEIGHT = 1.55;
export const WALK_RADIUS = 0.32;
const ROOM_HEIGHT = 4.7;
const FLOOR_HEIGHT = 6;
export const DOOR_WIDTH = 1.8;
export const DOOR_HEIGHT = 2.65;
const ROOM_DOOR = { halfWidth: DOOR_WIDTH / 2, height: DOOR_HEIGHT };
const SWITCH_DOOR_RADIUS = 1.21;
const DOOR_SPACING = 3.3;
const BACK_COLOR = new THREE.Color(0xf1acff);
const PAGE_SIZE = 12;

export class InteriorPlan {
  readonly blocks: Map<number, Block>;
  readonly entry: Block;
  private edges = new Map<number, Edge[]>();
  private levels = new Map<number, number>();
  private depths = new Map<number, number>();
  private positions = new Map<number, THREE.Vector3>();

  constructor(readonly fi: number, readonly graph: FnGraph, tower?: { x: number; z: number; width: number }) {
    this.blocks = new Map(graph.blocks.map((b) => [b.addr, b]));
    this.entry = this.blocks.get(graph.addr)
      ?? graph.blocks.find((b) => graph.addr >= b.addr && graph.addr < b.addr + b.size) ?? graph.blocks[0];
    for (const edge of graphEdges(graph)) {
      let outgoing = this.edges.get(edge.from);
      if (!outgoing) this.edges.set(edge.from, outgoing = []);
      outgoing.push(edge);
    }
    this.levels.set(this.entry.addr, 0);
    const queue = [this.entry.addr];
    for (const from of queue) {
      for (const edge of this.outgoing(from)) {
        if (this.levels.has(edge.to)) continue;
        this.levels.set(edge.to, this.floor(from) + 1);
        queue.push(edge.to);
      }
    }
    const floors: number[][] = [];
    for (const addr of this.blocks.keys()) (floors[this.floor(addr)] ??= []).push(addr);
    let z = 0;
    let lastDepth = 0;
    for (const [level, row] of floors.entries()) {
      const center = level === 0 ? row.indexOf(this.entry.addr) : (row.length - 1) / 2;
      let depth = 0;
      for (const addr of row) {
        const block = this.blocks.get(addr)!;
        const exits = this.outgoing(addr);
        const halfDepth = roomHalfDepth(disassembly(block).length, exits);
        this.depths.set(addr, halfDepth);
        depth = Math.max(depth, halfDepth);
      }
      if (level > 0) z -= lastDepth + depth + 6;
      else if (tower) {
        z = tower.z + tower.width / 2 - this.halfDepth(this.entry.addr);
      }
      lastDepth = depth;
      const pitch = Math.max(16, depth * 2 + 4);
      row.forEach((addr, column) => this.positions.set(addr, new THREE.Vector3((tower?.x ?? 0) + (column - center) * pitch, level * FLOOR_HEIGHT, z)));
    }
  }

  outgoing(addr: number) { return this.edges.get(addr) ?? []; }
  floor(addr: number) { return this.levels.get(addr) ?? 0; }
  halfDepth(addr: number) { return this.depths.get(addr)!; }
  position(addr: number) { return this.positions.get(addr)!.clone(); }

  returnDoorway(addr: number): RoomDoorway {
    return { x: 0, y: EYE_HEIGHT, z: this.halfDepth(addr), nx: 0, nz: 1 };
  }

  blockAt(addr: number) {
    return this.blocks.get(addr) ?? this.graph.blocks.find((b) => addr >= b.addr && addr < b.addr + b.size);
  }
}

export interface RoomExit {
  edge: Edge | null;
  label: string;
  endpoint: string;
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  lift: number;
  elevator: boolean;
  radius?: number;
  slide: boolean;
  light: THREE.MeshBasicMaterial;
  color: THREE.Color;
  frame: THREE.Group;
  destination: { plan: InteriorPlan; block: Block; doorway?: RoomDoorway; slide?: boolean } | null;
}

export type RoomDoorway = Pick<RoomExit, 'x' | 'y' | 'z' | 'nx' | 'nz' | 'radius'>;

export interface RoomArrival {
  doorway?: RoomDoorway;
  slide?: boolean;
  pose?: { pos: THREE.Vector3; target: THREE.Vector3 };
}

export interface Word {
  text: string;
  site?: number;
  target?: number;
  callee?: number;
}

type RoomDestination = NonNullable<RoomExit['destination']>;

function disposeGroup(group: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  group.traverse((item) => {
    if (item instanceof THREE.Mesh || item instanceof THREE.LineSegments) geometries.add(item.geometry);
    if (item instanceof THREE.Mesh || item instanceof THREE.LineSegments || item instanceof THREE.Sprite) materials.add(item.material);
  });
  for (const geo of geometries) geo.dispose();
  for (const mat of materials) {
    if ('map' in mat && mat.map instanceof THREE.Texture) textures.add(mat.map);
    if ('alphaMap' in mat && mat.alphaMap instanceof THREE.Texture) textures.add(mat.alphaMap);
    mat.dispose();
  }
  for (const tex of textures) tex.dispose();
}

function trimText(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function disassembly(block: Block) {
  const lines: { text: string; color: string }[] = [];
  for (const op of block.ops ?? []) {
    for (const flag of op.flags ?? []) {
      if (flag !== 'pc') for (const part of flag.match(/.{1,76}/gu) ?? []) lines.push({ text: `; ${part}`, color: '#9b94bb' });
    }
    const line = `${hex(op.addr)}  ${op.disasm ?? op.opcode ?? '???'}`;
    for (const [i, part] of (line.match(/.{1,78}/gu) ?? []).entries()) {
      lines.push({ text: i === 0 ? part : '    ' + part, color: opColor(op.type) });
    }
  }
  return lines.length ? lines : [{ text: 'No instructions reported for this block', color: '#bfb8d9' }];
}

function matrixColumns(count: number) {
  return Math.ceil(Math.sqrt(count * 1.22));
}

function roomHalfDepth(lines: number, exits: Edge[]) {
  if (exits.length > 2) {
    const columns = matrixColumns(exits.length);
    const rows = Math.ceil(exits.length / columns);
    return Math.max(7.2, Math.hypot(columns * 1.62, rows * 1.92) + 2.5, Math.ceil(lines / 20) * 1.85);
  }
  const slides = exits.filter((edge) => edge.kind === 'case').length;
  return Math.max(6.3, Math.max(Math.ceil(lines / 20), slides) * DOOR_SPACING / 2 + 1);
}

function doorSize(street: boolean) {
  return street ? STREET_ARCH : ROOM_DOOR;
}

function caseLabel(value: number) {
  if (!Number.isInteger(value) || value < 32 || value > 126) return `CASE ${value}`;
  const character = value === 32 ? 'SPACE' : JSON.stringify(String.fromCharCode(value));
  return `CASE ${character} · ${value}`;
}

function sphereFront(radius: number, x: number, y: number) {
  return -Math.sqrt(Math.max(0, radius * radius - x * x - y * y));
}

function sphereDoorMask(radius: number, exits: RoomExit[]) {
  const width = 1024, height = 512;
  const pixels = new Uint8Array(width * height * 4).fill(255);
  const openings = exits.map((exit) => ({ exit, ...doorSize(!exit.edge && !exit.destination) }));
  for (let row = 0; row < height; row++) {
    const theta = Math.PI * (1 - (row + 0.5) / height);
    const y = Math.cos(theta) * radius + EYE_HEIGHT;
    const ring = Math.sin(theta) * radius;
    for (const { exit, halfWidth, height: openingHeight } of openings) {
      const localY = y - exit.y + EYE_HEIGHT;
      const heightFromCenter = y - exit.y;
      if (exit.radius ? Math.abs(heightFromCenter) >= exit.radius : localY < 0 || localY > openingHeight) continue;
      const widthAtY = exit.radius ? Math.sqrt(exit.radius ** 2 - heightFromCenter ** 2)
        : exit.edge ? halfWidth : archHalfWidthAt(localY, halfWidth, openingHeight);
      const phi = (x: number) => Math.acos(THREE.MathUtils.clamp(-x / ring, -1, 1)) / (Math.PI * 2);
      const left = phi(exit.x - widthAtY), right = phi(exit.x + widthAtY);
      const from = Math.round((exit.nz < 0 ? 1 - right : left) * width);
      const to = Math.round((exit.nz < 0 ? 1 - left : right) * width);
      pixels.fill(0, (row * width + from) * 4, (row * width + to) * 4);
    }
  }
  const mask = new THREE.DataTexture(pixels, width, height);
  mask.needsUpdate = true;
  return mask;
}

function summaryWords(block: Block, fi: number, summary: string, model: Model): Word[] {
  const words: Word[] = [];
  const calls = new Map<number, Word>();
  const ops = block.ops ?? [];
  const opsByAddr = new Map(ops.map((op) => [op.addr, op]));
  const known = new Map(model.out[fi].map((call) => [call.site, call.callee]));
  for (const op of ops) {
    const callee = known.get(op.addr);
    if (!op.type?.includes('call') && callee === undefined) continue;
    const target = callee === undefined ? op.jump ?? op.refs?.find((ref) => ref.type === 'CALL')?.addr : model.fns[callee].addr;
    const index = callee ?? (target === undefined ? -1 : model.fnAt(target));
    calls.set(op.addr, { text: index >= 0 ? model.fns[index].name : op.disasm ?? op.opcode ?? 'Indirect call', site: op.addr,
      target, callee: index >= 0 ? index : undefined });
  }
  const seen = new Set<string>();
  for (const line of summary.split('\n')) {
    const parsed = line.trim().match(/^(0x[\da-f]+)\s+(.+)$/i);
    if (!parsed) continue;
    const addr = Number(parsed[1]);
    const text = parsed[2];
    if (addr < block.addr || addr >= block.addr + Math.max(1, block.size) || seen.has(line)) continue;
    seen.add(line);
    const call = calls.get(addr);
    const instruction = opsByAddr.get(addr);
    if (call && instruction && [instruction.disasm, instruction.opcode].some((s) => s?.trim() === text)) {
      words.push({ ...call, text });
      calls.delete(addr);
    } else words.push({ text });
  }
  for (const ref of model.strOut[fi]) {
    if (ref.site < block.addr || ref.site >= block.addr + block.size) continue;
    const entry = model.strings.get(ref.vaddr);
    if (entry && !words.some((word) => word.text.includes(entry.string))) words.push({ text: JSON.stringify(entry.string) });
  }
  words.push(...calls.values());
  return words;
}

export class BlockRoom {
  readonly group = new THREE.Group();
  readonly exits: RoomExit[] = [];
  readonly floor: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly zeroGravity: boolean;
  readonly condition: ReturnType<typeof blockCondition> | null;
  private summary: string | null = null;
  private words: Word[] = [];
  readonly calls: Word[] = [];
  private floating = new THREE.Group();
  private sprites: { sprite: THREE.Sprite; home: THREE.Vector3; word: Word }[] = [];
  private orb: THREE.Mesh | null = null;
  private orbRings: THREE.Mesh[] = [];
  private labeledExits = new Set<RoomExit>();
  private nextLabelUpdate = 0;
  private loadingLabel = false;
  private disposed = false;
  private unit = new THREE.BoxGeometry(1, 1, 1);
  private wall = new THREE.MeshBasicMaterial({ color: 0x252d45 });
  private trim = new THREE.MeshBasicMaterial({ color: 0x3c4870 });
  private page = 0;
  private callIndex = -1;
  private exitIndex = -1;

  constructor(
    readonly plan: InteriorPlan,
    readonly block: Block,
    private model: Model,
    summary: string,
    back: RoomDestination | null,
    private readSummary: (addr: number) => Promise<string>,
  ) {
    this.floor = plan.floor(block.addr);
    this.group.position.copy(plan.position(block.addr));
    const edges = plan.outgoing(block.addr);
    const doors = edges.filter((e) => e.kind !== 'case');
    const slides = edges.filter((e) => e.kind === 'case');
    const disasm = disassembly(block);
    const panels = Math.ceil(disasm.length / 20);
    this.zeroGravity = edges.length > 2;
    this.halfDepth = plan.halfDepth(block.addr);
    this.halfWidth = this.zeroGravity ? this.halfDepth : Math.max(5.4, doors.length * DOOR_SPACING / 2 + 1.2);
    const label = (edge: Edge) => edge.kind === 'case' ? caseLabel(edge.value!) : edge.kind === 'jump' ? 'TRUE' : edge.kind === 'fail' ? 'FALSE' : 'NEXT';
    if (this.zeroGravity) {
      const columns = matrixColumns(edges.length);
      const rows = Math.ceil(edges.length / columns);
      edges.forEach((edge, i) => {
        const row = Math.floor(i / columns);
        const short = Math.min(columns, edges.length - row * columns);
        const x = (i % columns - (short - 1) / 2) * DOOR_SPACING;
        const y = (row - (rows - 1) / 2) * 3.8;
        const z = sphereFront(this.halfDepth, x, y);
        this.addExit(edge, label(edge), x, z, 0, -1, plan.floor(edge.to) - this.floor, this.destination(edge), null, y + EYE_HEIGHT);
      });
    } else {
      this.box(this.halfWidth * 2, 0.24, this.halfDepth * 2, 0, -0.101, 0, new THREE.MeshBasicMaterial({ color: 0x111b2d }));
      this.box(this.halfWidth * 2, 0.22, this.halfDepth * 2, 0, ROOM_HEIGHT, 0, new THREE.MeshBasicMaterial({ color: 0x0b0e1e }));
      this.box(0.18, ROOM_HEIGHT, this.halfDepth * 2, -this.halfWidth, ROOM_HEIGHT / 2, 0, this.wall);
      this.addFloorGrid();

      doors.forEach((edge, i) => {
        const lift = plan.floor(edge.to) - this.floor;
        this.addExit(edge, label(edge), (i - (doors.length - 1) / 2) * DOOR_SPACING, -this.halfDepth, 0, -1, lift, this.destination(edge));
      });
      slides.forEach((edge, i) => this.addExit(edge, label(edge), this.halfWidth,
        (i - (slides.length - 1) / 2) * DOOR_SPACING, 1, 0, 0, this.destination(edge)));
    }
    const backLabel = back
      ? back.plan === plan ? `F${plan.floor(back.block.addr)}  ${hex(back.block.addr)}` : back.plan.graph.name
      : plan.graph.name;
    const returnLift = back?.plan === plan ? plan.floor(back.block.addr) - this.floor : 0;
    const door = plan.returnDoorway(block.addr);
    this.addExit(null, back ? 'BACK' : 'STREET EXIT', door.x, door.z, door.nx, door.nz, returnLift, backLabel, back, door.y);

    if (this.zeroGravity) {
      const alphaMap = sphereDoorMask(this.halfDepth, this.exits);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(this.halfDepth, 64, 40),
        new THREE.MeshBasicMaterial({ color: this.wall.color, alphaMap, alphaTest: 0.5, side: THREE.DoubleSide }));
      const lattice = new THREE.Mesh(new THREE.SphereGeometry(this.halfDepth - 0.08, 24, 14),
        new THREE.MeshBasicMaterial({ color: 0x353f5a, alphaMap, alphaTest: 0.5, wireframe: true }));
      sphere.position.y = lattice.position.y = EYE_HEIGHT;
      this.group.add(sphere, lattice);
    } else {
      this.wallWithDoors(0, -1);
      this.wallWithDoors(1, 0);
      this.wallWithDoors(0, 1);
      for (const x of [-this.halfWidth + 0.22, this.halfWidth - 0.22]) {
        this.box(0.08, 0.025, this.halfDepth * 2 - 0.25, x, 0.013, 0, this.trim);
        this.box(0.15, 0.055, this.halfDepth * 2 - 0.35, x, ROOM_HEIGHT - 0.16, 0, this.trim);
      }
      const ceiling = new THREE.MeshBasicMaterial({ color: 0x2c4b80 });
      for (const x of [-1.75, 1.75]) {
        this.box(0.055, 0.025, this.halfDepth * 2 - 0.25, x, ROOM_HEIGHT - 0.12, 0, ceiling);
      }
    }
    for (let i = 0; i < panels; i++) {
      const z = (i - (panels - 1) / 2) * DOOR_SPACING;
      this.sign([
        { text: `DISASSEMBLY   ${i + 1}/${panels}`, color: '#63dfef' },
        ...disasm.slice(i * 20, (i + 1) * 20),
      ], this.zeroGravity ? -Math.sqrt(this.halfDepth ** 2 - z * z) + 0.81 : -this.halfWidth + 0.105,
      2.03, z, Math.PI / 2, 0.103, 3.14);
    }
    this.sign([{ text: block === plan.entry ? 'ENTRY POINT' : 'BASIC BLOCK', color: '#7ce3ff' },
      { text: `FLOOR ${this.floor}   ${hex(block.addr)}`, color: '#edeaff' }],
    0, this.zeroGravity ? this.halfDepth * 0.78 : 4.06, this.zeroGravity ? -this.halfDepth * 0.58 : -this.halfDepth + 0.1,
    0, 0.16, this.halfWidth * 1.7);

    this.condition = edges.length > 1 ? blockCondition(block) : null;
    if (this.condition) this.addPillar();
    this.group.add(this.floating);
    this.setSummary(summary);
  }

  get floorY() { return this.group.position.y; }

  private destination(edge: Edge) {
    const type = edge.kind === 'case' && !this.zeroGravity ? 'SLIDE  ' : '';
    return `${type}F${this.plan.floor(edge.to)}  ${hex(edge.to)}`;
  }

  private addFloorGrid() {
    const points: number[] = [];
    const x = this.halfWidth - 0.20;
    const z = this.halfDepth - 0.20;
    for (let i = -Math.floor(x); i < x; i += 1) points.push(i, 0.026, -z, i, 0.026, z);
    for (let i = -Math.floor(z); i < z; i += 1) points.push(-x, 0.026, i, x, 0.026, i);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x273755 })));
  }

  private box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.MeshBasicMaterial) {
    const mesh = new THREE.Mesh(this.unit, mat);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    return mesh;
  }

  private sign(lines: { text: string; color: string }[], x: number, y: number, z: number, angle: number, row: number, maxWidth: number) {
    const tex = textTexture(lines, '#111426');
    const height = lines.length * row + 0.08;
    const width = Math.min(maxWidth, tex.image.width / tex.image.height * height);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = angle;
    this.group.add(mesh);
  }

  private addExit(edge: Edge | null, label: string, x: number, z: number, nx: number, nz: number, lift: number, endpoint: string, back: RoomDestination | null = null, y = EYE_HEIGHT) {
    const color = edge ? EDGE_COLORS[edge.kind] : BACK_COLOR;
    const light = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.83) });
    const circular = this.zeroGravity && edge?.kind === 'case';
    const slide = edge?.kind === 'case' && !circular;
    const { halfWidth, height } = doorSize(!edge && !back);
    const rotation = Math.atan2(-nx, -nz);
    const portal = new THREE.Group();
    portal.rotation.y = rotation;
    portal.position.set(x - nx * 0.11, y - EYE_HEIGHT, z - nz * 0.11);
    this.group.add(portal);
    if (circular) {
      const geometry = new THREE.RingGeometry(SWITCH_DOOR_RADIUS - 0.025, SWITCH_DOOR_RADIUS + 0.10, 64);
      const vertices = geometry.attributes.position;
      // Follow the curved wall so the rim stays visible even at the outer columns.
      for (let i = 0; i < vertices.count; i++) {
        const surface = sphereFront(this.halfDepth, x + vertices.getX(i), y - EYE_HEIGHT + vertices.getY(i));
        vertices.setZ(i, surface - z);
      }
      geometry.translate(0, EYE_HEIGHT, 0);
      const ring = new THREE.Mesh(geometry, light);
      ring.name = 'Switch door ring';
      portal.add(ring);
    } else if (edge) {
      // Rectangular frames and their landing strips share a light so the selected route brightens.
      for (const side of [-1, 1]) {
        const jamb = new THREE.Mesh(this.unit, light);
        jamb.position.set(side * DOOR_WIDTH / 2, DOOR_HEIGHT / 2, 0.06);
        jamb.scale.set(0.1, DOOR_HEIGHT, 0.16);
        portal.add(jamb);
      }
      const beam = new THREE.Mesh(this.unit, light);
      beam.position.set(0, DOOR_HEIGHT, 0.06);
      beam.scale.set(DOOR_WIDTH + 0.1, 0.105, 0.16);
      portal.add(beam);
    } else {
      const arch = new THREE.Mesh(archFrameGeometry(halfWidth, height), light);
      arch.name = 'Door arch';
      portal.add(arch);
    }
    if (!circular) {
      const ramp = new THREE.Mesh(this.unit, this.trim);
      ramp.position.set(0, slide ? 0.04 : 0.014, slide ? 1.03 : 0.43);
      ramp.scale.set(halfWidth * 2 - 0.12, slide ? 0.23 : 0.035, slide ? 2.18 : 0.86);
      if (slide) ramp.rotation.x = -0.30;
      portal.add(ramp);
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(this.unit, light);
        strip.position.set(side * (halfWidth - 0.14), slide ? 0.38 : 0.044, slide ? 1.03 : 0.44);
        strip.scale.set(0.065, slide ? 0.13 : 0.025, slide ? 2.16 : 0.85);
        if (slide) strip.rotation.x = -0.30;
        portal.add(strip);
      }
    }

    const target = edge ? this.plan.blocks.get(edge.to) : undefined;
    const destination = target ? { plan: this.plan, block: target } : back;
    const elevator = !!destination && destination.plan === this.plan && destination.block.addr < this.block.addr && edge?.kind !== 'case';
    const title = elevator ? `${label} · LIFT${lift ? (lift > 0 ? ' ↑' : ' ↓') : ''}` : label;
    const titleY = circular ? y + SWITCH_DOOR_RADIUS + 0.40 : y - EYE_HEIGHT + height + 0.54;
    const titleZ = circular ? sphereFront(this.halfDepth, Math.abs(x) + 1.55, Math.abs(titleY - EYE_HEIGHT) + 0.25) + 0.11 : z - nz * 0.13;
    this.sign([{ text: title, color: '#' + color.getHexString() }, { text: trimText(endpoint, 29), color: '#f0eeff' }],
      x - nx * 0.13, titleY, titleZ, rotation, 0.205, DOOR_SPACING - 0.17);
    this.exits.push({ edge, label: title, endpoint, x, y, z, nx, nz, lift, elevator, radius: circular ? SWITCH_DOOR_RADIUS : undefined,
      slide, light, color, frame: portal, destination });
  }

  private wallWithDoors(nx: number, nz: number) {
    const wall = nx ? this.halfWidth : nz * this.halfDepth;
    const span = nx ? this.halfDepth : this.halfWidth;
    const put = (from: number, to: number, base: number, top: number) => {
      if (to <= from) return;
      const center = (from + to) / 2;
      this.box(nx ? 0.18 : to - from, top - base, nx ? to - from : 0.18,
        nx ? wall : center, (base + top) / 2, nx ? center : wall, this.wall);
    };
    let start = -span;
    for (const exit of this.exits.filter((e) => e.nx === nx && e.nz === nz)) {
      const center = nx ? exit.z : exit.x;
      const { halfWidth, height } = doorSize(!exit.edge && !exit.destination);
      put(start, center - halfWidth, 0, ROOM_HEIGHT);
      if (exit.edge) put(center - halfWidth, center + halfWidth, height, ROOM_HEIGHT);
      else {
        const lintel = new THREE.Mesh(wallAboveArch(halfWidth, height, ROOM_HEIGHT), this.wall);
        lintel.name = 'Wall above door arch';
        lintel.position.set(exit.x, 0, exit.z);
        lintel.rotation.y = Math.atan2(-nx, -nz);
        this.group.add(lintel);
      }
      start = center + halfWidth;
    }
    put(start, span, 0, ROOM_HEIGHT);
    this.box(nx ? 0.08 : span * 2, 0.055, nx ? span * 2 : 0.08, nx ? wall : 0, 3.59, nx ? 0 : wall, this.trim);
  }

  private addPillar() {
    const condition = this.condition!;
    const state = condition.matches === null ? 'RUNTIME VALUE UNKNOWN' : condition.matches ? 'MATCHES · TRUE' : 'DOES NOT MATCH · FALSE';
    const tint = condition.matches === null ? 0xffcf67 : condition.matches ? 0x39ff88 : 0xff3864;
    this.box(1.15, 0.13, 1.15, 0, 0.065, 0, this.trim);
    this.box(0.76, 1.25, 0.76, 0, 0.68, 0, this.trim);
    this.orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(1.25) }));
    this.orb.position.y = 1.86;
    this.group.add(this.orb);
    const shell = new THREE.TorusGeometry(0.49, 0.014, 6, 35);
    const wire = new THREE.MeshBasicMaterial({ color: tint });
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(shell, wire);
      ring.rotation.z = i * Math.PI / 2;
      ring.position.y = this.orb.position.y;
      this.orbRings.push(ring);
      this.group.add(ring);
    }
    const lines = [{ text: state, color: '#' + new THREE.Color(tint).getHexString() },
      ...(condition.text.match(/.{1,40}/gu) ?? []).map((text) => ({ text, color: '#f1edff' }))];
    this.sign(lines, 0, 2.55, 0.52, 0, 0.13, 3.45);
    this.sign(lines, 0, 2.55, -0.52, Math.PI, 0.13, 3.45);
  }

  get pageCount() { return Math.ceil(this.words.length / PAGE_SIZE); }
  get summaryPage() { return this.page + 1; }
  get selectedCall() { return this.calls[this.callIndex]; }
  get selectedExit() { return this.exits[this.exitIndex]; }

  setSummary(text: string) {
    if (text === this.summary) return;
    this.summary = text;
    const selected = this.selectedCall?.site;
    this.words = summaryWords(this.block, this.plan.fi, text, this.model);
    this.calls.splice(0, this.calls.length, ...this.words.filter((word) => word.site !== undefined));
    this.callIndex = this.calls.findIndex((call) => call.site === selected);
    this.showPage(this.selectedCall ? Math.floor(this.words.indexOf(this.selectedCall) / PAGE_SIZE) : 0);
  }

  aimCall(ray: THREE.Raycaster) {
    const hits: THREE.Intersection<THREE.Sprite>[] = [];
    for (const { word, sprite } of this.sprites) {
      if (word.site === undefined) continue;
      sprite.raycast(ray, hits);
    }
    const nearest = hits.sort((a, b) => a.distance - b.distance)[0];
    return nearest ? this.sprites.find(({ sprite }) => sprite === nearest.object)?.word : undefined;
  }

  showPage(page: number) {
    this.page = THREE.MathUtils.euclideanModulo(page, Math.max(1, this.pageCount));
    disposeGroup(this.floating);
    this.floating.clear();
    this.sprites = [];
    this.words.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE).forEach((word, i) => {
      const call = word.site !== undefined;
      const selected = word === this.selectedCall;
      const text = trimText(word.text, 400).match(/.{1,46}/gu) ?? [' '];
      if (call) text.unshift(selected ? '◆ SELECTED CALL' : '◇ CALL');
      const texture = textTexture(text.map((line) => ({ text: line, color: call ? '#ffb3f2' : '#adf5ff' })),
        call ? '#3d154f' : '#153747', 28, call ? '#e15ac7' : '#3e9cba');
      const mat = new THREE.SpriteMaterial({ map: texture, color: new THREE.Color().multiplyScalar(call ? selected ? 2.4 : 1.55 : 0.86) });
      const sprite = new THREE.Sprite(mat);
      const height = Math.min(0.66, text.length * 0.15 + 0.1);
      sprite.scale.set(Math.min(3.15, height * texture.image.width / texture.image.height), height, 1);
      const col = (i % 3) - 1;
      const row = Math.floor(i / 3);
      const home = new THREE.Vector3(col * 3.22, 3.66 + (row % 2) * 0.47, -3.35 + row * 1.54);
      sprite.position.copy(home);
      this.floating.add(sprite);
      this.sprites.push({ sprite, home, word });
    });
  }

  cycleCall(step: number) {
    if (!this.calls.length) return;
    this.exitIndex = -1;
    this.callIndex = THREE.MathUtils.euclideanModulo(this.callIndex + 1 + step, this.calls.length + 1) - 1;
    const selected = this.selectedCall;
    this.showPage(selected ? Math.floor(this.words.indexOf(selected) / PAGE_SIZE) : this.page);
  }

  cycleExit(step: number) {
    if (this.callIndex !== -1) {
      this.callIndex = -1;
      this.showPage(this.page);
    }
    this.exitIndex = this.exitIndex === -1 ? (step > 0 ? 0 : this.exits.length - 1)
      : THREE.MathUtils.euclideanModulo(this.exitIndex + step, this.exits.length);
  }

  pageSummary(step: number) {
    this.callIndex = -1;
    this.showPage(this.page + step);
  }

  aimExit(eye: THREE.Vector3, direction: THREE.Vector3) {
    const at = eye.clone().sub(this.group.position);
    return this.exits.find((exit) => {
      const forward = direction.x * exit.nx + direction.z * exit.nz;
      if (forward <= 0.01) return false;
      const t = ((exit.x - at.x) * exit.nx + (exit.z - at.z) * exit.nz) / forward;
      const y = at.y + t * direction.y - exit.y + EYE_HEIGHT;
      const across = exit.nx ? at.z + t * direction.z - exit.z : at.x + t * direction.x - exit.x;
      if (t < 0) return false;
      if (exit.radius) return Math.hypot(across, y - EYE_HEIGHT) <= exit.radius;
      return y >= 0 && y <= 3.46 && Math.abs(across) <= doorSize(!exit.edge && !exit.destination).halfWidth;
    });
  }

  collide(eye: THREE.Vector3): RoomExit | undefined {
    const origin = this.group.position;
    let x = eye.x - origin.x;
    let z = eye.z - origin.z;
    const y = eye.y - origin.y;
    const exit = this.exits.find((e) => {
      const dx = x - e.x;
      const dz = z - e.z;
      const reach = e.slide || e.radius ? 0.97 : WALK_RADIUS;
      if (dx * e.nx + dz * e.nz < -reach) return false;
      const across = e.nx ? dz : dx;
      if (e.radius) return Math.hypot(across, y - e.y) < e.radius - WALK_RADIUS;
      const { halfWidth, height } = doorSize(!e.edge && !e.destination);
      const localY = y - e.y + EYE_HEIGHT;
      const widthAtY = e.edge ? halfWidth : archHalfWidthAt(localY, halfWidth, height);
      const fits = this.zeroGravity ? Math.abs(y - e.y) < 0.98 : e.slide || localY < height;
      return fits && Math.abs(across) < widthAtY - WALK_RADIUS;
    });
    if (this.zeroGravity) {
      const point = new THREE.Vector3(x, y - EYE_HEIGHT, z);
      const radius = this.halfDepth - WALK_RADIUS;
      if (point.lengthSq() > radius * radius) point.setLength(radius);
      eye.copy(origin).add(point).add(new THREE.Vector3(0, EYE_HEIGHT, 0));
      return exit;
    }
    x = THREE.MathUtils.clamp(x, WALK_RADIUS - this.halfWidth, this.halfWidth - WALK_RADIUS);
    z = THREE.MathUtils.clamp(z, WALK_RADIUS - this.halfDepth, this.halfDepth - WALK_RADIUS);
    if (this.condition) {
      const d = Math.hypot(x, z);
      if (d > 0 && d < 0.92) {
        x *= 0.92 / d;
        z *= 0.92 / d;
      }
    }
    eye.x = x + origin.x;
    eye.z = z + origin.z;
    return exit;
  }

  doorwayPosition(door: RoomDoorway) {
    return this.group.position.clone().add(new THREE.Vector3(door.x, door.y, door.z));
  }

  spawn() {
    const origin = this.group.position;
    return { pos: origin.clone().add(new THREE.Vector3(0, EYE_HEIGHT, 3.85)),
      target: origin.clone().add(new THREE.Vector3(0, EYE_HEIGHT + 0.65, -this.halfDepth)) };
  }

  private updateExitLabels(t: number, eye: THREE.Vector3, focused: RoomExit | undefined) {
    if (t < this.nextLabelUpdate || this.loadingLabel) return;
    this.nextLabelUpdate = t + 0.18;
    const local = eye.clone().sub(this.group.position);
    let nearest: RoomExit | undefined;
    let distance = 18;
    for (const exit of this.exits) {
      if (!exit.destination || this.labeledExits.has(exit)) continue;
      const d = Math.hypot(exit.x - local.x, exit.y - local.y, exit.z - local.z);
      if (exit !== focused && d >= distance) continue;
      nearest = exit;
      distance = d;
      if (exit === focused) break;
    }
    const destination = nearest?.destination;
    if (!nearest || !destination) return;
    const exit = nearest;
    this.labeledExits.add(exit);
    this.loadingLabel = true;
    void this.readSummary(destination.block.addr).then((summary) => {
      if (!this.disposed) this.addExitLabel(exit, summaryWords(destination.block, destination.plan.fi, summary, this.model));
    }).finally(() => { this.loadingLabel = false; });
  }

  private addExitLabel(exit: RoomExit, words: Word[]) {
    if (!words.length) return;
    const call = words.find((word) => word.site !== undefined);
    const string = words.find((word) => word.site === undefined && /^["'`]|\bstr\./i.test(word.text));
    const items = [...new Set([string, call, ...words])].filter((word): word is Word => !!word).slice(0, 2);
    const lines = items.map((word) => ({ text: trimText(word.text, 33), color: word.site === undefined ? '#c5fbff' : '#ffc3f5' }));
    const texture = textTexture(lines, 'transparent', 30);
    const height = lines.length * 0.19 + 0.09;
    const width = Math.min(exit.radius ? 1.88 : DOOR_WIDTH - 0.17, texture.image.width / texture.image.height * height);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({
      map: texture, color: new THREE.Color().multiplyScalar(1.25), transparent: true, depthWrite: false, toneMapped: false,
    }));
    label.name = 'Destination pdsb';
    label.position.set(0, exit.radius ? EYE_HEIGHT + 0.54 : DOOR_HEIGHT - 0.36, 0.24);
    label.renderOrder = 1;
    exit.frame.add(label);
  }

  update(t: number, eye: THREE.Vector3, aimed: RoomExit | undefined) {
    this.updateExitLabels(t, eye, this.selectedExit ?? aimed);
    this.animate(t, aimed);
  }

  animate(t: number, aimed?: RoomExit) {
    for (const [i, { sprite, home }] of this.sprites.entries()) {
      sprite.position.copy(home);
      sprite.position.x += Math.sin(t * 0.63 + i) * 0.28;
      sprite.position.y += Math.sin(t * 0.91 + i * 1.4) * 0.2;
      sprite.position.z += Math.cos(t * 0.51 + i) * 0.25;
    }
    if (this.orb) {
      this.orb.position.y = 1.85 + 0.14 * Math.sin(t * 2.1);
      this.orb.rotation.y = t * 0.8;
      this.orb.scale.setScalar(1 + Math.sin(t * 3.1) * 0.065);
      this.orbRings.forEach((ring, i) => {
        ring.position.y = this.orb!.position.y;
        ring.rotation.x = t * (i ? -0.98 : 0.75);
        ring.rotation.y = t * (i ? 0.63 : -0.46);
      });
    }
    for (const exit of this.exits) exit.light.color.copy(exit.color).multiplyScalar(exit === this.selectedExit || exit === aimed ? 1.18 : 0.83);
  }

  dispose() {
    this.disposed = true;
    disposeGroup(this.group);
  }
}

export class LiftDoors {
  readonly group = new THREE.Group();
  private leaves: THREE.Group[] = [];

  constructor(color: THREE.Color) {
    this.group.name = 'Lift doors';
    const geometry = new THREE.BoxGeometry();
    const body = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x1b263c).lerp(color, 0.18) });
    const pad = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x182841).lerp(color, 0.10) });
    const light = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.55) });
    for (const side of [-1, 1]) {
      const leaf = new THREE.Group();
      const panel = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.scale.set(w, h, d);
        mesh.position.set(x, y, z);
        leaf.add(mesh);
      };
      panel(0.95, 2.35, 0.11, 0, 1.18, 0, body);
      panel(0.68, 1.57, 0.028, 0, 1.20, 0.062, pad);
      panel(0.024, 2.20, 0.035, -side * 0.445, 1.18, 0.068, light);
      for (const h of [0.56, 1.8]) panel(0.60, 0.036, 0.028, 0, h, 0.08, light);
      this.leaves.push(leaf);
      this.group.add(leaf);
    }
    this.close(0);
  }

  close(amount: number) {
    const x = THREE.MathUtils.lerp(1.43, 0.478, amount);
    this.group.visible = amount > 0.005;
    this.leaves[0].position.x = -x;
    this.leaves[1].position.x = x;
  }
}
