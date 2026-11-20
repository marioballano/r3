import WebSocket from 'ws';
const file = process.argv[2] ?? '/usr/bin/grep';
const ws = new WebSocket('ws://127.0.0.1:3133/ws');
let id = 0;
const t0 = Date.now();
ws.on('open', () => ws.send(JSON.stringify({ t: 'open', path: file })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  const el = ((Date.now() - t0) / 1000).toFixed(2);
  if (m.t === 'status') { if (m.progress === 1 || m.progress < 0.3) console.log(el, 'status', m.msg, m.progress.toFixed(2)); return; }
  if (m.t === 'info') { console.log(el, 'info', m.info?.bin?.arch, 'sections', m.sections.length, 'strings', m.strings.length, 'imports', m.imports.length, 'entropy', m.entropy?.entropy?.length); return; }
  if (m.t === 'functions') {
    console.log(el, 'functions', m.functions.length, 'calls', m.calls.length, 'seek', m.seek);
    ws.send(JSON.stringify({ t: 'cmd', id: ++id, cmd: 'pd 4 @ entry0' }));
    ws.send(JSON.stringify({ t: 'cmd', id: ++id, cmd: '!id' }));
    ws.send(JSON.stringify({ t: 'cmd', id: ++id, cmd: 'cat /etc/passwd' }));
    ws.send(JSON.stringify({ t: 'cmd', id: ++id, cmd: 'e cfg.sandbox=false' }));
    ws.send(JSON.stringify({ t: 'cmd', id: ++id, cmd: 'e cfg.sandbox' }));
    ws.send(JSON.stringify({ t: 'fn', id: ++id, addr: m.functions.find((f: any) => f.nbbs > 5)?.addr }));
    return;
  }
  if (m.t === 'out') { console.log(el, 'out', m.id, JSON.stringify(m.text.slice(0, 300)), m.seek); return; }
  if (m.t === 'fn') { console.log(el, 'fn', m.graph?.name, m.graph?.blocks?.length); ws.close(); return; }
  console.log(el, m);
});
ws.on('close', () => process.exit(0));
