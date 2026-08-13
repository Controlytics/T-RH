# Colourful UI — per-module palettes across every page

**Date:** 2026-08-13
**Branch:** `data-injection`
**Status:** approved for planning

## Goal

Every page in `apps/web` becomes visibly colourful. No page keeps a plain white or
plain slate background. Colour is applied to surfaces *under* the data — tinted
cards, solid colour table headers, tinted alternating rows — not merely around it.

## Operator decisions

Recorded because each closed a real fork, and reversing one later is expensive:

1. **Vivid, with per-module palettes.** Each module gets its own hue so you can
   tell which part of the app you are in at a glance. Not one global hue.
2. **Treatment B — saturated surfaces.** Colour goes under the data: tinted card
   surface, solid colour table header band, rows alternating between two tints of
   the module hue. Rejected: treatment A (colour only around a white data card —
   judged a half-measure) and treatment C (frosted glass on a deep gradient —
   rejected because it is a dark theme).
3. **Curated fixed palette set** in code. Rejected: hue-rotation derived from the
   active theme (algorithmic hues land on muddy pairs, and "Audit is amber" cannot
   be guaranteed) and per-module colour pickers in Config (new config def + page +
   audit wiring for no requested benefit, and it permits unreadable combinations).
4. **Delivered in waves with a review gate after wave 1.** Rejected: one big pass.

## Why the app currently reads as white

`lib/themes.ts` already defines 10 palettes and pushes them into `--theme-*` CSS
custom properties. Across all of `apps/web/src` those variables are referenced
**25 times**, against **305** `bg-white`, **168** `bg-slate-50` and **362**
`border-slate-200`. Choosing a theme on the Branding page today recolours the
sidebar and a few gradient dialog headers and nothing else. The theme picker is
not broken — it was simply never wired to the surfaces.

Two further facts that shape the design:

- **One page canvas.** `components/layout/app-layout.tsx:172` — a single `<main>`
  carrying `bg-gradient-to-br from-slate-50 to-slate-100/50`. Every page's
  background comes from that one line.
- **Primitives do not cover the app.** `Card` is imported by 27 files and `Button`
  by 53, but **57 route files paint raw `bg-white` themselves**, and the `Table`
  primitive is used by only **7** files — most tables here are hand-rolled
  `<table>` with hardcoded classes.

## Architecture

### 1. Module palette layer (new)

`apps/web/src/lib/module-palettes.ts` — a curated map from route prefix to palette:

```ts
interface ModulePalette {
  id: string;          // 'instruments'
  label: string;       // 'Instruments'  (used in comments / devtools only)
  from: string;        // gradient start, 600-level
  to: string;          // gradient end, 600-level
  tableHead: string;   // 700-level — NOT `from`. See Contrast below.
  text: string;        // primary body text on tinted surfaces (950-level)
  muted: string;       // secondary text (800-level)
}
```

Surfaces are **not** stored. They are derived in CSS (§2) so that a palette is six
colours rather than ten, and the tint relationship is defined once instead of
twelve times.

`apps/web/src/hooks/use-module-palette.ts` resolves the palette for the current
route by **longest-prefix match** on `useLocation().pathname` and writes it to
`--mod-*` custom properties on `document.documentElement`. Mounted once in
`AppLayout`. This is the same mechanism `applyTheme()` already uses, so no new
pattern is introduced — and because it is CSS variables, navigating recolours the
page without re-rendering page content.

The hook emits exactly these custom properties, and nothing else writes them:

```
--mod-id  --mod-from  --mod-to  --mod-table-head  --mod-text  --mod-muted
```

