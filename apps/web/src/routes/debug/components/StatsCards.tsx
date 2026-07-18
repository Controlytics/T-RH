import type { TraceStats } from '../types';
import { formatDuration } from '../helpers';

// ---------------------------------------------------------------------------
// Stats Cards
// ---------------------------------------------------------------------------

export function StatsCards({ stats, total }: { stats: TraceStats | undefined; total: number }) {
  const statItems = [
    {
      label: 'Success Rate (1h)',
      value: stats ? `${stats.successRate1h.toFixed(1)}%` : '—',
      gradient: 'from-emerald-500 to-teal-600',
      iconBg: 'bg-gradient-to-br from-emerald-500 to-teal-600',
      icon: (
        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      valueClass: stats && stats.successRate1h < 90 ? 'text-red-600' : 'text-emerald-600',
    },
    {
      label: 'Success Rate (24h)',
      value: stats ? `${stats.successRate24h.toFixed(1)}%` : '—',
      gradient: 'from-blue-500 to-indigo-600',
      iconBg: 'bg-gradient-to-br from-blue-500 to-indigo-600',
      icon: (
        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
      valueClass: stats && stats.successRate24h < 90 ? 'text-red-600' : 'text-blue-600',
    },
    {
      label: 'Avg Duration',
      value: stats ? formatDuration(Math.round(stats.avgDurationMs)) : '—',
      gradient: 'from-violet-500 to-purple-600',
      iconBg: 'bg-gradient-to-br from-violet-500 to-purple-600',
      icon: (
        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      valueClass: 'text-violet-600',
    },
    {
      label: 'Total Traces',
      value: total.toLocaleString(),
      gradient: 'from-cyan-500 to-blue-600',
      iconBg: 'bg-gradient-to-br from-cyan-500 to-blue-600',
      icon: (
        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      ),
      valueClass: 'text-cyan-700',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {statItems.map((item) => (
        <div
          key={item.label}
          className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 p-5 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider leading-tight">{item.label}</p>
            <div className={`p-2 rounded-xl ${item.iconBg} shadow-lg`}>{item.icon}</div>
          </div>
          <p className={`text-2xl font-bold ${item.valueClass}`}>{item.value}</p>
        </div>
      ))}
    </div>
  );
}
