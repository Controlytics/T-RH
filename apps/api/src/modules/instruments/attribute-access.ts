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
  type AttributeAccess,
} from '@digilog/shared';

/**
 * This role's rule, or null for "not configured".
 *
 * Read per request rather than cached: the config is edited rarely and read on
 * attribute writes only, and a stale cache here would silently keep enforcing a
 * rule an admin has just removed — the kind of bug that is diagnosed as "the
 * permission system is broken".
 */
export async function loadAttributeAccess(role: string | null | undefined): Promise<AttributeAccess | null> {
  if (!role) return null;
  const row = await prisma.roleConfig.findUnique({
    where: { role },
    select: { attributeAccess: true },
  });
  return parseAttributeAccess(row?.attributeAccess ?? null);
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
  const { access, hasUpdatePermission, key, isNewKey, remark } = input;

  const permitted = isNewKey
    ? canAddAttribute(access, hasUpdatePermission)
    : canEditAttributeKey(access, key, hasUpdatePermission);

  if (!permitted) {
    return {
      status: 403,
      body: {
        error: 'ATTRIBUTE_NOT_EDITABLE',
        message: isNewKey
          ? 'Your role may view instrument attributes but not add them.'
          : `Your role may view "${key}" but not change it.`,
      },
    };
  }

  // Remarks are required to CHANGE a recorded value, not to record one for the
  // first time. Demanding a reason on every key of a newly registered instrument
  // teaches people to type "x", which is worse for an inspector than no field.
  if (!isNewKey) {
    const problem = validateAttributeRemark(remark);
    if (problem) return { status: 400, body: { error: 'REMARK_REQUIRED', message: problem } };
  }

  return null;
}

/** Does this role have to confirm its password for an attribute write? */
export function needsReauth(access: AttributeAccess | null): boolean {
  return attributeWriteNeedsReauth(access);
}
