# UI design system v3 — every screen rebuilt on one vocabulary

**Date:** 2026-09-21
**Status:** approved in chat, spec written for review
**Operator request:** *"as a senior most experienced developer and as a best
ui screen designer/developer update all the screens ui more professionally
and best ui screens"*. Asked how, they chose **"New design system, then every
screen"**; asked which direction, **"Your mockups' language"** — `Alarms.png`,
`screen-2.png`, `cc-dashboard.png` at the repo root.

## 1. Why

Measured on the tree, 2026-09-21:

| Fact | Number |
|---|---|
| `<Route>`s in `main.tsx` | 52 |
| Screens already on the house hero style (`PageHeader inverted` / `themeGradient`) | ~10 |
| Screens on the plain grey `PageHeader` | ~30 |
| Page-level screens with no shared header at all (auth, dashboard, instruments, users/edit, profile, several config pages) | ~12 |
| Route files that hand-roll a `<table>` | 19 |
| Route files that use the shared `Table` | 8 |
| Test files under `routes/**/__tests__` | 43 |

The product reads as two generations side by side: the Stage 2 foundation
(restrained tokens, grey header) under most screens, and the hero-band style
the operator approved on Settings and Functional Locations on a few. The
operator's three mockups all speak one language — theme-gradient hero bands,
stat cards with icon medallions on tinted grounds, saturated column headers,
big tabular figures, a dark sidebar — and that language is the target.

## 2. Approach: primitive-first

Build a small set of primitives once; rebuild every screen on them in four
batches. Consistency comes from construction. Rejected: screen-by-screen
restyling in place (52 screens diverge again — it is how the tree got here)
and adopting a component library (new dependencies this repo has avoided;
the ten colour presets would need rewiring).

## 3. Foundation

### 3.1 Tokens (`apps/web/src/app.css`, `@theme`)

Kept unchanged: the type scale, the 4px spacing steps, the three radii, the
two control heights, the three elevations, the five status ink/ground/dot
triples, the `--chart-*` series colours. **Status colours are never touched:
they carry data.**

Added:

| Token | Value | Use |
|---|---|---|
| `--text-figure` / `--text-figure--line-height` | 2rem / 2.25rem, `font-variant-numeric: tabular-nums` | the one number on a StatCard |
| `--text-figure-lg` | 2.5rem | hero figure tiles |
| `--surface-tint-1` | `color-mix(in srgb, var(--theme-primary) 6%, white)` | tinted card ground |
| `--surface-tint-2` | `color-mix(in srgb, var(--theme-primary) 12%, white)` | hover / selected ground |
| `--band-gradient` | `linear-gradient(90deg, var(--theme-gradient-from), var(--theme-gradient-to))` | table header band, hero band, plate |

Everything derives from the theme variables `use-branding` already sets, so
all ten presets work with no per-preset edit. Two quantity hues stay where
they are (`.tv-h-temp` burnt orange, `.tv-h-rh` green): they are identity
shared with the charts and the PDF.

All shared classes stay in `@layer components` (an unlayered rule beats every
utility — recorded in `apps/web/CLAUDE.md`).

### 3.2 Primitives (`apps/web/src/components/ui/`)

Each is one file, one purpose, tested by a render test in
`components/ui/__tests__/`.

**`PageHero`** — the gradient band every screen starts with.
Props: `title`, `icon`, `crumbs`, `actions?`, `tiles?: {label, value, hint?}[]`,
`children?` (a toolbar row that sits INSIDE the band, e.g. the Settings
picker). Renders `PageHeader inverted` on `--band-gradient` with the soft
circle motif from `cc-dashboard.png`; tiles are `bg-white/12` with
`--text-figure-lg`. `description` is dropped from every call site (no prose
rule); the `PageHeader` prop stays for the two places it is load-bearing.

**`StatCard`** — `{eyebrow, value, icon, tone?: StatusTone | 'neutral',
to?: string}`. Medallion (gradient circle, 48px) top-right, eyebrow
(`--text-eyebrow`), ONE figure (`--text-figure`), optional "View details"
link. Tinted ground: `--surface-tint-1` for neutral, the status `-bg` for a
tone, with a 3px top rail in the tone's `-dot`. **No sparkline, no "from
yesterday"** — nothing stores alarm-state history; the Alarms rebuild
already recorded this departure from the mockup.

**`DataTable`** — the shared table rebuilt. `Table`/`TableHeader`/… keep
their names and props; added: `band?: 'gradient' | 'neutral'` (default
gradient — white uppercase heads on `--band-gradient`), `ColumnGroup`
(`{label, hue?: 'temp' | 'rh' | 'theme', span}` — the two-row grouped header
of `screen-2.png`), `Th sortable` with the sort glyph, `TableRow accent?:
StatusTone` (the 3px left rail of `Alarms.png`), sticky `<thead>`, `TableEmpty`
(wraps `EmptyState`), `TableFooter` holding `<Pagination>`. Zebra off; hover
`--surface-tint-1`. **The 19 hand-rolled tables migrate onto it**, including
the trend page's raw-readings card, which was deliberately its own style and
now joins the system; its `pillTone()` rule and `ROW_ACCENT` class vocabulary
are unchanged, only where they render.

**`FormSection`** — `{title, icon?, actions?, columns?: 1 | 2, children}`.
A card whose header is a gradient plate (title + icon, white ink, no
description), body a `grid md:grid-cols-2 gap-4` of `FormField`s. Every
config, create and edit form is composed of these.

