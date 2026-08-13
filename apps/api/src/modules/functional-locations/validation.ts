/**
 * Invariants for a functional location, as pure logic.
 *
 * Pure so the rules are testable without Prisma and enforced identically on
 * create and update — the two paths diverging is how a tree acquires states the
 * UI can never have produced.
 *
 * THE DEPTH CAP LIVES HERE. Only an AREA may have a parent, and that parent must
 * be a BLOCK, so a third level is unreachable rather than merely discouraged.
 * `validation.test.ts` asserts it; if that test ever passes with an AREA parented
 * to an AREA, the cap is gone.
 */

export type FlType = 'BLOCK' | 'AREA';

export interface FlDraft {
  name: string;
  type: FlType;
  parentId: string | null;
}

/** The RESOLVED parent row. The caller fetches it; null when parentId is null. */
export interface FlParentRef {
  id: string;
  type: FlType;
}

export interface FlFieldError {
  field: 'name' | 'parentId' | 'type';
  message: string;
}

/**
 * @param siblingNames existing names under the SAME parent. On update the caller
 *   MUST exclude the location's own name, or a rename that keeps the same name is
 *   rejected. The validator cannot do this itself — it does not know the current
 *   row — and that contract is asserted in the tests.
 * @param selfId set on update, so a location cannot be re-parented to itself.
 */
export function validateFlDraft(
  draft: FlDraft,
  parent: FlParentRef | null,
  siblingNames: string[],
  selfId?: string,
): FlFieldError | null {
  const name = (draft.name ?? '').trim();
  if (!name) return { field: 'name', message: 'Name is required.' };

  if (draft.type === 'BLOCK') {
    if (draft.parentId) {
      return { field: 'parentId', message: 'A Block sits at the top level and cannot have a parent.' };
    }
  } else {
    if (!draft.parentId) {
      return { field: 'parentId', message: 'An Area must belong to a Block.' };
    }
    if (selfId && draft.parentId === selfId) {
      return { field: 'parentId', message: 'A location cannot be its own parent.' };
    }
    if (!parent) {
      return { field: 'parentId', message: 'The selected Block does not exist.' };
    }
    if (parent.type !== 'BLOCK') {
      return { field: 'parentId', message: 'An Area must belong to a Block, not to another Area.' };
    }
  }

  // Case- and whitespace-insensitive: the Postgres unique index is
  // case-sensitive, so "cwh" and "CWH" would both be stored and would be
  // indistinguishable to someone reading a dropdown.
  const clash = siblingNames.some((s) => (s ?? '').trim().toLowerCase() === name.toLowerCase());
  if (clash) return { field: 'name', message: `"${name}" already exists here.` };

  return null;
}
