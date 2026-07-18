# SearchableSelect — Filter & AHU pickers on the tablet Status tab

**Date:** 2026-07-17
**Branch:** RFID
**Status:** Approved (design), pending implementation

## Problem

The tablet Status tab makes an operator pick a filter from a native `<select>`
that renders every filter in the site as an `<option>`. There are ~376 filters
today and the expected ceiling is **~2,500**. At that size the operator cannot
realistically scroll to the one they want, and the browser's single-character
type-ahead is not a usable substitute.

A second, quieter problem: the option list is built and painted on page load
whether or not the picker is ever opened, so every Status-tab visit pays the
cost of ~2,500 DOM nodes.

## Scope

**In scope** — the tablet Status tab (`apps/web/src/routes/mobile/mobile-wrapper.tsx`):

- the filter picker at `:1400`, fed by `filterOptionsStatus` (`:1244`)
- the AHU picker in the same cascade, fed by `ahuOptionsStatus` (`~:1230`)

**Out of scope** — the other six filter pickers in the app (filter-lifecycle,
cleaning-cycles history, cleaning-profile-assignment, filter-data-management,
and the three other mobile-wrapper views). They keep their native `<select>`.
They can adopt the component later if it proves out; this spec does not migrate
them.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where search runs | **Client-side, in memory** | The Status tab already holds the full list. Instant, and it keeps working offline — the tablet is the offline device, so server-side search would silently break the primary use case. |
| Searchable fields | **Filter name only** (AHU name only, for the AHU picker) | The Block→Area→AHU cascade already scopes by AHU. Searching AHU names from the filter box would duplicate a control that already exists. |
| Match semantics | **Multi-keyword substring, case-insensitive** | Single word behaves as plain substring (`042` → `HF-042`). Extra words narrow rather than break (`hf 042` → `HF-042`). |
| Fuzzy matching | **No** | On a 21 CFR Part 11 system, a picker that offers a near-miss (`HF-04` → `HF-40`) invites logging a cleaning against the wrong asset. Exact substring keeps the operator in control. |
| Backend change | **None** | `/api/hierarchy/filters` needs no `search` param. `/api/assets/instances` already has one (`instance.service.ts:56`) and we are not using it. |

## Component

New file: `apps/web/src/components/ui/searchable-select.tsx`

Sits **alongside** the existing `select.tsx` rather than replacing it, so
untouched pickers are unaffected. Props mirror the native select's shape
(`value`, `onChange`, `options`, `placeholder`, `disabled`) so adopting it at a
call site is a small, reviewable edit.

Behaviour:

- Closed: a button showing the selected option's label.
- Open: a text input on top, matching options below.
- Selecting an option fires `onChange(value)` and closes the panel.
- Clearing the query restores the full (capped) list.
- Escape / outside-tap closes without changing the selection.

## Matching — `matchOptions(options, query)`

Extracted as a **pure function** in the same file (exported for test) so the
matching rules can be unit-tested without rendering.

```
matchOptions(options, query):
  if query is blank -> return options unchanged
  words = query.toLowerCase().split(/\s+/).filter(Boolean)
  matched = options where EVERY word is a substring of label.toLowerCase()
  return rank(matched, query)
```

### Ranking (required, not cosmetic)

`rank()` orders matches: **exact label match first, then prefix matches, then
the remainder** — each group keeping its existing alphabetical order.

This exists to close a real bug: with only a render cap and no ranking, a query
matching 60 options whose *exact* match sorts 51st would be filtered in but
never painted. The operator would conclude the filter does not exist. Ranking
guarantees an exact match is always position 1 and can never be cut.

## Render cap

Only the first **50** ranked matches are rendered. When matches exceed 50, a
line below the list reads:

> Showing 50 of 2,500 — keep typing to narrow

The cap limits **rendering only**. Matching always runs across the full list, so
typing a complete filter name resolves to that filter regardless of list size.

## Styling

Tailwind, consistent with `select.tsx`: `rounded-xl`, `border-2
border-slate-200`, white panel, `focus:ring-4` indigo ring, `shadow-sm`. Light
theme only. Touch targets sized for a tablet (min `h-11` rows), not a mouse.

## Testing

**Unit** (`apps/web/src/components/ui/__tests__/searchable-select.test.ts`,
vitest + jsdom, per `apps/web/CLAUDE.md`):

1. blank query returns all options
2. single word matches as substring, case-insensitively
3. multi-word requires all words, order-independent
4. no match returns empty
5. cap renders at most 50
6. **exact match ranks first even when 60 others match** (the ranking guard)
7. prefix matches rank above mid-string matches

**Device** — the only place this ships is the tablet, so unit tests are not
sufficient evidence of done. On real hardware, verify: both pickers open, search
narrows, selection drives the existing cascade, and the list is still reachable
with the on-screen keyboard raised.

## Known risk

Capacitor raises an on-screen keyboard when the search input takes focus, which
may cover the options list. This cannot be settled from the desktop — it is an
explicit device-verification item. If the keyboard does occlude the list, the
panel needs repositioning or a constrained max-height.

## Explicitly not doing

- No backend change
- No fuzzy matching
- No migration of the other six pickers
- No virtualised list (the 50-cap makes it unnecessary)
