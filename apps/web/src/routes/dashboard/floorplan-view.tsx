import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { worstStatus, type InstrumentStatus } from '@digilog/shared';
import { statusClasses, readingAge } from './status';
import {
  useFloorplans,
  useTelemetryOverview,
  useTelemetrySettings,
  formatSlot,
  type FloorplanRoomShape,
  type OverviewRow,
} from './use-telemetry';
import { RoomDetail } from './room-detail';

/**
 * The floor, DRAWN.
 *
 * This does NOT render the uploaded plan image. Showing the scan with
 * transparent hotspots over it reads as a photo with rectangles stuck on top:
 * the rooms are invisible until hovered, and the drawing's own ink competes with
 * the status colours it is supposed to be carrying. The image is a tracing guide
 * in the editor only.
 *
 * Rooms are stored as proportions (0..1), so they map straight onto an SVG
 * viewBox — the layout is resolution-independent and stays crisp at any zoom.
 *
 * Status colour NEVER carries meaning alone: every room that has a status also
 * shows a glyph and a word for it, and the legend repeats the pairing.
 */

/** viewBox width. Height follows the plan's aspect ratio. */
const VB_W = 1000;

/** Fill and stroke per status. Deliberately not the theme colours — a site that
 *  themes the app purple must not end up with a purple "out of spec". */
const ROOM_PAINT: Record<InstrumentStatus, { fill: string; stroke: string; ink: string; glyph: string }> = {
  OUT_OF_SPEC: { fill: '#fee2e2', stroke: '#dc2626', ink: '#991b1b', glyph: '▲' },
  STALE: { fill: '#fef3c7', stroke: '#d97706', ink: '#92400e', glyph: '◷' },
  PARTIAL: { fill: '#fef3c7', stroke: '#d97706', ink: '#92400e', glyph: '◑' },
  NO_DATA: { fill: '#f1f5f9', stroke: '#94a3b8', ink: '#475569', glyph: '·' },
  OK: { fill: '#dcfce7', stroke: '#16a34a', ink: '#166534', glyph: '●' },
};

interface RoomView {
  room: FloorplanRoomShape;
  rows: OverviewRow[];
  status: InstrumentStatus;
}

