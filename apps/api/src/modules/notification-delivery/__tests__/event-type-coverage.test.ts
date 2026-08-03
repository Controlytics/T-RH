import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(__dirname, '../../../../prisma/schema.prisma');
const DISPATCHER = path.resolve(__dirname, '../notification-dispatcher.ts');
const RULES = path.resolve(__dirname, '../../notification-rules/routes.ts');

function enumMembers(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const block = /enum NotificationEventType \{([^}]*)\}/.exec(src)?.[1] ?? '';
  return block.split('\n').map(l => l.trim()).filter(l => /^[A-Z_]+$/.test(l));
}

describe('NotificationEventType coverage', () => {
  const members = enumMembers();

  it('the enum is parsed', () => {
    expect(members.length).toBeGreaterThan(0);
  });

  it.each(['EVENT_LABELS', 'EVENT_FIELDS'])('%s covers every member', (_map) => {
    // Both maps live in notification-dispatcher.ts. A member missing from
    // EVENT_LABELS renders its raw enum name to operators; missing from
    // EVENT_FIELDS renders an email whose only row is "Time".
    const src = readFileSync(DISPATCHER, 'utf8');
    const missing = members.filter(m => !src.includes(`${m}:`));
    expect(missing).toEqual([]);
  });

  it('the rules EVENT_CATALOG covers every member', () => {
    // notification-rules/routes.ts drives the rule-authoring UI. A member absent
    // here can never have a rule created for it, so the event fires and reaches
    // nobody.
    const src = readFileSync(RULES, 'utf8');
    const missing = members.filter(m => !src.includes(`${m}:`));
    expect(missing).toEqual([]);
  });
});
