import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowChart } from '../FlowChart';
import type { FlowStep } from '../types';
import type { RoleAccess } from '../viewer-access';

// Module 'dashboard' has empty visibilityPrivilegeIds → visible to any role
// with ≥1 permission, so these tests exercise gate filtering (not sidebar
// visibility). Roles carry a permission so canRoleSeeModule('dashboard') = true.
const ROLES: RoleAccess[] = [
  { name: 'SUPER_ADMIN', displayName: 'Super Admin', hierarchyLevel: 6, color: 'bg-red-500', permissions: ['DASHBOARD_VIEW'], sidebarItems: [] },
  { name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 2, color: 'bg-emerald-500', permissions: ['DASHBOARD_VIEW', 'FILTER_OPERATE'], sidebarItems: [] },
];

const steps: FlowStep[] = [
  { label: 'Start Cycle', gate: ['FILTER_OPERATE'], kind: 'action' },
  { label: 'Submit Checklist', gate: ['FILTER_OPERATE'], kind: 'action',
    branch: { label: 'Bypass (deviation)', gate: ['FILTER_BYPASS'] } },
];

describe('FlowChart', () => {
  it('renders each step label', () => {
    render(<FlowChart steps={steps} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Start Cycle')).toBeInTheDocument();
    expect(screen.getByText('Submit Checklist')).toBeInTheDocument();
  });

  it('shows every role configured for an operation (Operator holds FILTER_OPERATE)', () => {
    render(<FlowChart steps={steps} moduleId="dashboard" roles={ROLES} />);
    // Both steps are FILTER_OPERATE → Super Admin (always) + Operator (2 each).
    // Super Admin also appears on the bypass branch card (FILTER_BYPASS) → 3 total.
    expect(screen.getAllByText('Operator').length).toBe(2);
    expect(screen.getAllByText('Super Admin').length).toBe(3);
  });

  it('renders the branch label', () => {
    render(<FlowChart steps={steps} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Bypass (deviation)')).toBeInTheDocument();
  });

  it('branch gate that only SUPER_ADMIN satisfies shows only Super Admin', () => {
    // Bypass gate FILTER_BYPASS — no default role here holds it, SA always does.
    render(<FlowChart steps={steps} moduleId="dashboard" roles={ROLES} />);
    // The branch card's roles: Super Admin only (Operator lacks FILTER_BYPASS).
    // Operator appears on the two main steps but NOT inside the branch card.
    const bypassLabel = screen.getByText('Bypass (deviation)');
    const branchCard = bypassLabel.closest('div')!;
    expect(branchCard.textContent).toContain('Super Admin');
    expect(branchCard.textContent).not.toContain('Operator');
  });
});

describe('FlowChart — non-role access rendering', () => {
  it('renders the automatic chip and no role badge for access: "automatic"', () => {
    const automatic: FlowStep[] = [
      { label: 'Cycle auto-completes', gate: [], access: 'automatic', kind: 'system' },
    ];
    render(<FlowChart steps={automatic} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Automatic — system')).toBeInTheDocument();
    expect(screen.queryByText('Super Admin')).not.toBeInTheDocument();
    expect(screen.queryByText('Operator')).not.toBeInTheDocument();
  });

  it('renders the public chip for access: "public"', () => {
    const publicStep: FlowStep[] = [
      { label: 'Submit a request', gate: [], access: 'public', kind: 'action' },
    ];
    render(<FlowChart steps={publicStep} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Anyone — no login required')).toBeInTheDocument();
  });

  it('renders configured chip for access: "configured"', () => {
    const cfg: FlowStep[] = [
      { label: 'View QNN', gate: [], access: 'configured', kind: 'system' },
    ];
    render(<FlowChart steps={cfg} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Roles enabled in visibility config')).toBeInTheDocument();
  });

  it('gateRoles step shows exactly the listed roles that can see the module', () => {
    const saOnly: FlowStep[] = [
      { label: 'Delete record', gate: [], gateRoles: ['SUPER_ADMIN'], kind: 'decision' },
    ];
    render(<FlowChart steps={saOnly} moduleId="dashboard" roles={ROLES} />);
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
    expect(screen.queryByText('Operator')).not.toBeInTheDocument();
  });
});
