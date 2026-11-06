import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `services.durable.enqueue` — what the Delay and Checkpoint nodes hand to
 * graphile-worker (ruling RE-2's hand-back now goes through `addDurableJobs`). The
 * job carries the message's hop count and call stack (ruled 2026-11-04) and the
 * RE-ENTRY DEPTH of the flow that handed it over (ruling RE-1): a re-entered
 * message's Delay must not come back as a first-generation one. It is built by
 * `durableJobPayload` (message.ts), the ONE job shape (fw-api open item 2), and it is
 * REFUSED when the originator's queue already holds `queueCapacity` waiting jobs
 * (fw-api open item 3). No database: the producer is a stand-in and the queue count
 * is a spy on `prisma.$queryRaw`; the job SCHEMA is the real one, so a field zod
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

const { createRuleServices, durableQueueDepth } = await import('../services.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');
const { runInFlow } = await import('../context.js');
const { newMessage, durableJobPayload, DURABLE_JOB_MAX_ATTEMPTS } = await import('../message.js');
const { ruleEngineMessageJobSchema } = await import('@digilog/queue');
const { prisma } = await import('../../../lib/prisma.js');

const CHAIN = '0f000000-0000-4000-8000-00000000000c';
const NODE = '0f000000-0000-4000-8000-00000000000d';
const services = (queueCapacity = RULE_ENGINE_CONFIG_DEFAULTS.queueCapacity) =>
  createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS, queueCapacity }), inc: () => undefined });
const msg = () => ({ ...newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'inst-1' }, { t: 1 }, { ts: 1 }), _hops: 4 });

/** The queue count the services read — every call recorded (the SQL and its values). */
let waiting = 0;
let counts: { sql: string; values: unknown[] }[] = [];
beforeEach(() => {
  jobs.length = 0;
  waiting = 0;
  counts = [];
  vi.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    counts.push({ sql: strings.join('?'), values });
    return Promise.resolve([{ n: waiting }]);
  }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

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

  it('review A I2: the job carries the flow\'s ADMITTED origin, never the metadata a node rewrote — null when the flow was admitted with none; outside a flow, the metadata (nothing was admitted)', async () => {
    const spoofed = () => { const m = msg(); return { ...m, metadata: { ...m.metadata, rule_engine_origin: 'ingest' } }; };
    await runInFlow({ reentryDepth: 0, admittedOrigin: 'rest_api' }, () => services().durable.enqueue(spoofed(), CHAIN, NODE));
    await runInFlow({ reentryDepth: 0 }, () => services().durable.enqueue(spoofed(), CHAIN, NODE));
    await services().durable.enqueue(spoofed(), CHAIN, NODE);
    // Through the REAL job schema: a field zod strips would come back undefined here.
    const origins = jobs.map((j) => ruleEngineMessageJobSchema.parse(JSON.parse(JSON.stringify(j.payload))).message._admittedOrigin);
    expect(origins).toEqual(['rest_api', null, 'ingest']);
  });

  it('builds its job with durableJobPayload — the ONE job shape (fw-api open item 2) — with the shared attempts and the runAt', async () => {
    const m = { ...msg(), _stack: [{ chainId: CHAIN, nodeId: NODE }] };
    const runAt = new Date(Date.now() + 60_000);
    await runInFlow({ reentryDepth: 1 }, () => services().durable.enqueue(m, CHAIN, NODE, runAt, { relation: 'False' }));
    expect(jobs[0].payload).toEqual(durableJobPayload(m, CHAIN, NODE, { reentryDepth: 1, admittedOrigin: null, relation: 'False' }));
    expect(jobs[0].opts).toEqual({ queueName: 'rule-engine:inst-1', runAt, maxAttempts: DURABLE_JOB_MAX_ATTEMPTS });
  });
});

describe('the durable cap: queueCapacity waiting jobs on the originator\'s queue (fw-api open item 3)', () => {
  it('room left → queued; AT the capacity → refused DURABLE_QUEUE_FULL, nothing queued (the node\'s Failure)', async () => {
    waiting = 99;
    await services(100).durable.enqueue(msg(), CHAIN, NODE);
    expect(jobs).toHaveLength(1);
    waiting = 100;
    await expect(services(100).durable.enqueue(msg(), CHAIN, NODE))
      .rejects.toThrow('DURABLE_QUEUE_FULL: 100 messages of this originator already wait in the Delay / Checkpoint queue (rule-engine:inst-1)');
    expect(jobs).toHaveLength(1);
  });

  it('the count reads THIS originator\'s queue, only jobs with attempts left, and stops at the capacity (LIMIT)', async () => {
    await services(250).durable.enqueue(msg(), CHAIN, NODE);
    expect(counts).toHaveLength(1);
    expect(counts[0].values).toEqual(['rule-engine:inst-1', 250]);
    expect(counts[0].sql).toMatch(/q\.queue_name = \?/);
    expect(counts[0].sql).toMatch(/j\.attempts < j\.max_attempts/);
    expect(counts[0].sql).toMatch(/LIMIT \?::int/);
  });

  it('durableQueueDepth returns the count the query gives', async () => {
    waiting = 7;
    expect(await durableQueueDepth('rule-engine:x', 100)).toBe(7);
  });
});
