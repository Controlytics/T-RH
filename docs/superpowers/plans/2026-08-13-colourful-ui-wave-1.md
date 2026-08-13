# Colourful UI — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every page in `apps/web` picks up its module's colour palette on tinted surfaces, with `/instruments` fully hand-tuned as the reviewable proof.

**Architecture:** A route→palette map writes `--mod-*` CSS custom properties on `documentElement`; `app.css` derives surface tokens from them with `color-mix` and redefines the legacy white/slate utilities to resolve to those tokens, so untouched pages recolour without being edited. Shared primitives are rewritten to use the tokens directly.

**Tech Stack:** React 19, Vite 6, Tailwind CSS v4 (`@tailwindcss/vite`), vitest 3 + jsdom, React Router v6.

**Spec:** `docs/superpowers/specs/2026-08-13-colourful-ui-design.md`

## Global Constraints

- Palette `tableHead` MUST be a 700-level colour, never the gradient's `from`. Reusing `from` reintroduces 5 WCAG AA failures (measured 2.94–3.77:1).
- WCAG AA floor: body text on any surface ≥ 4.50:1. White on gradient `to` ≥ 3.00:1 (large text only — 18px+ bold, never body).
- The compatibility layer uses **cascade order, never `!important`.** Proven in wave 0: the override is emitted after Tailwind's own rule at equal specificity and wins. `!important` would beat the inline `style={{ background: themeGradient }}` used on buttons across this app and kill every gradient button.
- `--theme-*` owns chrome (sidebar, login, primary buttons). `--mod-*` owns page (canvas, cards, tables, tiles). Never cross them.
- The layer overrides backgrounds and borders globally. It makes **exactly one text exception, scoped to the canvas** (see below). No other text utility is touched.
- **MEASURED REGRESSION — secondary text must be darkened.** `text-slate-500` (459 uses, incl. `CardDescription`) scores **3.97–4.49:1** on the tinted surfaces, below the 4.50 AA floor. It only passes today because the surface is pure white (4.76:1) — it has almost no headroom and a 6% tint consumes it. `text-slate-400` (279 uses) is worse and already fails on white. `slate-600` (`#475569`) passes everywhere (worst **6.32:1**), so both remap to it.
  **The remap MUST be scoped to `.bg-module-canvas` descendants**, never global: `text-slate-400` is also the sidebar's muted text on a **dark** background, where darkening it makes contrast worse. Two classes beats Tailwind's one on specificity, so no `!important` is needed. This is the same trap as the translucent-white overlays — a global text override looks simpler and is wrong.
- Translucent white utilities (`bg-white/5` `/10` `/15` `/20`, `hover:bg-white/*`, `border-white/*`, `ring-white/*`, `after:bg-white`, `via-white`) are highlights on DARK chrome. Never recolour them.
- Status colour semantics are untouched. Pills become solid-filled; every status keeps glyph + word.
- Do not stage or commit the operator's 5 pre-existing modified files or the untracked `CWH 3RD floor Pantry-DP.pdf`.
- `npx vitest run` never typechecks in this repo — `npx tsc --noEmit -p apps/web/tsconfig.json` is mandatory per task.

## Wave 0 — COMPLETE (findings baked into this plan)

Ran via `@tailwindcss/node`'s programmatic `compile()`. All four mechanics verified:

1. Bare-class override emitted **after** Tailwind's own rule → wins on cascade, no `!important`.
2. Variant override (`.hover\:bg-slate-50:hover`) redefinable the same way.
3. `bg-surface` generates from an `@theme` token whose value contains `var(--mod-from)` written at **runtime by JS**.
4. `bg-surface/50` nests `color-mix` inside `color-mix` and emits an `@supports` oklab fallback. Works.

Two consequences:

- **`bg-white/95`, `/70`, `/60` compile to a literal `#fff`** and are NOT reached by a `.bg-white` override. They need their own explicit rules. Conversely the excluded `/5`–`/20` overlays are safe automatically.
- Tailwind emits a fallback `--color-surface: var(--mod-from);` before the `color-mix` value. Later declaration wins; the token is never undefined.

## File Structure

