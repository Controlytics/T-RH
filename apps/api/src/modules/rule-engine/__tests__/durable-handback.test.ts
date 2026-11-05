import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * M6 (whole-branch review A): the engine's stop hands every waiting durable resume
 * back to graphile in ONE `add_jobs` insert (`addDurableJobs`, engine.ts) instead of
 * one `services.durable.enqueue` per item. Two writers of one job shape is a drift
 * risk, so this pins that they write the SAME job: task, payload (the real job
 * schema parses it), queue and attempts — for a message with a stack, a hop count,
 * a re-entry depth and a non-Success relation. No database: the producer is a
 * stand-in (the SQL itself runs against the test database in rule-engine.e2e).
 */
const added: { task: string; payload: unknown; opts: Record<string, unknown> }[] = [];
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock('@digilog/queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@digilog/queue')>();
  return {
    ...real,
    getProducer: async () => ({
      addJob: async (task: string, payload: unknown, opts: Record<string, unknown>) => { added.push({ task, payload, opts }); },
      withPgClient: async (fn: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
        fn({ query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [{ count: '1' }] }; } }),
    }),
  };
});

const { createRuleServices } = await import('../services.js');
const { addDurableJobs } = await import('../engine.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');
const { newMessage } = await import('../message.js');
const { ruleEngineMessageJobSchema } = await import('@digilog/queue');
const { prisma } = await import('../../../lib/prisma.js');

const CHAIN = '0f000000-0000-4000-8000-00000000001c';
const NODE = '0f000000-0000-4000-8000-00000000001d';

beforeEach(() => {
  added.length = 0;
  queries.length = 0;
  // enqueue counts the originator's waiting jobs first (the durable cap): an empty queue here.
  vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{ n: 0 }] as never);
});
afterEach(() => { vi.restoreAllMocks(); });

type Spec = { identifier: string; payload: unknown; queue_name: string; max_attempts: number };
const specsOf = (q: { params: unknown[] }) => JSON.parse(q.params[0] as string) as Spec[];

describe('addDurableJobs writes the job services.durable.enqueue writes (M6)', () => {
  it('same task, payload, queue and attempts — with a stack, hops, depth 1 and relation True', async () => {
    const msg = { ...newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'inst-9', code: 'C/9' }, { t: 1 }, { ts: '1' }), _hops: 6, _stack: [{ chainId: CHAIN, nodeId: NODE }] };
    const services = createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
    await services.durable.enqueue(msg, CHAIN, NODE, undefined, { reentryDepth: 1, relation: 'True' });
    await addDurableJobs([{ msg, chainId: CHAIN, nodeId: NODE, relation: 'True', reentryDepth: 1 }]);
    expect(added).toHaveLength(1);
    expect(queries).toHaveLength(1);
    const [spec] = specsOf(queries[0]);
    expect(spec.identifier).toBe(added[0].task);
    expect(spec.payload).toEqual(JSON.parse(JSON.stringify(added[0].payload)));
    expect(spec.queue_name).toBe(added[0].opts.queueName);
    expect(spec.max_attempts).toBe(added[0].opts.maxAttempts);
    const parsed = ruleEngineMessageJobSchema.parse(spec.payload);
    expect(parsed).toMatchObject({ chainId: CHAIN, resumeAfterNodeId: NODE, relation: 'True' });
    expect(parsed.message).toMatchObject({ _hops: 6, _reentryDepth: 1, _stack: [{ chainId: CHAIN, nodeId: NODE }] });
  });

  it('depth 0 and Success: neither written, as enqueue writes neither', async () => {
    const msg = newMessage('X', { type: 'SYSTEM', id: 'SYSTEM' }, {}, {});
    const services = createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
    await services.durable.enqueue(msg, CHAIN, NODE, undefined, { reentryDepth: 0, relation: 'Success' });
    await addDurableJobs([{ msg, chainId: CHAIN, nodeId: NODE, relation: 'Success', reentryDepth: 0 }]);
    const [spec] = specsOf(queries[0]);
    expect(spec.payload).toEqual(JSON.parse(JSON.stringify(added[0].payload)));
    expect(spec.payload).not.toHaveProperty('relation');
    expect((spec.payload as { message: object }).message).not.toHaveProperty('_reentryDepth');
  });

  it('ONE statement for the whole batch, the specs in order; nothing for an empty batch', async () => {
    const msgs = [1, 2, 3].map((n) => newMessage('X', { type: 'INSTRUMENT', id: `inst-${n}` }, { n }, {}));
    await addDurableJobs(msgs.map((msg) => ({ msg, chainId: CHAIN, nodeId: NODE, relation: 'Success', reentryDepth: 0 })));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/graphile_worker\.add_jobs/);
    expect(specsOf(queries[0]).map((s) => s.queue_name)).toEqual(['rule-engine:inst-1', 'rule-engine:inst-2', 'rule-engine:inst-3']);
    // The batch's first place in the whole hand-back rides along (run_at = now() + place µs).
    expect(queries[0].params[1]).toBe(0);
    await addDurableJobs(msgs.slice(0, 1).map((msg) => ({ msg, chainId: CHAIN, nodeId: NODE, relation: 'Success', reentryDepth: 0 })), 500);
    expect(queries[1].params[1]).toBe(500);
    await addDurableJobs([]);
    expect(queries).toHaveLength(2);
  });
});
