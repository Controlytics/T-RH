import { StatCard } from '@/components/ui/stat-card';

interface UserStatsBarProps {
  stats: {
    total: number;
    enabled: number;
    disabled: number;
    locked: number;
  };
}

/**
 * The four user counts as StatCards (UI v3, 2026-09-21). Each card is ONE
 * number; the tone is the status the count describes, from the same tokens
 * every badge uses, so "Locked" here is the same amber as a locked user's
 * badge in the table below.
 */
const ICON = {
  total: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  enabled: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  locked: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
  disabled: 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636',
} as const;

const glyph = (d: string) => (
  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
);

export function UserStatsBar({ stats }: UserStatsBarProps) {
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatCard eyebrow="Total users" value={stats.total} icon={glyph(ICON.total)} />
      <StatCard eyebrow="Active" value={stats.enabled} icon={glyph(ICON.enabled)} tone="ok" />
      <StatCard eyebrow="Locked" value={stats.locked} icon={glyph(ICON.locked)} tone="warn" />
      <StatCard eyebrow="Disabled" value={stats.disabled} icon={glyph(ICON.disabled)} tone="danger" />
    </div>
  );
}
