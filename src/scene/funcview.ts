import * as THREE from 'three';
import { FOG_PARS, globals, PALETTE } from '../shaders/common';
import { hex, type Block, type FnGraph, type Op } from '../types';
import { LabelField } from './labels';

const FONT_PX = 22;
const LINE_H = 30;
const PAD_X = 16;
const HEADER_H = 40;
const PX_PER_UNIT = 40;
const MAX_LINES = 32;

const opColor = (t?: string): string => {
  if (!t) return '#d8f6ff';
  if (t.includes('call')) return '#ff4fe0';
  if (t === 'ret') return '#ff4870';
  if (t.includes('cjmp')) return '#5dff9b';
  if (t.includes('jmp')) return '#ffe94d';
  if (t.includes('cmp') || t === 'acmp' || t === 'test') return '#ffa13d';
  if (t === 'nop' || t === 'null') return '#6b5d8c';
  if (t.includes('push') || t.includes('pop')) return '#a98bff';
  if (t.includes('load') || t.includes('store') || t === 'lea') return '#47e5ff';
  if (t === 'trap' || t === 'ill') return '#ff2020';
  return '#d8f6ff';
};

interface Panel {
  block: Block;
  mesh: THREE.Mesh;
  w: number;
  h: number;
  layer: number;
  rows: { addr: number; y0: number; y1: number }[];
  pxH: number;
}

/** A function's control-flow graph as floating holographic glass panels. */
export class FuncView {
  group = new THREE.Group();
  graph: FnGraph;
  panels: Panel[] = [];
  private panelByAddr = new Map<number, Panel>();
  private edgeMeshes: THREE.Mesh[] = [];
  private title: LabelField;
  private backdrop: THREE.Mesh;
  bounds = new THREE.Box3();
  helix = false;
  private hoverPanel: Panel | null = null;
  private seekPanel: Panel | null = null;

  constructor(graph: FnGraph) {
    this.graph = graph;
    const blocks = graph.blocks ?? [];
    const byAddr = new Map(blocks.map((b) => [b.addr, b]));
    const succ = (b: Block) => {
      const s: { to: number; kind: 'jump' | 'fail' | 'uncond' | 'case' }[] = [];
      const cond = b.fail !== undefined && b.jump !== undefined;
      if (b.jump !== undefined && byAddr.has(b.jump)) s.push({ to: b.jump, kind: cond ? 'jump' : 'uncond' });
      if (b.fail !== undefined && byAddr.has(b.fail)) s.push({ to: b.fail, kind: 'fail' });
      for (const c of b.switchop?.cases ?? []) if (byAddr.has(c.jump)) s.push({ to: c.jump, kind: 'case' });
      return s;
    };

    // ---- layering: DFS to find back edges, then longest-path layering
    const entry = byAddr.has(graph.addr) ? graph.addr : blocks[0]?.addr;
    const state = new Map<number, number>();
    const back = new Set<string>();
    const order: number[] = [];
    const dfs = (start: number) => {
      const stack: [number, number][] = [[start, 0]];
      state.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const ss = succ(byAddr.get(top[0])!);
        if (top[1] < ss.length) {
          const nx = ss[top[1]++].to;
          const st = state.get(nx) ?? 0;
          if (st === 1) back.add(`${top[0]}>${nx}`);
          else if (st === 0) {
            state.set(nx, 1);
            stack.push([nx, 0]);
          }
        } else {
          state.set(top[0], 2);
          order.push(top[0]);
          stack.pop();
        }
      }
    };
    if (entry !== undefined) dfs(entry);
    for (const b of blocks) if (!state.has(b.addr)) dfs(b.addr);
    order.reverse();
    const layer = new Map<number, number>();
    for (const a of order) if (!layer.has(a)) layer.set(a, 0);
    for (const a of order) {
      const l = layer.get(a)!;
      for (const s of succ(byAddr.get(a)!)) {
        if (back.has(`${a}>${s.to}`)) continue;
        layer.set(s.to, Math.max(layer.get(s.to) ?? 0, l + 1));
      }
    }

