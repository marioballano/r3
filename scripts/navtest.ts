// End-to-end navigation test: drives r3 like a user (keys, mouse on projected 3D
// positions, Inspector clicks, palette, shell) and checks state invariants after
// every step. Needs `npm run dev` (uses the dev-only window.__r3 hook).
//   npx tsx scripts/navtest.ts [/usr/bin/ssh]
import { chromium, type Page } from 'playwright';

const BIN = process.argv[2] ?? '/usr/bin/ssh';
const URL = process.env.R3_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));

let failures = 0;
let checks = 0;
const ev = <T>(js: string) => page.evaluate(js) as Promise<T>;
const wait = (ms: number) => page.waitForTimeout(ms);
const key = (k: string) => page.keyboard.press(k);

interface S {
  view: string;
  trans: boolean;
  sel: number | null;
  selName: string | null;
  seek: number | null;
  hud: string;
  insFi: number;
  insOpen: boolean;
  focusFi: number | null;
  focusDepth: number | null;
  constelFi: number | null;
  funcAddr: number | null;
  nav: { i: number; stack: { view: string; fi: number | null; addr: number | null }[] };
  mode: string;
  cam: number[];
  fnAtSeek: number;
  selAddr: number | null;
}

const state = () =>
  ev<S>(`(() => { const a = window.__r3, w = a.world, m = a.model; return {
    view: w.view, trans: w.transitioning, sel: a.sel, selName: a.sel !== null ? m.fns[a.sel].name : null,
    seek: a.seek, hud: document.querySelector('.hud .view').textContent, insFi: a.inspector.fi, insOpen: a.inspector.isOpen,
    focusFi: w.focus ? w.focus.fi : null, focusDepth: w.focus ? w.focus.depth : null,
    constelFi: w.constel && w.view === 'constellation' ? w.constel.fi : null, funcAddr: w.func && w.view === 'function' ? w.func.graph.addr : null,
    nav: a.nav.snapshot(), mode: w.rig.mode, cam: w.engine.camera.position.toArray(),
    fnAtSeek: a.seek !== null ? m.fnAt(a.seek) : -1, selAddr: a.sel !== null ? m.fns[a.sel].addr : null }; })()`);

const fnIndex = (name: string) => ev<number>(`window.__r3.model.index(${JSON.stringify(name)})`);
const r2seek = () => ev<number | null>(`window.__r3.sock.cmd('s').then(r => r.seek)`);

async function settle(extra = 600) {
  await wait(150); // let the action enter the navigation lane
  for (let i = 0; i < 80; i++) {
    const t = await ev<boolean>(`window.__r3.busy || window.__r3.world.rig.flying`);
    if (!t) break;
    await wait(250);
  }
  await wait(extra);
}

