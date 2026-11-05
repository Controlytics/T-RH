import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRuleEngine, type RuleEngine } from '../engine.js';
import { registerNode, getHandler } from '../registry.js';
import { registerAllNodes } from '../nodes/index.js';
import { runRuleEngineMessage, ruleEngineMessageTask } from '../../../workers/rule-engine-message.worker.js';
import { serialisableMessage, ruleNodeOrigin } from '../message.js';
import { clearScriptStrikes } from '../script-vm.js';
import { newMessage, type RuleMessage } from '../message.js';
import { currentReentryDepth } from '../context.js';
import { emitTelemetry, emitCounters, resetEmitCounters } from '../emit.js';
import { chainOf, docOf, nodeOf, memoryDeps, fakeServices, fakeContext, testMessage } from '../../../test-support/rule-engine.js';
import type { LoadedRuleChain } from '../service.js';
import { RULE_ENGINE_CONFIG_DEFAULTS } from '../config.js';

/**
 * The processor (spec §6): routing on the returned relation, Failure on a
 * throw, the end of a message at an unconnected relation, the hop limit, Rule
 * chain → Output, debug modes, late emissions, the budget. No database: the
 * chains, the debug sink and the services are in memory.
 */
const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

/** A test node type whose handler is `fn`. */
function type(id: string, fn: Parameters<typeof registerNode>[1], opts?: Parameters<typeof registerNode>[2]): string {
  restores.push(registerNode(id, fn, opts));
  return id;
}

function engineFor(chains: LoadedRuleChain[], config = {}) {
  const mem = memoryDeps(chains, config);
  const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
  return { engine, events: mem.events };
}

const received = (log: { node: string; msg: RuleMessage }[], node: string) => log.filter((e) => e.node === node);

describe('routing', () => {
  it('a two-node chain routes on the relation the handler returns', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const route = type('test:route', (ctx, msg) => ctx.tellNext(msg, (msg.data as { go: string }).go));
    const sink = type('test:sink', (ctx, msg) => { log.push({ node: ctx.node.name, msg }); });
    const a = nodeOf(route, 'A');
    const yes = nodeOf(sink, 'YES');
    const no = nodeOf(sink, 'NO');
    const chain = chainOf('c', docOf([a, yes, no], [[a, 'yes', yes], [a, 'no', no]]), { root: true });
    const { engine } = engineFor([chain]);
    await engine.processNow(testMessage({ go: 'yes' }));
    await engine.processNow(testMessage({ go: 'no' }));
    expect(received(log, 'YES').map((e) => (e.msg.data as { go: string }).go)).toEqual(['yes']);
    expect(received(log, 'NO').map((e) => (e.msg.data as { go: string }).go)).toEqual(['no']);
  });

  it('several relations and several targets: each delivery is its own copy', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const route = type('test:fan', (ctx, msg) => ctx.tellNext(msg, ['x', 'y']));
    const mutate = type('test:mutate', (ctx, msg) => { (msg.data as { v: number }).v = 99; log.push({ node: ctx.node.name, msg }); });
    const a = nodeOf(route, 'A');
    const b = nodeOf(mutate, 'B');
    const c = nodeOf(mutate, 'C');
    const d = nodeOf(mutate, 'D');
    const chain = chainOf('c', docOf([a, b, c, d], [[a, 'x', b], [a, 'x', c], [a, 'y', d]]), { root: true });
    const original = testMessage({ v: 1 });
    await engineFor([chain]).engine.processNow(original);
    expect(log.map((e) => e.node).sort()).toEqual(['B', 'C', 'D']);
    // Three objects, none of them the same, and the original untouched by any branch.
    expect(new Set(log.map((e) => e.msg)).size).toBe(3);
  });

  it('a handler that THROWS goes out on Failure with metadata.error and three stack frames', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const boom = type('test:boom', () => { throw new Error('kaput'); });
    const sink = type('test:sink2', (ctx, msg) => { log.push({ node: ctx.node.name, msg }); });
    const a = nodeOf(boom, 'A');
    const f = nodeOf(sink, 'F');
    const chain = chainOf('c', docOf([a, f], [[a, 'Failure', f]]), { root: true });
    await engineFor([chain]).engine.processNow(testMessage({ t: 1 }));
    const [hit] = received(log, 'F');
    expect(hit.msg.metadata.error).toBe('kaput');
    const frames = hit.msg.metadata.errorStack.split('\n');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(3);
    expect(frames.every((l) => l.startsWith('at '))).toBe(true);
  });

  it('a node type with no handler sends the message to Failure (UNSUPPORTED_NODE)', async () => {
    const log: RuleMessage[] = [];
    const sink = type('test:sink3', (_ctx, msg) => { log.push(msg); });
    const a = nodeOf('test:nobody-registered-this', 'Ghost');
    const f = nodeOf(sink, 'F');
    const chain = chainOf('c', docOf([a, f], [[a, 'Failure', f]]), { root: true });
    await engineFor([chain]).engine.processNow(testMessage({}));
    expect(log[0].metadata.error).toMatch(/^UNSUPPORTED_NODE/);
  });
});

describe('the Unsupported node (nodes/unsupported.ts)', () => {
  it('registerAllNodes registers tb:unsupported: Failure naming the ThingsBoard class', async () => {
    registerAllNodes();
    const handler = getHandler('tb:unsupported');
    expect(handler).toBeDefined();
    const { ctx, calls } = fakeContext({ type: 'tb:unsupported', config: { tbClass: 'org.thingsboard.rule.engine.pe.Foo' } });
    await handler!.handler(ctx, testMessage({}));
    expect(calls.failures.map((f) => f.error)).toEqual(['UNSUPPORTED_NODE: "org.thingsboard.rule.engine.pe.Foo" has no handler in this system']);
  });
});

describe('the end of a message, and debug', () => {
  it('an unhandled Failure ends the message: debug IN + OUT "Failure (unhandled)" with the error', async () => {
    const boom = type('test:boom2', () => { throw new Error('nope'); });
    const a = nodeOf(boom, 'A', { debugMode: 'all' });
    const chain = chainOf('c', docOf([a], []), { root: true });
    const { engine, events } = engineFor([chain]);
    await engine.processNow(testMessage({}));
    expect(events.map((e) => [e.direction, e.relation, e.error ?? null])).toEqual([
      ['IN', null, null],
      ['OUT', 'Failure (unhandled)', 'nope'],
    ]);
  });

  it('any other unconnected relation is recorded as "<relation> (unconnected)"', async () => {
    const ok = type('test:ok', (ctx, msg) => ctx.tellNext(msg, 'Success'));
    const a = nodeOf(ok, 'A', { debugMode: 'all' });
    const { engine, events } = engineFor([chainOf('c', docOf([a], []), { root: true })]);
    await engine.processNow(testMessage({}));
    expect(events.map((e) => `${e.direction} ${e.relation}`)).toEqual(['IN null', 'OUT Success (unconnected)']);
  });

  it('debugMode off records nothing; failures records only the IN and OUT of a Failure', async () => {
    const pick = type('test:pick', (ctx, msg) => {
      if ((msg.data as { fail: boolean }).fail) throw new Error('bad');
      ctx.tellNext(msg, 'Success');
    });
    const quiet = nodeOf(pick, 'Quiet', { debugMode: 'off' });
    const failures = nodeOf(pick, 'OnlyFailures', { debugMode: 'failures' });
    const sinkType = type('test:end', () => undefined);
    const end = nodeOf(sinkType, 'End', { debugMode: 'off' });
    const chain = chainOf('c', docOf([quiet, failures, end], [[quiet, 'Success', failures], [failures, 'Success', end]]), { root: true });
    const { engine, events } = engineFor([chain]);
    await engine.processNow(testMessage({ fail: false }));
    expect(events).toEqual([]);
    // Quiet fails first on this one, and records nothing (off).
    await engine.processNow(testMessage({ fail: true }));
    expect(events).toEqual([]);
    // A failure AT the 'failures' node: route it there by making Quiet pass.
    const passThrough = type('test:pass', (ctx, msg) => ctx.tellNext(msg, 'Success'));
    const first = nodeOf(passThrough, 'First');
    const watched = nodeOf(pick, 'Watched', { debugMode: 'failures' });
    const chain2 = chainOf('c2', docOf([first, watched], [[first, 'Success', watched]]), { root: true });
    const e2 = engineFor([chain2]);
    await e2.engine.processNow(testMessage({ fail: false }));
    expect(e2.events).toEqual([]);
    await e2.engine.processNow(testMessage({ fail: true }));
    expect(e2.events.map((e) => [e.nodeId, e.direction, e.relation])).toEqual([
      [watched.id, 'IN', 'Success'],
      [watched.id, 'OUT', 'Failure (unhandled)'],
    ]);
  });

  it('an OUT row carries the OUTGOING message (a transform\'s new data)', async () => {
    const tx = type('test:tx', (ctx, msg) => ctx.tellNext({ ...msg, data: { changed: true } }, 'Success'));
    const a = nodeOf(tx, 'A', { debugMode: 'all' });
    const { engine, events } = engineFor([chainOf('c', docOf([a], []), { root: true })]);
    await engine.processNow(testMessage({ changed: false }));
    expect(events[0].msg.data).toEqual({ changed: false });
    expect(events[1].msg.data).toEqual({ changed: true });
  });
});

