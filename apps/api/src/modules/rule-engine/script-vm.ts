import vm from 'node:vm';

/**
 * RULE NODE SCRIPTS (rule chains, 2026-11-03; spec §6) — ThingsBoard's
 * JavaScript node scripts: a function BODY run as
 * `function (msg, metadata, msgType) { <script> }`.
 *
 * ── THIS IS A TIME-BOX, NOT A SECURITY SANDBOX ──
 * It bounds how long a script runs (`scriptTimeoutMs`, ThingsBoard's 2 s
 * default) and what it can NAME, nothing more. Scripts are written by
 * RULE_CHAIN_MANAGE holders only (by default SUPER_ADMIN — the same trust as
 * the configuration pages), the stance `lib/regex-budget.ts` takes. `node:vm`
 * is documented by Node itself as not a security mechanism, and memory is not
 * bounded at all. What it does, so that an honest mistake cannot hurt the
 * process:
 *  - each script compiles ONCE into its own V8 context (`vm.createContext`,
 *    code generation from strings and WebAssembly OFF, microtasks run inside the
 *    time budget). `eval` / `Function` / `(()=>{}).constructor` throw;
 *  - NO host object ever enters the context: `msg` and `metadata` cross as JSON
 *    text and are parsed inside, so `x.constructor.constructor` is the
 *    context's own (disabled) `Function`, never the host's. `btoa` / `atob`
 *    are implemented inside the context for the same reason;
 *  - the body is compiled with `vm.compileFunction` (it cannot close its own
 *    function early) in strict mode, with every global the script may NOT use
 *    shadowed as an `undefined` parameter — `process`, `require`, `globalThis`,
 *    `fetch`, timers, `console`, `Function`, `Promise`, `Reflect`, `Proxy` …
 *    The names a script CAN use: `msg`, `metadata`, `msgType`, `JSON`, `Math`,
 *    `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `btoa`, `atob`,
 *    `String`, `Number`, `Boolean`, `Array`, `Object`, and (ruling T3-6) `Error`
 *    and `RegExp`, so `throw new Error('…')` and a dynamic pattern work;
 *  - the context is FROZEN once built — every intrinsic reachable from it and
 *    every global binding — so one run cannot leave state for the next run of
 *    the same script. (A frozen prototype makes `obj.toString = f` throw in
 *    strict mode; define such a key with an object literal instead.)
 *  - the result is serialised to JSON INSIDE the time budget and parsed in the
 *    host: what comes back is plain JSON — no functions, no getters;
 *  - an error thrown by the script is read inside the budget too, so a
 *    hostile `message` getter cannot run outside it.
 */
export const RULE_SCRIPT_KINDS = ['filter', 'switch', 'transform', 'generator', 'log', 'details'] as const;
export type RuleScriptKind = (typeof RULE_SCRIPT_KINDS)[number];

export type RuleScriptErrorCode = 'SCRIPT_TIMEOUT' | 'SCRIPT_SYNTAX' | 'SCRIPT_ERROR' | 'SCRIPT_RESULT';

export class RuleScriptError extends Error {
  constructor(public readonly code: RuleScriptErrorCode, message: string, public readonly scriptStack?: string) {
    super(message);
    this.name = 'RuleScriptError';
  }
}

/** One outgoing message of a transform script: the original fills any part the script left out. */
export interface RuleScriptOutput {
  msg: unknown;
  metadata: Record<string, string>;
  msgType: string;
}

/** The names a script may use besides `msg`, `metadata`, `msgType`. */
const ALLOWED_GLOBALS = new Set([
  'JSON', 'Math', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'btoa', 'atob',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Error', 'RegExp',
  'undefined', 'NaN', 'Infinity',
]);
/** Host globals a fresh context does not have, shadowed anyway so a future Node cannot leak one in. */
const ALWAYS_SHADOWED = [
  'globalThis', 'process', 'require', 'module', 'exports', 'Buffer', 'fetch', 'console',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'global', 'window', 'self',
  '__in', '__invoke', '__userFn', '__lock',
];
/** Not usable as a strict-mode parameter name. `eval` stays callable but cannot evaluate a string here. */
const NOT_A_PARAMETER = new Set(['eval', 'arguments']);

