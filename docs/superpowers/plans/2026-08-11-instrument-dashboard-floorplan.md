# Instrument Dashboard — Table + Floorplan Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two dashboard views over existing instrument telemetry — a table of every instrument's current temperature and RH, and a clickable floorplan where instrument-bearing rooms are coloured by spec compliance and drill into live per-room time-series.

**Architecture:** One new fleet-wide read endpoint feeds both views, so they can never disagree. Rooms become real records (`Floorplan` → `FloorplanRoom` → `Instrument.roomId`) placed by hand in an in-app editor over an uploaded plan image, with normalized 0–1 coordinates. Spec limits move from free-text instrument attributes onto the room. "Live" is SWR polling — this repo has no browser-facing push channel.

**Tech Stack:** Fastify + Prisma + PostgreSQL (partitioned telemetry history, raw SQL), React 19 + Vite + SWR + Tailwind, vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md`

## Global Constraints

- **No new runtime dependencies.** Charts are hand-rolled SVG. This repo has deliberately removed every chart/canvas library it ever carried (`chartjs-node-canvas`, `reactflow`, `@monaco-editor/react`).
- **No new permission constants.** Reads gate on `INSTRUMENT_READ`, writes on `CONFIG_UPDATE`. Both exist in `packages/shared/src/types/permissions.ts`.
- **Migrations are hand-authored.** `prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN. Draft with `prisma migrate diff`, hand-author into `prisma/migrations/<UTC>_<name>/migration.sql`, and `npm run db:verify-migrations` must PASS before commit. See `apps/api/CLAUDE.md` § "Database Migrations".
- **Telemetry reads/writes stay unaudited** (spec D5 — process data, not a §11 record). Do NOT add `auditLog()` to `telemetry.repository.ts` or to any read endpoint in this plan. Floorplan and room writes **are** audited.
- **API tests run single-fork:** `cd apps/api && npm test`. Any new e2e file provisions its own unique SUPER_ADMIN in `beforeAll` — never share the `admin` user.
- **Light theme only.** `bg-white`, `bg-slate-50`, `border-slate-200`. Colours come from theme CSS custom properties (`var(--theme-primary)` etc.) where the design is not semantic. Status colours ARE semantic and use fixed Tailwind emerald/amber/red/slate.
- **Route prefix:** `/api/dashboards` (plural) is already taken by the widget-dashboard module. Do not create `/api/dashboard`. New endpoints live under `/api/instruments` and `/api/floorplans`.
- **Normalized coordinates** are floats in `[0,1]`, never pixels.
- **`InstrumentStatus` precedence** (first match wins, also defines "worst"): `OUT_OF_SPEC` > `STALE` > `NO_DATA` > `PARTIAL` > `OK`.
- **Every user-visible count claim in docs must be re-verified by `grep`/`ls`** at the moment the doc is touched (root `CLAUDE.md` § Documentation Sync Rule).

---

## File Structure

**`packages/shared/src/types/`**
- `telemetry-slots.ts` (create) — the semantic-slot vocabulary: alias parsing, slot resolution, `InstrumentStatus`, status computation, worst-of. Pure, no I/O. Both API and web import it, which is why it lives here.
- `telemetry-slots.test.ts` (create) — table-driven tests for the above.
- `audit-actions.ts` (modify) — 6 new actions.
- `audit-templates.ts` (modify) — templates for those 6, under the existing `Instruments` category.
- `reauth-actions.ts` (modify) — 2 new actions.

**`apps/api/src/modules/config/defs/`**
- `telemetry-slots.def.ts` (create) — alias lists, display precision, poll intervals.

**`apps/api/src/modules/instruments/`**
- `telemetry-overview.ts` (create) — the fleet-wide query + row assembly. Separate file so `routes.ts` (already 1705 lines) does not grow a fourth responsibility.
- `routes.ts` (modify) — mount `GET /telemetry-overview`; add `from`/`to` to `GET /:id/telemetry`.

**`apps/api/src/modules/floorplans/`** (create — new module)
- `routes.ts` — plan + room CRUD, image upload, audited writes.
- `validation.ts` — zod schemas + the geometry/limit rules. Pure, unit-testable.
- `room-history.ts` — the bucketed multi-instrument history query. Raw SQL.

**`apps/web/src/routes/dashboard/`** (create — replaces `dashboard.tsx`)
- `index.tsx` — existing stat cards + `Table | Graphical` toggle.
- `telemetry-table.tsx` — table view.
- `floorplan-view.tsx` — plan picker, image, hotspot overlay, unplaced tray.
- `room-detail.tsx` — one room: instruments + charts.
- `time-series-chart.tsx` — hand-rolled SVG line chart.
- `status.ts` — status → Tailwind class mapping. Pure.
- `use-telemetry.ts` — SWR hooks.

**`apps/web/src/routes/config/`**
- `floorplans.tsx` (create) — the placement editor.
- `index.tsx` (modify) — add the Floorplans card.

**`scripts/`**
- `publish-demo-telemetry.ts` (create) — dev-only publisher so the views can be watched populating.

---

## Task 1: Telemetry slot vocabulary (shared, pure)

Everything downstream depends on two questions having one answer: *which telemetry key is "temperature"*, and *what status is this instrument in*. Both are pure functions, both are needed by API and web, so both live in `packages/shared`.

**Files:**
- Create: `packages/shared/src/types/telemetry-slots.ts`
- Create: `packages/shared/src/types/telemetry-slots.test.ts`
- Modify: `packages/shared/src/index.ts` (add the export line)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TelemetrySlot = 'temperature' | 'humidity'`
  - `const TELEMETRY_SLOT_ALIASES_DEFAULT: Record<TelemetrySlot, string>`
  - `parseTelemetryAliases(raw: string | null | undefined): string[]`
  - `resolveSlot<T extends { key: string }>(aliases: string[], readings: T[]): T | null`
  - `type InstrumentStatus = 'OUT_OF_SPEC' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'OK'`
  - `const STATUS_RANK: Record<InstrumentStatus, number>`
  - `interface RoomLimits { tempMin: number | null; tempMax: number | null; rhMin: number | null; rhMax: number | null }`
  - `computeInstrumentStatus(input: { temperature: number | null; humidity: number | null; limits: RoomLimits | null; reporting: boolean }): InstrumentStatus`
  - `worstStatus(statuses: InstrumentStatus[]): InstrumentStatus`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/telemetry-slots.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseTelemetryAliases,
  resolveSlot,
  computeInstrumentStatus,
  worstStatus,
  STATUS_RANK,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type InstrumentStatus,
  type RoomLimits,
} from './telemetry-slots.js';

const noLimits: RoomLimits = { tempMin: null, tempMax: null, rhMin: null, rhMax: null };
const tempOnly: RoomLimits = { tempMin: 18, tempMax: 25, rhMin: null, rhMax: null };
const bothLimits: RoomLimits = { tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 };

describe('parseTelemetryAliases', () => {
  it('splits on newlines, trims, drops blanks', () => {
    expect(parseTelemetryAliases('temperature\n  temp \n\n t \n')).toEqual(['temperature', 'temp', 't']);
  });

  it('lowercases so device casing does not matter', () => {
    expect(parseTelemetryAliases('Temperature\nTEMP')).toEqual(['temperature', 'temp']);
  });

  it('de-duplicates, keeping first occurrence for precedence', () => {
    expect(parseTelemetryAliases('temp\ntemperature\ntemp')).toEqual(['temp', 'temperature']);
  });

  it('returns [] for null, undefined and empty', () => {
    expect(parseTelemetryAliases(null)).toEqual([]);
    expect(parseTelemetryAliases(undefined)).toEqual([]);
    expect(parseTelemetryAliases('   ')).toEqual([]);
  });

  it('ships defaults that parse to the expected lists', () => {
    expect(parseTelemetryAliases(TELEMETRY_SLOT_ALIASES_DEFAULT.temperature))
      .toEqual(['temperature', 'temp', 't']);
    expect(parseTelemetryAliases(TELEMETRY_SLOT_ALIASES_DEFAULT.humidity))
      .toEqual(['humidity', 'rh', 'hum']);
  });
});

describe('resolveSlot', () => {
  const aliases = ['temperature', 'temp', 't'];

  it('returns the reading whose key matches', () => {
    expect(resolveSlot(aliases, [{ key: 'temp' }])).toEqual({ key: 'temp' });
  });

  it('matches case-insensitively', () => {
    expect(resolveSlot(aliases, [{ key: 'Temp' }])).toEqual({ key: 'Temp' });
  });

  it('prefers the earlier alias when a device sends both', () => {
    // Deterministic precedence is the whole point of an ordered list.
    const readings = [{ key: 'temp' }, { key: 'temperature' }];
    expect(resolveSlot(aliases, readings)).toEqual({ key: 'temperature' });
  });

  it('returns null when nothing matches', () => {
    expect(resolveSlot(aliases, [{ key: 'pressure' }])).toBeNull();
  });

  it('returns null for an empty alias list rather than guessing', () => {
    expect(resolveSlot([], [{ key: 'temp' }])).toBeNull();
  });
});

describe('computeInstrumentStatus', () => {
  it('is OK when reporting and within both limits', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OK');
  });

  it('is OUT_OF_SPEC above max', () => {
    expect(computeInstrumentStatus({ temperature: 27, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('is OUT_OF_SPEC below min', () => {
    expect(computeInstrumentStatus({ temperature: 17, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('treats a limit boundary as in spec', () => {
    expect(computeInstrumentStatus({ temperature: 25, humidity: 60, limits: bothLimits, reporting: true }))
      .toBe('OK');
  });

  it('breaches on humidity alone', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 65, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('ranks OUT_OF_SPEC above STALE — a stale breach is still a breach', () => {
    expect(computeInstrumentStatus({ temperature: 27, humidity: 50, limits: bothLimits, reporting: false }))
      .toBe('OUT_OF_SPEC');
  });

  it('is STALE when not reporting and not breaching', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 50, limits: bothLimits, reporting: false }))
      .toBe('STALE');
  });

  it('is STALE rather than NO_DATA when it has never reported and is not reporting', () => {
    expect(computeInstrumentStatus({ temperature: null, humidity: null, limits: bothLimits, reporting: false }))
      .toBe('STALE');
  });

  it('is NO_DATA when reporting but no readings at all', () => {
    expect(computeInstrumentStatus({ temperature: null, humidity: null, limits: bothLimits, reporting: true }))
      .toBe('NO_DATA');
  });

  it('is PARTIAL when a limited slot has no reading', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: bothLimits, reporting: true }))
      .toBe('PARTIAL');
  });

  it('is OK when the missing slot has no limit — nothing was promised', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: tempOnly, reporting: true }))
      .toBe('OK');
  });

  it('is OK with no room at all, as long as it is reporting something', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: null, reporting: true }))
      .toBe('OK');
    expect(computeInstrumentStatus({ temperature: 999, humidity: null, limits: noLimits, reporting: true }))
      .toBe('OK');
  });
});

describe('worstStatus', () => {
  it('picks the lowest rank', () => {
    expect(worstStatus(['OK', 'STALE', 'OUT_OF_SPEC'])).toBe('OUT_OF_SPEC');
    expect(worstStatus(['OK', 'PARTIAL'])).toBe('PARTIAL');
  });

  it('returns NO_DATA for an empty list — a room with no instruments knows nothing', () => {
    expect(worstStatus([])).toBe('NO_DATA');
  });

  it('ranks every status distinctly, so "worst" is never ambiguous', () => {
    const ranks = Object.values(STATUS_RANK);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('orders exactly as the spec precedence table', () => {
    const ordered = (['OUT_OF_SPEC', 'STALE', 'NO_DATA', 'PARTIAL', 'OK'] as InstrumentStatus[])
      .map((s) => STATUS_RANK[s]);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/shared && npx vitest run src/types/telemetry-slots.test.ts
```

Expected: FAIL — `Cannot find module './telemetry-slots.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/types/telemetry-slots.ts`:

```ts
/**
 * The vocabulary that turns free-form telemetry keys into two named slots, and
 * a reading plus a room's limits into one status.
 *
 * Lives in @digilog/shared because BOTH sides need it and they must agree: the
 * API computes each instrument's status, the web app maps that status to a
 * colour and aggregates rooms. Two implementations would drift, and the drift
 * would show up as a room whose colour contradicts its own rows.
 *
 * Ingest stores whatever key a device sends (`instruments/payload-parser.ts`
 * imposes no vocabulary). Live data here uses `temperature` / `humidity`; the
 * e2e suite exercises `temp` / `rh`. Neither is more correct, so the mapping is
 * administered rather than hardcoded — see `config/defs/telemetry-slots.def.ts`.
 */

export type TelemetrySlot = 'temperature' | 'humidity';

export const TELEMETRY_SLOTS: readonly TelemetrySlot[] = ['temperature', 'humidity'] as const;

/**
 * Newline-separated, most-preferred first — the same wire format as instrument
 * attribute keys, so an admin editing either is writing a list of words and
 * never JSON punctuation.
 */
export const TELEMETRY_SLOT_ALIASES_DEFAULT: Record<TelemetrySlot, string> = {
  temperature: 'temperature\ntemp\nt',
  humidity: 'humidity\nrh\nhum',
};

/** Trim, lowercase, drop blanks, de-duplicate keeping FIRST (order is precedence). */
export function parseTelemetryAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const v = line.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * First alias that any reading matches wins — NOT first reading that matches any
 * alias. A device sending both `temperature` and `temp` must resolve the same
 * way on every request, and only the alias order can guarantee that.
 */
export function resolveSlot<T extends { key: string }>(aliases: string[], readings: T[]): T | null {
  for (const alias of aliases) {
    const hit = readings.find((r) => r.key.toLowerCase() === alias);
    if (hit) return hit;
  }
  return null;
}

export type InstrumentStatus = 'OUT_OF_SPEC' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'OK';

/** Lower is worse. Also the precedence order in computeInstrumentStatus. */
export const STATUS_RANK: Record<InstrumentStatus, number> = {
  OUT_OF_SPEC: 1,
  STALE: 2,
  NO_DATA: 3,
  PARTIAL: 4,
  OK: 5,
};

export interface RoomLimits {
  tempMin: number | null;
  tempMax: number | null;
  rhMin: number | null;
  rhMax: number | null;
}

function breaches(value: number | null, min: number | null, max: number | null): boolean {
  if (value === null) return false;
  if (min !== null && value < min) return true;
  if (max !== null && value > max) return true;
  return false;
}

/** A slot is "promised" when its room sets either bound for it. */
function promised(min: number | null, max: number | null): boolean {
  return min !== null || max !== null;
}

export function computeInstrumentStatus(input: {
  temperature: number | null;
  humidity: number | null;
  limits: RoomLimits | null;
  reporting: boolean;
}): InstrumentStatus {
  const { temperature, humidity, limits, reporting } = input;
  const l = limits ?? { tempMin: null, tempMax: null, rhMin: null, rhMax: null };

  // 1. A breach outranks staleness on purpose: a probe last seen four hours ago
  //    reading 27 °C in a 25 °C room is a breach that happens to also be stale,
  //    and amber would understate it. Age is shown alongside regardless.
  if (breaches(temperature, l.tempMin, l.tempMax) || breaches(humidity, l.rhMin, l.rhMax)) {
    return 'OUT_OF_SPEC';
  }

  // 2. Not reporting. Judged by the instrument's own expectedIntervalSec where
  //    set, else the `instrument-activity` config window — the caller decides
  //    and passes the verdict in. There is exactly one staleness rule in this
  //    system and this is not the place that defines it.
  if (!reporting) return 'STALE';

  // 3. Reporting, but nothing has ever arrived.
  if (temperature === null && humidity === null) return 'NO_DATA';

  // 4. A slot the room sets a limit for has no reading — neither healthy nor a
  //    breach. Common: a temperature-only probe in a room that also specifies RH.
  if ((temperature === null && promised(l.tempMin, l.tempMax)) ||
      (humidity === null && promised(l.rhMin, l.rhMax))) {
    return 'PARTIAL';
  }

  return 'OK';
}

/** Worst status in a set — how a room takes its colour from its instruments. */
export function worstStatus(statuses: InstrumentStatus[]): InstrumentStatus {
  if (statuses.length === 0) return 'NO_DATA';
  return statuses.reduce((worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst));
}
```

