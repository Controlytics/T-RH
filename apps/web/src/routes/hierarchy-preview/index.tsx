import { useMemo } from 'react';
import {
  useHierarchy,
  type HierarchyAhu,
  type HierarchyArea,
  type HierarchyBlock,
  type HierarchyFilter,
} from '@/hooks/use-hierarchy';

/**
 * Wave 3 (asset-removal) — read-only dev preview of the new typed-table
 * hierarchy endpoints (Wave 2: `/api/hierarchy/tree`).
 *
 * This page exists to prove the typed-table read path works end-to-end in
 * the UI. It is intentionally NOT wired into the sidebar — accessed by
 * typing `/hierarchy-preview` in the URL. Existing pages remain on the
 * legacy AssetInstance routes until later waves migrate them over.
 */

type Counts = {
  blocks: number;
  areas: number;
  ahus: number;
  filters: number;
};

function computeCounts(blocks: HierarchyBlock[] | undefined): Counts {
  if (!blocks) return { blocks: 0, areas: 0, ahus: 0, filters: 0 };
  let areas = 0;
  let ahus = 0;
  let filters = 0;
  for (const b of blocks) {
    areas += b.areas.length;
    for (const a of b.areas) {
      ahus += a.ahus.length;
      for (const h of a.ahus) {
        filters += h.filters.length;
      }
    }
  }
  return { blocks: blocks.length, areas, ahus, filters };
}

