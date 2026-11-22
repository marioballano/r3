// Optional Node r2pipe backend. The analysis/inspection protocol is shared with WASM.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { WebSocket } from 'ws';
import { R2Pipe } from './r2pipe.js';
import { resolveBinary } from './fsbrowse.js';
import { CommandSession } from '../src/net/session.js';
import type { Analysis } from '../src/net/client.js';

function hashFile(file: string, size: number): Promise<string> {
  return new Promise(resolve => {
    const hash = createHash('sha256');
    if (size > 64 * 1024 * 1024) return resolve(hash.update(file + ':' + size).digest('hex'));
    createReadStream(file).on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', () => resolve(createHash('sha256').update(file).digest('hex')));
  });
}

export class Session {
  private engine: CommandSession | null = null;
  private r2: R2Pipe | null = null;
  private generation = 0;
  private closed = false;
  constructor(private ws: WebSocket) {
    ws.on('message', raw => {
      let msg: Record<string, any>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handle(msg).catch((e: Error) => this.send(msg.id === undefined
        ? { t: 'error', msg: e.message } : { t: 'failure', id: msg.id, msg: e.message }));
    });
    ws.on('close', () => this.close());
  }
  private send(obj: unknown) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj)); }
  close() { this.closed = true; this.generation++; this.engine?.close(); this.r2?.kill(); }
  private async handle(msg: Record<string, any>) {
    if (msg.t === 'open') return this.open(msg.path, msg.analysis);
    const r2 = this.engine;
    if (!r2) throw new Error('no binary loaded');
    switch (msg.t) {
      case 'cmd': return this.send({ ...await r2.cmd(msg.cmd, msg.cols), id: msg.id });
      case 'query': return this.send({ t: 'query', id: msg.id, data: await r2.query(msg.cmd) });
      case 'fn': return this.send({ t: 'fn', id: msg.id, graph: await r2.fn(msg.addr) });
      case 'inspect': return this.send({ t: 'inspect', id: msg.id, ...await r2.inspect(msg.addr) });
      case 'pdc': return this.send({ t: 'pdc', id: msg.id, text: await r2.pdc(msg.addr) });
    }
  }
  private async open(input: string, analysis: Analysis = 'auto') {
    const generation = ++this.generation;
    this.engine?.close(); this.engine = null; this.r2?.kill();
    const bin = await resolveBinary(input);
    if (this.closed || generation !== this.generation) return;
    this.send({ t: 'status', msg: `spawning r2 :: ${bin.path}`, progress: 0.02 });
    const r2 = this.r2 = new R2Pipe(bin.path, ['-e', 'bin.relocs.apply=true']);
    await r2.waitReady();
    const hash = await hashFile(bin.path, bin.size);
    if (this.closed || generation !== this.generation) { r2.kill(); return; }
    const engine = this.engine = new CommandSession({ cmd: (c, timeout) => r2.cmd(c, timeout), close: () => r2.kill() }, { ...bin, hash }, true);
    engine.on = {
      status: (msg, progress) => this.send({ t: 'status', msg, progress }),
      info: m => this.send(m), functions: m => this.send(m),
    };
    await engine.open(bin.path, ['auto', 'none', 'aa', 'aaa'].includes(analysis) ? analysis : 'auto');
  }
}
