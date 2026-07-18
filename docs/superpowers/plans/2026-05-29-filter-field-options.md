# Filter Field Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one Configuration page that manages three value-lists (AHU Type / Filter Type / Micron Size); surface those as dropdowns on the single-filter Add and Edit dialogs, plus a Last Cleaning Date input with an explicit "NA" toggle; rename the filters-table "Type" header to "Filter Type" and add a "Micron Size" column.

**Architecture:** Reuses the existing dynamic-config infrastructure (`/api/config/dynamic/<key>` GET/PUT, gated by `CONFIG_READ/UPDATE` + `UPDATE_CONFIG_PAGE` reauth) — same pattern as Filter Cleaning Reasons. Selected values are saved into the filter's existing `attributes` JSONB under keys `ahuType`, `filterType`, `micronSize`, `lastCleaningDate`; no schema change. Dialog inputs are factored into one shared sub-component used by both Create and Edit dialogs to keep them DRY.

**Tech Stack:** Fastify + Prisma (backend); React 19 + Vite 6 + SWR + Tailwind (frontend); vitest (tests).

**Spec:** [`docs/superpowers/specs/2026-05-29-filter-field-options-design.md`](../specs/2026-05-29-filter-field-options-design.md)

---

## File map

**Create**

- `apps/api/src/modules/config/defs/filter-field-options.def.ts` — config def (Task 1)
- `apps/web/src/routes/config/filter-field-options.tsx` — config admin page (Task 2)
- `apps/web/src/routes/filter-management/filter-list/lib/lastCleaningDateState.ts` — pure helper for NA-toggle state transitions (Task 3)
- `apps/web/src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts` — unit test for the helper (Task 3)
- `apps/web/src/routes/filter-management/filter-list/components/FilterFieldOptionsSection.tsx` — shared dialog sub-component for the 4 inputs (Task 4)

**Modify**

- `apps/api/src/lib/config-discovery.ts` — register the new def (Task 1)
- `apps/api/prisma/seed.ts` — seed defaults for `filter-field-options` (Task 1)
- `apps/web/src/routes/config/index.tsx` — add the config card (Task 2)
- `apps/web/src/main.tsx` — lazy import + `<Route>` (Task 2)
- `apps/web/src/routes/filter-management/filter-list/types.ts` — extend types (Task 5)
- `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx` — mount the shared section (Task 5)
- `apps/web/src/routes/filter-management/filter-list/dialogs/EditFilterDialog.tsx` — mount the shared section (Task 6)
- `apps/web/src/routes/filter-management/filter-list.tsx` — fetch config (SWR), state, prop wiring, body construction, table header rename, Micron Size column, NA-aware date display, project `micronSize` into enrichedFilters (Task 7)

---

## Task 1: Backend — config def + register + seed

**Files:**
- Create: `apps/api/src/modules/config/defs/filter-field-options.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts` (line 41 — the comment-marked insertion point)
- Modify: `apps/api/prisma/seed.ts` (add one `systemConfig.upsert` call alongside the other config seeds around line 256+)

- [ ] **Step 1: Create the config def file**

Write `apps/api/src/modules/config/defs/filter-field-options.def.ts`:

```ts
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const filterFieldOptionsDef: ModuleConfigDefinition = {
  moduleKey: 'filter-field-options',
  moduleName: 'Filter Field Options',
  description: 'Configure dropdown values for AHU Type, Filter Type, and Micron Size on the single-filter add/edit screens',
  icon: 'list',
  category: 'filter-management',
  sortOrder: 55, // immediately after filter-cleaning-reasons (sortOrder 50)
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  // Matches filter-cleaning-reasons: dynamic-routes.ts PUT handler reads
  // reauthAction off the def, so save calls go through the umbrella
  // UPDATE_CONFIG_PAGE reauth gate.
  requiresReauth: true,
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  customPagePath: '/config/filter-field-options',
  settings: [],
};
```

- [ ] **Step 2: Register the def in config-discovery.ts**

Open `apps/api/src/lib/config-discovery.ts`. Find the line:

```ts
    // ─── Add new module configs below this line ───
```

Immediately above that line (so the import sits inside the `Promise.all([...])` array), add:

```ts
    import('../modules/config/defs/filter-field-options.def.js'),
```

(Note the `.js` extension — matches the surrounding lines; TypeScript ESM compiles `.ts` → `.js`.)

- [ ] **Step 3: Seed the default config row**

Open `apps/api/prisma/seed.ts`. Find the block where `systemConfig` is upserted by `configKey` (around lines 256+). Add a new upsert immediately after the last `prisma.systemConfig.upsert` call (or in the same `for` loop / batch — match whatever pattern is in use locally):

```ts
  await prisma.systemConfig.upsert({
    where: { configKey: 'filter-field-options' },
    update: {}, // do not overwrite admin edits on re-seed
    create: {
      configKey: 'filter-field-options',
      configValue: {
        ahuType: ['Process', 'Non Process'],
        filterType: [],
        micronSize: [],
      },
      configType: 'filter',
      requiresReauth: true,
    },
  });
```

