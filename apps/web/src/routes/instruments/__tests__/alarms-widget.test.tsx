import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * The bug this guards: `statusText()` takes an optional configured-wording
 * argument, and the trend page's alarms widget must feed it the SAME config
 * (`/api/config/alarm-limits/status-texts`, mapped via `mapStatusTextsResponse`)
 * the Alarms page reads — not the shipped defaults. A test that only exercises
 * the fallback would pass against exactly this defect, so both cases are
 * asserted here.
 */

const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' };

const alarm = {
  id: 'a-1',
  instrumentCode: 'T-1',
  instrumentId: 'i-1',
  metric: 'TEMPERATURE',
  triggeredValue: 30,
  severity: 'CRITICAL',
  state: 'ACTIVE',
  raisedAt: '2026-08-10T00:00:00.000Z',
  clearedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT',
  limitKind: 'HIGH',
  clearedValue: null,
  ruleSnapshot: { limit: 25, decimals: 1 },
};

vi.mock('swr', () => ({
  default: () => ({ data: { data: [alarm] } }),
}));

vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }),
}));

const { AlarmsWidget } = await import('../trend');

describe('AlarmsWidget — configured status wording', () => {
  it('renders the shipped default while the config has not loaded (statusTexts undefined)', () => {
    render(<AlarmsWidget instrumentId="i-1" period={period} onExportPdf={() => {}} statusTexts={undefined} />);
    expect(screen.getByText('Still pending Unacknowledged')).toBeInTheDocument();
  });

  it('renders the CONFIGURED wording when the config has loaded — not the default', () => {
    render(
      <AlarmsWidget
        instrumentId="i-1"
        period={period}
        onExportPdf={() => {}}
        statusTexts={{
          activeUnack: 'Awaiting operator sign-off',
          activeAck: 'Active — Acknowledged',
          clearedUnack: 'Cleared — Unacknowledged',
          clearedAck: 'Cleared',
        }}
      />,
    );
    expect(screen.getByText('Awaiting operator sign-off')).toBeInTheDocument();
    expect(screen.queryByText('Still pending Unacknowledged')).toBeNull();
  });
});
