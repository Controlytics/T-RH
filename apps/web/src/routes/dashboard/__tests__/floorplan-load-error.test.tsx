import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * A FAILED plan load is not "no layout" (audit 2026-10-12 finding 5). A role
 * the plan list refused (it was CONFIG_READ-only until that day) saw "No floor
 * layout yet. Draw one on Configuration → Layout Designer" — an instruction
 * that is false and that it cannot follow. A failed load now says the layouts
 * could not be loaded, with the server's reason, and never the empty state.
 */
let PLANS_ERROR: unknown = undefined;
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: [], isLoading: false, error: PLANS_ERROR }),
  useTelemetryOverview: () => ({ rows: [], isLoading: false, error: undefined }),
}));

const { FloorplanView } = await import('../floorplan-view');
const mount = () => render(<MemoryRouter><FloorplanView /></MemoryRouter>);

describe('FloorplanView when the plan list fails to load', () => {
  it('shows a load error with the reason, not the "no layout yet" empty state', () => {
    PLANS_ERROR = { error: 'FORBIDDEN', message: 'Permission denied' };
    mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(alert.textContent).toMatch(/Permission denied/);
    expect(screen.queryByText(/No floor layout yet/)).toBeNull();
  });

  it('with no error and no plans it is still the empty state (positive control)', () => {
    PLANS_ERROR = undefined;
    mount();
    expect(screen.getByText(/No floor layout yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