**Longest-prefix match matters:** `/config/floorplans` must resolve to `config`,
not to the `/` dashboard entry. An unmatched route falls back to the neutral
`fallback` palette (today's slate), so a route added later degrades to the current
appearance rather than to something arbitrary.

### 2. Surface tokens

In `app.css`, after `@import "tailwindcss"`:

```css
:root {
  --surface:        color-mix(in srgb, var(--mod-from)  6%, white);
  --surface-alt:    color-mix(in srgb, var(--mod-from) 12%, white);
  --surface-raised: white;                                    /* popovers, menus */
  --border-tint:    color-mix(in srgb, var(--mod-from) 25%, white);
}
```

One definition; every module derives its own tints from its own `from`. This is why
`ModulePalette` does not carry surface colours — 12 palettes x 4 surfaces would be
48 hand-picked values and some of them would be wrong.

### 3. The compatibility layer (the safety net)

Also in `app.css`, these legacy utilities are redefined to resolve to the tokens:

| Utility | Resolves to |
|---|---|
| `.bg-white` | `var(--surface)` |
| `.bg-slate-50` | `var(--surface-alt)` |
| `.bg-slate-100` | `var(--surface-alt)` |
| `.border-slate-200`, `.border-slate-200\/60` | `var(--border-tint)` |

This is what makes the 57 untouched route files stop being white without editing
57 files blind.

`.surface-plain` is the documented opt-out, restoring true white. Applied to:
`components/report-page-wrapper.tsx` (PDF-facing chrome), the login card, and
toasts.

**This is a deliberate lie to anyone reading a component file**, and the spec says
so out loud rather than discovering it later. Mitigations:

- A loud header comment in `app.css` naming the override, the reason, and the
  opt-out class.
- Each wave replaces `bg-white` with `bg-surface` in the files it touches, so the
  layer shrinks rather than calcifying. It will **not** reach zero within this
  piece of work, and no claim will be made that it has.

### 4. Page canvas

`app-layout.tsx:172` drops `from-slate-50 to-slate-100/50` and takes the module
gradient wash instead:

```css
background:
  linear-gradient(140deg,
    color-mix(in srgb, var(--mod-from) 18%, white) 0%,
    color-mix(in srgb, var(--mod-to)   14%, white) 55%,
    color-mix(in srgb, var(--mod-from) 10%, white) 100%);
```

18 / 14 / 10 % against the card surface at 6 % keeps roughly 8–12 % separation, so
a tinted card still reads as raised against the canvas. If the canvas is pushed
darker than ~20 % the cards stop separating and need a shadow increase to
compensate — that is the constraint to respect when tuning depth, not a fixed
number to preserve.

### 5. Primitives rewritten properly

- `ui/card.tsx` — tokens instead of `bg-white` / `border-slate-200/60`; new
  gradient header-band variant.
- `ui/table.tsx` — solid `--mod-table-head` header with white text; rows alternate
  `--surface` / `--surface-alt`.
- `ui/dialog.tsx`, `ui/input.tsx`, `ui/select.tsx`, `ui/searchable-select.tsx`,
  `ui/badge.tsx`, `ui/button.tsx`, `ui/pagination.tsx`
- `layout/sidebar.tsx`, `layout/header.tsx` — these stay driven by `--theme-*`
  (see §6) but pick up the module accent on the active item.
- **New:** `ui/stat-tile.tsx` — the full-colour gradient stat tile from mockup B.
  It does not exist today; each page hand-rolls its own, differently.

### 6. Two colour systems, explicitly divided

`--theme-*` (the 10 themes) and `--mod-*` (module palettes) coexist with a written
boundary:

- `--theme-*` owns **chrome**: sidebar, login screen, primary buttons.
- `--mod-*` owns **page**: canvas, cards, tables, stat tiles, header bands.

That division goes in a comment in *both* `themes.ts` and `module-palettes.ts`.
Without it, the next person adds a third system — this repo already has two
overlapping ones (`THEMES` and the Branding config).

### 7. Status colour is not touched

Red / amber / green keep their existing meanings (out-of-limit, stale, in-spec).
Status pills become **solid-filled** so they read against a tinted row, and every
status keeps its glyph **and** its word. This is already the repo's rule
(`apps/web/CLAUDE.md`: "status colour never carries meaning alone") and treatment B
is precisely the case that rule exists for.

## Palette set — measured, not eyeballed

Body text on `--surface` / `--surface-alt`, and white on `tableHead`. WCAG AA body
text requires >= 4.50.

| Module | from | to | tableHead | worst ratio |
|---|---|---|---|---|
| `/` dashboard | `#4f46e5` | `#7c3aed` | `#4338ca` | 7.90 |
| `/home` | `#2563eb` | `#0284c7` | `#0369a1` | 5.93 |
| `/instruments` | `#0891b2` | `#0d9488` | `#0f766e` | 5.47 |
| `/audit` | `#d97706` | `#ea580c` | `#b45309` | 5.02 |
| `/config` | `#059669` | `#16a34a` | `#047857` | 5.48 |
| `/users` | `#db2777` | `#e11d48` | `#be185d` | 6.04 |
| `/notifications` | `#7c3aed` | `#c026d3` | `#7e22ce` | 6.98 |
| `/admin-requests` | `#ca8a04` | `#65a30d` | `#a16207` | 4.92 |
| `/debug/traces` | `#475569` | `#334155` | `#334155` | 8.66 |
| `/profile` | `#9333ea` | `#7c3aed` | `#7e22ce` | 6.98 |
| `/system-health` | `#0d9488` | `#059669` | `#0f766e` | 5.47 |
| fallback | `#475569` | `#334155` | `#334155` | 8.66 |

**Worst pair across all 12 palettes: 4.92:1.** White on the gradient `to` colour
ranges 3.09–10.35, which clears the >= 3.0 large-text threshold everywhere — so
gradient bands may carry 18px+ bold headings only, never body text.

**`tableHead` exists because of a measured failure.** The first draft reused `from`
as the header band. White body text on cyan-600, amber-600, emerald-600, yellow-600
and teal-600 measured **2.94–3.77:1** — five of twelve palettes failing AA.
Mid-600 tones are the trap; the header band must be 700-level. Anyone tempted to
"simplify" by deleting `tableHead` and reusing `from` will reintroduce five
failures.

**Hue adjacency, stated honestly:** eight palettes are strongly distinct.
`/profile` sits adjacent to `/notifications` (both violet-ward) and
`/system-health` adjacent to `/instruments` (both teal-ward). Accepted — these are
low-traffic pages, and forcing twelve mutually distinct hues would push some into
muddy territory. Red is deliberately unused as a module hue because it means
danger.

## Waves

**Wave 1 — foundation + the six most-used pages.**
`module-palettes.ts`, `use-module-palette.ts`, the `app.css` token + safety-net
layer, the `<main>` canvas, all primitives from §5, `StatTile`, sidebar + header.
Then hand-tuned: `/`, `/instruments`, `/instruments/:id`, `/audit`, `/config`,
`/users`. **Hard stop — operator reviews in the browser before wave 2 begins.**

**Wave 2** — `/instruments/new`, `/instruments/bulk`,
`/instruments/profiles/:profileId`, `/notifications`, `/admin-requests`, `/home`,
`/profile`, `/system-health`, `/debug/traces`.

**Wave 3** — the config cluster: the 21 `/config/*` sub-pages,
`dynamic-config.tsx`, the roles tabs (permissions / reauth / sidebar),
`branding-components/*`, `notification-rules/`, `notification-settings/*`.

**Wave 4** — shared dialog sweep (`confirm-dialog`, `message-dialog`,
`error-popup`, `reauth-dialog`, `toast`); burn down leftover raw `bg-white` in
every file the earlier waves touched; final contrast pass over the finished set.

Route facts: **42 unique paths / 45 `<Route>` definitions**, of which 21 are
`/config/*`. `/config/dynamic/:moduleKey` renders many config surfaces through one
file, which is where wave 3 gets its leverage.

## Verification

Mechanical, every wave:

- `npx tsc --noEmit -p apps/web/tsconfig.json` — **vitest does not typecheck in
  this repo** (esbuild strips types without checking them), so this is the only
  thing that catches a broken edit.
- `npx vite build`
- `npx vitest run` in `apps/web`, compared against the known-failing baseline.
  That baseline is **recorded as 5** (Phase 0 domain-strip test debt, not product
  defects) but this number comes from a prior session's notes, not from a run in
  this one. **Wave 1 establishes it by running the suite before touching anything**
  and uses the observed number thereafter. Ratchet down only, never up.
- A contrast script (kept in the scratchpad, numbers transcribed into this spec)
  recomputing every palette's text-on-`surface`, text-on-`surface-alt` and
  white-on-`tableHead` ratio. Any pair under 4.5 gets its tint percentage or its
  `tableHead` level adjusted before the wave ships.

**What cannot be verified here, stated plainly:** Playwright's browser cannot fetch
this API through the mkcert certificate, so it never gets past `/login` and no
authenticated page can be reached. **Zero tests in `apps/web` assert a CSS class**
(verified by grep), so this entire change is invisible to the test suite — nothing
goes red if a page is wrong.

Therefore every wave ends by handing the operator `https://localhost:5176`, the
list of pages changed, and an explicit statement that the pages have not been
looked at. A green build is not evidence that a page is beautiful and will not be
presented as such.

## Documentation to update

Per the repo's documentation sync rule:

- **root `CLAUDE.md`** — the rule "Light theme only — `bg-white`, `bg-slate-50`,
  `border-slate-200`, gradient dialog headers OK" is directly reversed by this
  work. Also needs the `--theme-*` / `--mod-*` chrome-vs-page division.
- **`apps/web/CLAUDE.md`** — its "Theme" section states "Unified light theme:
  bg-white cards, bg-slate-50 sections" (now wrong) and "No dark theme anywhere"
  (still true — treatment C was rejected).
- **`apps/web/DECISIONS.md`** — the compatibility-layer override, why it exists,
  and the `.surface-plain` opt-out.
- **`CHANGELOG.md`**
- **The Branding page** — the theme picker currently presents itself as setting the
  application's colours while changing almost nothing. Relabel to state that it
  controls the sidebar, login screen and buttons. A one-line honesty fix in the UI,
  not scope creep.

## Out of scope

- **Dark mode.** Treatment C was rejected; this stays a light application.
- **Login / forgot-password / contact-admin screens.** Already full-bleed gradient
  driven by branding colours, not white. Left alone.
- **PDF and print output stays light.** Saturated backgrounds on a printed 21 CFR
  Part 11 record waste ink and reduce legibility, so screen and paper deliberately
  differ. `report-page-wrapper` gets `.surface-plain`.
- **Making the 10 themes drive page colour.** Decision 3 keeps them on chrome.
- **Per-module colour configuration in Config.** Explicitly rejected.
- **The operator's uncommitted work.** Five modified files on `data-injection`
  (including `config/instrument-attributes.tsx`, which wave 3 will touch) plus an
  untracked PDF are left exactly as they are; only files belonging to this work get
  committed. If wave 3 needs to edit `instrument-attributes.tsx` while it still has
  uncommitted changes, that is called out at the time rather than silently merged.

## Risks

| Risk | Mitigation |
|---|---|
| Tinted rows weaken the out-of-spec signal — the acknowledged cost of treatment B | Solid-filled status pills, glyph + word retained, dedicated left inset bar on out-of-limit rows |
| The safety net recolours somewhere white was deliberate | `.surface-plain` opt-out; wave 4 sweep specifically hunts these |
| No test protection, no browser access for the implementer | Review gate after wave 1; operator is named as the sole visual verifier throughout |
| `color-mix` browser support | Chrome/Edge 111+, and the app already ships `color-mix` in `lib/theme-styles.ts`, so this adds no new requirement |
| Twelve palettes drift out of contrast compliance as they are tweaked | The contrast script is re-run every wave, not once |
