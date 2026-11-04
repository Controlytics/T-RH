/**
 * The Math function node's CUSTOM expression (rule chains, Task 5) — a small,
 * safe arithmetic parser for ThingsBoard's grammar, which is exp4j's.
 *
 * NOT the script VM, on purpose: in exp4j `^` is POWER, while in JavaScript it
 * is bitwise XOR — `x^2` would compute silently and wrongly. Nothing here can
 * name anything but the node's own argument names, the constants and the
 * functions below; there is no property access, no call of anything else.
 *
 * Grammar (exp4j precedence, low to high):
 *   expr  := term (('+' | '-') term)*
 *   term  := unary (('*' | '/' | '%') unary | <implicit *> unary)*
 *   unary := ('+' | '-') unary | power          -- so -2^2 = -4
 *   power := primary ('^' unary)?                -- right-associative: 2^3^2 = 512
 *   primary := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
 * Implicit multiplication (`2x`, `3(x - 1)`) is on, as exp4j's default.
 * Numbers take a fraction and an exponent (`1.5e2`, `.5`). Names: the node's
 * arguments, then the constants `pi` / `π`, `e`, `φ`. Division or modulo by zero
 * fails, as exp4j does.
 */
type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '%' | '^'; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

export interface CompiledExpression { readonly text: string; readonly root: Node }

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, 'π': Math.PI, e: Math.E, 'φ': 1.61803398874 };

const FUNCTIONS: Readonly<Record<string, { arity: number; fn: (...a: number[]) => number }>> = {
  sin: { arity: 1, fn: Math.sin }, cos: { arity: 1, fn: Math.cos }, tan: { arity: 1, fn: Math.tan },
  cot: { arity: 1, fn: (x) => 1 / Math.tan(x) }, csc: { arity: 1, fn: (x) => 1 / Math.sin(x) }, sec: { arity: 1, fn: (x) => 1 / Math.cos(x) },
  asin: { arity: 1, fn: Math.asin }, acos: { arity: 1, fn: Math.acos }, atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh }, cosh: { arity: 1, fn: Math.cosh }, tanh: { arity: 1, fn: Math.tanh },
  csch: { arity: 1, fn: (x) => 1 / Math.sinh(x) }, sech: { arity: 1, fn: (x) => 1 / Math.cosh(x) }, coth: { arity: 1, fn: (x) => 1 / Math.tanh(x) },
  log: { arity: 1, fn: Math.log }, log2: { arity: 1, fn: Math.log2 }, log10: { arity: 1, fn: Math.log10 }, log1p: { arity: 1, fn: Math.log1p },
  exp: { arity: 1, fn: Math.exp }, expm1: { arity: 1, fn: Math.expm1 },
  abs: { arity: 1, fn: Math.abs }, cbrt: { arity: 1, fn: Math.cbrt }, sqrt: { arity: 1, fn: Math.sqrt },
  floor: { arity: 1, fn: Math.floor }, ceil: { arity: 1, fn: Math.ceil }, signum: { arity: 1, fn: Math.sign },
  pow: { arity: 2, fn: Math.pow },
  toradian: { arity: 1, fn: (x) => x * (Math.PI / 180) }, todegree: { arity: 1, fn: (x) => x * (180 / Math.PI) },
};

const MAX_LENGTH = 4_000;
const MAX_DEPTH = 200;

type Token = { t: 'num'; v: number; at: number } | { t: 'name'; v: string; at: number } | { t: 'op'; v: string; at: number } | { t: 'end'; at: number };

