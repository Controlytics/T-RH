/**
 * The ONE mapping from the server's verdict on an instrument — `status`,
 * `reporting`, `judged` — to the word and colour the status widgets show (status
 * grid, instrument list, status pie). No widget words an instrument itself.
 *
 * Nothing is judged here: all three fields are the server's. The only rule is
 * how a NOT-judged instrument reads — one whose profile measures neither
 * temperature nor humidity (a pressure-only project instrument), for which the
 * server's status is a meaningless NO_DATA:
 * - reporting → "Not judged", neutral (`UNJUDGED_CLASSES`) — never "No data",
 *   never green: nothing checks its readings against a limit;
 * - not reporting → "Offline" (`STALE`), which is still true of it.
 *
 * An absent `judged` (a response cached before the field existed) reads as
 * judged, so such a row shows exactly what it showed before.
 *
 * If this ruling (phase 2 P3) is ever wrong, this is the one function to change.
 */
import type { InstrumentStatus } from '@digilog/shared';
import { statusClasses, type StatusClasses } from '../status';
import type { OverviewRow } from '../use-telemetry';
import { UNJUDGED_CLASSES } from './key-value';

export type InstrumentLookKey = InstrumentStatus | 'NOT_JUDGED';

export interface InstrumentLook {
  /** Also the key into `STATUS_HEX` (`charts/chart-colors.ts`). */
  key: InstrumentLookKey;
  classes: StatusClasses;
}

export function instrumentLook(row: Pick<OverviewRow, 'status' | 'reporting' | 'judged'>): InstrumentLook {
  if (row.judged === false) {
    return row.reporting
      ? { key: 'NOT_JUDGED', classes: UNJUDGED_CLASSES }
      : { key: 'STALE', classes: statusClasses('STALE') };
  }
  return { key: row.status, classes: statusClasses(row.status) };
}
