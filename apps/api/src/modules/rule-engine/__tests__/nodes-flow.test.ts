import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { BUILT_RULE_NODE_TYPES } from '@digilog/shared';
import { getHandler, registerNode } from '../registry.js';
import { registerFlowNodes } from '../nodes/flow/index.js';
import { createRuleEngine } from '../engine.js';
import { chainOf, docOf, nodeOf, memoryDeps, fakeServices, fakeContext, testMessage, type FakeContextOptions } from '../../../test-support/rule-engine.js';
import type { RuleMessage } from '../message.js';
import type { RuleServices } from '../services.js';
import type { LoadedRuleChain } from '../service.js';

/**
 * The FLOW rule nodes (rule chains, Task 4; spec §6, §7 Flow): Acknowledge,
 * Checkpoint, Rule chain, Output. Rule chain and Output are proven THROUGH THE
 * ENGINE (the call stack lives there); the handlers' own rules through
 * `fakeContext`.
 */
beforeAll(() => registerFlowNodes());

const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

async function run(type: string, msg: RuleMessage, opts: Omit<FakeContextOptions, 'type'> = {}) {
  const registered = getHandler(type);
  if (!registered) throw new Error(`no handler registered for ${type}`);
  const { ctx, calls } = fakeContext({ ...opts, type });
  try {
    await registered.handler(ctx, msg);
  } catch (err) {
    ctx.tellFailure(msg, err);
  }
  return { ctx, calls };
}

/** A test sink: records the node name and the message it received. */
function sinkType(id: string, log: { node: string; msg: RuleMessage }[]): string {
  restores.push(registerNode(id, (ctx, msg) => { log.push({ node: ctx.node.name, msg }); }));
  return id;
}

function engineFor(chains: LoadedRuleChain[], services: Partial<Parameters<typeof fakeServices>[0]> = {}) {
  const mem = memoryDeps(chains);
  const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(services), { dispose: async () => undefined }) });
  return { engine, events: mem.events };
}

const CALLEE = '0f000000-0000-4000-8000-0000000004c1';
const INNER = '0f000000-0000-4000-8000-0000000004c2';

describe('registerFlowNodes', () => {
  it('registers a handler for every BUILT flow node of the catalogue', () => {
    const built = BUILT_RULE_NODE_TYPES.filter((s) => s.group === 'flow').map((s) => s.id);
    expect(built.sort()).toEqual(['tb:flow:acknowledge', 'tb:flow:checkpoint', 'tb:flow:output', 'tb:flow:rule-chain']);
    for (const id of built) expect(getHandler(id), id).toBeDefined();
  });
});

describe('Acknowledge (TbAckNode)', () => {
  it('passes the message on unchanged under Success (the acknowledgement is queue-level in ThingsBoard; a no-op on Main)', async () => {
    const msg = testMessage({ t: 1 });
    const { calls } = await run('tb:flow:acknowledge', msg);
    expect(calls.relations()).toEqual(['Success']);
    expect(calls.next[0].msg).toBe(msg);
  });

  it('through the engine: recorded IN and OUT Success in debug', async () => {
    const ack = nodeOf('tb:flow:acknowledge', 'Ack', { debugMode: 'all' });
    const { engine, events } = engineFor([chainOf('c', docOf([ack], []), { root: true })]);
    await engine.processNow(testMessage({}));
    expect(events.map((e) => `${e.direction} ${e.relation}`)).toEqual(['IN null', 'OUT Success (unconnected)']);
  });
});