describe('the hop limit', () => {
  it('a node connected to itself stops at 200 hops with HOP_LIMIT', async () => {
    let calls = 0;
    const loop = type('test:loop', (ctx, msg) => { calls++; ctx.tellNext(msg, 'Success'); });
    const a = nodeOf(loop, 'A', { debugMode: 'failures' });
    const chain = chainOf('c', docOf([a], [[a, 'Success', a]]), { root: true });
    const { engine, events } = engineFor([chain], { hopLimit: 200 });
    await engine.processNow(testMessage({}));
    expect(calls).toBe(200);
    const out = events.filter((e) => e.direction === 'OUT');
    expect(out).toHaveLength(1);
    expect(out[0].relation).toBe('Failure (unhandled)');
    expect(out[0].error).toBe('HOP_LIMIT');
    expect(out[0].msg.metadata.error).toBe('HOP_LIMIT');
    expect(engine.stats().counters.hop_limit).toBe(1);
  });
});

/**
 * C1 (whole-branch review A, 2026-11-05): a flow of SYNCHRONOUS nodes awaited only
 * resolved promises, so it never gave the event loop back — and `_hops` is counted
 * per copy, so a fan-out cycle never reached the hop limit: the probe held the loop
 * for the whole 3 s budget. Now a flow yields (setImmediate) after ~10 ms of work, a
 * flow ends after hopLimit × 10 node runs over ALL its copies (STEP_LIMIT), and the
 * budget is Configuration → Rule Engine's `messageBudgetMs`.
 */