**`DialogBanner`** — moved from `routes/functional-locations/` to `ui/`
unchanged (`-mx-6 -mt-6` full-bleed inside `Dialog`'s `p-6`). Every dialog
gets one: title, icon, tone (`danger` for destructive).

**`Toolbar`** — `{search: {name, value, onChange, placeholder}, filters?:
ReactNode, trailing?: ReactNode}`. Rounded card, search left, filters middle,
actions right; `flex-nowrap` on wide, wraps under `md`. Replaces the three
hand-built rows (Alarms, dashboard readings, the alarm widgets' filter bar
stays a separate component but restyles on the same tokens).

Unchanged APIs, restyled tokens only: `Button` (primary = `--band-gradient`
with the existing `themeButton` shadow; secondary = white with hairline),
`Input`/`Select`/`.ctl` (40px, hairline, focus ring `--theme-primary`),
`Toggle` (green/red, kept), `Badge`/`StatusBadge` (kept), `Tabs` (underline
in `--theme-primary`), `Pagination` (kept), `EmptyState`, `Skeleton`,
`Toast`, `ConfirmDialog`/`MessageDialog` (gain `DialogBanner`).

### 3.3 Shell

- **Sidebar**: dark theme gradient kept. `MENU` eyebrow above the list;
  active item a white pill with `--theme-primary` ink and a right dot
  (`cc-dashboard.png`); inactive `text-white/80`, hover `bg-white/10`;
  collapsed rail 64px with `title` tooltips; brand block (logo + `appName`)
  at top; company block (Branding `companyName` + tagline) at bottom.
  Item list and ordering logic untouched.
- **Header**: white, 64px, `--elev-1`; left: menu toggle + AWS chip
  (operator-requested, stays); right: bell with count, avatar menu.
  Breadcrumbs move into `PageHero`.
- **Login / forgot / change-password / contact-admin**: full-bleed
  `--band-gradient` with two soft circles, centred `max-w-md` card, logo,
  fields, one primary button. The session-conflict and system-session
  dialogs gain `DialogBanner`. No prose beyond labels.

## 4. Screens — batches and what each becomes

Every batch is pushed and left for the operator to look at before the next
begins; a tail of one-line corrections after each is expected and is folded
in before moving on.

**Batch 1 — foundation, shell, auth.** Tokens, six primitives + tests,
sidebar, header, the four auth pages.

**Batch 2 — the monitoring screens.**
| Screen | Becomes |
|---|---|
| Dashboard | PageHero with welcome + role/date tiles (`cc-dashboard.png`), StatCards row, panel grid unchanged underneath; readings table → DataTable with `temp`/`rh` column groups (`screen-2.png`) |
| Alarms | PageHero; four StatCards by quadrant tone; Toolbar; DataTable with accent rails (`Alarms.png`) |
| Instruments list | PageHero + tiles; Toolbar; DataTable |
| Instrument detail | PageHero (code, status tile); FormSections for Details / Connection / Token; Attributes panel card restyled |
| Instrument trend | PageHero with period row inside the band; cards unchanged in content, restyled plates; raw table → DataTable |
| Data Report | PageHero; Generate card = hero tile; widget table → DataTable |
| Settings | PageHero with the picker inside the band; tiles unchanged |
| Functional Locations (index, detail) | already on the language; re-cut onto PageHero/StatCard so they stop carrying private copies |

**Batch 3 — people and records.** Users list/create/edit/reset-requests,
Admin Requests, Notifications, Audit Trail (table → DataTable; export menu in
Toolbar trailing), Reports (three tabs, DataTable), Profile.

**Batch 4 — configuration and system.** Configuration index (card grid on
tinted grounds with medallions), the 23 pages under `routes/config/` and
`dynamic-config.tsx` (every form → FormSections), Roles & Access (tabs +
FormSections), Floorplans editor (canvas untouched, chrome restyled), Alarm
Webhooks, System Health (StatCards), Debug traces, Help.

## 5. Rules held throughout

- One number per element. No helper prose; labels only. Units in headers,
  never in cells. Toggles green/red. Status colour never travels alone.
- No new dependencies. Light theme only. The ten presets must all render.
- PDF exports untouched (`lib/pdf-report.ts`, `chart-image.ts`, report
  layouts) — a signed record does not follow a restyle.
- **No API change and no behaviour change.** A rebuilt screen sends and
  receives exactly what it did; fetch keys, mutations, re-auth, audit, and
  permission gates (`useCan`, `RequireRole`) are moved, not altered.
- Every `data-testid`, `aria-label` and accessible name that a test relies on
  is preserved unless the control itself changed; tests are updated for
  markup only, never for behaviour.

## 6. Verification, per batch

1. `npm run build -w @digilog/shared` if shared changed (it should not).
2. `tsc --noEmit` for `apps/web` (and `apps/api` if touched — it should not).
3. `npx vite build`.
4. Every touched test file run INDIVIDUALLY by exit code (the whole
   `apps/web` suite manufactures failures on this tree — recorded in memory).
5. A render test per new primitive; every rebuilt page keeps its existing
   render test green.
6. Contrast: ink over `--surface-tint-1/2` and white over `--band-gradient`
   checked for WCAG AA on the default preset and the two darkest presets
   (Midnight, Slate) with a small script over `themes.ts`.
7. Not seen on screen — the operator holds the browser session. Each batch's
   summary names the two or three things that need their eye.

## 7. Out of scope

New features, new API fields, dark theme, mobile-first layouts beyond what
the current responsive breakpoints give, the PWA manifest, the PDF documents.

## 8. Restore point

The commit before Batch 1 lands; each batch is its own commit series on
`data-layer` so a batch can be reverted alone.
