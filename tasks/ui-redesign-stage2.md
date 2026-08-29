# UI redesign — Stage 2 (applying the design system)

Stage 1 (`7ed8329`) built the tokens and the missing primitives and migrated **no
pages**. This is the migration, ordered by leverage rather than alphabetically:
one edit to a token or to the shell changes every screen, while one edit to a
route changes one.

## Tier 0 — tokens (done)
- [x] **The font bug.** Inter was added as a self-hosted dependency and set as
      `--font-sans`, but `body` reads `--font-body`, which named Sora — fetched
      from `fonts.googleapis.com`. So Inter was bundled and never applied, and
      the faces that *were* applied came from a CDN this application's factory
      network may not reach. Both `--font-body` and `--font-display` now resolve
      to the bundled Inter; the Google Fonts `<link>` is gone from `index.html`.
- [x] **The duplicate radius scale.** `--radius-sm/md/lg/xl` aliased onto
      `--radius-control`/`--radius-card` rather than deleted — Tailwind generates
      `rounded-lg`/`rounded-xl` from them and those appear ~700 times, so
      deleting would silently drop the radius everywhere. `rounded-2xl`/`3xl`
      rewritten to the card radius across 59 files, skipping `routes/dashboard/`.
- [x] Zoom un-blocked (`maximum-scale=1.0, user-scalable=no` removed — WCAG
      1.4.4) and the stale "DigiLog — Digital Filter Management System" title
      replaced.

## Tier 1 — the application shell (done)
- [x] `sidebar.tsx` — collapsible icon rail (72px) with `title` tooltips, a
      positioned active rail, themed focus rings. **Deliberately still a FLAT
      list**: `config.sidebarItems` is an operator-ordered array, and imposing
      section headings would silently override an arrangement someone chose.
- [x] `header.tsx` — the desktop left side was an empty spacer; it now carries
      the sidebar collapse control, the app name (only while the sidebar is
      collapsed), and a dev-build environment chip. Role chips de-gradiented.
- [x] `app-layout.tsx` — collapse state persisted in `localStorage`, guarded.

## Tier 2 — configuration (done)
- [x] `dynamic-config.tsx` — **the biggest single lever**: it renders every
      auto-discovered config module. Now `PageHeader` + breadcrumbs, grouped
      `FormSection` cards in a two-column grid, `FormField` labels/required/help,
      the `Input`/`Select`/`Checkbox` primitives, and a **sticky** `FormActions`
      so a long form cannot hide its own Save.
- [x] `config/index.tsx` — one `ConfigCard` and one `ConfigGroup` replacing
      fourteen per-card gradient treatments. Colour kept, but spent on the icon
      tile only.

## Tier 3 — cross-cutting passes, applied to EVERY route (done)

These reached the config pages and the wider tree at once, which is why they were
done as passes rather than page by page:

- [x] **Form controls** — `.ctl`/`.ctl-sm`/`.ctl-check`/`.ctl-radio`; 134 controls
      across 43 files. Focus rings now follow `--theme-primary` on all ten themes.
- [x] **Type** — 37 `<h1>` + 23 `<h2>` onto the scale.
- [x] **Elevation** — 279 shadows onto three layers across 73 files.
- [x] **Borders** — 35 static 2px card borders to hairlines.
- [x] **Tables** — `.tbl` on all fifteen raw tables.
- [x] **Login** — taken off its `h-12 border-2` override of its own primitive.
- [x] **Dialogs and toasts** — focus capture/restore, `role="dialog"`,
      `aria-modal`, a polite live region, drawn icons instead of Unicode glyphs.
- [x] **Audit filters** — green "From" / red "To" date tiles neutralised; a date
      range has no good end and no bad end, and red is spent on limit breaches.

## Tier 4 — buttons and status badges (done)

- [x] **Buttons: 94 of 172 raw `<button>` migrated to `<Button>`** across 41
      files. The remainder is *categorised, not skipped* — re-derive any time with
      `scan_buttons.py`:
      - 32 dynamic className (state ternaries) — of which the segmented
        controls are now `.seg`; the rest are per-page colour codings.
      - 15 positioned overlays inside another control (a clear-`x` inside an
        input): giving these a control height breaks the composition.
      - 5 wrap block content — clickable **cards**, not buttons.
      - 3 carry a `group` class their descendants depend on (`group-hover:`).
      - 3 left-aligned rows / menu items.
      - ~16 inline micro-chips (`text-[10px] px-1.5`) in dense text rows, where
        even `size="sm"` (32px) would not fit. A 4th button size would be the
        principled fix and is deliberately NOT taken — "sizes nobody decided" is
        what Stage 1 removed.
- [x] **Segmented controls / tabs → `.seg` + `.seg-btn`**, active state painted
      by `aria-pressed` so the look cannot drift from the announced state.