- [ ] **Step 4: Export it from the package barrel**

In `packages/shared/src/index.ts`, add alongside the other `./types/*` re-exports:

```ts
export * from './types/telemetry-slots.js';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/shared && npx vitest run src/types/telemetry-slots.test.ts
```

Expected: PASS, 24 tests.

- [ ] **Step 6: Build the package so the API and web can import it**

```bash
npm run build -w @digilog/shared
```

Expected: exit 0. If this is skipped, Task 2 fails with an unresolved import.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/telemetry-slots.ts packages/shared/src/types/telemetry-slots.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): telemetry slot resolution and instrument status"
```

---

## Task 2: Telemetry slots config definition

**Files:**
- Create: `apps/api/src/modules/config/defs/telemetry-slots.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts`
- Modify: `apps/web/src/routes/config/index.tsx`

**Interfaces:**
- Consumes: `TELEMETRY_SLOT_ALIASES_DEFAULT` from Task 1.
- Produces: `system_config['telemetry-slots']` with keys `temperatureKeys`, `humidityKeys`, `temperatureDecimals`, `humidityDecimals`, `overviewRefreshSeconds`, `chartRefreshSeconds`. Task 3 reads it; Task 8 reads the refresh values.

> **Note on the 12-touchpoint rule** (`docs/CONTRIBUTING.md`): this def sets `hasCustomPage: false`, so it renders through the dynamic config page and needs **no** file in `routes/config/*.tsx`. The touchpoints that apply are the def file, the `config-discovery.ts` import, and the `config/index.tsx` card.

- [ ] **Step 1: Write the def**

Create `apps/api/src/modules/config/defs/telemetry-slots.def.ts`:

```ts
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { TELEMETRY_SLOT_ALIASES_DEFAULT } from '@digilog/shared';

/**
 * Which telemetry key means "temperature", and which means "humidity".
 *
 * Ingest imposes no vocabulary — a device's payload keys are stored verbatim.
 * This install's devices send `temperature` / `humidity`; the e2e suite
 * exercises `temp` / `rh`; the next vendor will send something else. Without an
 * administered mapping, that vendor's instruments render blank cells on the
 * dashboard and nothing on screen explains why.
 *
 * Newline-separated and ORDERED: the first alias any reading matches wins, so a
 * device sending both `temperature` and `temp` resolves identically on every
 * request. Parsing lives in @digilog/shared so the API and the web app cannot
 * disagree about what a line means.
 */
export const telemetrySlotsDef: ModuleConfigDefinition = {
  moduleKey: 'telemetry-slots',
  moduleName: 'Telemetry Keys',
  description: 'Which telemetry keys the dashboard reads as temperature and humidity, and how often it refreshes.',
  icon: 'activity',
  category: 'system',
  sortOrder: 16,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'temperatureKeys',
      type: 'textarea',
      label: 'Temperature keys',
      description: 'One key per line, most preferred first. A reading matching the first line wins over one matching the second.',
      default: TELEMETRY_SLOT_ALIASES_DEFAULT.temperature,
      maxLength: 500,
      group: 'Key Mapping',
    },
    {
      key: 'humidityKeys',
      type: 'textarea',
      label: 'Humidity keys',
      description: 'One key per line, most preferred first.',
      default: TELEMETRY_SLOT_ALIASES_DEFAULT.humidity,
      maxLength: 500,
      group: 'Key Mapping',
    },
    {
      key: 'temperatureDecimals',
      type: 'number',
      label: 'Temperature decimal places',
      description: 'How many decimals to show for temperature. Does not change what is stored.',
      default: 1,
      min: 0,
      max: 4,
      group: 'Display',
    },
    {
      key: 'humidityDecimals',
      type: 'number',
      label: 'Humidity decimal places',
      description: 'How many decimals to show for humidity. Does not change what is stored.',
      default: 1,
      min: 0,
      max: 4,
      group: 'Display',
    },
    {
      key: 'overviewRefreshSeconds',
      type: 'number',
      label: 'Dashboard refresh (seconds)',
      description: 'How often the table and floorplan re-poll for current readings. This is polling, not a live push — the browser asks on this interval.',
      default: 5,
      min: 2,
      max: 600,
      group: 'Refresh',
    },
    {
      key: 'chartRefreshSeconds',
      type: 'number',
      label: 'Chart refresh (seconds)',
      description: 'How often an open time-series chart re-polls.',
      default: 10,
      min: 2,
      max: 600,
      group: 'Refresh',
    },
  ],
};
```

- [ ] **Step 2: Register it for auto-discovery**

In `apps/api/src/lib/config-discovery.ts`, add to the `import()` array next to the existing `instrument-attributes.def.js` line:

```ts
    import('../modules/config/defs/telemetry-slots.def.js'),
```

- [ ] **Step 3: Add the config card**

In `apps/web/src/routes/config/index.tsx`, add an entry to the card array immediately after the `Instrument Attributes` card:

```tsx
  {
    title: 'Telemetry Keys',
    description: 'Which telemetry keys the dashboard reads as temperature and humidity',
    href: '/config/telemetry-slots',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12h4l3-9 4 18 3-9h4" />
      </svg>
    ),
    gradient: 'from-sky-500 to-cyan-600',
    shadowColor: 'shadow-sky-500/25',
  },
```

- [ ] **Step 4: Verify discovery picks it up**

```bash
cd apps/api && npx tsx watch src/app.ts
```

Then in another shell:

```bash
curl -sk https://localhost:3000/api/config/modules --ssl-revoke-best-effort \
  -H "Authorization: Bearer $TOKEN" | grep telemetry-slots
```

Expected: the module appears. (`--ssl-revoke-best-effort` is required — Windows `curl` uses Schannel and returns exit 60 on valid local chains without it. That is not a broken cert.)

- [ ] **Step 5: Verify the page renders**

Open `http://localhost:5175/config`, click **Telemetry Keys**, confirm six settings render in three groups and Save persists. Check the browser console is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/config/defs/telemetry-slots.def.ts apps/api/src/lib/config-discovery.ts apps/web/src/routes/config/index.tsx
git commit -m "feat(config): telemetry key mapping and dashboard refresh settings"
```

---

## Task 3: Fleet-wide telemetry overview endpoint

**Files:**
- Create: `apps/api/src/modules/instruments/telemetry-overview.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts`
- Create: `apps/api/src/e2e/telemetry-overview.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveSlot`, `parseTelemetryAliases`, `computeInstrumentStatus`, `InstrumentStatus`, `RoomLimits` (Task 1); `system_config['telemetry-slots']` (Task 2).
- Produces:
  - `buildTelemetryOverview(opts: { floorplanId?: string }): Promise<OverviewRow[]>`
  - `interface OverviewRow { instrumentId: string; code: string; name: string; isActive: boolean; room: { id: string; code: string; label: string | null; floorplanId: string } | null; temperature: SlotValue | null; humidity: SlotValue | null; reporting: boolean; status: InstrumentStatus }`
  - `interface SlotValue { key: string; value: number; ts: string }`
  - `GET /api/instruments/telemetry-overview` → `{ data: OverviewRow[] }`

> **Room fields are written now but always resolve to `null` until Task 6** adds `FloorplanRoom`. Write the query against `instruments` only in this task and add the room join in Task 6 — the shape is fixed here so the table view never changes contract.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/src/e2e/telemetry-overview.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, loginAs, createTestSuperAdmin } from './test-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let token: string;
const s = Date.now();

beforeAll(async () => {
  app = await buildTestApp();
  // Own SUPER_ADMIN, never the shared `admin` — see apps/api/CLAUDE.md.
  await createTestSuperAdmin(`tov-${s}`);
  token = await loginAs(app, `tov-${s}`);
});

async function createInstrument(code: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: code, code, profileId: await defaultProfileId(), ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

async function defaultProfileId() {
  const res = await app.inject({
    method: 'GET', url: '/api/instrument-profiles',
    headers: { authorization: `Bearer ${token}` },
  });
  return (res.json().data as { id: string }[])[0].id;
}

async function ingest(deviceToken: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/ingest/v1/telemetry',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload,
  });
}

async function overview() {
  const res = await app.inject({
    method: 'GET', url: '/api/instruments/telemetry-overview',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Record<string, any>[];
}

describe('GET /api/instruments/telemetry-overview', () => {
  it('returns an instrument that has never reported as NO_DATA with null slots', async () => {
    const inst = await createInstrument(`TOV-NEW-${s}`);
    const row = (await overview()).find((r) => r.instrumentId === inst.id);
    expect(row).toBeDefined();
    expect(row!.temperature).toBeNull();
    expect(row!.humidity).toBeNull();
    expect(row!.status).toBe('NO_DATA');
    expect(row!.room).toBeNull();
  });

  it('resolves temperature and humidity from the configured aliases', async () => {
    const inst = await createInstrument(`TOV-OK-${s}`);
    await ingest(inst.token, { temperature: 22.4, humidity: 45.2 });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temperature', value: 22.4 });
    expect(row.humidity).toMatchObject({ key: 'humidity', value: 45.2 });
  });

  it('resolves an alias key — a device sending `temp`/`rh` is not blank', async () => {
    const inst = await createInstrument(`TOV-ALIAS-${s}`);
    await ingest(inst.token, { temp: 21.0, rh: 44.0 });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temp', value: 21.0 });
    expect(row.humidity).toMatchObject({ key: 'rh', value: 44.0 });
  });

  it('ignores telemetry keys that map to no slot', async () => {
    const inst = await createInstrument(`TOV-OTHER-${s}`);
    await ingest(inst.token, { pressure: 1013 });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.temperature).toBeNull();
    expect(row.humidity).toBeNull();
  });

  it('ignores non-numeric values rather than emitting NaN', async () => {
    const inst = await createInstrument(`TOV-STR-${s}`);
    await ingest(inst.token, { temperature: 'warm' });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.temperature).toBeNull();
  });

  it('returns every instrument, including inactive ones', async () => {
    const inst = await createInstrument(`TOV-INACTIVE-${s}`, { isActive: false });
    const row = (await overview()).find((r) => r.instrumentId === inst.id);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview' });
    expect(res.statusCode).toBe(401);
  });

  it('does not shadow GET /api/instruments/:id', async () => {
    // The static path must match ahead of the uuid param route.
    const inst = await createInstrument(`TOV-ROUTE-${s}`);
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(inst.id);
  });
});
```

> If `createTestSuperAdmin` / `loginAs` / `buildTestApp` have different names in `apps/api/src/e2e/test-helper.ts`, use the real ones — read that file first and match the existing e2e files.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/e2e/telemetry-overview.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

Expected: FAIL — the overview route 404s.

- [ ] **Step 3: Write the query module**

Create `apps/api/src/modules/instruments/telemetry-overview.ts`:

```ts
/**
 * The fleet-wide "what is everything reading right now" query.
 *
 * ONE endpoint feeds BOTH dashboard views. The table renders these rows
 * directly; the floorplan groups them by room and takes each room's colour from
 * the worst status among its members. Two endpoints over the same data would
 * eventually disagree, and a room whose colour contradicts its own rows is the
 * worst possible bug on a compliance dashboard.
 *
 * Separate file rather than more of routes.ts, which is already 1700 lines.
 */
import { prisma } from '../../lib/prisma.js';
import {
  parseTelemetryAliases,
  resolveSlot,
  computeInstrumentStatus,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type InstrumentStatus,
  type RoomLimits,
} from '@digilog/shared';
import { getInstrumentActiveWindowMs } from './last-seen.js';

export interface SlotValue {
  key: string;
  value: number;
  ts: string;
}

export interface OverviewRow {
  instrumentId: string;
  code: string;
  name: string;
  isActive: boolean;
  room: { id: string; code: string; label: string | null; floorplanId: string } | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  reporting: boolean;
  status: InstrumentStatus;
}

interface RawReading {
  instrumentId: string;
  key: string;
  value: unknown;
  ts: Date;
}

async function loadAliases(): Promise<{ temperature: string[]; humidity: string[] }> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    temperature: parseTelemetryAliases(
      (cfg.temperatureKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.temperature,
    ),
    humidity: parseTelemetryAliases(
      (cfg.humidityKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.humidity,
    ),
  };
}

/**
 * A stored telemetry value is jsonb — it can legitimately be a string, a bool or
 * an object. Only a finite number is a reading; anything else is ignored rather
 * than coerced, because `Number("warm")` is NaN and NaN renders as a blank cell
 * that looks identical to "no data" while silently poisoning limit comparisons.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function toSlot(reading: RawReading | null): SlotValue | null {
  if (!reading) return null;
  const n = asNumber(reading.value);
  if (n === null) return null;
  return { key: reading.key, value: n, ts: reading.ts.toISOString() };
}

export async function buildTelemetryOverview(
  opts: { floorplanId?: string } = {},
): Promise<OverviewRow[]> {
  const aliases = await loadAliases();
  const fallbackWindowMs = await getInstrumentActiveWindowMs();

  const instruments = await prisma.instrument.findMany({
    select: {
      id: true, code: true, name: true, isActive: true,
      expectedIntervalSec: true, lastSeenAt: true,
    },
    orderBy: { code: 'asc' },
  });
  if (instruments.length === 0) return [];

  // One query for every latest reading, not one per instrument. The table is the
  // whole fleet and this is polled every few seconds.
  const readings = await prisma.$queryRaw<RawReading[]>`
    SELECT instrument_id AS "instrumentId", key, value, ts
    FROM instrument_telemetry_latest`;

  const byInstrument = new Map<string, RawReading[]>();
  for (const r of readings) {
    const list = byInstrument.get(r.instrumentId);
    if (list) list.push(r);
    else byInstrument.set(r.instrumentId, [r]);
  }

  const now = Date.now();

  return instruments.map((inst) => {
    const mine = byInstrument.get(inst.id) ?? [];
    const temperature = toSlot(resolveSlot(aliases.temperature, mine));
    const humidity = toSlot(resolveSlot(aliases.humidity, mine));

    // The ONE staleness rule in this system: the instrument's own declared
    // contract where it has one, else the site-wide fallback window. Do not
    // invent a second definition here — `instrument-activity.def.ts` documents
    // why a single fixed window would libel half the fleet.
    const windowMs = inst.expectedIntervalSec
      ? inst.expectedIntervalSec * 1000 * 2   // one missed report is not yet a fault
      : fallbackWindowMs;
    const reporting = inst.lastSeenAt !== null && now - inst.lastSeenAt.getTime() <= windowMs;

    // Rooms arrive in Task 6. Until then every instrument is unplaced, which is
    // an honest answer rather than a stub: nothing has been placed yet.
    const room: OverviewRow['room'] = null;
    const limits: RoomLimits | null = null;

    return {
      instrumentId: inst.id,
      code: inst.code,
      name: inst.name,
      isActive: inst.isActive,
      room,
      temperature,
      humidity,
      reporting,
      status: computeInstrumentStatus({
        temperature: temperature?.value ?? null,
        humidity: humidity?.value ?? null,
        limits,
        reporting,
      }),
    };
  });
}
```