describe('Checkpoint (TbCheckpointNode)', () => {
  it('hands the message to services.durable.enqueue at THIS chain and node, and does not continue it on Main', async () => {
    const enqueued: { msg: RuleMessage; chainId: string; nodeId: string; runAt?: Date }[] = [];
    const msg = testMessage({ t: 2 });
    const { ctx, calls } = await run('tb:flow:checkpoint', msg, {
      services: { durable: { enqueue: async (m: RuleMessage, chainId: string, nodeId: string, runAt?: Date) => { enqueued.push({ msg: m, chainId, nodeId, runAt }); } } },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].msg).toBe(msg);
    expect(enqueued[0].chainId).toBe(ctx.chain.id);
    expect(enqueued[0].nodeId).toBe(ctx.node.id);
    expect(enqueued[0].runAt).toBeUndefined();
    expect(calls.relations()).toEqual([]);
  });

  it('an enqueue that fails → Failure with the error', async () => {
    const { calls } = await run('tb:flow:checkpoint', testMessage({}), {
      services: { durable: { enqueue: async () => { throw new Error('graphile down'); } } },
    });
    expect(calls.failures.map((f) => f.error)).toEqual(['graphile down']);
  });

  it('through the engine: the node after the checkpoint is NOT reached on Main (the durable job resumes there)', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const after = nodeOf(sinkType('test:t4-after-cp', log), 'After');
    const cp = nodeOf('tb:flow:checkpoint', 'Checkpoint');
    const chain = chainOf('c', docOf([cp, after], [[cp, 'Success', after]]), { root: true });
    const jobs: { chainId: string; nodeId: string }[] = [];
    const { engine } = engineFor([chain], { durable: { enqueue: async (_m: RuleMessage, chainId: string, nodeId: string) => { jobs.push({ chainId, nodeId }); } } } as Partial<RuleServices>);
    await engine.processNow(testMessage({}));
    expect(jobs).toEqual([{ chainId: chain.id, nodeId: cp.id }]);
    expect(log).toEqual([]);
  });
});

describe('Output (TbRuleChainOutputNode)', () => {
  it('returns the message to the caller under the Output node\'s NAME', async () => {
    const msg = testMessage({});
    const { calls } = await run('tb:flow:output', msg, { name: 'High temp' });
    expect(calls.outputs).toEqual([{ msg, label: 'High temp' }]);
    expect(calls.next).toEqual([]);
  });
});

describe('Rule chain (TbRuleChainInputNode)', () => {
  it('calls the configured chain with the message', async () => {
    const msg = testMessage({});
    const { calls } = await run('tb:flow:rule-chain', msg, { config: { ruleChainId: CALLEE } });
    expect(calls.chains).toEqual([{ chainId: CALLEE, msg }]);
  });

  it('no chain chosen → Failure ("Rule chain must be set!", refused by ThingsBoard at init)', async () => {
    const { calls } = await run('tb:flow:rule-chain', testMessage({}));
    expect(calls.failures.map((f) => f.error)).toEqual(['CONFIG_INVALID: Rule chain must be set!']);
    expect(calls.chains).toEqual([]);
  });

  it('a chain that calls ITSELF → Failure with ThingsBoard\'s loop message', async () => {
    const { calls } = await run('tb:flow:rule-chain', testMessage({}), { chainId: CALLEE, config: { ruleChainId: CALLEE } });
    expect(calls.chains).toEqual([]);
    expect(calls.failures.map((f) => f.error)).toEqual([
      `TbRuleChainInputNode in rule chain [${CALLEE}] is configured to forward messages back to the same rule chain it belongs to. `
      + 'This would cause an infinite loop. Please check the rule chain configuration.',
    ]);
  });

  it('"forward to the originator\'s default chain" falls back to the configured chain (profiles have no default chain here)', async () => {
    const { calls } = await run('tb:flow:rule-chain', testMessage({}), { config: { ruleChainId: CALLEE, forwardMsgToDefaultRuleChain: true } });
    expect(calls.chains.map((c) => c.chainId)).toEqual([CALLEE]);
  });
});

