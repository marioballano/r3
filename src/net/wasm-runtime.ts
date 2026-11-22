import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

type API = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  r_core_new(): number;
  r_core_cmd_str(core: number, cmd: number): number;
  r_core_free(core: number): void;
};

/** A WASI reactor with an in-memory filesystem containing only the selected binary. */
export class WasmCore {
  private constructor(private api: API, private core: number) {}
  static async create(wasm: BufferSource, bytes: Uint8Array): Promise<WasmCore> {
    const wasi = new WASI([], ['HOME=/', 'PWD=/', 'R2_NOPLUGINS=1'], [
      new OpenFile(new File([])), ConsoleStdout.lineBuffered(s => console.debug(s)),
      ConsoleStdout.lineBuffered(s => console.debug(s)),
      new PreopenDirectory('/', new Map([['binary', new File(bytes, { readonly: true })]])),
    ], { debug: false });
    const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
    const api = instance.exports as API;
    wasi.initialize({ exports: { memory: api.memory, _initialize: api._initialize as (() => void) | undefined } });
    const core = api.r_core_new();
    if (!core) throw new Error('radare2 WASM could not create a core');
    const r2 = new WasmCore(api, core);
    r2.cmd('e bin.relocs.apply=true');
    r2.cmd('o /binary');
    const info = JSON.parse(r2.cmd('ij'));
    if (!info?.core) { r2.close(); throw new Error('radare2 WASM could not open this binary'); }
    return r2;
  }
  cmd(text: string): string {
    if (!this.core) throw new Error('WASM core closed');
    const bytes = new TextEncoder().encode(text + '\0');
    const input = this.api.malloc(bytes.length);
    if (!input) throw new Error('WASM allocation failed');
    let output = 0;
    try {
      new Uint8Array(this.api.memory.buffer, input, bytes.length).set(bytes);
      output = this.api.r_core_cmd_str(this.core, input);
      if (!output) throw new Error('WASM command failed');
      const memory = new Uint8Array(this.api.memory.buffer);
      const end = memory.indexOf(0, output);
      if (end < 0) throw new Error('Invalid WASM command output');
      return new TextDecoder().decode(memory.subarray(output, end));
    } finally { this.api.free(output); this.api.free(input); }
  }
  close() { if (this.core) this.api.r_core_free(this.core); this.core = 0; }
}
