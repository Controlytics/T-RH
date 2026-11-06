import { describe, it, expect, afterEach } from 'vitest';

/**
 * The ADMITTED origin (review A I2 follow-up, 2026-11-05): what a §11 row says a
 * message came from is the `rule_engine_origin` the engine admitted it with,
 * carried on the flow context (context.ts) like the re-entry depth — never the
 * metadata a node may have rewritten since. Pinned for a root message, a LATE call
 * (a handler emitting after it settled, which re-enters the queue as a new item)
 * and a tellSelf: each keeps its flow's admitted origin although a node upstream
 * rewrote `metadata.rule_engine_origin`. A DURABLE resume (Delay / Checkpoint) takes
 * the origin its JOB carries (`message._admittedOrigin`), and the stop hands a waiting
 * resume back with it. No database: chains, debug sink and services are in memory.
 */
const { createRuleEngine } = await import('../engine.js');
type DurableHandBack = import('../engine.js').DurableHandBack;
const { serialisableMessage } = await import('../message.js');
const { runRuleEngineMessage } = await import('../../../workers/rule-engine-message.worker.js');
const { registerNode } = await import('../registry.js');
const { currentAdmittedOrigin } = await import('../context.js');
const { chainOf, docOf, nodeOf, memoryDeps, fakeServices, testMessage } = await import('../../../test-support/rule-engine.js');

const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

