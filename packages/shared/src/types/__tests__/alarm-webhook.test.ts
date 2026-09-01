import { describe, it, expect } from 'vitest';
import {
  ALARM_WEBHOOK_EVENTS,
  ALARM_WEBHOOK_VARIABLES,
  DEFAULT_WEBHOOK_BODY_TEMPLATE,
} from '../alarm-webhook.js';

describe('alarm webhook contract', () => {
  it('offers exactly the four events', () => {
    expect([...ALARM_WEBHOOK_EVENTS]).toEqual(['RAISED', 'CLEARED', 'ACKNOWLEDGED', 'TEST']);
  });

  it('promises the common variables for every event', () => {
    for (const event of ['RAISED', 'CLEARED', 'ACKNOWLEDGED'] as const) {
      expect(ALARM_WEBHOOK_VARIABLES[event]).toEqual(
        expect.arrayContaining(['event', 'alarmId', 'instrument', 'metric', 'value', 'timestamp']),
      );
    }
  });

  // Severity stopped being an administered concept on 2026-09-01 and `${severity}`
  // went with it. Pinned as an ABSENCE because the two halves must move together:
  // `validateTargetDraft` builds its known-variable set from THIS list, so a
  // `severity` re-added here would be accepted in a body template that the renderer
  // no longer fills — shipping a literal `${severity}` to a hooter — while a
  // `severity` re-added to the renderer alone could never be typed into a template.
  it('no longer advertises severity to any event', () => {
    for (const event of ALARM_WEBHOOK_EVENTS) {
      expect(ALARM_WEBHOOK_VARIABLES[event]).not.toContain('severity');
    }
    expect(DEFAULT_WEBHOOK_BODY_TEMPLATE).not.toContain('severity');
  });

  it('promises the event-specific variables', () => {
    expect(ALARM_WEBHOOK_VARIABLES.CLEARED).toContain('duration');
    expect(ALARM_WEBHOOK_VARIABLES.CLEARED).toContain('raisedAt');
    expect(ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED).toContain('acknowledgedBy');
    expect(ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED).toContain('acknowledgeReason');
    expect(ALARM_WEBHOOK_VARIABLES.RAISED).not.toContain('duration');
  });

  // The default template must not advertise a placeholder the renderer never fills,
  // or a freshly created target ships a body with a literal ${...} in it.
  it('uses only variables RAISED actually promises', () => {
    const used = [...DEFAULT_WEBHOOK_BODY_TEMPLATE.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    expect(used.length).toBeGreaterThan(0);
    for (const v of used) expect(ALARM_WEBHOOK_VARIABLES.RAISED).toContain(v);
  });
});
