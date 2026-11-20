import '@fontsource/orbitron/500.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import './ui/styles.css';

import * as THREE from 'three';
import { World } from './scene/world';
import { Hud } from './ui/hud';
import { Shell } from './ui/terminal';
import { showPicker } from './ui/picker';
import { corners, h } from './ui/dom';
import { R2Socket, r2Status } from './net/socket';
import { audio } from './audio/audio';
import { hex, type Fn, type InfoMsg } from './types';

const R2_COMMANDS = ['afl', 'aflj', 'afi', 'pdf', 'pd', 'px', 'pxw', 'pxq', 's', 'iz', 'izz', 'ii', 'iS', 'is', 'ie', 'iI', 'i', 'p=e', 'axt', 'axf', 'agf', 'VV', 'iE', 'il', 'ir', '?v', 'f', 'fs', 'afn', 'afv', 'pds', 'pdc', 'ps', 'iZ'];

const HELP = `
\x1b[38;2;255;43;214m── r3 meta commands ─────────────────────────────────────────\x1b[0m
  \x1b[33m:tour\x1b[0m            cinematic flythrough of the binary
  \x1b[33m:home\x1b[0m            overview shot of the city
  \x1b[33m:open\x1b[0m            pick another binary
  \x1b[33m:music\x1b[0m on|off|vol N   ambient score control (N 0..100)
  \x1b[33m:fx\x1b[0m low|med|high|auto  render quality
  \x1b[33mq\x1b[0m / \x1b[33m..\x1b[0m           leave the function core, back to the city
\x1b[38;2;255;43;214m── r2 commands that move the world ──────────────────────────\x1b[0m
  \x1b[36ms <addr|flag>\x1b[0m    fly to the tower / block at that address
  \x1b[36mpdf\x1b[0m, \x1b[36magf\x1b[0m, \x1b[36mVV\x1b[0m    dive into the function's control-flow core
  \x1b[36mafl\x1b[0m              radar sweep across every function tower
  \x1b[36miz\x1b[0m               ignite the string nebula
  \x1b[36mii\x1b[0m               light up the import relays
  \x1b[36miS\x1b[0m, \x1b[36mp=e\x1b[0m         focus the entropy halo / sections
\x1b[38;2;107;93;140m  everything else is plain radare2 (sandboxed: no ! or file access)\x1b[0m
`;

class App {
  ui = document.getElementById('ui')!;
  world: World;
  hud!: Hud;
  shell!: Shell;
  sock: R2Socket | null = null;
  info: InfoMsg | null = null;
  functions: Fn[] = [];
  fnByName = new Map<string, Fn>();
  seek: number | null = null;
  ready = false;
  private version = '';
  private home?: string;

  constructor() {
    this.world = new World(document.getElementById('gl') as HTMLCanvasElement);
    this.world.engine.controls.autoRotate = true;
    this.world.engine.controls.autoRotateSpeed = 0.35;
  }

