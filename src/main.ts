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
import { World, type Pick, type RoomMotion } from './scene/world';
import type { Tower } from './scene/city';
import { BlockRoom, InteriorPlan, type RoomArrival, type RoomExit } from './scene/interior';
import { functionStrings } from './scene/entryvista';
import { Hud } from './ui/hud';
import { Shell } from './ui/terminal';
import { showPicker } from './ui/picker';
import { Inspector } from './ui/inspector';
import { Palette, type PaletteItem } from './ui/palette';
import { Minimap } from './ui/minimap';
import { RoomMapSidebar } from './ui/roommap';
import { corners, esc, h } from './ui/dom';
import { R2Socket, r2Status } from './net/socket';
import type { R2Client } from './net/client';
import { nativeConfig, nativeRequest, createNativeClient } from './net/native';
import { audio } from './audio/audio';
import { Model } from './model';
import { NavHistory, type NavEntry } from './nav';
import { XRMode } from './xr/xr';
import { hex, type InfoMsg } from './types';

const R2_COMMANDS = ['afl', 'aflj', 'afi', 'pdf', 'pd', 'px', 'pxw', 'pxq', 's', 'iz', 'izz', 'ii', 'iS', 'is', 'ie', 'iI', 'i', 'p=e', 'axt', 'axf', 'agf', 'agc', 'VV', 'iE', 'il', 'ir', '?v', 'f', 'fs', 'afn', 'afv', 'pds', 'pdc', 'ps', 'iZ'];

const HELP = `
\x1b[38;2;255;43;214m── r3 meta commands ─────────────────────────────────────────\x1b[0m
  \x1b[33m:tour\x1b[0m            cinematic flythrough of the binary
  \x1b[33m:home\x1b[0m            overview shot of the current view
  \x1b[33m:open\x1b[0m            pick another binary
  \x1b[33m:drone\x1b[0m           toggle drone flight (same as F)
  \x1b[33m:music\x1b[0m on|off|vol N   ambient score control (N 0..100)
  \x1b[33m:fx\x1b[0m low|med|high|auto  render quality
  \x1b[33mq\x1b[0m / \x1b[33m..\x1b[0m           leave the core / constellation, back to the city
\x1b[38;2;255;43;214m── r2 commands that move the world ──────────────────────────\x1b[0m
  \x1b[36ms <addr|flag>\x1b[0m    fly there (tower floor in the city, block in the core)
  \x1b[36mpdf\x1b[0m, \x1b[36magf\x1b[0m, \x1b[36mVV\x1b[0m    dive into the function's control-flow core
  \x1b[36magc\x1b[0m              call-graph constellation of the function
  \x1b[36maxt\x1b[0m, \x1b[36maxf\x1b[0m         focus callers/callees + Inspector xrefs
  \x1b[36mafl\x1b[0m              radar sweep across every function tower
  \x1b[36miz\x1b[0m / \x1b[36mii\x1b[0m / \x1b[36miS\x1b[0m     strings / import relays / entropy halo
\x1b[38;2;107;93;140m  everything else is plain radare2 (sandboxed: no ! or file access)\x1b[0m
`;

const KEYS_HELP: [string, string][] = [
  ['Ctrl K  /', 'search anything (functions, strings, imports, sections, 0xaddr, commands)'],
  ['click tower', 'select → focus its call graph in the city + open Inspector'],
  ['1 2 3', 'focus depth (hops of callers/callees)'],
  ['C', 'call-graph constellation of the selection (click nodes to re-centre)'],
  ['Enter / dbl-click', 'dive into the control-flow core'],
  ['↓ →  ↑ ←', 'core: follow fall-through / taken branch · predecessor / step back'],
  ['J K', 'core: next / previous instruction'],
  ['F', 'toggle drone flight (WASD, Q/E, Shift boost, wheel speed, RMB or lock to look)'],
  ['G', 'walk the city from the selected tower · WASD · Shift sprint · Space jump'],
  ['E / ← →', 'walk through, or choose an exit and press E to travel'],
  ['Tab / Space', 'cycle glowing calls / teleport to the selected or aimed call, or jump'],
  ['M / Backspace / X', 'building map / previous room / exit to street'],
  ['I', 'toggle the Inspector (disasm · pseudo-C · xrefs · info)'],
  ['Alt ← / Alt →', 'back / forward through your navigation history'],
  ['Esc', 'back out (core/constellation → city, clear focus)'],
  ['H  T  ~', 'overview · cinematic tour · r2 shell'],
];

class App {
  ui = document.getElementById('ui')!;
  world: World;
  hud!: Hud;
  shell!: Shell;
  inspector!: Inspector;
  palette!: Palette;
  minimap!: Minimap;
  roomMapSidebar!: RoomMapSidebar;
  nav = new NavHistory();
  sock: R2Client | null = null;
  info: InfoMsg | null = null;
  model: Model | null = null;
  sel: number | null = null;
  depth = 1;
  seek: number | null = null;
  ready = false;
  private walk: number[] = [];
  private predCycle = 0;
  private syncTimer = 0;
  private helpEl: HTMLElement | null = null;
  private version = '';
  private home?: string;
  private plans = new Map<number, InteriorPlan>();
  private pendingRoomPlans = new Map<number, Promise<InteriorPlan | null>>();
  private roomSummaries = new Map<number, Promise<string>>();
  private entranceStrings = new Map<number, Promise<string[]>>();
  private roomTrail: ({ fi: number; addr: number } & RoomArrival)[] = [];