export function FloorplanView() {
  const { plans, isLoading: plansLoading } = useFloorplans();
  const { rows, refreshMs } = useTelemetryOverview();
  const { temperatureDecimals, humidityDecimals } = useTelemetrySettings();

  const [planId, setPlanId] = useState<string>('');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);

  const plan = plans.find((p) => p.id === planId) ?? plans[0] ?? null;

  const byRoom = useMemo(() => {
    const map = new Map<string, OverviewRow[]>();
    for (const r of rows) {
      if (!r.room) continue;
      const list = map.get(r.room.id);
      if (list) list.push(r);
      else map.set(r.room.id, [r]);
    }
    return map;
  }, [rows]);

  const roomViews: RoomView[] = useMemo(() => {
    if (!plan) return [];
    return plan.rooms.map((room) => {
      const roomRows = byRoom.get(room.id) ?? [];
      return { room, rows: roomRows, status: worstStatus(roomRows.map((r) => r.status)) };
    });
  }, [plan, byRoom]);

  // Instruments nobody has placed. NEVER omitted — an instrument silently
  // absent from the dashboard is the failure this tray exists to prevent.
  const unplaced = rows.filter((r) => !r.room);

  if (openRoomId && plan) {
    return (
      <RoomDetail
        floorplanId={plan.id}
        roomId={openRoomId}
        onBack={() => setOpenRoomId(null)}
      />
    );
  }

  if (!plansLoading && plans.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No floor layout yet.</p>
        <p className="mt-1 text-xs text-slate-500">
          Draw one on{' '}
          <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
            Configuration → Floorplans
          </Link>
          {' '}to see rooms here.
        </p>
      </div>
    );
  }

  const vbH = plan ? Math.round((VB_W * plan.imageHeight) / plan.imageWidth) : 700;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          value={plan?.id ?? ''}
          onChange={(e) => setPlanId(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        >
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="text-xs text-slate-500">
          Updates every {Math.round(refreshMs / 1000)}s
        </p>
      </div>

      {plan && plan.rooms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm font-medium text-slate-700">{plan.name} has no rooms drawn yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Draw them on{' '}
            <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
              Configuration → Floorplans
            </Link>.
          </p>
        </div>
      ) : plan && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-soft">
          <svg
            viewBox={`0 0 ${VB_W} ${vbH}`}
            className="h-auto w-full"
            role="img"
            aria-label={`${plan.name}: ${roomViews.length} rooms with current temperature and humidity`}
          >
            {/* Floor slab, so drawn rooms read as sitting inside a building
                rather than floating on the page background. */}
            <rect x={0} y={0} width={VB_W} height={vbH} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={2} />

            {roomViews.map(({ room, rows: roomRows, status }) => {
              const x = room.x * VB_W;
              const y = room.y * vbH;
              const w = room.w * VB_W;
              const h = room.h * vbH;
              const paint = ROOM_PAINT[status];
              const cx = x + w / 2;

              const first = roomRows[0];
              const temp = formatSlot(first?.temperature ?? null, temperatureDecimals, '°C');
              const rh = formatSlot(first?.humidity ?? null, humidityDecimals, '%RH');

              // Text degrades as the box shrinks: a small room cannot hold four
              // lines, and overlapping text is worse than absent text.
              const fs = Math.max(9, Math.min(18, w / 9, h / 5));
              const showLabel = h > fs * 5.5 && room.label;
              const showReadings = h > fs * 3.5 && roomRows.length > 0;
              const showStatus = h > fs * 7;
              const lines = 1 + (showLabel ? 1 : 0) + (showReadings ? 2 : 0) + (showStatus ? 1 : 0);
              let cursor = y + h / 2 - ((lines - 1) * fs * 1.15) / 2 + fs * 0.35;
              const nextY = () => { const v = cursor; cursor += fs * 1.15; return v; };

              return (
                <g
                  key={room.id}
                  onClick={() => setOpenRoomId(room.id)}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenRoomId(room.id); }}
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}, ${statusClasses(status).label}, ${temp}, ${rh}`}
                >
                  {/* Wall. Thick stroke is what makes this read as a room
                      rather than a coloured tile. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill={paint.fill}
                    stroke={paint.stroke}
                    strokeWidth={2.5}
                    className="transition-opacity hover:opacity-80"
                  />
                  <text
                    x={cx} y={nextY()} textAnchor="middle"
                    fontSize={fs} fontWeight={700} fill={paint.ink}
                  >
                    {room.code}
                  </text>
                  {showLabel && (
                    <text x={cx} y={nextY()} textAnchor="middle" fontSize={fs * 0.82} fill="#475569">
                      {room.label}
                    </text>
                  )}
                  {showReadings && (
                    <>
                      <text x={cx} y={nextY()} textAnchor="middle" fontSize={fs * 0.95} fontWeight={600} fill="#0f172a">
                        {temp}
                      </text>
                      <text x={cx} y={nextY()} textAnchor="middle" fontSize={fs * 0.95} fontWeight={600} fill="#0f172a">
                        {rh}
                      </text>
                    </>
                  )}
                  {/* Glyph + word, so the fill colour is never the only carrier
                      of the status. */}
                  {showStatus && (
                    <text x={cx} y={nextY()} textAnchor="middle" fontSize={fs * 0.8} fill={paint.ink}>
                      {paint.glyph} {statusClasses(status).label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend — status is never colour alone. */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
        {(['OK', 'OUT_OF_SPEC', 'STALE', 'PARTIAL', 'NO_DATA'] as InstrumentStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-block h-3 w-3 rounded-sm border"
              style={{ backgroundColor: ROOM_PAINT[s].fill, borderColor: ROOM_PAINT[s].stroke }}
            />
            <span style={{ color: ROOM_PAINT[s].ink }}>{ROOM_PAINT[s].glyph}</span>
            {statusClasses(s).label}
          </span>
        ))}
      </div>

      {unplaced.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-800">
            Not placed on any plan ({unplaced.length})
          </h3>
          <p className="mb-3 text-xs text-slate-500">
            These instruments are reporting but have no room, so they cannot be checked against limits.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {unplaced.map((r) => {
              const c = statusClasses(r.status);
              const latest = [r.temperature?.ts, r.humidity?.ts].filter(Boolean).sort().pop() ?? null;
              return (
                <div key={r.instrumentId} className={`rounded-lg border px-3 py-2 ${c.bg} ${c.border}`}>
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/instruments/${r.instrumentId}`} className="text-sm font-medium text-slate-800 hover:underline">
                      {r.code}
                    </Link>
                    <span className={`flex items-center gap-1 text-[11px] font-medium ${c.text}`}>
                      <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                      {c.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-slate-600">
                    {formatSlot(r.temperature, temperatureDecimals, '°C')} · {formatSlot(r.humidity, humidityDecimals, '%RH')}
                    <span className="text-slate-400"> · {readingAge(latest)}</span>
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
