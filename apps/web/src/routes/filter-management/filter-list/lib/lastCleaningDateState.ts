// Pure helpers for the Last Cleaning Date input's "date OR NA" state.
//
// Stored on the filter as attributes.lastCleaningDate, with three valid
// states:
//   - undefined (field never filled — distinct from "explicitly NA")
//   - "NA"      (operator ticked the NA checkbox)
//   - ISO date  (e.g. "2026-04-15")
//
// The dialog input owns a {date, na} pair; these helpers translate to/from
// the stored representation.

export type LastCleaningDateState = { date: string; na: boolean };

export function decodeLastCleaningDate(stored: string | null | undefined): LastCleaningDateState {
  if (stored === 'NA') return { date: '', na: true };
  if (stored === null || stored === undefined || stored === '') return { date: '', na: false };
  return { date: stored, na: false };
}

export function encodeLastCleaningDate(state: LastCleaningDateState): string | undefined {
  if (state.na) return 'NA';
  if (!state.date) return undefined;
  return state.date;
}
