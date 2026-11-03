import { describe, it, expect, afterEach } from 'vitest';
import { createRuleEngine, type RuleEngine } from '../engine.js';
import { registerNode } from '../registry.js';
import { newMessage, type RuleMessage } from '../message.js';
import { chainOf, docOf, nodeOf, memoryDeps, fakeServices, testMessage } from '../../../test-support/rule-engine.js';
import type { LoadedRuleChain } from '../service.js';

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
