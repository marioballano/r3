// Minimal r2pipe over stdio: spawn `r2 -q0 <file>`, each command is written as
// "cmd\n" and its output is terminated by a NUL byte. Commands are queued so
// only one is in flight at a time.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending {
  cmd: string;
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  timeoutMs: number;
}

export class R2Pipe {
  private proc: ChildProcessWithoutNullStreams;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private chunks: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ready: Promise<void>;
  private dead = false;
  private stderrTail = '';

  constructor(file: string, extraArgs: string[] = []) {
    this.proc = spawn('r2', ['-q0', '-2', ...extraArgs, file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, R2_NOPLUGINS: process.env.R2_NOPLUGINS ?? '' },
    });
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    // r2 -q0 emits a single NUL once the file is loaded.
    this.ready = new Promise((resolve, reject) => {
      const onData = (d: Buffer) => {
        const i = d.indexOf(0);
        if (i >= 0) {
          this.proc.stdout.off('data', onData);
          this.proc.stdout.on('data', (x: Buffer) => this.onData(x));
          if (i + 1 < d.length) this.onData(d.subarray(i + 1));
          resolve();
        }
      };
      this.proc.stdout.on('data', onData);
      this.proc.on('error', reject);
      this.proc.on('exit', (code) => {
        this.dead = true;
        const err = new Error(`r2 exited (${code}) ${this.stderrTail.trim()}`);
        reject(err);
        this.current?.reject(err);
        for (const p of this.queue) p.reject(err);
        this.queue = [];
        this.current = null;
      });
    });
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  get alive(): boolean {
    return !this.dead;
  }

  cmd(cmd: string, timeoutMs = 30_000): Promise<string> {
    if (this.dead) return Promise.reject(new Error('r2 is not running'));
    // A newline inside a command would desync the protocol.
    const clean = cmd.replace(/[\r\n]+/g, ' ').trim();
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd: clean, resolve, reject, timeoutMs });
      this.pump();
    });
  }

  async cmdj<T = unknown>(cmd: string, timeoutMs?: number): Promise<T | null> {
    const out = await this.cmd(cmd, timeoutMs);
    const t = out.trim();
    if (!t) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      // Some commands print hints before JSON; try from first bracket.
      const i = t.search(/[[{]/);
      if (i > 0) {
        try {
          return JSON.parse(t.slice(i)) as T;
        } catch {
          /* fallthrough */
        }
      }
      return null;
    }
  }

  private pump() {
    if (this.current || this.dead) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.chunks = [];
    this.timer = setTimeout(() => {
      // Interrupt a runaway command; r2 prints the partial result + NUL.
      this.proc.kill('SIGINT');
      this.timer = setTimeout(() => this.kill(), 3000);
    }, next.timeoutMs);
    this.proc.stdin.write(next.cmd + '\n');
  }

  private onData(d: Buffer) {
    let buf = d;
    while (buf.length) {
      const i = buf.indexOf(0);
      if (i < 0) {
        this.chunks.push(buf);
        return;
      }
      this.chunks.push(buf.subarray(0, i));
      buf = buf.subarray(i + 1);
      const out = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const cur = this.current;
      this.current = null;
      cur?.resolve(out);
      this.pump();
    }
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill('SIGKILL');
  }
}
