import { describe, it, expect, beforeEach } from 'vitest';
import { runScript, runRaw, RuleScriptError, clearScriptCache, clearScriptStrikes, stackFrames, SCRIPT_DISABLED_MESSAGE } from '../script-vm.js';

/**
 * The node-script time-box (spec §6, script-vm.ts). Pins ThingsBoard's script
 * contracts per kind, the time budget, and what a script can and cannot name.
 */
const MD = { instrumentCode: 'CWH/RDU/001-00' };
const T = 'POST_TELEMETRY_REQUEST';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RuleScriptError);
    return (e as RuleScriptError).code;
  }
  throw new Error('expected a RuleScriptError');
}

beforeEach(() => { clearScriptCache(); clearScriptStrikes(); });

describe('filter', () => {
  it('returns the script\'s boolean', () => {
    expect(runScript('filter', 'return msg.temperature > 10;', { temperature: 12 }, MD, T, 2000)).toBe(true);
    expect(runScript('filter', 'return msg.temperature > 10;', { temperature: 5 }, MD, T, 2000)).toBe(false);
  });

  it('refuses a non-boolean result', () => {
    expect(codeOf(() => runScript('filter', 'return 1;', {}, MD, T, 2000))).toBe('SCRIPT_RESULT');
  });

  it('sees metadata and msgType', () => {
    expect(runScript('filter', 'return metadata.instrumentCode === "CWH/RDU/001-00" && msgType === "POST_TELEMETRY_REQUEST";', {}, MD, T, 2000)).toBe(true);
  });
});

describe('the time budget', () => {
  it('while(true){} is stopped with SCRIPT_TIMEOUT well within 2 s', () => {
    const started = Date.now();
    expect(codeOf(() => runScript('filter', 'while (true) {}', {}, MD, T, 200))).toBe('SCRIPT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a script interrupted by its budget runs again normally', () => {
    const script = 'if (msg.spin) { while (true) {} } return true;';
    expect(codeOf(() => runScript('filter', script, { spin: true }, MD, T, 100))).toBe('SCRIPT_TIMEOUT');
    expect(runScript('filter', script, { spin: false }, MD, T, 2000)).toBe(true);
  });

  it('a promise loop cannot run past the budget (microtasks are inside it)', () => {
    const script = 'var p = Promise; return true;'; // Promise is shadowed: undefined, not an escape
    expect(runScript('filter', script, {}, MD, T, 2000)).toBe(true);
    const loop = 'async function f() { while (true) { await 0; } } f(); return true;';
    expect(codeOf(() => runScript('filter', loop, {}, MD, T, 200))).toBe('SCRIPT_TIMEOUT');
  });
});

describe('what a script can name', () => {
  it('process, require, globalThis, fetch, timers and console are undefined', () => {
    const script = `return [typeof process, typeof require, typeof globalThis, typeof fetch, typeof setTimeout,
      typeof setImmediate, typeof console, typeof Function, typeof Reflect, typeof Proxy, typeof Buffer, typeof module];`;
    const result = runRaw(script, {}, MD, T, 2000) as string[];
    expect(result).toEqual(Array(12).fill('undefined'));
  });

  it('this is undefined (strict mode)', () => {
    expect(runRaw('return typeof this;', {}, MD, T, 2000)).toBe('undefined');
  });

  it('code generation from strings is off: new Function / a constructor\'s constructor throw', () => {
    expect(codeOf(() => runRaw('return (function(){}).constructor("return 1")();', {}, MD, T, 2000))).toBe('SCRIPT_ERROR');
    expect(() => runRaw('return (function(){}).constructor("return 1")();', {}, MD, T, 2000)).toThrow(/Code generation from strings disallowed/);
    // msg was parsed INSIDE the context: its constructor's constructor is the context's disabled Function.
    expect(() => runRaw('return msg.constructor.constructor("return process")();', {}, MD, T, 2000)).toThrow(/Code generation from strings disallowed/);
    expect(() => runRaw('return eval("1 + 1");', {}, MD, T, 2000)).toThrow(/Code generation from strings disallowed/);
  });

  it('the ThingsBoard helper surface is there', () => {
    const script = `return [JSON.stringify({ a: 1 }), Math.max(1, 2), typeof Date.now(), parseInt('42'), parseFloat('1.5'),
      isNaN('x'), isFinite(1), String(1), Number('2'), Boolean(1), Array.isArray([]), Object.keys({ k: 1 }),
      btoa('hello'), atob('aGVsbG8='), new Error('e').message, new RegExp('^a').test('ab')];`;
    expect(runRaw(script, {}, MD, T, 2000)).toEqual(['{"a":1}', 2, 'number', 42, 1.5, true, true, '1', 2, true, true, ['k'], 'aGVsbG8=', 'hello', 'e', true]);
  });

  it('a script cannot leave state for its next run (the context is frozen)', () => {
    const script = `
      if (msg.first) {
        try { Object.prototype.leak = 1; } catch (e) {}
        try { Math.mine = 1; } catch (e) {}
        try { JSON = 1; } catch (e) {}
        try { Array.prototype.push = function () {}; } catch (e) {}
      }
      return ({}).leak === undefined && Math.mine === undefined && typeof JSON.parse === 'function' && [1].concat([2]).length === 2;`;
    expect(runScript('filter', script, { first: true }, MD, T, 2000)).toBe(true);
    expect(runScript('filter', script, { first: false }, MD, T, 2000)).toBe(true);
  });

  it('the body cannot close its own function early', () => {
    expect(codeOf(() => runRaw('return 1; }); (function () {', {}, MD, T, 2000))).toBe('SCRIPT_SYNTAX');
    expect(codeOf(() => runRaw('return (', {}, MD, T, 2000))).toBe('SCRIPT_SYNTAX');
  });

  it('a thrown error is SCRIPT_ERROR with its message, and the stack is trimmed to frames', () => {
    try {
      runRaw('throw new Error("boom");', {}, MD, T, 2000);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as RuleScriptError).code).toBe('SCRIPT_ERROR');
      expect((e as RuleScriptError).message).toBe('Error: boom');
      expect(stackFrames((e as RuleScriptError).scriptStack).split('\n').length).toBeLessThanOrEqual(3);
    }
    expect(() => runRaw('throw "plain text";', {}, MD, T, 2000)).toThrow('plain text');
  });

  it('a hostile error getter runs inside the budget, not outside it', () => {
    const script = 'throw { get message() { while (true) {} } };';
    expect(codeOf(() => runRaw(script, {}, MD, T, 200))).toBe('SCRIPT_TIMEOUT');
  });
});

