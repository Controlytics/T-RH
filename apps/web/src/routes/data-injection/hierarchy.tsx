import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';

const LEVELS = ['COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE'] as const;
type Level = (typeof LEVELS)[number];

interface Node {
  id: string; parentId: string | null; level: Level;
  name: string; slug: string; path: string; isActive: boolean;
}

export default function HierarchyPage() {
  const can = useCan();
  const { toast } = useToast();
  const { data: nodes, mutate, isLoading } = useSWR<Node[]>('/api/hierarchy');
  const [parentId, setParentId] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>('COMPANY');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // API returns path-ordered rows with a dot-separated ltree path (e.g.
  // "controlyt.india.area_02" — see hierarchy.repository.ts's listTree()),
  // so depth is the number of dot-separated segments minus one. Splitting on
  // '/' (as an earlier draft of this page did) always yields a 1-element
  // array since the path never contains a slash, which flattened the tree.
  const rows = useMemo(
    () => (nodes ?? []).map(n => ({ ...n, depth: n.path.split('.').length - 1 })),
    [nodes],
  );

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await apiClient.post('/api/hierarchy', { parentId, level, name });
      toast.successToast('Node created');
      setName('');
      await mutate();
    } catch (e) {
      toast.errorToast('Could not create node', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await apiClient.delete(`/api/hierarchy/${id}`);
      toast.successToast('Node deleted');
      await mutate();
    } catch (e) {
      // Delete is leaf-only server-side; surface the backend's specific
      // "N children/gateways/instruments block this" message rather than a
      // generic failure toast.
      toast.errorToast('Could not delete node', (e as Error).message);
    }
  }

  if (isLoading) return <div className="p-6 text-slate-500">Loading hierarchy…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Hierarchy</h1>
      <p className="mt-1 text-sm text-slate-500">
        The location tree that UNS topic paths are derived from. A skipped level is simply omitted.
      </p>

      {can('hierarchy.create') && (
        <div className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Parent</span>
            <select className="rounded border border-slate-300 px-2 py-1.5"
              value={parentId ?? ''} onChange={e => setParentId(e.target.value || null)}>
              <option value="">(root)</option>
              {rows.map(n => <option key={n.id} value={n.id}>{' '.repeat(n.depth * 2)}{n.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Level</span>
            <select className="rounded border border-slate-300 px-2 py-1.5"
              value={level} onChange={e => setLevel(e.target.value as Level)}>
              {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Name</span>
            <input className="rounded border border-slate-300 px-2 py-1.5" value={name}
              onChange={e => setName(e.target.value)} placeholder="e.g. Plant 01" />
          </label>
          <button onClick={create} disabled={busy || !name.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">
            Add node
          </button>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr><th className="p-3">Name</th><th className="p-3">Level</th><th className="p-3">UNS path</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-slate-400">No hierarchy nodes yet.</td></tr>
            )}
            {rows.map(n => (
              <tr key={n.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3" style={{ paddingLeft: `${12 + n.depth * 20}px` }}>{n.name}</td>
                <td className="p-3 text-slate-500">{n.level}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{n.path}</td>
                <td className="p-3 text-right">
                  {can('hierarchy.delete') && (
                    <button onClick={() => remove(n.id, n.name)}
                      className="text-xs text-red-600 hover:underline">Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
