// Read-only host filesystem browser. Lists a directory and classifies files by
// magic bytes so the picker can highlight things radare2 can open.
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';

export type BinFormat = 'elf' | 'pe' | 'macho' | 'wasm' | 'dex' | 'java' | null;

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'other';
  size: number;
  exec: boolean;
  format: BinFormat;
  link?: string;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
}

const MAX_ENTRIES = 4000;

export async function sniff(file: string): Promise<BinFormat> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, fsc.O_RDONLY | fsc.O_NONBLOCK);
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    if (bytesRead < 4) return null;
    const m = buf.readUInt32BE(0);
    if (m === 0x7f454c46) return 'elf';
    if (buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(m)) return 'macho';
    if (m === 0xcafebabe) return bytesRead >= 8 && buf.readUInt16BE(6) > 40 ? 'java' : 'macho';
    if (m === 0x0061736d) return 'wasm';
    if (buf.toString('latin1', 0, 4) === 'dex\n') return 'dex';
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function listDir(input: string | undefined): Promise<Listing> {
  const target = path.resolve(input && input.trim() ? input : '/usr/bin');
  const real = await fs.realpath(target);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new Error('not a directory');
  const names = (await fs.readdir(real)).sort((a, b) => a.localeCompare(b));
  const truncated = names.length > MAX_ENTRIES;
  const entries: Entry[] = [];
  // stat in parallel batches; sniff only regular files
  const batch = 64;
  const slice = names.slice(0, MAX_ENTRIES);
  for (let i = 0; i < slice.length; i += batch) {
    const part = await Promise.all(
      slice.slice(i, i + batch).map(async (name): Promise<Entry | null> => {
        const p = path.join(real, name);
        try {
          const lst = await fs.lstat(p);
          let link: string | undefined;
          let s = lst;
          if (lst.isSymbolicLink()) {
            link = await fs.readlink(p).catch(() => undefined);
            s = await fs.stat(p);
          }
          if (s.isDirectory()) return { name, path: p, type: 'dir', size: 0, exec: false, format: null, link };
          if (!s.isFile()) return { name, path: p, type: 'other', size: s.size, exec: false, format: null, link };
          const exec = (s.mode & 0o111) !== 0;
          const format = s.size >= 4 ? await sniff(p) : null;
          return { name, path: p, type: 'file', size: s.size, exec, format, link };
        } catch {
          return null;
        }
      }),
    );
    for (const e of part) if (e) entries.push(e);
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  const parent = real === '/' ? null : path.dirname(real);
  return { path: real, parent, entries, truncated };
}

/** Resolve and validate a file the user wants to open. */
export async function resolveBinary(input: string): Promise<{ path: string; size: number; format: BinFormat }> {
  const real = await fs.realpath(path.resolve(input));
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error('not a regular file');
  await fs.access(real, fsc.R_OK);
  return { path: real, size: st.size, format: await sniff(real) };
}
