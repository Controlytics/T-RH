import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';

interface CountCard { label: string; count: number; to: string; visible: boolean }

export default function DataInjectionDashboard() {
  const can = useCan();
  const { data: instruments } = useSWR<unknown[]>(can('instruments.view') ? '/api/instruments' : null);
  const { data: gateways } = useSWR<unknown[]>(can('gateways.view') ? '/api/gateways' : null);
  const { data: profiles } = useSWR<unknown[]>(can('comm_profiles.view') ? '/api/communication-profiles' : null);
  const { data: nodes } = useSWR<unknown[]>(can('hierarchy.view') ? '/api/hierarchy' : null);

  const cards: CountCard[] = [
    { label: 'Instruments', count: instruments?.length ?? 0, to: '/data-injection/instruments', visible: can('instruments.view') },
    { label: 'Gateways', count: gateways?.length ?? 0, to: '/data-injection/gateways', visible: can('gateways.view') },
    { label: 'Communication Profiles', count: profiles?.length ?? 0, to: '/data-injection/profiles', visible: can('comm_profiles.view') },
    { label: 'Hierarchy Nodes', count: nodes?.length ?? 0, to: '/data-injection/hierarchy', visible: can('hierarchy.view') },
  ];

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Data Injection</h1>
      <p className="mt-1 text-sm text-slate-500">
        Instruments, gateways and industrial communication configuration.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.filter(c => c.visible).map(c => (
          <Link key={c.label} to={c.to}
            className="rounded-lg border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm
                       focus-visible:ring-2 focus-visible:ring-offset-2">
            <div className="text-3xl font-semibold text-slate-900">{c.count}</div>
            <div className="mt-1 text-sm text-slate-600">{c.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