describe('Rule chain → Output through the engine (stack behaviour)', () => {
  it('the callee\'s Output returns the message to the CALLER node, out under the Output\'s name', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const sink = sinkType('test:t4-sink-a', log);
    const call = nodeOf('tb:flow:rule-chain', 'Call', { config: { ruleChainId: CALLEE } });
    const done = nodeOf(sink, 'AfterDone');
    const other = nodeOf(sink, 'AfterOther');
    const caller = chainOf('caller', docOf([call, done, other], [[call, 'Done', done], [call, 'Other', other]]), { root: true });
    const callee = chainOf('callee', docOf([nodeOf('tb:flow:output', 'Done')], []), { id: CALLEE });
    await engineFor([caller, callee]).engine.processNow(testMessage({ v: 1 }));
    expect(log.map((e) => e.node)).toEqual(['AfterDone']);
    expect(log[0].msg.data).toEqual({ v: 1 });
    expect(log[0].msg._stack ?? []).toEqual([]);
  });

  it('two Outputs: the message comes back under whichever Output it reached', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const sink = sinkType('test:t4-sink-b', log);
    restores.push(registerNode('test:t4-route', (ctx, msg) => ctx.tellNext(msg, (msg.data as { t: number }).t > 20 ? 'hot' : 'cold')));
    const call = nodeOf('tb:flow:rule-chain', 'Call', { config: { ruleChainId: CALLEE } });
    const hot = nodeOf(sink, 'Hot');
    const cold = nodeOf(sink, 'Cold');
    const caller = chainOf('caller', docOf([call, hot, cold], [[call, 'High', hot], [call, 'Low', cold]]), { root: true });
    const route = nodeOf('test:t4-route', 'Route');
    const outHigh = nodeOf('tb:flow:output', 'High');
    const outLow = nodeOf('tb:flow:output', 'Low');
    const callee = chainOf('callee', docOf([route, outHigh, outLow], [[route, 'hot', outHigh], [route, 'cold', outLow]]), { id: CALLEE });
    const { engine } = engineFor([caller, callee]);
    await engine.processNow(testMessage({ t: 25 }));
    await engine.processNow(testMessage({ t: 15 }));
    expect(log.map((e) => `${e.node}:${(e.msg.data as { t: number }).t}`)).toEqual(['Hot:25', 'Cold:15']);
  });

  it('nested calls unwind one level per Output (A calls B, B calls C)', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const sink = sinkType('test:t4-sink-c', log);
    const callB = nodeOf('tb:flow:rule-chain', 'CallB', { config: { ruleChainId: CALLEE } });
    const end = nodeOf(sink, 'End');
    const a = chainOf('A', docOf([callB, end], [[callB, 'Done', end]]), { root: true });
    const callC = nodeOf('tb:flow:rule-chain', 'CallC', { config: { ruleChainId: INNER } });
    const outB = nodeOf('tb:flow:output', 'Done');
    const b = chainOf('B', docOf([callC, outB], [[callC, 'Back', outB]]), { id: CALLEE });
    const c = chainOf('C', docOf([nodeOf('tb:flow:output', 'Back')], []), { id: INNER });
    await engineFor([a, b, c]).engine.processNow(testMessage({ deep: true }));
    expect(log.map((e) => e.node)).toEqual(['End']);
    expect(log[0].msg._stack ?? []).toEqual([]);
  });

  it('the call stays in THIS message\'s flow even when reading the target chain is slow (callChain is awaited)', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const call = nodeOf('tb:flow:rule-chain', 'Call', { config: { ruleChainId: CALLEE } });
    const done = nodeOf(sinkType('test:t4-sink-slow', log), 'AfterDone');
    const caller = chainOf('caller', docOf([call, done], [[call, 'Done', done]]), { root: true });
    const callee = chainOf('callee', docOf([nodeOf('tb:flow:output', 'Done')], []), { id: CALLEE });
    const mem = memoryDeps([caller, callee]);
    // A chain read that takes a while, as a database read does: a call recorded after the handler settled would be a
    // LATE message, and with the engine not started it would be dropped — the sink would never see it.
    const slowGetChain = async (id: string) => { await new Promise((r) => setTimeout(r, 20)); return mem.deps.getChain(id); };
    const engine = createRuleEngine({ ...mem.deps, getChain: slowGetChain, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.processNow(testMessage({ v: 7 }));
    expect(log.map((e) => e.node)).toEqual(['AfterDone']);
    expect(engine.stats().counters.late_dropped ?? 0).toBe(0);
  });

  it('a chain that does not exist → the caller\'s Failure connection (RULE_CHAIN_NOT_FOUND)', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const call = nodeOf('tb:flow:rule-chain', 'Call', { config: { ruleChainId: '0f000000-0000-4000-8000-00000000dead' } });
    const fail = nodeOf(sinkType('test:t4-sink-d', log), 'Fail');
    await engineFor([chainOf('c', docOf([call, fail], [[call, 'Failure', fail]]), { root: true })]).engine.processNow(testMessage({}));
    expect(log).toHaveLength(1);
    expect(log[0].msg.metadata.error).toMatch(/^RULE_CHAIN_NOT_FOUND/);
  });

  it('a chain that calls itself → Failure, not a loop to the hop limit', async () => {
    const log: { node: string; msg: RuleMessage }[] = [];
    const selfId = '0f000000-0000-4000-8000-0000000004c3';
    const call = nodeOf('tb:flow:rule-chain', 'Call', { config: { ruleChainId: selfId } });
    const fail = nodeOf(sinkType('test:t4-sink-e', log), 'Fail');
    await engineFor([chainOf('self', docOf([call, fail], [[call, 'Failure', fail]]), { root: true, id: selfId })]).engine.processNow(testMessage({}));
    expect(log).toHaveLength(1);
    expect(log[0].msg.metadata.error).toMatch(/^TbRuleChainInputNode in rule chain/);
  });
});
