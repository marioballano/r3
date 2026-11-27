import type { LayoutRes } from '../scene/cfg.worker';
import { EDGE_COLORS, functionDiagram, type FunctionDiagram } from '../scene/funcview';
import type { BlockRoom } from '../scene/interior';
import { hex } from '../types';
import { corners, h } from './dom';

const W = 250;
const H = 210;
const PAD = 10;

export class RoomMapSidebar {
  private canvas = h('canvas', { width: String(W * 2), height: String(H * 2), 'aria-hidden': 'true' });
  private where = h('div', { class: 'room-map-location' });
  private cases = h('div', { class: 'room-map-cases hidden' });
  private el: HTMLElement;
  private room: BlockRoom | null = null;
  private diagram: FunctionDiagram | null = null;
  private layout: LayoutRes | null = null;

  constructor(root: HTMLElement, open: () => void) {
    const full = h('button', { type: 'button', title: 'Open the full-screen building map' }, 'M · FULL MAP');
    full.onclick = open;
    this.el = corners(h('aside', { class: 'panel room-map-sidebar hidden', 'aria-label': 'Building map' },
      h('div', { class: 'room-map-top' }, h('strong', {}, 'YOU ARE HERE'), full), this.canvas, this.cases, this.where));
    root.append(this.el);
  }

  show(room: BlockRoom | null) {
    this.el.classList.toggle('hidden', !room);
    if (!room) {
      this.room = null;
      return;
    }
    if (this.room === room) return;
    const sameGraph = this.room?.plan.graph === room.plan.graph;
    this.room = room;
    this.where.textContent = `FLOOR ${room.floor} · ${hex(room.block.addr)}`;
    const cases = room.plan.outgoing(room.block.addr).filter((edge) => edge.kind === 'case');
    this.cases.classList.toggle('hidden', !cases.length);
    const destinations = new Set(cases.map((edge) => edge.to)).size;
    this.cases.textContent = `${cases.length} cases → ${destinations} ${destinations === 1 ? 'room' : 'rooms'}`;
    if (!sameGraph || !this.diagram) {
      const diagram = functionDiagram(room.plan.graph);
      if (this.diagram !== diagram) {
        this.diagram = diagram;
        this.layout = null;
        void diagram.layout.then((layout) => {
          if (this.diagram !== diagram) return;
          this.layout = layout;
          this.draw();
        }).catch(() => {
          if (this.diagram === diagram) this.diagram = null;
        });
      }
    }
    this.draw();
  }

  private draw() {
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.fillStyle = '#0c162a';
    ctx.fillRect(0, 0, W, H);
    const { room, layout, diagram } = this;
    if (!room || !layout || !diagram || !layout.width || !layout.height) return;

    const scale = Math.min((W - 2 * PAD) / layout.width, (H - 2 * PAD) / layout.height);
    const offsetX = (W - layout.width * scale) / 2;
    const offsetY = (H - layout.height * scale) / 2;
    const sx = (x: number) => offsetX + x * scale;
    const sy = (y: number) => offsetY + y * scale;
    const addr = room.block.addr;

    diagram.edges.forEach((edge, i) => {
      const points = layout.edges[`e${i}`];
      if (!points || points.length < 2) return;
      const incident = edge.from === addr || edge.to === addr;
      ctx.strokeStyle = '#' + EDGE_COLORS[edge.kind].getHexString();
      ctx.globalAlpha = incident ? 0.94 : edge.kind === 'case' ? 0.53 : 0.41;
      ctx.lineWidth = incident ? 1.1 : 0.72;
      ctx.beginPath();
      ctx.moveTo(sx(points[0].x), sy(points[0].y));
      for (let j = 1; j < points.length; j++) ctx.lineTo(sx(points[j].x), sy(points[j].y));
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    for (const panel of diagram.panels) {
      const p = layout.nodes[String(panel.block.addr)];
      if (!p) continue;
      const current = panel.block.addr === addr;
      const width = Math.max(current ? 4 : 1.7, panel.w * scale);
      const height = Math.max(current ? 3 : 1.45, panel.h * scale);
      ctx.fillStyle = current ? '#fff098' : panel.block.addr === room.plan.entry.addr ? '#ba64d3' : '#4992ad';
      ctx.fillRect(sx(p.x) - width / 2, sy(p.y) - height / 2, width, height);
    }

    const node = layout.nodes[String(addr)];
    if (!node) return;
    ctx.strokeStyle = '#ffe375';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx(node.x), sy(node.y), 5.5, 0, Math.PI * 2);
    ctx.stroke();
  }
}
