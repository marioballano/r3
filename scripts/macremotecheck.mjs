// Test the native HTTP bridge against a real r2 server, including the rendered city.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const origin = `http://127.0.0.1:${port}`;
const r2 = spawn(process.env.R2 ?? 'r2', ['-N', '-q', '-e', 'http.sandbox=false', '-e', 'http.bind=127.0.0.1', '-e', `http.port=${port}`, '-e', `http.maxport=${port}`, '-c', 'aa', '-c', '=h', '/bin/ls'], { stdio: 'ignore' });
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      const response = execFileSync('curl', ['-fsS', '--max-time', '1', '--data-raw', '?v 1+2', `${origin}/cmd/`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (response.trim() === '0x3') { ready = true; break; }
    } catch { /* server is still starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('r2 HTTP server did not start');
  const child = spawn(resolve('app/mac/build/ui-test'), [resolve('app/mac/build/r3.app/Contents/Resources/webui'), origin], { cwd: resolve('app/mac'), stdio: 'inherit' });
  const { code, signal } = await new Promise((r, reject) => { child.on('exit', (code, signal) => r({ code, signal })); child.on('error', reject); });
  if (code !== 0) throw new Error(`Native remote test failed (${code ?? signal})`);
} finally { r2.kill(); }
