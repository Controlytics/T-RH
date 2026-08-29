import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, attachLogger, detachLogger } from '../logger.js';

/**
 * The point of this module is that ~40 sites written in console's
 * `(msg, extra)` order and ~38 written in pino's `(obj, msg)` order end up on
 * ONE stream, in ONE format, honouring ONE level. These assert exactly that.
 */

function fakeSink() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('logger — delegation to Fastify', () => {
  afterEach(() => detachLogger());

  it('sends to the attached sink', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.info('hello');
    expect(sink.info).toHaveBeenCalledWith('hello');
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('routes %s to the matching sink method', (level) => {
    const sink = fakeSink();
    attachLogger(sink);
    logger[level]('m');
    expect(sink[level]).toHaveBeenCalled();
  });

  // The migration rewrote console.warn('msg', { ctx }) to logger.warn(...)
  // WITHOUT swapping the arguments — 40 chances to get one backwards. The
  // logger reorders instead, so this is the assertion that keeps that safe.
  it('accepts console order (msg, obj) and emits pino order (obj, msg)', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.warn('[ingest] rejected', { code: 'BAD_TOKEN' });
    expect(sink.warn).toHaveBeenCalledWith({ code: 'BAD_TOKEN' }, '[ingest] rejected');
  });

  it('accepts pino order (obj, msg) unchanged', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.error({ instrumentId: 'i-1' }, 'decrypt failed');
    expect(sink.error).toHaveBeenCalledWith({ instrumentId: 'i-1' }, 'decrypt failed');
  });

  // console.error('msg', err) was a common shape. Losing the error would leave
  // a message with no cause, which is the failure this whole change is about.
  it('keeps an Error passed as the second argument', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.error('write failed', new Error('db down'));
    const [obj, msg] = sink.error.mock.calls[0];
    expect(msg).toBe('write failed');
    expect(JSON.stringify(obj)).toContain('db down');
  });

  it('keeps a non-object second argument rather than dropping it', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.info('count', 42);
    expect(sink.info).toHaveBeenCalledWith({ detail: 42 }, 'count');
  });

  it('handles an Error as the first argument', () => {
    const sink = fakeSink();
    attachLogger(sink);
    logger.error(new Error('boom'));
    const [obj, msg] = sink.error.mock.calls[0];
    expect(msg).toBe('boom');
    expect(obj).toMatchObject({ err: 'boom' });
  });
});

describe('logger — fallback before Fastify exists', () => {
  const originalEnv = process.env.NODE_ENV;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    detachLogger();
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.env.NODE_ENV = originalEnv;
    delete process.env.LOG_LEVEL;
  });

  it('writes one JSON object per line', () => {
    logger.info('started');
    const line = stdout.mock.calls[0][0] as string;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe('started');
    expect(parsed.level).toBe('info');
  });

  it('merges context fields into the record', () => {
    logger.info('ingested', { instrumentId: 'i-1' });
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.instrumentId).toBe('i-1');
  });

  it('sends warn and error to stderr', () => {
    logger.warn('careful');
    logger.error('broken');
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stdout).not.toHaveBeenCalled();
  });

  // The whole reason console.* was a problem: it printed regardless of level.
  it('honours the level — debug is suppressed in production', () => {
    process.env.NODE_ENV = 'production';
    logger.debug('noisy');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('emits debug outside production', () => {
    process.env.NODE_ENV = 'development';
    logger.debug('noisy');
    expect(stdout).toHaveBeenCalled();
  });

  it('LOG_LEVEL overrides the NODE_ENV default', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_LEVEL = 'warn';
    logger.info('suppressed');
    expect(stdout).not.toHaveBeenCalled();
    logger.warn('kept');
    expect(stderr).toHaveBeenCalled();
  });
});
