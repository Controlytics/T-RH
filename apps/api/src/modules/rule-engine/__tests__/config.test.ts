import { describe, it, expect, vi, afterEach } from 'vitest';
import { coerceRuleEngineConfig, RULE_ENGINE_CONFIG_DEFAULTS } from '../config.js';
import { ruleEngineDef } from '../../config/defs/rule-engine.def.js';
import { logger } from '../../../lib/logger.js';

/**
 * Configuration → Rule Engine's script timeout (ruling RE-3, 2026-11-05): a
 * node script runs on the API's one event loop, and the blacklist (script-vm.ts)
 * switches a script off only after THREE consecutive time-outs — so the
 * administered maximum is 5 000 ms (worst case 15 s of a blocked loop, not
 * 90 s). The def refuses more; a row stored before the cap (or edited by hand)
 * reads as the cap, and says so in the log once per stored value.
 */
afterEach(() => { vi.restoreAllMocks(); });

const body = (patch: Record<string, unknown> = {}) => ({ ...RULE_ENGINE_CONFIG_DEFAULTS, ...patch });

describe('the script timeout is at most 5 000 ms (ruling RE-3)', () => {
  it('the def refuses 5001 and accepts 5000 — its setting and its zod schema agree', () => {
    const setting = ruleEngineDef.settings.find((s) => s.key === 'scriptTimeoutMs');
    expect(setting?.max).toBe(5_000);
    const schema = ruleEngineDef.zodSchema!;
    expect(schema.safeParse(body({ scriptTimeoutMs: 5_000 })).success).toBe(true);
    const refused = schema.safeParse(body({ scriptTimeoutMs: 5_001 }));
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain('5000 or less');
  });

  it('a stored value above it reads as 5000, logged ONCE per stored value (the engine re-reads every second)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    expect(coerceRuleEngineConfig(body({ scriptTimeoutMs: 30_000 })).scriptTimeoutMs).toBe(5_000);
    expect(coerceRuleEngineConfig(body({ scriptTimeoutMs: 30_000 })).scriptTimeoutMs).toBe(5_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ setting: 'scriptTimeoutMs', stored: 30_000, used: 5_000 });
    // A different stored value is a different row: said again.
    expect(coerceRuleEngineConfig(body({ scriptTimeoutMs: 7_000 })).scriptTimeoutMs).toBe(5_000);
    expect(warn).toHaveBeenCalledTimes(2);
    // In range: nothing to say.
    expect(coerceRuleEngineConfig(body({ scriptTimeoutMs: 4_000 })).scriptTimeoutMs).toBe(4_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the shipped default is unchanged (2 000 ms)', () => {
    expect(RULE_ENGINE_CONFIG_DEFAULTS.scriptTimeoutMs).toBe(2_000);
    expect(coerceRuleEngineConfig({}).scriptTimeoutMs).toBe(2_000);
  });
});
