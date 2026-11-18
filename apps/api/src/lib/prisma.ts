import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient } from '@prisma/client';

/**
 * THREE connection pools, one `prisma` (performance audit 2026-11-17, P-04).
 *
 * There was one pool of 9 for everything: under a slow database the dashboard,
 * alarm and bell polls held all nine and sign-in, health and acknowledgement
 * failed with a pool timeout after 10 s (E2, measured). Now:
 *
 * - `general` — every request and task, unless said otherwise.
 * - `critical` — a small RESERVED pool for the requests that must keep answering
 *   when the rest is busy: sign-in / sign-out / refresh / me, `/api/health`, alarm
 *   acknowledgement. A route opts in with `config: { dbPool: 'critical' }`.
 * - `long` — backup export / restore / validate, chain verification and partition
 *   maintenance: no time limit, its own two connections, so a long operation is
 *   never cut and never takes a request's connection.
 *
 * `prisma` is the client of the pool the CURRENT request or task runs in
 * (AsyncLocalStorage, set by `registerDbPoolHook` from the route's config, or by
 * `runOnPool`), so everything a request calls — `auditLog`, config loaders,
 * repositories — lands on the same pool without being told.
 *
 * Time limits, per connection (`options=-c statement_timeout=…`: set on OUR
 * connections only, never on the `digilog` role, which the sibling DigiLog app
 * shares): `general` and `critical` cut a statement after 5 min and abandon a
 * connection that gives no answer for 5 min (`socket_timeout` — a statement limit
 * cannot end a HUNG connection, nothing reaches the server). 5 min is the longest
 * read the browser waits for (`LONG_READ_TIMEOUT_MS`), so no legitimate report is
 * cut; it bounds what used to have no bound at all. `long` has neither. A cut
 * statement is a 503 (`databaseUnavailable`).
 */
export type DbPool = 'general' | 'critical' | 'long';

const STATEMENT_LIMIT_MS = 5 * 60_000;
const SOCKET_LIMIT_S = 5 * 60 + 5;

interface PoolSettings {
  connectionLimit: number;
  poolTimeoutS: number;
  connectTimeoutS: number;
  statementTimeoutMs: number; // 0 = none
  socketTimeoutS: number | null;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function poolSettings(pool: DbPool, env: NodeJS.ProcessEnv = process.env): PoolSettings {
  switch (pool) {
    case 'critical':
      // A 15 s connect bound, not Prisma's 5 s: the reserved pool must still open a
      // connection to a database that is slow to answer (the R1 retest at 1 s per
      // round trip failed sign-in on exactly that); `warmPool` opens them at boot.
      return { connectionLimit: intFromEnv(env.DB_POOL_CRITICAL, 3), poolTimeoutS: 10, connectTimeoutS: 15, statementTimeoutMs: STATEMENT_LIMIT_MS, socketTimeoutS: SOCKET_LIMIT_S };
    case 'long':
      return { connectionLimit: intFromEnv(env.DB_POOL_LONG, 2), poolTimeoutS: 60, connectTimeoutS: 5, statementTimeoutMs: 0, socketTimeoutS: null };
    case 'general':
    default:
      return { connectionLimit: intFromEnv(env.DB_POOL_GENERAL, 10), poolTimeoutS: 10, connectTimeoutS: 5, statementTimeoutMs: STATEMENT_LIMIT_MS, socketTimeoutS: SOCKET_LIMIT_S };
  }
}

/**
 * The URL a pool's client connects with — pure, so it is unit-tested. Adds the
 * pool's own `connection_limit`, `pool_timeout`, `socket_timeout` and
 * `statement_timeout` (inside `options`, beside any options already there); a
 * parameter the operator already put in DATABASE_URL is kept for `general`.
 */
export function poolUrl(base: string, pool: DbPool, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(base);
  const s = poolSettings(pool, env);
  const keepOperator = pool === 'general';
  const set = (key: string, value: string | null) => {
    if (keepOperator && url.searchParams.has(key)) return;
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  };
  set('connection_limit', String(s.connectionLimit));
  set('pool_timeout', String(s.poolTimeoutS));
  set('connect_timeout', String(s.connectTimeoutS));
  // Names the pool in pg_stat_activity, so an operator (and the e2e) can see which
  // pool a connection belongs to.
  set('application_name', `compliance-core:${pool}`);
  set('socket_timeout', s.socketTimeoutS === null ? null : String(s.socketTimeoutS));
  const existing = (url.searchParams.get('options') ?? '').replace(/-c\s*statement_timeout=\S+/g, '').trim();
  const options = `${existing} -c statement_timeout=${s.statementTimeoutMs}`.trim();
  url.searchParams.set('options', options);
  return url.toString();
}

const clients = new Map<DbPool, PrismaClient>();

function clientFor(pool: DbPool): PrismaClient {
  let client = clients.get(pool);
  if (!client) {
    const base = process.env.DATABASE_URL;
    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      ...(base ? { datasources: { db: { url: poolUrl(base, pool) } } } : {}),
      // The reserved pool's interactive transactions (a sign-in's audit row, an
      // acknowledgement) get 15 s to start and 60 s to finish instead of Prisma's 2 s
      // and 5 s: the R1 retest at 1 s per round trip got sign-in through the pool and
      // then lost it to P2028 when its audit transaction passed 5 s. The other pools
      // keep Prisma's defaults — nothing else changes behaviour.
      ...(pool === 'critical' ? { transactionOptions: { maxWait: 15_000, timeout: 60_000 } } : {}),
    });
    clients.set(pool, client);
  }
  return client;
}

