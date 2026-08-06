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

  // Entity Template Management
  ASSET_TEMPLATE_CREATED: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  ASSET_TEMPLATE_UPDATED: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  ASSET_TEMPLATE_DELETED: 'bg-red-100 text-red-700 border-red-200',
  ASSET_TEMPLATE_VERSION_CREATED: 'bg-indigo-100 text-indigo-700 border-indigo-200',

  // Entity Instance Management
  ASSET_CREATED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  ASSET_UPDATED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  ASSET_STATUS_CHANGED: 'bg-amber-100 text-amber-700 border-amber-200',
  ASSET_DELETED: 'bg-red-100 text-red-700 border-red-200',

  // Entity Relationships
  ASSET_RELATIONSHIP_CREATED: 'bg-sky-100 text-sky-700 border-sky-200',
  ASSET_RELATIONSHIP_DELETED: 'bg-red-100 text-red-700 border-red-200',

  // Entity Identifiers
  ASSET_IDENTIFIER_CREATED: 'bg-lime-100 text-lime-700 border-lime-200',
  ASSET_IDENTIFIER_DELETED: 'bg-red-100 text-red-700 border-red-200',

  // Alarm Management — RETAINED per 21 CFR Part 11. The alarm subsystem
  // was retired 2026-05-17, but historic audit rows with these actions may
  // still exist and must continue to render with their original badge.
  // Do NOT delete these entries on dead-code sweeps.
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
 * The audit table previously rendered the raw constant (ASSET_IDENTIFIER_CREATED)
 * which is operator-unfriendly. This formatter returns a short title-cased
 * label, with dynamic specialisation for identifier rows where the type
 * (RFID / QR / BARCODE) is the meaningful detail.
 *
 * For unknown / generic actions it falls back to title-casing the snake_case
 * key (STATE_TRANSITION → "State Transition") so badges always render
 * presentably even when a new action key lands without an explicit override.
 */
// Block / Area / AHU / Filter kind → display label. Rows carry the kind on
// afterValue.templateKind (new rows) or afterValue.kind (typed filter rows).
const KIND_LABELS: Record<string, string> = { BLOCK: 'Block', AREA: 'Area', AHU: 'AHU', FILTER: 'Filter' };
const kindLabel = (k: unknown): string => (typeof k === 'string' && KIND_LABELS[k]) || '';

// Human record type for {recordType} (generic CREATED/UPDATED/DELETED rows).
// Title-cases the targetType (cleaning_profile → "Cleaning Profile") with a few
// acronym overrides so PM/AHU read correctly.
const RECORD_TYPE_OVERRIDES: Record<string, string> = { pm_schedule: 'PM Schedule' };

const ACTION_BADGE_OVERRIDES: Record<string, (after: any, before: any) => string> = {
  ASSET_IDENTIFIER_CREATED: (after) => {
    const t = (after?.identifierType as string) || '';
    return t ? `${t} Added` : 'Identifier Added';
  },
  ASSET_IDENTIFIER_DELETED: (after, before) => {
    const t = (after?.identifierType as string) || (before?.identifierType as string) || '';
    return t ? `${t} Removed` : 'Identifier Removed';
  },
  // Block / Area / AHU / Filter lifecycle — badge names the specific kind when known.
  ASSET_CREATED: (after) => `${kindLabel(after?.templateKind ?? after?.kind) || 'Record'} Created`,
  ASSET_UPDATED: (after) => `${kindLabel(after?.templateKind ?? after?.kind) || 'Record'} Updated`,
  ASSET_STATUS_CHANGED: (after, before) => `${kindLabel(after?.templateKind ?? before?.templateKind ?? after?.kind) || 'Record'} Status Changed`,
  ASSET_DELETED: (after, before) => `${kindLabel(after?.templateKind ?? before?.templateKind ?? after?.kind) || 'Record'} Deactivated`,
  ASSET_RELATIONSHIP_CREATED: () => 'Placed Under Parent',
  ASSET_RELATIONSHIP_DELETED: () => 'Removed From Parent',
};

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
 * avoiding internal words like "asset_instance". Names the Block / Area / AHU /
 * Filter kind when the row carries it; hierarchy links read as "Hierarchy Link".
 */
