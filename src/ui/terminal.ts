import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { audio } from '../audio/audio';
import { corners, h } from './dom';

const M = '\x1b[38;2;255;43;214m';
const Y = '\x1b[38;2;255;242;0m';
const C = '\x1b[38;2;0;240;255m';
const D = '\x1b[38;2;107;93;140m';
const R = '\x1b[0m';

/** Holographic r2 shell with line editing, history and completion. */
export class Shell {
  el: HTMLElement;
  term: Terminal;
  private fit: FitAddon;
  private buf = '';
  private cur = 0;
  private history: string[] = [];
  private hIdx = -1;
  private busy = false;
  private seek = 0;
  isOpen = false;
  onSubmit: (cmd: string) => Promise<void> = async () => {};
  complete: (word: string) => string[] = () => [];
  onToggle: (open: boolean) => void = () => {};

  constructor(root: HTMLElement) {
    const xt = h('div', { class: 'xt' });
    this.el = corners(
      h(
        'div',
        { class: 'panel term closed' },
        h('div', { class: 'thead' }, h('span', { class: 'ptitle' }, '◢ r2 :: neural shell'), h('span', { class: 'hint' }, '~ toggle · tab complete · ↑↓ history · :help')),
        xt,
      ),
    );
    root.append(this.el);
    try {
      this.history = JSON.parse(localStorage.getItem('r3.history') ?? '[]');
    } catch {
      this.history = [];
    }
    this.term = new Terminal({
      allowTransparency: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: true,
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: '#d8f6ff',
        cursor: '#ff2bd6',
        cursorAccent: '#000',
        selectionBackground: 'rgba(255,43,214,0.35)',
        black: '#1a1033',
        red: '#ff3864',
        green: '#39ff88',
        yellow: '#fff200',
        blue: '#4d7cff',
        magenta: '#ff2bd6',
        cyan: '#00f0ff',
        white: '#d8f6ff',
        brightBlack: '#6b5d8c',
        brightRed: '#ff6b8a',
        brightGreen: '#7dffb0',
        brightYellow: '#fff89a',
        brightBlue: '#8aa6ff',
        brightMagenta: '#ff7be6',
        brightCyan: '#7af7ff',
        brightWhite: '#ffffff',
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(xt);
    this.term.onData((d) => this.onData(d));
    window.addEventListener('resize', () => this.isOpen && this.fit.fit());
    this.term.writeln(`${M}  ▄▄▄  ▄▄▄${R}   ${C}r3 neural shell${R} ${D}— a radare2 session rendered in light${R}`);
    this.term.writeln(`${M}  █▀▀  ▄▄█${R}   ${D}every r2 command works. some of them move the world.${R}`);
    this.term.writeln(`${M}  ▀    ▄▄█${R}   ${D}try:${R} ${Y}afl${R} ${Y}s main${R} ${Y}pdf${R} ${Y}iz${R} ${Y}ii${R} ${Y}iS${R} ${Y}p=e${R} ${Y}:tour${R} ${Y}:help${R}`);
    this.term.writeln('');
  }

  get cols() {
    return this.term.cols;
  }

  toggle(force?: boolean) {
    this.isOpen = force ?? !this.isOpen;
    this.el.classList.toggle('closed', !this.isOpen);
    audio.blip(this.isOpen ? 740 : 440, 0.07, 'triangle', 0.05);
    if (this.isOpen) {
      requestAnimationFrame(() => {
        this.fit.fit();
        this.term.focus();
        if (!this.buf && !this.busy) this.prompt();
      });
    } else this.term.blur();
    this.onToggle(this.isOpen);
  }

  setSeek(addr: number) {
    this.seek = addr;
  }

  private promptStr() {
    return `${M}[${Y}0x${this.seek.toString(16).padStart(8, '0')}${M}]>${R} `;
  }

  private redraw() {
    this.term.write(`\r\x1b[2K${this.promptStr()}${this.buf}`);
    const back = this.buf.length - this.cur;
    if (back > 0) this.term.write(`\x1b[${back}D`);
  }

  prompt() {
    this.buf = '';
    this.cur = 0;
    this.term.write(`\r\n${this.promptStr()}`);
  }

  write(text: string) {
    this.term.write(text.replace(/\r?\n/g, '\r\n'));
  }

  /** Print a line above the prompt without disturbing typing. */
  println(text: string) {
    this.term.write(`\r\x1b[2K${text.replace(/\r?\n/g, '\r\n')}\r\n`);
    if (!this.busy) this.redraw();
  }

  /** Run a command as if typed. */
  async run(cmd: string) {
    if (!this.isOpen) this.toggle(true);
    this.buf = cmd;
    this.cur = cmd.length;
    this.redraw();
    await this.submit();
  }

  private async submit() {
    const cmd = this.buf.trim();
    this.term.write('\r\n');
    if (!cmd) {
      this.prompt();
      return;
    }
    if (this.history[this.history.length - 1] !== cmd) this.history.push(cmd);
    this.history = this.history.slice(-300);
    try {
      localStorage.setItem('r3.history', JSON.stringify(this.history));
    } catch {
      /* ignore */
    }
    this.hIdx = -1;
    this.busy = true;
    audio.confirm();
    try {
      await this.onSubmit(cmd);
    } catch (e) {
      this.write(`\x1b[31m${(e as Error).message}\x1b[0m\n`);
      audio.error();
    }
    this.busy = false;
    this.prompt();
  }

  private onData(d: string) {
    if (this.busy) return;
    if (d === '\r') return void this.submit();
    if (d === '\x7f' || d === '\b') {
      if (this.cur > 0) {
        this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
        this.cur--;
        this.redraw();
        audio.key();
      }
      return;
    }
    if (d === '\x1b[A' || d === '\x1b[B') {
      if (!this.history.length) return;
      if (d === '\x1b[A') this.hIdx = this.hIdx < 0 ? this.history.length - 1 : Math.max(0, this.hIdx - 1);
      else this.hIdx = this.hIdx < 0 ? -1 : this.hIdx + 1;
      if (this.hIdx >= this.history.length) this.hIdx = -1;
      this.buf = this.hIdx < 0 ? '' : this.history[this.hIdx];
      this.cur = this.buf.length;
      this.redraw();
      return;
    }
    if (d === '\x1b[D') {
      if (this.cur > 0) {
        this.cur--;
        this.term.write(d);
      }
      return;
    }
    if (d === '\x1b[C') {
      if (this.cur < this.buf.length) {
        this.cur++;
        this.term.write(d);
      }
      return;
    }
    if (d === '\x1b[H' || d === '\x01') {
      this.cur = 0;
      return this.redraw();
    }
    if (d === '\x1b[F' || d === '\x05') {
      this.cur = this.buf.length;
      return this.redraw();
    }
    if (d === '\x03') {
      this.term.write('^C');
      return this.prompt();
    }
    if (d === '\x0c') {
      this.term.clear();
      return this.redraw();
    }
    if (d === '\x15') {
      this.buf = this.buf.slice(this.cur);
      this.cur = 0;
      return this.redraw();
    }
    if (d === '\t') return this.tab();
    if (d === '`' || d === '~') {
      if (!this.buf) return this.toggle(false);
    }
    if (d.startsWith('\x1b')) return;
    // printable (also handles paste)
    const clean = d.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '');
    if (!clean) return;
    this.buf = this.buf.slice(0, this.cur) + clean + this.buf.slice(this.cur);
    this.cur += clean.length;
    this.redraw();
    audio.key();
  }

  private tab() {
    const left = this.buf.slice(0, this.cur);
    const m = left.match(/(\S*)$/);
    const word = m ? m[1] : '';
    if (!word) return;
    const opts = this.complete(word);
    if (!opts.length) return audio.blip(200, 0.05, 'square', 0.03);
    if (opts.length === 1) {
      const add = opts[0].slice(word.length) + ' ';
      this.buf = left + add + this.buf.slice(this.cur);
      this.cur += add.length;
      return this.redraw();
    }
    // common prefix
    let pre = opts[0];
    for (const o of opts) while (!o.startsWith(pre)) pre = pre.slice(0, -1);
    if (pre.length > word.length) {
      const add = pre.slice(word.length);
      this.buf = left + add + this.buf.slice(this.cur);
      this.cur += add.length;
      return this.redraw();
    }
    this.term.write('\r\n' + opts.slice(0, 60).map((o) => `${C}${o}${R}`).join('  ') + (opts.length > 60 ? ` ${D}(+${opts.length - 60})${R}` : '') + '\r\n');
    this.redraw();
  }
}
