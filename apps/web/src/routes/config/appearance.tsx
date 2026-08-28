import { BrandingConfigPage } from './branding';

/**
 * Branding — logo, colours, themes, and the company/application name.
 *
 * This page used to carry a second tab, "Dashboard Cards", holding a per-ROLE
 * card visibility matrix backed by `system_config['dashboard-cards']`. That
 * surface was retired on 2026-08-28: it had no per-user layer, four of its six
 * toggles gated dashboard sections that no longer existed, and it saved the whole
 * config blob at once, so two admins editing different roles overwrote each other
 * silently. Panel assignment now lives on Config -> Roles & Access -> Panels,
 * beside Instrument Scope, which is the other reason a user sees less than
 * everything.
 *
 * The wrapper is kept rather than collapsed into the branding page because the
 * route and its config card both point here.
 */
export function AppearanceConfigPage() {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-11 h-11 rounded-[var(--radius-card)] bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-[var(--elev-2)]">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
          </svg>
        </span>
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">Branding</h1>
          <p className="text-sm text-slate-500">
            Logo, colours, themes, and company/app name. Dashboard and trend-page panels are
            assigned on Roles &amp; Access &rarr; Panels.
          </p>
        </div>
      </div>

      <BrandingConfigPage />
    </div>
  );
}
