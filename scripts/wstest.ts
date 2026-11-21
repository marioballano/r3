// Protocol smoke test: open a binary, print graph stats, exercise inspect/pdc/cmd.
import WebSocket from 'ws';
const file = process.argv[2] ?? '/usr/bin/grep';
const ws = new WebSocket('ws://127.0.0.1:3133/ws');
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2);
ws.on('open', () => ws.send(JSON.stringify({ t: 'open', path: file })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'status') return;
  if (m.t === 'info') return console.log(el(), 'info', m.info?.bin?.arch, 'sections', m.sections.length, 'strings', m.strings.length);
  if (m.t === 'functions') {
    console.log(el(), 'functions', m.functions.length, 'call sites', m.calls.length, 'strRefs', m.strRefs.length);
    const big = m.functions.reduce((a: any, b: any) => (b.size > a.size ? b : a));
    console.log('  sample call', m.calls[0], 'fn', m.functions[m.calls[0][0]].name, '->', m.functions[m.calls[0][1]].name);
    ws.send(JSON.stringify({ t: 'inspect', id: 1, addr: big.addr }));
    ws.send(JSON.stringify({ t: 'pdc', id: 2, addr: big.addr }));
    ws.send(JSON.stringify({ t: 'cmd', id: 3, cmd: '!id' }));
    return;
  }
  if (m.t === 'inspect') return console.log(el(), 'inspect', m.info?.name, 'ops', m.ops.length, 'vars', Object.keys(m.vars ?? {}), 'op0', JSON.stringify(m.ops[0]).slice(0, 160));
  if (m.t === 'pdc') return console.log(el(), 'pdc', m.text.split('\n').length, 'lines');
  if (m.t === 'out') {
    console.log(el(), 'out', JSON.stringify(m.text.slice(0, 80)));
    ws.close();
    return;
  }
  console.log(el(), m);
});
ws.on('close', () => process.exit(0));
