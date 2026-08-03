/**
 * Types and presentation helpers shared by the alarm queue, the acknowledgement
 * dialog and the instrument threshold panel.
 *
 * Kept in its own module rather than in `alarms.tsx` so the ack dialog can
 * import the sentinel + label helpers without a cycle (the queue imports the
 * dialog).
 */

export type AlarmSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
export type AlarmState = 'ACTIVE' | 'ACTIVE_ACKED' | 'RESOLVED_UNACKED' | 'CLOSED';
export type ThresholdOperator = 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ' | 'OUT_OF_RANGE';

export interface AlarmRow {
  id: string;
  instrumentId: string;
  key: string;
  thresholdId: string | null;
  severity: AlarmSeverity;
  state: AlarmState;
  firstBreachAt: string;
  lastBreachAt: string;
  breachCount: number;
  triggerValue: number | null;
  peakValue: number | null;
  resolvedAt: string | null;
  ackedBy: string | null;
  ackedAt: string | null;
  ackReason: string | null;
  closedAt: string | null;
  instrument: { id: string; name: string; code: string };
  threshold: {
    id: string; operator: ThresholdOperator;
    limit: number | null; limitLow: number | null; limitHigh: number | null;
  } | null;
}

export interface ThresholdRow {
  id: string;
  instrumentId: string;
  key: string;
  operator: ThresholdOperator;
  limit: number | null;
  limitLow: number | null;
  limitHigh: number | null;
  hysteresis: number;
  severity: AlarmSeverity;
  isActive: boolean;
}

/**
 * Sentinel `key` the liveness sweep writes for a device-offline alarm
 * (`workers/liveness-sweep.worker.ts`). It is an internal marker, not a
 * telemetry key — never show it to an operator; see `measurementLabel`.
 */
export const LIVENESS_KEY = '__liveness__';

export function isLivenessAlarm(a: { key: string }): boolean {
  return a.key === LIVENESS_KEY;
}

/** Operator-facing name for an alarm's measurement column. */
export function measurementLabel(key: string): string {
  return key === LIVENESS_KEY ? 'Device offline' : key;
}

export const SEVERITY_ORDER: AlarmSeverity[] = ['CRITICAL', 'MAJOR', 'MINOR', 'INFO'];

export const ALARM_STATES: AlarmState[] = ['ACTIVE', 'ACTIVE_ACKED', 'RESOLVED_UNACKED', 'CLOSED'];

/** Everything except CLOSED — the alarms still awaiting attention. */
export const OPEN_ALARM_STATES: AlarmState[] = ['ACTIVE', 'ACTIVE_ACKED', 'RESOLVED_UNACKED'];

export const STATE_LABELS: Record<AlarmState, string> = {
  ACTIVE: 'Active',
  ACTIVE_ACKED: 'Active — acknowledged',
  RESOLVED_UNACKED: 'Resolved — needs signature',
  CLOSED: 'Closed',
};

export const OPERATOR_LABELS: Record<ThresholdOperator, string> = {
  GT: 'greater than',
  GTE: 'greater than or equal to',
  LT: 'less than',
  LTE: 'less than or equal to',
  EQ: 'equal to',
  NEQ: 'not equal to',
  OUT_OF_RANGE: 'outside range',
};

export const SEVERITY_LABELS: Record<AlarmSeverity, string> = {
  CRITICAL: 'Critical',
  MAJOR: 'Major',
  MINOR: 'Minor',
  INFO: 'Info',
};

export function formatNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  // Trim float noise (0.30000000000000004) without truncating real precision.
  return String(Number(v.toFixed(4)));
}

/** Human-readable summary of what a threshold trips on. */
export function describeThreshold(t: {
  operator: ThresholdOperator; limit: number | null;
  limitLow: number | null; limitHigh: number | null;
}): string {
  if (t.operator === 'OUT_OF_RANGE') {
    return `outside ${formatNumber(t.limitLow)} … ${formatNumber(t.limitHigh)}`;
  }
  return `${OPERATOR_LABELS[t.operator]} ${formatNumber(t.limit)}`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
