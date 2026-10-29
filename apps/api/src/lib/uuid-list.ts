const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses a comma list of ids from a querystring (`instrumentIds`).
 *
 * Absent (`undefined`) means NO filter, so it returns `{}`. Present but empty
 * (`''`) means "these ids: none", so it returns `{ ids: [] }` and the caller must
 * select NOTHING. Reading `''` as absent would turn a dashboard whose instrument
 * list was emptied into one showing the whole estate. Entries are trimmed, empty
 * ones dropped and duplicates removed. A bad entry or too many is an `error`,
 * which the route returns as a 400 instead of silently using a subset.
 */
export function parseUuidList(raw: string | undefined, max: number): { ids?: string[]; error?: string } {
  if (raw === undefined) return {};
  const ids = [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))];
  if (ids.some((id) => !UUID_RE.test(id))) return { error: 'instrumentIds must be instrument ids' };
  if (ids.length > max) return { error: `At most ${max} instrumentIds` };
  return { ids };
}