function type(id: string, fn: Parameters<typeof registerNode>[1]): string {
  restores.push(registerNode(id, fn));
  return id;
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A node that rewrites the metadata origin, as a Script / Copy keys / Rename keys node or a REST header can. */
const spoof = () => type('test:origin-spoof', (ctx, msg) => {
  ctx.tellNext({ ...msg, metadata: { ...msg.metadata, rule_engine_origin: 'ingest' } }, 'Success');
});

async function withEngine(chain: ReturnType<typeof chainOf>, fn: (engine: Awaited<ReturnType<typeof createRuleEngine>>) => Promise<void>) {
  const mem = memoryDeps([chain]);
  const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
  await engine.start();
  try {
    await fn(engine);
  } finally {
    await engine.stop();
  }
}

describe('the admitted origin rides the flow, not the metadata', () => {
  it('a root message: a node downstream of a rewrite still sees the origin it was admitted with', async () => {
    const seen: { admitted: string | undefined; metadata: string | undefined }[] = [];
    const s = nodeOf(spoof(), 'S');
    const r = nodeOf(type('test:origin-read', (_ctx, msg) => { seen.push({ admitted: currentAdmittedOrigin(), metadata: msg.metadata.rule_engine_origin }); }), 'R');
    await withEngine(chainOf('c', docOf([s, r], [[s, 'Success', r]]), { root: true }), async (engine) => {
      expect(engine.enqueue(testMessage({ t: 1 }, { metadata: { rule_engine_origin: 'rest_api' } }))).toBe(true);
      await waitFor(() => seen.length === 1);
    });
    expect(seen).toEqual([{ admitted: 'rest_api', metadata: 'ingest' }]);
  });

  it('a LATE call (a handler emitting after it settled) keeps its flow\'s admitted origin, not the rewritten metadata', async () => {
    const seen: (string | undefined)[] = [];
    const s = nodeOf(spoof(), 'S');
    const late = nodeOf(type('test:origin-late', (ctx, msg) => { setTimeout(() => ctx.tellNext(msg, 'Success'), 10); }), 'L');
    const r = nodeOf(type('test:origin-read2', () => { seen.push(currentAdmittedOrigin()); }), 'R');
    await withEngine(chainOf('c', docOf([s, late, r], [[s, 'Success', late], [late, 'Success', r]]), { root: true }), async (engine) => {
      engine.enqueue(testMessage({ t: 1 }, { metadata: { rule_engine_origin: 'rest_api' } }));
      await waitFor(() => seen.length === 1);
    });
    expect(seen).toEqual(['rest_api']);
  });

  it('a tellSelf keeps its flow\'s admitted origin too', async () => {
    const seen: (string | undefined)[] = [];
    const s = nodeOf(spoof(), 'S');
    const again = nodeOf(type('test:origin-self', async (ctx, msg) => {
      seen.push(currentAdmittedOrigin());
      if (seen.length < 2) await ctx.tellSelf(msg, 5);
    }), 'A');
    await withEngine(chainOf('c', docOf([s, again], [[s, 'Success', again]]), { root: true }), async (engine) => {
      engine.enqueue(testMessage({ t: 1 }, { metadata: { rule_engine_origin: 'user' } }));
      await waitFor(() => seen.length === 2);
    });
    expect(seen).toEqual(['user', 'user']);
  });
});

describe('a DURABLE resume keeps the origin its flow was admitted with (the job\'s _admittedOrigin)', () => {
  /** The real worker resumes a job AFTER D whose message metadata says "ingest"; R reads the resumed flow's origin. */
  async function originOnResume(job: Record<string, unknown>): Promise<string | undefined> {
    const seen: (string | undefined)[] = [];
    const d = nodeOf(type('test:origin-delay', () => undefined), 'D');
    const r = nodeOf(type('test:origin-resumed', () => { seen.push(currentAdmittedOrigin()); }), 'R');
    const chain = chainOf('c', docOf([d, r], [[d, 'Success', r]]), { root: true });
    await withEngine(chain, async (engine) => {
      const m = testMessage({ t: 1 }, { metadata: { rule_engine_origin: 'ingest' } });
      const payload = { message: { ...serialisableMessage(m), ...job }, chainId: chain.id, resumeAfterNodeId: d.id };
      expect(await runRuleEngineMessage(payload, engine)).toBe('admitted');
      await waitFor(() => seen.length === 1);
    });
    return seen[0];
  }

  it('the job\'s _admittedOrigin, not the metadata a node rewrote before the hand-over', async () => {
    expect(await originOnResume({ _admittedOrigin: 'rest_api' })).toBe('rest_api');
  });

  it('null = the flow was admitted with NONE: still never the metadata', async () => {
    expect(await originOnResume({ _admittedOrigin: null })).toBeUndefined();
  });

  it('a job queued before the field (absent): the metadata, as before', async () => {
    expect(await originOnResume({})).toBe('ingest');
  });

  it('the stop hands a waiting resume back WITH its admitted origin (null = none; a legacy resume, its metadata at admission)', async () => {
    const batches: DurableHandBack[][] = [];
    const hold = nodeOf(type('test:origin-hold', () => new Promise<void>(() => undefined)), 'Hold');
    const d = nodeOf(type('test:origin-delay2', () => undefined), 'D');
    const chain = chainOf('c', docOf([hold, d], [], hold), { root: true });
    const engine = createRuleEngine({
      ...memoryDeps([chain]).deps, budgetMs: 60_000, stopWaitMs: 20, durableHandBackBudgetMs: 5_000,
      handBackDurable: async (items) => { batches.push([...items]); },
      services: () => Object.assign(fakeServices(), { dispose: async () => undefined }),
    });
    await engine.start();
    // Originator A is held in flight, so every resume for A WAITS in the queue until the stop.
    engine.enqueue(testMessage({}, { originator: { id: 'A' } }));
    await waitFor(() => engine.stats().inFlight === 1);
    const spoofed = () => testMessage({}, { originator: { id: 'A' }, metadata: { rule_engine_origin: 'ingest' } });
    expect(engine.resumeAfter(spoofed(), chain.id, d.id, ['Success'], { admittedOrigin: 'rest_api' })).toBe(true);
    expect(engine.resumeAfter(spoofed(), chain.id, d.id, ['Success'], { admittedOrigin: null })).toBe(true);
    expect(engine.resumeAfter(spoofed(), chain.id, d.id)).toBe(true);
    await engine.stop();
    expect(batches.flat().map((i) => i.admittedOrigin)).toEqual(['rest_api', null, 'ingest']);
  });
});