- [x] **Status badges → `StatusBadge`** (4 → 9 files): user account state, alarm
      severity (incl. the dashboard's divergent fourth palette), password-reset
      request state, webhook target + delivery state, instrument reporting state,
      audit Success/Fail.
- [x] Users row actions: **Disable is amber, Delete is red.** They were both red,
      side by side, one of them irreversible.

## Tier 5 — page headers and states (done)

- [x] **`PageHeader` + breadcrumbs: 2 → 32 pages** (breadcrumbs on 34). PageHeader
      gained an optional `icon` drawn in ONE treatment — the theme's colour at a
      12% tint — replacing nineteen per-page gradient tiles. The back-chevron
      above the title went with it on the pages that had one: the breadcrumb's
      parent link is the way back.
- [x] **Empty and loading states** — table "Loading…" rows became `SkeletonRows`;
      empty rows became `EmptyState` with a title, a consequence and an action.

### Left un-migrated ON PURPOSE (not an oversight)

- **Auth screens** (`login`, `forgot-password`, `contact-admin`) — no app chrome
  and no breadcrumbs: a "Home" crumb on a logged-out page bounces the visitor
  into a login redirect. `contact-admin` was migrated by the script and REVERTED
  for exactly this, plus it had eaten the page's only link back to login.
- **`routes/dashboard/index.tsx`** — its header sits on a translucent plate so
  the title stays legible over the operator's wallpaper. PageHeader has no plate.
- **`instruments/list` and `profile`** — white-on-gradient identity strips, not
  page headers. Flattening them would remove a deliberate design.
- **`instruments/detail`, `functional-locations/detail`, `users/edit`,
  `trend-header`** — contextual identity headers whose title is the record.
  Worth migrating one day; each needs a judgement about what the crumb trail
  says for a record that may have been renamed.

## Tier 6 — loading states (done)

- [x] **17 spinners → skeletons**, each shaped like what it replaces: table
      bodies at their REAL column count, card grids in their real grid, System
      Health as four stat tiles above a two-column card grid. Seven screens
      shared one loader (a tinted circle around a spinner, each in its own
      accent), which is why they converted together.
- [x] Verified in the browser, not assumed: sampling the DOM during navigation
      shows the skeleton appear, a `role="status"` live region announce it, and
      the skeleton clear to ZERO with real rows in place.

**Three loading affordances stay, on purpose** (reasons are in the code):
the app boot splash (nothing is known yet — the session has not resolved, so
this may become the dashboard, a login redirect, a forced password change or the
lockdown screen; a skeleton would promise a layout that usually never appears),
`<option>Loading…</option>` inside a select, and the multiselect's inline
caption.

## Tier 7 — section icons (done)

- [x] **29 section-header tiles** onto the treatment Stage 1's `FormSection`
      already defined: `bg-slate-100 text-slate-600` in a control-radius square.
      The hierarchy is now legible — the PAGE icon carries the theme colour, the
      SECTION icons are quiet. Measured 6.92:1, past the 3:1 graphics need.
- [x] **8 gradient chips inside form fields** flattened to plain muted glyphs;
      the `pl-12 h-12` clearance they had forced went back to the standard
      control height. `forgot-password` also lost the `h-12 border rounded-xl`
      override of the `Input` primitive that `login` had already been fixed for.

**Semantic tints are deliberately untouched** — the red on an error banner and
the emerald on a success one carry meaning, not decoration. Only the decorative
gradients went.

## Tier 8 — the last raw controls (done)

- [x] **20 of the 23 "dynamic classNames" were not conditional at all** — they
      were `className={field}`, one module-level constant per file. Pointing
      three constants (`field` ×2, `inputCls`) at `.ctl` moved every call site,
      and their hardcoded slate/cyan focus rings now follow the site theme.
      Verified: all 8 controls in the webhook dialog measure 40px at 6px radius.
- [x] **The two genuinely conditional ones**: `help.tsx` re-implemented
      `[readonly]`/`:disabled` that `.ctl` already does (ternary removed);
      `export-options` KEEPS its value tint (it encodes PDF/Excel/Both/None) but
      gained a control shape and a real focus ring — it had `outline-none` with
      nothing put back.
- [x] The one VISIBLE file input styled via `file:` variants; colour swatches
      44px → 40px.

### Found while doing it

- [x] **`/config/export-options` had no route.** The config def declares
      `customPagePath` and the dashboard renders a card, but nothing was
      registered — the card fell through to the dashboard and the page had never
      been reachable. Registered with the sibling `CONFIG_READ` guard
      (Routes 50 → 51) and given the standard header.
- [x] **The Dialog focus fix drew a ring around the panel.** The global
      `:focus-visible` rule is unlayered and beat the panel's own
      `focus:outline-none` utility — the cascade-layer trap again. Exception now
      lives unlayered beside the rule it excepts.
- [x] **alarm-webhooks has two hand-rolled modals** that never used the Dialog
      primitive, so the `role`/`aria-modal` fix missed them. Both announced and
      labelled now.

## Tier 9 — still open
- [ ] **Remaining filter/action chips** — Field IDs' module filter and the audit
      `ACTION_COLORS` map are per-item colour codings, not statuses. They are
      internally consistent; unifying them would destroy the coding.
- [ ] **12 hidden/custom-widget controls** (`sr-only`, `peer`, `hidden`) — real
      inputs deliberately drawn over by something else. Correct as they are;
      listed so nobody "fixes" them.
- [ ] `routes/config/export-options.tsx` is now reachable but has never been
      exercised by anyone. Worth an operator's eye before it is trusted.

## Verification
`npx tsc -p apps/web/tsconfig.json --noEmit` after each tier — vitest never
typechecks, so it is not a check here. `npx vite build` as the second gate.

## Excluded on purpose (each has a measured reason in code)
`.tv-*` dark tabular view (operator preference, contrast measured across all 10
presets); `--chart-*` literal fallbacks (the PDF export serialises SVG with no
stylesheet); dashboard panel-card geometry and `rounded-2xl` (tuned with the
operator days ago); `.band-marker`; no dark theme anywhere.
