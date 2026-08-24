import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  worstStatus,
  formatDecimals,
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
import { wallSegments, doorPlacements, tileLayout } from './room-geometry';

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

/**
 * One object so a dark wall-display palette is a value swap rather than a
 * rewrite. The dark values are deliberately NOT authored yet — a scheme guessed
 * at without seeing it on the target display is wasted work.
 *
 * Chip colours are NOT in here: they are semantic and must not vary with the
 * surface, or a themed site ends up with a purple "out of spec".
 */
const PALETTE = {
  paper: '#ffffff',
  wall: '#1f2937',
  ink: '#111827',
  inkSoft: '#374151',
  tile: '#f8fafc',
  tileBorder: '#cbd5e1',
} as const;

interface RoomView {
  room: FloorplanRoomShape;
  rows: OverviewRow[];
  status: InstrumentStatus;
}

export function FloorplanView({ functionalLocationId, directOnly }: { functionalLocationId?: string; directOnly?: boolean } = {}) {
  const navigate = useNavigate();
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
            <rect x={0} y={0} width={VB_W} height={vbH} fill={PALETTE.paper} stroke={PALETTE.wall} strokeWidth={3} />

            {roomViews.map(({ room, rows: roomRows, status }) => {
              const x = room.x * VB_W;
              const y = room.y * vbH;
              const w = room.w * VB_W;
              const h = room.h * vbH;

              return (
                <g
                  key={room.id}
                  onClick={() => setOpenRoomId(room.id)}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenRoomId(room.id); }}
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}, ${statusClasses(status).label}, ${
                    roomRows.length
                  } instrument${roomRows.length === 1 ? '' : 's'}${
                    room.doors && room.doors.length > 0
                      ? `, ${room.doors.length} door${room.doors.length === 1 ? '' : 's'}`
                      : ''
                  }`}
                >
                  {/* Fill only. The walls are separate segments below, because a
                      stroked rect cannot have a door cut out of it. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill={PALETTE.paper}
                    className="transition-colors hover:fill-slate-100"
                  />

                  {wallSegments({ x, y, w, h }, room.doors).map((s, i) => (
                    <line
                      key={`w${i}`}
                      x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={PALETTE.wall} strokeWidth={2.5} strokeLinecap="butt"
                    />
                  ))}

                  {/* Doors: leaf + swing arc, in wall ink only. A door carries no
                      reading — nothing in this install senses one — so giving it
                      status colour would compete with the chips for no meaning. */}
                  {doorPlacements({ x, y, w, h }, room.doors).map((d, i) => (
                    <g key={`d${i}`}>
                      <line
                        x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2}
                        stroke={PALETTE.wall} strokeWidth={1.6}
                      />
                      <path d={d.arc} fill="none" stroke={PALETTE.inkSoft} strokeWidth={1} strokeDasharray="3 2" />
                      {d.kind !== 'PASSAGE' && (
                        <text
                          x={(d.start.x1 + d.start.x2) / 2}
                          y={(d.start.y1 + d.start.y2) / 2 - 2}
                          textAnchor="middle" fontSize={7} fontWeight={700} fill={PALETTE.inkSoft}
                        >
                          {d.kind === 'ENTRY' ? 'IN' : 'OUT'}
                        </text>
                      )}
                    </g>
                  ))}

                  <text
                    x={x + w / 2} y={y + 10} textAnchor="middle"
                    fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.86} fontWeight={700} fill={PALETTE.ink}
                  >
                    {room.code}
                  </text>
                  {room.label && tileLayout({ x, y, w, h }, roomRows.length).step === 'CODE_ONLY' && (
                    <text
                      x={x + w / 2} y={y + 22} textAnchor="middle"
                      fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.8} fill={PALETTE.inkSoft}
                    >
                      {room.label}
                    </text>
                  )}

                  {(() => {
                    const layout = tileLayout({ x, y, w, h }, roomRows.length);
                    if (layout.visible === 0) return null;

                    return roomRows.slice(0, layout.visible).map((row, i) => {
                      const col = i % layout.cols;
                      const rowIx = Math.floor(i / layout.cols);
                      const tx = x + col * layout.tile.w;
                      const ty = layout.bodyTop + rowIx * layout.tile.h;
                      const tcx = tx + layout.tile.w / 2;

                      const tempV = row.temperature?.value ?? null;
                      const rhV = row.humidity?.value ?? null;
                      const lim = row.limits;
                      const tempBad = outOfSpec(tempV, lim?.tempMin, lim?.tempMax);
                      const rhBad = outOfSpec(rhV, lim?.rhMin, lim?.rhMax);
                      const chipFor = (bad: boolean): InstrumentStatus =>
                        bad ? 'OUT_OF_SPEC' : row.status === 'OUT_OF_SPEC' ? 'OK' : row.status;

                      const values: { text: string; st: InstrumentStatus }[] = [];
                      if (tempV !== null) {
                        values.push({
                          text: `${formatDecimals(tempV, row.decimals.temperature)}°`,
                          st: chipFor(tempBad),
                        });
                      }
                      if (rhV !== null) {
                        values.push({
                          text: `${formatDecimals(rhV, row.decimals.humidity)}%`,
                          st: chipFor(rhBad),
                        });
                      }

                      return (
                        <g
                          key={row.instrumentId}
                          onClick={(e) => { e.stopPropagation(); navigate(`/instruments/${row.instrumentId}`); }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              navigate(`/instruments/${row.instrumentId}`);
                            }
                          }}
                          aria-label={`${row.code}${
                            tempV !== null ? `, ${formatDecimals(tempV, row.decimals.temperature)} degrees${tempBad ? ' out of spec' : ''}` : ''
                          }${rhV !== null ? `, ${formatDecimals(rhV, row.decimals.humidity)} percent humidity${rhBad ? ' out of spec' : ''}` : ''}`}
                        >
                          <rect
                            x={tx + 1.5} y={ty + 1} width={layout.tile.w - 3} height={layout.tile.h - 2}
                            rx={2} fill={PALETTE.tile} stroke={PALETTE.tileBorder} strokeWidth={0.8}
                          />
                          {layout.step === 'FULL' && (
                            <text
                              x={tcx} y={ty + layout.fontSize + 1} textAnchor="middle"
                              fontSize={layout.fontSize * 0.85} fontWeight={700} fill={PALETTE.ink}
                            >
                              {row.code}
                            </text>
                          )}
                          {values.map((v, vi) => {
                            const paint = CHIP[v.st];
                            const label = paint.glyph ? `${paint.glyph} ${v.text}` : v.text;
                            const cw = Math.min(layout.tile.w - 6, label.length * layout.fontSize * 0.6 + 4);
                            const chipH = layout.fontSize * 1.3;
                            const cyTop =
                              ty + (layout.step === 'FULL' ? layout.fontSize + 3 : 2) + vi * (chipH + 1.5);
                            if (cyTop + chipH > ty + layout.tile.h) return null;
                            return (
                              <g key={v.text}>
                                <rect x={tcx - cw / 2} y={cyTop} width={cw} height={chipH} rx={2} fill={paint.bg} />
                                <text
                                  x={tcx} y={cyTop + chipH * 0.75} textAnchor="middle"
                                  fontSize={layout.fontSize * 0.8} fontWeight={700} fill="#ffffff"
                                >
                                  {label}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      );
                    });
                  })()}

                  {(() => {
                    const layout = tileLayout({ x, y, w, h }, roomRows.length);
                    if (layout.hidden <= 0) return null;
                    const i = layout.visible;
                    const col = layout.cols > 0 ? i % layout.cols : 0;
                    const rowIx = layout.cols > 0 ? Math.floor(i / layout.cols) : 0;
                    return (
                      <text
                        x={x + col * layout.tile.w + layout.tile.w / 2}
                        y={layout.bodyTop + rowIx * layout.tile.h + layout.fontSize + 2}
                        textAnchor="middle" fontSize={layout.fontSize * 0.85}
                        fontWeight={700} fill={PALETTE.inkSoft}
                      >
                        +{layout.hidden}
                      </text>
                    );
                  })()}
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
