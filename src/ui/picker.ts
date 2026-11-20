import { listDir, type DirEntry, type Listing } from '../net/socket';
import { humanSize } from '../types';
import { audio } from '../audio/audio';
import { corners, h } from './dom';

/** Holographic host filesystem browser. Resolves with the chosen file path. */
export function showPicker(root: HTMLElement, opts: { version: string; home?: string; start?: string }): Promise<string> {
  return new Promise((resolve) => {
    const el = corners(h('div', { class: 'panel picker' }));
    const pathIn = h('input', { spellcheck: 'false', placeholder: '/path/to/binary' });
    const filterIn = h('input', { spellcheck: 'false', placeholder: 'filter…', style: 'flex: 0 0 180px' });
    const go = h('button', { class: 'btn' }, 'open');
    const list = h('div', { class: 'list' });
    const status = h('span', {}, '');
    const chips = h('div', { class: 'chips' });
    const onlyBins = h('span', { class: 'chip toggle on' }, '◉ binaries only');
    const places = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/local/bin', '/bin', opts.home ?? '/root', '/opt'];
    for (const p of [...new Set(places)]) {
      const c = h('span', { class: 'chip' }, p);
      c.onclick = () => load(p);
      chips.append(c);
    }
    chips.append(onlyBins);
    el.append(
      h('header', {}, h('h2', {}, 'SELECT TARGET'), h('span', { class: 'r2v' }, `● ${opts.version}`)),
      h('div', { class: 'pathrow' }, pathIn, filterIn, go),
      chips,
      list,
      h('footer', {}, status, h('span', {}, h('b', {}, '↑↓'), ' move  ', h('b', {}, '⏎'), ' open  ', h('b', {}, '⌫'), ' up  ', h('b', {}, 'type'), ' filter')),
    );
    root.append(el);

    let listing: Listing | null = null;
    let rows: { e: DirEntry; el: HTMLElement }[] = [];
    let sel = 0;
    let bins = true;

    const choose = (p: string) => {
      audio.confirm();
      el.classList.add('out');
      window.removeEventListener('keydown', onKey, true);
      setTimeout(() => el.remove(), 800);
      resolve(p);
    };

    const render = () => {
      if (!listing) return;
      const f = filterIn.value.toLowerCase();
      list.replaceChildren();
      rows = [];
      const items: DirEntry[] = [];
      if (listing.parent) items.push({ name: '..', path: listing.parent, type: 'dir', size: 0, exec: false, format: null });
      for (const e of listing.entries) {
        if (f && !e.name.toLowerCase().includes(f)) continue;
        if (bins && e.type === 'file' && !e.format) continue;
        if (e.type === 'other') continue;
        items.push(e);
      }
      const frag = document.createDocumentFragment();
      for (const e of items.slice(0, 1500)) {
        const isBin = !!e.format;
        const r = h(
          'div',
          { class: `row ${e.type === 'dir' ? 'dir' : isBin ? 'bin' : 'dim'}` },
          h('span', { class: 'ic' }, e.type === 'dir' ? '▸' : isBin ? '◆' : '·'),
          h('span', { class: 'nm' }, e.name, e.link ? h('span', { class: 'lnk' }, `→ ${e.link}`) : null),
          e.format ? h('span', { class: 'fmt' }, e.format.toUpperCase()) : h('span', {}),
          h('span', { class: 'sz' }, e.type === 'dir' ? '' : humanSize(e.size)),
        );
        const idx = rows.length;
        r.onmouseenter = () => setSel(idx, false);
        r.onclick = () => activate(e);
        rows.push({ e, el: r });
        frag.append(r);
      }
      list.append(frag);
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      if (listing.parent && rows.length > 1 && sel === 0) sel = 1;
      setSel(sel, true);
      const nb = listing.entries.filter((e) => e.format).length;
      status.textContent = `${listing.entries.length} entries · ${nb} binaries${listing.truncated ? ' · truncated' : ''}`;
    };

    const setSel = (i: number, scroll: boolean) => {
      rows[sel]?.el.classList.remove('sel');
      sel = Math.max(0, Math.min(rows.length - 1, i));
      const r = rows[sel];
      if (!r) return;
      r.el.classList.add('sel');
      if (scroll) r.el.scrollIntoView({ block: 'nearest' });
    };

    const activate = (e: DirEntry) => {
      if (e.type === 'dir') {
        audio.blip(520, 0.05, 'triangle', 0.04);
        load(e.path);
      } else choose(e.path);
    };

    const load = async (p: string) => {
      try {
        listing = await listDir(p);
        pathIn.value = listing.path;
        filterIn.value = '';
        sel = 0;
        for (const c of chips.querySelectorAll('.chip:not(.toggle)')) c.classList.toggle('on', c.textContent === listing.path);
        render();
        list.scrollTop = 0;
      } catch (err) {
        audio.error();
        status.textContent = `✖ ${(err as Error).message}`;
      }
    };

    const openTyped = async () => {
      const v = pathIn.value.trim();
      if (!v) return;
      try {
        await listDir(v);
        load(v);
      } catch {
        choose(v); // not a directory: treat as file, server validates
      }
    };

    onlyBins.onclick = () => {
      bins = !bins;
      onlyBins.classList.toggle('on', bins);
      onlyBins.textContent = bins ? '◉ binaries only' : '○ all files';
      render();
    };
    go.onclick = openTyped;
    filterIn.oninput = () => {
      sel = 0;
      render();
    };

    const onKey = (e: KeyboardEvent) => {
      const inPath = document.activeElement === pathIn;
      if (inPath) {
        if (e.key === 'Enter') {
          e.preventDefault();
          openTyped();
        }
        return;
      }
      if (e.key === 'ArrowDown') setSel(sel + 1, true);
      else if (e.key === 'ArrowUp') setSel(sel - 1, true);
      else if (e.key === 'PageDown') setSel(sel + 15, true);
      else if (e.key === 'PageUp') setSel(sel - 15, true);
      else if (e.key === 'Enter') {
        const r = rows[sel];
        if (r) activate(r.e);
      } else if (e.key === 'Backspace' && !filterIn.value && listing?.parent) {
        e.preventDefault();
        load(listing.parent);
        return;
      } else if (e.key === 'Escape') {
        filterIn.value = '';
        render();
        return;
      } else {
        if (document.activeElement !== filterIn && e.key.length === 1 && !e.ctrlKey && !e.metaKey) filterIn.focus();
        audio.key();
        return;
      }
      e.preventDefault();
      audio.key();
    };
    window.addEventListener('keydown', onKey, true);
    load(opts.start ?? '/usr/bin');
  });
}
