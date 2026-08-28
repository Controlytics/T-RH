interface UserStatsBarProps {
  stats: {
    total: number;
    enabled: number;
    disabled: number;
    locked: number;
  };
}

export function UserStatsBar({ stats }: UserStatsBarProps) {
  return (
    <div className="grid grid-cols-4 gap-4">
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-sm p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-100">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-800">{stats.total}</p>
            <p className="text-xs text-slate-500">Total Users</p>
          </div>
        </div>
      </div>
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-sm p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-100">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-800">{stats.enabled}</p>
            <p className="text-xs text-slate-500">Active</p>
          </div>
        </div>
      </div>
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-sm p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-100">
            <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-800">{stats.locked}</p>
            <p className="text-xs text-slate-500">Locked</p>
          </div>
        </div>
      </div>
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-sm p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-red-100">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <div>
            <p className="text-2xl font-bold text-slate-800">{stats.disabled}</p>
            <p className="text-xs text-slate-500">Disabled</p>
          </div>
        </div>
      </div>
    </div>
  );
}