- [ ] **Step 4: Add the active-window helper if it does not exist**

Read `apps/api/src/modules/instruments/last-seen.ts`. If it does not already export a function returning the fallback active window in milliseconds, add:

```ts
import { INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';

/**
 * The site-wide fallback window, in ms. Used ONLY for instruments that declare
 * no expectedIntervalSec — one that declares its own contract is judged against
 * that instead. See config/defs/instrument-activity.def.ts.
 */
export async function getInstrumentActiveWindowMs(): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-activity' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  const minutes = typeof cfg.activeWindowMinutes === 'number'
    ? cfg.activeWindowMinutes
    : INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;
  return minutes * 60_000;
}
```

If an equivalent already exists (under any name), import that instead and delete this step's addition — do not create a second definition of the active window.

- [ ] **Step 5: Mount the route**

In `apps/api/src/modules/instruments/routes.ts`, add the import at the top:

```ts
import { buildTelemetryOverview } from './telemetry-overview.js';
```

and register the route **immediately before** `app.get('/:id', ...)` (line ~468), next to the existing `/eligible-children` static route:

```ts
  // GET /api/instruments/telemetry-overview — every instrument's current
  // temperature and humidity, in one request.
  //
  // Registered BEFORE '/:id' so the static path wins the match, exactly as
  // '/eligible-children' does. Feeds both dashboard views; see
  // telemetry-overview.ts for why there is only one such endpoint.
  app.get('/telemetry-overview', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Current temperature and humidity for every instrument',
      querystring: {
        type: 'object',
        properties: { floorplanId: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  instrumentId: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  isActive: { type: 'boolean' },
                  room: {
                    type: 'object', nullable: true,
                    properties: {
                      id: { type: 'string' }, code: { type: 'string' },
                      label: { type: 'string', nullable: true },
                      floorplanId: { type: 'string' },
                    },
                  },
                  temperature: {
                    type: 'object', nullable: true,
                    properties: {
                      key: { type: 'string' }, value: { type: 'number' },
                      ts: { type: 'string', format: 'date-time' },
                    },
                  },
                  humidity: {
                    type: 'object', nullable: true,
                    properties: {
                      key: { type: 'string' }, value: { type: 'number' },
                      ts: { type: 'string', format: 'date-time' },
                    },
                  },
                  reporting: { type: 'boolean' },
                  status: { type: 'string' },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const q = req.query as { floorplanId?: string };
    return { data: await buildTelemetryOverview({ floorplanId: q.floorplanId }) };
  });
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/e2e/telemetry-overview.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Typecheck**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: exit 0. **Do not skip this** — vitest never typechecks, so a green suite is not evidence the code compiles.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/instruments/telemetry-overview.ts apps/api/src/modules/instruments/routes.ts apps/api/src/modules/instruments/last-seen.ts apps/api/src/e2e/telemetry-overview.e2e.test.ts
git commit -m "feat(api): fleet-wide telemetry overview endpoint"
```

---

## Task 4: Demo telemetry publisher

Fifteen instruments, two with a location, thirty-two history rows. Without this, the next four tasks build views nobody can watch working.

**Files:**
- Create: `scripts/publish-demo-telemetry.ts`

**Interfaces:**
- Consumes: `POST /api/instruments`, `POST /api/ingest/v1/telemetry` (both existing).
- Produces: nothing importable. Dev tool only, never wired into the app.

- [ ] **Step 1: Write the script**

Create `scripts/publish-demo-telemetry.ts`:

```ts
/**
 * Dev-only. Registers a handful of instruments named after real CWH 3rd-floor
 * rooms and publishes plausible temperature/humidity through the NORMAL ingest
 * endpoint — no direct database writes, so what the dashboard shows is what a
 * real device would produce.
 *
 * Deliberately includes one instrument that drifts out of spec and one that
 * stops reporting, because a dashboard whose colours have only ever been green
 * has not been tested.
 *
 * Usage:
 *   npx tsx scripts/publish-demo-telemetry.ts --seed        # create instruments, print tokens
 *   npx tsx scripts/publish-demo-telemetry.ts --publish     # publish every 5s until Ctrl-C
 */
const API = process.env.DEMO_API ?? 'https://localhost:3000';
const USER = process.env.DEMO_USER ?? 'superadmin';
const PASS = process.env.DEMO_PASS ?? 'Admin@123';

// Self-signed local cert — this is a dev script talking to localhost only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEVICES = [
  { code: 'DEMO-TH-142', name: 'Wet Lab probe',      room: 'CWH-I/142', temp: 22.0, rh: 45 },
  { code: 'DEMO-TH-220', name: 'HPLC Room probe',    room: 'CWH-I/220', temp: 21.5, rh: 48 },
  { code: 'DEMO-TH-221', name: 'GC Room probe',      room: 'CWH-I/221', temp: 23.0, rh: 50 },
  // Drifts above a 25 °C limit within a couple of minutes — this is the one
  // that proves the colour coding works.
  { code: 'DEMO-TH-347', name: 'Canteen probe',      room: 'CWH-I/347', temp: 24.6, rh: 55, drift: 0.15 },
  // Never publishes → goes STALE, then shows as amber.
  { code: 'DEMO-TH-361', name: 'Service Area probe', room: 'CWH-I/361', temp: 22.0, rh: 45, silent: true },
];

async function login(): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, force: true }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { token?: string; accessToken?: string };
  const token = body.token ?? body.accessToken;
  if (!token) throw new Error(`login returned no token: ${JSON.stringify(body)}`);
  return token;
}

async function seed() {
  const jwt = await login();
  const auth = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' };

  const profiles = await (await fetch(`${API}/api/instrument-profiles`, { headers: auth })).json();
  const profileId = (profiles.data as { id: string }[])[0].id;

  const tokens: Record<string, string> = {};
  for (const d of DEVICES) {
    const res = await fetch(`${API}/api/instruments`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: d.name, code: d.code, profileId, location: d.room }),
    });
    if (res.status === 409) {
      console.log(`${d.code}: already exists — regenerate its token in the UI if you need it`);
      continue;
    }
    if (!res.ok) throw new Error(`${d.code}: ${res.status} ${await res.text()}`);
    const body = await res.json() as { token: string };
    tokens[d.code] = body.token;
    console.log(`${d.code}: created`);
  }

  console.log('\nSave this — tokens are shown once:\n');
  console.log(JSON.stringify(tokens, null, 2));
  console.log('\nThen: DEMO_TOKENS=\'<that json>\' npx tsx scripts/publish-demo-telemetry.ts --publish');
}

async function publish() {
  const raw = process.env.DEMO_TOKENS;
  if (!raw) throw new Error('Set DEMO_TOKENS to the JSON printed by --seed');
  const tokens = JSON.parse(raw) as Record<string, string>;
  const drift: Record<string, number> = {};

  const tick = async () => {
    for (const d of DEVICES) {
      if (d.silent) continue;
      const token = tokens[d.code];
      if (!token) continue;
      drift[d.code] = (drift[d.code] ?? 0) + (d.drift ?? 0);
      const temperature = +(d.temp + drift[d.code] + (Math.random() - 0.5) * 0.3).toFixed(2);
      const humidity = +(d.rh + (Math.random() - 0.5) * 2).toFixed(2);
      const res = await fetch(`${API}/api/ingest/v1/telemetry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ temperature, humidity }),
      });
      console.log(`${d.code}  ${temperature} °C  ${humidity} %RH  → ${res.status}`);
    }
  };

  await tick();
  setInterval(tick, 5000);
}

const mode = process.argv[2];
if (mode === '--seed') await seed();
else if (mode === '--publish') await publish();
else {
  console.error('Usage: publish-demo-telemetry.ts --seed | --publish');
  process.exit(1);
}
```

- [ ] **Step 2: Verify the ingest path and login response shape**

Read `apps/api/src/modules/instruments/ingest-routes.ts` and confirm the telemetry POST path is `/telemetry` under the `/api/ingest/v1` prefix. Read the login handler in `apps/api/src/modules/auth/` and confirm the token field name. Fix the script to match the real values — do not leave a guess in it.

- [ ] **Step 3: Run it against the dev server**

With the API running:

```bash
npx tsx scripts/publish-demo-telemetry.ts --seed
DEMO_TOKENS='<paste>' npx tsx scripts/publish-demo-telemetry.ts --publish
```

Expected: five instruments created, four publishing every 5 seconds with `202`/`200`.

- [ ] **Step 4: Confirm it reaches the overview endpoint**

```bash
export PGPASSWORD=digilog123
psql -h localhost -U digilog -d compliance_core_db \
  -c "select instrument_id, key, value, ts from instrument_telemetry_latest order by ts desc limit 10;"
```

Expected: fresh rows for the DEMO instruments.

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-demo-telemetry.ts
git commit -m "chore(scripts): demo telemetry publisher for dashboard development"
```

---

## Task 5: Dashboard split and table view

**Files:**
- Delete: `apps/web/src/routes/dashboard.tsx` (content moves to `dashboard/index.tsx`)
- Create: `apps/web/src/routes/dashboard/index.tsx`
- Create: `apps/web/src/routes/dashboard/telemetry-table.tsx`
- Create: `apps/web/src/routes/dashboard/status.ts`
- Create: `apps/web/src/routes/dashboard/use-telemetry.ts`
- Create: `apps/web/src/routes/dashboard/__tests__/status.test.ts`
- Modify: `apps/web/src/main.tsx` (import path only)
- Modify: `apps/web/src/routes/config/dashboard-cards.tsx` (two new card keys)
- Modify: `apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts` (same two keys — the file says "keep in sync")

**Interfaces:**
- Consumes: `GET /api/instruments/telemetry-overview` (Task 3); `InstrumentStatus`, `worstStatus` (Task 1).
- Produces:
  - `statusClasses(status: InstrumentStatus): { dot: string; text: string; bg: string; border: string; label: string }`
  - `useTelemetryOverview(floorplanId?: string): { rows: OverviewRow[]; isLoading: boolean; error: unknown }`
  - `useTelemetrySettings(): { temperatureDecimals: number; humidityDecimals: number; overviewRefreshMs: number; chartRefreshMs: number }`
  - `<TelemetryTable rows={...} />`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/routes/dashboard/__tests__/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statusClasses } from '../status';
import { STATUS_RANK, type InstrumentStatus } from '@digilog/shared';

const ALL = Object.keys(STATUS_RANK) as InstrumentStatus[];

