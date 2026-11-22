import type { EntropyData } from '../types';

/** Match r2's normalized Shannon entropy, using physical file offsets. */
export function measureEntropy(bytes: Uint8Array, samples = 256): EntropyData {
  const count = Math.min(samples, bytes.length);
  const blocksize = count ? Math.floor(bytes.length / count) : 0;
  const entropy: EntropyData['entropy'] = [];
  for (let i = 0; i < count; i++) {
    const addr = i * blocksize;
    const frequencies = new Uint32Array(256);
    for (let j = addr; j < addr + blocksize; j++) frequencies[bytes[j]]++;
    let bits = 0;
    for (const n of frequencies) if (n) { const p = n / blocksize; bits -= p * Math.log2(p); }
    const max = Math.log2(Math.min(blocksize, 256));
    entropy.push({ addr, value: max > 0 ? Math.floor(255 * bits / max) : 0 });
  }
  return { blocksize, address: 0, size: bytes.length, entropy };
}

export function validEntropy(value: unknown): value is EntropyData {
  if (!value || typeof value !== 'object') return false;
  const e = value as EntropyData;
  return Number.isFinite(e.address) && Number.isFinite(e.size) && Number.isFinite(e.blocksize) && Array.isArray(e.entropy)
    && e.entropy.every(x => Number.isFinite(x.addr) && Number.isFinite(x.value));
}
