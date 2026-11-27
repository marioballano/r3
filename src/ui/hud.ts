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
  private tip_ = h('div', { class: 'tip hidden' });
  private cap = h('div', { class: 'caption' }, h('div', { class: 'c1' }), h('div', { class: 'c2' }));
  private log = h('div', { class: 'log' });
  private prog = h('div', { class: 'prog hidden' }, h('div', { class: 'pct' }, '0%'), h('div', { class: 'txt' }, ''), h('div', { class: 'bar' }, h('div', { class: 'fill' })));
  private mute = h('span', { class: 'mute' });
  private modeEl = h('div', { class: 'mode' }, 'ORBIT');
  private cross = h('div', { class: 'crosshair hidden' });
  private walkStatus = h('div', { class: 'walk-status hidden' }, h('strong'), h('span'));
  private crumbs = h('div', { class: 'crumbs' });
  private depthEl = h('div', { class: 'depth hidden' });
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
      h('div', { class: 'tr' }, this.seekEl, this.fname, this.viewEl, this.modeEl, this.depthEl),
      this.crumbs,
      this.cross,
      this.walkStatus,
      this.stats,
      this.log,
      this.cap,
      this.prog,
      h(
        'div',
        { class: 'bottom' },
        h('div', { class: 'ent' }, h('div', { class: 'lbl' }, 'ENTROPY'), this.ent),
        h(
          'div',
          { class: 'keys' },
          h('kbd', {}, 'Ctrl K'),
          'search ',
          h('kbd', {}, 'F'),
          'drone ',
          h('kbd', {}, 'G'),
          'walk ',
          h('kbd', {}, 'C'),
          'graph ',
          h('kbd', {}, '⏎'),
          'core ',
          h('kbd', {}, 'I'),
          'inspect ',
          h('kbd', {}, '~'),
          'shell ',
          h('kbd', {}, 'Alt ←'),
          'back ',
          h('kbd', {}, '?'),
          'help ',
        ),
        this.mute,
      ),
      this.tip_,
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

  /** Rich tooltip near the cursor (html is trusted, built by the app). */
  tip(html: string | null, p: { x: number; y: number }) {
    if (!html) return this.tip_.classList.add('hidden');
    this.tip_.classList.remove('hidden');
    this.tip_.innerHTML = html;
    const w = this.tip_.offsetWidth;
    const x = p.x + 18 + w > window.innerWidth - (document.body.classList.contains('ins-open') ? 500 : 10) ? p.x - w - 18 : p.x + 18;
    this.tip_.style.left = `${x}px`;
    this.tip_.style.top = `${p.y + 18}px`;
    this.tip_.style.transform = 'none';
  }

  setMode(mode: string) {
    this.modeEl.textContent = mode === 'drone' ? '◉ DRONE · WASD QE ⇧ · mouse look'
      : mode === 'walk' ? '◉ ON FOOT · WASD · ⇧ WASD/arrows sprint · Space jump' : '○ ORBIT';
    this.modeEl.classList.toggle('drone', mode === 'drone');
    this.modeEl.classList.toggle('on-foot', mode === 'walk');
    this.cross.classList.toggle('hidden', mode === 'orbit');
  }

  setWalkHint(title: string, controls = '') {
    this.walkStatus.classList.toggle('hidden', !title);
    if (this.walkStatus.firstElementChild!.textContent !== title) this.walkStatus.firstElementChild!.textContent = title;
    if (this.walkStatus.lastElementChild!.textContent !== controls) this.walkStatus.lastElementChild!.textContent = controls;
  }

  setDepth(d: number | null) {
    this.depthEl.classList.toggle('hidden', d === null);
    if (d !== null) this.depthEl.innerHTML = `FOCUS DEPTH ${[1, 2, 3].map((k) => `<span class="${k === d ? 'on' : ''}">${k}</span>`).join('')}`;
  }

  setCrumbs(items: { label: string; current: boolean; onClick: () => void }[]) {
    this.crumbs.innerHTML = '';
    items.forEach((it, i) => {
      if (i) this.crumbs.append(h('span', { class: 'sep' }, '›'));
      const c = h('span', { class: `crumb ${it.current ? 'cur' : ''}` });
      c.textContent = it.label;
      c.onclick = it.onClick;
      this.crumbs.append(c);
    });
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
