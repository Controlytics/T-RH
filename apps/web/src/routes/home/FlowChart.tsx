import { useEffect, useRef, useState } from 'react';
import type { AccessKind, FlowStep, StepKind } from './types';
import { rolesForStep, rolesForGate, type RoleAccess } from './viewer-access';

const ACCESS_COPY: Record<AccessKind, string> = {
  automatic: 'Automatic — system',
  public: 'Anyone — no login required',
  configured: 'Roles enabled in visibility config',
  authenticated: 'Any signed-in user',
};

/** Left-accent colour per step kind — echoes the cleaning-profile pipeline's
 * colour-coded node cards, adapted to the light theme. */
const KIND_ACCENT: Record<StepKind, string> = {
  action: 'border-l-cyan-500',
  decision: 'border-l-amber-400',
  system: 'border-l-slate-400',
};

/** A role's colour may be a Tailwind class (default roles) or a raw #hex/rgb
 * (custom roles); render each appropriately. */
function RoleBadge({ role }: { role: RoleAccess }) {
  const isRaw = /^(#|rgb|hsl)/i.test(role.color);
  return (
    <span
      style={isRaw ? { backgroundColor: role.color } : undefined}
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium text-white shadow-sm ${isRaw ? '' : role.color}`}
    >
      {role.displayName}
    </span>
  );
}

function RoleBadges({ roles }: { roles: RoleAccess[] }) {
  if (roles.length === 0) {
    return <span className="text-[11px] italic text-slate-400">no role configured</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <RoleBadge key={r.name} role={r} />
      ))}
    </div>
  );
}

function AccessChip({ access }: { access: AccessKind }) {
  return (
    <span className="inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-600 border-slate-200">
      {ACCESS_COPY[access]}
    </span>
  );
}

/** Which role(s) perform this step, from the live access matrix. Steps that
 * aren't permission/role-gated (automatic/public/configured) show a chip. */
function StepAccess({ step, moduleId, roles, auditMode }: { step: FlowStep; moduleId: string; roles: RoleAccess[]; auditMode: boolean }) {
  const stepRoles = rolesForStep(step, moduleId, roles, auditMode);
  if (stepRoles === null) return <AccessChip access={step.access!} />;
  return <RoleBadges roles={stepRoles} />;
}

/** Horizontal connector between two consecutive step cards: a line + arrowhead.
 * Pinned near the top so it meets each card at the same header line regardless
 * of how tall the cards grow (role lists / descriptions vary in height). */
function ArrowConnector() {
  return (
    <div className="flex shrink-0 items-center self-start px-1 pt-[2.1rem] text-slate-300" aria-hidden="true">
      <span className="block h-0.5 w-6 rounded bg-slate-300" />
      <svg className="-ml-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 6l6 6-6 6" />
      </svg>
    </div>
  );
}

/** Down-arrow that connects a step card to its branch card below. */
function DownArrow() {
  return (
    <svg className="my-1 h-5 w-4 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 5v14m0 0l6-6m-6 6l-6-6" />
    </svg>
  );
}

/** Three-line clamp without depending on the line-clamp plugin. */
const CLAMP_3: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

function StepCard({ step, index, moduleId, roles, auditMode, numbered = true }: { step: FlowStep; index: number; moduleId: string; roles: RoleAccess[]; auditMode: boolean; numbered?: boolean }) {
  // Fixed column width keeps every card readable (roomy) and every row's
  // cards the same width; the branch drops below IN NORMAL FLOW so it can
  // never overlap the next row. `numbered` is off for capability-list
  // (non-sequential) modules, where a step order would be misleading.
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className={`min-h-[7rem] rounded-xl border border-l-4 border-slate-200 bg-white p-4 shadow-sm ${KIND_ACCENT[step.kind]}`}>
        <div className="mb-2 flex items-start gap-2.5">
          {numbered && (
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
              {index + 1}
            </span>
          )}
          <span className="text-[15px] font-semibold leading-snug text-slate-800">{step.label}</span>
        </div>
        <StepAccess step={step} moduleId={moduleId} roles={roles} auditMode={auditMode} />
        {step.description && (
          <p className="mt-2.5 text-[13px] leading-relaxed text-slate-500" style={CLAMP_3} title={step.description}>
            {step.description}
          </p>
        )}
      </div>

      {step.branch && (
        <div className="flex flex-col items-center">
          <DownArrow />
          <div className="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50/50 p-3 shadow-sm">
            <p className="mb-1.5 text-[13px] font-medium text-slate-600">{step.branch.label}</p>
            <RoleBadges roles={rolesForGate(step.branch.gate, moduleId, roles, auditMode)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Tracks horizontal overflow + scroll position of a scroll container so the
 * caller can show edge fades and a "scroll for more" cue only when they help. */
function useHorizontalScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [state, setState] = useState({ overflow: false, atStart: true, atEnd: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const overflow = el.scrollWidth > el.clientWidth + 1;
      const atStart = el.scrollLeft <= 1;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setState({ overflow, atStart, atEnd });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // ResizeObserver may be absent (jsdom tests / very old WebViews); fall back
    // to a window resize listener so overflow is still recomputed on layout change.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    else window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', update);
    };
  }, []);
  return { ref, ...state };
}

export function FlowChart({ steps, moduleId, roles, auditMode = false, layout }: { steps: FlowStep[]; moduleId: string; roles: RoleAccess[]; auditMode?: boolean; layout?: 'sequence' | 'actions' }) {
  const { ref, overflow, atStart, atEnd } = useHorizontalScroll<HTMLDivElement>();

  // Capability-list layout (the default for non-workflow modules): the steps
  // are INDEPENDENT actions, so render them as a wrapping grid of cards — no
  // connector arrows, no step numbers — instead of a left-to-right sequence
  // that would falsely imply an order (Create → Edit → Delete is not a flow).
  if (layout !== 'sequence') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <ul className="flex flex-wrap gap-3">
          {steps.map((step, i) => (
            <li key={i}>
              <StepCard step={step} index={i} moduleId={moduleId} roles={roles} auditMode={auditMode} numbered={false} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* Scroll region. Cards top-align (items-start); the arrow connectors pin
          themselves to the header line, so uneven card heights never knock the
          row out of alignment. */}
      <div ref={ref} className="overflow-x-auto pb-2">
        <ol className="flex w-max items-start">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start">
              <StepCard step={step} index={i} moduleId={moduleId} roles={roles} auditMode={auditMode} />
              {i < steps.length - 1 && <ArrowConnector />}
            </li>
          ))}
        </ol>
      </div>

      {/* Edge fades — only when there is more to scroll to on that side. Sit on
          the white panel background so no colour seam shows. */}
      {overflow && !atStart && (
        <div className="pointer-events-none absolute inset-y-4 left-4 w-10 rounded-l-2xl bg-gradient-to-r from-white to-transparent" aria-hidden="true" />
      )}
      {overflow && !atEnd && (
        <div className="pointer-events-none absolute inset-y-4 right-4 w-10 rounded-r-2xl bg-gradient-to-l from-white to-transparent" aria-hidden="true" />
      )}

      {/* Scroll cue — visible until the user reaches the end. */}
      {overflow && !atEnd && (
        <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-1 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
          Scroll for more
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 6l6 6-6 6" />
          </svg>
        </div>
      )}
    </div>
  );
}
