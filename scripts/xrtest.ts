// WebXR smoke test: drives r3 through a mocked headset + Touch controllers (scripts/xrmock.js)
// in headless Chromium, checks the app state after each controller action and saves the stereo
// frames. Needs `npm run dev`.
//   npx tsx scripts/xrtest.ts [/usr/bin/ssh] [outdir]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BIN = process.argv[2] ?? '/usr/bin/ssh';
const OUT = process.argv[3] ?? 'shots/xr';
const BASE = process.env.R3_URL ?? 'http://127.0.0.1:5173';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.addInitScript({ content: readFileSync(new URL('./xrmock.js', import.meta.url), 'utf8') });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => (m.type() === 'error' || m.text().includes('[r3]')) && errors.push(`console: ${m.text().slice(0, 300)}`));

let fails = 0;
let checks = 0;
const ev = <T>(js: string) => page.evaluate(js) as Promise<T>;
const wait = (ms: number) => page.waitForTimeout(ms);
const check = (ok: boolean, what: string, info?: unknown) => {
  checks++;
  if (!ok) fails++;
  console.log(`   ${ok ? '✓' : '✖'} ${what}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`);
};
const step = (s: string) => console.log(`▸ ${s}`);
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });
const idle = async (max = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    if (!(await ev<boolean>(`window.__r3.busy || window.__r3.world.rig.flying || window.__r3.world.transitioning`))) return;
    await wait(200);
  }
};
/** let the XR loop run n frames (software rendering is slow: time-based waits can miss input) */
const frames = async (n = 3) => {
  const f0 = await ev<number>(`__xr.frames`);
  await page.waitForFunction(`__xr.frames >= ${f0 + n}`, null, { timeout: 30_000 });
};
const press = async (hand: string, b: number) => {
  await ev(`__xr.button('${hand}', ${b}, true)`);
  await frames();
  await ev(`__xr.button('${hand}', ${b}, false)`);
  await frames();
};
const S = () =>
  ev<{ view: string; sel: number | null; seek: number | null; presenting: boolean; eye: number[]; hov: string | null; rigS: number }>(`(() => {
    const a = window.__r3, w = a.world, e = w.engine, rig = e.scene.getObjectByName('xr-rig'), h = w.hovered;
    return { view: w.view, sel: a.sel, seek: a.seek, presenting: e.presenting, eye: e.camera.position.toArray().map(v => +v.toFixed(1)),
      hov: h ? h.kind + ':' + (h.fi ?? h.addr) : null, rigS: +rig.scale.x.toFixed(2) };
  })()`);
/** turn the mock head (and the parallel controller rays) towards a world point */
const aim = (expr: string) =>
  ev(`(() => {
    const w = window.__r3.world, rig = w.engine.scene.getObjectByName('xr-rig');
    const t = (${expr});
    const d = t.clone().sub(w.engine.camera.position).applyQuaternion(rig.quaternion.clone().invert()).normalize();
    __xr.state.yaw = Math.atan2(-d.x, -d.z);
    __xr.state.pitch = Math.asin(d.y);
  })()`);

step(`load ${BIN}`);
await page.goto(`${BASE}/?open=${encodeURIComponent(BIN)}&auto=1`);
await page.waitForFunction(`window.__r3 && window.__r3.ready`, null, { timeout: 180_000 });
await wait(6000);
check((await page.locator('.xrbar button').count()) === 2, 'ENTER VR + MR buttons shown');
await shot('00-desktop');

step('enter VR');
await page.locator('.xrbar button', { hasText: 'VR' }).click();
await wait(1500);
let s = await S();
check(s.presenting && s.rigS === 1, 'presenting at life scale', s);
check(await ev<boolean>(`document.querySelector('.xrbar').classList.contains('hidden')`), 'buttons hidden while presenting');
await shot('01-vr-city');

step('aim at the tallest tower → hover card');
const fi = await ev<number>(`[...window.__r3.world.city.towers].sort((a, b) => b.height - a.height)[0].fnIndex`);
await aim(`(() => { const t = w.city.towerOfFn(${fi}); return t.pos.clone().setY(t.height * 0.7); })()`);
await wait(800);
s = await S();
check(s.hov?.startsWith('tower:') ?? false, 'controller ray hovers a tower', s.hov);
const fiHit = Number(s.hov?.split(':')[1]);
const fps = await ev<number>(`(async () => { const f = __xr.frames; await new Promise(r => setTimeout(r, 2000)); return (__xr.frames - f) / 2; })()`);
console.log(`   (mock XR loop at ${fps} fps)`);
await shot('02-vr-hover');

step('trigger → select + flight follows');
const eye0 = s.eye;
await ev(`__xr.select('right')`);
await wait(600);
await idle();
await wait(500);
s = await S();
check(s.sel === fiHit, 'trigger selected the hovered tower', s.sel);
check(Math.hypot(s.eye[0] - eye0[0], s.eye[1] - eye0[1], s.eye[2] - eye0[2]) > 20, 'the rig flew with the camera', { from: eye0, to: s.eye });
await aim(`(() => { const t = w.city.towerOfFn(${fiHit}); return t.pos.clone().setY(t.height * 0.6); })()`);
await wait(600);
await shot('03-vr-focus');

