import type { Model } from '../model';
import type { R2Socket } from '../net/socket';
import { hex, type InspectMsg, type Op } from '../types';
import { opColor } from '../scene/funcview';
import { audio } from '../audio/audio';
import { corners, esc, h } from './dom';

export type Tab = 'disasm' | 'pseudo' | 'xrefs' | 'info';

export interface InspectorHost {
  /** seek within / to an address (fly the world there) */
  goto(addr: number): void;
  /** open a function (select + focus); `site` = address to land on */
  openFn(fi: number, site?: number): void;
  core(fi: number, site?: number): void;
  constellation(fi: number): void;
  focus(fi: number): void;
  hoverAddr(addr: number | null): void;
}

interface Row {
  kind: 'op' | 'label' | 'xref' | 'sep';
  op?: Op;
  text?: string;
  addr?: number;
}

const ROW_H = 19;
const GUTTER = 64;

/** Holographic, razor-sharp code inspector docked to the right. Synced with the 3D world. */
export class Inspector {
  el: HTMLElement;
  isOpen = false;
  fi = -1;
  tab: Tab = 'disasm';
  private body: HTMLElement;
  private head: HTMLElement;
  private tabsEl: HTMLElement;
  private cache = new Map<number, InspectMsg>();
  private pdcCache = new Map<number, string>();
  private data: InspectMsg | null = null;
  // disasm virtual list
  private rows: Row[] = [];
  private rowOf = new Map<number, number>();
  private arrows: { from: number; to: number; lane: number; cond: boolean }[] = [];
  private scroller: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private seek: number | null = null;
  private hoverRow = -1;
  private reqId = 0;
  onToggle: (open: boolean) => void = () => {};

  constructor(
    root: HTMLElement,
    private sock: () => R2Socket | null,
    private model: () => Model | null,
    private host: InspectorHost,
  ) {
    this.head = h('div', { class: 'ins-head' });
    this.tabsEl = h('div', { class: 'ins-tabs' });
    this.body = h('div', { class: 'ins-body' });
    this.el = corners(h('div', { class: 'panel inspector closed' }, this.head, this.tabsEl, this.body));
    root.append(this.el);
    for (const [t, label] of [
      ['disasm', 'DISASM'],
      ['pseudo', 'PSEUDO-C'],
      ['xrefs', 'XREFS'],
      ['info', 'INFO'],
    ] as const) {
      const b = h('button', { class: 'ins-tab', 'data-tab': t }, label);
      b.onclick = () => this.setTab(t);
      this.tabsEl.append(b);
    }
  }

  toggle(force?: boolean) {
    this.isOpen = force ?? !this.isOpen;
    this.el.classList.toggle('closed', !this.isOpen);
    document.body.classList.toggle('ins-open', this.isOpen);
    this.onToggle(this.isOpen);
    if (this.isOpen && this.fi >= 0) this.render();
  }

  setTab(t: Tab) {
    this.tab = t;
    audio.blip(880, 0.03, 'triangle', 0.03);
    this.render();
  }

  async show(fi: number, seek?: number) {
    const m = this.model();
    if (!m) return;
    if (!this.isOpen) this.toggle(true);
    const changed = fi !== this.fi;
    this.fi = fi;
    if (seek !== undefined) this.seek = seek;
    this.renderHead();
    if (changed) {
      this.data = this.cache.get(fi) ?? null;
      this.scroller = null;
      if (!this.data) {
        this.body.innerHTML = `<div class="ins-loading">decoding ${esc(m.fns[fi].name)}…</div>`;
        const id = ++this.reqId;
        const d = await this.sock()?.inspect(m.fns[fi].addr);
        if (!d || id !== this.reqId) return;
        this.cache.set(fi, d);
        this.data = d;
      }
      this.buildRows();
      this.render();
    } else if (seek !== undefined) this.setSeek(seek);
  }

