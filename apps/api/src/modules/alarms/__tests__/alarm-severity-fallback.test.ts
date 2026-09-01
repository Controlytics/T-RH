import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALARM_SEVERITY_FALLBACK } from '@digilog/shared';

/**
 * `ALARM_SEVERITY_FALLBACK` is the ONE value every new alarm is stamped with, now
 * that severity is no longer administered (2026-09-01). The column is retained
 * NOT NULL because 147 alarms carry real, meaningful severity and an alarm is a
 * §11 record.
 *
 * **Why this is checked against `schema.prisma` and not against a list written
 * here.** The constant is a plain string assigned into a Prisma ENUM column.
 * TypeScript cannot catch a typo in it — `'MAJORR'` compiles — and the failure
 * would not be a wrong label on one screen: `prisma.alarm.create` would throw on
 * an invalid enum value, so EVERY raise in all four alarm passes would fail, and
 * it would fail at runtime on a live installation rather than in CI. Restating
 * the three values in this file would only assert that two hand-written lists
 * agree; reading the schema asserts the constant matches the DATABASE.
 */
const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../../../prisma/schema.prisma', import.meta.url)),
  'utf-8',
);

function enumValues(name: string): string[] {
  const m = SCHEMA.match(new RegExp(`^enum ${name} \\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`enum ${name} not found in schema.prisma`);
  return m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
}

describe('ALARM_SEVERITY_FALLBACK', () => {
  it('is a value the AlarmSeverity enum actually accepts', () => {
    // Guard the guard: if the regex ever stops finding the enum this must fail
    // loudly rather than pass against an empty list.
    const values = enumValues('AlarmSeverity');
    expect(values.length).toBeGreaterThan(0);
    expect(values).toContain(ALARM_SEVERITY_FALLBACK);
  });

  it('is still a required column, which is why a fallback is needed at all', () => {
    // `severity AlarmSeverity` with no `?` and no `@default`. If this line ever
    // becomes nullable or gains a default, the fallback stops being load-bearing
    // and this file should be revisited — but until then, removing the constant
    // breaks every alarm insert.
    expect(SCHEMA).toMatch(/^\s*severity\s+AlarmSeverity\s*$/m);
  });
});
