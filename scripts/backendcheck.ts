// Exercise the actual official WASM binary through the shared analysis API.
import { measureEntropy, validEntropy } from '../src/net/entropy.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WasmCore } from '../src/net/wasm-runtime.js';
import { CommandSession } from '../src/net/session.js';
import type { FunctionsMsg, InfoMsg } from '../src/types.js';

assert.equal(validEntropy({}), false);
assert.equal(measureEntropy(new Uint8Array(512)).entropy[0].value, 0);
assert.equal(measureEntropy(new Uint8Array([0, 1, 2, 3]), 1).entropy[0].value, 255);
assert.equal(measureEntropy(new Uint8Array([1])).entropy[0].value, 0);
const wasm = await readFile('app/mac/build/wasm/radare2.wasm');
const binary = await readFile('/bin/ls');
const core = await WasmCore.create(wasm, new Uint8Array(binary));
let info: InfoMsg | undefined;
let graph: FunctionsMsg | undefined;
const session = new CommandSession({ cmd: async c => core.cmd(c), close: () => core.close() },
  { path: '/bin/ls', size: binary.length, hash: 'test', entropy: measureEntropy(binary) }, true);
session.on.info = m => { info = m; };
session.on.functions = m => { graph = m; };
try {
  await session.open('/bin/ls', 'aaa');
  assert.equal(info?.size, binary.length);
  assert.ok(info?.sections.length);
  assert.ok(info?.entropy?.entropy.some(e => e.value > 0), 'real physical file entropy');
  assert.equal(info?.entropy?.address, 0);
  assert.ok(graph && graph.functions.length > 10);
  assert.ok(graph.calls.length > 0);
  const fn = graph.functions.find(f => !f.imp && f.nbbs > 1)!;
  assert.ok((await session.fn(fn.addr))?.blocks.length);
  assert.ok((await session.inspect(fn.addr))?.ops.length);
  assert.ok((await session.pdc(fn.addr)).length);
  const [command, query] = await Promise.all([session.cmd(`s ${fn.addr}`), session.query<string>('ej scr.color')]);
  assert.equal(command.seek, fn.addr);
  assert.ok(query !== null);
  const caller = graph.functions[graph.calls[0][0]];
  const site = graph.calls[0][2];
  const callerGraph = await session.fn(caller.addr);
  const block = callerGraph?.blocks.find(b => b.addr <= site && site < b.addr + b.size);
  assert.ok(block);
  const summary = await session.blockSummary(block.addr);
  assert.ok(summary.includes('0x' + site.toString(16)), 'pdsb contains the call site in the requested block');
  assert.ok(!summary.includes('\x1b'), 'block summaries have no terminal colors');
  const functionSummary = await session.functionSummary(caller.addr);
  assert.ok(functionSummary.includes('0x' + site.toString(16)), 'pdsf contains the call from the requested function');
  assert.ok(!functionSummary.includes('\x1b'), 'function summaries have no terminal colors');
  assert.equal((await session.cmd('s')).seek, fn.addr, 'a block summary leaves the seek unchanged');
  assert.equal((await session.cmd('!id')).err, true);
  const other = await WasmCore.create(wasm, new Uint8Array([0x90, 0xc3]));
  try { assert.equal(other.cmd('p8 2').trim(), '90c3'); }
  finally { other.close(); }
  assert.equal((await session.cmd('s')).seek, fn.addr, 'a second core must not affect the first');
  console.log(`PASS: WASM headers, ${graph.functions.length} functions, ${graph.calls.length} calls, CFG, inspect, pdc, pdsb, pdsf, seek, command serialization, isolated cores`);
} finally { session.close(); }
await assert.rejects(session.query('ij'), /closed/);
