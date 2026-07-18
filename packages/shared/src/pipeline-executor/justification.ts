/**
 * Justification guards (Phase 8.5).
 *
 * Pure portion of bypass() + terminateCycle() justification checks in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 1614-1616, 1959-1961).
 *
 * Both server sites enforce min-length 10 chars; both have already
 * sanitized the string (HTML escape via the service's own helpers) before
 * reaching this guard. The pure check is a length test only.
 */
import type { GuardResult, LocalContext } from './types.js';

const DEFAULT_MIN_LENGTH = 10;

/**
 * Guards #40, #45: justification non-empty + length ≥ minLength.
 *
 * Two distinct call sites (bypass / terminateCycle) emit slightly different
 * messages. We mirror that via the `kind` discriminator so error rendering
 * stays parity-exact with the existing service errors.
 */
export function assertJustificationValid(
  _ctx: LocalContext,
  justification: string | null | undefined,
  options?: { kind?: 'bypass' | 'terminate'; minLength?: number },
): GuardResult {
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH;
  const ok = typeof justification === 'string' && justification.length >= minLength;
  if (ok) return { ok: true };
  if (options?.kind === 'bypass') {
    return {
      ok: false,
      code: 'JUSTIFICATION_REQUIRED',
      message: `Bypass justification required (min ${minLength} characters)`,
    };
  }
  // Default + 'terminate' use the shorter message — matches both
  // terminateCycle() and (when callers omit `kind`) generic call sites.
  return {
    ok: false,
    code: 'JUSTIFICATION_REQUIRED',
    message: `Justification required (min ${minLength} characters)`,
  };
}