  private renderHead() {
    const m = this.model()!;
    const f = m.fns[this.fi];
    const callers = m.callers(this.fi).length;
    const callees = m.callees(this.fi).length;
    this.head.innerHTML = '';
    const name = h('div', { class: 'ins-name' });
    name.textContent = f.name;
    const meta = h('div', { class: 'ins-meta' });
    meta.innerHTML = `<span class="a">${hex(f.addr)}</span> · ${f.size}B · ${f.nbbs} blocks · cc ${f.cc} · <span class="in">▲ ${callers}</span> <span class="out">▼ ${callees}</span>`;
    const acts = h('div', { class: 'ins-acts' });
    const mk = (label: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'ins-act', title }, label);
      b.onclick = fn;
      acts.append(b);
    };
    mk('◎ FOCUS', 'call graph in the city (click tower)', () => this.host.focus(this.fi));
    mk('✶ GRAPH', 'call-graph constellation (C)', () => this.host.constellation(this.fi));
    mk('◈ CORE', 'control-flow core (Enter)', () => this.host.core(this.fi, this.seek ?? undefined));
    const close = h('button', { class: 'ins-close', title: 'close (I)' }, '✕');
    close.onclick = () => this.toggle(false);
    this.head.append(close, name, meta, acts);
    if (f.sig) {
      const sig = h('div', { class: 'ins-sig' });
      sig.textContent = f.sig;
      this.head.append(sig);
    }
  }

  private render() {
    for (const b of this.tabsEl.querySelectorAll('.ins-tab')) b.classList.toggle('on', (b as HTMLElement).dataset.tab === this.tab);
    if (this.fi < 0) return;
    if (this.tab === 'disasm') return this.renderDisasm();
    if (this.tab === 'pseudo') return void this.renderPseudo();
    if (this.tab === 'xrefs') return this.renderXrefs();
    return this.renderInfo();
  }

  // --------------------------------------------------------------- disasm
  private buildRows() {
    const ops = this.data?.ops ?? [];
    const m = this.model()!;
    const f = m.fns[this.fi];
    const targets = new Set<number>();
    for (const o of ops) if (o.jump !== undefined && o.type && /jmp/.test(o.type) && o.jump >= f.min && o.jump <= f.max) targets.add(o.jump);
    const rows: Row[] = [];
    const rowOf = new Map<number, number>();
    let prevEnds = false;
    ops.forEach((o, i) => {
      if (i > 0 && (prevEnds || targets.has(o.addr))) rows.push({ kind: 'sep' });
      for (const fl of o.flags ?? []) if (fl !== 'pc') rows.push({ kind: 'label', text: `;-- ${fl}:`, addr: o.addr });
      const xr = (o.xrefs ?? []).filter((x) => x.type === 'CODE' || x.type === 'CALL');
      if (xr.length && i > 0) {
        const s = xr.slice(0, 3).map((x) => hex(x.addr, 0)).join(', ');
        rows.push({ kind: 'xref', text: `; ${xr[0].type} XREF${xr.length > 1 ? 'S' : ''} from ${s}${xr.length > 3 ? ` +${xr.length - 3}` : ''}`, addr: o.addr });
      }
      rowOf.set(o.addr, rows.length);
      rows.push({ kind: 'op', op: o, addr: o.addr });
      prevEnds = !!o.type && (/jmp/.test(o.type) || o.type === 'ret' || o.type === 'trap');
    });
    this.rows = rows;
    this.rowOf = rowOf;
    // jump arrows with lane allocation (shorter spans get inner lanes)
    const arrows: { from: number; to: number; lane: number; cond: boolean }[] = [];
    for (const o of ops) {
      if (o.jump === undefined || !o.type || !/jmp/.test(o.type)) continue;
      const a = rowOf.get(o.addr);
      const b = rowOf.get(o.jump);
      if (a === undefined || b === undefined) continue;
      arrows.push({ from: a, to: b, lane: 0, cond: o.type.includes('cjmp') });
    }
    arrows.sort((x, y) => Math.abs(x.to - x.from) - Math.abs(y.to - y.from));
    const lanes: [number, number][][] = [];
    for (const a of arrows) {
      const lo = Math.min(a.from, a.to);
      const hi = Math.max(a.from, a.to);
      let l = 0;
      while (lanes[l]?.some(([x, y]) => !(hi < x || lo > y))) l++;
      (lanes[l] ??= []).push([lo, hi]);
      a.lane = Math.min(l, 7);
    }
    this.arrows = arrows;
  }

  private renderDisasm() {
    this.body.innerHTML = '';
    if (!this.data) return;
    const scroller = h('div', { class: 'dis-scroll' });
    const spacer = h('div', { class: 'dis-spacer' });
    const layer = h('div', { class: 'dis-layer' });
    const canvas = h('canvas', { class: 'dis-arrows' });
    spacer.style.height = `${this.rows.length * ROW_H}px`;
    spacer.append(layer);
    scroller.append(spacer);
    this.body.append(scroller, canvas);
    this.scroller = scroller;
    this.layer = layer;
    this.canvas = canvas;
    scroller.onscroll = () => this.paint();
    layer.onmousemove = (e) => {
      const t = (e.target as HTMLElement).closest('.dr') as HTMLElement | null;
      const i = t ? Number(t.dataset.i) : -1;
      if (i === this.hoverRow) return;
      this.hoverRow = i;
      const r = this.rows[i];
      this.host.hoverAddr(r?.kind === 'op' ? r.addr! : null);
      this.paintArrows();
      for (const el of layer.querySelectorAll('.dr.hov')) el.classList.remove('hov');
      t?.classList.add('hov');
    };
    layer.onmouseleave = () => {
      this.hoverRow = -1;
      this.host.hoverAddr(null);
      this.paintArrows();
    };
    layer.onclick = (e) => {
      const tok = (e.target as HTMLElement).closest('.tk') as HTMLElement | null;
      if (tok) {
        e.stopPropagation();
        return this.follow(tok);
      }
      const t = (e.target as HTMLElement).closest('.dr') as HTMLElement | null;
      const r = t ? this.rows[Number(t.dataset.i)] : null;
      if (r?.addr !== undefined) this.host.goto(r.addr);
    };
    requestAnimationFrame(() => {
      if (this.seek !== null) this.scrollTo(this.seek, 'center');
      this.paint();
    });
  }

  private paint() {
    const sc = this.scroller;
    const layer = this.layer;
    if (!sc || !layer) return;
    const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 10);
    const last = Math.min(this.rows.length, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H) + 10);
    const m = this.model()!;
    const strAt = new Map<number, string>();
    for (const r of m.strOut[this.fi]) if (!strAt.has(r.site)) strAt.set(r.site, m.strings.get(r.vaddr)?.string ?? '');
    let html = '';
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const top = i * ROW_H;
      if (r.kind === 'sep') {
        html += `<div class="dr sep" data-i="${i}" style="top:${top}px"></div>`;
        continue;
      }
      if (r.kind !== 'op') {
        html += `<div class="dr ${r.kind}" data-i="${i}" style="top:${top}px"><span class="tx">${esc(r.text ?? '')}</span></div>`;
        continue;
      }
      const o = r.op!;
      const dis = (o.disasm ?? o.opcode ?? '').trim();
      const sp = dis.indexOf(' ');
      const mn = sp > 0 ? dis.slice(0, sp) : dis;
      const args = sp > 0 ? dis.slice(sp + 1) : '';
      let cm = '';
      if (o.type === 'call' && o.jump !== undefined) {
        const ci = m.entryAt(o.jump);
        if (ci >= 0 && m.fns[ci].imp) cm = `import`;
      }
      const s = strAt.get(o.addr);
      if (s) cm = `"${s.length > 60 ? s.slice(0, 60) + '…' : s}"`;
      if (o.comment) {
        try {
          cm = (cm ? cm + ' · ' : '') + atob(o.comment);
        } catch {
          /* not base64 */
        }
      }
      const seek = o.addr === this.seek ? ' seek' : '';
      html +=
        `<div class="dr op${seek}" data-i="${i}" style="top:${top}px">` +
        `<span class="ad">${hex(o.addr)}</span>` +
        `<span class="mn" style="color:${opColor(o.type)}">${esc(mn)}</span>` +
        `<span class="ar">${this.tokens(args, o)}</span>` +
        (cm ? `<span class="cm">; ${esc(cm)}</span>` : '') +
        `</div>`;
    }
    layer.innerHTML = html;
    this.paintArrows();
  }

  /** Make operands clickable: functions, jump targets, symbols, strings, addresses. */
  private tokens(args: string, o: Op): string {
    const m = this.model()!;
    return args.replace(/\b(0x[0-9a-fA-F]+|(?:fcn|sym|sub|str|obj|loc|reloc|section|entry|main|imp|method|class|global|rsym)[\w.]*)\b/g, (tok) => {
      let addr: number | null = null;
      let kind = 'sym';
      const fi = m.index(tok);
      if (fi >= 0) {
        addr = m.fns[fi].addr;
        kind = m.fns[fi].imp ? 'imp' : 'fn';
      } else if (o.jump !== undefined && (o.type === 'call' || (o.type ?? '').includes('jmp')) && (tok.startsWith('0x') || tok.startsWith('fcn') || tok.startsWith('loc'))) {
        addr = o.jump;
        kind = m.fnAt(o.jump) === this.fi ? 'loc' : 'fn';
      } else if (tok.startsWith('0x')) {
        addr = parseInt(tok, 16);
        kind = 'num';
      } else if (tok.startsWith('str.')) kind = 'str';
      const a = addr !== null ? ` data-a="${addr}"` : '';
      return `<span class="tk ${kind}"${a} data-n="${esc(tok)}">${esc(tok)}</span>`;
    });
  }

  private async follow(tok: HTMLElement) {
    audio.confirm();
    let addr = tok.dataset.a !== undefined ? Number(tok.dataset.a) : null;
    if (addr === null) {
      // let r2 resolve the symbol (exact flag address)
      const r = await this.sock()?.cmd(`?v ${tok.dataset.n}`);
      const v = r ? parseInt(r.text.replace(/\x1b\[[0-9;]*m/g, '').trim(), 16) : NaN;
      if (!Number.isFinite(v) || v === 0) return audio.error();
      addr = v;
    }
    const m = this.model()!;
    const fi = m.entryAt(addr);
    if (fi >= 0 && fi !== this.fi) return this.host.openFn(fi);
    this.host.goto(addr);
  }

  private paintArrows() {
    const cv = this.canvas;
    const sc = this.scroller;
    if (!cv || !sc) return;
    const dpr = devicePixelRatio;
    const H = sc.clientHeight;
    cv.width = GUTTER * dpr;
    cv.height = H * dpr;
    cv.style.height = `${H}px`;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    const y0 = sc.scrollTop;
    const ymid = (row: number) => row * ROW_H + ROW_H / 2 - y0;
    for (const a of this.arrows) {
      const ya = ymid(a.from);
      const yb = ymid(a.to);
      if (Math.max(ya, yb) < -20 || Math.min(ya, yb) > H + 20) continue;
      const x = GUTTER - 10 - a.lane * 7;
      const hot = this.hoverRow === a.from || this.hoverRow === a.to || (this.seek !== null && (this.rowOf.get(this.seek) === a.from || this.rowOf.get(this.seek) === a.to));
      const col = a.cond ? (a.to < a.from ? '#ffe14d' : '#39ff88') : '#2fd8ff';
      g.strokeStyle = col;
      g.globalAlpha = hot ? 1 : 0.45;
      g.lineWidth = hot ? 2 : 1;
      g.shadowColor = col;
      g.shadowBlur = hot ? 8 : 0;
      g.beginPath();
      g.moveTo(GUTTER - 2, ya);
      g.lineTo(x, ya);
      g.lineTo(x, yb);
      g.lineTo(GUTTER - 4, yb);
      g.stroke();
      g.beginPath();
      g.moveTo(GUTTER - 2, yb);
      g.lineTo(GUTTER - 7, yb - 3.5);
      g.lineTo(GUTTER - 7, yb + 3.5);
      g.closePath();
      g.fillStyle = col;
      g.fill();
    }
  }

  private scrollTo(addr: number, block: 'center' | 'nearest') {
    const sc = this.scroller;
    const i = this.rowOf.get(addr);
    if (!sc || i === undefined) return;
    const y = i * ROW_H;
    if (block === 'center') sc.scrollTop = y - sc.clientHeight / 2 + ROW_H / 2;
    else if (y < sc.scrollTop + ROW_H * 2 || y > sc.scrollTop + sc.clientHeight - ROW_H * 3) sc.scrollTo({ top: y - sc.clientHeight / 2, behavior: 'smooth' });
  }

  setSeek(addr: number) {
    this.seek = addr;
    if (this.tab === 'disasm' && this.scroller) {
      this.scrollTo(addr, 'nearest');
      this.paint();
    }
  }

  /** Highlight a line coming from the 3D view (hovering a CFG row). */
  hoverFromWorld(addr: number | null) {
    if (!this.layer) return;
    for (const el of this.layer.querySelectorAll('.dr.whov')) el.classList.remove('whov');
    if (addr === null) return;
    const i = this.rowOf.get(addr);
    if (i !== undefined) this.layer.querySelector(`.dr[data-i="${i}"]`)?.classList.add('whov');
  }

  /** Ops of the current function (for instruction stepping). */
  ops(): Op[] {
    return this.data?.ops ?? [];
  }

  // --------------------------------------------------------------- pseudo
  private async renderPseudo() {
    const m = this.model()!;
    const fi = this.fi;
    let text = this.pdcCache.get(fi);
    if (text === undefined) {
      this.body.innerHTML = `<div class="ins-loading">r2 pdc · decompiling ${esc(m.fns[fi].name)}…</div>`;
      text = (await this.sock()?.pdc(m.fns[fi].addr)) ?? '';
      this.pdcCache.set(fi, text);
      if (this.fi !== fi || this.tab !== 'pseudo') return;
    }
    const kw = /\b(if|else|while|for|do|return|goto|break|continue|switch|case|default)\b/g;
    const ty = /\b(void|int|char|long|short|unsigned|signed|uint\d+_t|int\d+_t|size_t|bool|const|struct)\b/g;
    const lines = text.split('\n').map((ln) => {
      let s = esc(ln);
      if (/^\s*\/\//.test(ln)) return `<span class="pc-cm">${s}</span>`;
      const ci = s.indexOf('//');
      let tail = '';
      if (ci >= 0) {
        tail = `<span class="pc-cm">${s.slice(ci)}</span>`;
        s = s.slice(0, ci);
      }
      s = s
        .replace(kw, '<span class="pc-kw">$1</span>')
        .replace(ty, '<span class="pc-ty">$1</span>')
        .replace(/\b(fcn\.[0-9a-f]+|sym\.[\w.]+|sub\.[\w.]+|main|entry0)\b/g, '<span class="tk fn" data-n="$1">$1</span>')
        .replace(/\b(0x[0-9a-f]+)\b/g, '<span class="pc-num">$1</span>');
      return s + tail;
    });
    this.body.innerHTML = '';
    const pre = h('pre', { class: 'pseudo' });
    pre.innerHTML = lines.join('\n');
    pre.onclick = (e) => {
      const tok = (e.target as HTMLElement).closest('.tk') as HTMLElement | null;
      if (!tok) return;
      const fi = m.index(tok.dataset.n ?? '');
      if (fi >= 0) this.host.openFn(fi);
    };
    const note = h('div', { class: 'ins-note' }, 'radare2 built-in pseudo-decompiler (pdc) — approximate C');
    this.body.append(note, pre);
  }

  // --------------------------------------------------------------- xrefs
  private renderXrefs() {
    const m = this.model()!;
    const fi = this.fi;
    this.body.innerHTML = '';
    const wrap = h('div', { class: 'xr' });
    const group = <K>(list: { key: K; site: number }[]) => {
      const g = new Map<K, number[]>();
      for (const x of list) (g.get(x.key) ?? g.set(x.key, []).get(x.key)!).push(x.site);
      return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
    };
    const section = (title: string, cls: string, count: string) => {
      const s = h('div', { class: `xr-sec ${cls}` }, h('div', { class: 'xr-title' }, title, h('span', {}, count)));
      wrap.append(s);
      return s;
    };
    const tailSites = new Set([...m.in[fi], ...m.out[fi]].filter((c) => c.kind === 'tail').map((c) => c.site));
    const chip = (s: number) => (tailSites.has(s) ? `jmp ${hex(s, 0)}` : hex(s, 0));
    const callers = group(m.in[fi].map((c) => ({ key: c.caller, site: c.site })));
    const sc = section('▲ CALLED BY', 'in', `${m.in[fi].length} sites · ${callers.length} fns`);
    for (const [g, sites] of callers.slice(0, 200)) {
      const row = h('div', { class: 'xr-row' });
      const n = h('span', { class: 'xr-fn' });
      n.textContent = m.fns[g].name;
      n.onclick = () => this.host.openFn(g);
      row.append(n);
      for (const s of sites.slice(0, 6)) {
        const a = h('span', { class: `xr-site ${tailSites.has(s) ? 'tail' : ''}`, title: tailSites.has(s) ? 'tail call (jump into this function)' : 'open the caller at this call site' }, chip(s));
        a.onclick = () => this.host.openFn(g, s);
        row.append(a);
      }
      if (sites.length > 6) row.append(h('span', { class: 'xr-more' }, `+${sites.length - 6}`));
      sc.append(row);
    }
    const callees = group(m.out[fi].map((c) => ({ key: c.callee, site: c.site })));
    const so = section('▼ CALLS', 'out', `${m.out[fi].length} sites · ${callees.length} fns`);
    for (const [g, sites] of callees.slice(0, 300)) {
      const row = h('div', { class: 'xr-row' });
      const n = h('span', { class: `xr-fn ${m.fns[g].imp ? 'imp' : ''}` });
      n.textContent = m.fns[g].name;
      n.onclick = () => this.host.openFn(g);
      row.append(n);
      for (const s of sites.slice(0, 6)) {
        const a = h('span', { class: `xr-site ${tailSites.has(s) ? 'tail' : ''}`, title: tailSites.has(s) ? 'tail call (jump into the callee)' : 'go to this call instruction' }, chip(s));
        a.onclick = () => this.host.goto(s);
        a.onmouseenter = () => this.host.hoverAddr(s);
        a.onmouseleave = () => this.host.hoverAddr(null);
        row.append(a);
      }
      so.append(row);
    }
    // function-pointer references: who takes this function's address, and whose address it takes
    const refIn = group(m.refIn[fi].map((r) => ({ key: r.from, site: r.site })));
    if (refIn.length) {
      const sr = section('& ADDRESS TAKEN BY', 'ref', `${m.refIn[fi].length} sites · callbacks / tables`);
      for (const [g, sites] of refIn.slice(0, 200)) {
        const row = h('div', { class: 'xr-row' });
        const n = h('span', { class: 'xr-fn' });
        n.textContent = m.fns[g].name;
        n.onclick = () => this.host.openFn(g);
        row.append(n);
        for (const s of sites.slice(0, 6)) {
          const a = h('span', { class: 'xr-site', title: 'open the referrer where it loads this address' }, hex(s, 0));
          a.onclick = () => this.host.openFn(g, s);
          row.append(a);
        }
        sr.append(row);
      }
    }
    const refOut = group(m.refOut[fi].map((r) => ({ key: r.to, site: r.site })));
    if (refOut.length) {
      const sr = section('& TAKES ADDRESS OF', 'ref', `${m.refOut[fi].length} sites`);
      for (const [g, sites] of refOut.slice(0, 200)) {
        const row = h('div', { class: 'xr-row' });
        const n = h('span', { class: `xr-fn ${m.fns[g].imp ? 'imp' : ''}` });
        n.textContent = m.fns[g].name;
        n.onclick = () => this.host.openFn(g);
        row.append(n);
        for (const s of sites.slice(0, 6)) {
          const a = h('span', { class: 'xr-site' }, hex(s, 0));
          a.onclick = () => this.host.goto(s);
          a.onmouseenter = () => this.host.hoverAddr(s);
          a.onmouseleave = () => this.host.hoverAddr(null);
          row.append(a);
        }
        sr.append(row);
      }
    }
    const strs = group(m.strOut[fi].map((r) => ({ key: r.vaddr, site: r.site })));
    const ss = section('◇ STRINGS', 'str', `${strs.length}`);
    for (const [v, sites] of strs.slice(0, 200)) {
      const row = h('div', { class: 'xr-row' });
      const t = h('span', { class: 'xr-str' });
      t.textContent = `"${m.strings.get(v)?.string ?? hex(v)}"`;
      row.append(t);
      for (const s of sites.slice(0, 4)) {
        const a = h('span', { class: 'xr-site' }, hex(s, 0));
        a.onclick = () => this.host.goto(s);
        a.onmouseenter = () => this.host.hoverAddr(s);
        a.onmouseleave = () => this.host.hoverAddr(null);
        row.append(a);
      }
      ss.append(row);
    }
    this.body.append(wrap);
  }

  // --------------------------------------------------------------- info
  private renderInfo() {
    const m = this.model()!;
    const f = m.fns[this.fi];
    const i = this.data?.info;
    const v = this.data?.vars;
    const kv = (k: string, val: string) => `<div class="kv"><span>${k}</span><b>${esc(val)}</b></div>`;
    let html = '<div class="info">';
    html += kv('address', `${hex(f.addr)}  [${hex(f.min)} – ${hex(f.max)}]`);
    html += kv('size', `${f.size} bytes · ${f.ninstrs} instructions`);
    html += kv('basic blocks', `${f.nbbs}${i ? ` · ${i.edges} edges` : ''}`);
    html += kv('cyclomatic complexity', String(f.cc));
    html += kv('stack frame', `${f.stack} bytes`);
    if (i?.calltype) html += kv('calling convention', i.calltype);
    html += kv('callers / callees', `${m.callers(this.fi).length} fns (${m.in[this.fi].length} sites) / ${m.callees(this.fi).length} fns (${m.out[this.fi].length} sites)`);
    html += kv('address taken by', `${m.referrers(this.fi).length} fns (${m.refIn[this.fi].length} sites)`);
    html += kv('tail calls in / out', `${m.in[this.fi].filter((c) => c.kind === 'tail').length} / ${m.out[this.fi].filter((c) => c.kind === 'tail').length}`);
    html += kv('strings referenced', String(new Set(m.strOut[this.fi].map((r) => r.vaddr)).size));
    if (f.sig) html += `<div class="sigbox">${esc(f.sig)}</div>`;
    const vars = [...(v?.reg ?? []).map((x) => ({ ...x, where: 'reg' })), ...(v?.stack ?? []).map((x) => ({ ...x, where: 'stack' }))];
    if (vars.length) {
      html += '<div class="vt"><div class="vh">VARIABLES</div>';
      for (const x of vars.slice(0, 80)) {
        const ref = x.ref as { base?: string; offset?: number } | string | undefined;
        const where = typeof ref === 'string' ? ref : ref ? `${ref.base ?? ''}${ref.offset !== undefined ? (ref.offset >= 0 ? '+' : '') + ref.offset : ''}` : x.where;
        html += `<div class="vr"><span class="vn">${esc(x.name)}</span><span class="vtp">${esc(x.type)}</span><span class="vw">${esc(String(where))}</span></div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    this.body.innerHTML = html;
  }
}
