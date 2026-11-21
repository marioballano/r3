import type { World } from '../scene/world';
import { h } from './dom';

/** Top-down radar: the city footprint, camera cone, focus neighbourhood; click to travel. */
export class Minimap {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  private extent = 200;
  private label: HTMLElement;
  onTravel: (x: number, z: number) => void = () => {};

  constructor(
    root: HTMLElement,
    private world: World,
  ) {
    this.cv = h('canvas', { width: '220', height: '220' });
    this.label = h('div', { class: 'mm-lbl' }, 'RADAR');
    this.el = h('div', { class: 'minimap hidden' }, this.label, this.cv);
    root.append(this.el);
    this.cv.onclick = (e) => {
      const r = this.cv.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width;
      const v = (e.clientY - r.top) / r.height;
      this.onTravel((u - 0.5) * 2 * this.extent, (v - 0.5) * 2 * this.extent);
    };
    const loop = () => {
      requestAnimationFrame(loop);
      this.draw();
    };
    loop();
  }

  rebuild() {
    const city = this.world.city;
    if (!city) return;
    const R = (this.world.sats?.radius ?? city.radius + 140) + 20;
    this.extent = R;
    const S = 220;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    const px = (x: number) => ((x / R) * 0.5 + 0.5) * S;
    g.fillStyle = 'rgba(6,2,18,0.85)';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(0,240,255,0.12)';
    for (let i = 1; i < 6; i++) {
      g.beginPath();
      g.arc(S / 2, S / 2, (i / 6) * S * 0.5, 0, Math.PI * 2);
      g.stroke();
    }
    const halo = this.world.halo?.radius;
    if (halo) {
      g.strokeStyle = 'rgba(255,43,214,0.55)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(S / 2, S / 2, (halo / R) * S * 0.5, 0, Math.PI * 2);
      g.stroke();
    }
    for (const t of city.towers) {
      const s = Math.max(1.2, (t.width / R) * S * 0.5);
      g.fillStyle = `rgb(${(t.color.r * 255) | 0},${(t.color.g * 255) | 0},${(t.color.b * 255) | 0})`;
      g.globalAlpha = 0.35 + Math.min(0.65, t.height / 60);
      g.fillRect(px(t.pos.x) - s / 2, px(t.pos.z) - s / 2, s, s);
    }
    g.globalAlpha = 1;
    for (const s of this.world.sats?.sats ?? []) {
      g.fillStyle = '#7af7ff';
      g.fillRect(px(s.pos.x) - 1, px(s.pos.z) - 1, 2, 2);
    }
    this.base = c;
  }

  private draw() {
    const w = this.world;
    const visible = w.view === 'city' && !!this.base && !w.isPlaceholder;
    this.el.classList.toggle('hidden', !visible);
    if (!visible) return;
    const S = 220;
    const g = this.cv.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.base!, 0, 0);
    const R = this.extent;
    const px = (x: number) => ((x / R) * 0.5 + 0.5) * S;
    // focus neighbourhood
    const f = w.focus;
    const city = w.city!;
    if (f) {
      for (const [fi, n] of f.nb) {
        const t = city.towerOfFn(fi);
        if (!t) continue;
        g.fillStyle = n.hop === 0 ? '#fff200' : n.role === 'caller' ? '#10f4ff' : n.role === 'callee' ? '#ff2bd6' : '#ffffff';
        const s = n.hop === 0 ? 6 : 3.5;
        g.fillRect(px(t.pos.x) - s / 2, px(t.pos.z) - s / 2, s, s);
      }
    }
    // camera cone
    const c = w.cameraXZ();
    const cx = px(c.x);
    const cz = px(c.z);
    const ang = Math.atan2(c.dz, c.dx);
    const half = Math.atan(Math.tan((c.fov * Math.PI) / 360) * c.aspect);
    const len = 46;
    const grad = g.createRadialGradient(cx, cz, 0, cx, cz, len);
    grad.addColorStop(0, 'rgba(255,242,0,0.45)');
    grad.addColorStop(1, 'rgba(255,242,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx, cz);
    g.arc(cx, cz, len, ang - half, ang + half);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff200';
    g.beginPath();
    g.arc(cx, cz, 3, 0, Math.PI * 2);
    g.fill();
    this.label.textContent = w.rig.mode === 'drone' ? 'RADAR · DRONE' : 'RADAR';
  }
}
