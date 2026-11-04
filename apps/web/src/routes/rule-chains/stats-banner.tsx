import type { HeroTile } from '@/components/ui/page-hero';
import type { RuleEngineStats } from './types';

/**
 * The engine's figures on the Rule Chains list (rule chains, 2026-11-04; spec
 * section 11) — `GET /api/rule-chains/stats` as returned.
 *
 * Two kinds of thing, shown two ways: the steady figures (queue depth,
 * messages processed in the last minute) are the hero's tiles, one number
 * each; the two states that need someone — the engine switched OFF
 * (Configuration → Rule Engine), and messages DROPPED because the in-memory
 * queue was full — are a banner, in the status colours with a glyph and a
 * word, shown only while true. A dropped message is never processed by any
 * chain; the reading it came from is stored regardless.
 */
export function statsTiles(stats: RuleEngineStats | undefined): HeroTile[] {
  if (!stats) return [];
  return [
    { label: 'Queue', value: stats.queueDepth.toLocaleString(), hint: 'messages waiting', testId: 'stat-queue' },
    { label: 'Processed', value: stats.processedLastMinute.toLocaleString(), hint: 'in the last minute', testId: 'stat-processed' },
  ];
}

export function StatsBanner({ stats }: { stats: RuleEngineStats | undefined }) {
  if (!stats) return null;
  const off = !stats.enabled;
  const dropped = stats.dropped > 0;
  if (!off && !dropped) return null;
  return (
    <div data-testid="rule-engine-banner" className="space-y-2">
      {off && (
        <p
          role="status"
          data-state="off"
          className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--status-warn-dot)] bg-[var(--status-warn-bg)] px-4 py-3 text-sm font-medium text-[var(--status-warn-ink)]"
        >
          <span aria-hidden className="text-base">⏸</span>
          <span><strong>Rule engine off.</strong> No message is processed by any chain until it is switched on in Configuration → Rule Engine.</span>
        </p>
      )}
      {dropped && (
        <p
          role="alert"
          data-state="dropped"
          className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--status-danger-dot)] bg-[var(--status-danger-bg)] px-4 py-3 text-sm font-medium text-[var(--status-danger-ink)]"
        >
          <span aria-hidden className="text-base">⚠</span>
          <span>
            <strong data-testid="stat-dropped">{stats.dropped.toLocaleString()} dropped</strong>
            {' '}— messages the full queue could not hold, never processed by a chain. The readings themselves were stored.
          </span>
        </p>
      )}
    </div>
  );
}
