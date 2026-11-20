// One r2 session per websocket connection.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { WebSocket } from 'ws';
import { R2Pipe } from './r2pipe.js';
import { resolveBinary } from './fsbrowse.js';

type Msg =
  | { t: 'open'; path: string }
  | { t: 'cmd'; id: number; cmd: string; cols?: number }
  | { t: 'query'; id: number; cmd: string }
  | { t: 'fn'; id: number; addr: number };

const MAX_OUT = 512 * 1024;
const MAX_STRINGS = 1200;
const MAX_SYMBOLS = 3000;
const AAA_LIMIT = 4 * 1024 * 1024;

interface AflEntry {
  addr: number;
  name: string;
  size: number;
  realsz?: number;
  nbbs?: number;
  cc?: number;
  ninstrs?: number;
  indegree?: number;
  outdegree?: number;
  type?: string;
  nargs?: number;
  nlocals?: number;
  stackframe?: number;
}

function hashFile(file: string, size: number): Promise<string> {
  return new Promise((resolve) => {
    const h = createHash('sha256');
    if (size > 64 * 1024 * 1024) {
      h.update(file + ':' + size);
      return resolve(h.digest('hex'));
    }
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(createHash('sha256').update(file).digest('hex')));
  });
}

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

export class Session {
  private r2: R2Pipe | null = null;
  private closed = false;

  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: Msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handle(msg).catch((e: Error) => this.send({ t: 'error', msg: e.message }));
    });
    ws.on('close', () => this.close());
  }

  private send(obj: unknown) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private status(msg: string, progress: number) {
    this.send({ t: 'status', msg, progress });
  }

  close() {
    this.closed = true;
    this.r2?.kill();
    this.r2 = null;
  }

  private async handle(msg: Msg) {
    switch (msg.t) {
      case 'open':
        return this.open(msg.path);
      case 'cmd':
        return this.userCmd(msg.id, msg.cmd, msg.cols);
      case 'query': {
        const r2 = this.need();
        const data = await r2.cmdj(msg.cmd, 20_000);
        return this.send({ t: 'query', id: msg.id, data });
      }
      case 'fn': {
        const r2 = this.need();
        const g = await r2.cmdj<unknown[]>(`agfj @ ${Number(msg.addr)}`, 20_000);
        return this.send({ t: 'fn', id: msg.id, addr: msg.addr, graph: Array.isArray(g) ? g[0] ?? null : null });
      }
    }
  }

  private need(): R2Pipe {
    if (!this.r2 || !this.r2.alive) throw new Error('no binary loaded');
    return this.r2;
  }

  private async userCmd(id: number, cmd: string, cols = 120) {
    const r2 = this.need();
    const c = cmd.trim();
    // Commands that would quit r2 or block on an interactive visual mode.
    if (/^(q|V|!|=!|#!)/.test(c) && !/^V?V$/.test(c)) {
      return this.send({ t: 'out', id, text: `\x1b[38;5;197m[r3] '${c.split(' ')[0]}' is disabled in the 3D shell\x1b[0m\n`, seek: null, err: true });
    }
    const visual = /^V?V$/.test(c);
    // Queue everything synchronously so nothing interleaves with the colour toggle.
    const [, out, , s] = await Promise.all([
      r2.cmd(`e scr.color=3;e scr.columns=${Math.max(40, Math.min(300, cols | 0))}`),
      visual ? Promise.resolve('') : r2.cmd(c, 60_000),
      r2.cmd('e scr.color=0'),
      r2.cmd('s'),
    ]);
    let text = out;
    if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n\x1b[33m[r3] output truncated (${text.length} bytes)\x1b[0m\n`;
    const seek = parseInt(s.trim(), 16);
    this.send({ t: 'out', id, text, seek: Number.isFinite(seek) ? seek : null });
  }

  private async open(input: string) {
    this.r2?.kill();
    const bin = await resolveBinary(input);
    this.status(`spawning r2 :: ${bin.path}`, 0.02);
    const r2 = new R2Pipe(bin.path, ['-e', 'bin.relocs.apply=true', '-e', 'scr.color=0', '-e', 'scr.interactive=false', '-e', 'scr.utf8=true', '-e', 'scr.prompt=false']);
    this.r2 = r2;
    await r2.waitReady();
    if (this.closed) return;

    const hash = await hashFile(bin.path, bin.size);
    this.status('reading headers', 0.08);
    const info = await r2.cmdj('ij');
    this.status('mapping sections', 0.12);
    const sections = (await r2.cmdj<unknown[]>('iSj')) ?? [];
    this.status('measuring entropy', 0.16);
    const entropy = await r2.cmdj('p=ej 256 @ 0');
    this.status('harvesting strings', 0.2);
    const strings = sample((await r2.cmdj<unknown[]>('izj', 30_000)) ?? [], MAX_STRINGS);
    this.status('resolving imports', 0.24);
    const imports = (await r2.cmdj<unknown[]>('iij')) ?? [];
    const symbols = sample((await r2.cmdj<unknown[]>('isj')) ?? [], MAX_SYMBOLS);
    const entries = (await r2.cmdj<unknown[]>('iej')) ?? [];

    // Lock it down before handing the shell to the user: no shell escapes,
    // no reading other files, no writing.
    await r2.cmd('e cfg.sandbox=true');

    this.send({ t: 'info', path: bin.path, size: bin.size, format: bin.format, hash, info, sections, entropy, strings, imports, symbols, entries });

    const deep = bin.size <= AAA_LIMIT;
    this.status(deep ? 'deep analysis :: aaa' : 'analysis :: aa', 0.3);
    // Fake-but-honest progress ticker while r2 crunches.
    let p = 0.3;
    const tick = setInterval(() => {
      p += (0.92 - p) * 0.05;
      this.status(deep ? 'deep analysis :: aaa' : 'analysis :: aa', p);
    }, 250);
    try {
      await r2.cmd(deep ? 'aaa' : 'aa', 10 * 60_000);
    } finally {
      clearInterval(tick);
    }
    if (this.closed) return;
    this.status('enumerating functions', 0.94);
    const afl = (await r2.cmdj<AflEntry[]>('aflj', 60_000)) ?? [];
    const functions = afl.map((f) => ({
      addr: f.addr,
      name: f.name,
      size: f.realsz ?? f.size,
      nbbs: f.nbbs ?? 1,
      cc: f.cc ?? 1,
      ninstrs: f.ninstrs ?? 0,
      indeg: f.indegree ?? 0,
      outdeg: f.outdegree ?? 0,
      nargs: f.nargs ?? 0,
      nlocals: f.nlocals ?? 0,
      stack: f.stackframe ?? 0,
      imp: f.name.startsWith('sym.imp.') || f.name.startsWith('imp.'),
    }));
    this.status('tracing call graph', 0.97);
    const cg = (await r2.cmdj<{ name: string; imports?: string[] }[]>('agCj', 60_000)) ?? [];
    const idx = new Map(functions.map((f, i) => [f.name, i]));
    const calls: [number, number][] = [];
    for (const n of cg) {
      const a = idx.get(n.name);
      if (a === undefined) continue;
      for (const callee of n.imports ?? []) {
        const b = idx.get(callee);
        if (b !== undefined && b !== a) calls.push([a, b]);
      }
    }
    const seek = parseInt((await r2.cmd('s')).trim(), 16);
    this.send({ t: 'functions', functions, calls, seek });
    this.status('online', 1);
  }
}