describe('statusClasses', () => {
  it('covers every status — a new status must not fall through to undefined', () => {
    for (const s of ALL) {
      const c = statusClasses(s);
      expect(c.label).toBeTruthy();
      expect(c.dot).toBeTruthy();
    }
  });

  it('gives OUT_OF_SPEC red and OK emerald', () => {
    expect(statusClasses('OUT_OF_SPEC').dot).toContain('red');
    expect(statusClasses('OK').dot).toContain('emerald');
  });

  it('gives STALE and PARTIAL amber — both mean "cannot confirm", not "bad"', () => {
    expect(statusClasses('STALE').dot).toContain('amber');
    expect(statusClasses('PARTIAL').dot).toContain('amber');
  });

  it('gives NO_DATA slate, distinct from every other colour', () => {
    expect(statusClasses('NO_DATA').dot).toContain('slate');
  });

  it('labels are human sentences, not enum names', () => {
    expect(statusClasses('OUT_OF_SPEC').label).toBe('Out of spec');
    expect(statusClasses('NO_DATA').label).toBe('No data');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run src/routes/dashboard/__tests__/status.test.ts
```

Expected: FAIL — cannot resolve `../status`.

- [ ] **Step 3: Write the status map**

Create `apps/web/src/routes/dashboard/status.ts`:

```ts
import type { InstrumentStatus } from '@digilog/shared';

/**
 * Status → Tailwind classes. These colours are SEMANTIC, so they are fixed
 * rather than theme variables: a site that themes the app purple must not end
 * up with a purple "out of spec".
 *
 * STALE and PARTIAL share amber deliberately. Both mean "cannot confirm this is
 * in spec" — one because the reading is old, one because a promised reading is
 * missing — and inventing a fifth colour for that distinction would cost more
 * legibility than it buys.
 */
export interface StatusClasses {
  dot: string;
  text: string;
  bg: string;
  border: string;
  label: string;
}

const MAP: Record<InstrumentStatus, StatusClasses> = {
  OUT_OF_SPEC: {
    dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-300',
    label: 'Out of spec',
  },
  STALE: {
    dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-300',
    label: 'Not reporting',
  },
  NO_DATA: {
    dot: 'bg-slate-400', text: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-300',
    label: 'No data',
  },
  PARTIAL: {
    dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-300',
    label: 'Partial data',
  },
  OK: {
    dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-300',
    label: 'In spec',
  },
};

export function statusClasses(status: InstrumentStatus): StatusClasses {
  return MAP[status] ?? MAP.NO_DATA;
}

/** "12s ago" / "4h ago" / "Never". Short by design — it sits inside a table cell. */
export function readingAge(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return 'Never';
  const secs = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/routes/dashboard/__tests__/status.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the data hooks**

Create `apps/web/src/routes/dashboard/use-telemetry.ts`:

```ts
import useSWR from 'swr';
import { TELEMETRY_SLOT_ALIASES_DEFAULT, type InstrumentStatus } from '@digilog/shared';

export interface SlotValue { key: string; value: number; ts: string }

export interface OverviewRow {
  instrumentId: string;
  code: string;
  name: string;
  isActive: boolean;
  room: { id: string; code: string; label: string | null; floorplanId: string } | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  reporting: boolean;
  status: InstrumentStatus;
}

export interface TelemetrySettings {
  temperatureDecimals: number;
  humidityDecimals: number;
  overviewRefreshMs: number;
  chartRefreshMs: number;
}

const SETTINGS_DEFAULT: TelemetrySettings = {
  temperatureDecimals: 1,
  humidityDecimals: 1,
  overviewRefreshMs: 5000,
  chartRefreshMs: 10000,
};

export function useTelemetrySettings(): TelemetrySettings {
  const { data } = useSWR<any>('/api/config/telemetry-slots/current', {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
  const v = data?.value ?? data ?? {};
  return {
    temperatureDecimals: v.temperatureDecimals ?? SETTINGS_DEFAULT.temperatureDecimals,
    humidityDecimals: v.humidityDecimals ?? SETTINGS_DEFAULT.humidityDecimals,
    overviewRefreshMs: (v.overviewRefreshSeconds ?? 5) * 1000,
    chartRefreshMs: (v.chartRefreshSeconds ?? 10) * 1000,
  };
}

/**
 * Polling, NOT push. This repo has no browser-facing WebSocket or SSE channel —
 * the `@fastify/websocket` registration that exists is INBOUND device ingest.
 * Every "live" surface in this feature is an interval, and the UI says so.
 */
export function useTelemetryOverview(floorplanId?: string) {
  const { overviewRefreshMs } = useTelemetrySettings();
  const url = floorplanId
    ? `/api/instruments/telemetry-overview?floorplanId=${floorplanId}`
    : '/api/instruments/telemetry-overview';
  const { data, error, isLoading } = useSWR<{ data: OverviewRow[] }>(url, {
    refreshInterval: overviewRefreshMs,
    revalidateOnFocus: true,
    dedupingInterval: 1000,
  });
  return { rows: data?.data ?? [], isLoading, error };
}

export function formatSlot(v: SlotValue | null, decimals: number, unit: string): string {
  if (!v) return '—';
  return `${v.value.toFixed(decimals)} ${unit}`;
}

export { TELEMETRY_SLOT_ALIASES_DEFAULT };
```

> Verify the shape returned by `GET /api/config/<key>/current` against an existing consumer (`apps/web/src/hooks/use-report-page-titles.ts` or the `dashboard-cards` fetch in the old `dashboard.tsx`) and make `useTelemetrySettings` unwrap it the same way. Do not leave the `data?.value ?? data` guess in place.

- [ ] **Step 6: Write the table view**

Create `apps/web/src/routes/dashboard/telemetry-table.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { statusClasses, readingAge } from './status';
import { useTelemetryOverview, useTelemetrySettings, formatSlot, type OverviewRow } from './use-telemetry';

type SortKey = 'code' | 'room' | 'temperature' | 'humidity' | 'status';

function sortValue(row: OverviewRow, key: SortKey): string | number {
  switch (key) {
    case 'code': return row.code.toLowerCase();
    case 'room': return row.room?.code.toLowerCase() ?? '￿';   // unplaced sort last
    case 'temperature': return row.temperature?.value ?? Number.NEGATIVE_INFINITY;
    case 'humidity': return row.humidity?.value ?? Number.NEGATIVE_INFINITY;
    case 'status': return row.status;
  }
}

export function TelemetryTable() {
  const { rows, isLoading, error } = useTelemetryOverview();
  const { temperatureDecimals, humidityDecimals } = useTelemetrySettings();
  const [sort, setSort] = useState<SortKey>('code');
  const [asc, setAsc] = useState(true);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          r.code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          (r.room?.code.toLowerCase().includes(q) ?? false) ||
          (r.room?.label?.toLowerCase().includes(q) ?? false))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return asc ? cmp : -cmp;
    });
  }, [rows, sort, asc, query]);

  const toggle = (key: SortKey) => {
    if (key === sort) setAsc(!asc);
    else { setSort(key); setAsc(true); }
  };

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Could not load instrument readings. {String((error as any)?.message ?? '')}
      </div>
    );
  }

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th
      onClick={() => toggle(k)}
      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 cursor-pointer select-none hover:text-slate-700"
    >
      {children}{sort === k ? (asc ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div className="space-y-4">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by instrument, name or room…"
        className="w-full max-w-sm rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2"
        style={{ ['--tw-ring-color' as any]: 'var(--theme-primary)' }}
      />

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-soft">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th k="code">Instrument</Th>
              <Th k="room">Room</Th>
              <Th k="temperature">Temperature</Th>
              <Th k="humidity">Humidity</Th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Last reading</th>
              <Th k="status">Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">Loading…</td></tr>
            )}
            {!isLoading && shown.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                {rows.length === 0 ? 'No instruments registered yet.' : 'No instruments match that filter.'}
              </td></tr>
            )}
            {shown.map((r) => {
              const c = statusClasses(r.status);
              const latest = r.temperature?.ts ?? r.humidity?.ts ?? null;
              return (
                <tr key={r.instrumentId} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/instruments/${r.instrumentId}`} className="font-medium text-slate-800 hover:underline">
                      {r.code}
                    </Link>
                    <div className="text-xs text-slate-500">{r.name}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {r.room ? (
                      <>
                        <span className="font-medium">{r.room.code}</span>
                        {r.room.label && <span className="text-slate-500"> · {r.room.label}</span>}
                      </>
                    ) : (
                      <span className="text-slate-400">Not placed</span>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-sm tabular-nums ${r.status === 'OUT_OF_SPEC' ? 'font-semibold text-red-700' : 'text-slate-800'}`}>
                    {formatSlot(r.temperature, temperatureDecimals, '°C')}
                  </td>
                  <td className={`px-4 py-3 text-sm tabular-nums ${r.status === 'OUT_OF_SPEC' ? 'font-semibold text-red-700' : 'text-slate-800'}`}>
                    {formatSlot(r.humidity, humidityDecimals, '%RH')}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500">{readingAge(latest)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${c.bg} ${c.border} ${c.text}`}>
                      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                      {c.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Split the dashboard page**

`git mv apps/web/src/routes/dashboard.tsx apps/web/src/routes/dashboard/index.tsx`, then in `index.tsx`:

1. Fix the relative imports — `@/` aliases are unaffected, but any `./`-relative import needs a `../` added.
2. Add the imports:

```tsx
import { useState } from 'react';
import { TelemetryTable } from './telemetry-table';
```

3. Add the view state next to the existing hooks in `DashboardPage`:

```tsx
  const [view, setView] = useState<'table' | 'graphical'>('table');
```

4. Insert this block between the "Stats Grid" section and "Quick Actions":

```tsx
      {(showCard('telemetry_table') || showCard('telemetry_floorplan')) && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-800">Instrument Readings</h2>
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
              {showCard('telemetry_table') && (
                <button
                  onClick={() => setView('table')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view === 'table' ? 'text-white' : 'text-slate-600 hover:text-slate-800'
                  }`}
                  style={view === 'table' ? { backgroundImage: themeGradient } : undefined}
                >
                  Table view
                </button>
              )}
              {showCard('telemetry_floorplan') && (
                <button
                  onClick={() => setView('graphical')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view === 'graphical' ? 'text-white' : 'text-slate-600 hover:text-slate-800'
                  }`}
                  style={view === 'graphical' ? { backgroundImage: themeGradient } : undefined}
                >
                  Graphical view
                </button>
              )}
            </div>
          </div>

          {view === 'table' && showCard('telemetry_table') && <TelemetryTable />}
          {view === 'graphical' && showCard('telemetry_floorplan') && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Floorplan view arrives in Task 13.
            </div>
          )}
        </div>
      )}
```

The `Floorplan view arrives in Task 13` placeholder is replaced in Task 13 and must not survive past it. Task 13 greps for it.

- [ ] **Step 8: Register the two new dashboard cards**

In `apps/web/src/routes/config/dashboard-cards.tsx`, add to `ALL_CARDS`:

```tsx
  { key: 'telemetry_table', label: 'Instrument Readings — Table' },
  { key: 'telemetry_floorplan', label: 'Instrument Readings — Floorplan' },
```

Match the existing entry shape in that file exactly. Mirror the same two keys into `apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts`, which carries a "Keep in sync with ALL_CARDS" comment.

- [ ] **Step 9: Fix the route import**

In `apps/web/src/main.tsx`, the import of `DashboardPage` resolves through the folder's `index.tsx` unchanged if it was `'./routes/dashboard'`. If it was `'./routes/dashboard.tsx'` or included the extension, update it.

- [ ] **Step 10: Run the web suite and typecheck**

```bash
cd apps/web && npm test
npx tsc -p apps/web/tsconfig.json --noEmit
```

Expected: all tests pass, typecheck exits 0.

- [ ] **Step 11: Verify in the browser**

With the API, Vite and the publisher from Task 4 running, open `http://localhost:5175/`:

- The Table/Graphical toggle renders and Table is selected.
- The DEMO instruments appear with live temperature and humidity, updating every ~5 seconds.
- `DEMO-TH-361` shows **Not reporting** (amber) — it never publishes.
- Every instrument shows **Not placed** under Room (correct — rooms arrive in Task 6).
- Sorting each column works; the filter box narrows rows.
- **The browser console is clean** — no errors, no failed requests, no React key warnings.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/routes/dashboard apps/web/src/main.tsx apps/web/src/routes/config/dashboard-cards.tsx apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts
git commit -m "feat(web): dashboard table view of live instrument readings"
```

---

## Task 6: Floorplan and room schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260811120000_instrument_floorplans/migration.sql`
- Modify: `apps/api/src/modules/instruments/telemetry-overview.ts`
- Modify: `apps/api/src/e2e/telemetry-overview.e2e.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.floorplan`, `prisma.floorplanRoom`, `Instrument.roomId`, and `OverviewRow.room` / room limits now actually populated.

- [ ] **Step 1: Add the models to the schema**

Append to `apps/api/prisma/schema.prisma`:

```prisma
/// A plan image with clickable rooms drawn on it. Several plans coexist (one
/// per floor or block); the dashboard shows one at a time.
model Floorplan {
  id          String   @id @default(uuid())
  name        String   @unique
  imagePath   String   @map("image_path")
  imageWidth  Int      @map("image_width")
  imageHeight Int      @map("image_height")
  isActive    Boolean  @default(true) @map("is_active")
  sortOrder   Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy   String?  @map("created_by")
  updatedBy   String?  @map("updated_by")

  rooms FloorplanRoom[]

  @@map("floorplans")
}

/// One clickable region of a plan, and the environmental specification that
/// region must hold.
///
/// LIMITS LIVE HERE, NOT ON THE INSTRUMENT. A cleanroom's specification belongs
/// to the room; replacing the probe on its wall must not discard the spec, and
/// two probes in one room must not be able to assert two different specs. This
/// reverses the four `* Temperature/Humidity Limit` instrument-attribute keys —
/// see docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md §3.
model FloorplanRoom {
  id          String  @id @default(uuid())
  floorplanId String  @map("floorplan_id")
  /// The room code as it appears on the drawing, e.g. "CWH-I/142".
  code        String
  label       String?

  /// Normalized 0..1 against the plan image, NOT pixels: the hotspot then holds
  /// at any zoom and any screen size, and survives re-exporting the drawing at a
  /// different DPI.
  x Float
  y Float
  w Float
  h Float

  /// NULL = that bound is not checked. All four NULL is legitimate — a corridor
  /// or an office has no environmental specification.
  tempMin Float? @map("temp_min")
  tempMax Float? @map("temp_max")
  rhMin   Float? @map("rh_min")
  rhMax   Float? @map("rh_max")

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy String?  @map("created_by")
  updatedBy String?  @map("updated_by")

  floorplan   Floorplan    @relation(fields: [floorplanId], references: [id], onDelete: Cascade)
  instruments Instrument[]

  @@unique([floorplanId, code])
  @@index([floorplanId])
  @@map("floorplan_rooms")
}
```

And on the existing `Instrument` model, next to the placement fields:

```prisma
  /// Which room this instrument sits in. NULLABLE — an unplaced instrument is a
  /// normal state, and the dashboard shows those in an explicit tray rather than
  /// dropping them. A real FK, not the free-text `location` column above,
  /// because room membership must not be breakable by a typo or a trailing space.
  roomId String?        @map("room_id")
  room   FloorplanRoom? @relation(fields: [roomId], references: [id], onDelete: SetNull)
```

and add to its index block:

```prisma
  @@index([roomId])
```

- [ ] **Step 2: Draft the migration SQL**

```bash
cd apps/api && npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Review the output. Strip any out-of-band noise (triggers, functions, sequences managed in `prisma/sql/*`) — those are maintained separately and regenerating them would delete them.

- [ ] **Step 3: Hand-author the migration**

Create `apps/api/prisma/migrations/20260811120000_instrument_floorplans/migration.sql`:

```sql
-- Floorplans and their clickable rooms.
--
-- Coordinates are normalized 0..1 against the plan image. Enforced in the
-- application layer (floorplans/validation.ts) rather than by CHECK constraints,
-- so a bad payload returns a 400 naming the offending field instead of a raw
-- Postgres constraint error the UI cannot explain.

CREATE TABLE "floorplans" (
  "id"           TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "image_path"   TEXT NOT NULL,
  "image_width"  INTEGER NOT NULL,
  "image_height" INTEGER NOT NULL,
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "sort_order"   INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL,
  "created_by"   TEXT,
  "updated_by"   TEXT,
  CONSTRAINT "floorplans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "floorplans_name_key" ON "floorplans"("name");

CREATE TABLE "floorplan_rooms" (
  "id"           TEXT NOT NULL,
  "floorplan_id" TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "label"        TEXT,
  "x"            DOUBLE PRECISION NOT NULL,
  "y"            DOUBLE PRECISION NOT NULL,
  "w"            DOUBLE PRECISION NOT NULL,
  "h"            DOUBLE PRECISION NOT NULL,
  "temp_min"     DOUBLE PRECISION,
  "temp_max"     DOUBLE PRECISION,
  "rh_min"       DOUBLE PRECISION,
  "rh_max"       DOUBLE PRECISION,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL,
  "created_by"   TEXT,
  "updated_by"   TEXT,
  CONSTRAINT "floorplan_rooms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "floorplan_rooms_floorplan_id_code_key"
  ON "floorplan_rooms"("floorplan_id", "code");
CREATE INDEX "floorplan_rooms_floorplan_id_idx"
  ON "floorplan_rooms"("floorplan_id");

ALTER TABLE "floorplan_rooms"
  ADD CONSTRAINT "floorplan_rooms_floorplan_id_fkey"
  FOREIGN KEY ("floorplan_id") REFERENCES "floorplans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Instrument -> room. NULLABLE and ON DELETE SET NULL: deleting a room must
-- never delete the instruments that were in it.
ALTER TABLE "instruments" ADD COLUMN "room_id" TEXT;

CREATE INDEX "instruments_room_id_idx" ON "instruments"("room_id");

ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "floorplan_rooms"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply and verify no drift**

```bash
cd apps/api
npx prisma migrate deploy
npx prisma generate
npm run db:verify-migrations
```

Expected: `migrate deploy` applies one migration; the drift guard PASSes. **If the guard fails, stop and fix the migration — do not proceed.**

- [ ] **Step 5: Apply to the test database too**

```bash
cd apps/api
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test npx prisma migrate deploy
```

> Confirm the test DB name against `apps/api/vitest.env.ts` — it rewrites `DATABASE_URL` and is the authority on which database the suite uses.

- [ ] **Step 6: Populate the room in the overview query**

In `apps/api/src/modules/instruments/telemetry-overview.ts`, extend the instrument select:

```ts
    select: {
      id: true, code: true, name: true, isActive: true,
      expectedIntervalSec: true, lastSeenAt: true,
      room: {
        select: {
          id: true, code: true, label: true, floorplanId: true,
          tempMin: true, tempMax: true, rhMin: true, rhMax: true,
        },
      },
    },
```

add the filter:

```ts
    where: opts.floorplanId ? { room: { floorplanId: opts.floorplanId } } : undefined,
```

and replace the two placeholder lines in the `map` callback:

```ts
    const room = inst.room
      ? { id: inst.room.id, code: inst.room.code, label: inst.room.label, floorplanId: inst.room.floorplanId }
      : null;
    const limits: RoomLimits | null = inst.room
      ? {
          tempMin: inst.room.tempMin, tempMax: inst.room.tempMax,
          rhMin: inst.room.rhMin, rhMax: inst.room.rhMax,
        }
      : null;
```

Delete the `// Rooms arrive in Task 6` comment.

- [ ] **Step 7: Add the room-aware e2e cases**

Append to `apps/api/src/e2e/telemetry-overview.e2e.test.ts`:

```ts
import { prisma } from '../lib/prisma.js';

describe('telemetry-overview with rooms', () => {
  async function makeRoom(code: string, limits: Partial<Record<'tempMin' | 'tempMax' | 'rhMin' | 'rhMax', number>>) {
    const plan = await prisma.floorplan.create({
      data: { name: `Plan ${code}`, imagePath: '/uploads/plans/x.png', imageWidth: 1000, imageHeight: 700 },
    });
    return prisma.floorplanRoom.create({
      data: { floorplanId: plan.id, code, x: 0.1, y: 0.1, w: 0.1, h: 0.1, ...limits },
    });
  }

  it('reports OUT_OF_SPEC against the room limits', async () => {
    const room = await makeRoom(`R-HOT-${s}`, { tempMin: 18, tempMax: 25 });
    const inst = await createInstrument(`TOV-HOT-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await ingest(inst.token, { temperature: 27.5 });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.room).toMatchObject({ code: `R-HOT-${s}` });
    expect(row.status).toBe('OUT_OF_SPEC');
  });

  it('reports PARTIAL when a limited slot has no reading', async () => {
    const room = await makeRoom(`R-PART-${s}`, { tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 });
    const inst = await createInstrument(`TOV-PART-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await ingest(inst.token, { temperature: 22 });
    const row = (await overview()).find((r) => r.instrumentId === inst.id)!;
    expect(row.status).toBe('PARTIAL');
  });

  it('unlinks rather than deletes when its room is deleted', async () => {
    const room = await makeRoom(`R-GONE-${s}`, {});
    const inst = await createInstrument(`TOV-GONE-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await prisma.floorplanRoom.delete({ where: { id: room.id } });
    const still = await prisma.instrument.findUnique({ where: { id: inst.id } });
    expect(still).not.toBeNull();
    expect(still!.roomId).toBeNull();
  });

  it('narrows to one plan with ?floorplanId=', async () => {
    const room = await makeRoom(`R-PLAN-${s}`, {});
    const inst = await createInstrument(`TOV-PLAN-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/telemetry-overview?floorplanId=${room.floorplanId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const data = res.json().data as Record<string, any>[];
    expect(data.map((r) => r.instrumentId)).toEqual([inst.id]);
  });
});
```

- [ ] **Step 8: Run the tests and typecheck**

```bash
cd apps/api && npx vitest run src/e2e/telemetry-overview.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 12 tests pass; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260811120000_instrument_floorplans apps/api/src/modules/instruments/telemetry-overview.ts apps/api/src/e2e/telemetry-overview.e2e.test.ts
git commit -m "feat(api): floorplan and room models with per-room environmental limits"
```

---

## Task 7: Audit and reauth actions for floorplan writes

**Files:**
- Modify: `packages/shared/src/types/audit-actions.ts`
- Modify: `packages/shared/src/types/audit-templates.ts`
- Modify: `packages/shared/src/types/reauth-actions.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AUDIT_ACTIONS.FLOORPLAN_CREATED | FLOORPLAN_UPDATED | FLOORPLAN_DELETED | FLOORPLAN_ROOM_CREATED | FLOORPLAN_ROOM_UPDATED | FLOORPLAN_ROOM_DELETED`, and `REAUTH_ACTIONS.UPDATE_FLOORPLAN | UPDATE_FLOORPLAN_ROOM`. Task 8 uses all eight.

- [ ] **Step 1: Add the audit actions**

In `packages/shared/src/types/audit-actions.ts`, after the `INSTRUMENT_ATTRIBUTE_REMOVED` entry:

```ts
  // Floorplans and rooms. A room carries the environmental SPECIFICATION for a
  // space — who changed a temperature limit, from what, to what, is a quality
  // record and must be answerable. This is the opposite of telemetry itself,
  // which stays unaudited as process data.
  FLOORPLAN_CREATED: 'FLOORPLAN_CREATED',
  FLOORPLAN_UPDATED: 'FLOORPLAN_UPDATED',
  FLOORPLAN_DELETED: 'FLOORPLAN_DELETED',
  FLOORPLAN_ROOM_CREATED: 'FLOORPLAN_ROOM_CREATED',
  FLOORPLAN_ROOM_UPDATED: 'FLOORPLAN_ROOM_UPDATED',
  FLOORPLAN_ROOM_DELETED: 'FLOORPLAN_ROOM_DELETED',
```

- [ ] **Step 2: Add the templates**

In `packages/shared/src/types/audit-templates.ts`, add six entries under the existing `Instruments` category. Match the exact shape of the neighbouring `INSTRUMENT_*` entries in that file — read them first, then add:

```ts
  FLOORPLAN_CREATED: {
    category: 'Instruments',
    label: 'Floorplan Created',
    template: '{{userName}} created floorplan "{{targetName}}"',
  },
  FLOORPLAN_UPDATED: {
    category: 'Instruments',
    label: 'Floorplan Updated',
    template: '{{userName}} updated floorplan "{{targetName}}"',
  },
  FLOORPLAN_DELETED: {
    category: 'Instruments',
    label: 'Floorplan Deleted',
    template: '{{userName}} deleted floorplan "{{targetName}}"',
  },
  FLOORPLAN_ROOM_CREATED: {
    category: 'Instruments',
    label: 'Room Created',
    template: '{{userName}} added room "{{targetName}}" to a floorplan',
  },
  FLOORPLAN_ROOM_UPDATED: {
    category: 'Instruments',
    label: 'Room Updated',
    template: '{{userName}} updated room "{{targetName}}"',
  },
  FLOORPLAN_ROOM_DELETED: {
    category: 'Instruments',
    label: 'Room Deleted',
    template: '{{userName}} deleted room "{{targetName}}"',
  },
```

- [ ] **Step 3: Add the reauth actions**

In `packages/shared/src/types/reauth-actions.ts`, in the `Configuration` category block:

```ts
  UPDATE_FLOORPLAN: { label: 'Create / Update / Delete Floorplan', category: 'Configuration' },
  UPDATE_FLOORPLAN_ROOM: { label: 'Create / Update / Delete Room', category: 'Configuration' },
```

- [ ] **Step 4: Run the shared suite**

```bash
cd packages/shared && npx vitest run
```

Expected: PASS. If a count assertion fails (`audit-templates.test.ts` or the frozen `permission-tree` snapshot), update the expected number **in the test** to the new true count — those tests exist to force a deliberate acknowledgement, not to block the change. Do not change any count in a doc without re-running the corresponding `grep`.

- [ ] **Step 5: Rebuild the package**

```bash
npm run build -w @digilog/shared
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/audit-actions.ts packages/shared/src/types/audit-templates.ts packages/shared/src/types/reauth-actions.ts packages/shared/src/types/audit-templates.test.ts
git commit -m "feat(shared): audit and reauth actions for floorplan and room writes"
```

---

## Task 8: Floorplans module — validation and CRUD

**Files:**
- Create: `apps/api/src/modules/floorplans/validation.ts`
- Create: `apps/api/src/modules/floorplans/routes.ts`
- Create: `apps/api/src/modules/floorplans/__tests__/validation.test.ts`
- Create: `apps/api/src/e2e/floorplans.e2e.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `AUDIT_ACTIONS.FLOORPLAN_*`, `REAUTH_ACTIONS.UPDATE_FLOORPLAN*` (Task 7); `prisma.floorplan`, `prisma.floorplanRoom` (Task 6).
- Produces:
  - `roomGeometrySchema`, `roomLimitsSchema`, `createRoomSchema`, `updateRoomSchema`, `createFloorplanSchema`, `updateFloorplanSchema` (zod)
  - `validateRoomPayload(input: unknown): { ok: true; data: RoomInput } | { ok: false; error: string }`
  - `GET|POST /api/floorplans`, `GET|PUT|DELETE /api/floorplans/:id`, `POST /api/floorplans/:id/rooms`, `PUT|DELETE /api/floorplans/:id/rooms/:roomId`, `PUT /api/floorplans/:id/rooms/:roomId/instruments`

- [ ] **Step 1: Write the failing validation test**

Create `apps/api/src/modules/floorplans/__tests__/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRoomPayload } from '../validation.js';

const base = { code: 'CWH-I/142', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

describe('validateRoomPayload — geometry', () => {
  it('accepts a box inside the plan', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts a box exactly filling the plan', () => {
    expect(validateRoomPayload({ ...base, x: 0, y: 0, w: 1, h: 1 }).ok).toBe(true);
  });

  it('rejects a negative origin', () => {
    const r = validateRoomPayload({ ...base, x: -0.01 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/x/);
  });

  it('rejects a box running off the right edge', () => {
    const r = validateRoomPayload({ ...base, x: 0.9, w: 0.2 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/right edge/i);
  });

  it('rejects a box running off the bottom edge', () => {
    const r = validateRoomPayload({ ...base, y: 0.95, h: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/bottom edge/i);
  });

  it('rejects a zero-width box — an unclickable hotspot is a bug, not a choice', () => {
    expect(validateRoomPayload({ ...base, w: 0 }).ok).toBe(false);
  });

  it('rejects pixel coordinates, which is the likely mistake', () => {
    const r = validateRoomPayload({ ...base, x: 420, y: 300, w: 120, h: 80 });
    expect(r.ok).toBe(false);
  });
});

describe('validateRoomPayload — limits', () => {
  it('accepts no limits at all — a corridor has no specification', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts one bound without the other', () => {
    expect(validateRoomPayload({ ...base, tempMax: 25 }).ok).toBe(true);
  });

  it('accepts a valid range', () => {
    expect(validateRoomPayload({ ...base, tempMin: 18, tempMax: 25 }).ok).toBe(true);
  });

  it('rejects an inverted temperature range', () => {
    const r = validateRoomPayload({ ...base, tempMin: 25, tempMax: 18 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/temperature/i);
  });

  it('rejects an inverted humidity range', () => {
    const r = validateRoomPayload({ ...base, rhMin: 60, rhMax: 40 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/humidity/i);
  });

  it('rejects equal bounds — nothing could ever be in spec', () => {
    expect(validateRoomPayload({ ...base, tempMin: 20, tempMax: 20 }).ok).toBe(false);
  });

  it('rejects humidity outside 0-100', () => {
    expect(validateRoomPayload({ ...base, rhMin: -1 }).ok).toBe(false);
    expect(validateRoomPayload({ ...base, rhMax: 101 }).ok).toBe(false);
  });
});

describe('validateRoomPayload — code', () => {
  it('rejects a blank code', () => {
    expect(validateRoomPayload({ ...base, code: '   ' }).ok).toBe(false);
  });

  it('trims the code', () => {
    const r = validateRoomPayload({ ...base, code: '  CWH-I/142  ' });
    expect(r.ok && r.data.code).toBe('CWH-I/142');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/modules/floorplans/__tests__/validation.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the validation module**

Create `apps/api/src/modules/floorplans/validation.ts`:

```ts
/**
 * Geometry and limit rules for a room, as a pure function.
 *
 * These are checked here rather than as Postgres CHECK constraints so a bad
 * payload returns a 400 that names the offending field. A raw constraint
 * violation would surface in the editor as an opaque 500 that the operator
 * cannot act on.
 */
import { z } from 'zod';

const normalized = z.number().min(0).max(1);
const temperature = z.number().min(-100).max(200);
const humidity = z.number().min(0).max(100);

export const roomSchema = z.object({
  code: z.string().trim().min(1).max(60),
  label: z.string().trim().max(120).nullable().optional(),
  x: normalized,
  y: normalized,
  w: normalized.refine((v) => v > 0, 'w must be greater than 0'),
  h: normalized.refine((v) => v > 0, 'h must be greater than 0'),
  tempMin: temperature.nullable().optional(),
  tempMax: temperature.nullable().optional(),
  rhMin: humidity.nullable().optional(),
  rhMax: humidity.nullable().optional(),
});

export type RoomInput = z.infer<typeof roomSchema>;

export type ValidationResult =
  | { ok: true; data: RoomInput }
  | { ok: false; error: string };

export function validateRoomPayload(input: unknown): ValidationResult {
  const parsed = roomSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join('.') || 'payload'}: ${first.message}` };
  }
  const d = parsed.data;

  // Coordinates are normalized, so a box must finish inside the plan. Catching
  // this here also catches the likely mistake of sending pixels, which fails the
  // 0..1 bound above first.
  if (d.x + d.w > 1) {
    return { ok: false, error: 'The room runs past the right edge of the plan (x + w must be at most 1).' };
  }
  if (d.y + d.h > 1) {
    return { ok: false, error: 'The room runs past the bottom edge of the plan (y + h must be at most 1).' };
  }

  // An inverted or empty range can never be satisfied, so it is a typo rather
  // than an intent. Reject loudly instead of colouring the room red forever.
  if (d.tempMin != null && d.tempMax != null && d.tempMin >= d.tempMax) {
    return { ok: false, error: 'Minimum temperature must be below maximum temperature.' };
  }
  if (d.rhMin != null && d.rhMax != null && d.rhMin >= d.rhMax) {
    return { ok: false, error: 'Minimum humidity must be below maximum humidity.' };
  }

  return { ok: true, data: d };
}

export const floorplanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  imagePath: z.string().trim().min(1).max(500),
  imageWidth: z.number().int().min(1).max(20000),
  imageHeight: z.number().int().min(1).max(20000),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const floorplanUpdateSchema = floorplanSchema.partial();
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/modules/floorplans/__tests__/validation.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Write the routes**

Create `apps/api/src/modules/floorplans/routes.ts`. Read `apps/api/src/modules/instrument-profiles/routes.ts` first and mirror its structure exactly — the `buildContext(req)` helper, the `sanitizeStrings` call, the `errorResponses` spread, and how it threads audit context. Then:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { validateRoomPayload, floorplanSchema, floorplanUpdateSchema } from './validation.js';

/**
 * Floorplans, their rooms, and which instruments sit in each.
 *
 * Reads gate on CONFIG_READ, writes on CONFIG_UPDATE with reauth. Every write is
 * audited: a room holds the environmental SPECIFICATION for a space, so
 * "who changed this limit, from what, to what" must be answerable. Telemetry
 * itself remains unaudited — see telemetry.repository.ts.
 */
export default async function floorplanRoutes(app: FastifyInstance) {
  const auditCtx = (req: FastifyRequest) => ({
    userId: req.user?.id,
    userName: req.user?.fullName ?? req.user?.username,
    userRole: req.user?.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    sessionId: req.user?.sessionId,
  });

  const roomSelect = {
    id: true, code: true, label: true,
    x: true, y: true, w: true, h: true,
    tempMin: true, tempMax: true, rhMin: true, rhMax: true,
  } as const;

  // ---- Plans -------------------------------------------------------------

  app.get('/', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Floorplans'], summary: 'List floorplans with their rooms' },
  }, async () => {
    const data = await prisma.floorplan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { rooms: { select: roomSelect, orderBy: { code: 'asc' } } },
    });
    return { data };
  });

  app.get('/:id', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Floorplans'], summary: 'One floorplan with its rooms and their instruments' },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await prisma.floorplan.findUnique({
      where: { id },
      include: {
        rooms: {
          orderBy: { code: 'asc' },
          include: { instruments: { select: { id: true, code: true, name: true } } },
        },
      },
    });
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });
    return plan;
  });

  app.post('/', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Create a floorplan' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const parsed = floorplanSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    try {
      const plan = await prisma.floorplan.create({
        data: { ...parsed.data, createdBy: req.user?.id, updatedBy: req.user?.id },
      });
      await auditLog({
        ...auditCtx(req),
        action: 'FLOORPLAN_CREATED',
        targetType: 'Floorplan',
        targetId: plan.id,
        afterValue: plan,
      });
      return reply.code(201).send(plan);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.code(409).send({ error: 'DUPLICATE_NAME', message: `A floorplan named "${parsed.data.name}" already exists.` });
      }
      throw err;
    }
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Update a floorplan' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const before = await prisma.floorplan.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    const parsed = floorplanUpdateSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const after = await prisma.floorplan.update({
      where: { id },
      data: { ...parsed.data, updatedBy: req.user?.id },
    });
    await auditLog({
      ...auditCtx(req),
      action: 'FLOORPLAN_UPDATED',
      targetType: 'Floorplan',
      targetId: id,
      beforeValue: before,
      afterValue: after,
    });
    return after;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Delete a floorplan and its rooms' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const before = await prisma.floorplan.findUnique({ where: { id }, include: { rooms: true } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    // Rooms cascade; instruments in them are UNLINKED, never deleted
    // (Instrument.roomId is ON DELETE SET NULL). They reappear in the
    // dashboard's unplaced tray.
    await prisma.floorplan.delete({ where: { id } });
    await auditLog({
      ...auditCtx(req),
      action: 'FLOORPLAN_DELETED',
      targetType: 'Floorplan',
      targetId: id,
      beforeValue: before,
    });
    return reply.code(204).send();
  });

  // ---- Rooms -------------------------------------------------------------

  app.post('/:id/rooms', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Add a room to a floorplan' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const plan = await prisma.floorplan.findUnique({ where: { id }, select: { id: true } });
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    const result = validateRoomPayload(sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []));
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });

    try {
      const room = await prisma.floorplanRoom.create({
        data: { ...result.data, floorplanId: id, createdBy: req.user?.id, updatedBy: req.user?.id },
      });
      await auditLog({
        ...auditCtx(req),
        action: 'FLOORPLAN_ROOM_CREATED',
        targetType: 'FloorplanRoom',
        targetId: room.id,
        afterValue: room,
      });
      return reply.code(201).send(room);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.code(409).send({ error: 'DUPLICATE_CODE', message: `This plan already has a room "${result.data.code}".` });
      }
      throw err;
    }
  });

  app.put('/:id/rooms/:roomId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Update a room' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const before = await prisma.floorplanRoom.findFirst({ where: { id: roomId, floorplanId: id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });

    const result = validateRoomPayload(sanitizeStrings((req.body ?? {}) as Record<string, unknown>, []));
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });

    const after = await prisma.floorplanRoom.update({
      where: { id: roomId },
      data: { ...result.data, updatedBy: req.user?.id },
    });
    await auditLog({
      ...auditCtx(req),
      action: 'FLOORPLAN_ROOM_UPDATED',
      targetType: 'FloorplanRoom',
      targetId: roomId,
      beforeValue: before,
      afterValue: after,
    });
    return after;
  });

  app.delete('/:id/rooms/:roomId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Delete a room' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const before = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      include: { instruments: { select: { id: true, code: true } } },
    });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });

    await prisma.floorplanRoom.delete({ where: { id: roomId } });
    await auditLog({
      ...auditCtx(req),
      action: 'FLOORPLAN_ROOM_DELETED',
      targetType: 'FloorplanRoom',
      targetId: roomId,
      beforeValue: before,
    });
    return reply.code(204).send();
  });

  // PUT /:id/rooms/:roomId/instruments — set the room's membership wholesale.
  //
  // Wholesale rather than add/remove: the editor shows a checkbox list and the
  // operator's intent is "these are the instruments in this room". A diffing API
  // would make the client responsible for computing that diff, and a client that
  // computes it wrong silently unplaces an instrument.
  app.put('/:id/rooms/:roomId/instruments', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: { tags: ['Floorplans'], summary: 'Set which instruments are in a room' },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const room = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      include: { instruments: { select: { id: true, code: true } } },
    });
    if (!room) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });

    const body = (req.body ?? {}) as { instrumentIds?: unknown };
    if (!Array.isArray(body.instrumentIds) || body.instrumentIds.some((v) => typeof v !== 'string')) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'instrumentIds must be an array of instrument ids.' });
    }
    const wanted = body.instrumentIds as string[];

    const found = await prisma.instrument.findMany({
      where: { id: { in: wanted } }, select: { id: true },
    });
    if (found.length !== wanted.length) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'One or more instrument ids do not exist.' });
    }

    // One transaction: unlink everything currently here, then link the wanted
    // set. An instrument already in ANOTHER room is MOVED — roomId is single-
    // valued, so being in two rooms is not representable and the move is the
    // only honest interpretation. The response says which ones moved so the UI
    // can tell the operator.
    const movedFrom = await prisma.instrument.findMany({
      where: { id: { in: wanted }, roomId: { not: null }, NOT: { roomId } },
      select: { id: true, code: true, room: { select: { id: true, code: true } } },
    });

    await prisma.$transaction([
      prisma.instrument.updateMany({ where: { roomId }, data: { roomId: null } }),
      prisma.instrument.updateMany({ where: { id: { in: wanted } }, data: { roomId } }),
    ]);

    await auditLog({
      ...auditCtx(req),
      action: 'FLOORPLAN_ROOM_UPDATED',
      targetType: 'FloorplanRoom',
      targetId: roomId,
      beforeValue: { instruments: room.instruments },
      afterValue: { instrumentIds: wanted },
    });

    return {
      roomId,
      instrumentIds: wanted,
      moved: movedFrom.map((i) => ({ id: i.id, code: i.code, fromRoom: i.room })),
    };
  });
}
```

> `enforceReauth` vs `enforceReauthAlways`: use `enforceReauth` (admin-configurable) here, matching every other Configuration-category write. Read `apps/api/src/lib/reauth-check.ts` and confirm the exported name and return shape before relying on `const { ok } = ...`.

- [ ] **Step 6: Register the module**

In `apps/api/src/app.ts`, next to the other admin route registrations:

```ts
import floorplanRoutes from './modules/floorplans/routes.js';
```

```ts
await app.register(floorplanRoutes, { prefix: '/api/floorplans' });
```

- [ ] **Step 7: Write the e2e test**

Create `apps/api/src/e2e/floorplans.e2e.test.ts` covering, with its own unique SUPER_ADMIN provisioned in `beforeAll`:

1. `POST /api/floorplans` returns 201 and writes a `FLOORPLAN_CREATED` audit row.
2. A duplicate plan name returns 409.
3. `POST /:id/rooms` returns 201 and writes `FLOORPLAN_ROOM_CREATED`.
4. A room with `x: 0.9, w: 0.2` returns 400 with a message mentioning "right edge".
5. A room with `tempMin: 25, tempMax: 18` returns 400 mentioning temperature.
6. A duplicate room code on the same plan returns 409; the same code on a **different** plan returns 201.
7. `PUT /:id/rooms/:roomId` writes a `FLOORPLAN_ROOM_UPDATED` audit row whose `beforeValue` holds the old limits and `afterValue` the new.
8. `PUT /:id/rooms/:roomId/instruments` sets membership, and calling it again with a subset unlinks the omitted instrument (its `roomId` becomes null; the instrument still exists).
9. Assigning an instrument already in room A to room B moves it and reports it in `moved`.
10. `DELETE /:id` cascades its rooms and leaves the instruments alive with `roomId = null`.
11. A user holding only `CONFIG_READ` gets 403 on every write.

Assert audit rows by querying `prisma.auditTrail.findFirst({ where: { targetId, action }, orderBy: { timestamp: 'desc' } })`. Read an existing e2e file that asserts audit rows (`apps/api/src/e2e/instruments.test.ts`) and copy its assertion style.

- [ ] **Step 8: Run the tests and typecheck**

```bash
cd apps/api && npx vitest run src/e2e/floorplans.e2e.test.ts src/modules/floorplans --pool=forks --poolOptions.forks.singleFork=true
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: all pass; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/floorplans apps/api/src/e2e/floorplans.e2e.test.ts apps/api/src/app.ts
git commit -m "feat(api): floorplan and room CRUD with audited, reauth-gated writes"
```

---

## Task 9: Plan image upload

**Files:**
- Modify: `apps/api/src/modules/uploads/routes.ts`
- Modify: `apps/api/src/app.ts` (static serve path, only if plans need a directory the existing serve does not cover)

**Interfaces:**
- Consumes: `UPLOADS_ROOT` from `apps/api/src/lib/uploads-dir.js`.
- Produces: `POST /api/uploads/floorplan` → `{ url: string; width: number; height: number }`. Task 10 posts to it.

- [ ] **Step 1: Read the existing photo upload handler**

Read `apps/api/src/modules/uploads/routes.ts` in full. The new handler mirrors it: same multipart handling, same `ALLOWED_TYPES` / `MAX_FILE_SIZE` mechanism, same write-to-disk-and-return-URL shape.

- [ ] **Step 2: Add the handler**

In `apps/api/src/modules/uploads/routes.ts`, add the directory next to `profilePhotosDir`:

```ts
const floorplansDir = path.join(UPLOADS_ROOT, 'floorplans');
```

include it in `ensureDirectories()`, and add:

```ts
  // POST /api/uploads/floorplan — a floorplan background image.
  //
  // Gated on CONFIG_UPDATE, unlike /photo: this is not self-service, it writes a
  // shared asset every user will see, and it costs disk that nothing reclaims.
  //
  // Dimensions come from the CLIENT, which has already loaded the image to
  // display it. Reading them server-side would mean an image-decoding
  // dependency for a value the browser already knows, and the value is only ever
  // used as the aspect ratio the normalized room coordinates are drawn against —
  // a wrong value distorts the operator's own editor immediately and visibly.
  app.post('/floorplan', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      tags: ['Uploads'],
      summary: 'Upload a floorplan background image',
    },
  }, async (req, reply) => {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'NO_FILE', message: 'No image was uploaded.' });
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return reply.code(400).send({ error: 'BAD_TYPE', message: `Allowed image types: ${ALLOWED_TYPES.join(', ')}` });
    }

    const buf = await file.toBuffer();
    if (buf.length > MAX_FILE_SIZE) {
      return reply.code(413).send({ error: 'TOO_LARGE', message: `Maximum image size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB.` });
    }

    const ext = path.extname(file.filename || '').toLowerCase() || '.png';
    const name = `${randomUUID()}${ext}`;
    await writeFile(path.join(floorplansDir, name), buf);

    return { url: `/uploads/floorplans/${name}` };
  });
```

- [ ] **Step 3: Confirm the static serve covers it**

In `apps/api/src/app.ts`, find the `@fastify/static` registration serving `/uploads/photos/` and the auth-hook public allowlist entry for it. Extend both to cover `/uploads/floorplans/` the same way. If the serve root is already `UPLOADS_ROOT` with prefix `/uploads/`, nothing is needed beyond the allowlist entry.

**Verify by fetching an uploaded plan in a logged-out browser tab** — if it 401s, the allowlist entry is missing and every plan image will be a broken `<img>`.

- [ ] **Step 4: Manual verification**

```bash
curl -sk -X POST https://localhost:3000/api/uploads/floorplan \
  --ssl-revoke-best-effort \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/c/Users/hello/compliance-core/plan.png"
```

Expected: `{"url":"/uploads/floorplans/<uuid>.png"}`, and that URL renders in a browser tab with no auth header.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/uploads/routes.ts apps/api/src/app.ts
git commit -m "feat(api): floorplan image upload"
```

---

## Task 10: Placement editor

**Files:**
- Create: `apps/web/src/routes/config/floorplans.tsx`
- Modify: `apps/web/src/routes/config/index.tsx`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: `/api/floorplans*` (Task 8), `POST /api/uploads/floorplan` (Task 9), `GET /api/instruments` (existing).
- Produces: the UI that creates the room records every later task renders.

- [ ] **Step 1: Convert the PDF to a plan image**

```bash
cd /c/Users/hello/compliance-core
pdftocairo -png -r 150 -singlefile "CWH 3RD floor Pantry-DP.pdf" cwh-3rd-floor
```

If `pdftocairo` is unavailable, any PDF-to-PNG route is fine — this is a one-off asset conversion, not part of the build. Note the pixel dimensions; they are what gets posted as `imageWidth` / `imageHeight`.

- [ ] **Step 2: Build the editor page**

Create `apps/web/src/routes/config/floorplans.tsx`. It has three parts:

**a. Plan list + upload.** A sidebar listing plans from `GET /api/floorplans`, with an upload control that posts the image to `POST /api/uploads/floorplan`, reads the natural dimensions from an `Image()` in the browser, then `POST /api/floorplans` with `{ name, imagePath: url, imageWidth, imageHeight }`.

**b. The canvas.** The selected plan's image at `width: 100%`, wrapped in a `position: relative` container. Each room renders as an absolutely-positioned `div` at `left: x*100%, top: y*100%, width: w*100%, height: h*100%`. Dragging on empty canvas draws a new box; dragging a box moves it; dragging its bottom-right corner resizes it. Convert pointer coordinates to normalized with the container's `getBoundingClientRect()`:

```tsx
function toNormalized(e: React.PointerEvent, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}
```

Clamping here is what keeps the client from ever posting geometry the server will reject.

**c. The room panel.** For the selected room: code, label, the four limit inputs, and a checkbox list of instruments from `GET /api/instruments`. Saving posts `PUT /api/floorplans/:id/rooms/:roomId` then `PUT .../instruments`. When the instruments response returns a non-empty `moved` array, show a toast naming each instrument and the room it came from — the operator must not discover a silent move later.

Follow the existing config-page conventions: `useToast` for feedback (never `alert()`), `useReauth` + `ReauthDialog` because these endpoints enforce reauth, and light-theme classes throughout. Read `apps/web/src/routes/config/instrument-attributes.tsx` first and match its page shell, save-button placement and reauth wiring.

- [ ] **Step 3: Add the config card**

In `apps/web/src/routes/config/index.tsx`, next to the Telemetry Keys card:

```tsx
  {
    title: 'Floorplans',
    description: 'Upload floor layouts, place rooms on them and set each room’s temperature and humidity limits',
    href: '/config/floorplans',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4h16v16H4zM4 10h16M10 10v10" />
      </svg>
    ),
    gradient: 'from-indigo-500 to-violet-600',
    shadowColor: 'shadow-indigo-500/25',
  },
```

- [ ] **Step 4: Add the route**

In `apps/web/src/main.tsx`, add a lazy route beside the other config routes, wrapped in the same `<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}>` guard the neighbouring config routes use. Match the surrounding pattern exactly.

- [ ] **Step 5: Verify in the browser**

Open `http://localhost:5175/config/floorplans`:

- Upload `cwh-3rd-floor.png`, name it "CWH — 3rd Floor". It appears in the list and renders.
- Drag a box over the WET LAB area, code it `CWH-I/142`, label it `WET LAB`, set temperature 18–25 and humidity 40–60, tick `DEMO-TH-142`. Save.
- Reload. The box is in the same place at the same size — this is what proves the coordinates are normalized rather than pixel-dependent.
- Resize the browser window; the box tracks the image.
- Add `CWH-I/220` with `DEMO-TH-220`, and `CWH-I/347` with `DEMO-TH-347` (the drifting one) with temperature max 25.
- Try to save a room with min 25 / max 18 — the server's message appears in a toast, not a raw error.
- Tick `DEMO-TH-142` into a second room — the move toast names the room it came from.
- **The browser console is clean.**

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/config/floorplans.tsx apps/web/src/routes/config/index.tsx apps/web/src/main.tsx
git commit -m "feat(web): floorplan placement editor"
```

---

## Task 11: Room history endpoint

**Files:**
- Create: `apps/api/src/modules/floorplans/room-history.ts`
- Modify: `apps/api/src/modules/floorplans/routes.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts`
- Create: `apps/api/src/e2e/room-history.e2e.test.ts`

**Interfaces:**
- Consumes: `parseTelemetryAliases` (Task 1), `prisma.floorplanRoom` (Task 6).
- Produces:
  - `type HistoryWindow = '15m' | '1h' | '6h' | '24h' | '7d'`
  - `WINDOW_SPEC: Record<HistoryWindow, { ms: number; bucketSec: number | null }>`
  - `getRoomHistory(roomId: string, window: HistoryWindow): Promise<{ from: string; to: string; bucketSeconds: number | null; series: Series[] }>`
  - `interface Series { instrumentId: string; instrumentCode: string; slot: 'temperature' | 'humidity'; key: string; points: { ts: string; value: number }[] }`
  - `GET /api/floorplans/:id/rooms/:roomId/history?window=`
  - `GET /api/instruments/:id/telemetry` gains `from` / `to`

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/src/e2e/room-history.e2e.test.ts` covering:

1. A room with two instruments returns up to four series (2 instruments × 2 slots), each with `instrumentCode` and `slot` set.
2. A slot with no readings produces **no series** rather than an empty one — a chart with no data must not render an empty axis.
3. `window=15m` returns `bucketSeconds: null` and raw points.
4. `window=7d` returns a non-null `bucketSeconds` and at most 500 points per series.
5. Points are ordered oldest-first (charts draw left to right).
6. An unknown `window` value returns 400.
7. A room on a different plan than `:id` returns 404.
8. Requires `INSTRUMENT_READ`.

Seed history by inserting directly into `instrument_telemetry_history` via `prisma.$executeRaw` with controlled timestamps — the ingest endpoint stamps `now()` and cannot produce a 7-day spread.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/api && npx vitest run src/e2e/room-history.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

Expected: FAIL — route 404s.

- [ ] **Step 3: Write the query module**

Create `apps/api/src/modules/floorplans/room-history.ts`:

```ts
/**
 * Every instrument in one room, both slots, one request.
 *
 * A three-instrument room would otherwise poll six per-instrument endpoints
 * every few seconds while its chart panel is open.
 *
 * Raw SQL because instrument_telemetry_history is PARTITIONED, which Prisma
 * cannot express — the same reason telemetry.repository.ts is raw.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  parseTelemetryAliases,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type TelemetrySlot,
} from '@digilog/shared';

export type HistoryWindow = '15m' | '1h' | '6h' | '24h' | '7d';

/**
 * bucketSec null = return raw rows. Above six hours the raw row count stops
 * being drawable (a 7-day window at a 10-second interval is ~60k points per
 * series) and no browser should receive it, so those windows are averaged into
 * buckets chosen to land near 500 points.
 */
export const WINDOW_SPEC: Record<HistoryWindow, { ms: number; bucketSec: number | null }> = {
  '15m': { ms: 15 * 60_000, bucketSec: null },
  '1h':  { ms: 60 * 60_000, bucketSec: null },
  '6h':  { ms: 6 * 3_600_000, bucketSec: null },
  '24h': { ms: 24 * 3_600_000, bucketSec: 180 },    // 480 points
  '7d':  { ms: 7 * 86_400_000, bucketSec: 1_260 },  // 480 points
};

export const HISTORY_WINDOWS = Object.keys(WINDOW_SPEC) as HistoryWindow[];

export interface SeriesPoint { ts: string; value: number }

export interface Series {
  instrumentId: string;
  instrumentCode: string;
  slot: TelemetrySlot;
  key: string;
  points: SeriesPoint[];
}

interface RawPoint { instrumentId: string; key: string; ts: Date; value: number }

async function slotAliases(): Promise<Record<TelemetrySlot, string[]>> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    temperature: parseTelemetryAliases((cfg.temperatureKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.temperature),
    humidity: parseTelemetryAliases((cfg.humidityKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.humidity),
  };
}

export async function getRoomHistory(roomId: string, window: HistoryWindow) {
  const spec = WINDOW_SPEC[window];
  const to = new Date();
  const from = new Date(to.getTime() - spec.ms);

  const instruments = await prisma.instrument.findMany({
    where: { roomId },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (instruments.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const aliases = await slotAliases();
  const allKeys = [...new Set([...aliases.temperature, ...aliases.humidity])];
  if (allKeys.length === 0) {
    return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: spec.bucketSec, series: [] };
  }

  const ids = instruments.map((i) => i.id);

  // `value` is jsonb. Only numeric readings can be plotted, so filter to
  // jsonb_typeof = 'number' IN SQL rather than fetching everything and dropping
  // the rest in JS — a device sending a status string would otherwise be
  // transferred in full every poll just to be discarded.
  const rows = spec.bucketSec === null
    ? await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key, ts, (value #>> '{}')::float8 AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND jsonb_typeof(value) = 'number'
        ORDER BY ts ASC`
    : await prisma.$queryRaw<RawPoint[]>`
        SELECT instrument_id AS "instrumentId", key,
               to_timestamp(floor(extract(epoch FROM ts) / ${spec.bucketSec}) * ${spec.bucketSec}) AS ts,
               avg((value #>> '{}')::float8) AS value
        FROM instrument_telemetry_history
        WHERE instrument_id = ANY(${ids}::text[])
          AND lower(key) = ANY(${allKeys}::text[])
          AND ts >= ${from} AND ts <= ${to}
          AND jsonb_typeof(value) = 'number'
        GROUP BY instrument_id, key, 3
        ORDER BY 3 ASC`;

  const codeOf = new Map(instruments.map((i) => [i.id, i.code]));
  const slotOf = (key: string): TelemetrySlot | null => {
    const k = key.toLowerCase();
    if (aliases.temperature.includes(k)) return 'temperature';
    if (aliases.humidity.includes(k)) return 'humidity';
    return null;
  };

  // Group by (instrument, key). A series exists only where points exist — an
  // empty series would render as a chart with axes and no line, which reads as
  // "flat" rather than "nothing here".
  const grouped = new Map<string, Series>();
  for (const r of rows) {
    const slot = slotOf(r.key);
    if (slot === null) continue;
    const gk = `${r.instrumentId}|${r.key}`;
    let s = grouped.get(gk);
    if (!s) {
      s = {
        instrumentId: r.instrumentId,
        instrumentCode: codeOf.get(r.instrumentId) ?? r.instrumentId,
        slot,
        key: r.key,
        points: [],
      };
      grouped.set(gk, s);
    }
    s.points.push({ ts: r.ts.toISOString(), value: r.value });
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds: spec.bucketSec,
    series: [...grouped.values()].sort(
      (a, b) => a.instrumentCode.localeCompare(b.instrumentCode) || a.slot.localeCompare(b.slot),
    ),
  };
}
```

> Verify the jsonb-to-float cast against how `telemetry.repository.ts` writes values (`JSON.stringify(value)::jsonb`). If `value #>> '{}'` does not cast cleanly for numbers, use `(value)::text::float8` — test it in `psql` before committing, do not guess.

- [ ] **Step 4: Mount the route**

In `apps/api/src/modules/floorplans/routes.ts`:

```ts
import { getRoomHistory, HISTORY_WINDOWS, type HistoryWindow } from './room-history.js';
```

```ts
  // Gated on INSTRUMENT_READ, not CONFIG_READ: this returns telemetry, and
  // anyone who may see the dashboard may see it. Only the geometry/limit WRITES
  // are a configuration capability.
  app.get('/:id/rooms/:roomId/history', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Time-series for every instrument in one room',
      querystring: {
        type: 'object',
        properties: { window: { type: 'string', enum: HISTORY_WINDOWS, default: '1h' } },
      },
    },
  }, async (req, reply) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const q = req.query as { window?: string };
    const window = (q.window ?? '1h') as HistoryWindow;
    if (!HISTORY_WINDOWS.includes(window)) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `window must be one of: ${HISTORY_WINDOWS.join(', ')}` });
    }
    const room = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      select: { id: true, code: true, label: true, tempMin: true, tempMax: true, rhMin: true, rhMax: true },
    });
    if (!room) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });

    const history = await getRoomHistory(roomId, window);
    return { room, ...history };
  });
```

- [ ] **Step 5: Expose `from`/`to` on the per-instrument endpoint**

In `apps/api/src/modules/instruments/routes.ts`, in the `GET /:id/telemetry` handler, add to the querystring schema:

```ts
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
```

and pass them through — `getHistory()` already accepts both, the route simply never surfaced them:

```ts
    const q = req.query as { key?: string; limit?: number; from?: string; to?: string };
    ...
      getHistory({
        instrumentId: id,
        key: q.key,
        limit,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      }),
```

This is additive: existing callers that pass neither are unaffected.

- [ ] **Step 6: Run the tests and typecheck**

```bash
cd apps/api && npx vitest run src/e2e/room-history.e2e.test.ts src/e2e/instruments.test.ts --pool=forks --poolOptions.forks.singleFork=true
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: new tests pass, the existing instruments suite still passes, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/floorplans/room-history.ts apps/api/src/modules/floorplans/routes.ts apps/api/src/modules/instruments/routes.ts apps/api/src/e2e/room-history.e2e.test.ts
git commit -m "feat(api): bucketed per-room telemetry history"
```

---

## Task 12: Time-series chart

**Files:**
- Create: `apps/web/src/routes/dashboard/time-series-chart.tsx`
- Create: `apps/web/src/routes/dashboard/__tests__/chart-scale.test.ts`

**Interfaces:**
- Consumes: `Series` shape from Task 11.
- Produces:
  - `niceScale(min: number, max: number, ticks?: number): { min: number; max: number; step: number; ticks: number[] }`
  - `<TimeSeriesChart series={...} limits={...} unit="°C" />`

> **REQUIRED: load the `dataviz` skill before writing any chart code in this task.** It triggers explicitly on inline-SVG plotting, and this chart is hand-rolled SVG. Read it first; it governs the axis, colour and legend decisions below.

- [ ] **Step 1: Write the failing scale test**

Create `apps/web/src/routes/dashboard/__tests__/chart-scale.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { niceScale } from '../time-series-chart';

describe('niceScale', () => {
  it('rounds to human tick values', () => {
    const s = niceScale(18.3, 24.7);
    expect(s.min).toBeLessThanOrEqual(18.3);
    expect(s.max).toBeGreaterThanOrEqual(24.7);
    expect(s.ticks.every((t) => Number.isFinite(t))).toBe(true);
  });

  it('never returns a zero or negative step', () => {
    expect(niceScale(20, 20).step).toBeGreaterThan(0);
  });

  it('gives a flat series visible range rather than a degenerate axis', () => {
    const s = niceScale(22, 22);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it('handles a negative range', () => {
    const s = niceScale(-20, -5);
    expect(s.min).toBeLessThanOrEqual(-20);
    expect(s.max).toBeGreaterThanOrEqual(-5);
  });

  it('produces ascending ticks within the range', () => {
    const s = niceScale(0, 100);
    expect(s.ticks).toEqual([...s.ticks].sort((a, b) => a - b));
    expect(s.ticks[0]).toBeGreaterThanOrEqual(s.min);
    expect(s.ticks[s.ticks.length - 1]).toBeLessThanOrEqual(s.max);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/web && npx vitest run src/routes/dashboard/__tests__/chart-scale.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the chart**

Create `apps/web/src/routes/dashboard/time-series-chart.tsx` exporting `niceScale` and a `TimeSeriesChart` component. Requirements, all of which the `dataviz` skill's guidance governs:

- Pure inline SVG with a `viewBox` and `width: 100%` so it is responsive. No dependency.
- One `<path>` per series. Series colours come from a fixed categorical palette (per the dataviz skill), **not** from status colours — a line's colour identifies the instrument, and reusing red would collide with "out of spec".
- The room's limits render as a shaded in-spec band behind the lines with labelled edges, so out-of-spec excursions are visible as geometry rather than needing a legend lookup.
- Y axis from `niceScale` over the data range **unioned with the limit band**, so a limit just outside the data range is still visible.
- X axis with time labels appropriate to the window (clock time under 24h, date+time above).
- Hover shows a vertical rule and a readout of every series' value at that time.
- Empty state: when `series` is empty, render a message, not axes. A chart with axes and no line reads as "flat", which is a lie.
- `aria-label` describing the chart, and the underlying numbers reachable — the table view is the accessible equivalent and should be linked in the empty/hover affordance.

```ts
/**
 * Round an axis range to human tick values.
 *
 * A flat series (min === max) gets an artificial range: a zero-height axis
 * divides by zero and renders every point on the same pixel row, which looks
 * identical to a broken chart.
 */
export function niceScale(min: number, max: number, ticks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (min === max) { min -= 1; max += 1; }
  const rawStep = (max - min) / Math.max(1, ticks);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let t = niceMin; t <= niceMax + step / 2; t += step) out.push(+t.toFixed(6));
  return { min: niceMin, max: niceMax, step, ticks: out };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && npx vitest run src/routes/dashboard/__tests__/chart-scale.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dashboard/time-series-chart.tsx apps/web/src/routes/dashboard/__tests__/chart-scale.test.ts
git commit -m "feat(web): hand-rolled SVG time-series chart"
```

---

## Task 13: Graphical view and room detail

**Files:**
- Create: `apps/web/src/routes/dashboard/floorplan-view.tsx`
- Create: `apps/web/src/routes/dashboard/room-detail.tsx`
- Modify: `apps/web/src/routes/dashboard/index.tsx`
- Modify: `apps/web/src/routes/dashboard/use-telemetry.ts`

**Interfaces:**
- Consumes: `GET /api/floorplans` (Task 8), `GET /api/floorplans/:id/rooms/:roomId/history` (Task 11), `useTelemetryOverview` (Task 5), `worstStatus` (Task 1), `statusClasses` (Task 5), `TimeSeriesChart` (Task 12).
- Produces: `<FloorplanView />`, `<RoomDetail floorplanId roomId onBack />`, `useFloorplans()`, `useRoomHistory(floorplanId, roomId, window)`.

- [ ] **Step 1: Add the two hooks**

Append to `apps/web/src/routes/dashboard/use-telemetry.ts`:

```ts
export interface FloorplanRoomShape {
  id: string; code: string; label: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
}

export interface FloorplanShape {
  id: string; name: string;
  imagePath: string; imageWidth: number; imageHeight: number;
  isActive: boolean; sortOrder: number;
  rooms: FloorplanRoomShape[];
}

export function useFloorplans() {
  const { data, error, isLoading } = useSWR<{ data: FloorplanShape[] }>('/api/floorplans', {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
  return { plans: data?.data ?? [], isLoading, error };
}

export type HistoryWindow = '15m' | '1h' | '6h' | '24h' | '7d';

export interface HistorySeries {
  instrumentId: string; instrumentCode: string;
  slot: 'temperature' | 'humidity'; key: string;
  points: { ts: string; value: number }[];
}

export function useRoomHistory(floorplanId: string, roomId: string, window: HistoryWindow) {
  const { chartRefreshMs } = useTelemetrySettings();
  const { data, error, isLoading } = useSWR<{
    room: FloorplanRoomShape;
    from: string; to: string; bucketSeconds: number | null;
    series: HistorySeries[];
  }>(`/api/floorplans/${floorplanId}/rooms/${roomId}/history?window=${window}`, {
    refreshInterval: chartRefreshMs,
    revalidateOnFocus: true,
  });
  return { history: data, isLoading, error };
}
```

- [ ] **Step 2: Build the floorplan view**

Create `apps/web/src/routes/dashboard/floorplan-view.tsx`:

- Plan picker (`<select>`) over `useFloorplans()`, defaulting to the lowest `sortOrder`. Render nothing but a call-to-action linking to `/config/floorplans` when there are no plans.
- The plan image inside a `position: relative` container at `width: 100%`, with `aspectRatio: imageWidth / imageHeight` so the box overlay never drifts while the image loads.
- For each room, an absolutely-positioned button at `left: x*100%, top: y*100%, width: w*100%, height: h*100%`, showing room code, temperature and RH, styled from `statusClasses(worstStatus(statusesOfItsInstruments))` — group `useTelemetryOverview()` rows by `row.room?.id`.
- A room with no instruments renders grey and is still clickable (it shows its limits and an empty state).
- **The unplaced tray** below the plan: every row with `room === null`, as compact cards with the same status treatment. Never omit these.
- A "Readings update every Ns" line so polling is stated, not implied.
- Clicking a room calls `onOpenRoom(roomId)`.

- [ ] **Step 3: Build the room detail**

Create `apps/web/src/routes/dashboard/room-detail.tsx`:

- Header: room code, label, its four limits rendered as "18.0 – 25.0 °C · 40 – 60 %RH" (or "No limits set"), and a Back control.
- The plan cropped to this room: reuse the plan image inside a container with `transform: scale()` and a negative offset derived from the room's normalized box, so the operator sees where they are.
- One card per instrument: code, name, current temperature and RH from `useTelemetryOverview()`, status badge, reading age.
- Window selector (15m / 1h / 6h / 24h / 7d), then `<TimeSeriesChart>` for temperature and another for humidity, each fed the matching `series` and the room's limit band.
- Empty state when the room has no instruments, linking to `/config/floorplans` to add some.

- [ ] **Step 4: Wire it into the dashboard**

In `apps/web/src/routes/dashboard/index.tsx`, replace the Task 5 placeholder:

```tsx
import { FloorplanView } from './floorplan-view';
```

```tsx
          {view === 'graphical' && showCard('telemetry_floorplan') && <FloorplanView />}
```

`FloorplanView` owns the selected-room state and renders `<RoomDetail>` in place of the plan when a room is open. **Confirm the Task 5 placeholder string no longer exists anywhere:**

```bash
grep -rn "arrives in Task" apps/web/src
```

Expected: no output.

- [ ] **Step 5: Verify in the browser**

With the API, Vite and the Task 4 publisher running, open `http://localhost:5175/` → **Graphical view**:

- The CWH plan renders with the three placed room boxes at the right positions.
- `CWH-I/142` and `CWH-I/220` are green; readings update every ~5s.
- Watch `CWH-I/347` drift past 25 °C and turn **red** — this is the check that the whole feature exists for.
- `DEMO-TH-361` appears in the unplaced tray as amber (Not reporting).
- Resize the window: boxes track the image at every size.
- Click `CWH-I/142`: room detail opens, both charts draw, the in-spec band is visible, hover shows values, the window selector redraws.
- Click a room with no instruments: an empty state, not a broken chart.
- Back returns to the plan.
- **The browser console is clean throughout** — no errors, no failed requests, no key warnings.

- [ ] **Step 6: Run the web suite and typecheck**

```bash
cd apps/web && npm test
npx tsc -p apps/web/tsconfig.json --noEmit
```

Expected: all pass, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/dashboard
git commit -m "feat(web): floorplan dashboard view with per-room live time-series"
```

---

## Task 14: Retire the limit attribute keys

Runs last, deliberately: rooms must exist before a limit value has anywhere to go.

**Files:**
- Create: `apps/api/prisma/migrations/20260811130000_retire_limit_attributes/migration.sql`
- Create: `apps/api/src/e2e/limit-attribute-retirement.e2e.test.ts`

**Interfaces:**
- Consumes: `floorplan_rooms` (Task 6).
- Produces: nothing importable.

- [ ] **Step 1: Survey the live data before writing anything**

```bash
export PGPASSWORD=digilog123
psql -h localhost -U digilog -d compliance_core_db -c "
  SELECT ia.key, ia.value, i.code, i.room_id
  FROM instrument_attributes ia JOIN instruments i ON i.id = ia.instrument_id
  WHERE ia.key IN ('Low Temperature Limit','High Temperature Limit','Low Humidity Limit','High Humidity Limit');"
```

Record the output in the commit message. The spec's claim of "exactly one matching row" was true at spec time; **verify it is still true**, and if it is not, confirm the collision rule below still covers what is there.

- [ ] **Step 2: Write the migration**

Create `apps/api/prisma/migrations/20260811130000_retire_limit_attributes/migration.sql`:

```sql
-- Retire the four spec-limit instrument attributes.
--
-- Limits now live on floorplan_rooms: a cleanroom's specification belongs to the
-- room, not to whichever probe is bolted to its wall. See
-- docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md §3.
--
-- Runs AFTER 20260811120000_instrument_floorplans, so rooms exist to migrate into.

-- 1. Copy each parseable value onto the room of the instrument that carries it,
--    but ONLY where every instrument in that room agrees. Where two instruments
--    in one room assert different values, the room is left unset and the rows
--    survive for manual resolution — silently picking one would invent a
--    specification nobody wrote.
WITH parsed AS (
  SELECT i.room_id,
         ia.key,
         (ia.value)::float8 AS num
  FROM instrument_attributes ia
  JOIN instruments i ON i.id = ia.instrument_id
  WHERE i.room_id IS NOT NULL
    AND ia.key IN ('Low Temperature Limit','High Temperature Limit','Low Humidity Limit','High Humidity Limit')
    -- Free text: only a clean number migrates. Anything else stays put.
    AND ia.value ~ '^\s*-?\d+(\.\d+)?\s*$'
),
agreed AS (
  SELECT room_id, key, min(num) AS num
  FROM parsed
  GROUP BY room_id, key
  HAVING count(DISTINCT num) = 1
)
UPDATE floorplan_rooms r SET
  temp_min = COALESCE(r.temp_min, (SELECT num FROM agreed a WHERE a.room_id = r.id AND a.key = 'Low Temperature Limit')),
  temp_max = COALESCE(r.temp_max, (SELECT num FROM agreed a WHERE a.room_id = r.id AND a.key = 'High Temperature Limit')),
  rh_min   = COALESCE(r.rh_min,   (SELECT num FROM agreed a WHERE a.room_id = r.id AND a.key = 'Low Humidity Limit')),
  rh_max   = COALESCE(r.rh_max,   (SELECT num FROM agreed a WHERE a.room_id = r.id AND a.key = 'High Humidity Limit'))
WHERE EXISTS (SELECT 1 FROM agreed a WHERE a.room_id = r.id);

-- 2. Delete only the rows that were successfully migrated. A value that could
--    not be parsed, or whose instrument is unplaced, or that collided, SURVIVES
--    for manual review — deleting data we could not carry over would be a
--    silent loss of a quality record.
DELETE FROM instrument_attributes ia
USING instruments i, floorplan_rooms r
WHERE ia.instrument_id = i.id
  AND i.room_id = r.id
  AND ia.key IN ('Low Temperature Limit','High Temperature Limit','Low Humidity Limit','High Humidity Limit')
  AND ia.value ~ '^\s*-?\d+(\.\d+)?\s*$'
  AND (
    (ia.key = 'Low Temperature Limit'  AND r.temp_min = (ia.value)::float8) OR
    (ia.key = 'High Temperature Limit' AND r.temp_max = (ia.value)::float8) OR
    (ia.key = 'Low Humidity Limit'     AND r.rh_min   = (ia.value)::float8) OR
    (ia.key = 'High Humidity Limit'    AND r.rh_max   = (ia.value)::float8)
  );

-- 3. Strip the four keys from every profile's prompt list, so no new instrument
--    is asked for them. The `* Range` keys are NOT touched — those describe the
--    DEVICE's measurement capability, which genuinely is a per-instrument fact.
UPDATE instrument_profiles SET attribute_keys = (
  SELECT string_agg(line, E'\n' ORDER BY ord)
  FROM unnest(string_to_array(attribute_keys, E'\n')) WITH ORDINALITY AS t(line, ord)
  WHERE btrim(line) NOT IN ('Low Temperature Limit','High Temperature Limit','Low Humidity Limit','High Humidity Limit')
)
WHERE attribute_keys IS NOT NULL
  AND attribute_keys ~ '(Low|High) (Temperature|Humidity) Limit';
```

> **The audited deletion cannot be done in SQL** — `auditLog()` computes a hash chain in application code and the chain must not be written around. Step 3 below handles it.

- [ ] **Step 3: Write the audit rows before running the migration**

Create `scripts/audit-limit-attribute-retirement.ts`: a one-shot that reads the four-key rows, writes one `INSTRUMENT_ATTRIBUTE_REMOVED` audit entry per row through `auditLog()` (recording key, value and instrument code, with `reason: 'Retired — spec limits moved to the room. See 2026-08-11 design §3.'`), and then reports what it wrote. Run it **before** `migrate deploy`, so no row is destroyed without its audit entry existing first.

The action `INSTRUMENT_ATTRIBUTE_REMOVED` already exists — do not add a new one.

- [ ] **Step 4: Apply and verify**

```bash
cd apps/api
npx tsx ../../scripts/audit-limit-attribute-retirement.ts
npx prisma migrate deploy
npm run db:verify-migrations
DATABASE_URL=postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test npx prisma migrate deploy
```

Expected: drift guard PASSes.

Then confirm:

```bash
psql -h localhost -U digilog -d compliance_core_db \
  -c "SELECT name, attribute_keys FROM instrument_profiles;" \
  -c "SELECT key, count(*) FROM instrument_attributes GROUP BY key;"
```

Expected: no `* Limit` key remains in any profile's list; any unmigrated attribute row is still present.

- [ ] **Step 5: Write the e2e regression test**

Create `apps/api/src/e2e/limit-attribute-retirement.e2e.test.ts`:

1. No instrument profile's `attributeKeys` contains any of the four retired keys.
2. The `* Range` keys are untouched where they were present.
3. Creating a room with limits and reading `telemetry-overview` gives `OUT_OF_SPEC` from the **room**, not from any attribute.

- [ ] **Step 6: Run the full API suite**

```bash
cd apps/api && npm test
```

Expected: no regressions. Compare against the baseline in `apps/api/CLAUDE.md`; if the count differs materially, investigate before assuming it is fine.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/migrations/20260811130000_retire_limit_attributes scripts/audit-limit-attribute-retirement.ts apps/api/src/e2e/limit-attribute-retirement.e2e.test.ts
git commit -m "refactor: retire instrument limit attributes in favour of room limits"
```

---

## Task 15: Documentation sync

**Files:**
- Modify: `CLAUDE.md`, `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `CHANGELOG.md`, `tasks/todo.md`
- Modify: `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`

- [ ] **Step 1: Re-derive every count from live code**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum " apps/api/prisma/schema.prisma
ls apps/api/src/modules/ | wc -l
ls apps/api/src/modules/config/defs/*.def.ts | wc -l
ls apps/web/src/routes/config/*.tsx | wc -l
grep -cE "<Route" apps/web/src/main.tsx
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts
```

Use these numbers. Do not copy any number from the spec or this plan — both were written before the code existed.

- [ ] **Step 2: Sweep for stale counts**

Build a regex from the **previous** values and grep the active doc set (root `README`/`CLAUDE`/`AGENTS`/`CHANGELOG`/`PROJECT_SUMMARY`/`PROJECT_ARCHITECTURE`/`API_REFERENCE`/`BACKEND_GUIDE`/`FRONTEND_GUIDE`, `apps/{api,web}/{CLAUDE,DECISIONS}.md`, `packages/shared/CLAUDE.md`). Every match needs updating.

- [ ] **Step 3: Update the docs**

- Root `CLAUDE.md` — model count (+2), config def count, module count (+1: `floorplans`), web route count, and the new endpoints in the API list.
- `apps/api/CLAUDE.md` — model count, config def count, module list, the new migrations.
- `apps/web/CLAUDE.md` — route count, the `routes/dashboard/` folder, the Floorplans config page.
- `CHANGELOG.md` — the feature, and the §3 limit reversal called out explicitly.
- `tasks/todo.md` — audit-log entry.
- `2026-08-08-per-profile-instrument-attributes-design.md` — a note at the top recording that the four limit keys were retired on 2026-08-11 and why, pointing at the new spec.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md apps/api/CLAUDE.md apps/web/CLAUDE.md CHANGELOG.md tasks/todo.md docs/superpowers/specs/
git commit -m "docs: sync counts and surfaces for the instrument dashboard"
```

---

## Verification Checklist

Run before calling this done. Evidence, not assertions.

- [ ] `cd packages/shared && npx vitest run` — passes
- [ ] `cd apps/api && npm test` — single-fork, no regressions against the `apps/api/CLAUDE.md` baseline
- [ ] `cd apps/web && npm test` — passes
- [ ] `npx tsc -p apps/api/tsconfig.json --noEmit` — exit 0
- [ ] `npx tsc -p apps/web/tsconfig.json --noEmit` — exit 0
- [ ] `cd apps/api && npm run db:verify-migrations` — PASS
- [ ] `cd apps/web && npx vite build` — exit 0
- [ ] `grep -rn "arrives in Task" apps/web/src` — no output
- [ ] Browser: table view populates and updates; a drifting instrument turns a room red; the unplaced tray lists unplaced instruments; room detail charts draw and refresh; **console clean on every view**
