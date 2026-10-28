/**
 * What a bulk upload will DO, row by row (2026-10-28).
 *
 * Until this date a row naming an Instrument ID that already existed was an
 * error. The operator: "when user doing bulk upload with already exiting
 * instrument ids and like attributes values changed and uploaded then already
 * existed error was coming, there i need like what values are changed those
 * data should update". So an existing ID is now an UPDATE of the attribute
 * cells that differ, or UNCHANGED when none do.
 *
 * This is the ONE rule. `POST /bulk/preview` runs it to show the operator the
 * changes before anything is written, and `POST /bulk` runs it again on the
 * same file at commit — it never takes a diff from the browser — so what was
 * reviewed is what is written, and the two cannot drift.
 *
 * Pure: the route reads the instruments, their attributes, the offset keys and
 * the caller's Attribute Access, and hands them in.
 *
 * Rules, each the safe reading of a file:
 * - a BLANK cell keeps the stored value. A file cannot clear one; removing an
 *   attribute is its own audited act with its own remark.
 * - only ATTRIBUTES change. Identity columns (`name`, `model`, …) are not
 *   applied to an existing instrument, and a file carrying them is told so once.
 * - an instrument in ANOTHER profile is refused on its row, never moved: a
 *   profile move is governed (it can change what is monitored and alarmed).
 * - an instrument outside the caller's view is the old "already exists" error,
 *   and nothing of it is read into the answer.
 * - a row is all or nothing: one refused cell fails the row.
 */
import { parseOffsetValue, formatOffsetValue, SENSOR_OFFSET_VALUE_MESSAGE } from '@digilog/shared';
import type { InstrumentDraft, RowError } from './bulk-csv.js';

export interface ExistingInstrument {
  id: string;
  /** As stored — the answer names it this way whatever case the file used. */
  code: string;
  profileId: string;
  profileName: string;
  /** Inside the caller's instrument view. */
  visible: boolean;
  /** Its stored attributes, ordered by key (the case-variant pick depends on it). */
  attributes: { key: string; value: string }[];
}

export interface PlannedChange {
  /** The key written: the STORED spelling when the instrument has one, else the profile's. */
  key: string;
  /** The heading as the file spells it. */
  column: string;
  /** The value replaced; null when the instrument has none yet (a first fill). */
  from: string | null;
  to: string;
}

export type RowPlan =
  | { kind: 'create'; index: number; row: number; code: string; attributes?: Record<string, string> }
  | { kind: 'update'; index: number; row: number; id: string; code: string; changes: PlannedChange[] }
  | { kind: 'unchanged'; index: number; row: number; id: string; code: string };

export interface BulkPlanInput {
  rows: InstrumentDraft[];
  rowNumbers: number[];
  codeHeading: string;
  headings: Record<string, string>;
  identityColumns: string[];
  /** The profile chosen for the upload. */
  profileId: string;
  /** Every instrument a row names, keyed by lower-cased code (codes are unique ignoring case). */
  existing: Map<string, ExistingInstrument>;
  isOffset: (key: string) => boolean;
  /** The caller holds Instrument Update. */
  mayUpdate: boolean;
  /** The Attribute Access refusal for one key on an existing instrument, or null. */
  accessRefusal: (key: string, isNewKey: boolean) => string | null;
}

const fold = (s: string) => s.trim().toLowerCase();

/** The stored attribute a column writes: the exact key, else the first that differs only by case. */
function storedFor(attributes: ExistingInstrument['attributes'], key: string) {
  return attributes.find((a) => a.key === key) ?? attributes.find((a) => fold(a.key) === fold(key));
}

export function planBulkUpload(input: BulkPlanInput): { plans: RowPlan[]; errors: RowError[]; warnings: string[] } {
  const plans: RowPlan[] = [];
  const errors: RowError[] = [];
  const column = (key: string) => input.headings[key] ?? key;

  input.rows.forEach((draft, index) => {
    const row = input.rowNumbers[index];

    // Every filled cell, offsets written with their sign — compared and stored
    // the way the single attribute routes store them, so `2` against a stored
    // `+2` is no change.
    const values: [string, string][] = [];
    let bad = false;
    for (const [key, raw] of Object.entries(draft.attributes ?? {})) {
      if (!input.isOffset(key)) { values.push([key, raw]); continue; }
      const parsed = parseOffsetValue(raw);
      if (parsed === null) { errors.push({ row, column: column(key), message: SENSOR_OFFSET_VALUE_MESSAGE }); bad = true; continue; }
      values.push([key, formatOffsetValue(parsed)]);
    }
    if (bad) return;

    const found = input.existing.get(draft.code.toLowerCase());
    if (!found) {
      plans.push({ kind: 'create', index, row, code: draft.code, ...(values.length ? { attributes: Object.fromEntries(values) } : {}) });
      return;
    }
    // Worded exactly as before this date: out of view, the instrument is a
    // collision and nothing more.
    if (!found.visible) {
      errors.push({ row, column: input.codeHeading, message: `Instrument ID "${draft.code}" already exists` });
      return;
    }
    if (found.profileId !== input.profileId) {
      errors.push({
        row, column: input.codeHeading,
        message: `Instrument ID "${found.code}" belongs to profile "${found.profileName}". Choose that profile to update it.`,
      });
      return;
    }

    const changes: PlannedChange[] = [];
    for (const [key, to] of values) {
      const stored = storedFor(found.attributes, key);
      // Whitespace round a stored value is not a difference anyone can see,
      // and rewriting it would be an audit row about nothing.
      if (stored && stored.value.trim() === to) continue;
      changes.push({ key: stored?.key ?? key, column: column(key), from: stored ? stored.value : null, to });
    }
    if (changes.length === 0) {
      plans.push({ kind: 'unchanged', index, row, id: found.id, code: found.code });
      return;
    }
    if (!input.mayUpdate) {
      errors.push({ row, column: input.codeHeading, message: `Instrument ID "${found.code}" already exists, and your role may not change instruments` });
      return;
    }
    const refused = changes
      .map((c) => ({ c, message: input.accessRefusal(c.key, c.from === null) }))
      .filter((r): r is { c: PlannedChange; message: string } => r.message !== null);
    if (refused.length > 0) {
      for (const { c, message } of refused) errors.push({ row, column: c.column, message });
      return;
    }
    plans.push({ kind: 'update', index, row, id: found.id, code: found.code, changes });
  });

  const warnings: string[] = [];
  if (input.identityColumns.length > 0 && plans.some((p) => p.kind !== 'create')) {
    warnings.push(
      `Column(s) ${input.identityColumns.map((c) => `"${c}"`).join(', ')} do not change an instrument that already exists — only its attributes are updated.`,
    );
  }
  return { plans, errors, warnings };
}

/**
 * The upload must carry a remark: some change OVERWRITES a recorded value. A
 * first fill asks for none — the same rule the single attribute routes apply
 * (`refuseAttributeWrite`). Decided here, on the server, and returned by the
 * preview so the page asks exactly when the upload will demand it.
 */
export function remarkRequired(plans: RowPlan[]): boolean {
  return plans.some((p) => p.kind === 'update' && p.changes.some((c) => c.from !== null));
}
