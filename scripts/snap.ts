// Dev helper: drive the app in headless Chromium (SwiftShader WebGL) and save screenshots.
// usage: npm run snap -- [binary] [outdir]     (needs `npm run dev` running)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const bin = process.argv[2] ?? '/usr/bin/grep';
const out = process.argv[3] ?? 'shots';
const url = process.env.R3_URL ?? 'http://127.0.0.1:5173';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 400));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const wait = (ms: number) => page.waitForTimeout(ms);
const shot = async (name: string) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};

const step = process.env.STEPS ?? 'boot,picker,city,close,tower,func,tour';
const steps = new Set(step.split(','));

if (steps.has('boot') || steps.has('picker')) {
  await page.goto(url);
  await wait(4000);
  if (steps.has('boot')) await shot('01-boot');
  await page.click('.jack');
  await wait(4500);
  if (steps.has('picker')) await shot('02-picker');
}

await page.goto(`${url}/?open=${encodeURIComponent(bin)}&auto=1`);
await page.waitForFunction(() => document.querySelector('.hud .view')?.textContent?.includes('CITY'), null, { timeout: 120_000 });
await wait(8000);
if (steps.has('city')) await shot('03-city');

if (steps.has('close')) {
  await page.keyboard.press('Escape');
  await page.mouse.move(800, 300);
  // zoom into the city
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -250);
    await wait(100);
  }
  await wait(2500);
  await shot('04-close');
}

const typeCmd = async (c: string) => {
  await page.keyboard.type(c, { delay: 15 });
  await page.keyboard.press('Enter');
};

if (steps.has('tower')) {
  // shell is auto-opened; seek to the biggest function
  await page.click('.term .xt');
  await typeCmd('afl~?');
  await wait(800);
  await typeCmd(`s ${process.env.FN ?? 'entry0'}`);
  await wait(3500);
  await shot('05-shell-seek');
}

if (steps.has('func')) {
  await typeCmd('pdf');
  await wait(6000);
  await shot('06-func');
  await page.keyboard.press('Escape'); // close shell
  await wait(1500);
  await shot('07-func-noshell');
  await page.keyboard.press('Escape'); // back to city
  await wait(4000);
  await shot('08-back');
}

if (steps.has('tour')) {
  await page.keyboard.press('t');
  await wait(6000);
  await shot('09-tour-a');
  await wait(8000);
  await shot('10-tour-b');
}

await browser.close();