**Create**
- `apps/web/src/lib/module-palettes.ts` — the 12-entry palette map + `resolveModulePalette(pathname)`. Pure data + one pure function; no React.
- `apps/web/src/lib/__tests__/module-palettes.test.ts` — resolution, longest-prefix, fallback, **and the WCAG contrast assertions**.
- `apps/web/src/lib/contrast.ts` — `contrastRatio(a, b)` + `mixWithWhite(hex, pct)`. Needed by the contrast test; kept as source (not test-only) so any future page can assert against it.
- `apps/web/src/hooks/use-module-palette.ts` — reads location, writes `--mod-*`.
- `apps/web/src/hooks/__tests__/use-module-palette.test.tsx` — asserts the custom properties land.
- `apps/web/src/components/ui/stat-tile.tsx` — the full-colour gradient stat tile.
- `apps/web/src/__tests__/compat-layer.test.ts` — compiles `app.css` through `@tailwindcss/node` and asserts the override is emitted last and carries no `!important`. Guards a Tailwind upgrade silently reversing the cascade.

**Modify**
- `apps/web/src/app.css` — `@theme` surface tokens + the compatibility layer.
- `apps/web/src/components/layout/app-layout.tsx` — mount the hook; replace the `<main>` canvas (line ~172).
- `apps/web/src/components/ui/{card,table,dialog,input,select,searchable-select,badge,button,pagination}.tsx`
- `apps/web/src/components/report-page-wrapper.tsx` — add `.surface-plain`.
- `apps/web/src/routes/instruments/list.tsx` — hand-tuned.
- `CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/web/DECISIONS.md`, `CHANGELOG.md`, `tasks/todo.md`.

---

### Task 1: Palette map + contrast as a test

**Files:**
- Create: `apps/web/src/lib/contrast.ts`
- Create: `apps/web/src/lib/module-palettes.ts`
- Test: `apps/web/src/lib/__tests__/module-palettes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ModulePalette { id, label, from, to, tableHead, text, muted }`; `MODULE_PALETTES: ModulePalette[]`; `FALLBACK_PALETTE: ModulePalette`; `resolveModulePalette(pathname: string): ModulePalette`; and from `contrast.ts`: `contrastRatio(a: string, b: string): number`, `mixWithWhite(hex: string, pct: number): string`.

This task is where the spec's "measured, not eyeballed" promise becomes enforceable. The repo has **zero** tests asserting styling; a contrast test is the one piece of this work a machine can actually verify, so it is written first and it is not optional.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/module-palettes.test.ts
import { describe, it, expect } from 'vitest';
import { MODULE_PALETTES, FALLBACK_PALETTE, resolveModulePalette } from '../module-palettes';
import { contrastRatio, mixWithWhite } from '../contrast';

const SURFACE_PCT = 6;
const SURFACE_ALT_PCT = 12;
const AA_BODY = 4.5;
const AA_LARGE = 3.0;

