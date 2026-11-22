import type { FnGraph, InspectMsg } from '../types';

import type { Analysis, Handlers, OutMsg, R2Client } from './client';
export type { OutMsg } from './client';

export class R2Socket implements R2Client {
  private ws: WebSocket;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private opened: Promise<void>;
  on: Partial<Handlers> = {};

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('websocket error'));
    });
    this.ws.onclose = () => { this.failPending(new Error('Connection closed')); this.on.close?.(); };
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
            clearTimeout(w.timer);
            if (m.t === 'failure') w.reject(new Error(m.msg)); else w.resolve(m);
          }
        }
      }
    };
  }

  async open(path: string, analysis: Analysis = 'auto') {
    await this.opened;
    this.ws.send(JSON.stringify({ t: 'open', path, analysis }));
  }

  private req<T>(obj: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Connection is not open'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('r2 request timed out')); }, 120_000);
      this.waiting.set(id, { resolve, reject, timer });
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

  async inspect(addr: number): Promise<InspectMsg | null> {
    const m = await this.req<InspectMsg>({ t: 'inspect', addr });
    return m ? { info: m.info, vars: m.vars, ops: m.ops ?? [] } : null;
  }

  async pdc(addr: number): Promise<string> {
    const m = await this.req<{ text: string }>({ t: 'pdc', addr });
    return m?.text ?? '';
  }

  async fn(addr: number): Promise<FnGraph | null> {
    const m = await this.req<{ graph: FnGraph | null }>({ t: 'fn', addr });
    return m.graph;
  }

  private failPending(error: Error) {
    for (const request of this.waiting.values()) { clearTimeout(request.timer); request.reject(error); }
    this.waiting.clear();
  }

  close() {
    this.failPending(new Error('Session closed'));
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
