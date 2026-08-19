/**
 * Who may change which instrument attributes, per role.
 *
 * Attributes used to ride entirely on `INSTRUMENT_UPDATE`: hold Edit Instruments
 * and you could change every attribute on every instrument, including a
 * calibration date or a limit an alarm fires against. That is one permission
 * covering two very different acts — correcting a supplier reference, and moving
 * the bound a regulated excursion is judged by.
 *
 * So the rule is administered per role instead: everything editable, nothing
 * editable, or a named set editable with the rest read-only.
 *
 * Lives in @digilog/shared because BOTH sides decide with it — the API enforces,
 * the panel renders the matching affordances — and a second implementation would
 * eventually show an Edit button the server refuses, which reads as the app
 * being broken rather than as a policy.
 *
 * NULL access = INHERIT = exactly the old behaviour (editable iff the role holds
 * `INSTRUMENT_UPDATE`). Shipping this must not silently freeze anyone out.
 */

export const ATTRIBUTE_ACCESS_MODES = ['ALL_EDIT', 'ALL_VIEW', 'SELECTED'] as const;
export type AttributeAccessMode = (typeof ATTRIBUTE_ACCESS_MODES)[number];

export interface AttributeAccess {
  mode: AttributeAccessMode;
  /** SELECTED only: the keys this role may change. Matched case-insensitively. */
  keys: string[];
  /** Prompt for the operator's password on every attribute write by this role. */
  requireReauth: boolean;
}

/** Bounds on the mandatory remark. */
export const ATTRIBUTE_REMARK_MIN = 5;
/**
 * `audit_trail.reason` is TEXT, but the `signature_meaning` built alongside it is
 * VARCHAR(255) and `auditLog` does NOT truncate — an over-long remark would write
 * the attribute and THEN throw, leaving a regulated change with no audit row.
 * Bounded here so the API body schema and the dialog agree on one number.
 */
export const ATTRIBUTE_REMARK_MAX = 500;

/**
 * A stored value into the shape the rules use, or null for "not configured".
 *
 * Defensive because this comes out of a JSONB column that an older release, a
 * restore, or a hand-edit could have left in any shape. An unrecognised mode is
 * treated as unconfigured rather than guessed at: inheriting today's behaviour is
 * a safe answer, and inventing ALL_EDIT from garbage would grant access nobody
 * chose.
 */
export function parseAttributeAccess(raw: unknown): AttributeAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (typeof mode !== 'string' || !ATTRIBUTE_ACCESS_MODES.includes(mode as AttributeAccessMode)) {
    return null;
  }
  const keys = Array.isArray(o.keys)
    ? [...new Set(
        o.keys
          .filter((k): k is string => typeof k === 'string')
          .map((k) => k.trim())
          .filter(Boolean),
      )]
    : [];
  return {
    mode: mode as AttributeAccessMode,
    keys,
    requireReauth: o.requireReauth === true,
  };
}

/**
 * May this role change (or delete) this attribute?
 *
 * `hasUpdatePermission` is the ordinary `INSTRUMENT_UPDATE` gate, still required
 * in every branch: the attribute rule NARROWS that permission and never widens
 * it. A role with no Edit Instruments cannot be handed attribute editing by
 * setting ALL_EDIT here, which would be a second, quieter route to the same
 * capability.
 */
export function canEditAttributeKey(
  access: AttributeAccess | null,
  key: string,
  hasUpdatePermission: boolean,
): boolean {
  if (!hasUpdatePermission) return false;
  if (!access) return true; // Unconfigured: exactly as before this feature existed.
  if (access.mode === 'ALL_EDIT') return true;
  if (access.mode === 'ALL_VIEW') return false;
  const k = key.trim().toLowerCase();
  return access.keys.some((sel) => sel.trim().toLowerCase() === k);
}

/**
 * May this role add a key the instrument does not have yet?
 *
 * Allowed in SELECTED mode on purpose: a NEW key cannot overwrite a protected
 * one, and the alternative — a role that may edit three keys but may not record a
 * fourth fact — makes the selected list a cage rather than a protection. ALL_VIEW
 * means read-only, so it blocks adding too.
 */
export function canAddAttribute(
  access: AttributeAccess | null,
  hasUpdatePermission: boolean,
): boolean {
  if (!hasUpdatePermission) return false;
  if (!access) return true;
  return access.mode !== 'ALL_VIEW';
}

/** Does this role have to re-authenticate to write an attribute? */
export function attributeWriteNeedsReauth(access: AttributeAccess | null): boolean {
  return access?.requireReauth === true;
}

/**
 * Why this remark is not acceptable, or null.
 *
 * One implementation so the dialog cannot promise something the endpoint refuses.
 */
export function validateAttributeRemark(remark: string | null | undefined): string | null {
  const text = (remark ?? '').trim();
  if (text.length < ATTRIBUTE_REMARK_MIN) {
    return `Enter at least ${ATTRIBUTE_REMARK_MIN} characters — this is recorded in the audit trail.`;
  }
  if (text.length > ATTRIBUTE_REMARK_MAX) {
    return `Keep it under ${ATTRIBUTE_REMARK_MAX} characters.`;
  }
  return null;
}
