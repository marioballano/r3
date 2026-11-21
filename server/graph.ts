// Builds an exact call graph (with call-site addresses) and function→string
// references from r2's global xref table, attributing each xref to the function
// whose *basic blocks* contain the referencing instruction.

export interface AflEntry {
  addr: number;
  name: string;
  size: number;
  realsz?: number;
  nbbs?: number;
  cc?: number;
  ninstrs?: number;
  indegree?: number;
  outdegree?: number;
  nargs?: number;
  nlocals?: number;
  stackframe?: number;
  minaddr?: number;
  maxaddr?: number;
  signature?: string;
}

export interface XrefEntry {
  from: number;
  addr: number;
  type: string;
}

export interface FnOut {
  addr: number;
  name: string;
  size: number;
  nbbs: number;
  cc: number;
  ninstrs: number;
  indeg: number;
  outdeg: number;
  nargs: number;
  nlocals: number;
  stack: number;
  imp: boolean;
  min: number;
  max: number;
  sig: string;
}

export interface GraphOut {
  functions: FnOut[];
  /** [callerIdx, calleeIdx, callSiteAddr] */
  calls: [number, number, number][];
  /** [fnIdx, siteAddr, stringVaddr] */
  strRefs: [number, number, number][];
  /** flat [fnIdx, blockAddr, blockSize, …] — exact basic-block ownership */
  blocks: number[];
  /** how many xrefs could be attributed to a function via basic blocks vs bounds fallback */
  stats: { bbAttributed: number; boundsAttributed: number; unattributed: number };
}

interface Interval {
  start: number;
  end: number;
  fn: number;
}

/** `afbj @@F` prints one JSON array per function, in the same order as `aflj`. */
export function parseBlocks(text: string): { addr: number; size: number }[][] {
  const out: { addr: number; size: number }[][] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('[')) continue;
    try {
      const arr = JSON.parse(t) as { addr: number; size: number }[];
      out.push(arr.map((b) => ({ addr: b.addr, size: b.size })));
    } catch {
      out.push([]);
    }
  }
  return out;
}

export function buildGraph(afl: AflEntry[], blocks: { addr: number; size: number }[][], xrefs: XrefEntry[], stringAddrs: Set<number>): GraphOut {
  const functions: FnOut[] = afl.map((f) => ({
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
    min: f.minaddr ?? f.addr,
    max: f.maxaddr ?? f.addr + (f.size || 1),
    sig: f.signature ?? '',
  }));

  // Basic-block intervals. `afbj @@F` does not iterate in `aflj` order, so identify
  // each block list by the function entry it contains (disambiguated by bounds).
  const entryIdx = new Map<number, number>();
  functions.forEach((f, i) => entryIdx.set(f.addr, i));
  const bbIv: Interval[] = [];
  const boundIv: Interval[] = [];
  const owned = new Set<number>();
  for (const bl of blocks) {
    if (!bl.length) continue;
    const lo = Math.min(...bl.map((b) => b.addr));
    const hi = Math.max(...bl.map((b) => b.addr + b.size));
    const cands = bl.map((b) => entryIdx.get(b.addr)).filter((i): i is number => i !== undefined && !owned.has(i));
    const fit = cands.filter((i) => functions[i].min <= lo && functions[i].max >= hi - 1);
    const fn = fit[0] ?? (cands.length === 1 ? cands[0] : undefined);
    if (fn === undefined) continue;
    owned.add(fn);
    for (const b of bl) bbIv.push({ start: b.addr, end: b.addr + Math.max(1, b.size), fn });
  }
  functions.forEach((f, i) => {
    if (!owned.has(i)) boundIv.push({ start: f.min, end: Math.max(f.min + 1, f.max), fn: i });
  });
  bbIv.sort((a, b) => a.start - b.start);
  boundIv.sort((a, b) => a.start - b.start || b.end - a.end);

  const findBB = (addr: number): number => {
    let lo = 0;
    let hi = bbIv.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bbIv[mid].start <= addr) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // blocks may overlap (shared code): scan back a little for a containing one
    for (let i = best; i >= 0 && i > best - 8; i--) if (addr < bbIv[i].end && addr >= bbIv[i].start) return bbIv[i].fn;
    return -1;
  };
  const findBounds = (addr: number): number => {
    let found = -1;
    let span = Infinity;
    for (const iv of boundIv) {
      if (iv.start > addr) break;
      if (addr < iv.end && iv.end - iv.start < span) {
        found = iv.fn;
        span = iv.end - iv.start;
      }
    }
    return found;
  };

  const stats = { bbAttributed: 0, boundsAttributed: 0, unattributed: 0 };
  const owner = (addr: number): number => {
    const a = findBB(addr);
    if (a >= 0) {
      stats.bbAttributed++;
      return a;
    }
    const b = findBounds(addr);
    if (b >= 0) stats.boundsAttributed++;
    else stats.unattributed++;
    return b;
  };

  const calls: [number, number, number][] = [];
  const strRefs: [number, number, number][] = [];
  const seenCall = new Set<string>();
  for (const x of xrefs) {
    if (x.type === 'CALL') {
      const callee = entryIdx.get(x.addr);
      if (callee === undefined) continue; // call into the middle of something unknown
      const caller = owner(x.from);
      if (caller < 0) continue;
      const k = `${x.from}>${x.addr}`;
      if (seenCall.has(k)) continue;
      seenCall.add(k);
      calls.push([caller, callee, x.from]);
    } else if (x.type === 'STRN' || (x.type === 'DATA' && stringAddrs.has(x.addr))) {
      if (!stringAddrs.has(x.addr)) continue;
      const fn = owner(x.from);
      if (fn >= 0) strRefs.push([fn, x.from, x.addr]);
    }
  }
  calls.sort((a, b) => a[2] - b[2]);
  const flat: number[] = [];
  for (const iv of bbIv) flat.push(iv.fn, iv.start, iv.end - iv.start);
  return { functions, calls, strRefs, blocks: flat, stats };
}
