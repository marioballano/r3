import type { EntropyData } from '../types';
import type { Analysis, CommandTransport, R2Client } from './client';
import { CommandSession } from './session';
import WasmWorker from './wasm.worker?worker&inline';

export interface NativeConfig {
  mode: 'wasm' | 'pipe' | 'http'; path?: string; size?: number; endpoint?: string; analysis?: Analysis;
}
declare global {
  interface Window {
    __R3_NATIVE__?: NativeConfig;
    webkit?: { messageHandlers: { r3: { postMessage(message: unknown): Promise<unknown> } } };
  }
}
export const nativeConfig = () => window.__R3_NATIVE__;
export async function nativeRequest(action: string, extra: Record<string, unknown> = {}) {
  if (!window.webkit) throw new Error('Native bridge unavailable');
  return window.webkit.messageHandlers.r3.postMessage({ action, ...extra });
}

class WasmTransport implements CommandTransport {
  private worker = new WasmWorker();
  private next = 0;
  private waiting = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor() {
    this.worker.onmessage = ({ data: m }) => {
      const request = this.waiting.get(m.id);
      if (!request) return;
      this.waiting.delete(m.id); clearTimeout(request.timer);
      if (m.error) request.reject(new Error(m.error)); else request.resolve(m.result);
    };
    this.worker.onerror = e => this.fail(new Error(e.message || 'WASM worker failed'));
  }
  private fail(error: Error) {
    for (const r of this.waiting.values()) { clearTimeout(r.timer); r.reject(error); }
    this.waiting.clear(); this.worker.terminate();
  }
  private request(message: Record<string, unknown>, timeout: number, transfer: Transferable[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => this.fail(new Error('WASM command timed out; reopen the binary to retry')), timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }
  async init(bytes: ArrayBuffer) {
    return JSON.parse(await this.request({ t: 'init', bytes, url: new URL('wasm/radare2.wasm', document.baseURI).href }, 120_000, [bytes])) as EntropyData;
  }
  cmd(cmd: string, timeout = 60_000) { return this.request({ cmd }, timeout); }
  close() { this.fail(new Error('Session closed')); }
}

class NativeCommandTransport implements CommandTransport {
  private closed = false;
  constructor(private mode: 'pipe' | 'cmd', private endpoint?: string) {}
  async cmd(command: string, timeoutMs = 60_000) {
    if (this.closed) throw new Error('Session closed');
    return await nativeRequest(this.mode, { endpoint: this.endpoint, command, timeoutMs }) as string;
  }
  close() { this.closed = true; void nativeRequest('cancel').catch(() => {}); }
}

export async function createNativeClient(config: NativeConfig): Promise<R2Client> {
  if (config.mode === 'http') {
    const endpoint = config.endpoint!;
    return new CommandSession(new NativeCommandTransport('cmd', endpoint), { path: endpoint, size: 0, hash: endpoint });
  }
  if (config.mode === 'pipe') {
    const hash = await nativeRequest('hash') as string;
    return new CommandSession(new NativeCommandTransport('pipe'), { path: config.path!, size: config.size!, hash }, true);
  }
  const transport = new WasmTransport();
  try {
    const response = await fetch(new URL('input', document.baseURI));
    if (!response.ok) throw new Error('Cannot read selected binary');
    const bytes = await response.arrayBuffer();
    const hash = await nativeRequest('hash') as string;
    const entropy = await transport.init(bytes);
    return new CommandSession(transport, { path: config.path!, size: config.size!, hash, entropy }, true);
  } catch (e) { transport.close(); throw e; }
}