describe('resolveModulePalette', () => {
  it('matches the longest prefix, not the first', () => {
    // '/config/floorplans' must not fall through to the '/' dashboard entry
    expect(resolveModulePalette('/config/floorplans').id).toBe('config');
    expect(resolveModulePalette('/config').id).toBe('config');
    expect(resolveModulePalette('/instruments/abc-123').id).toBe('instruments');
    expect(resolveModulePalette('/instruments/profiles/x').id).toBe('instruments');
  });

  it('resolves the dashboard for exactly "/"', () => {
    expect(resolveModulePalette('/').id).toBe('dashboard');
  });

  it('falls back to neutral for an unknown route', () => {
    expect(resolveModulePalette('/not-a-real-route').id).toBe(FALLBACK_PALETTE.id);
  });

  it('has no duplicate ids and no duplicate route prefixes', () => {
    const ids = MODULE_PALETTES.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('palette contrast (WCAG AA)', () => {
  it.each(MODULE_PALETTES.map(p => [p.id, p] as const))(
    '%s: body text clears 4.5:1 on both tinted surfaces',
    (_id, p) => {
      const surface = mixWithWhite(p.from, SURFACE_PCT);
      const surfaceAlt = mixWithWhite(p.from, SURFACE_ALT_PCT);
      // slate-800 / slate-500 are what the app actually paints body text with
      for (const fg of [p.text, p.muted, '#1e293b', '#64748b']) {
        expect(contrastRatio(fg, surface)).toBeGreaterThanOrEqual(AA_BODY);
        expect(contrastRatio(fg, surfaceAlt)).toBeGreaterThanOrEqual(AA_BODY);
      }
    },
  );

  it.each(MODULE_PALETTES.map(p => [p.id, p] as const))(
    '%s: white body text clears 4.5:1 on the tableHead band',
    (_id, p) => {
      expect(contrastRatio('#ffffff', p.tableHead)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(MODULE_PALETTES.map(p => [p.id, p] as const))(
    '%s: white large text clears 3:1 on both gradient stops',
    (_id, p) => {
      expect(contrastRatio('#ffffff', p.from)).toBeGreaterThanOrEqual(AA_LARGE);
      expect(contrastRatio('#ffffff', p.to)).toBeGreaterThanOrEqual(AA_LARGE);
    },
  );

  it('tableHead is never the gradient from — that reintroduces 5 AA failures', () => {
    for (const p of MODULE_PALETTES) {
      if (p.id === 'debug' || p.id === 'fallback') continue; // neutral: from is already dark
      expect(p.tableHead).not.toBe(p.from);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `cd apps/web && npx vitest run src/lib/__tests__/module-palettes.test.ts`
Expected: FAIL — cannot resolve `../module-palettes` / `../contrast`.

- [ ] **Step 3: Implement `contrast.ts`**

```ts
// apps/web/src/lib/contrast.ts
/** sRGB relative luminance + WCAG contrast, used to keep module palettes honest. */

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mirrors `color-mix(in srgb, <hex> <pct>%, white)` so tests measure what CSS paints. */
export function mixWithWhite(hex: string, pct: number): string {
  const rgb = toRgb(hex).map(c => Math.round((c * pct) / 100 + 255 * (1 - pct / 100)));
  return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Implement `module-palettes.ts`**

```ts
// apps/web/src/lib/module-palettes.ts
/**
 * Per-module colour palettes — the PAGE half of this app's colour system.
 *
 * DIVISION OF RESPONSIBILITY (do not cross these):
 *   --theme-*  (lib/themes.ts)  owns CHROME: sidebar, login screen, primary buttons.
 *   --mod-*    (this file)      owns PAGE:   canvas, cards, tables, stat tiles, bands.
 * This app already had two overlapping colour systems (THEMES + the Branding
 * config). Adding a third is how that happened; don't.
 *
 * `tableHead` is a 700-level colour and is deliberately NOT `from`. White body
 * text on the 600-level `from` values measures 2.94-3.77:1 — five of these twelve
 * palettes fail WCAG AA that way. module-palettes.test.ts enforces this.
 */

export interface ModulePalette {
  id: string;
  label: string;
  /** Route prefixes owning this palette. Longest match wins. */
  prefixes: string[];
  from: string;      // gradient start, 600-level
  to: string;        // gradient end, 600-level
  tableHead: string; // solid table header band, 700-level
  text: string;      // heading text on tinted surfaces, 950-level
  muted: string;     // secondary heading text, 800-level
}

export const MODULE_PALETTES: ModulePalette[] = [
  { id: 'dashboard',      label: 'Dashboard',      prefixes: ['/'],                 from: '#4f46e5', to: '#7c3aed', tableHead: '#4338ca', text: '#1e1b4b', muted: '#3730a3' },
  { id: 'home',           label: 'Module Guide',   prefixes: ['/home'],             from: '#2563eb', to: '#0284c7', tableHead: '#0369a1', text: '#172554', muted: '#1e40af' },
  { id: 'instruments',    label: 'Instruments',    prefixes: ['/instruments'],      from: '#0891b2', to: '#0d9488', tableHead: '#0f766e', text: '#083344', muted: '#155e75' },
  { id: 'audit',          label: 'Audit Trail',    prefixes: ['/audit'],            from: '#d97706', to: '#ea580c', tableHead: '#b45309', text: '#451a03', muted: '#92400e' },
  { id: 'config',         label: 'Configuration',  prefixes: ['/config'],           from: '#059669', to: '#16a34a', tableHead: '#047857', text: '#022c22', muted: '#065f46' },
  { id: 'users',          label: 'Users',          prefixes: ['/users'],            from: '#db2777', to: '#e11d48', tableHead: '#be185d', text: '#500724', muted: '#9d174d' },
  { id: 'notifications',  label: 'Notifications',  prefixes: ['/notifications'],    from: '#7c3aed', to: '#c026d3', tableHead: '#7e22ce', text: '#2e1065', muted: '#5b21b6' },
  { id: 'admin-requests', label: 'Admin Requests', prefixes: ['/admin-requests'],   from: '#ca8a04', to: '#65a30d', tableHead: '#a16207', text: '#422006', muted: '#854d0e' },
  { id: 'profile',        label: 'Profile',        prefixes: ['/profile'],          from: '#9333ea', to: '#7c3aed', tableHead: '#7e22ce', text: '#3b0764', muted: '#6b21a8' },
  { id: 'system-health',  label: 'System Health',  prefixes: ['/system-health'],    from: '#0d9488', to: '#059669', tableHead: '#0f766e', text: '#042f2e', muted: '#115e59' },
  { id: 'debug',          label: 'Debug Traces',   prefixes: ['/debug'],            from: '#475569', to: '#334155', tableHead: '#334155', text: '#0f172a', muted: '#334155' },
];

export const FALLBACK_PALETTE: ModulePalette = {
  id: 'fallback', label: 'Default', prefixes: [],
  from: '#475569', to: '#334155', tableHead: '#334155', text: '#0f172a', muted: '#334155',
};

/**
 * Longest-prefix match. '/config/floorplans' must resolve to `config`, not fall
 * through to the '/' dashboard entry — hence length-sorted, and '/' only ever
 * matches exactly.
 */
export function resolveModulePalette(pathname: string): ModulePalette {
  if (pathname === '/') return MODULE_PALETTES[0];
  const candidates = MODULE_PALETTES
    .flatMap(p => p.prefixes.filter(pre => pre !== '/').map(pre => ({ p, pre })))
    .filter(({ pre }) => pathname === pre || pathname.startsWith(pre + '/'))
    .sort((a, b) => b.pre.length - a.pre.length);
  return candidates[0]?.p ?? FALLBACK_PALETTE;
}
```

- [ ] **Step 5: Run the test — all must pass**

Run: `cd apps/web && npx vitest run src/lib/__tests__/module-palettes.test.ts`
Expected: PASS. If any contrast case fails, **adjust the palette, not the threshold.**

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/contrast.ts apps/web/src/lib/module-palettes.ts \
        apps/web/src/lib/__tests__/module-palettes.test.ts
git commit -m "feat(web): add per-module palettes with contrast enforced by test"
```

---

### Task 2: The hook that writes `--mod-*`

**Files:**
- Create: `apps/web/src/hooks/use-module-palette.ts`
- Test: `apps/web/src/hooks/__tests__/use-module-palette.test.tsx`

**Interfaces:**
- Consumes: `resolveModulePalette`, `ModulePalette` from Task 1.
- Produces: `useModulePalette(): ModulePalette` — writes `--mod-id`, `--mod-from`, `--mod-to`, `--mod-table-head`, `--mod-text`, `--mod-muted` onto `document.documentElement` and returns the active palette.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/hooks/__tests__/use-module-palette.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useModulePalette } from '../use-module-palette';

function Probe() {
  useModulePalette();
  return null;
}

const varsOf = () => {
  const s = document.documentElement.style;
  return {
    id: s.getPropertyValue('--mod-id'),
    from: s.getPropertyValue('--mod-from'),
    head: s.getPropertyValue('--mod-table-head'),
  };
};

afterEach(cleanup);

describe('useModulePalette', () => {
  it('writes the instruments palette for an instruments route', () => {
    render(<MemoryRouter initialEntries={['/instruments']}><Probe /></MemoryRouter>);
    expect(varsOf()).toEqual({ id: 'instruments', from: '#0891b2', head: '#0f766e' });
  });

  it('writes the config palette for a nested config route', () => {
    render(<MemoryRouter initialEntries={['/config/floorplans']}><Probe /></MemoryRouter>);
    expect(varsOf().id).toBe('config');
  });

  it('writes the neutral fallback for an unknown route', () => {
    render(<MemoryRouter initialEntries={['/nope']}><Probe /></MemoryRouter>);
    expect(varsOf().id).toBe('fallback');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && npx vitest run src/hooks/__tests__/use-module-palette.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/hooks/use-module-palette.ts
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveModulePalette, type ModulePalette } from '@/lib/module-palettes';

/**
 * Writes the active module's palette to CSS custom properties on :root, the same
 * way applyTheme() does for --theme-*. Because it is variables and not classes,
 * navigating recolours the whole page without re-rendering page content.
 *
 * Mount ONCE, in AppLayout.
 */
export function useModulePalette(): ModulePalette {
  const { pathname } = useLocation();
  const palette = resolveModulePalette(pathname);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mod-id', palette.id);
    root.style.setProperty('--mod-from', palette.from);
    root.style.setProperty('--mod-to', palette.to);
    root.style.setProperty('--mod-table-head', palette.tableHead);
    root.style.setProperty('--mod-text', palette.text);
    root.style.setProperty('--mod-muted', palette.muted);
  }, [palette]);

  return palette;
}
```

- [ ] **Step 4: Run — PASS**

Run: `cd apps/web && npx vitest run src/hooks/__tests__/use-module-palette.test.tsx`

- [ ] **Step 5: Typecheck, then commit**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
cd ../.. && git add apps/web/src/hooks/use-module-palette.ts apps/web/src/hooks/__tests__/use-module-palette.test.tsx
git commit -m "feat(web): write module palette to CSS custom properties per route"
```

---

### Task 3: Surface tokens + the compatibility layer

**Files:**
- Modify: `apps/web/src/app.css`
- Test: `apps/web/src/__tests__/compat-layer.test.ts`

**Interfaces:**
- Consumes: `--mod-from` / `--mod-to` (Task 2).
- Produces: utilities `bg-surface`, `bg-surface-alt`, `border-border-tint`; tokens `--color-surface`, `--color-surface-alt`, `--color-border-tint`; class `.surface-plain`.

The enumeration below is the **complete** include list, derived from the codebase — not sampled. Re-run the grep in the spec if files have been added since.

- [ ] **Step 1: Write the failing regression test**

Guards the two things wave 0 established, so a Tailwind upgrade can't silently reverse them.

```ts
// apps/web/src/__tests__/compat-layer.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from '@tailwindcss/node';

const CSS_PATH = resolve(__dirname, '../app.css');

async function build(candidates: string[]) {
  const css = readFileSync(CSS_PATH, 'utf8');
  const compiler = await compile(css, { base: resolve(__dirname, '..'), onDependency() {} });
  return compiler.build(candidates);
}

describe('compatibility layer', () => {
  it('emits the bg-white override AFTER tailwind\'s own rule so cascade order wins', async () => {
    const out = await build(['bg-white']);
    const tw = out.indexOf('var(--color-white)');
    const own = out.lastIndexOf('var(--color-surface)');
    expect(tw).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(tw);
  });

  it('never uses !important — that would beat inline style={{background}} on buttons', async () => {
    const out = await build(['bg-white', 'bg-slate-50', 'hover:bg-slate-50', 'border-slate-200']);
    expect(out).not.toMatch(/--color-surface[^;]*!important/);
    expect(out).not.toMatch(/--color-border-tint[^;]*!important/);
  });

  it('overrides the hover variant, or un-tuned tinted rows flash white on hover', async () => {
    const out = await build(['hover:bg-slate-50', 'hover:bg-slate-100']);
    expect(out).toMatch(/\.hover\\:bg-slate-50:hover\s*\{[^}]*--color-surface-alt/);
    expect(out).toMatch(/\.hover\\:bg-slate-100:hover\s*\{[^}]*--color-surface-alt/);
  });

  it('leaves translucent white overlays alone — they sit on the dark sidebar', async () => {
    const out = await build(['bg-white/10', 'bg-white/20', 'border-white/20']);
    expect(out).not.toMatch(/\.bg-white\\\/10\s*\{[^}]*--color-surface/);
    expect(out).not.toMatch(/\.bg-white\\\/20\s*\{[^}]*--color-surface/);
    expect(out).not.toMatch(/\.border-white\\\/20\s*\{[^}]*--color-border-tint/);
  });

  it('generates bg-surface from the theme token', async () => {
    const out = await build(['bg-surface', 'bg-surface-alt']);
    expect(out).toMatch(/\.bg-surface\s*\{[^}]*var\(--color-surface\)/);
    expect(out).toMatch(/\.bg-surface-alt\s*\{[^}]*var\(--color-surface-alt\)/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/web && npx vitest run src/__tests__/compat-layer.test.ts`
Expected: FAIL — no `--color-surface` in `app.css` yet.

- [ ] **Step 3: Add tokens to the existing `@theme` block in `app.css`**

```css
  /* Module-scoped surfaces — derived from --mod-from, which use-module-palette
     writes at runtime. Defined ONCE here so 12 palettes x 4 surfaces are not 48
     hand-picked values. */
  --color-surface: color-mix(in srgb, var(--mod-from) 6%, white);
  --color-surface-alt: color-mix(in srgb, var(--mod-from) 12%, white);
  --color-surface-raised: #ffffff;
  --color-border-tint: color-mix(in srgb, var(--mod-from) 25%, white);
```

- [ ] **Step 4: Append the compatibility layer at the END of `app.css`**

Position matters — it must come after `@import "tailwindcss"` to win on cascade.

```css
/* ===========================================================================
   COMPATIBILITY LAYER — READ THIS BEFORE EDITING A COMPONENT'S bg-white
   ---------------------------------------------------------------------------
   `bg-white` in this app NO LONGER PAINTS WHITE. It resolves to --color-surface,
   a 6% tint of the current module's colour (see lib/module-palettes.ts).
   This exists so ~57 route files became colourful without being edited blind by
   an implementer who cannot open the authenticated UI in a browser.

   Need real white? Add `surface-plain`.

   NO `!important` ANYWHERE IN THIS BLOCK. These rules win by cascade order
   alone (verified: __tests__/compat-layer.test.ts). Adding !important would
   beat the inline style={{ background: themeGradient }} this app puts on
   buttons and would kill every gradient button.

   This layer is intended to SHRINK: each wave replaces bg-white with bg-surface
   in the files it touches. It is not a permanent fixture.
   =========================================================================== */
@layer utilities {
  /* --- card surfaces --------------------------------------------------- */
  .bg-white { background-color: var(--color-surface); }
  .bg-white\/95 { background-color: color-mix(in srgb, var(--color-surface) 95%, transparent); }
  .bg-white\/70 { background-color: color-mix(in srgb, var(--color-surface) 70%, transparent); }
  .bg-white\/60 { background-color: color-mix(in srgb, var(--color-surface) 60%, transparent); }

  /* --- section surfaces ------------------------------------------------ */
  .bg-slate-50, .bg-slate-100 { background-color: var(--color-surface-alt); }
  .bg-slate-50\/80 { background-color: color-mix(in srgb, var(--color-surface-alt) 80%, transparent); }
  .bg-slate-50\/60 { background-color: color-mix(in srgb, var(--color-surface-alt) 60%, transparent); }
  .bg-slate-50\/50 { background-color: color-mix(in srgb, var(--color-surface-alt) 50%, transparent); }
  .bg-slate-50\/30 { background-color: color-mix(in srgb, var(--color-surface-alt) 30%, transparent); }

  /* --- heavier fills --------------------------------------------------- */
  .bg-slate-200 { background-color: var(--color-border-tint); }
  .bg-slate-200\/30 { background-color: color-mix(in srgb, var(--color-border-tint) 30%, transparent); }

  /* --- HOVER STATES: omitting these makes tinted rows flash white ------- */
  .hover\:bg-slate-50:hover,
  .hover\:bg-slate-100:hover { background-color: var(--color-surface-alt); }
  .hover\:bg-slate-50\/80:hover { background-color: color-mix(in srgb, var(--color-surface-alt) 80%, transparent); }
  .hover\:bg-slate-50\/70:hover { background-color: color-mix(in srgb, var(--color-surface-alt) 70%, transparent); }
  .hover\:bg-slate-50\/50:hover { background-color: color-mix(in srgb, var(--color-surface-alt) 50%, transparent); }
  .hover\:bg-slate-50\/40:hover { background-color: color-mix(in srgb, var(--color-surface-alt) 40%, transparent); }
  .hover\:bg-slate-200:hover { background-color: var(--color-border-tint); }
  .hover\:bg-slate-200\/70:hover { background-color: color-mix(in srgb, var(--color-border-tint) 70%, transparent); }
  .group:hover .group-hover\:bg-slate-200 { background-color: var(--color-border-tint); }

  /* --- other states ---------------------------------------------------- */
  .focus\:bg-white:focus { background-color: var(--color-surface); }
  .disabled\:bg-slate-50:disabled { background-color: var(--color-surface-alt); }
  .disabled\:bg-slate-100:disabled { background-color: var(--color-surface-alt); }

  /* --- borders + dividers ---------------------------------------------- */
  .border-slate-50,
  .border-slate-100,
  .border-slate-200 { border-color: var(--color-border-tint); }
  .border-slate-200\/60 { border-color: color-mix(in srgb, var(--color-border-tint) 60%, transparent); }
  .border-slate-200\/50 { border-color: color-mix(in srgb, var(--color-border-tint) 50%, transparent); }
  .divide-slate-100 > :not([hidden]) ~ :not([hidden]),
  .divide-slate-200 > :not([hidden]) ~ :not([hidden]) { border-color: var(--color-border-tint); }
  .ring-slate-200 { --tw-ring-color: var(--color-border-tint); }

  /* NOT overridden, deliberately: bg-white/5 /10 /15 /20, hover:bg-white/*,
     border-white*, ring-white*, after:bg-white, peer-checked:after:border-white,
     via-white. Those are highlights on the DARK sidebar and login screens, which
     --theme-* owns. Recolouring them damages the chrome.
     Also NOT overridden: gradient stops (from-/to-/via-slate-*, from-/to-white,
     ~85 uses). Whether a stop should tint depends on that gradient's intent, so
     they are handled per file as the waves reach them. */
}

/* The documented opt-out. Restores true white where white is required:
   PDF-facing report chrome, the login card, toasts. */
.surface-plain,
.surface-plain.bg-white { background-color: #ffffff; }
```

- [ ] **Step 5: Run the regression test — all 5 cases PASS**

Run: `cd apps/web && npx vitest run src/__tests__/compat-layer.test.ts`

- [ ] **Step 6: Build, to prove the CSS compiles in the real pipeline**

Run: `cd apps/web && npx vite build`
Expected: success. A malformed escaped selector fails here, not in the unit test.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app.css apps/web/src/__tests__/compat-layer.test.ts
git commit -m "feat(web): derive module surface tokens and redefine legacy white/slate utilities"
```

---

### Task 4: Mount the hook and recolour the page canvas

**Files:**
- Modify: `apps/web/src/components/layout/app-layout.tsx` (mount hook; `<main>` at ~line 172)
- Modify: `apps/web/src/components/report-page-wrapper.tsx` (add `surface-plain`)

**Interfaces:**
- Consumes: `useModulePalette()` (Task 2), `--color-surface` etc. (Task 3).
- Produces: `--mod-*` present on every authenticated page; the canvas gradient.

- [ ] **Step 1: Mount the hook**

In `AppLayout()`, immediately after `useDragScroll();`:

```tsx
  useModulePalette(); // writes --mod-* for the current route; see lib/module-palettes.ts
```

with `import { useModulePalette } from '@/hooks/use-module-palette';` at the top.

**Placement matters:** it must sit above the early returns for `isLoading`, `!isAuthenticated`, `forcePasswordChange` and `isDuplicateTab`, or the hook runs conditionally and React throws.

- [ ] **Step 2: Replace the canvas**

On `<main>`, replace `bg-gradient-to-br from-slate-50 to-slate-100/50` with `bg-module-canvas`, and add to `app.css` (outside the utilities layer):

```css
/* Page canvas. 18/14/10% against the 6% card surface keeps ~8-12% separation so
   cards still read as raised. Past ~20% they stop separating and need more
   shadow — that separation is the constraint, not these exact numbers. */
.bg-module-canvas {
  background:
    linear-gradient(140deg,
      color-mix(in srgb, var(--mod-from) 18%, white) 0%,
      color-mix(in srgb, var(--mod-to) 14%, white) 55%,
      color-mix(in srgb, var(--mod-from) 10%, white) 100%);
}
```

- [ ] **Step 3: Protect PDF-facing chrome**

In `report-page-wrapper.tsx`, add `surface-plain` to the outermost printed container so exported and printed report chrome stays white.

- [ ] **Step 4: Verify**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build && npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/app-layout.tsx apps/web/src/components/report-page-wrapper.tsx apps/web/src/app.css
git commit -m "feat(web): apply module palette to the page canvas"
```

---

### Task 5: Primitives

**Files:**
- Create: `apps/web/src/components/ui/stat-tile.tsx`
- Modify: `apps/web/src/components/ui/{card,table,badge,input,select,searchable-select,dialog,pagination}.tsx`

**Interfaces:**
- Produces: `<StatTile label value tone? icon? />` where `tone?: 'module' | 'positive' | 'warning' | 'danger'`, default `'module'`.

- [ ] **Step 1: StatTile**

```tsx
// apps/web/src/components/ui/stat-tile.tsx
import { cn } from '@/lib/cn';

const TONES = {
  module:   'from-[var(--mod-from)] to-[var(--mod-to)]',
  positive: 'from-emerald-600 to-teal-600',
  warning:  'from-amber-600 to-orange-600',
  danger:   'from-rose-600 to-red-600',
} as const;

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  tone?: keyof typeof TONES;
  icon?: React.ReactNode;
}

/** Full-colour gradient stat tile. White text on a 600-level gradient: the value
 *  is large + bold (clears the 3:1 large-text floor) and the label is uppercase
 *  tracking-wide at 90% opacity. Never put body-size prose on this surface. */
export function StatTile({ label, value, tone = 'module', icon, className, ...rest }: StatTileProps) {
  return (
    <div
      className={cn('rounded-2xl p-4 bg-gradient-to-br text-white shadow-lg', TONES[tone], className)}
      {...rest}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-3xl font-bold leading-none font-mono-tab">{value}</div>
        {icon ? <div className="opacity-80">{icon}</div> : null}
      </div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider opacity-90">{label}</div>
    </div>
  );
}
```

- [ ] **Step 2: Card** — `bg-white` becomes `bg-surface`, `border-slate-200/60` becomes `border-border-tint`; add an optional `banded` prop rendering a `--mod-from` to `--mod-to` gradient header strip.

- [ ] **Step 3: Table** — header row `bg-[var(--mod-table-head)] text-white`; body rows alternate `bg-surface` / `bg-surface-alt`; row hover `hover:bg-surface-alt`; dividers `border-border-tint`.

- [ ] **Step 4: Badge** — status variants become solid-filled (700-level background, white text) so they read against a tinted row. Keep every existing variant name so no caller changes.

- [ ] **Step 5: Input / Select / SearchableSelect** — field background `bg-surface-raised` (true white, so a field still reads as enterable against a tinted card), border `border-border-tint`, focus ring stays `--theme-focus-ring` because focus is chrome.

- [ ] **Step 6: Dialog / Pagination** — dialog panel `bg-surface` with its gradient header retained; pagination active page uses `--mod-from`.

- [ ] **Step 7: Verify + commit**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build && npx vitest run
cd ../.. && git add apps/web/src/components/ui
git commit -m "feat(web): recolour shared primitives from the module palette"
```

---

### Task 6: Hand-tune /instruments — the review gate

**Files:** Modify `apps/web/src/routes/instruments/list.tsx`

- [ ] **Step 1** Replace the hand-rolled stat cards with `<StatTile>`: registered (`module`), online (`positive`), out-of-spec (`danger`).
- [ ] **Step 2** Page header: gradient icon chip (`--mod-from` to `--mod-to`), title `text-[var(--mod-text)]`, subtitle `text-[var(--mod-muted)]`.
- [ ] **Step 3** Wrap the table in a `banded` Card; migrate the hand-rolled table to the Table primitive if it is a plain table, otherwise apply the same classes inline.
- [ ] **Step 4** Out-of-limit rows get an inset left bar plus the solid pill, so colour is never the only signal.
- [ ] **Step 5** Replace every remaining literal `bg-white` / `bg-slate-50` / `border-slate-200` in this file with `bg-surface` / `bg-surface-alt` / `border-border-tint`, so the compatibility layer is not load-bearing for a hand-tuned page.
- [ ] **Step 6** Verify + commit.

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build && npx vitest run
cd ../.. && git add apps/web/src/routes/instruments/list.tsx
git commit -m "feat(web): hand-tune the Instruments list for the module palette"
```

---

### Task 7: Docs

**Files:** `CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/web/DECISIONS.md`, `CHANGELOG.md`, `tasks/todo.md`

- [ ] **Step 1** Root `CLAUDE.md` — replace the "Light theme only" rule; add the chrome-vs-page division.
- [ ] **Step 2** `apps/web/CLAUDE.md` — correct the Theme section's "Unified light theme: bg-white cards"; keep "No dark theme anywhere", which is still true.
- [ ] **Step 3** `apps/web/DECISIONS.md` — record the compatibility layer: what it overrides, why (57 blind edits avoided), the no-important constraint and the inline-style reason behind it, and `.surface-plain`.
- [ ] **Step 4** `CHANGELOG.md` plus a `tasks/todo.md` wave checklist.
- [ ] **Step 5** Commit.

---

### Task 0 — run FIRST: record the real test baseline

The spec's figure of 5 web failures comes from prior session notes, not from a run.

- [ ] `cd apps/web && npx vitest run` — record passed/failed BEFORE any edit. That observed number is the ratchet for every later task. Ratchet down only, never up.

---

## Self-Review

**Spec coverage.** Palette layer to Task 1. Tokens to Task 3 Step 3. Compatibility layer with the enumerated include, exclude and defer lists to Task 3 Step 4. Canvas to Task 4 Step 2. Primitives and StatTile to Task 5. The two-system division to Task 1's file header plus Task 7 Step 1. Status semantics untouched to Task 5 Step 4 and Task 6 Step 4. The contrast table becomes Task 1's test. Wave 0 is complete with its findings in the header. Verification is per-task plus Task 0. Docs to Task 7. Out-of-scope items appear in no task, as intended.

**Placeholders.** None. Task 5 Steps 2 to 6 describe class-level swaps rather than whole file bodies; acceptable because each names the exact file, the exact utilities and the exact replacement token, and those files are 20 to 45 lines each.

**Type consistency.** `ModulePalette` fields (`id`, `label`, `prefixes`, `from`, `to`, `tableHead`, `text`, `muted`) are used identically in Tasks 1, 2 and 5. `resolveModulePalette` and `useModulePalette` signatures match between definition and consumer. Custom property names match across Task 2's `setProperty` calls, Task 3's `color-mix` references and Task 5's arbitrary-value classes: `--mod-from`, `--mod-to`, `--mod-table-head`, `--mod-text`, `--mod-muted`. Token names match between Task 3 and the utilities used in Tasks 4 to 6.

**One gap found and closed.** The plan had no step establishing the test baseline before edits began, so "ratchet down only" had nothing to ratchet against. Added as Task 0, ordered first.