function check(cond: boolean, msg: string, detail?: unknown) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`   ✖ ${msg}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

/** Invariants that must hold whenever the UI is at rest. */
async function invariants(label: string) {
  const s = await state();
  const cur = s.nav.stack[s.nav.i];
  const hudWant = s.view === 'city' ? 'CITY' : s.view === 'function' ? 'CORE' : 'CONSTELLATION';
  check(!s.trans, `${label}: world not transitioning`);
  check(s.hud.startsWith(hudWant), `${label}: HUD view matches world view`, { hud: s.hud, view: s.view });
  check(!!cur && cur.view === s.view, `${label}: history entry view == world view`, { cur, view: s.view });
  if (s.sel !== null) {
    check(!cur || cur.fi === s.sel, `${label}: history entry fn == selection`, { cur, sel: s.sel });
    if (s.insOpen) check(s.insFi === s.sel, `${label}: Inspector shows the selection`, { ins: s.insFi, sel: s.sel });
    if (s.view === 'city') check(s.focusFi === s.sel, `${label}: city focus == selection`, { focus: s.focusFi, sel: s.sel });
    if (s.view === 'function') {
      check(s.funcAddr === s.selAddr, `${label}: core shows the selected function`, { func: s.funcAddr, sel: s.selAddr });
      check(s.fnAtSeek === s.sel, `${label}: seek lies inside the selected function`, { seek: s.seek, fnAtSeek: s.fnAtSeek, sel: s.sel });
    }
    if (s.view === 'constellation') check(s.constelFi === s.sel, `${label}: constellation centred on selection`, { c: s.constelFi, sel: s.sel });
  } else if (s.view === 'city') check(s.focusFi === null, `${label}: no focus without a selection`, { focus: s.focusFi });
  await wait(400);
  const rs = await r2seek();
  if (s.seek !== null) check(rs === s.seek, `${label}: r2 seek == UI seek`, { r2: rs, ui: s.seek });
  return s;
}

async function step(label: string, fn: () => Promise<void>, settleMs = 600) {
  console.log(`▸ ${label}`);
  const before = failures;
  await fn();
  await settle(settleMs);
  const s = await invariants(label);
  console.log(`   view=${s.view} sel=${s.selName} seek=0x${(s.seek ?? 0).toString(16)} nav=${s.nav.i}/${s.nav.stack.length} ${failures === before ? '✓' : ''}`);
  return s;
}

/** Project a world point to screen pixels. */
const screenOf = (expr: string) =>
  ev<[number, number, number] | null>(`(() => { const w = window.__r3.world; const v = (${expr}); if (!v) return null; const p = v.clone().project(w.engine.camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight, p.z]; })()`);

async function palette(q: string) {
  await key('Control+k');
  await wait(300);
  await page.keyboard.type(q, { delay: 5 });
  await wait(300);
  await key('Enter');
}

async function shell(cmd: string) {
  const open = await ev<boolean>(`window.__r3.shell.isOpen`);
  if (!open) {
    await key('Backquote');
    await wait(500);
  }
  await page.click('.term .xt');
  await page.keyboard.type(cmd, { delay: 5 });
  await key('Enter');
  await wait(1500);
}

// ============================================================================ run
await page.goto(`${URL}/?open=${encodeURIComponent(BIN)}&auto=1`);
await page.waitForFunction(`window.__r3 && window.__r3.ready`, null, { timeout: 180_000 });
await settle(5000);
const A = 'fcn.00062ee0';
const iA = await fnIndex(A);
console.log(`loaded ${BIN}; A=${A} (#${iA})`);

await step('palette → select A (city focus)', () => palette(A));
let s = await state();
check(s.sel === iA, 'selection is A', s.sel);

await step('depth 2', async () => key('2'));
s = await state();
check(s.focusDepth === 2, 'focus depth 2', s.focusDepth);
await key('1');

const s1 = await step('C → constellation', () => key('c'), 1500);
check(s1.view === 'constellation', 'in constellation');

// click a caller node on screen
const nodeIdx = await ev<number>(`window.__r3.world.constel.nodes.findIndex(n => n.role === 'caller' && n.hop === 1)`);
const iB = await ev<number>(`window.__r3.world.constel.nodes[${nodeIdx}].fi`);
const np = await screenOf(`window.__r3.world.constel.nodes[${nodeIdx}].pos`);
await step('click caller node B in constellation → re-centre', async () => {
  if (np) {
    await page.mouse.move(np[0], np[1]);
    await wait(800);
    const hv = await ev<number | null>(`(() => { const h = window.__r3.world.hovered; return h && h.kind === 'node' ? h.fi : null; })()`);
    check(hv === iB, 'hovering the node picks it', { hovered: hv, B: iB });
    await page.mouse.click(np[0], np[1]);
  }
}, 2000);
s = await state();
check(s.sel === iB, 'selection moved to clicked node B', { sel: s.sel, B: iB });

await step('Alt+← back → A', () => key('Alt+ArrowLeft'), 2000);
s = await state();
check(s.sel === iA && s.view === 'constellation', 'back to A in constellation', { sel: s.sel, view: s.view });
await step('Alt+→ forward → B', () => key('Alt+ArrowRight'), 2000);
s = await state();
check(s.sel === iB, 'forward to B', s.sel);

await step('Enter → core of B', () => key('Enter'), 2500);
s = await state();
check(s.view === 'function', 'in core', s.view);

const before = (await state()).seek;
await step('↓ flow-walk', () => key('ArrowDown'), 1200);
s = await state();
check(s.seek !== before, 'seek moved after ↓', { before, after: s.seek });
await step('← step back', () => key('ArrowLeft'), 1200);
s = await state();
check(s.seek === before, '← returns to previous block', { before, after: s.seek });
await step('J next instruction', () => key('j'), 800);
await step('K previous instruction', () => key('k'), 800);
s = await state();
check(s.seek === before, 'J then K returns to same instruction', { before, after: s.seek });

// Inspector: click the 6th op row
await step('click Inspector disasm row', async () => {
  const rows = await page.$$('.dr.op');
  if (rows[5]) await rows[5].click();
}, 1200);

// Inspector: follow a call operand into its callee
const hasCall = await page.$('.dr.op .tk.fn');
if (hasCall) {
  const calleeName = (await hasCall.textContent()) ?? '';
  await step(`click call operand → ${calleeName}`, async () => hasCall.click(), 2500);
  s = await state();
  check(s.selName === calleeName && s.view === 'function', 'followed call into callee core', { sel: s.selName, want: calleeName, view: s.view });
  await step('Alt+← back from callee', () => key('Alt+ArrowLeft'), 2500);
  s = await state();
  check(s.sel === iB && s.view === 'function', 'back in B core', { sel: s.selName, view: s.view });
}

await step('Inspector ◎ FOCUS from core → city focus', () => page.click('.ins-act:nth-child(1)'), 2500);
s = await state();
check(s.view === 'city' && s.focusFi === iB, 'FOCUS button returns to city focus', { view: s.view, focus: s.focusFi });

await step('Esc clears focus', () => key('Escape'), 800);
s = await state();
check(s.sel === null && s.focusFi === null, 'focus cleared', { sel: s.sel, focus: s.focusFi });

// real mouse: find a tower that is actually under the cursor, click it, then double-click it
await step('H → overview', () => key('h'), 1500);
let target: { fi: number; x: number; y: number } | null = null;
const cands = await ev<number[]>(`(() => [...window.__r3.world.city.towers].sort((a,b) => b.height - a.height).slice(0, 40).map(t => t.fnIndex))()`);
for (const fi of cands) {
  const p = await screenOf(`(() => { const t = window.__r3.world.city.towerOfFn(${fi}); const v = t.pos.clone(); v.y = t.height * 0.8; return v; })()`);
  if (!p || p[2] > 1 || p[0] < 20 || p[1] < 20 || p[0] > 820 || p[1] > 650) continue;
  await page.mouse.move(p[0], p[1]);
  await wait(500);
  const hov = await ev<number | null>(`(() => { const h = window.__r3.world.hovered; return h && h.kind === 'tower' ? h.fi : null; })()`);
  if (hov !== null) {
    target = { fi: hov, x: p[0], y: p[1] };
    break;
  }
}
check(target !== null, 'found a tower under the cursor');
if (target) {
  await step('click tower under cursor', () => page.mouse.click(target!.x, target!.y), 2000);
  s = await state();
  check(s.sel === target.fi, 'clicking selects the hovered tower', { hovered: target.fi, sel: s.sel });
  const tp2 = await screenOf(`(() => { const t = window.__r3.world.city.towerOfFn(${target.fi}); const v = t.pos.clone(); v.y = t.height * 0.6; return v; })()`);
  if (tp2) {
    await page.mouse.move(tp2[0], tp2[1]);
    await wait(500);
    await step('double-click tower → core', () => page.mouse.dblclick(tp2[0], tp2[1]), 3000);
    s = await state();
    check(s.view === 'function', 'double-click dives into core', s.view);
    await step('Esc → city', () => key('Escape'), 2500);
  }
}

// mashing keys during a transition
await step('mash: C, Enter, Esc during warps', async () => {
  await palette(A);
  await wait(2500);
  await key('c');
  await wait(300);
  await key('Enter');
  await wait(300);
  await key('Escape');
}, 3000);

// shell-driven navigation
const vBefore = (await state()).view;
await step('shell: s fcn.00017d40', () => shell('s fcn.00017d40'), 2500);
s = await state();
check(s.selName === 'fcn.00017d40' && s.view === vBefore, 'shell seek selects it, staying in the same view', { sel: s.selName, view: s.view, before: vBefore });
await step('shell: pdf @ fcn.00062ee0', () => shell('pdf @ fcn.00062ee0'), 3000);
s = await state();
check(s.selName === A && s.view === 'function', 'pdf @ X opens core of X', { sel: s.selName, view: s.view });
await step('shell: agc', () => shell('agc'), 3000);
s = await state();
check(s.view === 'constellation' && s.selName === A, 'agc opens constellation', { sel: s.selName, view: s.view });
await step('shell: q', () => shell('q'), 3000);
s = await state();
check(s.view === 'city', 'q returns to city', s.view);
await page.keyboard.press('Escape'); // close shell

// drone
await step('F → drone, fly forward', async () => {
  await key('f');
  await wait(300);
  await page.keyboard.down('w');
  await wait(1500);
  await page.keyboard.up('w');
}, 600);
const sd = await state();
check(sd.mode === 'drone', 'drone mode on', sd.mode);
await step('drone in core can reach the whole graph (below ground level)', async () => {
  await palette(A);
  await wait(2500);
  await key('Enter');
  await wait(4000);
  await page.keyboard.down('q');
  await wait(1500);
  await page.keyboard.up('q');
}, 600);
s = await state();
check(s.cam[1] < 0, 'drone can descend below y=0 inside the core', s.cam);
await key('f');
await step('back to city', () => key('Escape'), 2500);

// breadcrumbs
await step('click first breadcrumb', async () => {
  const c = await page.$('.hud .crumbs .crumb');
  await c?.click();
}, 2500);

console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
if (errors.length) console.log('page errors:\n  ' + [...new Set(errors)].slice(0, 15).join('\n  '));
await browser.close();
process.exit(failures ? 1 : 0);
