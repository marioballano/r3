import type { EntropyData, FnGraph, FunctionsMsg, InfoMsg, InspectMsg } from '../types';

export type Analysis = 'none' | 'aa' | 'aaa' | 'auto';
export interface OutMsg {
  t: 'out'; id: number; text: string; seek: number | null; err?: boolean;
}
export interface Handlers {
  status: (msg: string, progress: number) => void;
  info: (m: InfoMsg) => void;
  functions: (m: FunctionsMsg) => void;
  error: (msg: string) => void;
  close: () => void;
}
export interface R2Client {
  on: Partial<Handlers>;
  open(path: string, analysis?: Analysis): Promise<void>;
  cmd(cmd: string, cols?: number): Promise<OutMsg>;
  query<T = unknown>(cmd: string): Promise<T | null>;
  inspect(addr: number): Promise<InspectMsg | null>;
  pdc(addr: number): Promise<string>;
  fn(addr: number): Promise<FnGraph | null>;
  close(): void;
}
export interface CommandTransport {
  cmd(command: string, timeoutMs?: number): Promise<string>;
  close(): void;
}
export interface Target {
  path: string; size: number; hash: string; format?: string | null; entropy?: EntropyData;
}