export function friendlyTargetType(record: any): string {
  const tt = record?.targetType;
  const after = record?.afterValue || {};
  const before = record?.beforeValue || {};
  if (tt === 'asset_instance') return kindLabel(after.templateKind ?? after.kind ?? before.templateKind) || 'Record';
  if (tt === 'asset_relationship') return 'Hierarchy Link';
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
  // 2026-05-20 fix: targetName falls through to filterName (CYCLE_STARTED +
  // other filter-scoped events store filterName, not name) and equipmentName.
  const targetName = after.name || before.name || after.label || before.label
    || after.filterName || before.filterName
    || after.equipmentName || before.equipmentName
    || nonUuid(record.targetId) || '';
  const configKey = nonUuid(record.targetId) || targetType || '';
  const version = after.versionNumber || after.version || before.versionNumber || before.version || '';
  const sourceName = after.sourceName || before.sourceName || '';
  // Block / Area / AHU / Filter kind labels. entityKind = this record's kind;
  // sourceKind = the parent in a hierarchy link; targetKind = the child. Older
  // rows lack these → fall back to neutral, jargon-free words.
  const entityKind = kindLabel(after.templateKind ?? before.templateKind ?? after.kind ?? before.kind) || 'record';
  const sourceKind = kindLabel(after.sourceKind ?? before.sourceKind) || 'parent';
  const targetKind = kindLabel(after.targetKind ?? before.targetKind ?? after.templateKind ?? after.kind) || 'item';
  // A create-under-parent is a single ASSET_CREATED row carrying the parent:
  // {parentClause} => ' under <ParentKind> "<ParentName>"' (or '' when no parent).
  const parentName = after.parentName || before.parentName || '';
  const parentClause = parentName ? ` under ${kindLabel(after.parentKind ?? before.parentKind) || 'parent'} "${parentName}"` : '';
  const recordType = targetType ? (RECORD_TYPE_OVERRIDES[targetType] || titleCase(targetType)) : 'record';
  const beforeStatus = before.status || '';
  const afterStatus = after.status || '';
  const identifierType = after.identifierType || before.identifierType || '';
  const identifierValue = after.identifierValue || before.identifierValue || '';
  // 2026-05-20 fix: {reason} was in the CYCLE_STARTED template (per
  // packages/shared/src/types/audit-templates.ts:342) but had no substitution
  // here — rendered as literal "{reason}" on every cycle-start row. Read
  // cleaningReasonLabel (human-readable) with fallback to the key.
  const reason = after.cleaningReasonLabel || before.cleaningReasonLabel
    || after.cleaningReasonKey || before.cleaningReasonKey
    || after.reason || before.reason || '';

  // 2026-05-20 fix: add {stage} (checklist/state-transition rows have
  // afterValue.stage / afterValue.state) and generic {status} (many flows
  // store status without before/after split). These were used by templates
  // but had no substitution → rendered as literal "{stage}".
  const stage = (after.stage as string) || (after.state as string) || '';
  // 2026-05-20: explicit "from" stage for STATE_TRANSITION rows, reads only
  // beforeValue so it never collides with the post-transition stage. Genesis
  // transitions (state-machine entry, e.g. WASH_IN with no prior state) are
  // the operator scanning a filter that's awaiting its first cleaning cycle,
  // so render the "from" half as "To Be Cleaned" — the user-facing label
  // for that pre-cycle lifecycle state.
  const fromStageRaw = (before.stage as string) || (before.state as string) || '';
  const fromStage = fromStageRaw || 'To Be Cleaned';
  const status = (after.status as string) || (before.status as string) || afterStatus || beforeStatus || '';

  // 2026-06-22 fix: the stage-interlock templates (STAGE_APPROVAL_APPROVED /
  // _REJECTED) use {stageKey}, {filterName}, {rejectToStateKey}. The audit rows
  // carry them in afterValue, but they had no substitution here → rendered as
  // literal "{stageKey}" / "{filterName}". Prettify the stage keys for display
  // (WASH_OUT → "Wash Out") to match the rest of the cleaning UI.
  const stageKeyRaw = (after.stageKey as string) || (before.stageKey as string) || '';
  const stageKey = stageKeyRaw ? titleCase(stageKeyRaw) : '';
  const rejectToStateKeyRaw = (after.rejectToStateKey as string) || (before.rejectToStateKey as string) || '';
  const rejectToStateKey = rejectToStateKeyRaw ? titleCase(rejectToStateKeyRaw) : '';
  const filterName = (after.filterName as string) || (before.filterName as string) || '';
  // 2026-07-15: {currentState} for STAGE_APPROVAL_SUPERSEDED — the lifecycle state
  // the filter had already reached when its approval request was closed undecided.
  // Prettified like the other stage keys (CLEANING_CYCLE_COMPLETED → "Cleaning Cycle
  // Completed"). Same omission as the 2026-05-20 / 2026-06-22 fixes above: a template
  // placeholder with no substitution here renders literally.
  const currentStateRaw = (after.currentState as string) || (before.currentState as string) || '';
  const currentState = currentStateRaw ? titleCase(currentStateRaw) : '';

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

  const replacePlaceholders = (tpl: string) => {
    const filled = tpl
      .replace(/\{actor\}/g, actor)
      .replace(/\{targetUser\}/g, targetUser || actor)
      .replace(/\{targetName\}/g, targetName)
      .replace(/\{configKey\}/g, configKey)
      .replace(/\{targetType\}/g, targetType || 'Data')
      .replace(/\{version\}/g, String(version))
      .replace(/\{entityKind\}/g, entityKind)
      .replace(/\{recordType\}/g, recordType)
      .replace(/\{parentClause\}/g, parentClause)
      .replace(/\{sourceKind\}/g, sourceKind)
      .replace(/\{targetKind\}/g, targetKind)
      .replace(/\{sourceName\}/g, sourceName)
      .replace(/\{beforeStatus\}/g, beforeStatus)
      .replace(/\{afterStatus\}/g, afterStatus)
      .replace(/\{identifierType\}/g, identifierType)
      .replace(/\{identifierValue\}/g, identifierValue)
      .replace(/\{reason\}/g, reason)
      .replace(/\{stage\}/g, stage)
      .replace(/\{fromStage\}/g, fromStage)
      .replace(/\{status\}/g, status)
      .replace(/\{stageKey\}/g, stageKey)
      .replace(/\{filterName\}/g, filterName)
      .replace(/\{rejectToStateKey\}/g, rejectToStateKey)
      .replace(/\{currentState\}/g, currentState)
      .replace(/\{instrument\}/g, instrument)
      .replace(/\{gateway\}/g, gateway);
    // Drop empty quoted placeholders: an unnamed record (e.g. a PM schedule
    // review/approve row carries no name — the AHU is shown separately) would
    // otherwise render 'PM schedule "" reviewed by EMP-123'. An empty "" is
    // always a missing-value artifact, never intentional, so collapse it and
    // tidy the resulting whitespace.
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
