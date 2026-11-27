// Browser-style navigation history across views.
export interface NavEntry {
  view: 'city' | 'constellation' | 'function' | 'interior';
  fi: number | null;
  addr: number | null;
}

export class NavHistory {
  private stack: NavEntry[] = [];
  private i = -1;
  onChange: () => void = () => {};

  push(e: NavEntry) {
    const cur = this.stack[this.i];
    if (cur && cur.view === e.view && cur.fi === e.fi && cur.addr === e.addr) return;
    // same function/view: replace (keeps history meaningful while stepping instructions)
    if (cur && cur.view === e.view && cur.fi === e.fi && e.view !== 'city') {
      this.stack[this.i] = e;
      return this.onChange();
    }
    this.stack = this.stack.slice(0, this.i + 1);
    this.stack.push(e);
    if (this.stack.length > 200) this.stack.shift();
    this.i = this.stack.length - 1;
    this.onChange();
  }

  back(): NavEntry | null {
    if (this.i <= 0) return null;
    this.i--;
    this.onChange();
    return this.stack[this.i];
  }

  forward(): NavEntry | null {
    if (this.i >= this.stack.length - 1) return null;
    this.i++;
    this.onChange();
    return this.stack[this.i];
  }

  /** Move the cursor to a specific entry (breadcrumb click). */
  jump(e: NavEntry): NavEntry | null {
    const k = this.stack.lastIndexOf(e);
    if (k < 0) return null;
    this.i = k;
    this.onChange();
    return e;
  }

  /** for tests / debugging */
  snapshot() {
    return { i: this.i, stack: this.stack.map((e) => ({ ...e })) };
  }

  trail(n = 6): { e: NavEntry; current: boolean }[] {
    const from = Math.max(0, this.i - n + 1);
    return this.stack.slice(from, this.i + 1).map((e, k) => ({ e, current: from + k === this.i }));
  }

  get canBack() {
    return this.i > 0;
  }
  get canForward() {
    return this.i < this.stack.length - 1;
  }
}
