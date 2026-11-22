// Analysis and inspection use only the command interface: no Node or HTTP dependency.
import { validEntropy } from './entropy';
import type { BinInfo, FnGraph, InfoMsg, InspectMsg } from '../types';
import { buildGraph, parseBlocks, type AflEntry, type XrefEntry } from './graph';
import type { Analysis, CommandTransport, Handlers, OutMsg, R2Client, Target } from './client';

const sample = <T>(a: T[], n: number): T[] => a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor(i * a.length / n)]);
const clipped = (s: string) => s.length > 512 * 1024 ? s.slice(0, 512 * 1024) + '\n[r3] output truncated\n' : s;

export class CommandSession implements R2Client {
  on: Partial<Handlers> = {};
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private transport: CommandTransport, private target: Target, private lockSandbox = false) {}

  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error('Session closed');
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async json<T>(cmd: string): Promise<T | null> {
    const out = await this.transport.cmd(cmd, 120_000);
    try { return JSON.parse(out) as T; } catch { return null; }
  }
  async open(_path: string, analysis: Analysis = 'auto') {
    const status = (s: string, p: number) => {
      if (this.closed) throw new Error('Session closed');
      this.on.status?.(s, p);
    };
    await this.transaction(async () => {
      await this.transport.cmd('e scr.color=0;e scr.interactive=false;e scr.utf8=true;e scr.prompt=false');
      status('reading headers', 0.08);
      const info = await this.json<BinInfo>('ij');
      const size = this.target.size || info?.core?.size || 0;
      status('mapping sections', 0.12);
      const sections = await this.json<InfoMsg['sections']>('iSj') ?? [];
      status('measuring entropy', 0.16);
      const rawEntropy = this.target.entropy ?? await this.json<unknown>('p=ej 256 @ 0 @e:zoom.in=raw,io.va=false');
      const entropy = validEntropy(rawEntropy) ? rawEntropy : null;
      status('harvesting strings', 0.2);
      const strings = sample(await this.json<InfoMsg['strings']>('izj') ?? [], 20000)
        .map(x => ({ ...x, string: x.string?.length > 200 ? x.string.slice(0, 200) + '…' : x.string }));
      const imports = await this.json<InfoMsg['imports']>('iij') ?? [];
      const symbols = sample(await this.json<InfoMsg['symbols']>('isj') ?? [], 3000);
      const entries = await this.json<InfoMsg['entries']>('iej') ?? [];
      if (this.lockSandbox) await this.transport.cmd('e cfg.sandbox=true');
      status('headers ready', 0.25);
      this.on.info?.({ t: 'info', ...this.target, size, format: this.target.format ?? info?.core?.format ?? null,
        info, sections, entropy, strings, imports, symbols, entries });
      const command = analysis === 'auto' ? (size <= 4 * 1024 * 1024 ? 'aaa' : 'aa') : analysis;
      if (command !== 'none') {
        status(`analysis :: ${command}`, 0.3);
        await this.transport.cmd(command, 10 * 60_000);
      }
      status('enumerating functions', 0.94);
      const afl = await this.json<AflEntry[]>('aflj') ?? [];
      status('mapping basic blocks', 0.95);
      const blocks = parseBlocks(await this.transport.cmd('afbj @@F', 120_000));
      status('tracing cross-references', 0.97);
      const xrefs = await this.json<XrefEntry[]>('axlj') ?? [];
      const graph = buildGraph(afl, blocks, xrefs, new Set(strings.map(x => x.vaddr)));
      const seek = parseInt((await this.transport.cmd('s')).trim(), 16);
      status('building city', 0.99);
      this.on.functions?.({ t: 'functions', ...graph, seek: Number.isFinite(seek) ? seek : null });
      status('online', 1);
    });
  }
  query<T = unknown>(cmd: string): Promise<T | null> { return this.transaction(() => this.json<T>(cmd)); }
  fn(addr: number): Promise<FnGraph | null> {
    return this.transaction(async () => (await this.json<FnGraph[]>(`agfj @ ${Number(addr)}`))?.[0] ?? null);
  }
  inspect(addr: number): Promise<InspectMsg> {
    return this.transaction(async () => {
      const a = Number(addr);
      const info = await this.json<unknown[]>(`afij @ ${a}`);
      const vars = await this.json<InspectMsg['vars']>(`afvj @ ${a}`);
      const dis = await this.json<{ ops?: InspectMsg['ops'] }>(`pdfj @ ${a}`);
      return { info: info?.[0] as InspectMsg['info'] ?? null, vars, ops: dis?.ops ?? [] };
    });
  }
  pdc(addr: number): Promise<string> {
    return this.transaction(async () => clipped(await this.transport.cmd(`pdc @ ${Number(addr)}`, 60_000)));
  }
  cmd(cmd: string, cols = 120): Promise<OutMsg> {
    return this.transaction(async () => {
      const c = cmd.replace(/[\r\n]+/g, ' ').trim();
      const visual = /^V?V$/.test(c);
      if (/^(q|V|!|=!|#!)/.test(c) && !visual)
        return { t: 'out', id: 0, text: `[r3] '${c.split(' ')[0]}' is disabled in the 3D shell\n`, seek: null, err: true };
      let text: string;
      await this.transport.cmd(`e scr.color=3;e scr.cols=${Math.max(40, Math.min(300, cols | 0))}`);
      try { text = visual ? '' : await this.transport.cmd(c, 60_000); }
      finally { await this.transport.cmd('e scr.color=0'); }
      const seek = parseInt((await this.transport.cmd('s')).trim(), 16);
      return { t: 'out', id: 0, text: clipped(text), seek: Number.isFinite(seek) ? seek : null };
    });
  }
  close() { this.closed = true; this.on = {}; this.transport.close(); }
}