    // ---- panels
    const layers: Panel[][] = [];
    for (const b of blocks) {
      const p = this.makePanel(b, graph);
      p.layer = layer.get(b.addr) ?? 0;
      (layers[p.layer] ??= []).push(p);
      this.panels.push(p);
      this.panelByAddr.set(b.addr, p);
    }
    // order within layers by barycentre of predecessors
    const xOf = new Map<Panel, number>();
    const preds = new Map<number, number[]>();
    for (const b of blocks) for (const s of succ(b)) (preds.get(s.to) ?? preds.set(s.to, []).get(s.to)!).push(b.addr);
    const GAP_X = 4;
    const GAP_Y = 7;
    // Big graphs wrap their layers around a helix (a DNA-like tower); small ones stay planar.
    const nLayers = layers.filter(Boolean).length;
    this.helix = nLayers > 22;
    const rowWidth = (row: Panel[]) => row.reduce((s, p) => s + p.w, 0) + GAP_X * (row.length - 1);
    const maxRow = Math.max(10, ...layers.filter(Boolean).map(rowWidth));
    const widths = this.panels.map((p) => p.w).sort((a, b) => a - b);
    const medW = widths[Math.floor(widths.length / 2)] ?? 12;
    const helixR = Math.max(30, Math.min(90, medW * 3.2, maxRow * 0.6));
    const turn = 0.42; // radians per layer
    let y = 0;
    layers.forEach((row, li) => {
      if (!row) return;
      if (li > 0) {
        const bary = (p: Panel) => {
          const ps = (preds.get(p.block.addr) ?? []).map((a) => this.panelByAddr.get(a)).filter((q): q is Panel => !!q && xOf.has(q));
          return ps.length ? ps.reduce((s, q) => s + xOf.get(q)!, 0) / ps.length : 0;
        };
        row.sort((a, b) => bary(a) - bary(b));
      }
      const total = rowWidth(row);
      let x = -total / 2;
      let maxH = 0;
      const a = li * turn;
      for (const p of row) {
        const cx = x + p.w / 2;
        xOf.set(p, cx);
        if (this.helix) {
          // tangent offset along the circle, facing outward
          const ang = a + cx / helixR;
          p.mesh.position.set(Math.sin(ang) * helixR, y - p.h / 2, Math.cos(ang) * helixR);
          p.mesh.rotation.y = ang;
        } else {
          p.mesh.position.set(cx, y - p.h / 2, Math.sin(li * 0.7) * 5 + Math.cos(cx * 0.05) * 2);
        }
        x += p.w + GAP_X;
        maxH = Math.max(maxH, p.h);
      }
      y -= this.helix ? maxH * 0.55 + 4 : maxH + GAP_Y;
    });
    for (const p of this.panels) {
      this.group.add(p.mesh);
      p.mesh.updateMatrixWorld(true);
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.bounds.expandByPoint(p.mesh.localToWorld(new THREE.Vector3((sx * p.w) / 2, (sy * p.h) / 2, 0)));
    }
    if (this.helix) {
      // a luminous spine down the helix axis
      const spineGeo = new THREE.CylinderGeometry(0.6, 0.6, this.bounds.max.y - this.bounds.min.y + 40, 12, 1, true);
      const spine = new THREE.Mesh(
        spineGeo,
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: { ...globals },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
          fragmentShader: `uniform float uTime; varying vec2 vUv; void main(){ float p = smoothstep(0.9, 1.0, fract(vUv.y * 12.0 + uTime * 0.4)); gl_FragColor = vec4(vec3(1.0, 0.2, 0.9) * (1.0 + p * 4.0), 0.35 + p * 0.6); }`,
        }),
      );
      spine.position.y = (this.bounds.max.y + this.bounds.min.y) / 2;
      this.group.add(spine);
    }

    // ---- edges
    for (const b of blocks) {
      const from = this.panelByAddr.get(b.addr)!;
      const ss = succ(b);
      ss.forEach((s, k) => {
        const to = this.panelByAddr.get(s.to);
        if (!to) return;
        const isBack = back.has(`${b.addr}>${s.to}`) || to.layer <= from.layer;
        const color =
          s.kind === 'jump' ? PALETTE.green : s.kind === 'fail' ? PALETTE.red : s.kind === 'case' ? PALETTE.yellow : PALETTE.cyan;
        this.addEdge(from, to, color, isBack, ss.length > 1 ? (k / (ss.length - 1) - 0.5) * Math.min(from.w * 0.6, 6) : 0);
      });
    }

    // ---- title + backdrop
    const top = this.bounds.max.y;
    const bwid = Math.min(120, this.bounds.max.x - this.bounds.min.x);
    const ts = Math.max(2.2, Math.min(9, bwid * 0.12));
    this.title = new LabelField(
      [
        { text: graph.name, color: PALETTE.magenta, position: new THREE.Vector3(0, top + ts * 1.9, 0), size: ts, font: `700 40px "Orbitron", sans-serif` },
        {
          text: `${hex(graph.addr)} · ${graph.blocks?.length ?? 0} blocks · ${graph.ninstr} instrs · ${graph.size} bytes`,
          color: PALETTE.cyan,
          position: new THREE.Vector3(0, top + ts * 0.85, 0),
          size: ts * 0.38,
        },
      ],
      { fadeFar: 3000, fadeNear: 10, px: 44, shrink: 200 },
    );
    this.group.add(this.title.mesh);

    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    const bw = Math.max(400, size.x * 3);
    const bh = Math.max(400, size.y * 3);
    const bgeo = new THREE.PlaneGeometry(bw, bh);
    const bmat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...globals },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform float uTime;
        varying vec3 vW;
        float gl(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s; vec2 fw = fwidth(p); vec2 l = 1.0 - smoothstep(vec2(0.0), fw * 1.2, g); return max(l.x, l.y); }
        void main() {
          vec2 p = vW.xy;
          float g = gl(p, 4.0) * 0.12 + gl(p, 32.0) * 0.5;
          float scan = exp(-pow(mod(p.y + uTime * 22.0, 160.0) - 80.0, 2.0) / 40.0);
          vec3 c = vec3(0.25, 0.05, 0.6) * g + vec3(0.0, 0.8, 1.0) * scan * g * 2.0;
          gl_FragColor = vec4(c, 0.9 * exp(-length(vW.xy) * 0.0025));
        }`,
    });
    this.backdrop = new THREE.Mesh(bgeo, bmat);
    const center = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.backdrop.position.set(center.x, center.y, this.bounds.min.z - 60);
    this.backdrop.visible = !this.helix;
    this.group.add(this.backdrop);
  }

  private makePanel(b: Block, g: FnGraph): Panel {
    const ops = b.ops ?? [];
    const shown = ops.slice(0, MAX_LINES);
    const lines: { op?: Op; segs: [string, string][] }[] = [];
    for (const op of shown) {
      for (const f of op.flags ?? []) if (f !== 'pc') lines.push({ segs: [[`;-- ${f}:`, '#fff36b']] });
      const dis = (op.disasm ?? op.opcode ?? '???').trim();
      const sp = dis.indexOf(' ');
      const mnem = sp > 0 ? dis.slice(0, sp) : dis;
      const args = sp > 0 ? dis.slice(sp) : '';
      lines.push({
        op,
        segs: [
          [hex(op.addr), '#7d6aa8'],
          ['  ', '#000'],
          [mnem.padEnd(7), opColor(op.type)],
          [args.length > 44 ? args.slice(0, 43) + '…' : args, '#d8f6ff'],
        ],
      });
    }
    if (ops.length > MAX_LINES) lines.push({ segs: [[`  … ${ops.length - MAX_LINES} more instructions`, '#8a7ab0']] });

    const meas = document.createElement('canvas').getContext('2d')!;
    meas.font = `500 ${FONT_PX}px "JetBrains Mono", monospace`;
    const cw = meas.measureText('M').width;
    const maxChars = Math.max(30, ...lines.map((l) => l.segs.reduce((s, x) => s + x[0].length, 0)));
    const pxW = Math.ceil(maxChars * cw + PAD_X * 2);
    const pxH = HEADER_H + lines.length * LINE_H + 14;
    const cv = document.createElement('canvas');
    const scale = (g.blocks?.length ?? 0) > 150 ? 1 : 2;
    cv.width = pxW * scale;
    cv.height = pxH * scale;
    const c = cv.getContext('2d')!;
    c.scale(scale, scale);
    c.textBaseline = 'middle';
    // header
    const isEntry = b.addr === g.addr;
    c.font = `700 ${FONT_PX - 2}px "Orbitron", sans-serif`;
    c.fillStyle = isEntry ? '#ff5be6' : '#5ef2ff';
    c.fillText(isEntry ? `◆ ${g.name}` : `◇ ${hex(b.addr)}`, PAD_X, HEADER_H / 2 + 2);
    c.font = `500 ${FONT_PX - 6}px "JetBrains Mono", monospace`;
    c.fillStyle = '#8f7fc4';
    const meta = `${ops.length} ops · ${b.size}B`;
    c.fillText(meta, pxW - PAD_X - c.measureText(meta).width, HEADER_H / 2 + 2);
    const rows: Panel['rows'] = [];
    c.font = `500 ${FONT_PX}px "JetBrains Mono", monospace`;
    lines.forEach((l, i) => {
      const yy = HEADER_H + i * LINE_H + LINE_H / 2 + 4;
      let x = PAD_X;
      for (const [txt, col] of l.segs) {
        c.fillStyle = col;
        c.shadowColor = col;
        c.shadowBlur = 2;
        c.fillText(txt, x, yy);
        x += txt.length * cw;
      }
      if (l.op) rows.push({ addr: l.op.addr, y0: HEADER_H + i * LINE_H + 4, y1: HEADER_H + (i + 1) * LINE_H + 4 });
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const w = pxW / PX_PER_UNIT;
    const h = pxH / PX_PER_UNIT;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        ...globals,
        uMap: { value: tex },
        uSize: { value: new THREE.Vector2(w, h) },
        uHeader: { value: HEADER_H / pxH },
        uAccent: { value: new THREE.Color(isEntry ? 0xff2bd6 : 0x00e5ff) },
        uHover: { value: 0 },
        uSeek: { value: 0 },
        uRow: { value: new THREE.Vector2(-1, -1) },
        uReveal: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDist;
        void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform sampler2D uMap;
        uniform vec2 uSize;
        uniform float uHeader;
        uniform vec3 uAccent;
        uniform float uHover;
        uniform float uSeek;
        uniform vec2 uRow;
        uniform float uTime;
        uniform float uReveal;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          if (1.0 - vUv.y > uReveal) discard;
          vec2 w = vUv * uSize;
          vec2 e = min(w, uSize - w);
          float ed = min(e.x, e.y);
          float border = 1.0 - smoothstep(0.0, 0.07, ed);
          float glow = exp(-ed * 2.2) * 0.35;
          // corner brackets
          vec2 ce = min(w, uSize - w);
          float corner = step(ce.x, 1.2) * step(ce.y, 1.2) * (1.0 - smoothstep(0.08, 0.16, ed));
          float yTop = 1.0 - vUv.y;
          vec3 bg = mix(vec3(0.03, 0.01, 0.08), vec3(0.01, 0.02, 0.05), vUv.y);
          float header = step(yTop, uHeader);
          bg += uAccent * header * 0.12;
          bg += uAccent * (1.0 - smoothstep(0.0, 0.004, abs(yTop - uHeader))) * 0.8;
          // scanlines
          bg *= 0.85 + 0.15 * sin(w.y * 40.0);
          float sweep = exp(-pow((yTop - fract(uTime * 0.12 + uSize.x * 0.01)) * 30.0, 2.0)) * 0.12;
          // highlighted row (current seek)
          float row = step(uRow.x, yTop) * step(yTop, uRow.y);
          bg += vec3(1.0, 0.85, 0.1) * row * (0.28 + 0.08 * sin(uTime * 6.0));
          bg += vec3(1.0, 0.9, 0.2) * row * step(vUv.x, 0.012) * 3.0;
          vec4 t = texture2D(uMap, vUv);
          float bb = 1.0 + uHover * 1.5 + uSeek * 1.2;
          vec3 col = bg + t.rgb * t.a * 0.8 + uAccent * (border * 1.8 + glow + corner * 2.5) * bb + uAccent * sweep;
          float a = 0.8 + border * 0.2;
          col = applyFog(col, vDist * 0.5);
          gl_FragColor = vec4(col, a);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.userData.block = b.addr;
    return { block: b, mesh, w, h, layer: 0, rows, pxH };
  }

  private addEdge(from: Panel, to: Panel, color: THREE.Color, isBack: boolean, dx: number) {
    const a = from.mesh.localToWorld(new THREE.Vector3(dx, -from.h / 2, 0));
    const b = to.mesh.localToWorld(new THREE.Vector3(0, to.h / 2 + 0.6, 0));
    const na = new THREE.Vector3(0, 0, 1).applyQuaternion(from.mesh.quaternion);
    const nb = new THREE.Vector3(0, 0, 1).applyQuaternion(to.mesh.quaternion);
    let curve: THREE.Curve<THREE.Vector3>;
    if (!isBack) {
      const dy = Math.max(3, (a.y - b.y) * 0.5);
      curve = new THREE.CubicBezierCurve3(
        a,
        a.clone().add(new THREE.Vector3(0, -dy, 0)).addScaledVector(na, 2),
        b.clone().add(new THREE.Vector3(0, dy, 0)).addScaledVector(nb, 2),
        b,
      );
    } else {
      const out = 7 + Math.random() * 5;
      const ra = new THREE.Vector3(1, 0, 0).applyQuaternion(from.mesh.quaternion);
      const side = this.helix ? 0 : Math.max(from.mesh.position.x + from.w / 2, to.mesh.position.x + to.w / 2) + 6 + Math.random() * 4;
      const pa = this.helix ? a.clone().addScaledVector(na, out).add(new THREE.Vector3(0, -3, 0)) : new THREE.Vector3(side, a.y - 3, a.z + 6);
      const pb = this.helix ? b.clone().addScaledVector(nb, out).add(new THREE.Vector3(0, 3, 0)) : new THREE.Vector3(side, b.y + 3, b.z + 6);
      void ra;
      const pts = [a, a.clone().add(new THREE.Vector3(0, -2.5, 0)).addScaledVector(na, 3), pa, pb, b.clone().add(new THREE.Vector3(0, 2.5, 0)).addScaledVector(nb, 3), b];
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    }
    const geo = new THREE.TubeGeometry(curve as THREE.Curve<THREE.Vector3>, isBack ? 80 : 48, 0.11, 6, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { ...globals, uColor: { value: color.clone() }, uSeed: { value: Math.random() }, uReveal: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uSeed;
        uniform float uReveal;
        varying vec2 vUv;
        void main() {
          if (vUv.x > uReveal) discard;
          float p = smoothstep(0.8, 1.0, fract(vUv.x * 3.0 - uTime * 0.9 + uSeed));
          gl_FragColor = vec4(uColor * (1.3 + p * 3.5), 0.55 + p * 0.45);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.edgeMeshes.push(mesh);
    this.group.add(mesh);
    // arrow head
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.1, 10),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.2), transparent: true, opacity: 0.95 }),
    );
    cone.position.copy(b).add(new THREE.Vector3(0, -0.1, 0));
    cone.rotation.x = Math.PI;
    this.group.add(cone);
  }

  /** Animate panels & edges in. */
  reveal(engineAdd: (fn: (dt: number) => void) => () => boolean) {
    let t = 0;
    const off = engineAdd((dt) => {
      t += dt;
      for (const p of this.panels) {
        const delay = p.layer * 0.06;
        (p.mesh.material as THREE.ShaderMaterial).uniforms.uReveal.value = Math.min(1, Math.max(0, (t - delay) * 2.2));
      }
      const er = Math.min(1, Math.max(0, (t - 0.3) * 0.9));
      for (const e of this.edgeMeshes) (e.material as THREE.ShaderMaterial).uniforms.uReveal.value = er;
      if (t > 4 + this.panels.length * 0.002) off();
    });
  }

  panelAt(addr: number): Panel | null {
    let best: Panel | null = null;
    for (const p of this.panels) if (addr >= p.block.addr && addr < p.block.addr + Math.max(1, p.block.size)) best = p;
    return best;
  }

  setSeek(addr: number): Panel | null {
    if (this.seekPanel) {
      const u = (this.seekPanel.mesh.material as THREE.ShaderMaterial).uniforms;
      u.uSeek.value = 0;
      u.uRow.value.set(-1, -1);
    }
    const p = this.panelAt(addr);
    this.seekPanel = p;
    if (p) {
      const u = (p.mesh.material as THREE.ShaderMaterial).uniforms;
      u.uSeek.value = 1;
      const r = p.rows.find((r) => r.addr === addr);
      if (r) u.uRow.value.set(r.y0 / p.pxH, r.y1 / p.pxH);
    }
    return p;
  }

  hover(mesh: THREE.Object3D | null) {
    if (this.hoverPanel) (this.hoverPanel.mesh.material as THREE.ShaderMaterial).uniforms.uHover.value = 0;
    this.hoverPanel = mesh ? (this.panels.find((p) => p.mesh === mesh) ?? null) : null;
    if (this.hoverPanel) (this.hoverPanel.mesh.material as THREE.ShaderMaterial).uniforms.uHover.value = 1;
  }

  /** Map a raycast hit on a panel to the instruction address under it. */
  opAtHit(mesh: THREE.Object3D, uv: THREE.Vector2): number | null {
    const p = this.panels.find((q) => q.mesh === mesh);
    if (!p) return null;
    const y = (1 - uv.y) * p.pxH;
    return p.rows.find((r) => y >= r.y0 && y < r.y1)?.addr ?? p.block.addr;
  }

  pickables() {
    return this.panels.map((p) => p.mesh);
  }

  /** Camera framing for a panel (or the entry). */
  frame(p: Panel | null): { pos: THREE.Vector3; target: THREE.Vector3 } {
    if (!p) return this.overview();
    const target = p.mesh.position.clone();
    const span = Math.max(p.w, p.h * 1.6);
    const dist = Math.max(22, span * 1.55);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(p.mesh.quaternion);
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(p.mesh.quaternion);
    return { pos: target.clone().addScaledVector(n, dist).addScaledVector(r, span * 0.12).add(new THREE.Vector3(0, -span * 0.06, 0)), target };
  }

  overview(aspect = window.innerWidth / window.innerHeight, fov = 55): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    this.bounds.getCenter(c);
    this.bounds.getSize(s);
    const t = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    if (this.helix) {
      const top = new THREE.Vector3(c.x, this.bounds.max.y - 30, c.z);
      const d = Math.max(s.x, s.z) * 1.6 + 60;
      return { pos: top.clone().add(new THREE.Vector3(d * 0.55, d * 0.35, d * 0.85)), target: new THREE.Vector3(c.x, this.bounds.max.y - Math.min(s.y * 0.35, 140), c.z) };
    }
    const dist = Math.max(40, Math.max((s.y + 16) / 2 / t, (s.x + 16) / 2 / (t * aspect)) * 0.95);
    // slightly from the side and below: the graph recedes in depth
    return { pos: c.clone().add(new THREE.Vector3(dist * 0.42, -dist * 0.12, dist * 0.9)), target: c.clone().add(new THREE.Vector3(0, s.y * 0.04, 0)) };
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.ShaderMaterial | undefined;
      if (mat) {
        (mat.uniforms?.uMap?.value as THREE.Texture | undefined)?.dispose();
        mat.dispose();
      }
    });
    this.title.dispose();
  }
}
