import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';

interface Row {
  id: string; name: string; code: string; instrumentType: string;
  deviceKey: string | null; isActive: boolean;
  hierarchyNode: { name: string } | null;
  gateway: { name: string } | null;
}

export default function InstrumentsPage() {
  const can = useCan();
  const { data, isLoading } = useSWR<Row[]>('/api/instruments');

  if (isLoading) return <div className="p-6 text-slate-500">Loading instruments…</div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Instruments</h1>
        {can('instruments.create') && (
          <Link to="/data-injection/instruments/create"
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white">Create Instrument</Link>
        )}
      </div>
      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">Type</th>
              <th className="p-3">Location</th><th className="p-3">Gateway</th>
              <th className="p-3">Device key</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">No instruments yet.</td></tr>
            )}
            {(data ?? []).map(r => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3">{r.name}</td>
                <td className="p-3 font-mono text-xs">{r.code}</td>
                <td className="p-3 text-slate-500">{r.instrumentType}</td>
                <td className="p-3 text-slate-500">{r.hierarchyNode?.name ?? '—'}</td>
                <td className="p-3 text-slate-500">{r.gateway?.name ?? 'Independent'}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{r.deviceKey ?? '—'}</td>
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