  async boot() {
    const params = new URLSearchParams(location.search);
    const st = await r2Status();
    this.version = st.version ?? '';
    this.home = st.home;
    const direct = params.get('open');
    if (direct && st.ok) {
      this.mountHud();
      const go = h('button', { class: 'jack', style: 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)' }, 'JACK IN');
      this.ui.append(go);
      go.onclick = async () => {
        go.remove();
        await audio.start();
        audio.setMood('loading');
        this.openBinary(direct);
      };
      if (params.has('auto')) go.click();
      return;
    }
    const logo = h('div', { class: 'logo glitch', 'data-text': 'r3' }, 'r3');
    const ver = h('div', { class: 'ver' }, st.ok ? `◉ ${st.version}` : '');
    const btn = h('button', { class: 'jack' }, 'JACK IN');
    const boot = h(
      'div',
      { class: 'boot' },
      logo,
      h('div', { class: 'tag' }, 'radare2 · three-dimensional'),
      ver,
      btn,
      h('div', { class: 'hint' }, 'audio on · headphones recommended'),
    );
    if (!st.ok) {
      ver.innerHTML = `<span class="err">✖ ${st.error ?? 'radare2 not available'} — install r2 and run ./install-deps.sh</span>`;
      (btn as HTMLButtonElement).disabled = true;
    }
    this.ui.append(boot);
    btn.onclick = async () => {
      await audio.start();
      audio.boot();
      audio.setMood('idle');
      this.world.engine.glitch(0.9, 1.2);
      this.world.engine.flash(0.4, 1.4);
      boot.classList.add('out');
      setTimeout(() => boot.remove(), 1300);
      this.world.engine.controls.autoRotate = false;
      await this.world.flyTo(new THREE.Vector3(-260, 120, 300), new THREE.Vector3(0, 40, 0), 2.6, 'power2.inOut');
      this.world.engine.controls.autoRotate = true;
      this.world.engine.controls.autoRotateSpeed = 0.2;
      this.pick();
    };
  }

  private mountHud() {
    if (this.hud) return;
    this.hud = new Hud(this.ui);
    this.shell = new Shell(this.ui);
    this.shell.onSubmit = (c) => this.dispatch(c);
    this.shell.complete = (w) => this.complete(w);
    this.world.ev = {
      hoverTower: (t, p) => this.hud.tower(t, p),
      hoverSat: (n, p) => this.hud.sat(n, p),
      clickTower: (t) => this.gotoAddr(t.fn.addr),
      dblTower: (t) => this.enterFunction(t.fn.addr),
      clickOp: (a) => this.gotoAddr(a),
      caption: (a, b) => this.hud.caption(a, b),
    };
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  async pick() {
    this.mountHud();
    this.hud.setView('SELECT TARGET');
    const path = await showPicker(this.ui, { version: this.version, home: this.home });
    this.openBinary(path);
  }

  async openBinary(path: string) {
    this.mountHud();
    if (this.world.view === 'function') await this.world.exitFunction();
    this.sock?.close();
    this.ready = false;
    const sock = (this.sock = new R2Socket());
    this.hud.setView('JACKING IN');
    this.hud.logLine(`target :: ${path}`);
    audio.setMood('loading');
    this.world.engine.controls.autoRotate = true;
    this.world.engine.controls.autoRotateSpeed = 0.6;
    let lastMsg = '';
    sock.on.status = (msg, p) => {
      if (msg !== lastMsg) {
        if (lastMsg) this.hud.logLine(lastMsg, true);
        lastMsg = msg;
        audio.blip(400 + p * 900, 0.04, 'triangle', 0.03);
      }
      this.hud.progress(msg, p);
      if (p >= 1) {
        this.hud.logLine('neural link established', true);
        this.hud.clearLog(2500);
      }
    };
    sock.on.info = (m) => {
      this.info = m;
      this.hud.setInfo(m);
      this.world.loadInfo(m);
      document.title = `r3 // ${m.path.split('/').pop()}`;
    };
    sock.on.functions = (m) => {
      this.functions = m.functions;
      this.fnByName = new Map(m.functions.map((f) => [f.name, f]));
      this.world.engine.controls.autoRotate = false;
      this.world.loadFunctions(m);
      audio.setMood('city');
      this.hud.setStats({ functions: m.functions.filter((f) => !f.imp).length, xrefs: m.calls.length });
      this.hud.setView('CITY // ADDRESS SPACE');
      this.hud.caption('// ONLINE', `${m.functions.length} functions materialised`);
      this.ready = true;
      if (m.seek !== null) this.setSeek(m.seek, false);
      setTimeout(() => {
        if (!this.shell.isOpen) this.shell.toggle(true);
      }, 4200);
    };
    sock.on.error = (msg) => {
      audio.error();
      this.world.engine.glitch(1, 0.6);
      this.hud.logLine(`✖ ${msg}`);
      if (this.shell.isOpen) this.shell.println(`\x1b[31m✖ ${msg}\x1b[0m`);
      if (!this.info) {
        const t = corners(h('div', { class: 'panel toast' }, `✖ ${msg}`));
        this.ui.append(t);
        setTimeout(() => {
          t.remove();
          this.pick();
        }, 2600);
      }
    };
    sock.on.close = () => {
      if (this.sock === sock) this.hud.logLine('✖ link lost');
    };
    try {
      await sock.open(path);
    } catch (e) {
      sock.on.error?.((e as Error).message);
    }
  }

  // ------------------------------------------------------------------ nav
  private fnAt(addr: number): Fn | null {
    const t = this.world.city?.towerAt(addr);
    if (t) return t.fn;
    return this.functions.find((f) => addr >= f.addr && addr < f.addr + Math.max(1, f.size)) ?? null;
  }

  private setSeek(addr: number, fly = true) {
    const changed = addr !== this.seek;
    this.seek = addr;
    const fn = this.fnAt(addr);
    this.hud.setSeek(addr, fn?.name);
    this.shell.setSeek(addr);
    const p = this.world.halo?.vaddrToPaddr(addr);
    if (p !== null && p !== undefined && this.info?.entropy?.size) this.hud.setSeekFrac((p - this.info.entropy.address) / this.info.entropy.size);
    if (!changed && fly) return;
    if (this.world.view === 'function' && this.world.func) {
      const inside = this.world.func.panelAt(addr);
      if (inside) this.world.seek(addr, fly);
      else if (fn && !fn.imp) this.enterFunction(fn.addr, addr);
      else this.world.exitFunction().then(() => this.world.seek(addr, fly));
      return;
    }
    this.world.seek(addr, fly);
  }

  async gotoAddr(addr: number) {
    if (!this.sock || !this.ready) return;
    audio.confirm();
    const r = await this.sock.cmd(`s ${addr}`);
    if (this.shell.isOpen) this.shell.println(`\x1b[38;2;107;93;140m# s ${hex(addr)}\x1b[0m`);
    this.setSeek(r.seek ?? addr);
  }

  async enterFunction(addr: number, seekTo?: number) {
    if (!this.sock || !this.ready) return;
    const g = await this.sock.fn(addr);
    if (!g || !g.blocks?.length) {
      audio.error();
      this.hud.caption('// NO GRAPH', `nothing to render at ${hex(addr)}`);
      return;
    }
    this.hud.setView('CORE // CONTROL FLOW');
    this.hud.caption(`// ${g.name}`, `${g.blocks.length} blocks · ${g.ninstr} instructions`);
    await this.world.enterFunction(g);
    const r = await this.sock.cmd(`s ${seekTo ?? addr}`);
    this.seek = null;
    this.setSeek(r.seek ?? addr, seekTo !== undefined && seekTo !== addr);
  }

  async exitFunction() {
    await this.world.exitFunction();
    this.hud.setView('CITY // ADDRESS SPACE');
    if (this.seek !== null) this.world.seek(this.seek, true);
  }

  // ------------------------------------------------------------------ shell
  private complete(word: string): string[] {
    const set = new Set<string>();
    for (const c of R2_COMMANDS) if (c.startsWith(word)) set.add(c);
    if (word.startsWith(':')) for (const c of [':tour', ':home', ':open', ':music', ':fx', ':help']) if (c.startsWith(word)) set.add(c);
    for (const f of this.functions) if (f.name.startsWith(word)) set.add(f.name);
    for (const s of this.info?.symbols ?? []) {
      const n = `sym.${s.name}`;
      if (n.startsWith(word)) set.add(n);
    }
    return [...set].sort().slice(0, 400);
  }

  private async resolve(expr: string): Promise<number | null> {
    if (!this.sock) return null;
    const r = await this.sock.cmd(`?v ${expr}`);
    // strip ansi
    const v = parseInt(r.text.replace(/\x1b\[[0-9;]*m/g, '').trim(), 16);
    return Number.isFinite(v) ? v : null;
  }

  async dispatch(raw: string) {
    const cmd = raw.trim();
    const w = this.world;
    if (cmd.startsWith(':')) return this.meta(cmd);
    if (cmd === 'q' || cmd === '..' || cmd === 'exit' || cmd === 'q!') {
      if (w.view === 'function') return this.exitFunction();
      this.shell.write('\x1b[38;2;107;93;140m(already in the city — :open to pick another binary)\x1b[0m\n');
      return;
    }
    if (!this.sock || !this.ready) {
      this.shell.write('\x1b[33manalysis in progress… hold on\x1b[0m\n');
      return;
    }
    const isGraph = /^(pdf|pdr|agf|VV?)(\s|$|@|~)/.test(cmd);
    const r = await this.sock.cmd(cmd, this.shell.cols);
    if (r.text) this.shell.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
    if (r.err) audio.error();
    const head = cmd.split(/[\s@~;]/)[0];
    if (isGraph) {
      const at = cmd.match(/@\s*(\S+)/);
      const addr = at ? await this.resolve(at[1]) : (r.seek ?? this.seek);
      const fn = addr !== null ? this.fnAt(addr) : null;
      if (fn) {
        if (w.view === 'function' && w.func?.graph.addr === fn.addr) {
          const o = w.func.overview();
          w.flyTo(o.pos, o.target, 1.6);
        } else this.enterFunction(fn.addr, addr ?? undefined);
        return;
      }
    }
    if (r.seek !== null && r.seek !== this.seek) this.setSeek(r.seek, true);
    if (w.view !== 'city') return;
    switch (head) {
      case 'afl':
        w.sweep();
        break;
      case 'iz':
      case 'izz':
        w.pulseStrings();
        break;
      case 'ii':
        w.pulseImports();
        break;
      case 'iS':
      case 'p=e':
        w.focusEntropy();
        break;
    }
  }

  private async meta(cmd: string) {
    const [c, ...args] = cmd.slice(1).split(/\s+/);
    const sh = this.shell;
    switch (c) {
      case 'help':
      case 'h':
        sh.write(HELP);
        break;
      case 'tour':
        if (this.world.view === 'function') await this.exitFunction();
        sh.toggle(false);
        this.world.tour();
        break;
      case 'home':
        if (this.world.view === 'function') await this.exitFunction();
        this.world.select(null);
        this.world.overview();
        break;
      case 'open':
        sh.toggle(false);
        this.pick();
        break;
      case 'music':
        if (args[0] === 'off') audio.setMuted(true);
        else if (args[0] === 'on') audio.setMuted(false);
        else if (args[0] === 'vol') audio.setVolume(Number(args[1] ?? 80) / 100);
        sh.write(`music ${audio.muted ? 'off' : 'on'} · vol ${Math.round(audio.volume * 100)}\n`);
        break;
      case 'fx': {
        const e = this.world.engine;
        const m: Record<string, number> = { low: 0, med: 1, high: 2 };
        if (args[0] === 'auto') e.autoQuality = true;
        else if (args[0] in m) {
          e.autoQuality = false;
          e.setQuality(m[args[0]]);
        }
        sh.write(`quality ${['low', 'med', 'high'][e.quality]}${e.autoQuality ? ' (auto)' : ''}\n`);
        break;
      }
      default:
        sh.write(`\x1b[31munknown meta command :${c}\x1b[0m — try :help\n`);
        audio.error();
    }
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
    if (typing && !this.shell.el.contains(t)) return;
    if ((e.key === '`' || e.key === '~' || e.key === 'º') && !this.shell.isOpen && this.ready) {
      e.preventDefault();
      this.shell.toggle(true);
      return;
    }
    if (this.shell.isOpen && this.shell.el.contains(t)) {
      if (e.key === 'Escape') this.shell.toggle(false);
      return;
    }
    if (!this.ready) return;
    if (e.key === 'Escape') {
      if (this.world.view === 'function') this.exitFunction();
      else this.world.select(null);
    } else if (e.key === 't' || e.key === 'T') {
      this.world.tour();
    } else if (e.key === 'h' || e.key === 'H') {
      this.world.overview();
    } else if (e.key === 'Enter' && this.world.selected && this.world.view === 'city') {
      this.enterFunction(this.world.selected.fn.addr);
    }
  }
}

const app = new App();
document.fonts.ready.then(() => app.boot());
