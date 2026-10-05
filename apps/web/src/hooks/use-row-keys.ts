import { useRef } from 'react';

let seq = 0;
const newKey = () => `row-${++seq}`;

/**
 * Stable React keys for an editable list whose rows have no id of their own
 * (audit 2026-10-03, WEB-14) — LDAP required groups and role mappings, webhook
 * headers, notification-rule recipients.
 *
 * Those lists were keyed by index. Remove row 2 while the caret is in row 3's
 * input and React reuses row 2's DOM node for what is now row 2 (the old row
 * 3): the caret lands in the wrong input. The values stay right (controlled),
 * the focus does not. A key per row that follows the ROW, not its position,
 * is the fix; a client-only `id` on the row itself would be sent to the server
 * with the rest of the object, so the keys live beside the state instead.
 *
 * `at(i)` is the key of row i. A list that GREW (a row appended, a different
 * record loaded) gets keys for the new rows on the next render and keeps the
 * ones it had. A row REMOVED must be reported with `remove(i)` BEFORE the
 * state update that drops it — otherwise the resync only truncates the tail
 * and the row after the removed one inherits its key, which is the exact
 * defect this exists to prevent.
 */
export function useRowKeys(count: number): { at: (i: number) => string; remove: (i: number) => void } {
  const keys = useRef<string[]>([]);
  if (keys.current.length !== count) {
    keys.current = Array.from({ length: count }, (_, i) => keys.current[i] ?? newKey());
  }
  return {
    at: (i: number) => keys.current[i] ?? `row-${i}`,
    remove: (i: number) => {
      keys.current = keys.current.filter((_, j) => j !== i);
    },
  };
}
