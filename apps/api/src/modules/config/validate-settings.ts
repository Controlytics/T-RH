import type { ModuleConfigDefinition, SettingDefinition } from '../../lib/config-registry.js';

/**
 * Server-side enforcement of every setting's DECLARED shape (audit 2026-10-12
 * #7). A def's `type` / `min` / `max` / `minLength` / `maxLength` / `options`
 * were read by the config page only: 33 of 35 defs have no zod schema, so
 * `PUT /api/config/dynamic/<key>` stored whatever arrived — a page size of 0,
 * a lockout of -5 minutes, a "mode" no reader recognises. This is the ONE
 * generic validator, run before a def's own zod schema and hooks.
 *
 * Rules, chosen so no value the page can legitimately send is refused:
 *   - Only keys PRESENT in the body are checked. Keys the def does not declare
 *     pass through — several defs are written wholesale and carry extra keys
 *     (inactivity-alarms' wordings); their zod schema, where there is one,
 *     is the stricter control.
 *   - `null`, and '' for a number, mean "not set" unless the setting is
 *     `required`: the page sends '' when a number box is cleared, and a stored
 *     '' was always read back as "use the default".
 *   - `select` / `multiselect` options are enforced only when the def lists
 *     them statically; a `dynamicOptionsSource` list is live data.
 *   - `json` is not shape-checked here.
 *
 * Returns the first problem as `{ field, message }`, or null.
 */
export function validateDeclaredSettings(
  def: Pick<ModuleConfigDefinition, 'settings'>,
  body: Record<string, unknown>,
): { field: string; message: string } | null {
  for (const s of def.settings ?? []) {
    if (!Object.prototype.hasOwnProperty.call(body, s.key)) continue;
    const problem = checkOne(s, body[s.key]);
    if (problem) return { field: s.key, message: `${s.label}: ${problem}` };
  }
  return null;
}

function unset(s: SettingDefinition, v: unknown): boolean {
  return v === null || (s.type === 'number' && v === '');
}

function checkOne(s: SettingDefinition, v: unknown): string | null {
  if (unset(s, v)) return s.required ? 'is required.' : null;
  switch (s.type) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number.';
      if (s.min !== undefined && v < s.min) return `must be at least ${s.min}.`;
      if (s.max !== undefined && v > s.max) return `must be ${s.max} or less.`;
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false.';
    case 'string': case 'textarea': case 'secret': case 'url': case 'email': case 'color': case 'cron': {
      if (typeof v !== 'string') return 'must be text.';
      if (s.minLength !== undefined && v.length < s.minLength) return `must be at least ${s.minLength} characters.`;
      if (s.maxLength !== undefined && v.length > s.maxLength) return `must be ${s.maxLength} characters or fewer.`;
      return null;
    }
    case 'select': {
      if (typeof v !== 'string' && typeof v !== 'number') return 'must be one of the listed options.';
      return inOptions(s, v) ? null : `"${String(v)}" is not one of the listed options.`;
    }
    case 'multiselect': {
      if (!Array.isArray(v)) return 'must be a list.';
      const bad = v.find((x) => (typeof x !== 'string' && typeof x !== 'number') || !inOptions(s, x));
      return bad === undefined ? null : `"${String(bad)}" is not one of the listed options.`;
    }
    case 'json':
    default:
      return null;
  }
}

function inOptions(s: SettingDefinition, v: string | number): boolean {
  if (s.dynamicOptionsSource || !s.options || s.options.length === 0) return true;
  return s.options.some((o) => String(o.value) === String(v));
}
