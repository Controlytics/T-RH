import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `services.durable.enqueue` — what the Delay and Checkpoint nodes hand to
 * graphile-worker, and what the engine's stop hands back (ruling RE-2). The
 * job carries the message's hop count and call stack (ruled 2026-11-04) and the
 * RE-ENTRY DEPTH of the flow that handed it over (ruling RE-1): a re-entered
 * message's Delay must not come back as a first-generation one. No database:
 * the producer is a stand-in; the job SCHEMA is the real one, so a field zod
 * would strip fails here.
 */
const jobs: { task: string; payload: unknown; opts: Record<string, unknown> }[] = [];

vi.mock('@digilog/queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@digilog/queue')>();
  return {
    ...real,
    getProducer: async () => ({
      addJob: async (task: string, payload: unknown, opts: Record<string, unknown>) => { jobs.push({ task, payload, opts }); },
    }),
  };
});

const { createRuleServices } = await import('../services.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');
const { runInFlow } = await import('../context.js');
const { newMessage } = await import('../message.js');
const { ruleEngineMessageJobSchema } = await import('@digilog/queue');

const CHAIN = '0f000000-0000-4000-8000-00000000000c';
const NODE = '0f000000-0000-4000-8000-00000000000d';
const services = () => createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
const msg = () => ({ ...newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'inst-1' }, { t: 1 }, { ts: 1 }), _hops: 4 });

beforeEach(() => { jobs.length = 0; });

describe('services.durable.enqueue', () => {
  it('inside a flow that re-entered (depth 1), the job carries _reentryDepth 1 — and survives the job schema', async () => {
    await runInFlow({ reentryDepth: 1 }, () => services().durable.enqueue(msg(), CHAIN, NODE));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task).toBe('rule_engine_message');
    expect(jobs[0].opts).toMatchObject({ queueName: 'rule-engine:inst-1' });
    const parsed = ruleEngineMessageJobSchema.parse(JSON.parse(JSON.stringify(jobs[0].payload)));
    expect(parsed.message._reentryDepth).toBe(1);
    expect(parsed.message._hops).toBe(4);
    expect(parsed.relation).toBe('Success');
  });

  it('a first-generation flow (depth 0) or no flow at all writes no depth', async () => {
    await runInFlow({ reentryDepth: 0 }, () => services().durable.enqueue(msg(), CHAIN, NODE));
    await services().durable.enqueue(msg(), CHAIN, NODE);
    for (const j of jobs) expect((j.payload as { message: Record<string, unknown> }).message).not.toHaveProperty('_reentryDepth');
  });

  it('an explicit depth and relation win over the running flow (the engine\'s stop hands a waiting resume back)', async () => {
    await runInFlow({ reentryDepth: 0 }, () => services().durable.enqueue(msg(), CHAIN, NODE, undefined, { reentryDepth: 1, relation: 'True' }));
    const parsed = ruleEngineMessageJobSchema.parse(JSON.parse(JSON.stringify(jobs[0].payload)));
    expect(parsed.message._reentryDepth).toBe(1);
    expect(parsed.relation).toBe('True');
  });
});
