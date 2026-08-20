export const ACTION_COLORS: Record<string, string> = {
  // Authentication
  LOGIN_SUCCESS: 'bg-green-100 text-green-700 border-green-200',
  LOGIN: 'bg-green-100 text-green-700 border-green-200',
  LOGOUT: 'bg-slate-100 text-slate-700 border-slate-200',
  LOGIN_FAILED: 'bg-red-100 text-red-700 border-red-200',
  SESSION_TIMEOUT: 'bg-slate-100 text-slate-700 border-slate-200',
  FORCED_LOGOUT: 'bg-orange-100 text-orange-700 border-orange-200',

  // User Management
  USER_CREATED: 'bg-blue-100 text-blue-700 border-blue-200',
  USER_UPDATED: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  USER_DELETED: 'bg-red-100 text-red-700 border-red-200',
  BULK_USER_DELETED: 'bg-red-100 text-red-700 border-red-200',
  USER_ENABLED: 'bg-green-100 text-green-700 border-green-200',
  USER_DISABLED: 'bg-orange-100 text-orange-700 border-orange-200',
  ACCOUNT_LOCKED: 'bg-red-100 text-red-700 border-red-200',
  ACCOUNT_UNLOCKED: 'bg-green-100 text-green-700 border-green-200',
  PASSWORD_CHANGED: 'bg-amber-100 text-amber-700 border-amber-200',
  PASSWORD_RESET: 'bg-amber-100 text-amber-700 border-amber-200',
  PASSWORD_EXPIRED: 'bg-orange-100 text-orange-700 border-orange-200',
  PROFILE_UPDATED: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  ROLE_ASSIGNED: 'bg-violet-100 text-violet-700 border-violet-200',

  // Configuration
  CONFIG_CHANGED: 'bg-purple-100 text-purple-700 border-purple-200',

  // Role Management
  ROLE_CREATED: 'bg-violet-100 text-violet-700 border-violet-200',
  ROLE_UPDATED: 'bg-violet-100 text-violet-700 border-violet-200',
  ROLE_DELETED: 'bg-red-100 text-red-700 border-red-200',

  // Backup
  BACKUP_CREATED: 'bg-teal-100 text-teal-700 border-teal-200',
  BACKUP_RESTORED: 'bg-teal-100 text-teal-700 border-teal-200',

  // Data & Approvals
  DATA_VIEWED: 'bg-slate-100 text-slate-700 border-slate-200',
  DATA_EXPORTED: 'bg-slate-100 text-slate-700 border-slate-200',
  APPROVAL_REQUESTED: 'bg-amber-100 text-amber-700 border-amber-200',
  APPROVAL_GRANTED: 'bg-green-100 text-green-700 border-green-200',
  APPROVAL_REJECTED: 'bg-red-100 text-red-700 border-red-200',
  UNAUTHORIZED_ACTION_ATTEMPT: 'bg-red-100 text-red-700 border-red-200',

  // Alarm Management
  ALARM_ACKNOWLEDGED: 'bg-amber-100 text-amber-700 border-amber-200',
  ALARM_CLEARED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

// Actions that represent failures
export const FAIL_ACTIONS = new Set([
  'LOGIN_FAILED',
  'UNAUTHORIZED_ACTION_ATTEMPT',
  'ACCOUNT_LOCKED',
]);

export function getAuditStatus(action: string): 'Success' | 'Fail' {
  return FAIL_ACTIONS.has(action) ? 'Fail' : 'Success';
}

/**
 * 2026-05-20: human-friendly action badge label.
 *
 * The audit table previously rendered the raw constant (INSTRUMENT_TOKEN_SET)
 * which is operator-unfriendly. This formatter returns a short title-cased
 * label; ACTION_BADGE_OVERRIDES allows a per-action specialisation where the
 * title-cased key is not the most meaningful wording.
 *
 * For unknown / generic actions it falls back to title-casing the snake_case
 * key (STATE_TRANSITION → "State Transition") so badges always render
 * presentably even when a new action key lands without an explicit override.
 */
// Human record type for {recordType} (generic CREATED/UPDATED/DELETED rows).
const RECORD_TYPE_OVERRIDES: Record<string, string> = {};

const ACTION_BADGE_OVERRIDES: Record<string, (after: any, before: any) => string> = {};

function titleCase(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function formatActionLabel(action: string, afterValue?: any, beforeValue?: any): string {
  const override = ACTION_BADGE_OVERRIDES[action];
  if (override) return override(afterValue ?? {}, beforeValue ?? {});
  return titleCase(action);
}

/**
 * Human-friendly "target" label for a row (used in the exported report column),
 * avoiding internal snake_case words.
 */
export function friendlyTargetType(record: any): string {
  const tt = record?.targetType;
  return tt ? titleCase(String(tt)) : '-';
}

export function getAuditSummary(record: any, templates: Record<string, string>): string {
  const actor = record.userId || 'System';
  const before = record.beforeValue || {};
  const after = record.afterValue || {};
  const targetType = record.targetType || '';

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const nonUuid = (v: unknown): string => (typeof v === 'string' && !UUID_RE.test(v) ? v : '');
  const targetUser = after.username || before.username || nonUuid(record.targetId) || '';
  const isSelf = targetUser === actor;
  const targetName = after.name || before.name || after.label || before.label
    || nonUuid(record.targetId) || '';
  const configKey = nonUuid(record.targetId) || targetType || '';
  const recordType = targetType ? (RECORD_TYPE_OVERRIDES[targetType] || titleCase(targetType)) : 'record';
  // {reason} is the operator's free-text justification on the audit
  // self-administration actions (AUDIT_RECORD_DELETED / _REDACTED).
  const reason = after.reason || before.reason || '';

  // 2026-08-06 fix: the eight INSTRUMENT_* templates use {instrument}/{gateway},
  // but had no substitution here → every instrument row rendered the literal
  // "{instrument}".
  //
  // BOTH keys must stay readable, permanently. The emitters in
  // apps/api/src/modules/instruments/routes.ts were converged onto `code` later
  // the same day (it matches the column, and INSTRUMENT_CREATED/DELETED/
  // TOKEN_REGENERATED already used it), but the six gateway-wiring actions had
  // been writing `instrument` — and audit_trail is immutable, so those historic
  // rows exist forever and must keep rendering. Do not "tidy" either key away.
  //
  // targetId is the last resort, for rows that genuinely carry neither: every
  // INSTRUMENT_UPDATED row written before the same fix added `code` to its diff.
  // A raw UUID is truthful; guessing is not.
  const instrument = (after.code as string) || (before.code as string)
    || (after.instrument as string) || (before.instrument as string) || record.targetId || '';
  // {gateway}: on INSTRUMENT_UNLINKED_FROM_GATEWAY, afterValue.gateway is
  // explicitly null (the link is gone) — the code that matters for that
  // sentence is the FORMER gateway, which only beforeValue carries, so after
  // must be tried first and fall through on null/empty. If a row genuinely
  // lacks both (should not happen from the current emitters), leave it empty;
  // the existing empty-quoted-placeholder cleanup below collapses
  // `gateway ""` rather than showing a false or literal value.
  const gateway = (after.gateway as string) || (before.gateway as string) || '';
  // {attribute}: the KEY of an instrument attribute. A removal carries it only
  // in beforeValue (there is no after), so both sides are tried — same shape as
  // {gateway} above. A template placeholder with no substitution here renders as
  // the literal "{attribute}", which is the bug this line exists to avoid.
  const attribute = (after.attribute as string) || (before.attribute as string) || '';
  // {floorplan}: the plan's NAME. It sits in two different fields depending on
  // the row — FLOORPLAN_* writes it as `name` (the record is the plan itself),
  // while FLOORPLAN_ROOM_CREATED writes it as `floorplan` (the record is the
  // room, and the plan is context). Both are tried; a DELETED row carries it
  // only in beforeValue, so both sides are read, same shape as {gateway} above.
  const floorplan = (after.floorplan as string) || (before.floorplan as string)
    || (after.name as string) || (before.name as string) || '';
  // {room}: the room CODE as it appears on the drawing, e.g. "CWH-I/142".
  // Falls back to the raw id rather than guessing — a UUID is truthful.
  const room = (after.code as string) || (before.code as string) || record.targetId || '';
  // {location}: a functional location's NAME. A DELETED row carries it only in
  // beforeValue, so both sides are read — same shape as {gateway} above. Adding a
  // template without adding a substitution here is what makes the placeholder
  // render as the literal "{location}" in the Audit Trail AND in the exported
  // 21 CFR §11 record; template-placeholders.test.ts exists to catch it.
  const location = (after.location as string) || (before.location as string) || '';

  const replacePlaceholders = (tpl: string) => {
    const filled = tpl
      .replace(/\{actor\}/g, actor)
      .replace(/\{floorplan\}/g, floorplan)
      .replace(/\{room\}/g, room)
      .replace(/\{location\}/g, location)
      .replace(/\{targetUser\}/g, targetUser || actor)
      .replace(/\{targetName\}/g, targetName)
      .replace(/\{configKey\}/g, configKey)
      .replace(/\{targetType\}/g, targetType || 'Data')
      .replace(/\{recordType\}/g, recordType)
      .replace(/\{reason\}/g, reason)
      .replace(/\{instrument\}/g, instrument)
      .replace(/\{gateway\}/g, gateway)
      .replace(/\{attribute\}/g, attribute);
    // Drop empty quoted placeholders: a record that carries no name would
    // otherwise render 'Role "" updated by EMP-123'. An empty "" is always a
    // missing-value artifact, never intentional, so collapse it and tidy the
    // resulting whitespace.
    return filled.replace(/\s*""/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  };

  // Self-action handling: check for _SELF variant
  const selfActions = ['USER_UPDATED', 'PROFILE_UPDATED', 'PASSWORD_CHANGED'];
  if (isSelf && selfActions.includes(record.action)) {
    const selfKey = record.action + '_SELF';
    const selfTemplate = templates[selfKey];
    if (selfTemplate) {
      return replacePlaceholders(selfTemplate);
    }
  }

  const template = templates[record.action];
  if (template) {
    return replacePlaceholders(template);
  }

  // Fallback for unknown actions — avoid showing UUIDs as "names"
  const label = record.action.replace(/_/g, ' ').toLowerCase();
  const name = nonUuid(targetName) || nonUuid(targetUser);
  return name ? `${label} — "${name}" by ${actor}` : `${label} by ${actor}`;
}

/**
 * Redaction display helpers.
 *
 * Redaction is this system's VISIBLE, chain-preserving alternative to physically
 * deleting an audit row: the payload is NULLed but the checksum + chain link
 * survive, and redactedAt/redactedBy/redactionReason record who masked it and why.
 * Rendered identically to a live row it does neither job — an inspector sees a
 * record with an empty before/after and no hint that anything was removed. So the
 * marker goes on every surface that shows a record: the table, the detail modal,
 * and the PDF/Excel exports (the export is the artifact an inspector receives).
 */
export function isRedacted(record: any): boolean {
  return !!record?.redactedAt;
}

export interface RedactionDetail { by: string; reason: string; }

/** Who masked the payload and why, with fallbacks. Check isRedacted() first. */
export function redactionDetail(record: any): RedactionDetail {
  return {
    // redactedByName is the backend's read-time username lookup; it falls back to
    // the raw id when the redactor's account was since deleted.
    by: record?.redactedByName || record?.redactedBy || 'unknown user',
    reason: record?.redactionReason || 'no reason recorded',
  };
}

/** One-line note for flat surfaces (PDF / Excel cells) that can't render markup. */
export function redactionNote(record: any): string {
  const { by, reason } = redactionDetail(record);
  return `[REDACTED by ${by}: ${reason}]`;
}

// Sensitive audit keys — kept in sync with apps/api/src/lib/audit-diff.ts.
const SENSITIVE_KEY_RE = /password|secret|token|apikey|api[_-]?key|private[_-]?key|credential/i;
const DIFF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prettyFieldName(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function maskAuditValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_RE.test(key)) return '••••••';
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface AuditFieldChange { field: string; from: string; to: string; }

/** Changed fields only, old → new. Skips id/uuid keys; masks sensitive values. */
export function diffAuditValues(before: any, after: any): AuditFieldChange[] {
  const b = before && typeof before === 'object' ? before : {};
  const a = after && typeof after === 'object' ? after : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  const changes: AuditFieldChange[] = [];
  for (const key of keys) {
    if (/^id$|[_-]id$|Id$/.test(key)) continue;
    const bv = b[key];
    const av = a[key];
    if (typeof bv === 'string' && DIFF_UUID_RE.test(bv)) continue;
    if (typeof av === 'string' && DIFF_UUID_RE.test(av)) continue;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    if (bv && av && typeof bv === 'object' && typeof av === 'object' && !Array.isArray(bv) && !Array.isArray(av)) {
      const subKeys = Array.from(new Set([...Object.keys(bv), ...Object.keys(av)]));
      for (const sk of subKeys) {
        if (/^id$|[_-]id$|Id$/.test(sk)) continue;
        const sbv = (bv as any)[sk];
        const sav = (av as any)[sk];
        if (typeof sbv === 'string' && DIFF_UUID_RE.test(sbv)) continue;
        if (typeof sav === 'string' && DIFF_UUID_RE.test(sav)) continue;
        if (JSON.stringify(sbv) === JSON.stringify(sav)) continue;
        changes.push({ field: prettyFieldName(sk), from: maskAuditValue(sk, sbv), to: maskAuditValue(sk, sav) });
      }
      continue;
    }
    changes.push({ field: prettyFieldName(key), from: maskAuditValue(key, bv), to: maskAuditValue(key, av) });
  }
  return changes;
}