const currentPool = new AsyncLocalStorage<DbPool>();

/** The pool the current request or task runs in. */
export function currentDbPool(): DbPool {
  return currentPool.getStore() ?? 'general';
}

/** Run `fn` — and everything it calls — on `pool`. For a worker task; routes use `config.dbPool`. */
export function runOnPool<T>(pool: DbPool, fn: () => T): T {
  return currentPool.run(pool, fn);
}

/**
 * The client of the CURRENT pool. Typed as a PrismaClient so the 100+ call sites
 * are unchanged; every property is read from the pool's client at call time.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(target, prop) {
    // A property SET on `prisma` itself wins, as it does on a real PrismaClient:
    // tests shadow a method or a model delegate by assignment, and `vi.spyOn`
    // installs its spy as an own property. Production code never sets one.
    if (Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop);
    const client = clientFor(currentDbPool());
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
  has(target, prop) {
    return Reflect.has(target, prop) || Reflect.has(clientFor(currentDbPool()), prop);
  },
  // An assignment `prisma.x = v` arrives here with only `{ value }`. Defining a NEW
  // property from that would make it read-only and non-configurable (the defaults
  // of a partial descriptor), so the shadow could never be put back or deleted.
  defineProperty(target, prop, descriptor) {
    if (Reflect.getOwnPropertyDescriptor(target, prop)) return Reflect.defineProperty(target, prop, descriptor);
    const accessor = 'get' in descriptor || 'set' in descriptor;
    return Reflect.defineProperty(target, prop, {
      configurable: true,
      enumerable: true,
      ...(accessor ? {} : { writable: true }),
      ...descriptor,
    });
  },
  // `vi.spyOn` asks for the property's descriptor before replacing it.
  getOwnPropertyDescriptor(target, prop) {
    const own = Reflect.getOwnPropertyDescriptor(target, prop);
    if (own) return own;
    if (!Reflect.has(clientFor(currentDbPool()), prop)) return undefined;
    return { configurable: true, enumerable: true, writable: true, value: Reflect.get(prisma as object, prop) };
  },
});

/** For a test or a pool-specific check: the client of a named pool. */
export function prismaFor(pool: DbPool): PrismaClient {
  return clientFor(pool);
}

/**
 * Open every connection of a pool now, so the first request that needs it does not
 * have to (performance audit R1, P-04): the reserved pool exists for the moment the
 * database is slow, which is exactly when a new connection is slow to open. Each
 * query holds its connection briefly, so the pool has to open all of them.
 */
export async function warmPool(pool: DbPool): Promise<number> {
  const client = clientFor(pool);
  const n = poolSettings(pool).connectionLimit;
  // $executeRaw: pg_sleep returns void, which $queryRaw cannot deserialize.
  await Promise.all(Array.from({ length: n }, () => client.$executeRaw`SELECT pg_sleep(0.2)`));
  return n;
}

/** Close every pool that was opened (shutdown, test teardown). */
export async function disconnectAllPrisma(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
}

/**
 * Enter a route's pool for the whole request lifecycle. Registered BEFORE the auth
 * plugin, so the session check of a critical route runs on the critical pool too.
 * `run(…, done)` — the documented AsyncLocalStorage pattern for a Fastify hook:
 * the rest of the request continues inside `done`.
 */
export function registerDbPoolHook(app: {
  addHook: (name: 'onRequest', fn: (req: { routeOptions?: { config?: unknown } }, reply: unknown, done: () => void) => void) => unknown;
}): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const pool = (req.routeOptions?.config as { dbPool?: DbPool } | undefined)?.dbPool;
    if (pool === 'critical' || pool === 'long') currentPool.run(pool, done);
    else done();
  });
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Which database pool the request runs on (performance audit 2026-11-17, P-04). */
    dbPool?: DbPool;
  }
}
