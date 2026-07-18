import { useState } from 'react';
import useSWR from 'swr';
import { useAuth } from '@/hooks/use-auth';
import { MODULE_FLOWS, CATEGORY_ORDER } from './module-flows';
import { FlowChart } from './FlowChart';
import { viewerCanSeeModule, type RoleAccess, type ViewerCtx } from './viewer-access';

function slug(id: string) { return `mod-${id}`; }

/** A role's colour may be a Tailwind class (default roles) or a raw #hex/rgb (custom roles). */
function RoleLegendBadge({ role }: { role: RoleAccess }) {
  const isRaw = /^(#|rgb|hsl)/i.test(role.color);
  return (
    <span
      style={isRaw ? { backgroundColor: role.color } : undefined}
      className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium text-white shadow-sm ${isRaw ? '' : role.color}`}
    >
      {role.displayName}
    </span>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  // Auto-refresh the live role matrix every 30s. Scoped to THIS key (used only
  // by the Module Guide) so no other screen is affected, and SWR only polls
  // while this page is mounted and the tab is visible — navigating away stops
  // it. The shared config keys below are intentionally left without an interval
  // (the sidebar also reads them); the manual Refresh reloads those.
  const { data: matrix, mutate: mutateMatrix } = useSWR<{ roles: RoleAccess[] }>(
    '/api/roles/access-matrix',
    { refreshInterval: 30_000 },
  );
  const { data: myConfig, mutate: mutateConfig } = useSWR<{ sidebarItems?: string[] }>('/api/config/my-config');
  const { data: qnn, mutate: mutateQnn } = useSWR<{ visible: boolean }>('/api/pm-schedules/qnn/visible');

  // Live count of ACTIVE cleaning profiles, to make the Filter Operations note
  // concrete ("N active cleaning profiles configured"). Only fetched when the
  // viewer can read profiles (FCP_READ / Super Admin) so no 403 hits the
  // console for operators — the note still renders, just without the number.
  const canReadProfiles = (user?.role === 'SUPER_ADMIN') || (user?.permissions ?? []).includes('FCP_READ');
  const { data: cpData } = useSWR<any>(canReadProfiles ? '/api/filter-cleaning-profiles?limit=200' : null);
  const cpList: any[] = Array.isArray(cpData) ? cpData : (Array.isArray(cpData?.data) ? cpData.data : []);
  const activeProfileCount = cpList.filter((p) => p?.status === 'ACTIVE').length;

  // Audit view: every module + every role permitted by the backend gate,
  // regardless of the viewer's or any role's sidebar. Default = the viewer's
  // own modules (mirrors their sidebar).
  const [auditView, setAuditView] = useState(false);

  // Manual refresh — re-pull the live role matrix (+ sidebar/qnn config) so a
  // role/permission change made elsewhere is reflected without leaving the page.
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    setRefreshing(true);
    try {
      await Promise.all([mutateMatrix(), mutateConfig(), mutateQnn()]);
    } finally {
      setRefreshing(false);
    }
  }

  const roles = matrix?.roles ?? [];

  // Which module flowcharts THIS viewer sees — mirrors their own sidebar.
  const viewer: ViewerCtx = {
    role: user?.role ?? '',
    permissions: user?.permissions ?? [],
    sidebarItems: (myConfig?.sidebarItems as string[]) ?? [],
    qnnVisible: qnn?.visible ?? false,
  };
  const visibleModules = auditView
    ? MODULE_FLOWS
    : MODULE_FLOWS.filter((m) => viewerCanSeeModule(m.id, viewer));

  const byCategory = CATEGORY_ORDER
    .map((cat) => ({ cat, mods: visibleModules.filter((m) => m.category === cat) }))
    .filter((g) => g.mods.length > 0);

  const loading = !user || !matrix;

  return (
    <div className="w-full p-4 sm:p-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-slate-800">Module Guide</h1>
          <div className="flex items-center gap-2">
            {/* View toggle: personalized vs full audit view. */}
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm" role="group" aria-label="Guide view">
              <button
                type="button"
                onClick={() => setAuditView(false)}
                aria-pressed={!auditView}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${!auditView ? 'bg-white text-cyan-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                My modules
              </button>
              <button
                type="button"
                onClick={() => setAuditView(true)}
                aria-pressed={auditView}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${auditView ? 'bg-white text-cyan-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                All modules (audit)
              </button>
            </div>
            {/* Manual refresh of the live role matrix. */}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Reload roles from the latest configuration"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-60"
            >
              <svg
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-slate-600">
          {auditView
            ? 'Audit view — every module and every role permitted to perform each operation, from your live role configuration (independent of any role’s sidebar).'
            : 'How each module works, step by step, with the role(s) configured to perform each operation. Roles come live from your role configuration, so custom roles and permission changes are reflected. You see the modules your role can access.'}
        </p>
      </header>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
          Loading roles…
        </div>
      ) : (
        <>
          {/* Live role legend + step-type key */}
          <section className="mb-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Roles</h2>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <RoleLegendBadge key={r.name} role={r} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-200 pt-3 text-xs text-slate-500">
              <span className="font-semibold uppercase tracking-wide text-slate-400">Step type</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-1 rounded bg-cyan-500" />Action</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-1 rounded bg-amber-400" />Decision</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-1 rounded bg-slate-400" />System / automatic</span>
              <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-dashed border-amber-300 bg-amber-50" />Branch (e.g. Bypass / Reject)</span>
            </div>
          </section>

          {byCategory.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
              No modules are assigned to your role yet.
            </div>
          ) : (
            <>
              {/* Table of contents */}
              <nav className="mb-8 rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Modules</h2>
                {byCategory.map(({ cat, mods }) => (
                  <div key={cat} className="mb-3 last:mb-0">
                    <p className="text-xs font-semibold text-slate-400">{cat}</p>
                    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {mods.map((m) => (
                        <li key={m.id}>
                          <a href={`#${slug(m.id)}`} className="text-sm text-cyan-700 hover:underline">{m.title}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>

              {/* Sections */}
              {byCategory.map(({ cat, mods }) => (
                <section key={cat} className="mb-10">
                  <h2 className="mb-4 border-b border-slate-200 pb-1 text-lg font-bold text-slate-700">{cat}</h2>
                  <div className="space-y-10">
                    {mods.map((m) => (
                      <article key={m.id} id={slug(m.id)} className="scroll-mt-6">
                        <h3 className="text-base font-semibold text-slate-800">{m.title}</h3>
                        <p className="mb-3 text-sm text-slate-500">{m.summary}</p>
                        {m.note && (
                          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
                            <svg className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span>
                              {m.note}
                              {m.id === 'filter-operations' && canReadProfiles && activeProfileCount > 0 && (
                                <> {' '}<span className="font-semibold">{activeProfileCount} active cleaning {activeProfileCount === 1 ? 'profile is' : 'profiles are'} configured.</span></>
                              )}
                            </span>
                          </div>
                        )}
                        <FlowChart steps={m.steps} moduleId={m.id} roles={roles} auditMode={auditView} layout={m.layout} />
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
