import type { Permission } from '@digilog/shared';

export type StepKind = 'action' | 'decision' | 'system';

export type ModuleCategory =
  | 'Operations'
  | 'Governance & Compliance'
  | 'Admin'
  | 'Reports'
  | 'System';

/**
 * Non-permission, non-role access marker for steps whose backend gate is not
 * a permission constant. Exactly one of gate/gateRoles/access must resolve
 * to something renderable — see FlowChart's role-display resolution order.
 */
export type AccessKind = 'public' | 'authenticated' | 'automatic' | 'configured';

export interface FlowStep {
  label: string;
  description?: string;
  /** Backend permission gate (requireAnyPermission semantics). [] = no gate / read-only. */
  gate: Permission[];
  /** Role-level gate (requireRole / requireSuperAdmin) — roles that may perform this step. */
  gateRoles?: string[];
  /** Non-permission, non-role access marker. Exactly one of gate/gateRoles/access must resolve. */
  access?: AccessKind;
  kind: StepKind;
  /** Optional side-branch (e.g. Bypass, Terminate). */
  branch?: { label: string; gate: Permission[] };
}

export interface ModuleFlow {
  /** Matches a sidebar item id where one exists. Unique across the catalog. */
  id: string;
  title: string;
  category: ModuleCategory;
  /** One-line "what it does". */
  summary: string;
  steps: FlowStep[];
  /** Optional caveat shown as an info callout above the flow — e.g. "the real
   * stages depend on the cleaning profile assigned to each filter". */
  note?: string;
  /**
   * How the steps relate to each other, which decides the rendering:
   * - 'sequence' — an ordered, step-by-step workflow (Start → Wash → …). Rendered
   *   as a left-to-right arrowed flow with numbered cards. Use for true workflows
   *   (the ones with review/approve branches).
   * - 'actions' (default when omitted) — INDEPENDENT capabilities (Create / Edit /
   *   Delete). Rendered as a wrapping grid of cards, no arrows, no numbers, so the
   *   layout doesn't imply a false step order.
   */
  layout?: 'sequence' | 'actions';
}
