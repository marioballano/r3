// r3 server: host filesystem browser + one radare2 process per websocket.
import express from 'express';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { listDir } from './fsbrowse.js';
import { Session } from './session.js';

// R3_LAN=1 opens r3 to the network (a headset on Wi-Fi); an explicit R3_HOST still wins
const HOST = process.env.R3_HOST ?? (process.env.R3_LAN ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.R3_PORT ?? 3133);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = express();

app.get('/api/r2', (_req, res) => {
  execFile('r2', ['-v'], { timeout: 5000 }, (err, stdout) => {
    if (err) return res.json({ ok: false, error: 'radare2 (r2) not found in PATH' });
    res.json({ ok: true, version: stdout.split('\n')[0].trim(), home: os.homedir() });
  });
});

app.get('/api/ls', async (req, res) => {
  try {
    res.json(await listDir(typeof req.query.path === 'string' ? req.query.path : undefined));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

const dist = path.join(root, 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
wss.on('connection', (ws) => new Session(ws));

server.listen(PORT, HOST, () => {
  console.log(`\x1b[35m[r3]\x1b[0m listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of wss.clients) c.terminate();
    process.exit(0);
  });
}
