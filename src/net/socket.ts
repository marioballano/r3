import type { FnGraph, FunctionsMsg, InfoMsg } from '../types';

export interface OutMsg {
  t: 'out';
  id: number;
  text: string;
  seek: number | null;
  err?: boolean;
}

type Handlers = {
  status: (msg: string, progress: number) => void;
  info: (m: InfoMsg) => void;
  functions: (m: FunctionsMsg) => void;
  error: (msg: string) => void;
  close: () => void;
};

export class R2Socket {
  private ws: WebSocket;
  private nextId = 1;
  private waiting = new Map<number, (m: any) => void>();
  private opened: Promise<void>;
  on: Partial<Handlers> = {};

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('websocket error'));
    });
    this.ws.onclose = () => this.on.close?.();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case 'status':
          return this.on.status?.(m.msg, m.progress);
        case 'info':
          return this.on.info?.(m);
        case 'functions':
          return this.on.functions?.(m);
        case 'error':
          return this.on.error?.(m.msg);
        default: {
          const w = this.waiting.get(m.id);
          if (w) {
            this.waiting.delete(m.id);
            w(m);
          }
        }
      }
    };
  }

  async open(path: string) {
    await this.opened;
    this.ws.send(JSON.stringify({ t: 'open', path }));
  }

  private req<T>(obj: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ ...obj, id }));
    });
  }

  cmd(cmd: string, cols = 120): Promise<OutMsg> {
    return this.req<OutMsg>({ t: 'cmd', cmd, cols });
  }

  async query<T = unknown>(cmd: string): Promise<T | null> {
    const m = await this.req<{ data: T | null }>({ t: 'query', cmd });
    return m.data;
  }

  async fn(addr: number): Promise<FnGraph | null> {
    const m = await this.req<{ graph: FnGraph | null }>({ t: 'fn', addr });
    return m.graph;
  }

  close() {
    this.on = {};
    this.ws.close();
  }
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'other';
  size: number;
  exec: boolean;
  format: string | null;
  link?: string;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
  error?: string;
}

export async function listDir(path?: string): Promise<Listing> {
  const r = await fetch('/api/ls' + (path ? `?path=${encodeURIComponent(path)}` : ''));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'failed');
  return j;
}

export async function r2Status(): Promise<{ ok: boolean; version?: string; error?: string; home?: string }> {
  try {
    const r = await fetch('/api/r2');
    return await r.json();
  } catch {
    return { ok: false, error: 'r3 server unreachable' };
  }
}
