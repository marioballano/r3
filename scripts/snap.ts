// Dev helper: drive r3 in headless Chromium (SwiftShader WebGL) and save screenshots of each feature.
// usage: npm run snap -- [binary] [outdir]     (needs `npm run dev` running)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const bin = process.argv[2] ?? '/usr/bin/ssh';
const out = process.argv[3] ?? 'shots';
const FN = process.env.FN ?? 'fcn.00062ee0';
const url = process.env.R3_URL ?? 'http://127.0.0.1:5173';
const steps = new Set((process.env.STEPS ?? 'city,focus,depth,graph,core,walk,pseudo,xrefs,palette,drone').split(','));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const [VW, VH] = (process.env.SIZE ?? '1600x900').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}]`, m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms: number) => page.waitForTimeout(ms);
const shot = async (name: string) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};
const key = (k: string) => page.keyboard.press(k);
const palette = async (q: string) => {
  await key('Control+k');
  await wait(400);
  await page.keyboard.type(q, { delay: 10 });
  await wait(400);
  await key('Enter');
};

await page.goto(`${url}/?open=${encodeURIComponent(bin)}&auto=1`);
await page.waitForFunction(() => document.querySelector('.hud .view')?.textContent?.includes('CITY'), null, { timeout: 180_000 });
await wait(9000);
if (steps.has('city')) await shot('01-city');

await palette(FN);
await wait(5000);
if (steps.has('focus')) await shot('02-focus');
if (steps.has('depth')) {
  await key('2');
  await wait(2500);
  await shot('03-focus-depth2');
  await key('1');
}
if (steps.has('graph')) {
  await key('c');
  await wait(7000);
  await shot('04-constellation');
  await key('Escape');
  await wait(4000);
}
if (steps.has('core')) {
  const t0 = Date.now();
  await key('Enter');
  await page.waitForFunction(() => document.querySelector('.hud .view')?.textContent?.includes('CORE'), null, { timeout: 120_000 });
  console.log('core view after', Date.now() - t0, 'ms');
  await wait(Number(process.env.CORE_WAIT ?? 9000));
  await shot('05-core');
  if (process.env.ZOOM) {
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, -400);
      await wait(250);
    }
    await wait(4000);
    await shot('05b-core-zoom');
  }
}
if (steps.has('walk')) {
  await key('ArrowDown');
  await wait(1800);
  await key('ArrowRight');
  await wait(2500);
  await shot('06-walk');
}
if (steps.has('pseudo')) {
  await page.click('.ins-tab[data-tab="pseudo"]');
  await wait(2500);
  await shot('07-pseudo');
}
if (steps.has('xrefs')) {
  await page.click('.ins-tab[data-tab="xrefs"]');
  await wait(1500);
  await shot('08-xrefs');
  await page.click('.ins-tab[data-tab="disasm"]');
}
if (steps.has('palette')) {
  await key('Escape');
  await wait(4000);
  await key('Control+k');
  await wait(300);
  await page.keyboard.type('clock', { delay: 20 });
  await wait(600);
  await shot('09-palette');
  await key('Escape');
}
if (steps.has('drone')) {
  await key('f');
  await wait(500);
  await page.keyboard.down('w');
  await wait(2500);
  await page.keyboard.up('w');
  await wait(800);
  await shot('10-drone');
}
await browser.close();