describe('no flow holds the event loop (C1)', () => {
  const SWITCH_TYPE = 'tb:filter:message-type-switch';

  /** S1 → S2 and S3, both back to S1, on 'Post telemetry': the review's probe, on the REAL Message Type Switch. */
  function fanOutCycle(debugMode: 'off' | 'failures' = 'off') {
    registerAllNodes();
    const s1 = nodeOf(SWITCH_TYPE, 'S1', { debugMode });
    const s2 = nodeOf(SWITCH_TYPE, 'S2', { debugMode });
    const s3 = nodeOf(SWITCH_TYPE, 'S3', { debugMode });
    return chainOf('fan', docOf([s1, s2, s3], [
      [s1, 'Post telemetry', s2], [s1, 'Post telemetry', s3], [s2, 'Post telemetry', s1], [s3, 'Post telemetry', s1],
    ]), { root: true });
  }

  it('a fan-out cycle from the root: a 5 ms timer fires WHILE the flow still runs, within ~50 ms', async () => {
    // hopLimit 1000 → a 10 000-step flow (~0.65 s of switch work here): long enough that only a
    // yield can let the timer in before it ends.
    const { engine } = engineFor([fanOutCycle()], { hopLimit: 1_000, messageBudgetMs: 60_000 });
    let flowDone = false;
    let firedAfter = -1;
    let firedWhileRunning = false;
    const t0 = Date.now();
    setTimeout(() => { firedAfter = Date.now() - t0; firedWhileRunning = !flowDone; }, 5);
    await engine.processNow(testMessage({ t: 1 }));
    flowDone = true;
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 20));
    expect(firedWhileRunning, `the timer fired after ${firedAfter} ms; the flow took ${elapsed} ms`).toBe(true);
    expect(firedAfter).toBeLessThan(50);
    expect(elapsed).toBeGreaterThan(firedAfter);
    expect(engine.stats().counters.step_limit).toBe(1);
  });

  it('… and with the default limits it ends at the STEP LIMIT long before the budget: debug IN + OUT "Failure (unhandled)" STEP_LIMIT', async () => {
    const { engine, events } = engineFor([fanOutCycle('failures')]);
    const t0 = Date.now();
    await engine.processNow(testMessage({ t: 1 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    const c = engine.stats().counters;
    expect(c.step_limit).toBe(1);
    expect(c.timeouts ?? 0).toBe(0);
    expect(c.hop_limit ?? 0).toBe(0);
    expect(c.steps_abandoned).toBeGreaterThan(0);
    expect(events.map((e) => `${e.direction} ${e.relation} ${e.error ?? ''}`.trim())).toEqual([
      'IN Post telemetry', 'OUT Failure (unhandled) STEP_LIMIT',
    ]);
    expect(events[1].msg.metadata.error).toBe('STEP_LIMIT');
  });

  it('the step limit is hopLimit × 10 node runs, counted over EVERY copy of the message', async () => {
    let runs = 0;
    const fan = type('test:c1-fan', (ctx, msg) => { runs++; ctx.tellNext(msg, 'Success'); });
    const a = nodeOf(fan, 'A');
    const b = nodeOf(fan, 'B');
    // A → A and B, B → A: every copy is a fresh lineage, far under the hop limit of 20.
    const chain = chainOf('c', docOf([a, b], [[a, 'Success', a], [a, 'Success', b], [b, 'Success', a]]), { root: true });
    const { engine } = engineFor([chain], { hopLimit: 20 });
    await engine.processNow(testMessage({}));
    expect(runs).toBe(200);
    expect(engine.stats().counters.step_limit).toBe(1);
  });

  it('a plain cycle (no fan-out) still ends at the HOP limit, not the step limit', async () => {
    let runs = 0;
    const loop = type('test:c1-loop', (ctx, msg) => { runs++; ctx.tellNext(msg, 'Success'); });
    const a = nodeOf(loop, 'A');
    const { engine } = engineFor([chainOf('c', docOf([a], [[a, 'Success', a]]), { root: true })], { hopLimit: 20 });
    await engine.processNow(testMessage({}));
    expect(runs).toBe(20);
    expect(engine.stats().counters.hop_limit).toBe(1);
    expect(engine.stats().counters.step_limit ?? 0).toBe(0);
  });

  it('the message budget is Configuration → Rule Engine\'s messageBudgetMs', async () => {
    const slow = type('test:c1-slow', () => new Promise<void>(() => undefined));
    const a = nodeOf(slow, 'A', { debugMode: 'all' });
    const mem = memoryDeps([chainOf('c', docOf([a], []), { root: true })], { messageBudgetMs: 150 });
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      const t0 = Date.now();
      expect(engine.enqueue(testMessage({}))).toBe(true);
      await waitFor(() => mem.events.length === 2, 3_000);
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(mem.events[1].error).toBe('MESSAGE_TIMEOUT');
    } finally {
      await engine.stop();
    }
  });

  it('the re-entry depth survives a yield: a depth-1 flow busy for > 10 ms before its write still emits nothing (loop_skipped)', async () => {
    resetEmitCounters();
    const seen: number[] = [];
    const busy = type('test:c1-busy', (ctx, msg) => { const until = Date.now() + 15; while (Date.now() < until) { /* spin */ } ctx.tellNext(msg, 'Success'); });
    const write = type('test:c1-write', async (ctx, msg) => {
      seen.push(currentReentryDepth());
      await emitTelemetry(msg.originator.id, [{ key: 't', value: 1, ts: new Date() }], 'rule-engine', ctx.origin);
    });
    const b = nodeOf(busy, 'Busy');
    const b2 = nodeOf(busy, 'Busy2');
    const w = nodeOf(write, 'W');
    const chain = chainOf('c', docOf([b, b2, w], [[b, 'Success', b2], [b2, 'Success', w]]), { root: true, reEnterOnRuleNodeWrites: true });
    const mem = memoryDeps([chain]);
    const engine = createRuleEngine({ ...mem.deps, installSink: true, lifecyclePollMs: 3_600_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({}, { originator: { id: 'X' }, metadata: { rule_engine_origin: ruleNodeOrigin(chain.id, w.id) } }));
      await waitFor(() => seen.length >= 1);
      await engine.drain();
      expect(seen).toEqual([1]);
      expect(emitCounters().loop_skipped).toBe(1);
    } finally {
      await engine.stop();
    }
  });

  it('stop() halts a flow still running once its wait for in-flight messages is over: no node runs after stop() resolved', async () => {
    let runs = 0;
    const loop = type('test:c1-forever', (ctx, msg) => { runs++; const until = Date.now() + 2; while (Date.now() < until) { /* spin */ } ctx.tellNext(msg, 'Success'); });
    const a = nodeOf(loop, 'A');
    const mem = memoryDeps([chainOf('c', docOf([a], [[a, 'Success', a]]), { root: true })], { hopLimit: 10_000, messageBudgetMs: 60_000 });
    const engine = createRuleEngine({ ...mem.deps, stopWaitMs: 50, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    engine.enqueue(testMessage({}));
    await waitFor(() => runs > 5);
    await engine.stop();
    const atStop = runs;
    await new Promise((r) => setTimeout(r, 100));
    expect(runs - atStop).toBe(0);
    expect(engine.stats().counters.halted_on_stop).toBe(1);
  });
});

describe('Rule chain and Output', () => {
  it('Output returns to the CALLER node\'s connections under the Output node\'s NAME', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const calleeId = '0f000000-0000-4000-8000-0000000000c2';
    const callType = type('test:call', async (ctx, msg) => { await ctx.callChain(calleeId, msg); });
    const outType = type('test:output', (ctx, msg) => ctx.output(msg, ctx.node.name));
    const sink = type('test:sink4', (ctx, msg) => { log.push({ node: ctx.node.name, msg }); });
    const call = nodeOf(callType, 'Call');
    const after = nodeOf(sink, 'AfterDone');
    const other = nodeOf(sink, 'AfterOther');
    const caller = chainOf('caller', docOf([call, after, other], [[call, 'Done', after], [call, 'Other', other]]), { root: true });
    const out = nodeOf(outType, 'Done');
    const callee = chainOf('callee', docOf([out], []), { id: calleeId });
    await engineFor([caller, callee]).engine.processNow(testMessage({ v: 1 }));
    expect(log.map((e) => e.node)).toEqual(['AfterDone']);
    expect(log[0].msg._stack ?? []).toEqual([]);
  });

  it('callChain to a missing chain goes out on Failure', async () => {
    const log: RuleMessage[] = [];
    const callType = type('test:call-missing', async (ctx, msg) => { await ctx.callChain('0f000000-0000-4000-8000-00000000dead', msg); });
    const sink = type('test:sink5', (_ctx, msg) => { log.push(msg); });
    const call = nodeOf(callType, 'Call');
    const f = nodeOf(sink, 'F');
    await engineFor([chainOf('c', docOf([call, f], [[call, 'Failure', f]]), { root: true })]).engine.processNow(testMessage({}));
    expect(log).toHaveLength(1);
    expect(log[0].metadata.error).toMatch(/^RULE_CHAIN_NOT_FOUND/);
  });

  it('a chain with no Output ends the message there', async () => {
    const log: string[] = [];
    const calleeId = '0f000000-0000-4000-8000-0000000000c3';
    const callType = type('test:call2', async (ctx, msg) => { await ctx.callChain(calleeId, msg); });
    const inner = type('test:inner', (ctx) => { log.push(ctx.node.name); });
    const sink = type('test:sink6', (ctx) => { log.push(ctx.node.name); });
    const call = nodeOf(callType, 'Call');
    const after = nodeOf(sink, 'After');
    const caller = chainOf('caller', docOf([call, after], [[call, 'Success', after]]), { root: true });
    const callee = chainOf('callee', docOf([nodeOf(inner, 'Inner')], []), { id: calleeId });
    await engineFor([caller, callee]).engine.processNow(testMessage({}));
    expect(log).toEqual(['Inner']);
  });

  it('an Output in a chain nobody called ends the message as "<label> (no caller)"', async () => {
    const outType = type('test:output2', (ctx, msg) => ctx.output(msg, ctx.node.name));
    const out = nodeOf(outType, 'Done', { debugMode: 'all' });
    const { engine, events } = engineFor([chainOf('c', docOf([out], []), { root: true })]);
    await engine.processNow(testMessage({}));
    expect(events.map((e) => `${e.direction} ${e.relation}`)).toEqual(['IN null', 'OUT Done (no caller)']);
  });
});

describe('late emissions, tellSelf and the budget', () => {
  it('a tellNext AFTER the handler settled starts a new message at the node\'s connections', async () => {
    const log: string[] = [];
    const late = type('test:late', (ctx, msg) => { setTimeout(() => ctx.tellNext(msg, 'Success'), 10); });
    const sink = type('test:sink7', (ctx) => { log.push(ctx.node.name); });
    const a = nodeOf(late, 'A');
    const b = nodeOf(sink, 'B');
    const mem = memoryDeps([chainOf('c', docOf([a, b], [[a, 'Success', b]]), { root: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      expect(engine.enqueue(testMessage({}))).toBe(true);
      await waitFor(() => log.length === 1);
      expect(log).toEqual(['B']);
    } finally {
      await engine.stop();
    }
  });

  it('tellSelf delivers the message to the same node again', async () => {
    const seen: number[] = [];
    const again = type('test:again', async (ctx, msg) => {
      const n = (msg.data as { n: number }).n;
      seen.push(n);
      if (n < 2) await ctx.tellSelf({ ...msg, data: { n: n + 1 } }, 5);
    });
    const a = nodeOf(again, 'A');
    const mem = memoryDeps([chainOf('c', docOf([a], []), { root: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({ n: 0 }));
      await waitFor(() => seen.length === 3);
      expect(seen).toEqual([0, 1, 2]);
    } finally {
      await engine.stop();
    }
  });

  it('a handler that outlives the message budget ends it on MESSAGE_TIMEOUT; its late calls are dropped', async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = type('test:slow', async (ctx, msg) => {
      await new Promise<void>((r) => { release = r; });
      ctx.tellNext(msg, 'Success');
    });
    const sink = type('test:sink8', (ctx) => { log.push(ctx.node.name); });
    const a = nodeOf(slow, 'A', { debugMode: 'all' });
    const b = nodeOf(sink, 'B');
    const mem = memoryDeps([chainOf('c', docOf([a, b], [[a, 'Success', b]]), { root: true })]);
    const engine = createRuleEngine({ ...mem.deps, budgetMs: 50, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    // STARTED, so the engine is accepting: only the abandoned message can be why the late call is dropped.
    await engine.start();
    try {
      expect(engine.enqueue(testMessage({}))).toBe(true);
      await waitFor(() => mem.events.length === 2);
      expect(mem.events.map((e) => `${e.direction} ${e.relation} ${e.error ?? ''}`.trim())).toEqual([
        'IN null', 'OUT Failure (unhandled) MESSAGE_TIMEOUT',
      ]);
      release();
      await new Promise((r) => setTimeout(r, 30));
      await engine.drain();
      expect(log).toEqual([]);
      expect(engine.stats().counters.late_dropped).toBe(1);
    } finally {
      await engine.stop();
    }
  });
});

describe('node lifecycles (onInit / onDestroy)', () => {
  type Seen = { event: 'init' | 'destroy'; nodeKey: string; config: unknown };

  function lifecycleType(id: string, seen: Seen[], opts: { failFirst?: boolean; keep?: (ctx: import('../context.js').RuleContext) => void } = {}) {
    let failures = opts.failFirst ? 1 : 0;
    return type(id, () => undefined, {
      onInit: (ctx) => {
        if (failures > 0) { failures--; throw new Error('not yet'); }
        seen.push({ event: 'init', nodeKey: ctx.nodeKey, config: ctx.config });
        opts.keep?.(ctx);
      },
      onDestroy: (ctx) => { seen.push({ event: 'destroy', nodeKey: ctx.nodeKey, config: ctx.config }); },
    });
  }

  function lifecycleEngine(chains: LoadedRuleChain[]) {
    const mem = memoryDeps(chains);
    const engine = createRuleEngine({ ...mem.deps, lifecyclePollMs: 3_600_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    return { engine, mem };
  }

  const later = (c: LoadedRuleChain, ms: number): LoadedRuleChain => ({ ...c, updatedAt: new Date(c.updatedAt.getTime() + ms) });

  it('onInit at start, re-init on a config change, onDestroy on node removal, chain delete and stop', async () => {
    const seen: Seen[] = [];
    const life = lifecycleType('test:life', seen);
    const a = nodeOf(life, 'A', { config: { n: 1 } });
    const chain = chainOf('c', docOf([a], []), { root: true });
    const other = nodeOf(life, 'B');
    const chain2 = chainOf('c2', docOf([other], []));
    const { engine, mem } = lifecycleEngine([chain, chain2]);
    await engine.start();
    try {
      expect(seen.map((s) => `${s.event} ${s.nodeKey}`).sort()).toEqual([`init ${chain.id}:${a.id}`, `init ${chain2.id}:${other.id}`].sort());

      // The same version again: nothing.
      seen.length = 0;
      await engine.syncLifecycles();
      expect(seen).toEqual([]);

      // A config change: the old instance stops, the new one starts with the new config.
      const changed = { ...a, config: { n: 2 } };
      mem.chains.set(chain.id, later(chainOf('c', docOf([changed], []), { id: chain.id, root: true }), 1_000));
      await engine.syncLifecycles();
      expect(seen.map((s) => [s.event, (s.config as { n?: number }).n])).toEqual([['destroy', 1], ['init', 2]]);

      // The node removed from the chain: destroyed.
      seen.length = 0;
      mem.chains.set(chain.id, later(chainOf('c', docOf([], [], null), { id: chain.id, root: true }), 2_000));
      await engine.syncLifecycles();
      expect(seen.map((s) => `${s.event} ${s.nodeKey}`)).toEqual([`destroy ${chain.id}:${a.id}`]);

      // The chain deleted: its nodes destroyed.
      seen.length = 0;
      mem.chains.delete(chain2.id);
      await engine.syncLifecycles();
      expect(seen.map((s) => `${s.event} ${s.nodeKey}`)).toEqual([`destroy ${chain2.id}:${other.id}`]);

      // Restore one and stop: destroyed on stop.
      mem.chains.set(chain2.id, later(chain2, 3_000));
      await engine.syncLifecycles();
      seen.length = 0;
    } finally {
      await engine.stop();
    }
    expect(seen.map((s) => `${s.event} ${s.nodeKey}`)).toEqual([`destroy ${chain2.id}:${other.id}`]);
  });

  it('a failed onInit is retried (the version is not recorded) — after its backoff, not at the very next sync', async () => {
    const seen: Seen[] = [];
    const life = lifecycleType('test:life-fail', seen, { failFirst: true });
    const a = nodeOf(life, 'A');
    const chain = chainOf('c', docOf([a], []), { root: true });
    const { engine } = lifecycleEngine([chain]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-05T10:00:00Z');
    vi.setSystemTime(t0);
    try {
      await engine.start();
      expect(seen.filter((s) => s.event === 'init')).toEqual([]);
      expect(engine.stats().counters.init_errors).toBe(1);
      vi.setSystemTime(t0 + 5_000);
      await engine.syncLifecycles();
      expect(seen.filter((s) => s.event === 'init').map((s) => s.nodeKey)).toEqual([`${chain.id}:${a.id}`]);
      vi.setSystemTime(t0 + 60_000);
      await engine.syncLifecycles();
      expect(seen.filter((s) => s.event === 'init')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await engine.stop();
    }
  });

  it('m2: a chain that could not be READ is not recorded — the next sync initialises it', async () => {
    const seen: Seen[] = [];
    const life = lifecycleType('test:life-unreadable', seen);
    const a = nodeOf(life, 'A');
    const chain = chainOf('c', docOf([a], []), { root: true });
    const mem = memoryDeps([chain]);
    let unreadable = 1;
    const engine = createRuleEngine({
      ...mem.deps,
      getChain: async (id: string) => (id === chain.id && unreadable-- > 0 ? null : mem.chains.get(id) ?? null),
      lifecyclePollMs: 3_600_000,
      services: () => Object.assign(fakeServices(), { dispose: async () => undefined }),
    });
    await engine.start();
    try {
      expect(seen).toEqual([]);
      await engine.syncLifecycles();
      expect(seen.map((s) => `${s.event} ${s.nodeKey}`)).toEqual([`init ${chain.id}:${a.id}`]);
      await engine.syncLifecycles();
      expect(seen).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  });

  it('m3: an onInit that ALWAYS fails backs off 5 s, 10 s, 20 s … to 5 min — no hot retry, no cache invalidation in between; a save or force retries at once; each failed start gets a best-effort onDestroy', async () => {
    const inits: number[] = [];
    let destroys = 0;
    const failing = type('test:life-always-fails', () => undefined, {
      onInit: () => { inits.push(Date.now()); throw new Error('GENERATOR_ORIGINATOR_REQUIRED: no instrument'); },
      onDestroy: () => { destroys++; },
    });
    const a = nodeOf(failing, 'A');
    const chain = chainOf('c', docOf([a], []), { root: true });
    const mem = memoryDeps([chain]);
    let invalidations = 0;
    const engine = createRuleEngine({
      ...mem.deps, invalidateChain: () => { invalidations++; }, lifecyclePollMs: 3_600_000,
      services: () => Object.assign(fakeServices(), { dispose: async () => undefined }),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.parse('2026-11-05T10:00:00Z');
    vi.setSystemTime(now);
    const at = async (ms: number) => { now += ms; vi.setSystemTime(now); await engine.syncLifecycles(); return inits.length; };
    try {
      await engine.start();
      expect(inits).toHaveLength(1);
      expect(destroys).toBe(1);
      expect(await at(0)).toBe(1);
      expect(await at(4_999)).toBe(1);
      expect(await at(1)).toBe(2); // 5 s after the first failure
      expect(await at(9_999)).toBe(2);
      expect(await at(1)).toBe(3); // then 10 s
      expect(invalidations, 'the chain cache is dropped only when a start is actually tried').toBe(3);
      await engine.syncLifecycles({ force: true });
      expect(inits).toHaveLength(4);
      // A save (a new version) is retried at once, and starts the backoff over.
      mem.chains.set(chain.id, { ...chain, updatedAt: new Date(chain.updatedAt.getTime() + 1_000) });
      expect(await at(0)).toBe(5);
      expect(await at(4_999)).toBe(5);
      expect(await at(1)).toBe(6);
      // Doubling to the 5-minute ceiling: 10, 20, 40, 80, 160 s, then 300, 300.
      for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000]) {
        const n = inits.length;
        expect(await at(wait - 1)).toBe(n);
        expect(await at(1)).toBe(n + 1);
      }
      expect(await at(299_999)).toBe(12);
      expect(await at(1)).toBe(13);
      expect(destroys).toBe(13);
    } finally {
      vi.useRealTimers();
      await engine.stop();
    }
  });

  it('m1: a lifecycle node\'s script strikes follow the chain\'s CURRENT version — a save that does not touch the node re-enables it', async () => {
    clearScriptStrikes();
    const seen: Seen[] = [];
    let initCtx: import('../context.js').RuleContext | undefined;
    const life = lifecycleType('test:life-script', seen, { keep: (ctx) => { initCtx = ctx; } });
    const gen = nodeOf(life, 'Gen');
    const other = nodeOf(type('test:life-other', () => undefined), 'Other', { config: { v: 1 } });
    const chain = chainOf('c', docOf([gen, other], []), { root: true });
    const mem = memoryDeps([chain], { scriptTimeoutMs: 100 });
    const engine = createRuleEngine({ ...mem.deps, lifecyclePollMs: 3_600_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    const run = (spin: boolean) => {
      try {
        return String(initCtx!.runScript('filter', 'if (msg.spin) { while (true) {} } return true;', testMessage({ spin })));
      } catch (e) {
        return (e as { code?: string }).code ?? 'error';
      }
    };
    await engine.start();
    try {
      expect([run(true), run(true), run(true), run(false)]).toEqual(['SCRIPT_TIMEOUT', 'SCRIPT_TIMEOUT', 'SCRIPT_TIMEOUT', 'SCRIPT_DISABLED']);
      // Saved with ANOTHER node changed: the Generator keeps its instance (and the context it was started with) …
      mem.chains.set(chain.id, { ...chainOf('c', docOf([gen, { ...other, config: { v: 2 } }], []), { id: chain.id, root: true }), updatedAt: new Date(chain.updatedAt.getTime() + 1_000) });
      await engine.syncLifecycles();
      expect(seen.filter((s) => s.event === 'init')).toHaveLength(1);
      // … and its script runs again.
      expect(run(false)).toBe('true');
    } finally {
      await engine.stop();
    }
  });

  it('a tellNext from the init context starts a message at the node\'s connections', async () => {
    const log: string[] = [];
    let initCtx: import('../context.js').RuleContext | undefined;
    const life = lifecycleType('test:life-gen', [], { keep: (ctx) => { initCtx = ctx; } });
    const sink = type('test:life-sink', (ctx, msg) => { log.push(`${ctx.node.name} ${(msg.data as { n: number }).n}`); });
    const gen = nodeOf(life, 'Gen');
    const b = nodeOf(sink, 'B');
    const chain = chainOf('c', docOf([gen, b], [[gen, 'Success', b]]), { root: true });
    const { engine } = lifecycleEngine([chain]);
    await engine.start();
    try {
      expect(initCtx).toBeDefined();
      initCtx!.tellNext(testMessage({ n: 7 }), 'Success');
      await waitFor(() => log.length === 1);
      expect(log).toEqual(['B 7']);
    } finally {
      await engine.stop();
    }
  });

  it('ctx.nodeKey is <chainId>:<nodeId> in a handler too', async () => {
    const keys: string[] = [];
    const rec = type('test:key', (ctx) => { keys.push(ctx.nodeKey); });
    const a = nodeOf(rec, 'A');
    const chain = chainOf('c', docOf([a], []), { root: true });
    await engineFor([chain]).engine.processNow(testMessage({}));
    expect(keys).toEqual([`${chain.id}:${a.id}`]);
  });
});

describe('the durable path (rule_engine_message)', () => {
  it('the job completes once the Main queue ADMITS the message, before a slow downstream node finishes', async () => {
    let release!: () => void;
    let finished = false;
    const from = type('test:delay-like', () => undefined);
    const slow = type('test:slow-next', async () => { await new Promise<void>((r) => { release = r; }); finished = true; });
    const a = nodeOf(from, 'Delay');
    const b = nodeOf(slow, 'Next');
    const chain = chainOf('c', docOf([a, b], [[a, 'Success', b]]), { root: true });
    const mem = memoryDeps([chain]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      const msg = testMessage({ t: 1 });
      expect(await runRuleEngineMessage({ message: serialisableMessage(msg), chainId: chain.id, resumeAfterNodeId: a.id }, engine)).toBe('admitted');
      await waitFor(() => release !== undefined);
      expect(finished).toBe(false);
      release();
      await engine.drain();
      expect(finished).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it('a refused admission THROWS (graphile retries); not started THROWS; switched off drops', async () => {
    const mem = memoryDeps([], { enabled: false });
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    const payload = { message: serialisableMessage(testMessage({})), chainId: '0f000000-0000-4000-8000-0000000000c1', resumeAfterNodeId: '0f000000-0000-4000-8000-0000000000c2' };
    await expect(runRuleEngineMessage(payload, engine)).rejects.toThrow(/^ENGINE_NOT_STARTED/);
    await engine.start();
    try {
      expect(await runRuleEngineMessage(payload, engine)).toBe('dropped_disabled');
    } finally {
      await engine.stop();
    }
    const stopping = createRuleEngine({ ...memoryDeps([]).deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await stopping.start();
    const stopped = stopping.stop();
    await expect(runRuleEngineMessage(payload, stopping)).rejects.toThrow(/^QUEUE_REFUSED|^ENGINE_NOT_STARTED/);
    await stopped;
  });

  it('RE-2: a full queue never evicts an ADMITTED durable resume — it is processed after 200 more messages of its originator', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const resumed: string[] = [];
    const hold = type('test:re2-hold', async () => { await gateOpen; });
    const from = type('test:re2-delay', () => undefined);
    const after = type('test:re2-after', (_ctx, msg) => { resumed.push(msg.id); });
    const h = nodeOf(hold, 'Hold');
    const d = nodeOf(from, 'Delay');
    const r = nodeOf(after, 'After');
    const chain = chainOf('c', docOf([h, d, r], [[d, 'Success', r]], h), { root: true });
    const mem = memoryDeps([chain], { queueCapacity: 100 });
    const engine = createRuleEngine({ ...mem.deps, budgetMs: 60_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({ i: 0 }, { originator: { id: 'A' } }));
      await waitFor(() => engine.stats().inFlight === 1);
      for (let i = 1; i < 99; i++) engine.enqueue(testMessage({ i }, { originator: { id: 'A' } }));
      const durable = testMessage({ durable: true }, { originator: { id: 'A' } });
      expect(engine.resumeAfter(durable, chain.id, d.id)).toBe(true);
      for (let i = 0; i < 200; i++) engine.enqueue(testMessage({ more: i }, { originator: { id: 'A' } }));
      expect(engine.stats().queueDepth).toBe(100);
      expect(engine.stats().dropped).toBe(199);
      release();
      await engine.drain();
      expect(resumed).toEqual([durable.id]);
    } finally {
      await engine.stop();
    }
  });

  it('RE-2: at capacity resumeAfter REFUSES (durable_refused) — graphile keeps the job, nothing is evicted for it', async () => {
    const hold = type('test:re2-hold2', () => new Promise<void>(() => undefined));
    const h = nodeOf(hold, 'Hold');
    const chain = chainOf('c', docOf([h], []), { root: true });
    const mem = memoryDeps([chain], { queueCapacity: 100 });
    const engine = createRuleEngine({ ...mem.deps, budgetMs: 60_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({ i: 0 }, { originator: { id: 'A' } }));
      await waitFor(() => engine.stats().inFlight === 1);
      for (let i = 1; i <= 100; i++) engine.enqueue(testMessage({ i }, { originator: { id: 'A' } }));
      expect(engine.stats().queueDepth).toBe(100);
      expect(engine.resumeAfter(testMessage({}, { originator: { id: 'A' } }), chain.id, h.id)).toBe(false);
      expect(engine.stats().counters.durable_refused).toBe(1);
      expect(engine.stats().dropped).toBe(0);
    } finally {
      await engine.stop();
    }
  });

  it('RE-2: stop() hands every WAITING durable resume back to graphile — its message, node, relation and depth (durable_requeued)', async () => {
    const handed: { msgId: string; chainId: string; nodeId: string; runAt: Date | undefined; opts: unknown }[] = [];
    const hold = type('test:re2-hold3', () => new Promise<void>(() => undefined));
    const h = nodeOf(hold, 'Hold');
    const d = nodeOf(type('test:re2-d3', () => undefined), 'Delay');
    const chain = chainOf('c', docOf([h, d], [], h), { root: true });
    const mem = memoryDeps([chain]);
    const services = Object.assign(fakeServices({
      durable: { enqueue: async (msg, chainId, nodeId, runAt, opts) => { handed.push({ msgId: msg.id, chainId, nodeId, runAt, opts }); } },
    }), { dispose: async () => undefined });
    const engine = createRuleEngine({ ...mem.deps, budgetMs: 60_000, services: () => services });
    await engine.start();
    engine.enqueue(testMessage({}, { originator: { id: 'A' } }));
    await waitFor(() => engine.stats().inFlight === 1);
    const deep = { ...testMessage({ n: 1 }, { originator: { id: 'A' } }), _hops: 9 };
    const plain = testMessage({ n: 2 }, { originator: { id: 'A' } });
    expect(engine.resumeAfter(deep, chain.id, d.id, ['True'], { reentryDepth: 1 })).toBe(true);
    expect(engine.resumeAfter(plain, chain.id, d.id)).toBe(true);
    engine.enqueue(testMessage({ ordinary: true }, { originator: { id: 'A' } }));
    const counters = () => engine.stats().counters;
    await engine.stop();
    expect(handed).toEqual([
      { msgId: deep.id, chainId: chain.id, nodeId: d.id, runAt: undefined, opts: { reentryDepth: 1, relation: 'True' } },
      { msgId: plain.id, chainId: chain.id, nodeId: d.id, runAt: undefined, opts: { reentryDepth: 0, relation: 'Success' } },
    ]);
    expect(counters()).toMatchObject({ durable_requeued: 2 });
    expect(counters().durable_dropped ?? 0).toBe(0);
  });

  it('RE-2: a hand-back that fails is counted durable_dropped (and logged), the others still go back', async () => {
    let calls = 0;
    const hold = type('test:re2-hold4', () => new Promise<void>(() => undefined));
    const h = nodeOf(hold, 'Hold');
    const d = nodeOf(type('test:re2-d4', () => undefined), 'Delay');
    const chain = chainOf('c', docOf([h, d], [], h), { root: true });
    const services = Object.assign(fakeServices({
      durable: { enqueue: async () => { calls++; if (calls === 1) throw new Error('database gone'); } },
    }), { dispose: async () => undefined });
    const engine = createRuleEngine({ ...memoryDeps([chain]).deps, budgetMs: 60_000, services: () => services });
    await engine.start();
    engine.enqueue(testMessage({}, { originator: { id: 'A' } }));
    await waitFor(() => engine.stats().inFlight === 1);
    engine.resumeAfter(testMessage({ n: 1 }, { originator: { id: 'A' } }), chain.id, d.id);
    engine.resumeAfter(testMessage({ n: 2 }, { originator: { id: 'A' } }), chain.id, d.id);
    await engine.stop();
    expect(calls).toBe(2);
    expect(engine.stats().counters).toMatchObject({ durable_dropped: 1, durable_requeued: 1 });
  });

  it('RE-2: switching the engine OFF drops waiting durable resumes — counted durable_dropped (the worker drops them too when off)', async () => {
    const hold = type('test:re2-hold5', () => new Promise<void>(() => undefined));
    const h = nodeOf(hold, 'Hold');
    const d = nodeOf(type('test:re2-d5', () => undefined), 'Delay');
    const chain = chainOf('c', docOf([h, d], [], h), { root: true });
    const config: { enabled?: boolean } = {};
    const engine = createRuleEngine({ ...memoryDeps([chain], config).deps, budgetMs: 60_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({}, { originator: { id: 'A' } }));
      await waitFor(() => engine.stats().inFlight === 1);
      engine.resumeAfter(testMessage({ n: 1 }, { originator: { id: 'A' } }), chain.id, d.id);
      engine.enqueue(testMessage({ ordinary: true }, { originator: { id: 'A' } }));
      config.enabled = false;
      await engine.refreshConfig();
      expect(engine.stats().counters).toMatchObject({ cleared_on_disable: 2, durable_dropped: 1 });
    } finally {
      await engine.stop();
    }
  });

  it('RE-2: a refused or early job is RESCHEDULED (no graphile attempt spent), backing off 5 s, 10 s, 20 s … up to 5 min', async () => {
    const calls: { payload: Record<string, unknown>; runAt: Date; originatorId: string }[] = [];
    const reschedule = async (payload: Record<string, unknown>, runAt: Date, originatorId: string) => { calls.push({ payload, runAt, originatorId }); };
    const payload = { message: serialisableMessage(testMessage({}, { originator: { id: 'inst-7' } })), chainId: '0f000000-0000-4000-8000-0000000000c1', resumeAfterNodeId: '0f000000-0000-4000-8000-0000000000c2' };
    // Not started: rescheduled, not thrown.
    const idle = createRuleEngine({ ...memoryDeps([]).deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    const t0 = Date.now();
    expect(await runRuleEngineMessage(payload, idle, { reschedule })).toBe('rescheduled');
    expect(calls[0].originatorId).toBe('inst-7');
    expect(calls[0].payload).toEqual({ ...payload, requeues: 1 });
    expect(calls[0].runAt.getTime() - t0).toBeGreaterThanOrEqual(5_000);
    expect(calls[0].runAt.getTime() - t0).toBeLessThan(6_000);
    // The tenth time: 5 s × 2^9 = 2560 s, capped at 300 s.
    expect(await runRuleEngineMessage({ ...payload, requeues: 9 }, idle, { reschedule })).toBe('rescheduled');
    expect(calls[1].payload.requeues).toBe(10);
    expect(calls[1].runAt.getTime() - Date.now()).toBeGreaterThan(299_000);
    expect(calls[1].runAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    // Refused by a full queue: rescheduled too.
    const hold = type('test:re2-hold6', () => new Promise<void>(() => undefined));
    const h = nodeOf(hold, 'Hold');
    const chain = chainOf('c', docOf([h], []), { root: true });
    const full = createRuleEngine({ ...memoryDeps([chain], { queueCapacity: 100 }).deps, budgetMs: 60_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await full.start();
    try {
      full.enqueue(testMessage({ i: 0 }, { originator: { id: 'A' } }));
      await waitFor(() => full.stats().inFlight === 1);
      for (let i = 1; i <= 100; i++) full.enqueue(testMessage({ i }, { originator: { id: 'A' } }));
      expect(await runRuleEngineMessage({ ...payload, chainId: chain.id, resumeAfterNodeId: h.id }, full, { reschedule })).toBe('rescheduled');
      expect(calls).toHaveLength(3);
    } finally {
      await full.stop();
    }
  });

  it('RE-2: the TASK wires the reschedule to graphile\'s addJob — same task, payload + requeues, the originator\'s queue, the job\'s maxAttempts, ~5 s out', async () => {
    // The process singleton is never started in a unit file: the ENGINE_NOT_STARTED path.
    const added: { task: string; payload: Record<string, unknown>; spec: { queueName?: string; runAt?: Date; maxAttempts?: number } }[] = [];
    const helpers = { addJob: async (task: string, payload: Record<string, unknown>, spec: never) => { added.push({ task, payload, spec }); }, job: { max_attempts: 7 } };
    const payload = { message: serialisableMessage(testMessage({}, { originator: { id: 'inst-42' } })), chainId: '0f000000-0000-4000-8000-0000000000c1', resumeAfterNodeId: '0f000000-0000-4000-8000-0000000000c2' };
    const t0 = Date.now();
    await ruleEngineMessageTask(payload, helpers as never);
    expect(added).toHaveLength(1);
    expect(added[0].task).toBe('rule_engine_message');
    expect(added[0].payload).toEqual({ ...payload, requeues: 1 });
    expect(added[0].spec).toMatchObject({ queueName: 'rule-engine:inst-42', maxAttempts: 7 });
    expect(added[0].spec.runAt!.getTime() - t0).toBeGreaterThanOrEqual(5_000);
    expect(added[0].spec.runAt!.getTime() - t0).toBeLessThan(6_000);
  });

  it('the hop count travels through the durable path: a cycle through Delay still reaches the hop limit', async () => {
    const from = type('test:delay-like2', () => undefined);
    const next = type('test:next2', (ctx, msg) => ctx.tellNext(msg, 'Success'));
    const a = nodeOf(from, 'Delay');
    const b = nodeOf(next, 'Next', { debugMode: 'all' });
    const chain = chainOf('c', docOf([a, b], [[a, 'Success', b]]), { root: true });
    const mem = memoryDeps([chain], { hopLimit: 200 });
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      const msg = { ...testMessage({}), _hops: 200 };
      const payload = JSON.parse(JSON.stringify({ message: serialisableMessage(msg), chainId: chain.id, resumeAfterNodeId: a.id }));
      expect(payload.message._hops).toBe(200);
      expect(await runRuleEngineMessage(payload, engine)).toBe('admitted');
      await engine.drain();
      expect(mem.events.filter((e) => e.nodeId === b.id).map((e) => `${e.direction} ${e.relation} ${e.error ?? ''}`.trim()))
        .toEqual(['IN Success', 'OUT Failure (unhandled) HOP_LIMIT']);
    } finally {
      await engine.stop();
    }
  });
});

describe('the re-entry depth (ruling RE-1)', () => {
  beforeEach(() => resetEmitCounters());

  /** An engine installed as the emit helpers' SINK (as the singleton is), every chain's Re-enter ON. */
  async function sinkEngine(chains: LoadedRuleChain[]) {
    const mem = memoryDeps(chains);
    const engine = createRuleEngine({ ...mem.deps, installSink: true, lifecyclePollMs: 3_600_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    return { engine, mem };
  }

  /**
   * A node that WRITES what reaches it, as Save time series does: a rule node's
   * telemetry, through the emit path under its own origin — after a few awaits of
   * the kinds a real write makes. Records the flow's depth. Stops writing after 10
   * runs, so a missing cap fails the assertion instead of looping forever.
   */
  function writerType(id: string, seen: { originator: string; depth: number }[]) {
    return type(id, async (ctx, msg) => {
      seen.push({ originator: msg.originator.id, depth: currentReentryDepth() });
      if (seen.length > 10) return;
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 1));
      await emitTelemetry(msg.originator.id, [{ key: 't', value: seen.length, ts: new Date() }], 'rule-engine', ctx.origin);
    });
  }

  const from = (origin: string, data: unknown = {}, originatorId = 'X') =>
    testMessage(data, { originator: { id: originatorId }, metadata: { rule_engine_origin: origin } });

  it('a write re-enters ONCE: the re-entered message (depth 1) writes, and that write emits nothing (loop_skipped)', async () => {
    const seen: { originator: string; depth: number }[] = [];
    const w = nodeOf(writerType('test:re-writer', seen), 'W');
    const { engine } = await sinkEngine([chainOf('c', docOf([w], []), { root: true, reEnterOnRuleNodeWrites: true })]);
    try {
      expect(engine.enqueue(from('rest_api'))).toBe(true);
      await waitFor(() => seen.length >= 2);
      await settleEngine(engine);
      expect(seen.map((s) => s.depth)).toEqual([0, 1]);
      expect(emitCounters()).toMatchObject({ emitted: 1, loop_skipped: 1 });
    } finally {
      await engine.stop();
    }
  });

  it('each flow runs at ITS OWN depth: a depth-0 message admitted from inside a depth-1 flow still re-enters', async () => {
    const seen: { originator: string; depth: number }[] = [];
    let engineRef: RuleEngine | null = null;
    const spawner = type('test:re-spawner', async (ctx, msg) => {
      seen.push({ originator: msg.originator.id, depth: currentReentryDepth() });
      if (seen.length > 10) return;
      // A REST-API message pushed from inside this flow: the queue's setImmediate would hand it THIS flow's context.
      if ((msg.data as { spawn?: boolean }).spawn) engineRef!.enqueue(from('rest_api', {}, 'Y'));
      await new Promise((r) => setTimeout(r, 2));
      await emitTelemetry(msg.originator.id, [{ key: 't', value: 1, ts: new Date() }], 'rule-engine', ctx.origin);
    });
    const s = nodeOf(spawner, 'S');
    const chain = chainOf('c', docOf([s], []), { root: true, reEnterOnRuleNodeWrites: true });
    const { engine } = await sinkEngine([chain]);
    engineRef = engine;
    try {
      expect(engine.enqueue(from(ruleNodeOrigin(chain.id, s.id), { spawn: true }, 'X'))).toBe(true);
      await waitFor(() => seen.length >= 3);
      await settleEngine(engine);
      expect(seen.map((r) => `${r.originator}:${r.depth}`).sort()).toEqual(['X:1', 'Y:0', 'Y:1']);
      expect(emitCounters().loop_skipped).toBe(2);
    } finally {
      await engine.stop();
    }
  });

  it('a late call keeps the depth of the flow it came from — not what the metadata says by then', async () => {
    const seen: { originator: string; depth: number }[] = [];
    const late = type('test:re-late', (ctx, msg) => {
      // A script could rewrite the origin; the depth must not follow it.
      setTimeout(() => ctx.tellNext({ ...msg, metadata: { ...msg.metadata, rule_engine_origin: 'rest_api' } }, 'Success'), 5);
    });
    const l = nodeOf(late, 'L');
    const w = nodeOf(writerType('test:re-writer-late', seen), 'W');
    const chain = chainOf('c', docOf([l, w], [[l, 'Success', w]]), { root: true, reEnterOnRuleNodeWrites: true });
    const { engine } = await sinkEngine([chain]);
    try {
      engine.enqueue(from(ruleNodeOrigin(chain.id, w.id)));
      await waitFor(() => seen.length >= 1);
      await settleEngine(engine);
      expect(seen.map((r) => r.depth)).toEqual([1]);
      expect(emitCounters()).toMatchObject({ emitted: 0, loop_skipped: 1 });
      // A first-generation message through the same late path: its write re-enters once, then ends.
      engine.enqueue(from('rest_api'));
      await waitFor(() => seen.length >= 3);
      await settleEngine(engine);
      expect(seen.map((r) => r.depth)).toEqual([1, 0, 1]);
      expect(emitCounters()).toMatchObject({ emitted: 1, loop_skipped: 2 });
    } finally {
      await engine.stop();
    }
  });

  it('a durable resume keeps the depth the job carries (message._reentryDepth); a job without one is depth 0', async () => {
    const seen: { originator: string; depth: number }[] = [];
    const d = nodeOf(type('test:re-delay', () => undefined), 'Delay');
    const w = nodeOf(writerType('test:re-writer-durable', seen), 'W');
    const chain = chainOf('c', docOf([d, w], [[d, 'Success', w]]), { root: true, reEnterOnRuleNodeWrites: true });
    const { engine } = await sinkEngine([chain]);
    try {
      const deep = { message: { ...serialisableMessage(from('rest_api')), _reentryDepth: 1 }, chainId: chain.id, resumeAfterNodeId: d.id };
      expect(await runRuleEngineMessage(JSON.parse(JSON.stringify(deep)), engine)).toBe('admitted');
      await waitFor(() => seen.length >= 1);
      await settleEngine(engine);
      expect(seen.map((r) => r.depth)).toEqual([1]);
      expect(emitCounters().loop_skipped).toBe(1);
      const plain = { message: serialisableMessage(from('rest_api')), chainId: chain.id, resumeAfterNodeId: d.id };
      expect(await runRuleEngineMessage(plain, engine)).toBe('admitted');
      await waitFor(() => seen.length >= 2);
      await settleEngine(engine);
      expect(seen.map((r) => r.depth)).toEqual([1, 0]);
      expect(emitCounters().emitted).toBe(1);
    } finally {
      await engine.stop();
    }
  });

  it('processNow decides the depth from the origin it was given, as admission does', async () => {
    const depths: number[] = [];
    const rec = type('test:re-depth', () => { depths.push(currentReentryDepth()); });
    const r = nodeOf(rec, 'R');
    const chain = chainOf('c', docOf([r], []), { root: true });
    const { engine } = engineFor([chain]);
    await engine.processNow(from('ingest'));
    await engine.processNow(from(ruleNodeOrigin(chain.id, r.id)));
    expect(depths).toEqual([0, 1]);
  });
});

/** The queue empty and idle, a beat for late timers, and idle again. */
async function settleEngine(engine: RuleEngine): Promise<void> {
  await engine.drain();
  await new Promise((r) => setTimeout(r, 30));
  await engine.drain();
}

describe('ctx.runScript', () => {
  it('runs on the message; three time-outs disable it until the chain is saved (a new version)', async () => {
    clearScriptStrikes();
    const results: string[] = [];
    const scripted = type('test:scripted', (ctx, msg) => {
      try {
        results.push(String(ctx.runScript('filter', 'if (msg.spin) { while (true) {} } return msg.t > 20;', msg)));
      } catch (e) {
        results.push((e as { code?: string }).code ?? 'error');
      }
    });
    const a = nodeOf(scripted, 'A');
    const chain = chainOf('c', docOf([a], []), { root: true });
    const mem = memoryDeps([chain], { scriptTimeoutMs: 100 });
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.processNow(testMessage({ t: 25 }));
    for (let i = 0; i < 3; i++) await engine.processNow(testMessage({ spin: true }));
    await engine.processNow(testMessage({ t: 25 }));
    expect(results).toEqual(['true', 'SCRIPT_TIMEOUT', 'SCRIPT_TIMEOUT', 'SCRIPT_TIMEOUT', 'SCRIPT_DISABLED']);
    // Saved: a new version of the same chain.
    mem.chains.set(chain.id, { ...chain, updatedAt: new Date(chain.updatedAt.getTime() + 1_000) });
    await engine.processNow(testMessage({ t: 25 }));
    expect(results.at(-1)).toBe('true');
  });
});

/**
 * M1 (whole-branch review A): if Configuration → Rule Engine could not be read at
 * start, the engine ran on the SHIPPED defaults — `enabled: true` — even when the
 * stored switch said OFF. Now it accepts nothing until a read of THIS start succeeds.
 */
describe('nothing is accepted before the configuration is read (M1)', () => {
  function flakyEngine(chains: LoadedRuleChain[], stored: Partial<typeof RULE_ENGINE_CONFIG_DEFAULTS> = {}) {
    const state = { fail: true };
    const mem = memoryDeps(chains);
    const engine = createRuleEngine({
      ...mem.deps,
      loadConfig: async () => {
        if (state.fail) throw new Error('database unreachable');
        return { ...RULE_ENGINE_CONFIG_DEFAULTS, ...stored };
      },
      configRefreshMs: 3_600_000,
      services: () => Object.assign(fakeServices(), { dispose: async () => undefined }),
    });
    return { engine, state };
  }

  it('a failed first read: not started, enqueue refused, a durable job RESCHEDULED (never dropped) — until a read succeeds', async () => {
    const chain = chainOf('c', docOf([nodeOf(type('test:m1-sink', () => undefined), 'A')], []), { root: true });
    const { engine, state } = flakyEngine([chain]);
    const calls: unknown[] = [];
    const reschedule = async (payload: Record<string, unknown>) => { calls.push(payload); };
    const payload = { message: serialisableMessage(testMessage({})), chainId: chain.id, resumeAfterNodeId: chain.document.nodes[0].id };
    await engine.start();
    try {
      expect(engine.started).toBe(false);
      expect(engine.enqueue(testMessage({}))).toBe(false);
      expect(await runRuleEngineMessage(payload, engine, { reschedule })).toBe('rescheduled');
      expect(calls).toHaveLength(1);
      state.fail = false;
      await engine.refreshConfig();
      expect(engine.started).toBe(true);
      expect(engine.enqueue(testMessage({}))).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it('… and when the first read that succeeds says OFF, it stays off', async () => {
    const chain = chainOf('c', docOf([nodeOf(type('test:m1-sink2', () => undefined), 'A')], []), { root: true });
    const { engine, state } = flakyEngine([chain], { enabled: false });
    await engine.start();
    try {
      expect(engine.enqueue(testMessage({}))).toBe(false);
      state.fail = false;
      await engine.refreshConfig();
      expect(engine.enqueue(testMessage({}))).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it('every START needs its own read: a restart whose read fails accepts nothing, whatever the last run read', async () => {
    const chain = chainOf('c', docOf([nodeOf(type('test:m1-sink3', () => undefined), 'A')], []), { root: true });
    const { engine, state } = flakyEngine([chain]);
    state.fail = false;
    await engine.start();
    expect(engine.enqueue(testMessage({}))).toBe(true);
    await engine.stop();
    state.fail = true;
    await engine.start();
    try {
      expect(engine.started).toBe(false);
      expect(engine.enqueue(testMessage({}))).toBe(false);
    } finally {
      await engine.stop();
    }
  });
});

describe('enqueue and stats', () => {
  it('enqueue is refused before start and when switched off', async () => {
    const mem = memoryDeps([], { enabled: false });
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    expect(engine.enqueue(testMessage({}))).toBe(false);
    await engine.start();
    try {
      expect(engine.enqueue(testMessage({}))).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it('per originator: messages of one instrument run in order', async () => {
    const order: string[] = [];
    const rec = type('test:rec', async (_ctx, msg) => {
      await new Promise((r) => setTimeout(r, (msg.data as { wait: number }).wait));
      order.push((msg.data as { id: string }).id);
    });
    const mem = memoryDeps([chainOf('c', docOf([nodeOf(rec, 'A')], []), { root: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      engine.enqueue(testMessage({ id: 'X1', wait: 30 }, { originator: { id: 'X' } }));
      engine.enqueue(testMessage({ id: 'Y1', wait: 1 }, { originator: { id: 'Y' } }));
      engine.enqueue(testMessage({ id: 'X2', wait: 1 }, { originator: { id: 'X' } }));
      await waitFor(() => order.length === 3);
      expect(order).toEqual(['Y1', 'X1', 'X2']);
      expect(engine.stats().processedLastMinute).toBe(3);
    } finally {
      await engine.stop();
    }
  });

  it('a full queue drops the oldest of the largest backlog and counts it', async () => {
    const hold = type('test:hold', () => new Promise<void>(() => undefined));
    const mem = memoryDeps([chainOf('c', docOf([nodeOf(hold, 'A')], []), { root: true })], { queueCapacity: 100 });
    const engine = createRuleEngine({ ...mem.deps, budgetMs: 60_000, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      for (let i = 0; i < 102; i++) engine.enqueue(testMessage({ i }, { originator: { id: 'A' } }));
      expect(engine.stats().dropped).toBe(2);
      expect(engine.stats().queueDepth).toBe(100);
    } finally {
      await engine.stop();
    }
  });

  it('the instrument metadata is filled in before the first node sees the message', async () => {
    const seen: Record<string, string>[] = [];
    const rec = type('test:meta', (_ctx, msg) => { seen.push(msg.metadata); });
    const mem = memoryDeps([chainOf('c', docOf([nodeOf(rec, 'A')], []), { root: true })]);
    const engine = createRuleEngine({
      ...mem.deps,
      instrumentInfo: async (id: string) => (id === 'inst-9' ? { code: 'CWH/9', name: 'Nine', profileName: 'T&RH' } : null),
      services: () => Object.assign(fakeServices(), { dispose: async () => undefined }),
    });
    await engine.processNow(newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'inst-9' }, { ts: 1, values: {} }, { ts: '1' }));
    expect(seen[0]).toMatchObject({ instrumentCode: 'CWH/9', instrumentName: 'Nine', profileName: 'T&RH', ts: '1' });
  });
});

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export type { RuleEngine };
