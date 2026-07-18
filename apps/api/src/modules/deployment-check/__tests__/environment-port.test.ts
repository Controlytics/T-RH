import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { checkEnvironment } from '../routes.js';

/**
 * The deployment check used to validate API_PORT, which nothing reads —
 * app.ts binds `process.env.PORT ?? '3000'`. That inverted the check's whole
 * purpose: a correct install (scripts/install.ps1 writes PORT) was reported as
 * a WARN, and an install that set API_PORT=8080 expecting the server to move
 * was reported as a PASS while it kept listening on 3000.
 */

const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_API_PORT = process.env.API_PORT;

function portCheck() {
  const found = checkEnvironment().find((c) => c.name === 'PORT');
  if (!found) throw new Error('no PORT sub-check was produced');
  return found;
}

describe('checkEnvironment — listen port', () => {
  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.API_PORT;
  });

  afterAll(() => {
    if (ORIGINAL_PORT === undefined) delete process.env.PORT;
    else process.env.PORT = ORIGINAL_PORT;
    if (ORIGINAL_API_PORT === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = ORIGINAL_API_PORT;
  });

  it('checks PORT — the variable app.ts actually binds', () => {
    // Guards the rename itself: if the check reverts to API_PORT there is no
    // PORT sub-check at all and portCheck() throws.
    process.env.PORT = '3000';
    expect(portCheck().status).toBe('PASS');
  });

  it('PASSes on a correct install: PORT set, API_PORT absent', () => {
    process.env.PORT = '8080';
    const c = portCheck();
    expect(c.status).toBe('PASS');
    expect(c.found).toBe('8080');
  });

  it('does NOT report API_PORT as the port variable', () => {
    process.env.API_PORT = '8080';
    expect(checkEnvironment().some((c) => c.name === 'API_PORT')).toBe(false);
  });

  it('WARNs — not PASSes — when only API_PORT is set, and names the real variable', () => {
    // The trap: API_PORT=8080 reads as "we moved the port" but the server still
    // listens on 3000. This must never be a PASS.
    process.env.API_PORT = '8080';
    const c = portCheck();
    expect(c.status).toBe('WARN');
    expect(c.found).toBe('3000');
    expect(c.message).toMatch(/PORT/);
  });

  it('WARNs when neither is set, reporting the effective 3000 default', () => {
    const c = portCheck();
    expect(c.status).toBe('WARN');
    expect(c.found).toBe('3000');
  });

  it('PORT wins when both are set', () => {
    process.env.PORT = '9000';
    process.env.API_PORT = '8080';
    const c = portCheck();
    expect(c.status).toBe('PASS');
    expect(c.found).toBe('9000');
  });
});
