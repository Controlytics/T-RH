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

## Tier 3 — the real CRUD config pages
- [ ] alarm-rules, alarm-webhooks, floorplans, role-access, ldap,
      instrument-attributes, notification-rules, notification-settings, backup,
      branding, audit-templates, access-matrix, action-reauth, export-options,
      field-ids, help, pagination, password-policy, report-page-titles, user-id,
      datetime, display-settings, appearance

## Tier 4 — the wider route tree
- [ ] auth (login / forgot-password / contact-admin), users, instruments,
      alarms, audit, notifications, admin-requests, functional-locations,
      system-health, profile, home, debug

## Verification
`npx tsc -p apps/web/tsconfig.json --noEmit` after each tier — vitest never
typechecks, so it is not a check here. `npx vite build` as the second gate.

## Excluded on purpose (each has a measured reason in code)
`.tv-*` dark tabular view (operator preference, contrast measured across all 10
presets); `--chart-*` literal fallbacks (the PDF export serialises SVG with no
stylesheet); dashboard panel-card geometry and `rounded-2xl` (tuned with the
operator days ago); `.band-marker`; no dark theme anywhere.