const CODE_GENERATION = { strings: false, wasm: false } as const;

let shadowNames: string[] | null = null;
/** Every global of a fresh context the script may not use, plus the host names above. */
function shadowedNames(): string[] {
  if (shadowNames) return shadowNames;
  const probe = vm.runInNewContext('Object.getOwnPropertyNames(globalThis).join("\\n")', {}, {
    contextCodeGeneration: CODE_GENERATION,
  }) as string;
  const names = new Set([...probe.split('\n'), ...ALWAYS_SHADOWED]);
  shadowNames = [...names].filter((n) => n && !ALLOWED_GLOBALS.has(n) && !NOT_A_PARAMETER.has(n) && /^[A-Za-z_$][\w$]*$/.test(n));
  return shadowNames;
}

/**
 * Runs once in each new context, after `__userFn` was placed on it: defines
 * `btoa` / `atob`, the `__invoke` entry point, locks every global binding but
 * the `__in` channel, and freezes every intrinsic reachable from the context.
 * Strict throughout; reads nothing from the host.
 */
const PRELUDE = `(function (g) {
  'use strict';
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function btoa(input) {
    var s = String(input), out = '', i = 0;
    for (var k = 0; k < s.length; k++) {
      if (s.charCodeAt(k) > 255) throw new Error('btoa: the string contains characters outside of the Latin1 range');
    }
    while (i < s.length) {
      var a = s.charCodeAt(i++), b = s.charCodeAt(i++), c = s.charCodeAt(i++);
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
        + (isNaN(b) ? '=' : B64.charAt((n >> 6) & 63)) + (isNaN(c) ? '=' : B64.charAt(n & 63));
    }
    return out;
  }
  function atob(input) {
    var s = String(input).replace(/[\\t\\n\\f\\r ]+/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw new Error('atob: the string is not correctly encoded');
    var out = '', bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
    }
    return out;
  }
  // Captured first: the loop below re-defines every global binding.
  var O = Object, R = Reflect, WS = WeakSet, SYM = Symbol, MAP = Map, SET = Set;
  var parse = JSON.parse, stringify = JSON.stringify, toStr = String, userFn = g.__userFn;
  function __invoke() {
    var input = parse(g.__in);
    try {
      var r = userFn(input.msg, input.metadata, input.msgType);
      return stringify({ ok: true, undef: r === undefined, value: r === undefined ? null : r });
    } catch (e) {
      var name = 'Error', message = '', stack = '';
      try {
        if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
          name = toStr(e.name); message = toStr(e.message); stack = toStr(e.stack || '');
        } else {
          message = toStr(e);
        }
      } catch (inner) { message = 'the script threw a value that could not be read'; }
      return stringify({ ok: false, error: { name: name, message: message, stack: stack } });
    }
  }
  O.defineProperty(g, 'btoa', { value: btoa, writable: false, configurable: false, enumerable: false });
  O.defineProperty(g, 'atob', { value: atob, writable: false, configurable: false, enumerable: false });
  O.defineProperty(g, '__invoke', { value: __invoke, writable: false, configurable: false, enumerable: false });
  var seen = new WS();
  function harden(root) {
    var stack = [root];
    while (stack.length > 0) {
      var o = stack.pop();
      if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o) || o === g) continue;
      seen.add(o);
      O.freeze(o);
      var keys = R.ownKeys(o);
      for (var i = 0; i < keys.length; i++) {
        var d = R.getOwnPropertyDescriptor(o, keys[i]);
        if (!d) continue;
        if ('value' in d) stack.push(d.value); else { stack.push(d.get); stack.push(d.set); }
      }
      stack.push(R.getPrototypeOf(o));
    }
  }
  var names = R.ownKeys(g);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (n === '__in') continue;
    var d = R.getOwnPropertyDescriptor(g, n);
    if (!d) continue;
    if ('value' in d) harden(d.value);
    if (d.configurable || d.writable) {
      // The WHOLE descriptor: a partial one reaches the sandbox through the
      // vm interceptor with no value, and the binding would read undefined.
      var locked = 'value' in d
        ? { value: d.value, writable: false, enumerable: d.enumerable, configurable: false }
        : { get: d.get, set: d.set, enumerable: d.enumerable, configurable: false };
      try { O.defineProperty(g, n, locked); } catch (e) { /* a binding the host owns */ }
    }
  }
  // Intrinsics no global names: iterators, generators, async functions.
  harden(R.getPrototypeOf([][SYM.iterator]()));
  harden(R.getPrototypeOf(''[SYM.iterator]()));
  harden(R.getPrototypeOf(new MAP()[SYM.iterator]()));
  harden(R.getPrototypeOf(new SET()[SYM.iterator]()));
  harden(R.getPrototypeOf(/a/[SYM.matchAll]('a')));
  harden(R.getPrototypeOf(function* () {}));
  harden(R.getPrototypeOf(async function () {}));
  harden(R.getPrototypeOf(async function* () {}));
  harden(userFn);
})(this);`;

