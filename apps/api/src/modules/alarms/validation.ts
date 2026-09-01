// Alarm RULES were removed 2026-08-31 (see `routes.ts`), taking `RuleDraft`
// and `validateRuleDraft` with them. What remains is the ACKNOWLEDGEMENT
// validation, which is not rule-specific and is used by every alarm source.
/**
 * Alarm-rule invariants, as pure logic so they are testable without Prisma and
 * enforced identically on create and update.
 */



const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Acknowledgement is a 21 CFR §11 e-signature, so both of its refusals are decided here
 * rather than inline in the route: the reason must be real, and the FIRST acceptance is
 * the record — a second one would overwrite a signature.
 */
export type AckRefusal =
  | { code: 'VALIDATION_ERROR'; message: string; field: string }
  | { code: 'ALREADY_ACKNOWLEDGED'; message: string };

/** Same floor the audit redact/delete reasons use, so "ok" can't stand in for a reason. */
const MIN_REASON = 5;

export function validateAcknowledgement(
  alarm: { acknowledgedAt: Date | null; acknowledgedBy: string | null },
  reason: string,
): AckRefusal | null {
  if (alarm.acknowledgedAt) {
    return {
      code: 'ALREADY_ACKNOWLEDGED',
      message: `This alarm was already acknowledged${alarm.acknowledgedBy ? ` by ${alarm.acknowledgedBy}` : ''} on ${alarm.acknowledgedAt.toISOString()}. The first acceptance is the record and cannot be replaced.`,
    };
  }
  if (reason.trim().length < MIN_REASON) {
    return {
      code: 'VALIDATION_ERROR',
      field: 'reason',
      message: `A reason of at least ${MIN_REASON} characters is required — it is signed into the audit trail.`,
    };
  }
  return null;
}

/**
 * `audit_trail.signature_meaning` is VARCHAR(255) while `reason` is TEXT, so a signature
 * line built from free text can exceed the column and make the INSERT throw — after the
 * record it describes has already been written. Clamping loses nothing: the reason is
 * stored verbatim in `audit_trail.reason` and `alarms.acknowledge_reason`.
 */
export const SIGNATURE_MEANING_MAX = 255;

export function clampSignature(line: string): string {
  return line.length <= SIGNATURE_MEANING_MAX ? line : `${line.slice(0, SIGNATURE_MEANING_MAX - 1)}…`;
}