(Note: `update: {}` is intentional — re-running the seed must not clobber the admin's added Filter Type / Micron Size values.)

- [ ] **Step 4: Verify config registers at startup**

Run the API in another shell:

```bash
cd apps/api && npx tsx watch src/app.ts
```

Expected on stdout: `[config-registry] 28 modules registered` (was 27 before; one more after this def is added).

Then curl the dynamic config endpoint to confirm the row exists:

```bash
curl -sk https://localhost:3000/api/config/dynamic/filter-field-options -H "Authorization: Bearer $(curl -sk https://localhost:3000/api/auth/login -X POST -H 'Content-Type: application/json' -d '{"username":"superadmin","password":"Admin@123"}' | jq -r .token)" | jq
```

Expected response: `{ "value": { "ahuType": ["Process", "Non Process"], "filterType": [], "micronSize": [] } }`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/config/defs/filter-field-options.def.ts apps/api/src/lib/config-discovery.ts apps/api/prisma/seed.ts
git commit -m "feat(config): add filter-field-options def + seed defaults"
```

---

## Task 2: Frontend — config admin page + route + card

**Files:**
- Create: `apps/web/src/routes/config/filter-field-options.tsx`
- Modify: `apps/web/src/main.tsx` (around line 69 for the lazy import; around line 234 for the `<Route>`)
- Modify: `apps/web/src/routes/config/index.tsx` (insert a new card after the cleaning-reasons card around line 272)

- [ ] **Step 1: Create the config page**

Write `apps/web/src/routes/config/filter-field-options.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

type ListKey = 'ahuType' | 'filterType' | 'micronSize';
type FieldOptions = { ahuType: string[]; filterType: string[]; micronSize: string[] };

const DEFAULT_VALUE: FieldOptions = { ahuType: ['Process', 'Non Process'], filterType: [], micronSize: [] };

const SECTIONS: { key: ListKey; title: string; placeholder: string }[] = [
  { key: 'ahuType',    title: 'AHU Type',    placeholder: 'e.g. Process' },
  { key: 'filterType', title: 'Filter Type', placeholder: 'e.g. HEPA' },
  { key: 'micronSize', title: 'Micron Size', placeholder: 'e.g. 0.3' },
];

export function FilterFieldOptionsConfigPage() {
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const navigate = useNavigate();
  const { data: config } = useSWR('/api/config/dynamic/filter-field-options');
  const [value, setValue] = useState<FieldOptions>(DEFAULT_VALUE);
  const [draft, setDraft] = useState<Record<ListKey, string>>({ ahuType: '', filterType: '', micronSize: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reauth = useReauth();

  useEffect(() => {
    const v = config?.value as Partial<FieldOptions> | undefined;
    if (v) {
      setValue({
        ahuType: Array.isArray(v.ahuType) ? v.ahuType : [],
        filterType: Array.isArray(v.filterType) ? v.filterType : [],
        micronSize: Array.isArray(v.micronSize) ? v.micronSize : [],
      });
    }
  }, [config]);

  const addValue = (key: ListKey) => {
    const next = draft[key].trim();
    if (!next) return;
    if (value[key].some(v => v.toLowerCase() === next.toLowerCase())) {
      setError(`"${next}" already exists in ${key}`);
      return;
    }
    setValue({ ...value, [key]: [...value[key], next] });
    setDraft({ ...draft, [key]: '' });
    setError(null);
  };

  const removeValue = (key: ListKey, idx: number) => {
    setValue({ ...value, [key]: value[key].filter((_, i) => i !== idx) });
  };

  const move = (key: ListKey, idx: number, dir: -1 | 1) => {
    const list = [...value[key]];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    setValue({ ...value, [key]: list });
  };

  const save = () => {
    setSaving(true);
    const body = { value };
    reauth.execute(
      'UPDATE_CONFIG_PAGE',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/config/dynamic/filter-field-options', body, password);
        else await apiClient.put('/api/config/dynamic/filter-field-options', body);
      },
      {
        onSuccess: () => {
          mutate('/api/config/dynamic/filter-field-options');
          setError(null);
          setSaving(false);
        },
        onError: (e: any) => {
          setError(e.message || 'Failed to save field options');
          setSaving(false);
        },
      },
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header — visual style mirrors cleaning-reasons */}
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/config')}
          className="p-2 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:border-slate-300 transition-colors shadow-sm"
          title="Back to Config">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-3 flex-1">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Filter Field Options</h1>
            <p className="text-sm text-slate-500">Configure the dropdown values shown on the single-filter add/edit screens</p>
          </div>
        </div>
        <button onClick={save} disabled={saving || !canWrite}
          title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}
          className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-lg hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 transition-all shadow-sm font-medium text-sm">
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 ml-4 text-lg font-medium">&times;</button>
        </div>
      )}

      {/* Three sections — one per list */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl divide-y divide-slate-100">
        {SECTIONS.map(({ key, title, placeholder }) => (
          <div key={key} className="px-5 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{title}</h2>
              <span className="text-xs text-slate-400">{value[key].length} value{value[key].length === 1 ? '' : 's'}</span>
            </div>

            {value[key].length === 0 ? (
              <p className="text-sm text-slate-400 italic">No values configured yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {value[key].map((v, idx) => (
                  <li key={idx} className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">
                    <span className="flex-1 text-sm text-slate-800">{v}</span>
                    <button disabled={!canWrite || idx === 0} onClick={() => move(key, idx, -1)}
                      className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-xs">↑</button>
                    <button disabled={!canWrite || idx === value[key].length - 1} onClick={() => move(key, idx, 1)}
                      className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-xs">↓</button>
                    <button disabled={!canWrite} onClick={() => removeValue(key, idx)}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs font-medium">Remove</button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2 pt-1">
              <input value={draft[key]} disabled={!canWrite}
                onChange={e => setDraft({ ...draft, [key]: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValue(key); } }}
                placeholder={placeholder}
                className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:bg-slate-50" />
              <button disabled={!canWrite || !draft[key].trim()} onClick={() => addValue(key)}
                className="px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium text-sm">
                + Add
              </button>
            </div>
          </div>
        ))}
      </div>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Update Filter Field Options"
      />
    </div>
  );
}
```

- [ ] **Step 2: Register the route in `main.tsx`**

Open `apps/web/src/main.tsx`. Around line 69 (immediately after `CleaningReasonsConfigPage` lazy import), add:

```ts
const FilterFieldOptionsConfigPage = lazy(() => import("./routes/config/filter-field-options").then(m => ({ default: m.FilterFieldOptionsConfigPage })));
```

Around line 234 (immediately after the `/config/filter-cleaning-reasons` `<Route>`), add:

```tsx
            <Route path="/config/filter-field-options" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><FilterFieldOptionsConfigPage /></Suspense></RequireRole>} />
```

- [ ] **Step 3: Add the card on `/config`**

Open `apps/web/src/routes/config/index.tsx`. Around line 269 (immediately after the cleaning-reasons card object, before the next card in the array), add a new card:

```tsx
  {
    title: 'Filter Field Options',
    description: 'Manage AHU Type, Filter Type, and Micron Size dropdown values',
    href: '/config/filter-field-options',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7" />
      </svg>
    ),
  },
```

(Verified from `apps/web/src/routes/config/index.tsx:269–276` — neighbour cards use exactly this `{ title, description, href, icon }` shape. If the card array near line 269 carries an extra field on its existing entries (e.g. `category`), copy that field over too; preserve whatever is there.)

- [ ] **Step 4: Verify the page loads + a value round-trips**

Start the web dev server (`cd apps/web && npx vite --host`). Open `http://localhost:5175/config/filter-field-options`. Expected:

- Header reads "Filter Field Options"
- Three sections rendered (AHU Type with "Process" and "Non Process" rows, Filter Type empty, Micron Size empty)
- Add a value to Filter Type (e.g. "HEPA"), click "Save Changes" → reauth prompt → enter `Admin@123` → success
- Reload the page; the value persists.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/config/filter-field-options.tsx apps/web/src/main.tsx apps/web/src/routes/config/index.tsx
git commit -m "feat(config): filter-field-options admin page + route + card"
```

---

## Task 3: NA-toggle helper + test (TDD)

The Last Cleaning Date control has non-trivial state — date input + NA checkbox — that must round-trip through `attributes.lastCleaningDate` correctly. Extract that into a pure helper and TDD it before wiring the UI.

**Files:**
- Create: `apps/web/src/routes/filter-management/filter-list/lib/lastCleaningDateState.ts`
- Create: `apps/web/src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts`

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeLastCleaningDate,
  encodeLastCleaningDate,
  type LastCleaningDateState,
} from '../lastCleaningDateState';

describe('decodeLastCleaningDate', () => {
  it('returns empty + NA=false for null/undefined', () => {
    expect(decodeLastCleaningDate(null)).toEqual({ date: '', na: false });
    expect(decodeLastCleaningDate(undefined)).toEqual({ date: '', na: false });
  });

  it('returns empty + NA=true for the literal "NA"', () => {
    expect(decodeLastCleaningDate('NA')).toEqual({ date: '', na: true });
  });

  it('returns the ISO date + NA=false for a date string', () => {
    expect(decodeLastCleaningDate('2026-04-15')).toEqual({ date: '2026-04-15', na: false });
  });
});

describe('encodeLastCleaningDate', () => {
  it('returns "NA" when na is true (regardless of date)', () => {
    expect(encodeLastCleaningDate({ date: '', na: true })).toBe('NA');
    expect(encodeLastCleaningDate({ date: '2026-04-15', na: true })).toBe('NA');
  });

  it('returns undefined when na is false and date is empty', () => {
    expect(encodeLastCleaningDate({ date: '', na: false })).toBeUndefined();
  });

  it('returns the date string when na is false and date is set', () => {
    expect(encodeLastCleaningDate({ date: '2026-04-15', na: false })).toBe('2026-04-15');
  });
});

describe('NA toggle interaction', () => {
  it('clears the date when NA is checked', () => {
    const before: LastCleaningDateState = { date: '2026-04-15', na: false };
    const after: LastCleaningDateState = { ...before, na: true, date: '' };
    expect(encodeLastCleaningDate(after)).toBe('NA');
  });

  it('round-trips: decode(encode(s)) === s for canonical states', () => {
    const cases: LastCleaningDateState[] = [
      { date: '', na: false },
      { date: '', na: true },
      { date: '2026-04-15', na: false },
    ];
    for (const s of cases) {
      expect(decodeLastCleaningDate(encodeLastCleaningDate(s) ?? null)).toEqual(s);
    }
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails (module not yet written)**

Run:

```bash
cd apps/web && npx vitest run src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts
```

Expected: FAIL with `Cannot find module '../lastCleaningDateState'`.

- [ ] **Step 3: Implement the helper**

Write `apps/web/src/routes/filter-management/filter-list/lib/lastCleaningDateState.ts`:

```ts
// Pure helpers for the Last Cleaning Date input's "date OR NA" state.
//
// Stored on the filter as attributes.lastCleaningDate, with three valid
// states:
//   - undefined (field never filled — distinct from "explicitly NA")
//   - "NA"      (operator ticked the NA checkbox)
//   - ISO date  (e.g. "2026-04-15")
//
// The dialog input owns a {date, na} pair; these helpers translate to/from
// the stored representation.

export type LastCleaningDateState = { date: string; na: boolean };

export function decodeLastCleaningDate(stored: string | null | undefined): LastCleaningDateState {
  if (stored === 'NA') return { date: '', na: true };
  if (stored === null || stored === undefined || stored === '') return { date: '', na: false };
  return { date: stored, na: false };
}

export function encodeLastCleaningDate(state: LastCleaningDateState): string | undefined {
  if (state.na) return 'NA';
  if (!state.date) return undefined;
  return state.date;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
cd apps/web && npx vitest run src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts
```

Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list/lib/lastCleaningDateState.ts apps/web/src/routes/filter-management/filter-list/lib/__tests__/lastCleaningDateState.test.ts
git commit -m "test+feat(filter-list): lastCleaningDate NA-state helper"
```

---

## Task 4: Shared dialog sub-component

Both CreateFilterDialog and EditFilterDialog need the same 4 inputs. Extract once.

**Files:**
- Create: `apps/web/src/routes/filter-management/filter-list/components/FilterFieldOptionsSection.tsx`

- [ ] **Step 1: Create the shared section component**

Write `apps/web/src/routes/filter-management/filter-list/components/FilterFieldOptionsSection.tsx`:

```tsx
import type { LastCleaningDateState } from '../lib/lastCleaningDateState';

export type FilterFieldOptions = {
  ahuType: string[];
  filterType: string[];
  micronSize: string[];
};

type Props = {
  options: FilterFieldOptions;
  ahuType: string;
  filterType: string;
  micronSize: string;
  lastCleaning: LastCleaningDateState;
  onAhuTypeChange: (v: string) => void;
  onFilterTypeChange: (v: string) => void;
  onMicronSizeChange: (v: string) => void;
  onLastCleaningChange: (next: LastCleaningDateState) => void;
};

export function FilterFieldOptionsSection({
  options, ahuType, filterType, micronSize, lastCleaning,
  onAhuTypeChange, onFilterTypeChange, onMicronSizeChange, onLastCleaningChange,
}: Props) {
  const select = (value: string, list: string[], onChange: (v: string) => void, emptyHint: string) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
      <option value="">{list.length === 0 ? emptyHint : 'Select…'}</option>
      {list.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  );

  return (
    <div className="space-y-3 pt-1 border-t border-slate-100">
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider pt-2">Filter Details</div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">AHU Type</label>
        {select(ahuType, options.ahuType, onAhuTypeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Filter Type</label>
        {select(filterType, options.filterType, onFilterTypeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Micron Size <span className="text-slate-400 font-normal">(µm)</span></label>
        {select(micronSize, options.micronSize, onMicronSizeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Last Cleaning Date</label>
        <div className="flex items-center gap-3">
          <input type="date"
            value={lastCleaning.date}
            disabled={lastCleaning.na}
            onChange={e => onLastCleaningChange({ ...lastCleaning, date: e.target.value })}
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 disabled:bg-slate-50 disabled:text-slate-400" />
          <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
            <input type="checkbox"
              checked={lastCleaning.na}
              onChange={e => onLastCleaningChange({ na: e.target.checked, date: e.target.checked ? '' : lastCleaning.date })}
              className="w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
            NA
          </label>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check builds**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: passes (or only pre-existing errors unrelated to this file).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list/components/FilterFieldOptionsSection.tsx
git commit -m "feat(filter-list): shared filter field-options section component"
```

---

## Task 5: Wire into CreateFilterDialog + extend shared types

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-list/types.ts`
- Modify: `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`

- [ ] **Step 1: Extend `types.ts`**

Open `apps/web/src/routes/filter-management/filter-list/types.ts`. Add the following near the end of the file (after `BulkUploadStep`):

```ts
// Re-export the field-options shape for parent + dialog use.
export type { FilterFieldOptions } from './components/FilterFieldOptionsSection';
export type { LastCleaningDateState } from './lib/lastCleaningDateState';
```

Also widen `EditFilterRef` so the edit dialog can mount with the current values:

```ts
export type EditFilterRef = {
  id: string;
  name: string;
  filterSet?: string;
  ahuType?: string;
  filterType?: string;
  micronSize?: string;
  lastCleaningDate?: string | null;
};
```

- [ ] **Step 2: Extend CreateFilterDialog props + render the section**

Open `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`.

(a) Update the import at the top:

```ts
import { themeButton } from '@/lib/theme-styles';
import type { AhuOption, TemplateField, FilterFieldOptions, LastCleaningDateState } from '../types';
import { FilterFieldOptionsSection } from '../components/FilterFieldOptionsSection';
```

(b) Extend the `Props` type — add the new fields below the existing ones:

```ts
type Props = {
  ahu: string;
  area: string;
  name: string;
  filterSet: 'A' | 'B';
  attrs: Record<string, any>;
  schema: TemplateField[];
  ahus: AhuOption[];
  areas: AhuOption[];
  error: string;
  submitting: boolean;
  // Filter Field Options (Task 5)
  fieldOptions: FilterFieldOptions;
  ahuType: string;
  filterType: string;
  micronSize: string;
  lastCleaning: LastCleaningDateState;
  onAhuChange: (v: string) => void;
  onAreaChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onFilterSetChange: (v: 'A' | 'B') => void;
  onAttrChange: (next: (prev: Record<string, any>) => Record<string, any>) => void;
  onAhuTypeChange: (v: string) => void;
  onFilterTypeChange: (v: string) => void;
  onMicronSizeChange: (v: string) => void;
  onLastCleaningChange: (s: LastCleaningDateState) => void;
  onClose: () => void;
  onSubmit: () => void;
};
```

(c) Update the destructure in the function signature to include the new fields:

```tsx
export function CreateFilterDialog({
  ahu, area, name, filterSet, attrs, schema, ahus, areas, error, submitting,
  fieldOptions, ahuType, filterType, micronSize, lastCleaning,
  onAhuChange, onAreaChange, onNameChange, onFilterSetChange, onAttrChange,
  onAhuTypeChange, onFilterTypeChange, onMicronSizeChange, onLastCleaningChange,
  onClose, onSubmit,
}: Props) {
```

(d) Insert the section **immediately above** the existing `{schema.length > 0 && (` block (around line 91):

```tsx
          <FilterFieldOptionsSection
            options={fieldOptions}
            ahuType={ahuType}
            filterType={filterType}
            micronSize={micronSize}
            lastCleaning={lastCleaning}
            onAhuTypeChange={onAhuTypeChange}
            onFilterTypeChange={onFilterTypeChange}
            onMicronSizeChange={onMicronSizeChange}
            onLastCleaningChange={onLastCleaningChange}
          />
```

- [ ] **Step 3: Type-check builds**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: passes. (Parent `filter-list.tsx` will still error because it isn't passing the new props yet — that's Task 7. If you want to type-check in isolation, run vitest's `--typecheck` only against this file; otherwise accept the parent-file errors until Task 7 completes.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list/types.ts apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx
git commit -m "feat(filter-list): create-filter dialog gets AHU/Filter/Micron + Last Cleaning Date"
```

---

## Task 6: Wire into EditFilterDialog

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-list/dialogs/EditFilterDialog.tsx`

- [ ] **Step 1: Rewrite EditFilterDialog with the new fields**

The current file is short (~58 lines). Replace its contents entirely:

```tsx
import type { FilterFieldOptions, LastCleaningDateState } from '../types';
import { FilterFieldOptionsSection } from '../components/FilterFieldOptionsSection';

type Props = {
  name: string;
  filterSet: 'A' | 'B';
  error: string;
  submitting: boolean;
  fieldOptions: FilterFieldOptions;
  ahuType: string;
  filterType: string;
  micronSize: string;
  lastCleaning: LastCleaningDateState;
  onNameChange: (v: string) => void;
  onFilterSetChange: (v: 'A' | 'B') => void;
  onAhuTypeChange: (v: string) => void;
  onFilterTypeChange: (v: string) => void;
  onMicronSizeChange: (v: string) => void;
  onLastCleaningChange: (s: LastCleaningDateState) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function EditFilterDialog({
  name, filterSet, error, submitting,
  fieldOptions, ahuType, filterType, micronSize, lastCleaning,
  onNameChange, onFilterSetChange,
  onAhuTypeChange, onFilterTypeChange, onMicronSizeChange, onLastCleaningChange,
  onClose, onSubmit,
}: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl">
        <div className="px-6 py-4 shrink-0 flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500">
          <div>
            <h2 className="text-lg font-bold text-white">Edit Filter</h2>
            <p className="text-white/70 text-sm">Update filter name, set, and field details</p>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 160px)' }}>
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Filter Name <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={e => onNameChange(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Filter Set</label>
            <div className="flex gap-2">
              {(['A', 'B'] as const).map(s => (
                <button key={s} type="button" onClick={() => onFilterSetChange(s)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    filterSet === s ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}>
                  Set {s}
                </button>
              ))}
            </div>
          </div>

          <FilterFieldOptionsSection
            options={fieldOptions}
            ahuType={ahuType}
            filterType={filterType}
            micronSize={micronSize}
            lastCleaning={lastCleaning}
            onAhuTypeChange={onAhuTypeChange}
            onFilterTypeChange={onFilterTypeChange}
            onMicronSizeChange={onMicronSizeChange}
            onLastCleaningChange={onLastCleaningChange}
          />
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          <button onClick={onSubmit} disabled={submitting || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list/dialogs/EditFilterDialog.tsx
git commit -m "feat(filter-list): edit-filter dialog gets the new field-options section"
```

---

## Task 7: Parent wiring (`filter-list.tsx`)

This is the integration step — fetch the config, hold state, pass to both dialogs, build the API body, project `micronSize` into enriched rows, rename the table header, add the Micron Size column, and make the date formatter NA-aware.

**Files:**
- Modify: `apps/web/src/routes/filter-management/filter-list.tsx` (multiple sites — line numbers cited; verify they match the file before editing)

- [ ] **Step 1: Add the SWR fetch + state for the new fields**

Near the top of the component (around lines 87–105 where other dialog state is declared), add:

```tsx
  // ── Filter Field Options config (Task 7) ──
  const { data: filterFieldOptionsConfig } = useSWR('/api/config/dynamic/filter-field-options');
  const fieldOptions: FilterFieldOptions = (() => {
    const v = filterFieldOptionsConfig?.value as Partial<FilterFieldOptions> | undefined;
    return {
      ahuType: Array.isArray(v?.ahuType) ? v!.ahuType : ['Process', 'Non Process'],
      filterType: Array.isArray(v?.filterType) ? v!.filterType : [],
      micronSize: Array.isArray(v?.micronSize) ? v!.micronSize : [],
    };
  })();

  // Create-filter state additions
  const [createFilterAhuType, setCreateFilterAhuType] = useState('');
  const [createFilterFilterType, setCreateFilterFilterType] = useState('');
  const [createFilterMicronSize, setCreateFilterMicronSize] = useState('');
  const [createFilterLastCleaning, setCreateFilterLastCleaning] = useState<LastCleaningDateState>({ date: '', na: false });

  // Edit-filter state additions
  const [editFilterAhuType, setEditFilterAhuType] = useState('');
  const [editFilterFilterType, setEditFilterFilterType] = useState('');
  const [editFilterMicronSize, setEditFilterMicronSize] = useState('');
  const [editFilterLastCleaning, setEditFilterLastCleaning] = useState<LastCleaningDateState>({ date: '', na: false });
```

And add the imports at the top of the file (find the existing `import type { … } from './filter-list/types';` line and extend it; add a new import for the helper):

```ts
import type { /* existing */ FilterFieldOptions, LastCleaningDateState } from './filter-list/types';
import { encodeLastCleaningDate, decodeLastCleaningDate } from './filter-list/lib/lastCleaningDateState';
```

- [ ] **Step 2: Initialize create-filter state in `openCreateFilter` (around line 879)**

Find `openCreateFilter` (line ~879). Add inside it:

```tsx
    setCreateFilterAhuType('');
    setCreateFilterFilterType('');
    setCreateFilterMicronSize('');
    setCreateFilterLastCleaning({ date: '', na: false });
```

- [ ] **Step 3: Inject the new attribute values into `submitCreateFilter`'s body (around line 909–926)**

Inside `submitCreateFilter`, in the block where `attributes` is built (after the existing `for (const field of filterAttributeSchema)` loop), append:

```tsx
    // Filter Field Options (Task 7) — write into attributes alongside any
    // template attributeSchema fields.
    if (createFilterAhuType)    attributes.ahuType    = createFilterAhuType;
    if (createFilterFilterType) attributes.filterType = createFilterFilterType;
    if (createFilterMicronSize) attributes.micronSize = createFilterMicronSize;
    const lastEnc = encodeLastCleaningDate(createFilterLastCleaning);
    if (lastEnc !== undefined)  attributes.lastCleaningDate = lastEnc;
```

- [ ] **Step 4: Initialize edit-filter state in `openEditFilter` (around line 813)**

Modify `openEditFilter` so it primes the new state from the row being edited. Widen the parameter type and the body:

```tsx
  const openEditFilter = (f: {
    id: string; name: string; filterSet?: string;
    ahuType?: string; filterType?: string; micronSize?: string; lastCleaningDate?: string | null;
  }) => {
    setEditFilterDialog(f);
    setEditFilterName(f.name);
    setEditFilterSet((f.filterSet === 'B' ? 'B' : 'A') as 'A' | 'B');
    setEditFilterAhuType(f.ahuType && f.ahuType !== '-' ? f.ahuType : '');
    setEditFilterFilterType(f.filterType && f.filterType !== '-' ? f.filterType : '');
    setEditFilterMicronSize(f.micronSize && f.micronSize !== '-' ? f.micronSize : '');
    setEditFilterLastCleaning(decodeLastCleaningDate(f.lastCleaningDate ?? null));
    setEditFilterError('');
  };
```

Also update the call site that invokes `openEditFilter(f)` to pass through the extra fields. Find each `openEditFilter(...)` call site in the file (it's the per-row action handler) and ensure the argument has the new fields — easiest is to pass the enrichedFilter row directly since it now has all four (see Step 8 below).

- [ ] **Step 5: Inject the new attributes into `submitEditFilter`'s body (around line 829)**

Replace the existing one-line body construction:

```tsx
      const body = { name: editFilterName.trim(), filterSet: editFilterSet };
```

with:

```tsx
      // Read existing attributes off the current row so we don't blow away
      // template-schema fields when patching.
      const current = enrichedFilters.find(x => x.id === id);
      const attributes: Record<string, any> = {
        ...(current as any)?._rawAttributes ?? {},
      };
      if (editFilterAhuType) attributes.ahuType = editFilterAhuType; else delete attributes.ahuType;
      if (editFilterFilterType) attributes.filterType = editFilterFilterType; else delete attributes.filterType;
      if (editFilterMicronSize) attributes.micronSize = editFilterMicronSize; else delete attributes.micronSize;
      const lastEnc = encodeLastCleaningDate(editFilterLastCleaning);
      if (lastEnc !== undefined) attributes.lastCleaningDate = lastEnc; else delete attributes.lastCleaningDate;

      const body = {
        name: editFilterName.trim(),
        filterSet: editFilterSet,
        ...(Object.keys(attributes).length > 0 && { attributes }),
      };
```

This requires `enrichedFilters` to also carry the raw attributes — see Step 6.

- [ ] **Step 6: Project `micronSize` and the raw attributes into `enrichedFilters` (line 362)**

Modify the `enrichedFilters` map block (line 362–375) — add `micronSize` and stash the raw attributes for the edit-merge:

```tsx
  const enrichedFilters = useMemo(() => {
    return allFilters.map((f: any) => {
      const { ahuId, ahuName, areaId, areaName, blockId } = resolveAncestors(f.id);
      return {
        id: f.id, name: f.name, filterSet: f.filterSet,
        currentState: f.currentLifecycleState,
        status: f.status ?? 'Active',
        ahuId, ahuName, areaId, areaName, blockId,
        filterType: f.attributes?.filterType ?? '-',
        ahuType: f.attributes?.ahuType ?? '-',
        micronSize: f.attributes?.micronSize ?? '-',
        lastCleaningDate: f.attributes?.lastCleaningDate ?? null,
        _rawAttributes: f.attributes ?? {},
      };
    });
  }, [allFilters, instanceMap, ahuTemplateId, blockIds]);
```

- [ ] **Step 7: Make the `Last Cleaned` table cell NA-aware (line ~1485)**

Replace:

```tsx
                          <td className="px-5 py-3.5 text-sm text-slate-500">{f.lastCleaningDate ? formatDate(f.lastCleaningDate) : '--'}</td>
```

with:

```tsx
                          <td className="px-5 py-3.5 text-sm text-slate-500">
                            {f.lastCleaningDate === 'NA'
                              ? <span className="text-slate-400 italic">NA</span>
                              : f.lastCleaningDate
                                ? formatDate(f.lastCleaningDate)
                                : '--'}
                          </td>
```

- [ ] **Step 8: Rename the "Type" header, add "Micron Size" column header + cell**

Header block (around line 1427) — rename:

```tsx
                      <th className="text-left px-5 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Filter Type</th>
```

Immediately after that `<th>`, before the "Set" header, insert:

```tsx
                      <th className="text-left px-5 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Micron Size</th>
```

In the row body (around line 1477, right after the existing `filterType` cell), add:

```tsx
                          <td className="px-5 py-3.5 text-sm text-slate-500">
                            {f.micronSize !== '-' ? <>{f.micronSize} <span className="text-slate-400">µm</span></> : '--'}
                          </td>
```

- [ ] **Step 9: Pass the new props into both dialog mount sites (around lines 1730, 1779)**

CreateFilterDialog mount (line 1730) — extend the props passed in:

```tsx
        <CreateFilterDialog
          ahu={createFilterAhu}
          area={createFilterArea}
          name={createFilterName}
          filterSet={createFilterSet}
          attrs={createFilterAttrs}
          schema={filterAttributeSchema}
          ahus={createFilterAhusVisible}
          areas={createFilterAreas}
          error={createFilterError}
          submitting={createFilterSubmitting}
          fieldOptions={fieldOptions}
          ahuType={createFilterAhuType}
          filterType={createFilterFilterType}
          micronSize={createFilterMicronSize}
          lastCleaning={createFilterLastCleaning}
          onAhuChange={setCreateFilterAhu}
          onAreaChange={(v) => { setCreateFilterArea(v); setCreateFilterAhu(''); }}
          onNameChange={setCreateFilterName}
          onFilterSetChange={setCreateFilterSet}
          onAttrChange={setCreateFilterAttrs}
          onAhuTypeChange={setCreateFilterAhuType}
          onFilterTypeChange={setCreateFilterFilterType}
          onMicronSizeChange={setCreateFilterMicronSize}
          onLastCleaningChange={setCreateFilterLastCleaning}
          onClose={() => setCreateFilterOpen(false)}
          onSubmit={submitCreateFilter}
        />
```

EditFilterDialog mount (line 1779) — extend similarly:

```tsx
        <EditFilterDialog
          name={editFilterName}
          filterSet={editFilterSet}
          error={editFilterError}
          submitting={editFilterSubmitting}
          fieldOptions={fieldOptions}
          ahuType={editFilterAhuType}
          filterType={editFilterFilterType}
          micronSize={editFilterMicronSize}
          lastCleaning={editFilterLastCleaning}
          onNameChange={setEditFilterName}
          onFilterSetChange={setEditFilterSet}
          onAhuTypeChange={setEditFilterAhuType}
          onFilterTypeChange={setEditFilterFilterType}
          onMicronSizeChange={setEditFilterMicronSize}
          onLastCleaningChange={setEditFilterLastCleaning}
          onClose={() => setEditFilterDialog(null)}
          onSubmit={submitEditFilter}
        />
```

- [ ] **Step 10: Type-check builds clean**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: passes with no new errors. If a "missing prop" error fires on `<CreateFilterDialog`/`<EditFilterDialog`, re-check Step 9.

- [ ] **Step 11: Run the existing unit-test suite**

```bash
cd apps/web && npm test
```

Expected: lastCleaningDateState tests pass (Task 3) + no regressions in pre-existing tests.

- [ ] **Step 12: Manual smoke test against the running app**

1. `/config/filter-field-options`: add a Filter Type ("HEPA") and a Micron Size ("0.3"); save (reauth prompt).
2. Filters page → "+ Add Filter" → confirm all 4 new inputs appear under "Filter Details"; AHU Type shows Process / Non Process; Filter Type shows HEPA; Micron Size shows 0.3.
3. Fill all 4 (date in Last Cleaning Date, NA unchecked); submit. Expect a success toast, dialog closes, the new row appears.
4. Confirm in the table: header reads **Filter Type** (not "Type"); new **Micron Size** column visible; values populated; **Last Cleaned** shows the picked date.
5. Click "Edit" on that row → dialog mounts with the 4 values pre-filled. Tick **NA** in Last Cleaning Date — date input clears + disables. Save. Confirm the table's **Last Cleaned** cell now renders italic "NA".
6. Edit again — confirm the NA checkbox is pre-ticked on open.

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/routes/filter-management/filter-list.tsx
git commit -m "feat(filter-list): wire field options + Last Cleaning Date NA + Micron Size column + 'Filter Type' header"
```

---

## Wrap-up

After Task 7 commits, the feature is shippable end-to-end:
- New Config page at `/config/filter-field-options` (Task 1 + 2)
- Add/Edit dialogs show the 4 new inputs (Tasks 4 + 5 + 6)
- Table shows the renamed header + Micron Size column + NA rendering (Task 7)

**Branch:** still `RFID`. The 7 commits are independent and reviewable in isolation. No DB migration was needed — `asset_instances.attributes` is JSONB.

**Update CHANGELOG.md** with one `[Unreleased]` entry summarising the feature, referencing the spec at `docs/superpowers/specs/2026-05-29-filter-field-options-design.md`. (One additional commit.)

**Out-of-scope, deferred per spec §12:** bulk-upload CSV columns, filter detail/trace page rendering, required-field validation.

**Spec items intentionally not in this plan (acknowledged trade-offs):**
- **Server-side shape validation** of the PUT body (spec §8). The generic `/api/config/dynamic/:key` PUT endpoint accepts arbitrary JSON for every key — matching the cleaning-reasons pattern. Client-side dedupe + trim in the config page is the only guard. Since this page is SUPER_ADMIN-only with reauth, the risk is bounded; add a server-side validator later if any non-trusted writer appears.
- **Dialog component test with `@testing-library/react`** (spec §11). The non-trivial logic (NA-toggle state) is covered by the pure-helper unit test in Task 3; the rest of the dialog is straightforward prop wiring. Manual smoke (Task 7 Step 12) catches integration regressions. Add a component test if/when these dialogs gain conditional render logic.