  constructor() {
    this.world = new World(document.getElementById('gl') as HTMLCanvasElement);
    this.world.engine.controls.autoRotate = true;
    this.world.engine.controls.autoRotateSpeed = 0.35;
    // headset controllers reuse the desktop shortcuts, so XR goes through the same navigation lane
    new XRMode(this.world, {
      key: (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      status: () => ({ sel: this.sel, seek: this.seek, depth: this.depth, ready: this.ready }),
    });
  }

  // =================================================================== boot
  async boot() {
    const params = new URLSearchParams(location.search);
    const native = nativeConfig();
    if (native) {
      const start = h('button', { class: 'jack' }, native.path || native.endpoint ? 'JACK IN' : native.mode === 'http' ? 'CONNECT TO R2 SERVER' : 'OPEN BINARY');
      const remote = h('button', { class: 'btn' }, 'CONNECT TO R2 SERVER');
      const boot = h('div', { class: 'boot' }, h('div', { class: 'logo glitch', 'data-text': 'r3' }, 'r3'),
        h('div', { class: 'tag' }, 'radare2 · three-dimensional'),
        h('div', { class: 'ver' }, native.mode === 'http' ? '◉ remote HTTP' : native.mode === 'pipe' ? '◉ local r2pipe' : '◉ embedded radare2.wasm'), start, remote,
        h('div', { class: 'hint' }, 'drop a binary · ⌘O open · ⌘T new tab · ⌘L connect'));
      if (!native.path && !native.endpoint) {
        const backend = h('select', { class: 'btn', 'aria-label': 'Analysis backend' });
        for (const [value, label] of [['wasm', 'WebAssembly (bundled)'], ['pipe', 'r2pipe (spawn local r2)'], ['http', 'Remote HTTP server']]) {
          const option = h('option', { value }, label); option.selected = native.mode === value; backend.append(option);
        }
        backend.onchange = () => { void nativeRequest('backend', { mode: backend.value }); };
        boot.insertBefore(backend, start);
      }
      this.ui.append(boot);
      remote.onclick = () => { void nativeRequest('connect'); };
      start.onclick = async () => {
        if (!native.path && !native.endpoint) { await nativeRequest(native.mode === 'http' ? 'connect' : 'pick'); return; }
        boot.remove();
        await audio.start();
        this.openBinary(native.path ?? native.endpoint!);
      };
      return;
    }
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
    const boot = h('div', { class: 'boot' }, logo, h('div', { class: 'tag' }, 'radare2 · three-dimensional'), ver, btn, h('div', { class: 'hint' }, 'audio on · headphones recommended'));
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
    this.inspector = new Inspector(
      this.ui,
      () => this.sock,
      () => this.model,
      {
        goto: (a) => this.goto(a),
        openFn: (fi, site) => this.openFn(fi, site),
        core: (fi, site) => this.openCore(fi, site),
        constellation: (fi) => this.openGraph(fi),
        focus: (fi) => this.focusFn(fi),
        hoverAddr: (a) => this.hoverAddr(a),
      },
    );
    this.inspector.onToggle = () => this.updateCameraCenter();
    this.palette = new Palette(this.ui);
    this.palette.source = (q) => this.paletteItems(q);
    this.minimap = new Minimap(this.ui, this.world);
    this.roomMapSidebar = new RoomMapSidebar(this.ui, () => {
      if (!this.busy || this.world.inCorridor) void this.toggleRoomMap();
    });
    this.minimap.onTravel = (x, z) => this.travel(x, z);
    this.world.ev = {
      hover: (p, s) => this.onHover(p, s),
      click: (p) => this.onClick(p),
      dbl: (p) => this.onDbl(p),
      caption: (a, b) => this.hud.caption(a, b),
      enterTower: (tower) => this.enterTower(tower),
      previewTower: (tower) => this.previewTower(tower),
      previewStrings: (tower) => this.previewStrings(tower),
      roomExit: (exit) => this.takeRoomExit(exit),
      walkHint: (tower, exit) => {
        if (!this.busy || this.world.inCorridor) this.walkHint(tower, exit);
      },
    };
    this.world.rig.onMode = (m) => {
      this.hud.setMode(m);
      this.updateCameraCenter();
      audio.blip(m === 'drone' ? 300 : 600, 0.12, 'sawtooth', 0.05);
    };
    this.nav.onChange = () => this.renderCrumbs();
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) this.back();
      if (e.button === 4) this.forward();
    });
  }

  async pick() {
    if (nativeConfig()) { await nativeRequest('pick'); return; }
    this.mountHud();
    this.hud.setView('SELECT TARGET');
    const path = await showPicker(this.ui, { version: this.version, home: this.home });
    this.openBinary(path);
  }

  async openBinary(path: string) {
    this.mountHud();
    this.ready = false;
    this.roomTrail = [];
    this.plans.clear();
    this.pendingRoomPlans.clear();
    this.roomSummaries.clear();
    this.entranceStrings.clear();
    this.world.clearRoom();
    this.world.stopWalking();
    this.hud.setWalkHint('');
    this.roomMapSidebar.show(null);
    if (this.world.view !== 'city') await this.world.backToCity();
    this.sock?.close();
    this.info = null;
    this.seek = null;
    this.walk = [];
    this.nav = new NavHistory();
    this.nav.onChange = () => this.renderCrumbs();
    this.model = null;
    this.sel = null;
    this.inspector.toggle(false, false);
    let sock: R2Client;
    try {
      this.hud.setView('LOADING ENGINE');
      sock = nativeConfig() ? await createNativeClient(nativeConfig()!) : new R2Socket();
      this.sock = sock;
    } catch (e) {
      this.hud.logLine(`✖ ${(e as Error).message}`);
      this.hud.caption('ENGINE FAILED', (e as Error).message);
      return;
    }
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
      if (!this.info) return;
      this.model = new Model(this.info, m);
      this.world.engine.controls.autoRotate = false;
      this.world.loadModel(this.model);
      this.minimap.rebuild();
      audio.setMood('city');
      this.hud.setStats({ functions: m.functions.filter((f) => !f.imp).length, 'call sites': m.calls.length, 'string refs': m.strRefs.length });
      this.hud.setView('CITY // ADDRESS SPACE');
      this.hud.caption('// ONLINE', `${m.functions.length} functions · ${m.calls.length} call sites · G to walk the city`);
      this.ready = true;
      if (m.seek !== null) this.setSeekUi(m.seek);
      this.nav.push({ view: 'city', fi: null, addr: null });
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
      await sock.open(path, nativeConfig()?.analysis);
    } catch (e) {
      sock.on.error?.((e as Error).message);
    }
  }

  // =================================================================== navigation core
  /** Keep r2's own seek in sync with what the user is looking at (debounced, silent). */
  private syncR2(addr: number) {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.sock?.cmd(`s ${addr}`), 120);
  }

  private setSeekUi(addr: number) {
    this.seek = addr;
    const m = this.model;
    const fi = m ? m.fnAt(addr) : -1;
    this.hud.setSeek(addr, fi >= 0 ? m!.fns[fi].name : undefined);
    this.shell.setSeek(addr);
    this.world.halo?.setSeek(addr);
    if (this.world.halo) audio.setBrightness(this.world.halo.entropyAt(addr));
    const p = this.world.halo?.vaddrToPaddr(addr);
    if (p !== null && p !== undefined && this.info?.entropy?.size) this.hud.setSeekFrac((p - this.info.entropy.address) / this.info.entropy.size);
    if (this.inspector.fi === fi) this.inspector.setSeek(addr);
  }

  /** Select a function in the city: focus its call graph, open it in the Inspector. */
  select(fi: number, o: { fly?: boolean; addr?: number; push?: boolean; inspect?: boolean } = {}) {
    const m = this.model;
    if (!m) return;
    this.sel = fi;
    const addr = o.addr ?? m.fns[fi].addr;
    if (this.world.view === 'city') {
      this.world.setFocus(fi, this.depth);
      this.hud.setDepth(this.depth);
      const t = this.world.city?.towerOfFn(fi);
      if (o.fly !== false) {
        if (this.world.rig.mode === 'walk') {
          if (t) this.world.startStreet(t);
        } else if (t) this.world.focusTower(t, 1.8, o.addr);
        else {
          const sp = this.world.sats?.posOfFn(fi);
          if (sp) this.world.flyTo(sp.clone().add(new THREE.Vector3(30, 25, 30)), sp, 1.8);
        }
      }
      this.world.focus?.highlightSite(o.addr ?? null);
    }
    this.setSeekUi(addr);
    this.syncR2(addr);
    this.inspector.show(fi, addr, o.inspect ?? this.world.rig.mode !== 'walk');
    if (o.push !== false) this.nav.push({ view: this.world.view, fi, addr: o.addr ?? null });
  }

  // ---------------------------------------------------------------- view changes
  // Every view change runs in one exclusive lane: input arriving while a warp or a
  // graph fetch is in flight is rejected (with a soft blip) instead of half-applying
  // and leaving the HUD, history and world out of sync.
  private navTask: Promise<void> | null = null;

  /** current view, re-read after awaits (TS would otherwise keep a stale narrowing) */
  private viewNow(): string {
    return this.world.view;
  }

  private get busy() {
    return this.navTask !== null || this.world.transitioning;
  }

  private async exclusive(fn: () => Promise<void>) {
    if (this.busy) {
      audio.blip(180, 0.04, 'square', 0.02);
      return false;
    }
    const task = Promise.resolve().then(fn);
    this.navTask = task;
    try {
      await task;
    } finally {
      this.navTask = null;
    }
    return true;
  }

  private updateCameraCenter() {
    const w = this.world;
    w.engine.setCenterShift(w.rig.mode !== 'walk' && !w.roomMap && this.inspector.isOpen && window.innerWidth > 900 ? 250 : 0);
  }

  private walkHint(tower: Tower | null, aimed?: RoomExit) {
    const w = this.world;
    document.body.classList.toggle('room-map-open', w.roomMap);
    this.roomMapSidebar.show(w.view === 'interior' ? w.room : null);
    if (w.roomMap && w.room) {
      const selected = w.func?.selectedBlock;
      const location = w.inCorridor
        ? `In corridor · ${hex(w.room.block.addr)} → ${w.corridorDestination === undefined ? 'Street' : hex(w.corridorDestination)}`
        : `You are here · Floor ${w.room.floor} · ${hex(w.room.block.addr)}`;
      this.hud.setWalkHint(location,
        selected && selected !== w.room.block ? `M / Enter visit ${hex(selected.addr)} · Esc cancel`
          : 'Click a block to visit · M / Esc returns');
      return;
    }
    if (w.inCorridor) {
      const direction = w.corridorDirection;
      this.hud.setWalkHint(direction > 0 ? '↑ TOWARD DESTINATION' : direction < 0 ? '↓ BACK TOWARD SOURCE' : 'BRANCH CORRIDOR',
        'Cyan arrows point to destination · W / S move · M map');
      return;
    }
    if (w.view === 'interior' && w.room) {
      const room = w.room;
      const route = room.selectedExit ?? aimed;
      const call = room.selectedCall ?? w.aimedRoomCall();
      const controls = [
        '← → choose exit · E travel', 'M map', 'Backspace back', 'X street',
        room.zeroGravity ? 'Space / Q rise / descend' : '',
        room.calls.length ? 'Aim at a call or cycle with Tab · Space teleport' : '',
        room.pageCount > 1 ? `[ ] summaries ${room.summaryPage}/${room.pageCount}` : '',
      ].filter(Boolean).join(' · ');
      const title = call
        ? `Call ${room.calls.indexOf(call) + 1}/${room.calls.length} · ${call.text}${call.callee === undefined ? ' · destination unavailable' : ' · Space teleport'}`
        : route ? `${route.label} · ${route.endpoint}`
          : `Floor ${room.floor} · ${room.block === room.plan.entry ? 'Entry point' : 'Basic block'} · ${hex(room.block.addr)}`;
      this.hud.setWalkHint(title, controls);
      return;
    }
    this.hud.setWalkHint(w.rig.mode === 'walk' ? (tower ? `Enter ${tower.fn.name}` : 'Follow the lit entrances at street level') : '',
      'Look up for function strings · walk through or press E nearby · G orbit');
  }

  private toggleWalking() {
    const w = this.world;
    if (this.busy || w.view !== 'city') return;
    if (w.rig.mode === 'walk') {
      w.stopWalking(true);
      this.walkHint(null);
      return;
    }
    const entries = this.info?.entries ?? [];
    const fi = this.sel ?? (entries.length ? this.model?.fnAt(entries[0].vaddr) : undefined);
    const tower = (fi === undefined ? null : w.city?.towerOfFn(fi)) ?? w.city?.towers[0];
    if (!tower) return;
    this.inspector.toggle(false, false);
    w.startStreet(tower, true);
    this.walkHint(w.nearEntrance());
  }

  private enterTower(tower: Tower, quick = false) {
    if (!this.ready || this.world.view !== 'city' || this.world.rig.mode !== 'walk') return;
    void this.exclusive(() => this.openRoom(tower.fnIndex, undefined, quick ? 'quick' : 'door'));
  }

  private readRoomSummary(sock: R2Client, addr: number): Promise<string> {
    const cached = this.roomSummaries.get(addr);
    if (cached) return cached;
    const pending = sock.blockSummary(addr).catch(() => {
      if (this.roomSummaries.get(addr) === pending) this.roomSummaries.delete(addr);
      return '';
    });
    this.roomSummaries.set(addr, pending);
    if (this.roomSummaries.size > 128) this.roomSummaries.delete(this.roomSummaries.keys().next().value!);
    return pending;
  }

  private getRoomPlan(sock: R2Client, fi: number, addr: number): Promise<InteriorPlan | null> {
    const cached = this.plans.get(fi);
    if (cached) return Promise.resolve(cached);
    const running = this.pendingRoomPlans.get(fi);
    if (running) return running;
    const pending = sock.fn(addr).then((graph) => {
      if (!graph?.blocks?.length || this.sock !== sock || !this.ready) return null;
      const tower = this.world.city?.towerOfFn(fi);
      const street = tower && this.world.city?.streetPosition(tower);
      const plan = new InteriorPlan(fi, graph, tower && street ? { x: street.x, z: street.z, width: tower.width } : undefined);
      this.plans.set(fi, plan);
      return plan;
    }).finally(() => {
      if (this.pendingRoomPlans.get(fi) === pending) this.pendingRoomPlans.delete(fi);
    });
    this.pendingRoomPlans.set(fi, pending);
    return pending;
  }

  private async previewTower(tower: Tower) {
    const sock = this.sock;
    const model = this.model;
    if (!sock || !model || !this.ready) return;
    const plan = await this.getRoomPlan(sock, tower.fnIndex, tower.fn.addr).catch(() => null);
    if (!plan || this.sock !== sock || !this.world.showEntranceVista(tower, plan, model, (addr) => this.readRoomSummary(sock, addr))) return;
    const summary = await this.readRoomSummary(sock, plan.entry.addr);
    if (this.sock === sock) this.world.updateEntranceSummary(tower, summary);
  }

  private async previewStrings(tower: Tower) {
    const sock = this.sock;
    const model = this.model;
    if (!sock || !model || !this.ready) return;
    let strings = this.entranceStrings.get(tower.fnIndex);
    if (!strings) {
      strings = sock.functionSummary(tower.fn.addr).catch(() => '').then((summary) => functionStrings(summary, model, tower.fnIndex));
      this.entranceStrings.set(tower.fnIndex, strings);
      if (this.entranceStrings.size > 48) this.entranceStrings.delete(this.entranceStrings.keys().next().value!);
    }
    const values = await strings;
    if (this.sock === sock) this.world.updateEntranceStrings(tower, values);
  }

  private async openRoom(fi: number, addr: number | undefined, motion: RoomMotion, exit?: RoomExit, history: 'push' | 'back' | 'restore' = 'push', arrival?: RoomArrival) {
    const m = this.model;
    const sock = this.sock;
    const w = this.world;
    if (!m || !sock || m.fns[fi]?.imp || !m.fns[fi]) return;
    const from = w.room;
    const trail = from ? [...this.roomTrail] : [];
    if (history === 'push' && from) trail.push({
      fi: from.plan.fi, addr: from.block.addr, pose: w.cameraFrame(),
      doorway: exit ? { x: exit.x, y: exit.y, z: exit.z, nx: exit.nx, nz: exit.nz, radius: exit.radius } : undefined,
      slide: exit?.slide,
    });
    if (history === 'back') trail.pop();
    w.rig.walkBlocked = true;
    try {
      if (!this.plans.has(fi)) this.hud.setWalkHint(`Opening ${m.fns[fi].name}…`);
      const plan = await this.getRoomPlan(sock, fi, m.fns[fi].addr);
      if (this.sock !== sock || !this.ready) return;
      if (!plan) {
        this.hud.caption('// NO BASIC BLOCKS', m.fns[fi].name);
        return;
      }
      const block = (addr === undefined ? undefined : plan.blockAt(addr)) ?? plan.entry;
      const walking = motion === 'door' || motion === 'lift' || motion === 'slide';
      const summaryPending = this.readRoomSummary(sock, block.addr);
      const summary = walking ? '' : await summaryPending;
      if (this.sock !== sock || !this.ready || w.room !== from) return;
      const back = trail.at(-1);
      const backPlan = back ? this.plans.get(back.fi) : undefined;
      const backBlock = back && backPlan?.blockAt(back.addr);
      const entrance = walking && !from && block === plan.entry ? w.entranceRoom(plan) : null;
      const room = entrance ?? new BlockRoom(plan, block, m, summary, backPlan && backBlock ? {
        plan: backPlan, block: backBlock, doorway: back?.doorway, slide: back?.slide,
      } : null,
        (addr) => this.readRoomSummary(sock, addr));
      await w.enterRoom(room, motion, exit, arrival);
      if (w.room !== room || this.sock !== sock) return;
      if (walking) void summaryPending.then((text) => {
        if (w.room === room && this.sock === sock) room.setSummary(text);
      });
      this.roomTrail = trail;
      this.sel = fi;
      this.hud.setView(`BUILDING // FLOOR ${room.floor}`);
      this.hud.setDepth(null);
      this.updateCameraCenter();
      this.inspector.show(fi, block.addr, false);
      this.setSeekUi(block.addr);
      this.syncR2(block.addr);
      if (history !== 'restore') this.nav.push({ view: 'interior', fi, addr: block.addr });
    } catch (e) {
      audio.error();
      this.hud.caption('// ROOM UNAVAILABLE', (e as Error).message);
    } finally {
      w.rig.walkBlocked = false;
      this.walkHint(w.view === 'city' ? w.nearEntrance() : null);
    }
  }

  private takeRoomExit(exit: RoomExit, quick = false) {
    const room = this.world.room;
    if (!room || this.world.view !== 'interior') return;
    if (!exit.edge) return this.backRoom(quick ? undefined : exit);
    const motion = quick ? 'quick' : exit.slide ? 'slide' : exit.elevator ? 'lift' : 'door';
    void this.exclusive(() => this.openRoom(room.plan.fi, exit.edge!.to, motion, exit));
  }

  private backRoom(exit?: RoomExit) {
    const w = this.world;
    if (this.busy) return;
    if (w.roomMap) return this.toggleRoomMap();
    const back = this.roomTrail.at(-1);
    if (!back) return this.leaveBuilding(exit);
    const backDoor = exit ?? w.room?.exits.find((door) => !door.edge);
    const lift = exit && backDoor?.elevator;
    const motion = lift ? 'lift' : exit ? 'door' : back.fi === w.room?.plan.fi ? 'quick' : 'warp';
    void this.exclusive(() => this.openRoom(back.fi, back.addr, motion, lift ? backDoor : exit, 'back', back));
  }

  private leaveBuilding(exit?: RoomExit) {
    const w = this.world;
    const tower = w.room && w.city?.towerOfFn(w.room.plan.fi);
    if (!tower || this.busy) return;
    void this.exclusive(async () => {
      if (!await w.exitToStreet(tower, exit)) return;
      this.roomTrail = [];
      this.hud.setView('CITY // ADDRESS SPACE');
      this.select(tower.fnIndex, { fly: false, inspect: false });
      this.walkHint(w.nearEntrance());
    });
  }

  private async followRoomCall(fi: number) {
    if (!this.model?.fns[fi].imp) return this.openRoom(fi, undefined, 'warp');
    if (!await this.world.walkToImport(fi)) return;
    this.roomTrail = [];
    this.hud.setView('CITY // ADDRESS SPACE');
    this.select(fi, { fly: false, inspect: false });
    this.walkHint(null);
  }

  private async toggleRoomMap(visitSelected = true) {
    const w = this.world;
    if (!w.room) return;
    if (w.roomMap) {
      const selected = visitSelected ? w.func?.selectedBlock : undefined;
      const room = w.room;
      w.closeRoomMap();
      this.hud.setView(`BUILDING // FLOOR ${room.floor}`);
      this.walkHint(null);
      if (selected && selected.addr !== room.block.addr) {
        if (w.inCorridor) {
          const walking = this.navTask;
          w.cancelCorridor();
          await walking;
        }
        await this.exclusive(() => this.openRoom(room.plan.fi, selected.addr, 'quick'));
      }
      return;
    }
    const showMap = async () => {
      w.rig.walkBlocked = true;
      try {
        await w.openRoomMap();
        if (w.roomMap) this.hud.setView('BUILDING MAP // CONTROL FLOW');
      } finally {
        w.rig.walkBlocked = false;
        this.walkHint(null);
      }
    };
    if (w.inCorridor) {
      if (!w.rig.walkBlocked) await showMap();
    } else await this.exclusive(showMap);
  }

  private clearInteriorNavigation() {
    this.roomTrail = [];
    this.world.clearRoom();
    this.hud.setWalkHint('');
    document.body.classList.remove('room-map-open');
    this.roomMapSidebar.show(null);
    this.updateCameraCenter();
  }

  /** Open a function from a reference (Inspector, palette…) staying in the current view type. */
  openFn(fi: number, site?: number) {
    const v = this.world.view;
    if (v === 'interior') return void this.exclusive(() => this.openRoom(fi, site, 'warp'));
    if (v === 'function') return void this.openCore(fi, site);
    if (v === 'constellation') return void this.exclusive(() => this.recenterTo(fi, true));
    this.select(fi, { addr: site });
  }

  /** Select + focus in the city, leaving the core / constellation if needed. */
  focusFn(fi: number) {
    if (this.world.view === 'city') return this.select(fi);
    void this.exclusive(async () => {
      await this.doToCity(false);
      this.select(fi);
    });
  }

  openCore(fi: number, site?: number, push = true) {
    return this.exclusive(() => this.doOpenCore(fi, site, push));
  }

  openGraph(fi: number, push = true) {
    return this.exclusive(() => this.doOpenGraph(fi, push));
  }

  toCity(push = true) {
    return this.exclusive(() => this.doToCity(push));
  }

  private async recenterTo(fi: number, push: boolean) {
    this.sel = fi;
    this.inspector.show(fi);
    const done = this.world.recenter(fi);
    this.setSeekUi(this.model!.fns[fi].addr);
    this.syncR2(this.model!.fns[fi].addr);
    if (push) this.nav.push({ view: 'constellation', fi, addr: null });
    await done;
  }

  private async doOpenCore(fi: number, site?: number, push = true) {
    const m = this.model;
    if (!m || !this.sock) return;
    if (m.fns[fi].imp) {
      this.hud.caption('// IMPORT', `${m.fns[fi].name} lives outside this binary`);
      return audio.error();
    }
    if (!this.world.roomMap && this.world.view === 'function' && this.world.func?.graph.addr === m.fns[fi].addr) {
      if (site !== undefined) this.goto(site);
      return;
    }
    const g = await this.sock.fn(m.fns[fi].addr);
    if (!g || !g.blocks?.length) {
      audio.error();
      this.hud.caption('// NO GRAPH', `nothing to render at ${hex(m.fns[fi].addr)}`);
      return;
    }
    this.clearInteriorNavigation();
    await this.world.enterFunction(g, site);
    if (this.viewNow() !== 'function' || this.world.func?.graph.addr !== g.addr) return;
    this.sel = fi;
    this.walk = [];
    this.hud.setView('CORE // CONTROL FLOW');
    this.hud.setDepth(null);
    this.hud.caption(`// ${g.name}`, `${g.blocks.length} blocks · ${g.ninstr} instructions · ↓ → ↑ ← walk the flow`);
    this.inspector.show(fi, site ?? g.addr);
    this.setSeekUi(site ?? g.addr);
    this.syncR2(site ?? g.addr);
    if (push) this.nav.push({ view: 'function', fi, addr: site ?? null });
  }

  private async doOpenGraph(fi: number, push = true) {
    if (!this.model) return;
    if (this.world.view === 'constellation') return this.recenterTo(fi, push);
    this.clearInteriorNavigation();
    await this.world.enterConstellation(fi);
    if (this.viewNow() !== 'constellation') return;
    this.sel = fi;
    this.hud.setView('CONSTELLATION // CALL GRAPH');
    this.hud.setDepth(null);
    this.hud.caption(`// ${this.model.fns[fi].name}`, 'callers above · address-takers violet · callees below · imports amber · click to re-centre');
    this.inspector.show(fi);
    this.setSeekUi(this.model.fns[fi].addr);
    this.syncR2(this.model.fns[fi].addr);
    if (push) this.nav.push({ view: 'constellation', fi, addr: null });
  }

  private async doToCity(push = true) {
    if (this.world.view === 'city') {
      this.world.stopWalking(true);
      this.walkHint(null);
      return;
    }
    this.clearInteriorNavigation();
    await this.world.backToCity();
    if (this.viewNow() !== 'city') return;
    this.hud.setView('CITY // ADDRESS SPACE');
    if (this.sel !== null) {
      this.world.setFocus(this.sel, this.depth);
      this.hud.setDepth(this.depth);
      this.inspector.show(this.sel);
    }
    if (push) this.nav.push({ view: 'city', fi: this.sel, addr: null });
  }

  /** Go to an address, wherever we are. */
  goto(addr: number, fromR2 = false) {
    const m = this.model;
    if (!m) return;
    const fi = m.fnAt(addr);
    const w = this.world;
    if (w.view === 'interior' && w.room) {
      if (fi < 0) return;
      if (w.room.plan.fi === fi && w.room.plan.blockAt(addr) === w.room.block) {
        this.setSeekUi(addr);
        if (!fromR2) this.syncR2(addr);
        return;
      }
      return void this.exclusive(() => this.openRoom(fi, addr, fi === w.room?.plan.fi ? 'quick' : 'warp'));
    }
    if (w.view === 'function' && w.func) {
      const p = w.func.panelAt(addr);
      if (p) {
        w.func.setSeek(addr);
        const f = w.func.frameOf(p);
        w.flyTo(f.pos, f.target, 1.1);
        if (w.roomMap) {
          this.walkHint(null);
          return;
        }
        this.setSeekUi(addr);
        if (!fromR2) this.syncR2(addr);
        this.nav.push({ view: 'function', fi, addr });
        return;
      }
      if (fi >= 0) return void this.openCore(fi, addr);
    }
    if (w.view === 'constellation' && fi >= 0) return this.openFn(fi);
    if (fi >= 0) return this.select(fi, { addr: addr === m.fns[fi].addr ? undefined : addr });
    // not inside any function (data, strings…): just move the halo marker
    this.setSeekUi(addr);
    if (!fromR2) this.syncR2(addr);
  }

  private hoverAddr(addr: number | null) {
    const w = this.world;
    if (w.view === 'function') w.func?.hoverAddr(addr);
    else if (w.view === 'city') w.focus?.highlightSite(addr);
  }

  private travel(x: number, z: number) {
    const w = this.world;
    if (w.rig.mode === 'walk') return;
    const cam = w.engine.camera.position;
    if (w.rig.mode === 'drone') {
      w.flyTo(new THREE.Vector3(x, Math.max(cam.y, 30), z + 20), new THREE.Vector3(x, 10, z), 1.4);
    } else {
      const off = cam.clone().sub(w.engine.controls.target);
      w.flyTo(new THREE.Vector3(x, 0, z).add(off.setLength(Math.min(off.length(), 160))), new THREE.Vector3(x, 8, z), 1.6);
    }
  }

  // ---------------------------------------------------------------- history
  private async apply(e: NavEntry) {
    if (e.view === 'city') {
      await this.doToCity(false);
      if (e.fi !== null) this.select(e.fi, { push: false, addr: e.addr ?? undefined });
      else {
        this.world.clearFocus();
        this.sel = null;
        this.hud.setDepth(null);
      }
    } else if (e.view === 'constellation' && e.fi !== null) {
      await this.doOpenGraph(e.fi, false);
    } else if (e.view === 'function' && e.fi !== null) {
      await this.doOpenCore(e.fi, e.addr ?? undefined, false);
      if (e.addr !== null && this.world.view === 'function') this.seekInCore(e.addr);
    } else if (e.view === 'interior' && e.fi !== null) {
      await this.openRoom(e.fi, e.addr ?? undefined, 'warp', undefined, 'restore');
    }
  }

  /** Move within the open core without touching history. */
  private seekInCore(addr: number) {
    const fv = this.world.func;
    const p = fv?.panelAt(addr);
    if (!fv || !p) return;
    fv.setSeek(addr);
    const f = fv.frameOf(p);
    this.world.flyTo(f.pos, f.target, 1.1);
    this.setSeekUi(addr);
    this.syncR2(addr);
  }

  private travelHistory(dir: -1 | 1) {
    if (this.busy) return audio.blip(180, 0.04, 'square', 0.02);
    const e = dir < 0 ? this.nav.back() : this.nav.forward();
    if (!e) return;
    audio.whoosh(0.5, dir > 0);
    void this.exclusive(() => this.apply(e));
  }

  back() {
    this.travelHistory(-1);
  }

  forward() {
    this.travelHistory(1);
  }

  private renderCrumbs() {
    const m = this.model;
    this.hud.setCrumbs(
      this.nav.trail(5).map(({ e, current }) => ({
        label: (e.view === 'city' ? '◌ ' : e.view === 'constellation' ? '✶ ' : e.view === 'interior' ? '▥ ' : '◈ ') + (e.fi !== null && m ? m.fns[e.fi].name.replace(/^sym\./, '') : 'city'),
        current,
        onClick: () => {
          if (this.busy || current) return;
          if (this.nav.jump(e)) void this.exclusive(() => this.apply(e));
        },
      })),
    );
  }

  // ---------------------------------------------------------------- world events
  private tipFor(p: Pick): string | null {
    const m = this.model;
    if (!m) return null;
    if (p.kind === 'tower') {
      const f = m.fns[p.fi];
      // the call instruction nearest to the hovered floor, if any
      let near = '';
      let best = Infinity;
      for (const c of m.out[p.fi]) {
        const d = Math.abs(m.frac(p.fi, c.site) - m.frac(p.fi, p.addr));
        if (d < best && d < 0.04) {
          best = d;
          near = `<div class="k">floor ${hex(c.site)} → <span class="v">${esc(m.fns[c.callee].name)}</span></div>`;
        }
      }
      return `<div class="n">${esc(f.name)}</div><div class="a">${hex(f.min)} – ${hex(f.max)}</div>
        <div><span class="k">size</span> <span class="v">${f.size}</span> <span class="k">blocks</span> <span class="v">${f.nbbs}</span> <span class="k">cc</span> <span class="v">${f.cc}</span></div>
        <div><span class="k">▲ callers</span> <span class="v">${m.callers(p.fi).length}</span> <span class="k">▼ callees</span> <span class="v">${m.callees(p.fi).length}</span> <span class="k">strings</span> <span class="v">${m.strOut[p.fi].length}</span>${m.refIn[p.fi].length ? ` <span class="k">&amp; taken by</span> <span class="v">${m.referrers(p.fi).length}</span>` : ''}</div>
        ${near}<div class="hint">click focus · dbl-click core · C graph</div>`;
    }
    if (p.kind === 'sat') {
      const n = p.fi !== null ? m.callers(p.fi).length : 0;
      return `<div class="k">IMPORT RELAY</div><div class="n">${esc(p.name)}</div>${p.fi !== null ? `<div><span class="k">called from</span> <span class="v">${m.in[p.fi].length}</span> <span class="k">sites in</span> <span class="v">${n}</span> <span class="k">fns</span></div>` : ''}`;
    }
    if (p.kind === 'node') {
      const f = m.fns[p.fi];
      return `<div class="n">${esc(f.name)}</div><div class="a">${hex(f.addr)}</div><div><span class="k">size</span> <span class="v">${f.size}</span> <span class="k">▲</span> <span class="v">${m.callers(p.fi).length}</span> <span class="k">▼</span> <span class="v">${m.callees(p.fi).length}</span></div><div class="hint">click re-centre · dbl-click core</div>`;
    }
    return null;
  }

  private onHover(p: Pick | null, s: { x: number; y: number }) {
    this.hud.tip(p ? this.tipFor(p) : null, s);
    if (this.world.view === 'function') this.inspector.hoverFromWorld(p?.kind === 'op' ? p.addr : null);
  }

  private onClick(p: Pick | null) {
    const m = this.model;
    if (!m || !this.ready) return;
    if (!p) {
      if (this.world.view === 'city' && this.sel !== null && this.world.rig.mode === 'orbit') {
        this.world.clearFocus();
        this.sel = null;
        this.hud.setDepth(null);
        this.nav.push({ view: 'city', fi: null, addr: null });
      }
      return;
    }
    audio.confirm();
    if (p.kind === 'tower') return this.select(p.fi, { addr: this.world.focus?.fi === p.fi ? this.nearestSite(p.fi, p.addr) : undefined });
    if (p.kind === 'sat' && p.fi !== null) return this.select(p.fi);
    if (p.kind === 'node') {
      if (p.fi === this.world.constel?.fi) return this.openCore(p.fi);
      return this.openFn(p.fi);
    }
    if (p.kind === 'op') return this.goto(p.addr);
  }

  private nearestSite(fi: number, addr: number): number | undefined {
    const m = this.model!;
    let best: number | undefined;
    let d = 0.04;
    for (const c of m.out[fi]) {
      const x = Math.abs(m.frac(fi, c.site) - m.frac(fi, addr));
      if (x < d) {
        d = x;
        best = c.site;
      }
    }
    return best;
  }

  private onDbl(p: Pick | null) {
    const m = this.model;
    if (!m || !p) return;
    if (p.kind === 'tower' || p.kind === 'node') return void this.openCore(p.fi, p.kind === 'tower' ? this.nearestSite(p.fi, p.addr) : undefined);
    if (p.kind === 'op') {
      // follow a call into its callee
      const op = this.inspector.ops().find((o) => o.addr === p.addr);
      if (op?.type === 'call' && op.jump !== undefined) {
        const fi = m.entryAt(op.jump);
        if (fi >= 0 && !m.fns[fi].imp) return void this.openCore(fi);
      }
    }
  }

  // ---------------------------------------------------------------- flow walk (core view)
  private flowStep(key: string) {
    const w = this.world;
    const fv = w.func;
    if (!fv || this.seek === null) return;
    const cur = fv.panelAt(this.seek);
    if (!cur) return;
    const at = cur.block.addr;
    let next: number | null = null;
    if (key === 'ArrowDown') {
      const s = fv.succ(at);
      next = (s.find((e) => e.kind === 'fail') ?? s[0])?.to ?? null;
    } else if (key === 'ArrowRight') {
      const s = fv.succ(at).filter((e) => e.kind !== 'fail');
      if (s.length) next = s[this.predCycle++ % s.length].to;
    } else if (key === 'ArrowUp') {
      const p = fv.preds(at);
      if (p.length) next = p[this.predCycle++ % p.length].from;
    } else if (key === 'ArrowLeft') {
      next = this.walk.pop() ?? null;
      if (next === null) return audio.blip(200, 0.05, 'square', 0.03);
      this.goto(next);
      return;
    }
    if (next === null) return audio.blip(200, 0.05, 'square', 0.03);
    if (key !== 'ArrowRight' && key !== 'ArrowUp') this.predCycle = 0;
    this.walk.push(at);
    audio.blip(key === 'ArrowRight' ? 980 : key === 'ArrowUp' ? 520 : 720, 0.05, 'triangle', 0.04);
    this.goto(next);
  }

  private stepInstr(d: number) {
    const ops = this.inspector.ops();
    if (!ops.length || this.seek === null) return;
    let i = ops.findIndex((o) => o.addr === this.seek);
    if (i < 0) i = ops.findIndex((o) => o.addr > this.seek!) - 1;
    const n = ops[Math.max(0, Math.min(ops.length - 1, i + d))];
    if (n) this.goto(n.addr);
  }

  // ---------------------------------------------------------------- palette
  private paletteItems(q: string): PaletteItem[] {
    const m = this.model;
    const items: PaletteItem[] = [];
    const addrQ = q.match(/^(?:0x)?([0-9a-f]{3,16})$/i);
    if (m && addrQ && q.startsWith('0x')) {
      const a = parseInt(addrQ[1], 16);
      const fi = m.fnAt(a);
      items.push({ kind: 'addr', label: hex(a), detail: fi >= 0 ? `in ${m.fns[fi].name}` : 'seek', run: () => this.goto(a) });
    }
    if (q) return items;
    const cmd = (label: string, detail: string, run: () => void) => items.push({ kind: 'cmd', label, detail, run });
    cmd('Cinematic tour', 'T', () => this.world.tour());
    cmd('Toggle drone flight', 'F', () => this.toggleDrone());
    cmd('Overview', 'H', () => this.world.overview());
    cmd('Back to the city', 'Esc', () => this.toCity());
    cmd('Toggle Inspector', 'I', () => this.inspector.toggle());
    cmd('Open r2 shell', '~', () => this.shell.toggle(true));
    cmd('Open another binary', ':open', () => this.pick());
    cmd('Entropy halo', 'p=e', () => this.world.focusEntropy());
    cmd('String nebula', 'iz', () => this.world.pulseStrings());
    cmd('Import relays', 'ii', () => this.world.pulseImports());
    if (!m) return items;
    m.fns.forEach((f, i) =>
      items.push({
        kind: f.imp ? 'imp' : 'fn',
        label: f.name,
        detail: `${hex(f.addr)} · ${f.size}B · ▲${m.in[i].length} ▼${m.out[i].length}`,
        run: () => (this.world.view === 'city' ? this.select(i) : this.openFn(i)),
      }),
    );
    for (const s of this.info?.strings ?? []) {
      const refs = m.strIn.get(s.vaddr) ?? [];
      items.push({
        kind: 'str',
        label: s.string,
        detail: `${hex(s.vaddr)} · ${refs.length ? `used by ${new Set(refs.map((r) => r.fn)).size} fn` : 'no code refs'}`,
        run: () => {
          if (refs.length) this.openFn(refs[0].fn, refs[0].site);
          else this.goto(s.vaddr);
        },
      });
    }
    for (const sec of this.info?.sections ?? []) if (sec.name) items.push({ kind: 'sec', label: sec.name, detail: `${hex(sec.vaddr)} · ${sec.perm} · ${sec.size}B`, run: () => this.goto(sec.vaddr) });
    for (const s of this.info?.symbols ?? []) if (s.name && s.vaddr) items.push({ kind: 'sym', label: s.name, detail: hex(s.vaddr), run: () => this.goto(s.vaddr) });
    return items;
  }

  // ---------------------------------------------------------------- shell
  private complete(word: string): string[] {
    const set = new Set<string>();
    for (const c of R2_COMMANDS) if (c.startsWith(word)) set.add(c);
    if (word.startsWith(':')) for (const c of [':tour', ':home', ':open', ':drone', ':music', ':fx', ':help']) if (c.startsWith(word)) set.add(c);
    for (const f of this.model?.fns ?? []) if (f.name.startsWith(word)) set.add(f.name);
    for (const s of this.info?.symbols ?? []) {
      const n = `sym.${s.name}`;
      if (n.startsWith(word)) set.add(n);
    }
    return [...set].sort().slice(0, 400);
  }

  private async resolve(expr: string): Promise<number | null> {
    if (!this.sock) return null;
    const r = await this.sock.cmd(`?v ${expr}`);
    const v = parseInt(r.text.replace(/\x1b\[[0-9;]*m/g, '').trim(), 16);
    return Number.isFinite(v) ? v : null;
  }

  async dispatch(raw: string) {
    const cmd = raw.trim();
    const w = this.world;
    if (cmd.startsWith(':')) return this.meta(cmd);
    if (cmd === 'q' || cmd === '..' || cmd === 'exit' || cmd === 'q!') {
      if (w.view !== 'city') {
        await this.toCity();
        return;
      }
      this.shell.write('\x1b[38;2;107;93;140m(already in the city — :open to pick another binary)\x1b[0m\n');
      return;
    }
    if (!this.sock || !this.ready || !this.model) {
      this.shell.write('\x1b[33manalysis in progress… hold on\x1b[0m\n');
      return;
    }
    const r = await this.sock.cmd(cmd, this.shell.cols);
    if (r.text) this.shell.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
    if (r.err) audio.error();
    const head = cmd.split(/[\s@~;]/)[0];
    const at = cmd.match(/@\s*(\S+)/);
    const target = at ? await this.resolve(at[1]) : (r.seek ?? this.seek);
    const fi = target !== null ? this.model.fnAt(target) : -1;
    if (/^(pdf|pdr|agf|VV?)$/.test(head) && fi >= 0) return void this.openCore(fi, target !== this.model.fns[fi].addr ? (target ?? undefined) : undefined);
    if (/^(agc|agC)$/.test(head) && fi >= 0) return void this.openGraph(fi);
    if (/^(axt|axf|afx)$/.test(head) && fi >= 0) {
      if (w.view !== 'city') await this.toCity();
      this.select(fi);
      this.inspector.setTab('xrefs');
      return;
    }
    if (r.seek !== null && r.seek !== this.seek) this.goto(r.seek, true);
    if (w.view !== 'city') return;
    if (head === 'afl') w.sweep();
    else if (head === 'iz' || head === 'izz') w.pulseStrings();
    else if (head === 'ii') w.pulseImports();
    else if (head === 'iS' || head === 'p=e') w.focusEntropy();
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
        if (this.world.view !== 'city') await this.toCity();
        sh.toggle(false);
        this.world.tour();
        break;
      case 'home':
        this.world.overview();
        break;
      case 'drone':
        this.toggleDrone();
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

  // ---------------------------------------------------------------- keys
  private toggleDrone() {
    if (this.world.room || this.busy) return;
    if (this.world.rig.mode === 'walk') this.world.stopWalking();
    this.world.rig.setMode(this.world.rig.mode === 'drone' ? 'orbit' : 'drone');
    this.walkHint(null);
  }

  private onWalkKey(e: KeyboardEvent) {
    const w = this.world;
    const k = e.key.toLowerCase();
    if (w.roomMap) {
      if (k === 'm' || k === 'enter' || k === 'escape' || k === 'backspace') {
        e.preventDefault();
        if ((!this.busy || w.inCorridor) && !e.repeat) void this.toggleRoomMap(k === 'm' || k === 'enter');
        return true;
      }
      if (k === 'x') {
        if (!e.repeat) this.leaveBuilding();
        return true;
      }
      if (k.startsWith('arrow') || k === 'f') return true;
      return false;
    }
    if (w.rig.mode !== 'walk') return false;
    if (k === 'arrowup' || k === 'arrowdown' || (e.shiftKey && (k === 'arrowleft' || k === 'arrowright'))) return true;
    const room = w.room;
    if (w.inCorridor && (k === 'm' || k === ' ')) {
      e.preventDefault();
      if (k === 'm' && !e.repeat) void this.toggleRoomMap();
      return true;
    }
    if (k === 'escape') {
      if (!w.rig.locked && !this.busy && !room) this.toggleWalking();
      return true;
    }
    if (k === 'e' || k === 'enter') {
      e.preventDefault();
      if (this.busy || e.repeat) return true;
      if (room) {
        const exit = room.selectedExit ?? w.aimedRoomExit();
        if (exit) this.takeRoomExit(exit, true);
      } else {
        const tower = w.nearEntrance();
        if (tower) this.enterTower(tower, true);
      }
      return true;
    }
    if (k === 'g' && !room) {
      if (!e.repeat) this.toggleWalking();
      return true;
    }
    if (!room) return false;
    if (k === ' ' || k === 'r') {
      const callee = (room.selectedCall ?? w.aimedRoomCall())?.callee;
      if (callee !== undefined) {
        e.preventDefault();
        if (!this.busy && !e.repeat) void this.exclusive(() => this.followRoomCall(callee));
        return true;
      }
    }
    if (['m', 'backspace', 'x', 'tab', 'arrowleft', 'arrowright', '[', ']'].includes(k)) {
      e.preventDefault();
      if (this.busy || (e.repeat && !k.startsWith('arrow'))) return true;
      if (k === 'm') void this.toggleRoomMap();
      if (k === 'backspace') this.backRoom();
      if (k === 'x') this.leaveBuilding();
      if (k === 'tab') room.cycleCall(e.shiftKey ? -1 : 1);
      if (k === 'arrowleft' || k === 'arrowright') room.cycleExit(k === 'arrowleft' ? -1 : 1);
      if (k === '[' || k === ']') room.pageSummary(k === '[' ? -1 : 1);
      if (!this.busy) this.walkHint(null, w.aimedRoomExit());
      return true;
    }
    return false;
  }

  private toggleHelp() {
    if (this.helpEl) {
      this.helpEl.remove();
      this.helpEl = null;
      return;
    }
    const rows = KEYS_HELP.map(([k, d]) => `<div class="hk"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('');
    this.helpEl = corners(h('div', { class: 'panel helpbox' }));
    this.helpEl.innerHTML += `<div class="ptitle">// CONTROLS</div>${rows}<div class="hint">press ? to close</div>`;
    this.helpEl.onclick = () => this.toggleHelp();
    this.ui.append(this.helpEl);
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const inShell = this.shell?.el.contains(t);
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      if (this.ready) this.palette.isOpen ? this.palette.close() : this.palette.open();
      return;
    }
    if (this.palette?.isOpen) return;
    if (typing && !inShell) return;
    if ((e.key === '`' || e.key === '~' || e.key === 'º') && !this.shell.isOpen && this.ready) {
      e.preventDefault();
      this.shell.toggle(true);
      return;
    }
    if (inShell) {
      if (e.key === 'Escape') this.shell.toggle(false);
      return;
    }
    if (!this.ready) return;
    if (e.altKey && e.key === 'ArrowLeft') return (e.preventDefault(), this.back());
    if (e.altKey && e.key === 'ArrowRight') return (e.preventDefault(), this.forward());
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const w = this.world;
    const drone = w.rig.mode === 'drone';
    const k = e.key;
    if (k === '/') return (e.preventDefault(), this.palette.open());
    if (k === '?') return this.toggleHelp();
    if (k === 'Escape' && this.helpEl) return this.toggleHelp();
    if (this.onWalkKey(e)) return;
    if (k === 'Escape') {
      if (drone && !w.rig.locked) return w.rig.setMode('orbit');
      if (w.view !== 'city') return void this.toCity();
      if (this.sel !== null) {
        w.clearFocus();
        this.sel = null;
        this.hud.setDepth(null);
        this.nav.push({ view: 'city', fi: null, addr: null });
      }
      return;
    }
    if (k.toLowerCase() === 'g' && !e.repeat) return this.toggleWalking();
    if (k === 'f' || k === 'F') return this.toggleDrone();
    if (drone && 'wasdqeWASDQE '.includes(k)) return; // flight keys belong to the rig
    if (k === 'Backspace') return (e.preventDefault(), this.back());
    if (k === 'i' || k === 'I') return this.inspector.toggle();
    if (k === 't' || k === 'T') return void w.tour();
    if (k === 'h' || k === 'H') return void w.overview();
    if (k === 'c' || k === 'C') {
      if (w.view === 'constellation') return void this.toCity();
      const fi = this.sel ?? (this.seek !== null ? this.model?.fnAt(this.seek) ?? -1 : -1);
      if (fi !== null && fi >= 0) return void this.openGraph(fi);
      return;
    }
    if (k === 'Enter') {
      const fi = this.sel ?? (this.seek !== null ? this.model?.fnAt(this.seek) ?? -1 : -1);
      if (fi !== null && fi >= 0 && w.view === 'function' && w.func?.selectedBlock && !w.engine.presenting) {
        const addr = w.func.selectedBlock.addr;
        return void this.exclusive(() => this.openRoom(fi, addr, 'warp'));
      }
      if (fi !== null && fi >= 0 && w.view !== 'function') return void this.openCore(fi);
      return;
    }
    if (['1', '2', '3'].includes(k) && w.view === 'city' && this.sel !== null) {
      this.depth = Number(k);
      w.setFocus(this.sel, this.depth);
      this.hud.setDepth(this.depth);
      audio.blip(500 + this.depth * 200, 0.06, 'triangle', 0.04);
      return;
    }
    if (w.view === 'function') {
      if (k.startsWith('Arrow')) return (e.preventDefault(), this.flowStep(k));
      if (k === 'j' || k === 'J') return this.stepInstr(1);
      if (k === 'k' || k === 'K') return this.stepInstr(-1);
    }
  }
}

const app = new App();
// dev builds only: expose the app for the Playwright navigation tests (scripts/navtest.ts)
if (import.meta.env.DEV) (window as unknown as { __r3: App }).__r3 = app;
document.fonts.ready.then(() => app.boot());
