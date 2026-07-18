import { describe, it, expect } from 'vitest';
import { MODULE_FLOWS, CATEGORY_ORDER } from '../module-flows';
import { PERMISSIONS } from '@digilog/shared';

const ALL_PERMS = new Set(Object.values(PERMISSIONS));

describe('MODULE_FLOWS integrity', () => {
  it('has no duplicate module ids', () => {
    const ids = MODULE_FLOWS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every module has at least one step', () => {
    for (const m of MODULE_FLOWS) expect(m.steps.length).toBeGreaterThan(0);
  });

  it('every gate permission is a real PERMISSIONS constant', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        for (const g of s.gate) expect(ALL_PERMS.has(g)).toBe(true);
        for (const g of s.branch?.gate ?? []) expect(ALL_PERMS.has(g)).toBe(true);
      }
    }
  });

  it('every module category is one of the known categories', () => {
    for (const m of MODULE_FLOWS) expect(CATEGORY_ORDER).toContain(m.category);
  });

  // Anti-recurrence guard: gate: [] used to silently render as "any user" in
  // FlowChart even when the real backend gate was requireSuperAdmin /
  // requireRole / public / automatic / config-gated. Every step must now
  // resolve to one of the three real access signals — no silent catch-all.
  it('every step resolves an access signal: gate, gateRoles, or access', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        const resolves = s.gate.length > 0 || (s.gateRoles?.length ?? 0) > 0 || s.access !== undefined;
        expect(resolves, `${m.id} → "${s.label}" has no gate, gateRoles, or access`).toBe(true);
      }
    }
  });

  it('every gateRoles entry is a known default role name', () => {
    const KNOWN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'MAINTENANCE', 'OPERATOR', 'VIEWER']);
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        for (const r of s.gateRoles ?? []) expect(KNOWN_ROLES.has(r)).toBe(true);
      }
    }
  });

  it('every access value is one of the four known enum values', () => {
    const KNOWN_ACCESS = new Set(['public', 'authenticated', 'automatic', 'configured']);
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        if (s.access !== undefined) expect(KNOWN_ACCESS.has(s.access)).toBe(true);
      }
    }
  });

  // Anti-recurrence guard: branch.gate: [] would silently render as "any user"
  // when actually the branch permission should be explicitly specified.
  // Every step that has a branch must resolve a non-empty gate.
  it('every branch resolves a non-empty gate', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        if (s.branch !== undefined) {
          expect(s.branch.gate.length, `${m.id} → "${s.label}" branch gate must be non-empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  // A branch (Bypass / Reject) only makes sense inside an ordered workflow.
  // If a module has any branch step it MUST render as a 'sequence' (arrowed
  // flow), never as a non-sequential capability list.
  it('any module with a branch step is layout "sequence"', () => {
    for (const m of MODULE_FLOWS) {
      const hasBranch = m.steps.some((s) => s.branch !== undefined);
      if (hasBranch) {
        expect(m.layout, `${m.id} has a branch step so it must be layout: 'sequence'`).toBe('sequence');
      }
    }
  });

  it('layout is only ever "sequence" or "actions" when set', () => {
    for (const m of MODULE_FLOWS) {
      if (m.layout !== undefined) expect(['sequence', 'actions']).toContain(m.layout);
    }
  });

  it('every gateRoles entry contains SUPER_ADMIN', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        if (s.gateRoles !== undefined && s.gateRoles.length > 0) {
          expect(s.gateRoles, `${m.id} → "${s.label}" gateRoles must contain SUPER_ADMIN`).toContain('SUPER_ADMIN');
        }
      }
    }
  });

  it('every step has exactly one access mode: gate, gateRoles, or access', () => {
    for (const m of MODULE_FLOWS) {
      for (const s of m.steps) {
        const hasModes = [
          s.gate.length > 0,
          (s.gateRoles?.length ?? 0) > 0,
          s.access !== undefined,
        ];
        const modeCount = hasModes.filter(Boolean).length;
        expect(modeCount, `${m.id} → "${s.label}" must have exactly one of: gate, gateRoles, access (found ${modeCount})`).toBe(1);
      }
    }
  });
});
