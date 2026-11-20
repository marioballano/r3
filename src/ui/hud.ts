import type { Tower } from '../scene/city';
import { hex, humanSize, type EntropyData, type InfoMsg } from '../types';
import { audio } from '../audio/audio';
import { h, scramble } from './dom';

export class Hud {
  el = h('div', { class: 'hud' });
  private file = h('div', { class: 'file' });
  private meta = h('div', { class: 'meta' });
  private seekEl = h('div', { class: 'seek' }, '0x00000000');
  private fname = h('div', { class: 'fname' }, '');
  private viewEl = h('div', { class: 'view' }, 'STANDBY');
  private stats = h('div', { class: 'stats' });
  private ent = h('canvas');
  private tip = h('div', { class: 'tip hidden' });
  private cap = h('div', { class: 'caption' }, h('div', { class: 'c1' }), h('div', { class: 'c2' }));
  private log = h('div', { class: 'log' });
  private prog = h('div', { class: 'prog hidden' }, h('div', { class: 'pct' }, '0%'), h('div', { class: 'txt' }, ''), h('div', { class: 'bar' }, h('div', { class: 'fill' })));
  private mute = h('span', { class: 'mute' });
  private entropy: EntropyData | null = null;
  private seekFrac = -1;
  private capTimer = 0;

  constructor(root: HTMLElement) {
    const bars = h('span', { class: 'bars' });
    for (let i = 0; i < 5; i++) bars.append(h('i', { style: 'height: 4px' }));
    this.mute.append(bars, h('span', {}, 'AUDIO'));
    this.mute.onclick = () => {
      audio.setMuted(!audio.muted);
      this.mute.classList.toggle('off', audio.muted);
    };
    const animBars = () => {
      const l = audio.level();
      bars.querySelectorAll('i').forEach((b, i) => ((b as HTMLElement).style.height = `${2 + Math.min(10, (l * 22 + Math.random() * 3) * (0.5 + ((i * 7) % 5) / 5))}px`));
      requestAnimationFrame(animBars);
    };
    animBars();
    this.el.append(
      h('div', { class: 'tl' }, h('div', { class: 'brand' }, 'r3', h('small', {}, 'radare2 // 3d')), this.file, this.meta),
      h('div', { class: 'tr' }, this.seekEl, this.fname, this.viewEl),
      this.stats,
      this.log,
      this.cap,
      this.prog,
      h(
        'div',
        { class: 'bottom' },
        h('div', { class: 'ent' }, h('div', { class: 'lbl' }, 'ENTROPY'), this.ent),
        h('div', { class: 'keys' }, h('kbd', {}, '~'), 'shell ', h('kbd', {}, 'T'), 'tour ', h('kbd', {}, 'Esc'), 'back ', h('kbd', {}, 'dbl-click'), 'dive  '),
        this.mute,
      ),
      this.tip,
    );
    root.append(this.el);
    window.addEventListener('resize', () => this.drawEntropy());
  }

  setInfo(m: InfoMsg) {
    scramble(this.file, m.path, 700);
    const b = m.info?.bin ?? {};
    this.meta.innerHTML = `<span>${(m.format ?? m.info?.core?.format ?? '?').toUpperCase()}</span> · ${b.arch ?? '?'}/${b.bits ?? '?'} · ${b.os ?? '?'} · ${humanSize(m.size)} · sha256 <span>${m.hash.slice(0, 16)}</span>`;
    this.entropy = m.entropy;
    this.setStats({ sections: m.sections.length, strings: m.strings.length, imports: m.imports.length, symbols: m.symbols.length });
    this.drawEntropy();
  }

  private statVals: Record<string, number | string> = {};
  setStats(s: Record<string, number | string>) {
    Object.assign(this.statVals, s);
    this.stats.innerHTML = Object.entries(this.statVals)
      .map(([k, v]) => `${k} <b>${v}</b>`)
      .join('<br>');
  }

  setSeek(addr: number | null, fn?: string) {
    const s = hex(addr);
    if (this.seekEl.textContent !== s) scramble(this.seekEl, s, 280);
    this.fname.textContent = fn ?? '';
    if (addr !== null && this.entropy?.size) {
      this.seekFrac = -1;
    }
  }