const PRELUDE_SCRIPT = new vm.Script(PRELUDE, { filename: 'rule-script-prelude.js' });
const INVOKE_SCRIPT = new vm.Script('__invoke()', { filename: 'rule-script-invoke.js' });

interface CompiledScript {
  sandbox: { __in: string; __userFn?: unknown };
  context: vm.Context;
}

/** Compiled scripts by source, least recently used first. A context costs memory, so the cache is bounded. */
const COMPILED_MAX = 64;
const compiled = new Map<string, CompiledScript>();

function compile(script: string): CompiledScript {
  const hit = compiled.get(script);
  if (hit) {
    compiled.delete(script);
    compiled.set(script, hit);
    return hit;
  }
  const sandbox: CompiledScript['sandbox'] = { __in: '' };
  const context = vm.createContext(sandbox, { codeGeneration: CODE_GENERATION, microtaskMode: 'afterEvaluate' });
  let fn: unknown;
  try {
    fn = vm.compileFunction(`'use strict';\n${script}`, ['msg', 'metadata', 'msgType', ...shadowedNames()], {
      parsingContext: context,
      filename: 'rule-node-script.js',
    });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    throw new RuleScriptError('SCRIPT_SYNTAX', `${err.name ?? 'SyntaxError'}: ${err.message ?? String(e)}`);
  }
  sandbox.__userFn = fn;
  PRELUDE_SCRIPT.runInContext(context, { timeout: 5_000 });
  const entry = { sandbox, context };
  compiled.set(script, entry);
  while (compiled.size > COMPILED_MAX) compiled.delete(compiled.keys().next().value as string);
  return entry;
}

/** Test seam: forget every compiled script. */
export function clearScriptCache(): void {
  compiled.clear();
}

function isTimeout(e: unknown): boolean {
  return (e as { code?: string })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

/** The first `frames` lines of a stack after its message line. */
export function stackFrames(stack: string | undefined, frames = 3): string {
  if (!stack) return '';
  return stack.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, frames).join('\n');
}

/**
 * Run a script body once and return its raw result as plain JSON. Throws
 * `RuleScriptError`: SCRIPT_SYNTAX (does not compile), SCRIPT_TIMEOUT (ran past
 * `timeoutMs`), SCRIPT_ERROR (threw, or returned something JSON cannot carry).
 */
