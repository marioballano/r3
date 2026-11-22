// Select the newest published official WASI reactor, verify GitHub's SHA-256 digest,
// and cache it. A regular build is offline once cached; update-wasm refreshes it.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const directory = new URL('build/wasm/', import.meta.url);
await mkdir(directory, { recursive: true });
if (!process.argv.includes('--update')) {
  try {
    const manifest = JSON.parse(await readFile(new URL('release.json', directory), 'utf8'));
    const bytes = await readFile(new URL('radare2.wasm', directory));
    if (createHash('sha256').update(bytes).digest('hex') === manifest.wasmSHA256) process.exit(0);
  } catch { /* fetch a fresh verified copy */ }
}
async function get(url) {
  // curl honors system proxies and follows GitHub release redirects.
  return execFileSync('curl', ['-fLsS', '--retry', '2', '--connect-timeout', '20', '--max-time', '180', url], { maxBuffer: 100 * 1024 * 1024 });
}
const releases = JSON.parse(await get('https://api.github.com/repos/radareorg/radare2/releases?per_page=100'));
const candidates = releases.filter(r => !r.draft && !r.prerelease)
  .sort((a, b) => b.published_at.localeCompare(a.published_at));
const release = candidates.find(r => r.assets.some(a => /-wasi-api\.zip$/.test(a.name)));
if (!release) throw new Error('No official radare2 WASI API release found');
const asset = release.assets.find(a => /-wasi-api\.zip$/.test(a.name));
if (!asset.digest?.startsWith('sha256:')) throw new Error('Release has no SHA-256 digest');
console.log(`Fetching ${asset.name}`);
const zip = await get(asset.browser_download_url);
const digest = createHash('sha256').update(zip).digest('hex');
if (`sha256:${digest}` !== asset.digest) throw new Error('radare2 release checksum mismatch');
const archive = new URL('download.zip', directory);
await writeFile(archive, zip);
try {
  const names = execFileSync('unzip', ['-Z1', archive.pathname], { encoding: 'utf8' }).split('\n');
  const name = names.find(n => /^[^/]+\/radare2\.wasm$/.test(n));
  if (!name) throw new Error('Release is missing radare2.wasm');
  const wasm = execFileSync('unzip', ['-p', archive.pathname, name], { maxBuffer: 100 * 1024 * 1024 });
  if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Invalid WASM module');
  const manifest = { version: release.tag_name, url: asset.browser_download_url, archiveSHA256: digest,
    wasmSHA256: createHash('sha256').update(wasm).digest('hex') };
  await writeFile(new URL('radare2.wasm.tmp', directory), wasm);
  await rename(new URL('radare2.wasm.tmp', directory), new URL('radare2.wasm', directory));
  await writeFile(new URL('release.json', directory), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Bundling radare2 ${release.tag_name}`);
} finally { await rm(archive, { force: true }); }
