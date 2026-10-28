/**
 * Resolving a request's instrument-attribute access from its role.
 *
 * The rules themselves live in @digilog/shared so the panel renders exactly what
 * this enforces; this file is the I/O and the refusals.
 *
 * SUPER_ADMIN is not special-cased by a branch here — it is handled where every
 * other bypass in this app is, by the role never being configured and by
 * `requirePermission` letting it through. If a super admin's role IS given a rule
 * it applies to them too, which is the honest reading of an administered setting.
 */
import { prisma } from '../../lib/prisma.js';
import {
  parseAttributeAccess,
  canEditAttributeKey,
  canAddAttribute,
  attributeWriteNeedsReauth,
  validateAttributeRemark,
  effectiveAttributeAccess,
  type AttributeAccess,
} from '@digilog/shared';

/**
 * The rule for THIS request: the role's, combined with the user's own
 * (2026-10-24, `effectiveAttributeAccess` — the user may change a key if either
 * rule allows it). `userId` is REQUIRED: a caller passing only the role would
 * enforce a different rule from the one `/attribute-access/me` shows.
 *
 * Read per request rather than cached: the config is edited rarely and read on
 * attribute writes only, and a stale cache here would silently keep enforcing a
 * rule an admin has just removed — the kind of bug that is diagnosed as "the
 * permission system is broken".
 */
export async function loadAttributeAccess(
  role: string | null | undefined,
  userId: string | null | undefined,
): Promise<AttributeAccess | null> {
  if (!role) return null;
  const [roleRow, userRow] = await Promise.all([
    prisma.roleConfig.findUnique({ where: { role }, select: { attributeAccess: true } }),
    userId ? prisma.userConfig.findUnique({ where: { userId }, select: { attributeAccess: true } }) : Promise.resolve(null),
  ]);
  return effectiveAttributeAccess(
    parseAttributeAccess(roleRow?.attributeAccess ?? null),
    parseAttributeAccess(userRow?.attributeAccess ?? null),
  );
}

export interface AttributeWriteRefusal {
  status: 403 | 400;
  body: { error: string; message: string };
}

/**
 * May this request write this attribute, and is its remark acceptable?
 *
 * `isNewKey` decides both the access rule (adding is allowed in SELECTED mode —
 * a new key cannot overwrite a protected one) and the remark rule (filling a
 * blank prompt for the first time is registration, not a change). `remark` is
 * therefore ignored entirely on a create.
 *
 * Returns the refusal rather than sending it, so the caller keeps one exit path
 * and the reply shape stays this module's business rather than the route's.
 */
export function refuseAttributeWrite(input: {
  access: AttributeAccess | null;
  hasUpdatePermission: boolean;
  key: string;
  isNewKey: boolean;
  remark?: string | null;
}): AttributeWriteRefusal | null {
  const { isNewKey, remark } = input;

  const refused = attributeAccessRefusal(input);
  if (refused) return { status: 403, body: { error: 'ATTRIBUTE_NOT_EDITABLE', message: refused } };

  // Remarks are required to CHANGE a recorded value, not to record one for the
  // first time. Demanding a reason on every key of a newly registered instrument
  // teaches people to type "x", which is worse for an inspector than no field.
  if (!isNewKey) {
    const problem = validateAttributeRemark(remark);
    if (problem) return { status: 400, body: { error: 'REMARK_REQUIRED', message: problem } };
  }

  return null;
}

/**
 * The ACCESS half of `refuseAttributeWrite` alone — its wording, or null when
 * the role may write the key. The bulk upload (2026-10-28) asks it once per
 * changed cell and takes the remark once for the whole file, so it needs the
 * rule without the remark check; both callers word a refusal identically.
 */
export function attributeAccessRefusal(input: {
  access: AttributeAccess | null;
  hasUpdatePermission: boolean;
  key: string;
  isNewKey: boolean;
}): string | null {
  const { access, hasUpdatePermission, key, isNewKey } = input;
  const permitted = isNewKey
    ? canAddAttribute(access, hasUpdatePermission)
    : canEditAttributeKey(access, key, hasUpdatePermission);
  if (permitted) return null;
  return isNewKey
    ? 'You may view instrument attributes but not add them.'
    : `You may view "${key}" but not change it.`;
}

/** Does this role have to confirm its password for an attribute write? */
export function needsReauth(access: AttributeAccess | null): boolean {
  return attributeWriteNeedsReauth(access);
}
