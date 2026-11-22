import * as THREE from 'three';
import { FOG_PARS, globals, PALETTE } from '../shaders/common';
import { hex, type Block, type FnGraph, type Op } from '../types';
import { LabelField } from './labels';
import { Ribbons, type RibbonSpec } from './ribbons';
import type { LayoutReq, LayoutRes } from './cfg.worker';
import CFGWorker from './cfg.worker?worker&inline';

const FONT_PX = 22;
const LINE_H = 30;
const PAD_X = 16;
const HEADER_H = 40;
const PX_PER_UNIT = 40;
const MAX_LINES = 40;
const MAX_DETAIL = 90; // crisp text textures alive at once
const CHAR_W = FONT_PX * 0.6; // JetBrains Mono advance

export type EdgeKind = 'jump' | 'fail' | 'uncond' | 'case';
export const EDGE_COLORS: Record<EdgeKind, THREE.Color> = {
  jump: new THREE.Color(0x39ff88),
  fail: new THREE.Color(0xff3864),
  uncond: new THREE.Color(0x2fd8ff),
  case: new THREE.Color(0xffe14d),
};

export const opColor = (t?: string): string => {
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

interface Line {
  op?: Op;
  segs: [string, string][];
}

export interface Panel {
  block: Block;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  w: number;
  h: number;
  pxW: number;
  pxH: number;
  lines: Line[];
  rows: { addr: number; y0: number; y1: number }[];
  detail: THREE.CanvasTexture | null;
  lastUsed: number;
  index: number;
}

export interface Edge {
  from: number;
  to: number;
  kind: EdgeKind;
}

/** A function's control-flow graph: dagre-laid-out glass panels with LOD text. */
export class FuncView {
  group = new THREE.Group();
  graph: FnGraph;
  panels: Panel[] = [];
  edges: Edge[] = [];
  private byAddr = new Map<number, Panel>();
  private edgeRibbons: Ribbons | null = null;
  private arrows: THREE.InstancedMesh | null = null;
  private title: LabelField | null = null;
  private backdrop: THREE.Mesh | null = null;
  private barTex: THREE.DataTexture;
  bounds = new THREE.Box3();
  private seekPanel: Panel | null = null;
  private hoverPanel: Panel | null = null;
  private rowHover: Panel | null = null;
  private frame = 0;
  ready: Promise<void>;
  layoutMs = 0;

  constructor(graph: FnGraph) {
    this.graph = graph;
    const blocks = graph.blocks ?? [];
    const has = new Set(blocks.map((b) => b.addr));
    for (const b of blocks) {
      const cond = b.fail !== undefined && b.jump !== undefined;
      if (b.jump !== undefined && has.has(b.jump)) this.edges.push({ from: b.addr, to: b.jump, kind: cond ? 'jump' : 'uncond' });
      if (b.fail !== undefined && has.has(b.fail)) this.edges.push({ from: b.addr, to: b.fail, kind: 'fail' });
      for (const c of b.switchop?.cases ?? []) if (has.has(c.jump)) this.edges.push({ from: b.addr, to: c.jump, kind: 'case' });
    }

    // text lines + sizes (no rasterisation yet)
    let totalRows = 0;
    blocks.forEach((b, i) => {
      const lines = this.linesOf(b, graph);
      const maxChars = Math.max(30, ...lines.map((l) => l.segs.reduce((s, x) => s + x[0].length, 0)));
      const pxW = Math.ceil(maxChars * CHAR_W + PAD_X * 2);
      const pxH = HEADER_H + lines.length * LINE_H + 14;
      const rows: Panel['rows'] = [];
      lines.forEach((l, k) => l.op && rows.push({ addr: l.op.addr, y0: HEADER_H + k * LINE_H + 4, y1: HEADER_H + (k + 1) * LINE_H + 4 }));
      const p: Panel = { block: b, mesh: null!, mat: null!, w: pxW / PX_PER_UNIT, h: pxH / PX_PER_UNIT, pxW, pxH, lines, rows, detail: null, lastUsed: 0, index: i };
      totalRows += lines.length;
      this.panels.push(p);
      this.byAddr.set(b.addr, p);
    });

    // shared "barcode" texture: one texel per line (colour + line length) for far LOD
    // 2D layout (256 texels per row) so huge functions never exceed max texture height
    const BW = 256;
    const H = Math.max(1, Math.ceil(Math.max(1, totalRows) / BW));
    const data = new Uint8Array(BW * H * 4);
    let r = 0;
    const tmp = new THREE.Color();
    const rowStart: number[] = [];
    for (const p of this.panels) {
      rowStart.push(r);
      for (const l of p.lines) {
        tmp.set(l.op ? opColor(l.op.type) : '#fff36b');
        const len = l.segs.reduce((s, x) => s + x[0].trimEnd().length, 0) * CHAR_W + PAD_X;
        data.set([tmp.r * 255, tmp.g * 255, tmp.b * 255, Math.min(255, (len / p.pxW) * 255)], r * 4);
        r++;
      }
    }
    this.barTex = new THREE.DataTexture(data, BW, H, THREE.RGBAFormat);
    this.barTex.needsUpdate = true;

    for (const p of this.panels) {
      const isEntry = p.block.addr === graph.addr;
      p.mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          ...globals,
          uMap: { value: null },
          uDetail: { value: 0 },
          uBar: { value: this.barTex },
          uBarRows: { value: new THREE.Vector3(rowStart[p.index], p.lines.length, H) },
          uSize: { value: new THREE.Vector2(p.w, p.h) },
          uPx: { value: new THREE.Vector2(p.pxW, p.pxH) },
          uHeader: { value: HEADER_H / p.pxH },
          uAccent: { value: new THREE.Color(isEntry ? 0xff2bd6 : 0x00e5ff) },
          uHover: { value: 0 },
          uSeek: { value: 0 },
          uRow: { value: new THREE.Vector2(-1, -1) },
          uRow2: { value: new THREE.Vector2(-1, -1) },
          uReveal: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying float vDist;
          void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z / length(viewMatrix[0].xyz); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: /* glsl */ `
          ${FOG_PARS}
          uniform sampler2D uMap;
          uniform sampler2D uBar;
          uniform float uDetail;
          uniform vec3 uBarRows;
          uniform vec2 uSize;
          uniform vec2 uPx;
          uniform float uHeader;
          uniform vec3 uAccent;
          uniform float uHover;
          uniform float uSeek;
          uniform vec2 uRow;
          uniform vec2 uRow2;
          uniform float uTime;
          uniform float uReveal;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            float yTop = 1.0 - vUv.y;
            if (yTop > uReveal) discard;
            vec2 w = vUv * uSize;
            vec2 e = min(w, uSize - w);
            float ed = min(e.x, e.y);
            float border = 1.0 - smoothstep(0.0, 0.06, ed);
            float glow = exp(-ed * 2.4) * 0.3;
            float corner = step(e.x, 1.0) * step(e.y, 1.0) * (1.0 - smoothstep(0.08, 0.16, ed));
            vec3 bg = mix(vec3(0.035, 0.012, 0.085), vec3(0.012, 0.02, 0.05), vUv.y);
            float header = step(yTop, uHeader);
            bg += uAccent * header * 0.13;
            bg += uAccent * (1.0 - smoothstep(0.0, 0.004, abs(yTop - uHeader))) * 0.8;
            bg *= 0.88 + 0.12 * sin(w.y * 40.0);
            float row = step(uRow.x, yTop) * step(yTop, uRow.y);
            float row2 = step(uRow2.x, yTop) * step(yTop, uRow2.y);
            bg += vec3(1.0, 0.85, 0.1) * row * (0.26 + 0.06 * sin(uTime * 6.0));
            bg += vec3(1.0, 0.9, 0.2) * row * step(vUv.x, 0.012) * 3.0;
            bg += vec3(0.2, 0.9, 1.0) * row2 * 0.18;
            vec3 text = vec3(0.0);
            if (uDetail > 0.5) {
              vec4 t = texture2D(uMap, vUv);
              text = t.rgb * t.a * 0.85;
            } else if (yTop > uHeader) {
              // far LOD: one bar per instruction, coloured by instruction class
              float py = yTop * uPx.y - ${HEADER_H.toFixed(1)} - 4.0;
              float r = floor(py / ${LINE_H.toFixed(1)});
              float fy = fract(py / ${LINE_H.toFixed(1)});
              if (r >= 0.0 && r < uBarRows.y) {
                float idx = uBarRows.x + r;
                vec4 b = texture2D(uBar, vec2((mod(idx, 256.0) + 0.5) / 256.0, (floor(idx / 256.0) + 0.5) / uBarRows.z));
                float x = vUv.x * uPx.x;
                float bar = step(${PAD_X.toFixed(1)}, x) * step(x, b.a * uPx.x) * step(0.3, fy) * step(fy, 0.7);
                text = b.rgb * b.rgb * bar * 0.6;
              }
            }
            float bb = 1.0 + uHover * 1.4 + uSeek * 1.3;
            vec3 col = bg + text + uAccent * (border * 1.7 + glow + corner * 2.4) * bb;
            col = applyFog(col, vDist * 0.5);
            gl_FragColor = vec4(col, 0.82 + border * 0.18);
          }`,
      });
      p.mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), p.mat);
      p.mesh.userData.panel = p.index;
      this.group.add(p.mesh);
    }
    this.ready = this.layout();
  }

  private linesOf(b: Block, g: FnGraph): Line[] {
    const ops = b.ops ?? [];
    const lines: Line[] = [];
    for (const op of ops.slice(0, MAX_LINES)) {
      for (const f of op.flags ?? []) if (f !== 'pc' && f !== g.name) lines.push({ segs: [[`;-- ${f}:`, '#fff36b']] });
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
          [args.length > 46 ? args.slice(0, 45) + '…' : args, '#d8f6ff'],
        ],
      });
    }
    if (ops.length > MAX_LINES) lines.push({ segs: [[`  … ${ops.length - MAX_LINES} more instructions`, '#8a7ab0']] });
    return lines;
  }

  private async layout() {
    const req: LayoutReq = {
      nodes: this.panels.map((p) => ({ id: String(p.block.addr), w: p.w, h: p.h })),
      edges: this.edges.map((e, i) => ({ v: String(e.from), w: String(e.to), name: `e${i}`, weight: e.kind === 'fail' ? 3 : e.kind === 'uncond' ? 2 : 1 })),
    };
    const res = await new Promise<LayoutRes>((resolve, reject) => {
      const w = new CFGWorker();
      w.onmessage = (ev) => {
        resolve(ev.data);
        w.terminate();
      };
      w.onerror = (e) => {
        reject(e);
        w.terminate();
      };
      w.postMessage(req);
    });
    this.layoutMs = res.ms;
    // dagre: y grows downward → flip; centre the graph horizontally around x=0
    const ox = res.width / 2;
    for (const p of this.panels) {
      const n = res.nodes[String(p.block.addr)];
      if (!n) continue;
      p.mesh.position.set(n.x - ox, -n.y, 0);
      this.bounds.expandByPoint(new THREE.Vector3(n.x - ox - p.w / 2, -n.y - p.h / 2, 0));
      this.bounds.expandByPoint(new THREE.Vector3(n.x - ox + p.w / 2, -n.y + p.h / 2, 0));
    }
    // edges along dagre's routed polylines, smoothed
    const specs: RibbonSpec[] = [];
    const heads: { p: THREE.Vector3; d: THREE.Vector3; c: THREE.Color }[] = [];
    this.edges.forEach((e, i) => {
      const pts = res.edges[`e${i}`];
      if (!pts || pts.length < 2) return;
      const v = pts.map((q) => new THREE.Vector3(q.x - ox, -q.y, 0.15));
      const curve = v.length > 2 ? new THREE.CatmullRomCurve3(v, false, 'centripetal', 0.5) : new THREE.LineCurve3(v[0], v[1]);
      const sampled = curve.getPoints(Math.min(60, 10 + v.length * 6));
      const c = EDGE_COLORS[e.kind];
      specs.push({ points: sampled, color0: c, color1: c, width: 2.2, alpha: 0.85, flow: 9, tag: i });
      const end = sampled[sampled.length - 1];
      const prev = sampled[Math.max(0, sampled.length - 3)];
      heads.push({ p: end, d: end.clone().sub(prev).normalize(), c });
    });
    this.edgeRibbons = new Ribbons(specs, { pulseSpacing: 9, renderOrder: 2 });
    this.edgeRibbons.material.uniforms.uReveal.value = 0;
    this.group.add(this.edgeRibbons.mesh);
    // arrowheads
    const cone = new THREE.ConeGeometry(0.42, 1.0, 12);
    cone.translate(0, -0.5, 0);
    this.arrows = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial({ toneMapped: false }), Math.max(1, heads.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    heads.forEach((h, i) => {
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.d);
      m.compose(h.p, q, new THREE.Vector3(1, 1, 1));
      this.arrows!.setMatrixAt(i, m);
      this.arrows!.setColorAt(i, h.c.clone().multiplyScalar(2.2));
    });
    this.arrows.count = heads.length;
    this.group.add(this.arrows);

    // title + backdrop
    const top = this.bounds.max.y;
    const bw = Math.max(1, this.bounds.max.x - this.bounds.min.x);
    const ts = Math.max(2.2, Math.min(7, bw * 0.08));
    const g = this.graph;
    this.title = new LabelField(
      [
        { text: g.name, color: PALETTE.magenta, position: new THREE.Vector3(0, top + ts * 1.9, 0), size: ts, font: `700 40px "Orbitron", sans-serif` },
        { text: `${hex(g.addr)} · ${g.blocks?.length ?? 0} blocks · ${this.edges.length} edges · ${g.ninstr} instrs · ${g.size} bytes`, color: PALETTE.cyan, position: new THREE.Vector3(0, top + ts * 0.85, 0), size: ts * 0.36 },
      ],
      { fadeFar: 4000, fadeNear: 4, px: 44, shrink: 160 },
    );
    this.group.add(this.title.mesh);
    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    const bgeo = new THREE.PlaneGeometry(Math.max(500, size.x * 3), Math.max(500, size.y * 3));
    const bmat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...globals },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vW;
        float gl(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s; vec2 fw = fwidth(p); vec2 l = 1.0 - smoothstep(vec2(0.0), fw * 1.2, g); return max(l.x, l.y); }
        void main() {
          vec2 p = vW.xy;
          // fade each grid level out before it gets denser than a few pixels (no aliasing far away)
          float fw = length(fwidth(p));
          float minor = gl(p, 4.0) * (1.0 - smoothstep(0.12, 0.5, fw));
          float major = gl(p, 32.0) * (1.0 - smoothstep(0.7, 2.6, fw));
          float g = minor * 0.1 + major * 0.4;
          float scan = exp(-pow(mod(p.y + uTime * 22.0, 160.0) - 80.0, 2.0) / 40.0);
          vec3 c = vec3(0.25, 0.05, 0.6) * g + vec3(0.0, 0.8, 1.0) * scan * major * 1.2;
          gl_FragColor = vec4(c, 0.85);
        }`,
    });
    this.backdrop = new THREE.Mesh(bgeo, bmat);
    const center = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.backdrop.position.set(center.x, center.y, -40);
    this.group.add(this.backdrop);
  }

  /** Animate panels & edges in (call after `ready`). */
  reveal(add: (fn: (dt: number) => void) => () => boolean) {
    let t = 0;
    const top = this.bounds.max.y;
    const span = Math.max(1, top - this.bounds.min.y);
    const off = add((dt) => {
      t += dt;
      for (const p of this.panels) {
        const delay = ((top - p.mesh.position.y) / span) * 1.2;
        p.mat.uniforms.uReveal.value = Math.min(1, Math.max(0, (t - delay) * 3));
      }
      if (this.edgeRibbons) this.edgeRibbons.material.uniforms.uReveal.value = Math.max(0, (t - 0.4) * 60);
      if (t > 3.8) {
        if (this.edgeRibbons) this.edgeRibbons.material.uniforms.uReveal.value = 1e9;
        for (const p of this.panels) p.mat.uniforms.uReveal.value = 1;
        off();
      }
    });
  }

  // ----------------------------------------------------------------- LOD
  /** Keep crisp text only on the panels that are big on screen. */
  updateLod(camera: THREE.PerspectiveCamera, viewH = window.innerHeight) {
    if (++this.frame % 6) return;
    const k = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const v = new THREE.Vector3();
    const scored: { p: Panel; px: number }[] = [];
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const p of this.panels) {
      if (!frustum.intersectsObject(p.mesh)) continue;
      p.mesh.getWorldPosition(v);
      const d = v.distanceTo(camera.position);
      const px = (p.h / Math.max(d, 0.1)) * k;
      if (px > 70) scored.push({ p, px });
    }
    scored.sort((a, b) => b.px - a.px);
    const want = new Set(scored.slice(0, MAX_DETAIL).map((s) => s.p));
    let created = 0;
    for (const p of want) {
      p.lastUsed = this.frame;
      if (!p.detail && created < 6) {
        p.detail = this.rasterise(p);
        p.mat.uniforms.uMap.value = p.detail;
        p.mat.uniforms.uDetail.value = 1;
        created++;
      }
    }
    const alive = this.panels.filter((p) => p.detail);
    if (alive.length > MAX_DETAIL) {
      alive
        .filter((p) => !want.has(p))
        .sort((a, b) => a.lastUsed - b.lastUsed)
        .slice(0, alive.length - MAX_DETAIL)
        .forEach((p) => {
          p.detail?.dispose();
          p.detail = null;
          p.mat.uniforms.uMap.value = null;
          p.mat.uniforms.uDetail.value = 0;
        });
    }
  }

  private rasterise(p: Panel): THREE.CanvasTexture {
    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = p.pxW * scale;
    cv.height = p.pxH * scale;
    const c = cv.getContext('2d')!;
    c.scale(scale, scale);
    c.textBaseline = 'middle';
    const g = this.graph;
    const isEntry = p.block.addr === g.addr;
    c.font = `700 ${FONT_PX - 2}px "Orbitron", sans-serif`;
    c.fillStyle = isEntry ? '#ff5be6' : '#5ef2ff';
    c.fillText(isEntry ? `◆ ${g.name}` : `◇ ${hex(p.block.addr)}`, PAD_X, HEADER_H / 2 + 2);
    c.font = `500 ${FONT_PX - 6}px "JetBrains Mono", monospace`;
    c.fillStyle = '#8f7fc4';
    const meta = `${p.block.ops?.length ?? 0} ops · ${p.block.size}B`;
    c.fillText(meta, p.pxW - PAD_X - c.measureText(meta).width, HEADER_H / 2 + 2);
    c.font = `500 ${FONT_PX}px "JetBrains Mono", monospace`;
    p.lines.forEach((l, i) => {
      const yy = HEADER_H + i * LINE_H + LINE_H / 2 + 4;
      let x = PAD_X;
      for (const [txt, col] of l.segs) {
        c.fillStyle = col;
        c.shadowColor = col;
        c.shadowBlur = 2;
        c.fillText(txt, x, yy);
        x += txt.length * CHAR_W;
      }
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  // ----------------------------------------------------------------- queries
  panelAt(addr: number): Panel | null {
    const direct = this.byAddr.get(addr);
    if (direct) return direct;
    for (const p of this.panels) if (addr >= p.block.addr && addr < p.block.addr + Math.max(1, p.block.size)) return p;
    return null;
  }

  succ(addr: number): Edge[] {
    return this.edges.filter((e) => e.from === addr);
  }

  preds(addr: number): Edge[] {
    return this.edges.filter((e) => e.to === addr);
  }

  setSeek(addr: number): Panel | null {
    if (this.seekPanel) {
      this.seekPanel.mat.uniforms.uSeek.value = 0;
      this.seekPanel.mat.uniforms.uRow.value.set(-1, -1);
      this.seekPanel.mesh.position.z = 0;
    }
    const p = this.panelAt(addr);
    this.seekPanel = p;
    if (p) {
      p.mat.uniforms.uSeek.value = 1;
      p.mesh.position.z = 1.2;
      const r = p.rows.find((r) => r.addr === addr) ?? p.rows.find((r) => r.addr <= addr && addr < r.addr + 1) ?? null;
      if (r) p.mat.uniforms.uRow.value.set(r.y0 / p.pxH, r.y1 / p.pxH);
    }
    return p;
  }

  /** Secondary highlight (e.g. hovered line in the Inspector). */
  hoverAddr(addr: number | null) {
    if (this.rowHover) this.rowHover.mat.uniforms.uRow2.value.set(-1, -1);
    this.rowHover = null;
    if (addr === null) return;
    const p = this.panelAt(addr);
    if (!p) return;
    const r = p.rows.find((r) => r.addr === addr);
    if (r) p.mat.uniforms.uRow2.value.set(r.y0 / p.pxH, r.y1 / p.pxH);
    this.rowHover = p;
  }

  hover(mesh: THREE.Object3D | null) {
    if (this.hoverPanel) this.hoverPanel.mat.uniforms.uHover.value = 0;
    this.hoverPanel = mesh ? (this.panels[mesh.userData.panel as number] ?? null) : null;
    if (this.hoverPanel) this.hoverPanel.mat.uniforms.uHover.value = 1;
  }

  opAtHit(mesh: THREE.Object3D, uv: THREE.Vector2): number | null {
    const p = this.panels[mesh.userData.panel as number];
    if (!p) return null;
    const y = (1 - uv.y) * p.pxH;
    return p.rows.find((r) => y >= r.y0 && y < r.y1)?.addr ?? p.block.addr;
  }

  pickables() {
    return this.panels.map((p) => p.mesh);
  }

  frameOf(p: Panel | null): { pos: THREE.Vector3; target: THREE.Vector3 } {
    if (!p) return this.overview();
    const target = p.mesh.position.clone();
    const span = Math.max(p.w * 0.75, p.h * 1.25);
    const dist = Math.max(20, span * 1.7);
    return { pos: target.clone().add(new THREE.Vector3(span * 0.1, -span * 0.04, dist)), target };
  }

  overview(aspect = window.innerWidth / window.innerHeight, fov = 55): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    this.bounds.getCenter(c);
    this.bounds.getSize(s);
    const t = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    // big graphs: frame the top part (entry) rather than a postage stamp of the whole thing
    const fitH = Math.min(s.y + 20, Math.max(80, (s.x + 20) / aspect) * 1.4);
    const dist = Math.max(40, Math.max(fitH / 2 / t, (s.x + 20) / 2 / (t * aspect)) * 0.92);
    const target = new THREE.Vector3(c.x, Math.min(c.y, this.bounds.max.y - fitH / 2 + 10), 0);
    return { pos: target.clone().add(new THREE.Vector3(dist * 0.18, -dist * 0.06, dist)), target };
  }

  dispose() {
    for (const p of this.panels) {
      p.detail?.dispose();
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    this.barTex.dispose();
    this.edgeRibbons?.dispose();
    this.arrows?.geometry.dispose();
    (this.arrows?.material as THREE.Material | undefined)?.dispose();
    this.title?.dispose();
    this.backdrop?.geometry.dispose();
    (this.backdrop?.material as THREE.Material | undefined)?.dispose();
  }
}
