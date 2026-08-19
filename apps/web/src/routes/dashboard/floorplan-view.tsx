import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  worstStatus,
  formatDecimals,
  TELEMETRY_DECIMALS_FALLBACK,
  type InstrumentStatus,
} from '@digilog/shared';
import { statusClasses, readingAge } from './status';
import { outOfSpec } from './set-point';
import {
  useFloorplans,
  useTelemetryOverview,
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

/**
 * ARCHITECTURAL DRAWING (operator reference `graphical.png`, 2026-08-13).
 *
 * Rooms are WHITE with dark walls, like a plan. Status colour lives in the value
 * CHIPS, not in the room fill. That is the whole point of the change: a floor of
 * pastel-tinted tiles cannot show two readings disagreeing — one room, one
 * colour — whereas a green temperature chip beside a red humidity chip says
 * exactly what is wrong. It also keeps a dense floor readable, because most of
 * the drawing stays white.
 *
 * Chip colours are SEMANTIC and deliberately not theme colours: a site that
 * themes the app purple must not end up with a purple "out of spec".
 */
const CHIP: Record<InstrumentStatus, { bg: string; glyph: string }> = {
  OUT_OF_SPEC: { bg: '#dc2626', glyph: '▲' },
  STALE: { bg: '#d97706', glyph: '◷' },
  PARTIAL: { bg: '#d97706', glyph: '◑' },
  NO_DATA: { bg: '#64748b', glyph: '·' },
  OK: { bg: '#15803d', glyph: '' },
};

/** Wall + label ink. Uniform across every room — the walls carry no status. */
const WALL = '#1f2937';
const INK = '#111827';
const INK_SOFT = '#374151';

interface RoomView {
  room: FloorplanRoomShape;
  rows: OverviewRow[];
  status: InstrumentStatus;
}

export function FloorplanView({ functionalLocationId, directOnly }: { functionalLocationId?: string; directOnly?: boolean } = {}) {
  const { plans, isLoading: plansLoading } = useFloorplans();
  // Scoped server-side. When a functional location is selected the rows are only
  // that location's instruments, so the rooms drawn below narrow with it.
  const { rows, refreshMs } = useTelemetryOverview({ functionalLocationId, directOnly });

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
    const all = plan.rooms.map((room) => {
      const roomRows = byRoom.get(room.id) ?? [];
      return { room, rows: roomRows, status: worstStatus(roomRows.map((r) => r.status)) };
    });
    // Unscoped: draw the whole floor, empty rooms included — that is the plan.
    // Scoped to a functional location: draw ONLY rooms holding one of its
    // instruments, otherwise selecting "Module-E" still renders the entire
    // building and the filter appears to have done nothing.
    return functionalLocationId ? all.filter((r) => r.rows.length > 0) : all;
  }, [plan, byRoom, functionalLocationId]);

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
      {/* Dark title bar: current plan on the left, the others as links on the
          right — the reference drawing's chrome. A <select> hid which other plans
          existed behind a click; these are visible at a glance. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl px-4 py-2.5"
        style={{ background: 'linear-gradient(135deg, var(--theme-sidebar-bg), var(--theme-primary-dark))' }}
      >
        <h3 className="text-sm font-bold tracking-wide text-white">{plan?.name ?? 'Floor plan'}</h3>
        <div className="flex flex-wrap items-center gap-1">
          {plans.filter((p) => p.id !== plan?.id).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlanId(p.id)}
              className="rounded px-2 py-1 text-xs font-semibold text-white/80 hover:bg-white/15 hover:text-white"
            >
              {p.name}
            </button>
          ))}
          <span className="ml-2 text-[11px] text-white/70">
            updates every {Math.round(refreshMs / 1000)}s
          </span>
        </div>
      </div>

      {/* Scoped, but none of this location's instruments sit in a room on this
          plan. Drawing the building with no rooms would read as "the plan is
          broken"; naming the actual fix is more useful than an empty rectangle. */}
      {plan && functionalLocationId && plan.rooms.length > 0 && roomViews.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm font-medium text-slate-700">
            No instruments in this functional location are placed on {plan.name}.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Place them on{' '}
            <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
              Configuration → Floorplans
            </Link>
            , or switch to the Tabular view, which does not need geometry.
          </p>
        </div>
      ) : plan && plan.rooms.length === 0 ? (
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
        <div className="overflow-hidden rounded-b-2xl border border-slate-300 bg-white p-3 shadow-soft">
          <svg
            viewBox={`0 0 ${VB_W} ${vbH}`}
            className="h-auto w-full"
            role="img"
            aria-label={`${plan.name}: ${roomViews.length} rooms with current temperature and humidity`}
          >
            {/* Building outline. White, not a grey slab: on a plan the paper is
                white and the ink is the information. */}
            <rect x={0} y={0} width={VB_W} height={vbH} fill="#ffffff" stroke={WALL} strokeWidth={3} />

            {roomViews.map(({ room, rows: roomRows, status }) => {
              const x = room.x * VB_W;
              const y = room.y * vbH;
              const w = room.w * VB_W;
              const h = room.h * vbH;
              const cx = x + w / 2;

              const first = roomRows[0];
              const tempV = first?.temperature?.value ?? null;
              const rhV = first?.humidity?.value ?? null;
              // The chips show `first`'s reading, so they take `first`'s own
              // precision. A room-wide number would misreport a room holding two
              // probes of different resolution.
              const tempDp = first?.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK;
              const rhDp = first?.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK;
              // Judged against the SAME band the row's status used — the
              // instrument's own limits where it has them, else the room's,
              // resolved once on the server. Reading `room.tempMin` here instead
              // (as this did until 2026-08-19) meant a chip could sit green on a
              // reading the very same instrument's row called out of spec.
              const chipLimits = first?.limits ?? null;
              const tempBad = outOfSpec(tempV, chipLimits?.tempMin, chipLimits?.tempMax);
              const rhBad = outOfSpec(rhV, chipLimits?.rhMin, chipLimits?.rhMax);

              // A reading's own chip colour: red when IT breaches, otherwise the
              // room's overall status (stale / no data / ok). This is what lets a
              // green temperature sit beside a red humidity in the same room.
              const chipFor = (bad: boolean): InstrumentStatus =>
                bad ? 'OUT_OF_SPEC' : status === 'OUT_OF_SPEC' ? 'OK' : status;

              // Text degrades as the box shrinks: a small room cannot hold four
              // lines, and overlapping text is worse than absent text.
              const fs = Math.max(8, Math.min(15, w / 10, h / 6));
              const showLabel = room.label && h > fs * 4.5 && w > fs * 6;
              const chips: { text: string; st: InstrumentStatus }[] = [];
              if (tempV !== null) chips.push({ text: `${formatDecimals(tempV, tempDp)} °C`, st: chipFor(tempBad) });
              if (rhV !== null) chips.push({ text: `${formatDecimals(rhV, rhDp)} %`, st: chipFor(rhBad) });
              const showChips = chips.length > 0 && h > fs * 3.2;

              const chipH = fs * 1.5;
              const blockH = (showChips ? chips.length * (chipH + 2) : 0) + fs * 1.2 + (showLabel ? fs * 1.15 : 0);
              let cursor = y + h / 2 - blockH / 2 + fs;

              return (
                <g
                  key={room.id}
                  onClick={() => setOpenRoomId(room.id)}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenRoomId(room.id); }}
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}, ${statusClasses(status).label}${
                    tempV !== null ? `, ${formatDecimals(tempV, tempDp)} degrees${tempBad ? ' out of spec' : ''}` : ''
                  }${rhV !== null ? `, ${formatDecimals(rhV, rhDp)} percent humidity${rhBad ? ' out of spec' : ''}` : ''}`}
                >
                  {/* Wall only — no status fill. The room is white like paper. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill="#ffffff"
                    stroke={WALL}
                    strokeWidth={2.5}
                    className="transition-colors hover:fill-slate-100"
                  />

                  <text
                    x={cx} y={cursor} textAnchor="middle"
                    fontSize={fs * 0.86} fontWeight={700} fill={INK}
                  >
                    {room.code}
                  </text>
                  {showLabel && (
                    <text
                      x={cx} y={(cursor += fs * 1.15)} textAnchor="middle"
                      fontSize={fs * 0.8} fill={INK_SOFT}
                    >
                      {room.label}
                    </text>
                  )}

                  {/* Solid value chips — the colour belongs to the READING. */}
                  {showChips && chips.map((chip, ci) => {
                    const paint = CHIP[chip.st];
                    const label = paint.glyph ? `${paint.glyph} ${chip.text}` : chip.text;
                    const cw = Math.min(w - 6, label.length * fs * 0.62 + fs * 0.7);
                    const cyTop = (cursor += ci === 0 ? fs * 0.6 : chipH + 2);
                    return (
                      <g key={chip.text}>
                        <rect
                          x={cx - cw / 2} y={cyTop} width={cw} height={chipH}
                          rx={2} fill={paint.bg}
                        />
                        <text
                          x={cx} y={cyTop + chipH * 0.72} textAnchor="middle"
                          fontSize={fs * 0.82} fontWeight={700} fill="#ffffff"
                        >
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend — status is never colour alone. */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <span className="text-xs font-semibold text-slate-700">Reading colour:</span>
        {(['OK', 'OUT_OF_SPEC', 'STALE', 'PARTIAL', 'NO_DATA'] as InstrumentStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-bold text-white"
              style={{ backgroundColor: CHIP[s].bg }}
            >
              {CHIP[s].glyph || '21.7'}
            </span>
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
            Not on a plan. Each is still checked against its own limit attributes, where it has them.
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
                    {formatSlot(r.temperature, r.decimals.temperature, '°C')} · {formatSlot(r.humidity, r.decimals.humidity, '%RH')}
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
