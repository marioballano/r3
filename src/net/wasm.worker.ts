import { measureEntropy } from './entropy';
import { WasmCore } from './wasm-runtime';
let core: WasmCore | undefined;
self.onmessage = async ({ data: m }) => {
  try {
    let result = '';
    if (m.t === 'init') {
      const response = await fetch(m.url);
      if (!response.ok) throw new Error(`Cannot load bundled radare2.wasm (${response.status})`);
      const bytes = new Uint8Array(m.bytes);
      core = await WasmCore.create(await response.arrayBuffer(), bytes);
      result = JSON.stringify(measureEntropy(bytes));
    } else {
      if (!core) throw new Error('WASM core not ready');
      result = core.cmd(m.cmd);
    }
    self.postMessage({ id: m.id, result });
  } catch (e) { self.postMessage({ id: m.id, error: (e as Error).message }); }
};
