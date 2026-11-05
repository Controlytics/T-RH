import { describe, it, expect, vi, afterEach } from 'vitest';
import { coerceRuleEngineConfig, RULE_ENGINE_CONFIG_DEFAULTS } from '../config.js';
import { ruleEngineDef } from '../../config/defs/rule-engine.def.js';
import { logger } from '../../../lib/logger.js';

/**
 * Configuration → Rule Engine's script timeout (ruling RE-3, 2026-11-05): a
 * node script runs on the API's one event loop, so the administered maximum is
 * 5 000 ms — ONE call can hold the loop that long (a script that times out three
 * times in a row is switched off; one that runs just under the timeout is not —
 * review A I1, accepted). The def refuses more; a row stored before the cap (or
 * edited by hand) reads as the cap, and says so in the log once per stored value.
 *
 * And the time per message (C1, 2026-11-05) — hard-coded 30 s until then — is
 * administered the same way: a bounded number, clamped on read, logged once.
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

describe('the time per message is administered (C1)', () => {
  it('a setting with bounds 1 000..300 000 and the shipped 30 000 — the def\'s setting and its zod schema agree', () => {
    const setting = ruleEngineDef.settings.find((s) => s.key === 'messageBudgetMs');
    expect(setting).toMatchObject({ type: 'number', min: 1_000, max: 300_000, default: 30_000, required: true });
    expect(RULE_ENGINE_CONFIG_DEFAULTS.messageBudgetMs).toBe(30_000);
    const schema = ruleEngineDef.zodSchema!;
    expect(schema.safeParse(body({ messageBudgetMs: 300_000 })).success).toBe(true);
    expect(schema.safeParse(body({ messageBudgetMs: 300_001 })).success).toBe(false);
    expect(schema.safeParse(body({ messageBudgetMs: 999 })).success).toBe(false);
    // The dynamic PUT replaces the row: a body without the key is refused, not silently defaulted.
    const { messageBudgetMs: _omitted, ...withoutIt } = body();
    expect(schema.safeParse(withoutIt).success).toBe(false);
  });

  it('a stored value outside the bounds reads as the bound, logged once; an absent key reads as 30 000', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    expect(coerceRuleEngineConfig(body({ messageBudgetMs: 10 })).messageBudgetMs).toBe(1_000);
    expect(coerceRuleEngineConfig(body({ messageBudgetMs: 10 })).messageBudgetMs).toBe(1_000);
    expect(coerceRuleEngineConfig(body({ messageBudgetMs: 9_999_999 })).messageBudgetMs).toBe(300_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatchObject({ setting: 'messageBudgetMs', stored: 10, used: 1_000 });
    expect(coerceRuleEngineConfig({ enabled: true }).messageBudgetMs).toBe(30_000);
  });

  it('the hop limit no longer claims a hop-limited message "goes out on Failure" — it ends; the step limit is named', () => {
    const hop = ruleEngineDef.settings.find((s) => s.key === 'hopLimit');
    expect(hop?.description).not.toMatch(/goes out on Failure/);
    expect(hop?.description).toMatch(/STEP_LIMIT/);
  });
});
