import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';
import { apiClient } from '@/lib/api-client';
import { OPEN_ALARM_STATES, type AlarmRow } from './alarm-shared';

interface CountCard { label: string; count: number; to: string; visible: boolean }

interface ConnectionHealth {
  connected: boolean;
  lastMessageAt: string | null;
  lastError: string | null;
  messagesReceived: number;
  reconnectCount: number;
  profileName: string;
  protocolKey: string;
  startError: string | null;
  subscriptionCount: number;
}

interface HealthResponse {
  connections: Record<string, ConnectionHealth>;
  queue: { depth: number; dropped: number; flushed: number };
}

function age(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DataInjectionDashboard() {
  const can = useCan();
  const { data: instruments } = useSWR<unknown[]>(can('instruments.view') ? '/api/instruments' : null);
  const { data: gateways } = useSWR<unknown[]>(can('gateways.view') ? '/api/gateways' : null);
  const { data: profiles } = useSWR<unknown[]>(can('comm_profiles.view') ? '/api/communication-profiles' : null);
  const { data: nodes } = useSWR<unknown[]>(can('hierarchy.view') ? '/api/hierarchy' : null);

  // Open alarms = everything except CLOSED. The API filters on a single state
  // enum, so this is one request per open state (see alarms.tsx for why an
  // unfiltered call would be wrong).
  const { data: openAlarms } = useSWR<AlarmRow[]>(
    can('alarms.view') ? ['alarms-open-count'] : null,
    async () => {
      const res = await Promise.all(OPEN_ALARM_STATES.map(
        s => apiClient.get<AlarmRow[]>(`/api/alarms?state=${s}`),
      ));
      return res.flat();
    },
    { refreshInterval: 30_000 },
  );

  // Conditional keys — null when the user lacks the permission, so no 403 ever
  // reaches the console. Same convention as the counts above.
  const { data: health } = useSWR<HealthResponse>(
    can('instruments.view') ? '/api/data-injection/health' : null,
    { refreshInterval: 10_000 },
  );
  const { data: deadLetters } = useSWR<{ rows: unknown[]; total: number }>(
    can('instruments.view') ? '/api/data-injection/dead-letters?resolved=false&limit=1' : null,
    { refreshInterval: 10_000 },
  );

  const connections = Object.entries(health?.connections ?? {});
  const unresolved = deadLetters?.total ?? 0;

  const cards: CountCard[] = [
    { label: 'Instruments', count: instruments?.length ?? 0, to: '/data-injection/instruments', visible: can('instruments.view') },
    { label: 'Gateways', count: gateways?.length ?? 0, to: '/data-injection/gateways', visible: can('gateways.view') },
    { label: 'Communication Profiles', count: profiles?.length ?? 0, to: '/data-injection/profiles', visible: can('comm_profiles.view') },
    { label: 'Hierarchy Nodes', count: nodes?.length ?? 0, to: '/data-injection/hierarchy', visible: can('hierarchy.view') },
    // Alarms is reached from this hub like every other Data Injection page —
    // none of them carry their own top-level sidebar item.
    { label: 'Open Alarms', count: openAlarms?.length ?? 0, to: '/data-injection/alarms', visible: can('alarms.view') },
  ];

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Data Injection</h1>
      <p className="mt-1 text-sm text-slate-500">
        Instruments, gateways and industrial communication configuration.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.filter(c => c.visible).map(c => (
          <Link key={c.label} to={c.to}
            className="rounded-lg border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm
                       focus-visible:ring-2 focus-visible:ring-offset-2">
            <div className="text-3xl font-semibold text-slate-900">{c.count}</div>
            <div className="mt-1 text-sm text-slate-600">{c.label}</div>
          </Link>
        ))}
      </div>

      {can('instruments.view') && (
        <section className="mt-8">
          <h2 className="text-lg font-medium text-slate-900">Ingestion health</h2>

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/*
              A non-zero unresolved dead-letter count is the most useful signal
              here: it means data IS arriving and being rejected, which is
              invisible everywhere else — the connection looks healthy and the
              telemetry tables simply stay empty.
            */}
            <div className={`rounded-lg border p-5 ${
              unresolved > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
              <div className={`text-3xl font-semibold ${
                unresolved > 0 ? 'text-amber-800' : 'text-slate-900'}`}>{unresolved}</div>
              <div className="mt-1 text-sm text-slate-600">Unresolved dead letters</div>
              {unresolved > 0 && (
                <div className="mt-1 text-xs text-amber-800">
                  Messages are arriving and being rejected.
                </div>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="text-3xl font-semibold text-slate-900">{health?.queue.depth ?? 0}</div>
              <div className="mt-1 text-sm text-slate-600">Queued messages</div>
              <div className="mt-1 text-xs text-slate-400">
                {health?.queue.flushed ?? 0} written · {health?.queue.dropped ?? 0} dropped
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="text-3xl font-semibold text-slate-900">
                {connections.filter(([, c]) => c.connected).length}/{connections.length}
              </div>
              <div className="mt-1 text-sm text-slate-600">Connections up</div>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="p-3">Profile</th><th className="p-3">Protocol</th>
                  <th className="p-3">State</th><th className="p-3">Subscriptions</th>
                  <th className="p-3">Messages</th><th className="p-3">Last message</th>
                  <th className="p-3">Reconnects</th>
                </tr>
              </thead>
              <tbody>
                {connections.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500">
                      <div className="font-medium text-slate-700">No protocol connections running</div>
                      <div className="mt-1 text-xs">
                        A protocol must be enabled and a communication profile active
                        before the server connects to a broker.
                      </div>
                    </td>
                  </tr>
                )}
                {connections.map(([id, c]) => (
                  <tr key={id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="p-3 text-slate-900">{c.profileName}</td>
                    <td className="p-3 text-slate-500">{c.protocolKey}</td>
                    <td className="p-3">
                      <span className={`rounded px-2 py-0.5 text-xs ${
                        c.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                        {c.connected ? 'Connected' : 'Disconnected'}
                      </span>
                      {c.startError && <div className="mt-1 text-xs text-red-700">{c.startError}</div>}
                      {!c.startError && c.lastError && (
                        <div className="mt-1 text-xs text-amber-700">{c.lastError}</div>
                      )}
                    </td>
                    <td className="p-3 text-slate-500">{c.subscriptionCount}</td>
                    <td className="p-3 text-slate-500">{c.messagesReceived}</td>
                    <td className="p-3 text-slate-500">{age(c.lastMessageAt)}</td>
                    <td className="p-3 text-slate-500">{c.reconnectCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