const invalid = (text: string, why: string): Error => new Error(`MATH_EXPRESSION_INVALID: ${why} in "${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`);

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_À-ɏͰ-Ͽ][A-Za-z0-9_À-ɏͰ-Ͽ]*/.exec(text.slice(i));
    if (name) {
      out.push({ t: 'name', v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) {
      out.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    throw invalid(text, `unexpected "${c}" at ${i + 1}`);
  }
  out.push({ t: 'end', at: text.length });
  return out;
}

function parse(text: string): Node {
  const tokens = tokenize(text);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => { const t = peek(); return t.t === 'op' && t.v === v; };
  const expect = (v: string) => {
    if (!isOp(v)) throw invalid(text, `"${v}" expected at ${peek().at + 1}`);
    pos++;
  };
  const enter = () => { if (++depth > MAX_DEPTH) throw invalid(text, 'nested too deeply'); };

  const expr = (): Node => {
    enter();
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: '+' | '-' }).v;
      left = { k: 'bin', op, a: left, b: term() };
    }
    depth--;
    return left;
  };
  const startsPrimary = () => { const t = peek(); return t.t === 'num' || t.t === 'name' || (t.t === 'op' && t.v === '('); };
  const term = (): Node => {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) {
        const op = (tokens[pos++] as { v: '*' | '/' | '%' }).v;
        left = { k: 'bin', op, a: left, b: unary() };
      } else if (startsPrimary()) {
        left = { k: 'bin', op: '*', a: left, b: unary() };
      } else {
        return left;
      }
    }
  };
  const unary = (): Node => {
    if (isOp('-')) { pos++; enter(); const a = unary(); depth--; return { k: 'neg', a }; }
    if (isOp('+')) { pos++; enter(); const a = unary(); depth--; return a; }
    return power();
  };
  const power = (): Node => {
    const base = primary();
    if (!isOp('^')) return base;
    pos++;
    enter();
    const exponent = unary();
    depth--;
    return { k: 'bin', op: '^', a: base, b: exponent };
  };
  const primary = (): Node => {
    const t = peek();
    if (t.t === 'num') { pos++; return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      pos++;
      if (!isOp('(')) return { k: 'var', name: t.v };
      const f = FUNCTIONS[t.v];
      if (!f) throw invalid(text, `unknown function "${t.v}"`);
      pos++;
      const args = [expr()];
      while (isOp(',')) { pos++; args.push(expr()); }
      expect(')');
      if (args.length !== f.arity) throw invalid(text, `${t.v} takes ${f.arity} argument(s), not ${args.length}`);
      return { k: 'call', fn: t.v, args };
    }
    if (t.t === 'op' && t.v === '(') {
      pos++;
      const inner = expr();
      expect(')');
      return inner;
    }
    throw invalid(text, t.t === 'end' ? 'the expression ends too early' : `unexpected "${(t as { v: string }).v}" at ${t.at + 1}`);
  };

  const root = expr();
  if (peek().t !== 'end') throw invalid(text, `unexpected "${(peek() as { v: string }).v}" at ${peek().at + 1}`);
  return root;
}

const cache = new Map<string, CompiledExpression>();
const CACHE_MAX = 500;

/** Parse once (cached by text). Throws MATH_EXPRESSION_INVALID. */
export function compileExpression(text: string): CompiledExpression {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('MATH_EXPRESSION_INVALID: the expression is blank');
  if (text.length > MAX_LENGTH) throw new Error(`MATH_EXPRESSION_INVALID: the expression is longer than ${MAX_LENGTH} characters`);
  const hit = cache.get(text);
  if (hit) return hit;
  const compiled: CompiledExpression = { text, root: parse(text) };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(text, compiled);
  return compiled;
}

/** Evaluate with the argument values by name. Throws MATH_EXPRESSION_INVALID (unknown name) / MATH_DIVISION_BY_ZERO. */
export function evaluateExpression(expr: CompiledExpression, vars: Readonly<Record<string, number>>): number {
  const ev = (n: Node): number => {
    switch (n.k) {
      case 'num': return n.v;
      case 'var':
        if (Object.prototype.hasOwnProperty.call(vars, n.name)) return vars[n.name];
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, n.name)) return CONSTANTS[n.name];
        throw new Error(`MATH_EXPRESSION_INVALID: unknown name "${n.name}" (the arguments are ${Object.keys(vars).map((k) => `"${k}"`).join(', ') || 'none'})`);
      case 'neg': return -ev(n.a);
      case 'call': return FUNCTIONS[n.fn].fn(...n.args.map(ev));
      case 'bin': {
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': if (b === 0) throw new Error('MATH_DIVISION_BY_ZERO: division by zero'); return a / b;
          case '%': if (b === 0) throw new Error('MATH_DIVISION_BY_ZERO: modulo by zero'); return a % b;
          case '^': return Math.pow(a, b);
        }
      }
    }
    throw new Error('MATH_EXPRESSION_INVALID: unreachable');
  };
  return ev(expr.root);
}
