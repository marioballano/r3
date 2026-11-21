// Cross-check r3's call graph for one function against r2's own `axtj` / `afxj`.
import WebSocket from 'ws';
const [file, fname] = [process.argv[2] ?? '/usr/bin/ssh', process.argv[3] ?? 'fcn.00062ee0'];
const ws = new WebSocket('ws://127.0.0.1:3133/ws');
let fns: any[] = [];
let calls: number[][] = [];
ws.on('open', () => ws.send(JSON.stringify({ t: 'open', path: file })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'functions') {
    fns = m.functions;
    calls = m.calls;
    const fi = fns.findIndex((f) => f.name === fname);
    ws.send(JSON.stringify({ t: 'query', id: 1, cmd: `axtj @ ${fns[fi].addr}` }));
    ws.send(JSON.stringify({ t: 'query', id: 2, cmd: `afxj @ ${fns[fi].addr}` }));
  }
  if (m.t === 'query' && m.id === 1) {
    const fi = fns.findIndex((f) => f.name === fname);
    const mine = new Set(calls.filter((c) => c[1] === fi).map((c) => c[2]));
    const r2 = (m.data as any[]).filter((x) => x.type === 'CALL');
    const r2inFn = new Set(r2.filter((x) => x.fcn_addr !== undefined).map((x) => x.from));
    const missing = [...r2inFn].filter((a) => !mine.has(a));
    const extra = [...mine].filter((a) => !r2inFn.has(a));
    console.log(`callers of ${fname}: r3=${mine.size} r2(axtj, inside fns)=${r2inFn.size} r2(all)=${r2.length} missing=${missing.length} extra=${extra.length}`);
    for (const x of r2.slice(0, 3)) {
      const c = calls.find((c) => c[2] === x.from && c[1] === fi);
      console.log(`  site 0x${x.from.toString(16)} r2 says ${x.fcn_name ?? x.name} | r3 says ${c ? fns[c[0]].name : '-'}`);
    }
  }
  if (m.t === 'query' && m.id === 2) {
    const fi = fns.findIndex((f) => f.name === fname);
    const mine = new Set(calls.filter((c) => c[0] === fi).map((c) => `${c[2]}>${fns[c[1]].addr}`));
    const r2 = new Set((m.data as any[]).filter((x) => x.type === 'CALL').map((x) => `${x.from}>${x.to}`));
    const r2known = [...r2].filter((k) => fns.some((f) => f.addr === Number(k.split('>')[1])));
    console.log(`callees of ${fname}: r3=${mine.size} r2(afxj CALL to known fns)=${r2known.length} equal=${r2known.every((k) => mine.has(k)) && mine.size === r2known.length}`);
    ws.close();
  }
});
ws.on('close', () => process.exit(0));
