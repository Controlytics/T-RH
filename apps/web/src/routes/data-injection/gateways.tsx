import useSWR from 'swr';

interface Row {
  id: string; name: string; code: string; gatewayType: string;
  externalId: string | null; isActive: boolean;
  hierarchyNode: { name: string } | null;
  _count: { instruments: number };
}

export default function GatewaysPage() {
  const { data, isLoading } = useSWR<Row[]>('/api/gateways');

  if (isLoading) return <div className="p-6 text-slate-500">Loading gateways…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Gateways</h1>
      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">Type</th>
              <th className="p-3">External ID</th><th className="p-3">Location</th>
              <th className="p-3">Instruments</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">No gateways yet.</td></tr>
            )}
            {(data ?? []).map(r => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3">{r.name}</td>
                <td className="p-3 font-mono text-xs">{r.code}</td>
                <td className="p-3 text-slate-500">{r.gatewayType}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{r.externalId ?? '—'}</td>
                <td className="p-3 text-slate-500">{r.hierarchyNode?.name ?? '—'}</td>
                <td className="p-3 text-slate-500">{r._count?.instruments ?? 0}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    r.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {r.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
