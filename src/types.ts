export interface Section {
  name: string;
  size: number;
  vsize: number;
  type?: string;
  perm: string;
  paddr: number;
  vaddr: number;
}

export interface StringEntry {
  vaddr: number;
  paddr: number;
  string: string;
  section?: string;
  type?: string;
  length?: number;
}

export interface ImportEntry {
  name: string;
  type?: string;
  bind?: string;
  plt?: number;
  libname?: string;
}

export interface SymbolEntry {
  name: string;
  realname?: string;
  vaddr: number;
  size: number;
  type?: string;
}

export interface EntropyData {
  blocksize: number;
  address: number;
  size: number;
  entropy: { addr: number; value: number }[];
}

export interface BinInfo {
  core?: { file?: string; size?: number; format?: string; type?: string; humansz?: string };
  bin?: {
    arch?: string;
    bits?: number;
    os?: string;
    lang?: string;
    machine?: string;
    class?: string;
    endian?: string;
    stripped?: boolean;
    canary?: boolean;
    nx?: boolean;
    pic?: boolean;
    compiler?: string;
  };
}

export interface InfoMsg {
  t: 'info';
  path: string;
  size: number;
  format: string | null;
  hash: string;
  info: BinInfo | null;
  sections: Section[];
  entropy: EntropyData | null;
  strings: StringEntry[];
  imports: ImportEntry[];
  symbols: SymbolEntry[];
  entries: { vaddr: number; type?: string }[];
}

export interface Fn {
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
  /** lowest / highest address covered by the function's basic blocks */
  min: number;
  max: number;
  sig: string;
}

export interface FunctionsMsg {
  t: 'functions';
  functions: Fn[];
  /** exact call sites: [callerIdx, calleeIdx, siteAddr] */
  calls: [number, number, number][];
  /** string references: [fnIdx, siteAddr, stringVaddr] */
  strRefs: [number, number, number][];
  /** tail calls (jump into another function's entry): [fromIdx, toIdx, siteAddr] */
  tails: [number, number, number][];
  /** function address taken by code in another function: [fromIdx, toIdx, siteAddr] */
  refs: [number, number, number][];
  /** flat [fnIdx, blockAddr, blockSize, …] */
  blocks: number[];
  seek: number | null;
}

export interface Op {
  addr: number;
  size?: number;
  disasm?: string;
  opcode?: string;
  type?: string;
  bytes?: string;
  esil?: string;
  jump?: number;
  fail?: number;
  flags?: string[];
  comment?: string;
  refs?: { addr: number; type: string }[];
  xrefs?: { addr: number; type: string }[];
  ptr?: number;
  val?: number;
}

export interface InspectMsg {
  info: {
    name: string;
    addr: number;
    size: number;
    realsz?: number;
    cc: number;
    nbbs: number;
    ninstrs: number;
    edges: number;
    stackframe: number;
    signature?: string;
    nargs: number;
    nlocals: number;
    calltype?: string;
    minaddr?: number;
    maxaddr?: number;
  } | null;
  vars: { reg?: { name: string; type: string; ref?: unknown }[]; stack?: { name: string; type: string; ref?: { base?: string; offset?: number } }[]; bp?: unknown[]; sp?: unknown[] } | null;
  ops: Op[];
}

export interface Block {
  addr: number;
  size: number;
  jump?: number;
  fail?: number;
  switchop?: { cases?: { jump: number; value?: number }[] };
  ops: Op[];
}

export interface FnGraph {
  name: string;
  addr: number;
  ninstr: number;
  size: number;
  blocks: Block[];
}

export const hex = (n: number | null | undefined, pad = 8) =>
  n === null || n === undefined || !Number.isFinite(n) ? '0x????????' : '0x' + n.toString(16).padStart(pad, '0');

export const humanSize = (n: number) =>
  n < 1024 ? `${n}B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)}K` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)}M` : `${(n / (1 << 30)).toFixed(2)}G`;
