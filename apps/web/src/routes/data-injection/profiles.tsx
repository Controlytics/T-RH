import useSWR from 'swr';

// NOTE: the API response includes a `config` field, but it may carry
// broker passwords / client certs / API keys (masked server-side via an
// allowlist, not stripped). Never destructure or render it here.
interface Row {
  id: string; name: string; protocolKey: string; isActive: boolean;
}

export default function ProfilesPage() {
  const { data, isLoading } = useSWR<Row[]>('/api/communication-profiles');

  if (isLoading) return <div className="p-6 text-slate-500">Loading communication profiles…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Communication Profiles</h1>
      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Name</th><th className="p-3">Protocol</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-slate-400">No communication profiles yet.</td></tr>
            )}
            {(data ?? []).map(r => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3">{r.name}</td>
                <td className="p-3 text-slate-500">{r.protocolKey}</td>
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
