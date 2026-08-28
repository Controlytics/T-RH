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

## Tier 4 — NOT DONE. What a follow-up session should pick up

Honest list. These are structural, per-page edits that no safe scripted pass
reaches:

- [ ] **`PageHeader` + breadcrumbs adoption: 2 of ~42 pages.** Most pages still
      assemble their own header (icon tile + title + actions). They are now
      CONSISTENT with each other — the h1 pass saw to that — but they carry no
      breadcrumbs, so §24/§25 of the brief are only partly met. `dynamic-config`
      and `config/index` show the target shape.
- [ ] **Buttons: ~180 raw `<button>` across 68 files.** Nearly all build their
      className from a template literal, so they cannot be converted by a string
      pass; each needs migrating to `<Button>` by hand. The primitive itself is
      correct and `whitespace-nowrap` is fixed, so the damage is bounded.
- [ ] **Status badges: 43 bespoke pills** against 4 uses of `StatusBadge`. Same
      reason — the tone is computed per call site.
- [ ] **Empty and loading states (§18/§19)** — `EmptyState`, `ErrorState`,
      `Skeleton` exist and are barely adopted. Several lists still render nothing,
      or a bare "Loading…", where a skeleton belongs.
- [ ] **Per-page section-icon colour** — pages give each section its own tinted
      icon tile (orange/purple/green). It reads as deliberate, but no rule governs
      which colour means what.
- [ ] **23 dynamic classNames + 12 hidden/custom-widget controls** the `.ctl` pass
      skipped by design; each needs a human decision.

## Verification
`npx tsc -p apps/web/tsconfig.json --noEmit` after each tier — vitest never
typechecks, so it is not a check here. `npx vite build` as the second gate.

## Excluded on purpose (each has a measured reason in code)
`.tv-*` dark tabular view (operator preference, contrast measured across all 10
presets); `--chart-*` literal fallbacks (the PDF export serialises SVG with no
stylesheet); dashboard panel-card geometry and `rounded-2xl` (tuned with the
operator days ago); `.band-marker`; no dark theme anywhere.
