import { describe, it, expect } from 'vitest';
import type { DashboardTimeWindow } from '@digilog/shared';
import { selectionForSource } from '../selection';

const W: DashboardTimeWindow = { mode: 'relative', period: '7d' };
const P = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const L = '1b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';

describe('selectionForSource', () => {
  it('all → everything, not direct', () => {
    expect(selectionForSource({ mode: 'all' }, W)).toEqual({ directOnly: false, window: W });
  });
  it('profile → profileId', () => {
    expect(selectionForSource({ mode: 'profile', profileId: P }, W)).toEqual({ directOnly: false, profileId: P, window: W });
  });
  it('location → functionalLocationId and directOnly', () => {
    expect(selectionForSource({ mode: 'location', functionalLocationId: L, directOnly: true }, W))
      .toEqual({ functionalLocationId: L, directOnly: true, window: W });
  });
  it('instruments → the fixed list', () => {
    expect(selectionForSource({ mode: 'instruments', ids: [P, L] }, W))
      .toEqual({ directOnly: false, instrumentIds: [P, L], window: W });
  });
  it('null (an unreadable source) → an empty list, never everything', () => {
    expect(selectionForSource(null, W)).toEqual({ directOnly: false, instrumentIds: [], window: W });
  });
});