describe('a script that keeps timing out is disabled (review I6)', () => {
  const loop = 'if (msg.spin) { while (true) {} } return true;';
  const key = 'chain-1:node-1:1000';

  it('three CONSECUTIVE time-outs → SCRIPT_DISABLED at once, without entering the VM', () => {
    for (let i = 0; i < 3; i++) expect(codeOf(() => runScript('filter', loop, { spin: true }, MD, T, 50, { key }))).toBe('SCRIPT_TIMEOUT');
    const started = Date.now();
    try {
      runScript('filter', loop, { spin: false }, MD, T, 50, { key });
      throw new Error('expected SCRIPT_DISABLED');
    } catch (e) {
      expect((e as RuleScriptError).code).toBe('SCRIPT_DISABLED');
      expect((e as RuleScriptError).message).toBe(SCRIPT_DISABLED_MESSAGE);
    }
    // Did not run: a disabled script cannot even return true for a message that would not loop.
    expect(Date.now() - started).toBeLessThan(40);
  });

  it('a run that ends any other way resets the count', () => {
    for (let i = 0; i < 2; i++) codeOf(() => runScript('filter', loop, { spin: true }, MD, T, 50, { key }));
    expect(runScript('filter', loop, { spin: false }, MD, T, 2000, { key })).toBe(true);
    for (let i = 0; i < 2; i++) codeOf(() => runScript('filter', loop, { spin: true }, MD, T, 50, { key }));
    expect(runScript('filter', loop, { spin: false }, MD, T, 2000, { key })).toBe(true);
  });

  it('another node, another chain version (a save) or another script text is not disabled; no key = never disabled', () => {
    for (let i = 0; i < 3; i++) codeOf(() => runScript('filter', loop, { spin: true }, MD, T, 50, { key }));
    expect(codeOf(() => runScript('filter', loop, { spin: false }, MD, T, 2000, { key }))).toBe('SCRIPT_DISABLED');
    expect(runScript('filter', loop, { spin: false }, MD, T, 2000, { key: 'chain-1:node-2:1000' })).toBe(true);
    expect(runScript('filter', loop, { spin: false }, MD, T, 2000, { key: 'chain-1:node-1:2000' })).toBe(true);
    expect(runScript('filter', `${loop} `, { spin: false }, MD, T, 2000, { key })).toBe(true);
    for (let i = 0; i < 4; i++) expect(codeOf(() => runScript('filter', loop, { spin: true }, MD, T, 50))).toBe('SCRIPT_TIMEOUT');
  });
});

