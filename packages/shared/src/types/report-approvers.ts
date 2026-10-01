/**
 * Which roles may APPROVE a report — administered by SUPER_ADMIN under
 * Configuration → Report Approvers (2026-09-07).
 *
 * Operator: "that approval role should be configurable which role user should
 * be approved that role will set by super admin in configurations". Until then
 * the requester chose freely from every user and every role.
 *
 * The stored row is `{ approverRoles: string[] }` under `system_config`
 * key `report-approvers`. `coerceApproverRoles` is the ONE reader of it: the
 * server's request check (`report-reviews/service.ts`), the narrow-slice route
 * every authenticated user reads (`GET /api/config/report-approvers/current`),
 * and the browser's Send-to picker all go through it, so a malformed row cannot
 * be read three different ways.
 *
 * **Nothing configured means NOTHING may be requested.** An absent, empty or
 * malformed row is an empty list, never "anyone" — the same fail-closed stance
 * as an empty `instrument_scope` selection. The consequence is stated on the
 * def and in the dialog: after deploy no PDF can be requested until a super
 * admin sets the role once.
 *
 * SUPER_ADMIN is stripped wherever it is read: it is not an approving function,
 * and a request "to any super admin" names nobody.
 */
export const REPORT_APPROVERS_CONFIG_KEY = 'report-approvers';

export interface ReportApproversConfig {
  approverRoles: string[];
  /** Users named outright (2026-10-01) — ids. Any of them, or any holder of an
   *  approver role, may approve. */
  approverUserIds: string[];
}

/** What a requester is told when the list is empty — the fix, not just the fact. */
export const REPORT_APPROVERS_NONE_MESSAGE =
  'No report approver is configured. Ask a super admin to set one under Configuration → Report Settings.';

/**
 * Since 2026-10-01 the requester no longer chooses an approver: every request
 * goes to ALL the configured roles and users (operator: "per user or per role
 * option should be removed in request place and add that in configuration";
 * asked one or several, chose "several"). The set is FROZEN onto the request at
 * the moment it is raised, so a later configuration change never re-routes a
 * pending request — which is what "existing requests keep their assignee" means.
 */
export function coerceApproverUserIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).approverUserIds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** Both halves, through the two readers. Empty both = nothing may be requested. */
export function coerceReportApprovers(value: unknown): ReportApproversConfig {
  return { approverRoles: coerceApproverRoles(value), approverUserIds: coerceApproverUserIds(value) };
}

export function coerceApproverRoles(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).approverRoles;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || name === 'SUPER_ADMIN' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}
