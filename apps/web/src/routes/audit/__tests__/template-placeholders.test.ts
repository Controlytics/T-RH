import { describe, it, expect } from 'vitest';
import { AUDIT_TEMPLATE_DEFAULTS } from '@digilog/shared';
import { getAuditSummary } from '../audit-helpers';

/**
 * THE COUPLING THIS FILE EXISTS TO ENFORCE.
 *
 * An audit template lives in `packages/shared/src/types/audit-templates.ts`.
 * Its placeholders are substituted, one `.replace()` per name, in
 * `getAuditSummary()` over in `apps/web/src/routes/audit/audit-helpers.ts`.
 * Nothing links the two files — so adding a template with a new placeholder and
 * forgetting the substitution renders the literal `{yourPlaceholder}` in the
 * Audit Trail, in the detail modal, and in the PDF/Excel exports an inspector
 * receives. That is a §11 record with template syntax in it.
 *
 * This has now shipped THREE times: `{reason}`/`{stage}` (fixed 2026-05-20),
 * `{stageKey}`/`{filterName}`/`{rejectToStateKey}` (2026-06-22),
 * `{currentState}` (2026-07-15), then `{instrument}`/`{gateway}` and
 * `{attribute}` on 2026-08-06. Every one was found by a human looking at a
 * rendered row. This test is what makes the fourth one a red CI run instead.
 *
 * ── What is asserted, and why it is rendering and not declaration ──
 *
 * The assertion is that **no literal `{name}` survives rendering**, not that a
 * particular field is read. Two reasons it is framed that way:
 *
 *  1. It is the actual failure mode. A placeholder may legitimately resolve
 *     from several fields or fall back to a neutral word (`{fromStage}` →
 *     "To Be Cleaned", `{targetType}` → "Data"), and an empty substitution is
 *     fine — `replacePlaceholders` collapses the resulting `""`. None of that
 *     reaches an auditor as broken text. A surviving brace does.
 *  2. Iterating each definition's declared `placeholders[]` array would assert
 *     something subtly different and wrong. A template may DECLARE a name it
 *     does not use — `DEVIATION_OPEN_BLOCKED` declares `{actor}` and its
 *     template string never interpolates it — and an unused declaration cannot
 *     be "substituted" by anything. That row is a documented, pre-existing
 *     failure in the shared `audit-templates` suite; it is a declaration bug,
 *     not a rendering bug, and it is not this file's subject.
 *
 * The list of templates is read from `AUDIT_TEMPLATE_DEFAULTS` at runtime, so a
 * new entry is covered the moment it is added. Hardcoding the names here would
 * rebuild the exact decoupling the test exists to remove.
 */

/** Any `{word}` left in rendered output. Deliberately loose. */
const SURVIVING_PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_]*\}/g;

/**
 * A record with no useful payload at all. Every substitution in
 * `getAuditSummary` runs unconditionally — a known placeholder resolves to the
 * empty string rather than being skipped — so a bare record is the strictest
 * input: anything still wearing braces afterwards has no substitution at all.
 *
 * `userId` is set because `{actor}` falls back to the literal word 'System',
 * which would mask nothing but reads oddly in a failure message. `targetId` is
 * a UUID so the `nonUuid()` guards behave as they do in production.
 */
function bareRecord(action: string) {
  return {
    action,
    userId: 'EMP-TEST',
    targetId: '00000000-0000-4000-8000-000000000000',
    targetType: 'thing',
    beforeValue: {},
    afterValue: {},
  };
}

describe('audit template placeholders are all substituted by the renderer', () => {
  const entries = Object.entries(AUDIT_TEMPLATE_DEFAULTS);

  it('has templates to check (guards against an empty-iteration pass)', () => {
    // A vacuous test is the failure mode of every "walk the registry" guard: if
    // the import ever resolves to `{}` the loop below runs zero times and the
    // file reports green while checking nothing.
    expect(entries.length).toBeGreaterThan(50);
  });

  it.each(entries)('%s renders with no literal placeholder left', (action, def) => {
    const rendered = getAuditSummary(bareRecord(action), { [action]: def.template });
    const left = rendered.match(SURVIVING_PLACEHOLDER) ?? [];
    expect(
      left,
      `Template "${action}" uses ${left.join(', ')}, which getAuditSummary() does not substitute. `
      + `Add a substitution in apps/web/src/routes/audit/audit-helpers.ts — otherwise this renders `
      + `literally in the Audit Trail and in the exported record. Rendered: "${rendered}"`,
    ).toEqual([]);
  });

  // The `_SELF` variants are picked by a different branch of getAuditSummary
  // (actor === target), which the loop above never reaches: `bareRecord` gives
  // the actor and the target different identities on purpose. Their template
  // strings are checked by the loop as ordinary keys, but the branch that
  // SELECTS them is worth exercising once so a placeholder reachable only that
  // way is not missed.
  it('substitutes placeholders on the self-action variants too', () => {
    let checked = 0;
    for (const [key, def] of entries) {
      if (!key.endsWith('_SELF')) continue;
      const action = key.slice(0, -'_SELF'.length);
      const rendered = getAuditSummary(
        { ...bareRecord(action), userId: 'EMP-SELF', afterValue: { username: 'EMP-SELF' } },
        { [key]: def.template },
      );
      expect(rendered.match(SURVIVING_PLACEHOLDER) ?? [], `${key}: "${rendered}"`).toEqual([]);
      checked += 1;
    }
    // Without this the loop is vacuous the moment the naming convention changes
    // or an import resolves oddly: zero matches, zero assertions, green — which
    // is precisely the failure mode this file exists to catch, and it would be
    // embarrassing to have it here. Three today: USER_UPDATED_SELF,
    // PROFILE_UPDATED_SELF, PASSWORD_CHANGED_SELF. Raise this if more are added.
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
