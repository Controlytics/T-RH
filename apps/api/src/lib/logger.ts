/**
 * The one place server-side logging goes.
 *
 * WHY (audit M5, restated after measuring — the original finding was wrong)
 * -----------------------------------------------------------------------
 * The audit reported "only 32 log statements across ~40,000 lines" and
 * concluded the backend was under-logged, naming the workers, the MQTT
 * lifecycle and ingest rejections as logging nothing. Re-measured properly on
 * 2026-08-29, that was two errors in one:
 *
 *   - The count missed `helpers.logger.*` in the graphile-worker tasks, because
 *     the grep pattern `log\.(info|warn)` does not match `logger.info`.
 *   - It missed 42 `console.*` calls entirely. The ingest listeners, the MQTT
 *     bridge, the enqueue helpers and the config discovery all DO log — just
 *     not through Fastify.
 *
 * The real figure is ~80 logging sites, and the real defect is that they go
 * through TWO mechanisms with different behaviour:
 *
 *   - `app.log.*` (pino) honours `logger.level` — `info` in production,
 *     `debug` otherwise — emits structured JSON, and carries request context.
 *   - `console.*` honours nothing. A `console.log` debug line prints in
 *     production no matter the level, unstructured, with no request id, and
 *     interleaved with pino's JSON so a log processor sees two formats on one
 *     stream.
 *
 * That is worse than too little logging: it is logging you cannot turn down,
 * filter, or parse. This module gives both halves one API.
 *
 * HOW IT WORKS
 * ------------
 * `attachLogger(app.log)` is called once in app.ts after the Fastify instance
 * exists. Before that — and in scripts, workers and unit tests that never build
 * an app — calls fall back to a console writer that still respects the level.
 * So a module can import `logger` at the top level without caring whether it
 * runs inside the server, a graphile-worker task, or `tsx some-script.ts`.
 *
 * Deliberately NOT a direct `pino` import: pino is not a declared dependency of
 * this package (it arrives under `fastify/node_modules`), and reaching into a
 * transitive dependency is exactly the kind of undeclared coupling this audit
 * complained about elsewhere. Delegating to the instance Fastify already built
 * gets the same logger without the dependency question.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The subset of pino's surface used here — structurally satisfied by app.log. */
export interface LoggerSink {
  debug(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Matches app.ts's Fastify logger config so the fallback cannot disagree with it. */
function configuredLevel(): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (explicit && explicit in ORDER) return explicit as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

let sink: LoggerSink | null = null;

/**
 * Point this module at Fastify's logger. Called once from app.ts. Safe to call
 * again (last one wins) — tests build several apps in one process.
 */
export function attachLogger(target: LoggerSink): void {
  sink = target;
}

/** Drop back to the console writer. For tests that assert the fallback path. */
export function detachLogger(): void {
  sink = null;
}

/**
 * Normalise the two argument orders this codebase uses into pino's.
 *
 * pino is (obj, msg). `console.*` is (msg, ...extras), and the ~40 migrated
 * call sites are written that way — `logger.warn('[ingest] rejected', { code })`.
 * Rewriting them all to swap the arguments would have been ~40 chances to get
 * one backwards for no benefit, so the logger accepts both and puts them into
 * pino's order here, once.
 */
function normalise(a: unknown, b?: unknown): { obj?: Record<string, unknown>; msg: string } {
  const asRecord = (v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error)
      ? (v as Record<string, unknown>)
      : undefined;

  if (typeof a === 'string') {
    // console order: (msg, extra?)
    if (b === undefined) return { msg: a };
    const obj = asRecord(b);
    if (obj) return { obj, msg: a };
    // A non-object second argument (an Error, a number, an array) still has to
    // survive — dropping it would lose the only detail on the line.
    return { obj: { detail: b instanceof Error ? (b.stack ?? b.message) : b }, msg: a };
  }
  // pino order: (obj, msg?)
  if (a instanceof Error) {
    return { obj: { err: a.message, stack: a.stack }, msg: typeof b === 'string' ? b : a.message };
  }
  return { obj: asRecord(a), msg: typeof b === 'string' ? b : '' };
}

function fallback(level: LogLevel, obj: Record<string, unknown> | undefined, msg: string): void {
  if (ORDER[level] < ORDER[configuredLevel()]) return;
  // One JSON object per line, the same shape pino emits, so a log processor
  // sees one format on the stream whether or not Fastify is up yet.
  const line = JSON.stringify({ level, time: Date.now(), ...(obj ?? {}), msg });
  // stderr for warn/error, stdout otherwise — matches how WinSW splits its logs.
  const out = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  out.write(`${line}\n`);
}

function emit(level: LogLevel, a: unknown, b?: unknown): void {
  const { obj, msg } = normalise(a, b);
  if (sink) {
    if (obj) (sink[level] as (o: unknown, m?: string) => void)(obj, msg);
    else (sink[level] as (m: string) => void)(msg);
    return;
  }
  fallback(level, obj, msg);
}

export const logger = {
  debug: (a: unknown, b?: unknown) => emit('debug', a, b),
  info: (a: unknown, b?: unknown) => emit('info', a, b),
  warn: (a: unknown, b?: unknown) => emit('warn', a, b),
  error: (a: unknown, b?: unknown) => emit('error', a, b),
};