  setSeekFrac(f: number) {
    this.seekFrac = f;
    this.drawEntropy();
  }

  setView(v: string) {
    scramble(this.viewEl, v, 400);
  }

  caption(a: string, b = '') {
    const [c1, c2] = this.cap.children as unknown as HTMLElement[];
    clearTimeout(this.capTimer);
    if (!a) {
      this.cap.style.opacity = '0';
      return;
    }
    this.cap.style.opacity = '1';
    scramble(c1, a, 500);
    c2.textContent = b;
    this.capTimer = window.setTimeout(() => (this.cap.style.opacity = '0'), 6000);
  }

  tower(t: Tower | null, p: { x: number; y: number }) {
    if (!t) {
      this.tip.classList.add('hidden');
      return;
    }
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${p.x}px`;
    this.tip.style.top = `${p.y}px`;
    const f = t.fn;
    this.tip.innerHTML = `<div class="n"></div><div class="a">${hex(f.addr)}</div><div><span class="k">size</span> <span class="v">${f.size}</span> <span class="k">blocks</span> <span class="v">${f.nbbs}</span> <span class="k">cc</span> <span class="v">${f.cc}</span></div><div><span class="k">calls in</span> <span class="v">${f.indeg}</span> <span class="k">out</span> <span class="v">${f.outdeg}</span> <span class="k">args</span> <span class="v">${f.nargs}</span></div>`;
    (this.tip.firstChild as HTMLElement).textContent = f.name;
  }

  sat(name: string | null, p: { x: number; y: number }) {
    if (!name) return this.tip.classList.add('hidden');
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${p.x}px`;
    this.tip.style.top = `${p.y}px`;
    this.tip.innerHTML = `<div class="k">IMPORT RELAY</div><div class="n"></div>`;
    (this.tip.lastChild as HTMLElement).textContent = name;
  }

  logLine(text: string, ok = false) {
    const ln = h('div', { class: `ln ${ok ? 'ok' : ''}` }, `${ok ? '✓' : '›'} ${text}`);
    this.log.append(ln);
    while (this.log.children.length > 12) this.log.firstChild?.remove();
  }

  clearLog(delay = 0) {
    setTimeout(() => {
      this.log.style.transition = 'opacity 1s';
      this.log.style.opacity = '0';
      setTimeout(() => {
        this.log.replaceChildren();
        this.log.style.opacity = '1';
      }, 1000);
    }, delay);
  }

  progress(msg: string, p: number) {
    this.prog.classList.remove('hidden');
    this.prog.style.opacity = p >= 1 ? '0' : '1';
    const [pct, txt, bar] = this.prog.children as unknown as HTMLElement[];
    pct.textContent = `${Math.round(p * 100)}%`;
    txt.textContent = msg;
    (bar.firstChild as HTMLElement).style.width = `${p * 100}%`;
    if (p >= 1) setTimeout(() => this.prog.classList.add('hidden'), 900);
  }

  private drawEntropy() {
    const cv = this.ent;
    const w = (cv.width = cv.clientWidth * devicePixelRatio);
    const hh = (cv.height = cv.clientHeight * devicePixelRatio);
    const g = cv.getContext('2d');
    if (!g || !w) return;
    g.clearRect(0, 0, w, hh);
    const e = this.entropy?.entropy ?? [];
    if (!e.length) return;
    const bw = w / e.length;
    for (let i = 0; i < e.length; i++) {
      const v = e[i].value / 255;
      const y = Math.pow(v, 1.6) * hh;
      const grad = v > 0.9 ? '#fff200' : v > 0.75 ? '#ff2bd6' : v > 0.45 ? '#8a3dff' : '#00f0ff';
      g.fillStyle = grad;
      g.globalAlpha = 0.35 + v * 0.65;
      g.fillRect(i * bw, hh - y, Math.max(1, bw - 1), y);
    }
    g.globalAlpha = 1;
    if (this.seekFrac >= 0) {
      g.fillStyle = '#fff';
      g.shadowColor = '#fff200';
      g.shadowBlur = 10;
      g.fillRect(this.seekFrac * w - 1, 0, 2 * devicePixelRatio, hh);
    }
  }
}
