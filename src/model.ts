// The binary's analysed structure, shared by every view and the Inspector.
// Built once from the server's exact (basic-block attributed) xref graph.
import type { Fn, FunctionsMsg, InfoMsg, StringEntry } from './types';

export interface CallSite {
  site: number; // address of the call instruction
  caller: number; // fn index
  callee: number; // fn index
}

export interface StrRef {
  fn: number;
  site: number;
  vaddr: number;
}

export type Role = 'focus' | 'caller' | 'callee' | 'both';

export interface Neighbour {
  hop: number;
  role: Role;
}

export class Model {
  fns: Fn[];
  info: InfoMsg;
  out: CallSite[][];
  in: CallSite[][];
  strOut: StrRef[][];
  strIn = new Map<number, StrRef[]>();
  strings = new Map<number, StringEntry>();
  private sorted: number[];
  /** basic blocks sorted by address: parallel arrays */
  private bbStart: Float64Array;
  private bbEnd: Float64Array;
  private bbFn: Int32Array;
  private byName = new Map<string, number>();
  readonly callCount: number;

  constructor(info: InfoMsg, msg: FunctionsMsg) {
    this.info = info;
    this.fns = msg.functions;
    const n = this.fns.length;
    this.out = Array.from({ length: n }, () => []);
    this.in = Array.from({ length: n }, () => []);
    this.strOut = Array.from({ length: n }, () => []);
    for (const [caller, callee, site] of msg.calls) {
      const c = { caller, callee, site };
      this.out[caller].push(c);
      this.in[callee].push(c);
    }
    this.callCount = msg.calls.length;
    for (const s of info.strings) this.strings.set(s.vaddr, s);
    for (const [fn, site, vaddr] of msg.strRefs) {
      const r = { fn, site, vaddr };
      this.strOut[fn].push(r);
      (this.strIn.get(vaddr) ?? this.strIn.set(vaddr, []).get(vaddr)!).push(r);
    }
    this.fns.forEach((f, i) => this.byName.set(f.name, i));
    this.sorted = this.fns.map((_, i) => i).sort((a, b) => this.fns[a].addr - this.fns[b].addr);
    const nb = Math.floor((msg.blocks?.length ?? 0) / 3);
    const order = Array.from({ length: nb }, (_, i) => i).sort((a, b) => msg.blocks[a * 3 + 1] - msg.blocks[b * 3 + 1]);
    this.bbStart = new Float64Array(nb);
    this.bbEnd = new Float64Array(nb);
    this.bbFn = new Int32Array(nb);
    order.forEach((k, i) => {
      this.bbFn[i] = msg.blocks[k * 3];
      this.bbStart[i] = msg.blocks[k * 3 + 1];
      this.bbEnd[i] = msg.blocks[k * 3 + 1] + Math.max(1, msg.blocks[k * 3 + 2]);
    });
  }

  index(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** Function whose entry is exactly `addr`. */
  entryAt(addr: number): number {
    const i = this.lowerBound(addr);
    return i >= 0 && this.fns[this.sorted[i]].addr === addr ? this.sorted[i] : -1;
  }

  /**
   * Function owning `addr`: exact via its basic blocks (the same attribution the
   * server uses for xrefs). A function entry always wins over a block of another
   * function that happens to overlap it (shared tails). Falls back to the closest
   * preceding entry whose range covers the address.
   */
  fnAt(addr: number): number {
    const e = this.entryAt(addr);
    if (e >= 0) return e;
    let lo = 0;
    let hi = this.bbStart.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bbStart[mid] <= addr) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = k; i >= 0 && i > k - 16; i--) if (addr >= this.bbStart[i] && addr < this.bbEnd[i]) return this.bbFn[i];
    for (let i = this.lowerBound(addr), n = 0; i >= 0 && n < 64; i--, n++) {
      const f = this.fns[this.sorted[i]];
      if (addr >= f.min && addr <= f.max) return this.sorted[i];
    }
    return -1;
  }

  private lowerBound(addr: number): number {
    let lo = 0;
    let hi = this.sorted.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.fns[this.sorted[mid]].addr <= addr) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Position of an address inside its function: 0 at entry … 1 at the last byte. */
  frac(fi: number, addr: number): number {
    const f = this.fns[fi];
    const span = Math.max(1, f.max - f.min);
    return Math.max(0, Math.min(1, (addr - f.min) / span));
  }

  /** Distinct callers / callees (by function). */
  callers(fi: number): number[] {
    return [...new Set(this.in[fi].map((c) => c.caller))];
  }

  callees(fi: number): number[] {
    return [...new Set(this.out[fi].map((c) => c.callee))];
  }

  /**
   * Breadth-first neighbourhood up to `depth` hops, walking callers upward and
   * callees downward separately (so "caller of a callee" is not a caller).
   */
  neighbourhood(fi: number, depth: number, cap = 600): Map<number, Neighbour> {
    const res = new Map<number, Neighbour>([[fi, { hop: 0, role: 'focus' }]]);
    const walk = (dir: 'caller' | 'callee') => {
      let frontier = [fi];
      for (let hop = 1; hop <= depth && frontier.length && res.size < cap; hop++) {
        const next: number[] = [];
        for (const f of frontier) {
          for (const g of dir === 'caller' ? this.callers(f) : this.callees(f)) {
            const cur = res.get(g);
            if (cur) {
              if (cur.role !== 'focus' && cur.role !== dir) cur.role = 'both';
              continue;
            }
            if (res.size >= cap) break;
            res.set(g, { hop, role: dir });
            next.push(g);
          }
        }
        frontier = next;
      }
    };
    walk('caller');
    walk('callee');
    return res;
  }

  fnName(fi: number) {
    return this.fns[fi]?.name ?? '?';
  }
}
