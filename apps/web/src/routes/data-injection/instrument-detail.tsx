import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { InstrumentThresholds } from './instrument-thresholds';
import { SeverityPill } from './alarm-severity-pill';
import { useCan } from '@/hooks/use-can';
import { OPEN_ALARM_STATES, SEVERITY_ORDER, type AlarmRow } from './alarm-shared';

interface Instrument {
  id: string; name: string; code: string; instrumentType: string;
  deviceKey: string | null; isActive: boolean;
  expectedIntervalSec: number | null;
  hierarchyNode: { name: string } | null;
  gateway: { name: string; slug: string } | null;
}

interface Reading {
  key: string; value: unknown; valueType: string;
  quality: string | null; ts: string; receivedAt: string;
}

/** Compact "how long ago" — a stale reading is the thing an operator looks for. */
function age(iso: string): string {
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

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const PAGE = 25;

export default function InstrumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const [key, setKey] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const { data: instrument } = useSWR<Instrument>(id ? `/api/instruments/${id}` : null);
  const { data: topics } = useSWR<Record<string, string>>(id ? `/api/instruments/${id}/topics` : null);

  // Live panel — polls. The interval is the only thing making this "live";
  // there is no push channel in this build.
  const { data: latest } = useSWR<{ instrumentId: string; readings: Reading[] }>(
    id ? `/api/instruments/${id}/telemetry/latest` : null,
    { refreshInterval: 5000 },
  );

  const historyQuery = new URLSearchParams();
  if (key) historyQuery.set('key', key);
  if (from) historyQuery.set('from', new Date(from).toISOString());
  if (to) historyQuery.set('to', new Date(to).toISOString());
  historyQuery.set('limit', String(PAGE));
  historyQuery.set('offset', String(page * PAGE));

  const { data: history } = useSWR<{ rows: Reading[]; total: number }>(
    id ? `/api/instruments/${id}/telemetry/history?${historyQuery.toString()}` : null,
  );

  // Conditional key — null when the user lacks ALARM_VIEW, so no 403 reaches
  // the console. One request per open state; see alarms.tsx.
  const { data: openAlarms } = useSWR<AlarmRow[]>(
    id && can('alarms.view') ? ['instrument-open-alarms', id] : null,
    async () => {
      const res = await Promise.all(OPEN_ALARM_STATES.map(
        s => apiClient.get<AlarmRow[]>(`/api/alarms?state=${s}&instrumentId=${id}`),
      ));
      return res.flat();
    },
    { refreshInterval: 15_000 },
  );

  const openBySeverity = SEVERITY_ORDER
    .map(sev => ({ sev, count: (openAlarms ?? []).filter(a => a.severity === sev).length }))
    .filter(x => x.count > 0);

  const liveReadings = latest?.readings ?? [];
  const telemetryTopic = topics?.TELEMETRY;
  const totalPages = Math.max(1, Math.ceil((history?.total ?? 0) / PAGE));

  return (
    <div className="p-6">
      <Link to="/data-injection/instruments" className="text-sm text-slate-500 hover:text-slate-700">
        ← Instruments
      </Link>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{instrument?.name ?? 'Instrument'}</h1>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono text-xs">{instrument?.code}</span>
            {instrument?.hierarchyNode && <> · {instrument.hierarchyNode.name}</>}
            {instrument?.gateway ? <> · {instrument.gateway.name}</> : <> · Independent</>}
            {instrument?.deviceKey && <> · device key <span className="font-mono text-xs">{instrument.deviceKey}</span></>}
          </p>
        </div>
        {instrument && (
          <span className={`rounded px-2 py-0.5 text-xs ${
            instrument.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {instrument.isActive ? 'Active' : 'Inactive'}
          </span>
        )}
      </div>

      {/* ── Open alarms ──────────────────────────────────────────────────── */}
      {can('alarms.view') && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <span className="text-sm text-slate-600">Open alarms</span>
          {openBySeverity.length === 0 ? (
            <span className="text-sm text-slate-400">None</span>
          ) : (
            openBySeverity.map(({ sev, count }) => (
              <Link
                key={sev}
                to={`/data-injection/alarms?instrumentId=${id}`}
                className="inline-flex items-center gap-1.5 hover:underline"
              >
                <SeverityPill severity={sev} />
                <span className="tabular-nums text-sm font-medium text-slate-900">{count}</span>
              </Link>
            ))
          )}
          <Link
            to={`/data-injection/alarms?instrumentId=${id}`}
            className="ml-auto text-sm text-slate-500 hover:text-slate-700 hover:underline"
          >View alarm queue →</Link>
        </div>
      )}

      {/* ── Liveness ─────────────────────────────────────────────────────── */}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm text-slate-600">Expected reading interval</div>
        <div className="mt-1 text-slate-900">
          {instrument?.expectedIntervalSec == null
            ? 'Not set'
            : `${instrument.expectedIntervalSec}s`}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {instrument?.expectedIntervalSec == null
            ? 'Liveness monitoring is OFF for this instrument — no device-offline alarm will '
              + 'ever be raised, however long it stays silent.'
            : 'The liveness sweep raises a device-offline alarm when no reading arrives within '
              + 'this interval. Clearing it switches liveness monitoring off.'}
        </p>
      </div>

      {/* ── Live ─────────────────────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium text-slate-900">Live values</h2>
          <span className="text-xs text-slate-400">refreshes every 5s</span>
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="p-3">Key</th><th className="p-3">Value</th>
                <th className="p-3">Type</th><th className="p-3">Reading time</th>
                <th className="p-3">Age</th>
              </tr>
            </thead>
            <tbody>
              {liveReadings.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    <div className="font-medium text-slate-700">No telemetry received yet</div>
                    {/* A blank panel is indistinguishable from a broken one. Naming
                        the expected topic turns this into a diagnostic. */}
                    {telemetryTopic ? (
                      <div className="mt-2 text-xs">
                        Publish to{' '}
                        <span className="font-mono text-slate-800">{telemetryTopic}</span>
                        {' '}for readings to appear here.
                      </div>
                    ) : (
                      <div className="mt-2 text-xs">
                        This instrument has no derived telemetry topic yet.
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {liveReadings.map(r => (
                <tr key={r.key} className="border-b border-slate-100 last:border-0">
                  <td className="p-3 font-mono text-xs">{r.key}</td>
                  <td className="p-3 font-medium text-slate-900">{renderValue(r.value)}</td>
                  <td className="p-3 text-slate-500">{r.valueType}</td>
                  <td className="p-3 text-slate-500">{new Date(r.ts).toLocaleString()}</td>
                  <td className="p-3 text-slate-500">{age(r.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Topics ───────────────────────────────────────────────────────── */}
      {topics && (
        <section className="mt-6">
          <h2 className="text-lg font-medium text-slate-900">Derived topics</h2>
          <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
            {Object.entries(topics).map(([category, topic]) => (
              <div key={category} className="text-xs">
                <span className="text-slate-500">{category.toLowerCase()}</span>
                <div className="font-mono text-slate-800 break-all">{topic}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Alarm thresholds ─────────────────────────────────────────────── */}
      {id && can('alarms.view') && <InstrumentThresholds instrumentId={id} />}

      {/* ── History ──────────────────────────────────────────────────────── */}
      <section className="mt-6">
        <h2 className="text-lg font-medium text-slate-900">History</h2>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">
            Key
            <select
              value={key}
              onChange={e => { setKey(e.target.value); setPage(0); }}
              className="mt-1 block rounded border border-slate-200 px-2 py-1 text-sm"
            >
              <option value="">All keys</option>
              {liveReadings.map(r => <option key={r.key} value={r.key}>{r.key}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            From
            <input type="datetime-local" value={from}
              onChange={e => { setFrom(e.target.value); setPage(0); }}
              className="mt-1 block rounded border border-slate-200 px-2 py-1 text-sm" />
          </label>
          <label className="text-xs text-slate-600">
            To
            <input type="datetime-local" value={to}
              onChange={e => { setTo(e.target.value); setPage(0); }}
              className="mt-1 block rounded border border-slate-200 px-2 py-1 text-sm" />
          </label>
          {(key || from || to) && (
            <button
              onClick={() => { setKey(''); setFrom(''); setTo(''); setPage(0); }}
              className="rounded border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50"
            >Clear</button>
          )}
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="p-3">Reading time</th><th className="p-3">Key</th>
                <th className="p-3">Value</th><th className="p-3">Type</th>
                <th className="p-3">Received</th>
              </tr>
            </thead>
            <tbody>
              {(history?.rows ?? []).length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-slate-400">
                  No readings for this filter.
                </td></tr>
              )}
              {(history?.rows ?? []).map((r, i) => (
                <tr key={`${r.key}-${r.ts}-${i}`} className="border-b border-slate-100 last:border-0">
                  <td className="p-3 text-slate-700">{new Date(r.ts).toLocaleString()}</td>
                  <td className="p-3 font-mono text-xs">{r.key}</td>
                  <td className="p-3">{renderValue(r.value)}</td>
                  <td className="p-3 text-slate-500">{r.valueType}</td>
                  <td className="p-3 text-slate-500">{age(r.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <div>{history?.total ?? 0} reading(s)</div>
          <div className="flex items-center gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
              className="rounded border border-slate-200 px-3 py-1 disabled:opacity-40"
            >Previous</button>
            <span className="text-xs">Page {page + 1} of {totalPages}</span>
            <button
              disabled={page + 1 >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="rounded border border-slate-200 px-3 py-1 disabled:opacity-40"
            >Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