function StatusBadge({ status }: { status: string }) {
  // Keep palette inside the light-theme guidance: slate base, plus a small
  // green/red/amber tint for the three common states. Unknown statuses
  // fall back to slate so we never crash the page on a new enum value.
  const upper = (status ?? '').toUpperCase();
  let cls = 'bg-slate-100 text-slate-700 border-slate-200';
  if (upper === 'ACTIVE') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (upper === 'INACTIVE' || upper === 'RETIRED') cls = 'bg-slate-100 text-slate-600 border-slate-200';
  else if (upper === 'PENDING' || upper === 'MAINTENANCE') cls = 'bg-amber-50 text-amber-700 border-amber-200';
  else if (upper === 'FAULT' || upper === 'ERROR') cls = 'bg-red-50 text-red-700 border-red-200';
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium border rounded ${cls}`}>
      {status || 'UNKNOWN'}
    </span>
  );
}

function LifecycleChip({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <span className="inline-block px-2 py-0.5 text-xs font-medium border rounded bg-cyan-50 text-cyan-700 border-cyan-200">
      {value}
    </span>
  );
}

function FilterRow({ filter }: { filter: HierarchyFilter }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 px-2 rounded hover:bg-slate-50">
      <span className="text-sm text-slate-800">{filter.name}</span>
      <StatusBadge status={filter.status} />
      <LifecycleChip value={filter.currentLifecycleState} />
      <span className="ml-auto text-xs text-slate-400 font-mono">{filter.id}</span>
    </li>
  );
}

function AhuNode({ ahu }: { ahu: HierarchyAhu }) {
  return (
    <details className="ml-4 my-1 border-l border-slate-200 pl-3" open>
      <summary className="cursor-pointer flex flex-wrap items-center gap-2 py-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">AHU</span>
        <span className="text-sm font-medium text-slate-800">{ahu.name}</span>
        <StatusBadge status={ahu.status} />
        <span className="text-xs text-slate-500">({ahu.filters.length} filter{ahu.filters.length === 1 ? '' : 's'})</span>
      </summary>
      {ahu.filters.length === 0 ? (
        <p className="ml-4 my-1 text-xs italic text-slate-400">No filters</p>
      ) : (
        <ul className="ml-4 my-1 space-y-0.5">
          {ahu.filters.map((f) => (
            <FilterRow key={f.id} filter={f} />
          ))}
        </ul>
      )}
    </details>
  );
}

function AreaNode({ area }: { area: HierarchyArea }) {
  return (
    <details className="ml-4 my-1 border-l border-slate-200 pl-3" open>
      <summary className="cursor-pointer flex flex-wrap items-center gap-2 py-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Area</span>
        <span className="text-sm font-medium text-slate-800">{area.name}</span>
        <StatusBadge status={area.status} />
        <span className="text-xs text-slate-500">({area.ahus.length} AHU{area.ahus.length === 1 ? '' : 's'})</span>
      </summary>
      {area.ahus.length === 0 ? (
        <p className="ml-4 my-1 text-xs italic text-slate-400">No AHUs</p>
      ) : (
        area.ahus.map((h) => <AhuNode key={h.id} ahu={h} />)
      )}
    </details>
  );
}

function BlockNode({ block }: { block: HierarchyBlock }) {
  return (
    <details className="my-2 bg-white border border-slate-200 rounded-lg p-3 shadow-sm" open>
      <summary className="cursor-pointer flex flex-wrap items-center gap-2 py-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Block</span>
        <span className="text-base font-semibold text-slate-900">{block.name}</span>
        <StatusBadge status={block.status} />
        <span className="text-xs text-slate-500">({block.areas.length} area{block.areas.length === 1 ? '' : 's'})</span>
      </summary>
      {block.areas.length === 0 ? (
        <p className="ml-4 my-1 text-xs italic text-slate-400">No areas</p>
      ) : (
        block.areas.map((a) => <AreaNode key={a.id} area={a} />)
      )}
    </details>
  );
}

export function HierarchyPreviewPage() {
  const { data, error, isLoading, mutate } = useHierarchy();

  const counts = useMemo(() => computeCounts(data?.blocks), [data]);

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm mb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Hierarchy Preview</h1>
              <p className="text-sm text-slate-500 mt-1">
                Read-only preview of the new typed-table hierarchy endpoint
                <span className="font-mono text-xs ml-1 px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200">
                  GET /api/hierarchy/tree
                </span>
                . Dev-only — not wired into the sidebar.
              </p>
            </div>
            <button
              type="button"
              onClick={() => mutate()}
              className="px-3 py-1.5 text-sm font-medium border border-slate-200 rounded text-slate-700 hover:bg-slate-50"
            >
              Refresh
            </button>
          </div>

          {/* Counts */}
          <div className="mt-4 text-sm text-slate-700">
            <span className="font-semibold">{counts.blocks}</span> block{counts.blocks === 1 ? '' : 's'}
            <span className="mx-1 text-slate-300">·</span>
            <span className="font-semibold">{counts.areas}</span> area{counts.areas === 1 ? '' : 's'}
            <span className="mx-1 text-slate-300">·</span>
            <span className="font-semibold">{counts.ahus}</span> AHU{counts.ahus === 1 ? '' : 's'}
            <span className="mx-1 text-slate-300">·</span>
            <span className="font-semibold">{counts.filters}</span> filter{counts.filters === 1 ? '' : 's'}
          </div>
        </div>

        {/* Body */}
        {isLoading && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 text-center text-slate-500">
            Loading hierarchy…
          </div>
        )}

        {!isLoading && error && (
          <div className="bg-white border border-red-200 rounded-lg p-5 text-sm">
            <p className="font-semibold text-red-700">Failed to load hierarchy</p>
            <p className="mt-1 text-red-600">
              {(error as any)?.message ?? String(error)}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              The Wave 2 endpoint <span className="font-mono">/api/hierarchy/tree</span> may not be
              available yet in this build.
            </p>
          </div>
        )}

        {!isLoading && !error && data && data.blocks.length === 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-6 text-center text-slate-500">
            No blocks found. Create blocks/areas/AHUs/filters first.
          </div>
        )}

        {!isLoading && !error && data && data.blocks.length > 0 && (
          <div>
            {data.blocks.map((b) => (
              <BlockNode key={b.id} block={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
