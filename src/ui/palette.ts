import { audio } from '../audio/audio';
import { esc, h } from './dom';

export interface PaletteItem {
  kind: 'fn' | 'imp' | 'str' | 'sec' | 'sym' | 'cmd' | 'addr';
  label: string;
  detail?: string;
  /** extra text matched but not shown prominently */
  keywords?: string;
  run: () => void;
}

const BADGE: Record<PaletteItem['kind'], string> = { fn: 'FN', imp: 'IMP', str: 'STR', sec: 'SEC', sym: 'SYM', cmd: 'CMD', addr: 'ADDR' };

const KIND_BONUS: Partial<Record<PaletteItem['kind'], number>> = { fn: 45, imp: 40, sym: 15, sec: 10, cmd: 5 };

/** Fuzzy subsequence score with bonuses for word starts, contiguity and prefix. */
export function fuzzy(q: string, s: string): number {
  if (!q) return 1;
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  const direct = sl.indexOf(ql);
  if (direct >= 0) return 1000 - direct * 2 - (sl.length - ql.length) * 0.1 + (direct === 0 ? 200 : 0);
  let score = 0;
  let si = 0;
  let run = 0;
  for (let qi = 0; qi < ql.length; qi++) {
    const c = ql[qi];
    let found = -1;
    for (; si < sl.length; si++)
      if (sl[si] === c) {
        found = si;
        break;
      }
    if (found < 0) return -1;
    const boundary = found === 0 || /[._\-\s/:]/.test(sl[found - 1]);
    run = found > 0 && sl[found - 1] === ql[qi - 1] ? run + 1 : 0;
    score += 10 + (boundary ? 15 : 0) + run * 6;
    si = found + 1;
  }
  return score - sl.length * 0.05;
}

/** Ctrl+K command palette: search everything in the binary and jump there. */
export class Palette {
  el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private items: PaletteItem[] = [];
  private shown: PaletteItem[] = [];
  private sel = 0;
  isOpen = false;
  source: (q: string) => PaletteItem[] = () => [];

  constructor(root: HTMLElement) {
    this.input = h('input', { class: 'pal-in', spellcheck: 'false', placeholder: 'search functions, strings, imports, sections, symbols, 0xaddress, commands…' });
    this.list = h('div', { class: 'pal-list' });
    const hint = h('div', { class: 'pal-hint' }, '↑↓ select · ⏎ go · esc close · prefix: f: s: i: > for commands');
    this.el = h('div', { class: 'pal-wrap hidden' }, h('div', { class: 'panel pal' }, this.input, this.list, hint));
    root.append(this.el);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.input.oninput = () => this.refresh();
    this.input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') this.move(1);
      else if (e.key === 'ArrowUp') this.move(-1);
      else if (e.key === 'PageDown') this.move(10);
      else if (e.key === 'PageUp') this.move(-10);
      else if (e.key === 'Enter') this.choose(this.shown[this.sel]);
      else if (e.key === 'Escape') this.close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
  }

  open(prefill = '') {
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.input.value = prefill;
    this.items = this.source('');
    this.refresh();
    requestAnimationFrame(() => this.input.focus());
    audio.blip(1200, 0.05, 'triangle', 0.04);
  }

  close() {
    this.isOpen = false;
    this.el.classList.add('hidden');
    this.input.blur();
  }

  private refresh() {
    const raw = this.input.value.trim();
    let q = raw;
    let only: PaletteItem['kind'][] | null = null;
    const pre = raw.match(/^([fsi>]):?\s*/);
    if (pre && (raw[1] === ':' || raw[0] === '>')) {
      only = pre[1] === 'f' ? ['fn'] : pre[1] === 's' ? ['str'] : pre[1] === 'i' ? ['imp'] : ['cmd'];
      q = raw.slice(pre[0].length);
    }
    const dyn = this.source(q).filter((x) => x.kind === 'addr');
    const scored: { it: PaletteItem; s: number }[] = [];
    for (const it of this.items) {
      if (only && !only.includes(it.kind)) continue;
      const s = Math.max(fuzzy(q, it.label), it.keywords ? fuzzy(q, it.keywords) - 40 : -1);
      if (s > 0) scored.push({ it, s: s + (KIND_BONUS[it.kind] ?? 0) + (it.kind === 'cmd' && !q ? 60 : 0) });
    }
    scored.sort((a, b) => b.s - a.s);
    this.shown = [...dyn, ...scored.slice(0, 80).map((x) => x.it)];
    this.sel = 0;
    this.list.innerHTML = this.shown
      .map(
        (it, i) =>
          `<div class="pal-row ${i === 0 ? 'sel' : ''}" data-i="${i}"><span class="pal-b ${it.kind}">${BADGE[it.kind]}</span><span class="pal-l">${esc(it.label)}</span><span class="pal-d">${esc(it.detail ?? '')}</span></div>`,
      )
      .join('');
    if (!this.shown.length) this.list.innerHTML = `<div class="pal-empty">no matches</div>`;
    this.list.querySelectorAll('.pal-row').forEach((r) => {
      (r as HTMLElement).onmouseenter = () => this.setSel(Number((r as HTMLElement).dataset.i));
      (r as HTMLElement).onclick = () => this.choose(this.shown[Number((r as HTMLElement).dataset.i)]);
    });
  }

  private setSel(i: number) {
    const rows = this.list.querySelectorAll('.pal-row');
    rows[this.sel]?.classList.remove('sel');
    this.sel = Math.max(0, Math.min(this.shown.length - 1, i));
    rows[this.sel]?.classList.add('sel');
    (rows[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private move(d: number) {
    this.setSel(this.sel + d);
    audio.key();
  }

  private choose(it: PaletteItem | undefined) {
    if (!it) return;
    this.close();
    audio.confirm();
    it.run();
  }
}