step('A → core');
await press('right', 4);
await page.waitForFunction(`window.__r3.world.view === 'function'`, null, { timeout: 120_000 });
await idle(20000);
await wait(1500);
s = await S();
check(s.view === 'function', 'in the core', s.view);
await aim(`(() => { const o = w.func.overview(1, 70); return o.target; })()`);
await wait(1200);
await shot('04-vr-core');
// up close: the seek block
await ev(`(() => { const w = window.__r3.world, p = w.func.panelAt(window.__r3.seek); const f = w.func.frameOf(p); w.flyTo(f.pos, f.target, 0.6); })()`);
await idle();
await aim(`w.func.panelAt(window.__r3.seek).mesh.getWorldPosition(new (w.engine.camera.position.constructor)())`);
await frames(8);
await shot('04b-vr-core-close');

step('R grip + flick down → flow walk');
const seek0 = s.seek;
await ev(`__xr.button('right', 1, true)`);
await ev(`__xr.stick('right', 0, 1)`);
await frames();
await ev(`__xr.stick('right', 0, 0)`);
await ev(`__xr.button('right', 1, false)`);
await frames();
await wait(400);
await idle();
s = await S();
check(s.seek !== seek0, 'seek moved along the flow', { from: seek0, to: s.seek });

step('B → city');
await press('right', 5);
await page.waitForFunction(`window.__r3.world.view === 'city'`, null, { timeout: 30_000 });
await idle();
check((await S()).view === 'city', 'back in the city');

step('X → constellation');
await press('left', 4);
await page.waitForFunction(`window.__r3.world.view === 'constellation'`, null, { timeout: 30_000 });
await idle();
await wait(1500);
await aim(`w.constel.overview(70, 1).target`);
await wait(800);
await shot('05-vr-constellation');
const node = await ev<number>(`window.__r3.world.constel.nodes.findIndex(n => n.hop === 1)`);
await aim(`w.constel.nodes[${node}].pos.clone()`);
await wait(800);
s = await S();
check(s.hov?.startsWith('node:') ?? false, 'ray hovers a constellation node', s.hov);
await press('right', 5);
await page.waitForFunction(`window.__r3.world.view === 'city'`, null, { timeout: 30_000 });
await idle();

step('Y → giant → tabletop');
await press('left', 5);
s = await S();
check(s.rigS === 12, 'giant scale', s.rigS);
await press('left', 5);
await wait(300);
s = await S();
check(s.rigS > 12, 'tabletop scale', s.rigS);
await aim(`new (w.engine.camera.position.constructor)(0, 0, 0)`);
await wait(800);
await shot('06-vr-table');
await press('left', 5);
check((await S()).rigS === 1, 'back to life size');

step('L stick → fly');
await ev(`__xr.state.pitch = 0`);
const e1 = (await S()).eye;
await ev(`__xr.stick('left', 0, -1)`);
await frames(12);
await ev(`__xr.stick('left', 0, 0)`);
await frames(4);
const e2 = (await S()).eye;
check(Math.hypot(e2[0] - e1[0], e2[2] - e1[2]) > 5, 'flew forward', { from: e1, to: e2 });
await shot('07-vr-fly');

step('R stick → snap turn');
const yaw0 = await ev<number>(`(() => { const d = window.__r3.world.engine.camera.getWorldDirection(new (window.__r3.world.engine.camera.position.constructor)()); return Math.atan2(-d.x, -d.z); })()`);
await ev(`__xr.stick('right', 1, 0)`);
await frames(4);
await ev(`__xr.stick('right', 0, 0)`);
await frames(4);
const yaw1 = await ev<number>(`(() => { const d = window.__r3.world.engine.camera.getWorldDirection(new (window.__r3.world.engine.camera.position.constructor)()); return Math.atan2(-d.x, -d.z); })()`);
const dy = Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0));
check(Math.abs(Math.abs(dy) - Math.PI / 6) < 0.05, 'snap-turned 30°', +((dy * 180) / Math.PI).toFixed(1));

step('exit');
await ev(`__xr.session.end()`);
await wait(1500);
s = await S();
check(!s.presenting, 'session ended', s);
check(await ev<boolean>(`!document.querySelector('.xrbar').classList.contains('hidden')`), 'buttons back');
check(await ev<boolean>(`window.__r3.world.engine.controls.enabled`), 'orbit controls back');
await shot('08-desktop-after');

step('MR passthrough');
await page.locator('.xrbar button', { hasText: 'MR' }).click();
await wait(1500);
s = await S();
check(s.presenting && s.rigS > 12, 'MR starts as a tabletop', s.rigS);
check(await ev<boolean>(`window.__r3.world.engine.scene.background === null`), 'no background in passthrough');
await aim(`new (w.engine.camera.position.constructor)(0, 0, 0)`);
await wait(800);
await shot('09-mr-table');
await ev(`__xr.session.end()`);
await wait(1000);
check(await ev<boolean>(`window.__r3.world.engine.scene.background !== null`), 'background restored');

for (const e of errors) console.log('  ', e);
check(errors.length === 0, 'no page errors');
console.log(`\n${checks - fails}/${checks} checks passed, ${fails} failed`);
await browser.close();
process.exit(fails ? 1 : 0);
