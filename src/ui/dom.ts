export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

export function corners(el: HTMLElement) {
  for (const c of ['tl', 'tr', 'bl', 'br']) el.append(h('div', { class: `corner ${c}` }));
  return el;
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Type text into an element character by character (with a scramble). */
export function scramble(el: HTMLElement, text: string, ms = 600) {
  const chars = '!<>-_\\/[]{}—=+*^?#ABCDEF0123456789';
  const start = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / ms);
    const n = Math.floor(text.length * k);
    let out = text.slice(0, n);
    for (let i = n; i < text.length; i++) out += text[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)];
    el.textContent = out;
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}
