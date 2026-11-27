import type { Block, FnGraph } from './types';

export type EdgeKind = 'jump' | 'fail' | 'uncond' | 'case';
export interface Edge {
  from: number;
  to: number;
  kind: EdgeKind;
  value?: number;
}

export function graphEdges(graph: FnGraph): Edge[] {
  const has = new Set(graph.blocks.map((b) => b.addr));
  const edges: Edge[] = [];
  for (const b of graph.blocks) {
    const jump = b.jump !== undefined && has.has(b.jump) ? b.jump : undefined;
    const fail = b.fail !== undefined && has.has(b.fail) ? b.fail : undefined;
    if (jump !== undefined) edges.push({ from: b.addr, to: jump, kind: fail !== undefined && fail !== jump ? 'jump' : 'uncond' });
    if (fail !== undefined && fail !== jump) edges.push({ from: b.addr, to: fail, kind: jump !== undefined ? 'fail' : 'uncond' });
    for (const [index, c] of (b.switchop?.cases ?? []).entries()) {
      if (has.has(c.jump)) edges.push({ from: b.addr, to: c.jump, kind: 'case', value: c.value ?? index });
    }
  }
  return edges;
}

export interface BlockCondition {
  text: string;
  matches: boolean | null;
}

const binary = new Map<string, (left: bigint, right: bigint) => bigint>([
  ['&', (a, b) => a & b], ['|', (a, b) => a | b], ['^', (a, b) => a ^ b],
  ['==', (a, b) => BigInt(a === b)], ['!=', (a, b) => BigInt(a !== b)],
]);

/** Fold conditions with inputs established by this block's ESIL. Unknown machine state stays unknown. */
export function blockCondition(block: Block): BlockCondition {
  const ops = block.ops ?? [];
  const branch = [...ops].reverse().find((op) => op.type?.includes('cjmp'));
  if (!branch) {
    const dispatch = ops.at(-1);
    return { text: dispatch?.esil || dispatch?.disasm || dispatch?.opcode || 'Switch dispatch', matches: null };
  }
  const predicate = branch.esil?.split(',?{,')[0];
  const text = predicate && !predicate.includes('?{') ? predicate : branch.disasm ?? branch.opcode ?? 'Conditional jump';
  const unknown = { text, matches: null };
  if (!predicate || predicate === branch.esil || predicate.includes('}')) return unknown;

  let registers = new Map<string, bigint>();
  const read = (token: string, known: Map<string, bigint>) => {
    if (/^(?:0x[\da-f]+|\d+)$/i.test(token)) return BigInt(token);
    if (/^e(?:ax|bx|cx|dx|si|di|bp|sp)$/.test(token) && known.has('r' + token.slice(1))) {
      return BigInt.asUintN(32, known.get('r' + token.slice(1))!);
    }
    return known.get(token);
  };
  for (const op of ops) {
    if (op === branch) break;
    const input = op.esil?.split(',') ?? [];
    if (op.type === 'nop') continue;
    if (op.type === 'mov' && input.length && input.length % 3 === 0) {
      // Keep only the writes we can prove, so register aliases and implicit writes cannot leave stale facts.
      const next = new Map<string, bigint>();
      for (let i = 0; i < input.length; i += 3) {
        const [src, dst, assign] = input.slice(i, i + 3);
        const value = read(src, next) ?? read(src, registers);
        if (assign !== '=' || !/^[a-z][\da-z]*$/i.test(dst) || value === undefined || value > 127n) {
          next.clear();
          break;
        }
        next.set(dst, value);
      }
      registers = next;
    } else if ((op.type === 'cmp' || op.type === 'acmp') && input[2] === '==' && input.slice(3, 6).join(',') === '$z,zf,:=') {
      const [right, left] = [read(input[0], registers), read(input[1], registers)];
      registers = new Map();
      if (left !== undefined && right !== undefined && right <= 127n) registers.set('zf', BigInt(left === right));
    } else registers.clear();
  }

  const stack: bigint[] = [];
  for (const token of predicate.split(',')) {
    const operation = binary.get(token);
    if (operation || token === '!') {
      const left = stack.pop();
      if (left === undefined) return unknown;
      if (!operation) stack.push(BigInt(left === 0n));
      else {
        const right = stack.pop();
        if (right === undefined) return unknown;
        stack.push(operation(left, right));
      }
    } else {
      const value = read(token, registers);
      if (value === undefined) return unknown;
      stack.push(value);
    }
  }
  return stack.length === 1 ? { text, matches: stack[0] !== 0n } : unknown;
}
