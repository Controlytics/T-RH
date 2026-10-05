import { AppError } from './errors.js';

/**
 * A regulated write that carries an e-signature must also carry the operator's
 * REASON for it (audit 2026-10-03, DATA-11). Until then a user delete or
 * disable, a role permission change and an instrument-scope change each took a
 * password and recorded no "why": an inspector asking was answered only by the
 * before/after values. The route schema asks for the field; THIS is the
 * control — it runs in the service, so a caller that bypasses the schema (an
 * older client, a script) is refused the same way.
 *
 * Trimmed, bounded to the audit row's `reason` column, 400 REASON_REQUIRED.
 */
export const REASON_MAX = 500;

export function requireReason(reason: unknown, what = 'This action'): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) {
    throw new AppError(400, 'REASON_REQUIRED', `${what} requires a reason.`);
  }
  if (text.length > REASON_MAX) {
    throw new AppError(400, 'REASON_TOO_LONG', `reason must be at most ${REASON_MAX} characters.`);
  }
  return text;
}