describe('results are plain JSON', () => {
  it('functions vanish, dates become ISO text', () => {
    expect(runRaw('return { f: function () {}, d: new Date(0), n: 1 };', {}, MD, T, 2000)).toEqual({ d: '1970-01-01T00:00:00.000Z', n: 1 });
  });

  it('undefined comes back as undefined; a cycle is SCRIPT_ERROR', () => {
    expect(runRaw('return;', {}, MD, T, 2000)).toBeUndefined();
    expect(codeOf(() => runRaw('var a = {}; a.a = a; return a;', {}, MD, T, 2000))).toBe('SCRIPT_ERROR');
  });

  it('the input is a copy: a script changing msg changes nothing outside', () => {
    const msg = { t: 1 };
    runRaw('msg.t = 99; return msg;', msg, MD, T, 2000);
    expect(msg).toEqual({ t: 1 });
  });
});

describe('switch', () => {
  it('a string becomes one relation, an array several', () => {
    expect(runScript('switch', 'return "High";', {}, MD, T, 2000)).toEqual(['High']);
    expect(runScript('switch', 'return ["a", "b"];', {}, MD, T, 2000)).toEqual(['a', 'b']);
  });

  it('anything else is SCRIPT_RESULT', () => {
    expect(codeOf(() => runScript('switch', 'return [1];', {}, MD, T, 2000))).toBe('SCRIPT_RESULT');
    expect(codeOf(() => runScript('switch', 'return null;', {}, MD, T, 2000))).toBe('SCRIPT_RESULT');
  });
});

describe('transform', () => {
  it('an array yields two messages', () => {
    const out = runScript('transform', `return [
      { msg: { a: 1 }, metadata: metadata, msgType: 'ONE' },
      { msg: { b: 2 }, metadata: metadata, msgType: 'TWO' },
    ];`, { x: 0 }, MD, T, 2000);
    expect(out).toHaveLength(2);
    expect(out.map((o) => [o.msg, o.msgType])).toEqual([[{ a: 1 }, 'ONE'], [{ b: 2 }, 'TWO']]);
  });

  it('metadata values are coerced to strings; null values dropped', () => {
    const [out] = runScript('transform', 'return { msg: msg, metadata: { a: 1, b: true, c: { x: 1 }, d: null, e: "s" }, msgType: msgType };', {}, MD, T, 2000);
    expect(out.metadata).toEqual({ a: '1', b: 'true', c: '{"x":1}', e: 's' });
  });

  it('a part the script leaves out keeps the original', () => {
    const [out] = runScript('transform', 'return { msg: { t: msg.t * 2 } };', { t: 2 }, MD, T, 2000);
    expect(out).toEqual({ msg: { t: 4 }, metadata: MD, msgType: T });
  });

  it('a non-object result is SCRIPT_RESULT', () => {
    expect(codeOf(() => runScript('transform', 'return 5;', {}, MD, T, 2000))).toBe('SCRIPT_RESULT');
    expect(codeOf(() => runScript('transform', 'return { msgType: "" };', {}, MD, T, 2000))).toBe('SCRIPT_RESULT');
  });
});

describe('generator / log / details return their own value', () => {
  it('log returns its string', () => {
    expect(runScript('log', 'return "Incoming message:\\n" + JSON.stringify(msg);', { a: 1 }, MD, T, 2000)).toBe('Incoming message:\n{"a":1}');
  });
  it('details returns its object', () => {
    expect(runScript('details', 'return { temp: msg.t };', { t: 30 }, MD, T, 2000)).toEqual({ temp: 30 });
  });
});