export function runRaw(script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number): unknown {
  let input: string;
  try {
    input = JSON.stringify({ msg: msg === undefined ? null : msg, metadata, msgType });
  } catch (e) {
    throw new RuleScriptError('SCRIPT_ERROR', `The message cannot be given to a script: ${(e as Error).message}`);
  }
  const entry = compile(script);
  entry.sandbox.__in = input;
  let out: string;
  try {
    out = INVOKE_SCRIPT.runInContext(entry.context, { timeout: Math.max(1, Math.floor(timeoutMs)) }) as string;
  } catch (e) {
    // A context interrupted mid-run is not reused.
    compiled.delete(script);
    if (isTimeout(e)) throw new RuleScriptError('SCRIPT_TIMEOUT', `SCRIPT_TIMEOUT: the script ran longer than ${timeoutMs} ms`);
    const err = e as { name?: string; message?: string; stack?: string };
    throw new RuleScriptError('SCRIPT_ERROR', `${err.name ?? 'Error'}: ${err.message ?? String(e)}`, err.stack);
  } finally {
    entry.sandbox.__in = '';
  }
  const parsed = JSON.parse(out) as
    | { ok: true; undef: boolean; value: unknown }
    | { ok: false; error: { name: string; message: string; stack: string } };
  if (!parsed.ok) {
    const { name, message, stack } = parsed.error;
    // A value JSON.stringify refused (a cycle, a BigInt) is the RESULT's fault.
    throw new RuleScriptError('SCRIPT_ERROR', `${name || 'Error'}: ${message}`, stack);
  }
  return parsed.undef ? undefined : parsed.value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** ThingsBoard metadata: every value a string; null / undefined dropped; objects serialised. */
export function coerceMetadata(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (value === undefined || value === null) return { ...fallback };
  if (!isPlainObject(value)) throw new RuleScriptError('SCRIPT_RESULT', 'metadata must be an object of strings');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

function toOutput(value: unknown, msg: unknown, metadata: Record<string, string>, msgType: string): RuleScriptOutput {
  if (!isPlainObject(value)) {
    throw new RuleScriptError('SCRIPT_RESULT', 'A transformation script must return { msg, metadata, msgType } or an array of them');
  }
  const type = value.msgType;
  if (type !== undefined && type !== null && (typeof type !== 'string' || type.trim() === '')) {
    throw new RuleScriptError('SCRIPT_RESULT', 'msgType must be a non-empty string');
  }
  return {
    msg: 'msg' in value && value.msg !== undefined ? value.msg : msg,
    metadata: coerceMetadata(value.metadata, metadata),
    msgType: typeof type === 'string' ? type : msgType,
  };
}

/**
 * Run a node script and shape its result by KIND (ThingsBoard's contracts):
 *  - filter → `true` / `false` (anything else is SCRIPT_RESULT);
 *  - switch → the relation names, ALWAYS an array (a single string is wrapped);
 *  - transform → the outgoing messages, ALWAYS an array (a single
 *    `{ msg, metadata, msgType }` is wrapped; a part left out keeps the
 *    original; metadata values coerced to strings);
 *  - generator / log / details → the script's own return value, as JSON.
 */
export function runScript(
  kind: 'filter', script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number,
): boolean;
export function runScript(
  kind: 'switch', script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number,
): string[];
export function runScript(
  kind: 'transform', script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number,
): RuleScriptOutput[];
export function runScript(
  kind: RuleScriptKind, script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number,
): unknown;
export function runScript(
  kind: RuleScriptKind, script: string, msg: unknown, metadata: Record<string, string>, msgType: string, timeoutMs: number,
): unknown {
  const result = runRaw(script, msg, metadata, msgType, timeoutMs);
  switch (kind) {
    case 'filter':
      if (typeof result !== 'boolean') throw new RuleScriptError('SCRIPT_RESULT', 'A filter script must return true or false');
      return result;
    case 'switch': {
      const list = typeof result === 'string' ? [result] : result;
      if (!Array.isArray(list) || list.some((r) => typeof r !== 'string')) {
        throw new RuleScriptError('SCRIPT_RESULT', 'A switch script must return a relation name or an array of relation names');
      }
      return list as string[];
    }
    case 'transform': {
      const list = Array.isArray(result) ? result : [result];
      return list.map((r) => toOutput(r, msg, metadata, msgType));
    }
    default:
      return result;
  }
}
