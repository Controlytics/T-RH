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
  ROOM_GRADES,
  ROOM_GRADE_META,
  type RoomGrade,
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
 * ARCHITECTURAL DRAWING (operator reference `graphical.png`, 2026-08-13;
 * restyled to docs/superpowers/specs/2026-08-24-graphical-view-visual-design.md).
 *
 * Rooms are drawn with dark walls, like a plan. STATUS colour lives in the value
 * CHIPS and nowhere else on the drawing: a floor tinted BY STATUS cannot show two
 * readings disagreeing — one room, one colour — whereas a green temperature chip
 * beside a red humidity chip says exactly what is wrong. The room fill carries a
 * different reading entirely (cleanroom grade, see ZONE below) at a chroma low
 * enough that it can never be mistaken for an alarm.
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
  /** The plate the building sits on, so the plan reads as a drawing, not a float. */
  ground: '#f8fafc',
  wall: '#1f2937',
  /** Doors read as openings, and match the operator's reference drawing. */
  door: '#0ea5e9',
  ink: '#111827',
  inkSoft: '#374151',
  /** Room label — subordinate to the code by size AND colour. */
  labelInk: '#475569',
  /** Corridor centre-line. */
  centreLine: '#94a3b8',
  /** Alarm halo. Same red as the OUT_OF_SPEC chip, deliberately. */
  alarm: '#dc2626',
  tile: '#ffffff',
  tileBorder: '#cbd5e1',
} as const;

/**
 * ZONE COLOUR — hue encodes cleanroom GRADE, saturation encodes STATUS.
 *
 * GMP floor plans are already colour-coded by classification, so this borrows
 * the subject's own vernacular instead of inventing a palette. The rule that
 * keeps the two readings from fighting: zone colour is LOW CHROMA and appears
 * in exactly three places — the room fill, the room code, and the grade tab.
 * Status colour is saturated and appears only in the chips and the alarm halo.
 * Walls, doors and the building outline are never zone-coloured: the zone
 * already speaks three times, and a fourth is what tips a dense floor into
 * noise.
 *
 * An unknown or absent grade falls back to `NONE`, which is exactly how the
 * drawing looked before grades existed — an absent classification is honest, a
 * guessed one is not.
 */
const NO_ZONE = { fill: PALETTE.paper, ink: PALETTE.wall } as const;

const ZONE: Record<RoomGrade, { fill: string; ink: string }> = {
  A: { fill: '#eef0ff', ink: '#4338ca' },
  B: { fill: '#e8f1fe', ink: '#1d4ed8' },
  C: { fill: '#e9f7f1', ink: '#047857' },
  D: { fill: '#fef5e7', ink: '#b45309' },
  CIRCULATION: { fill: '#eff2f7', ink: '#475569' },
  UTILITY: { fill: '#f4f4f5', ink: '#52525b' },
};

/** The API sends free text; anything not in the vocabulary draws unclassified. */
function zoneOf(grade: string | null): { fill: string; ink: string } {
  return grade && grade in ZONE ? ZONE[grade as RoomGrade] : NO_ZONE;
}

/**
 * The alarm halo pulses so a breach finds the eye from across the room — this
 * drawing's job is to be read from a monitoring wall. Motion is a real
 * accessibility cost, so `prefers-reduced-motion` drops to the static stroke;
 * the halo itself never goes away, because it is the thing carrying the alarm.
 */
const HALO_CSS = `
/* Hover feedback that does not repaint the zone: darkening keeps the hue, and
   works on a white unclassified room where a tint would be invisible. */
.fp-room-fill { transition: filter 120ms ease; }
.fp-room-fill:hover { filter: brightness(0.955); }
.fp-alarm-halo { opacity: 0.9; animation: fpAlarmPulse 2s ease-in-out infinite; }
@keyframes fpAlarmPulse { 0%, 100% { opacity: 0.9 } 50% { opacity: 0.35 } }
@media (prefers-reduced-motion: reduce) {
  .fp-alarm-halo { animation: none; opacity: 0.9; }
}
`;

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
            <style>{HALO_CSS}</style>

            {/* Building outline on its plate. The ground is a shade off white so
                the building reads as a drawing laid on something, and so the
                gaps between rooms are visibly OUTSIDE them. The ink is still the
                information. */}
            <rect x={0} y={0} width={VB_W} height={vbH} fill={PALETTE.ground} stroke={PALETTE.wall} strokeWidth={3} />

            {roomViews.map(({ room, rows: roomRows, status }) => {
              const x = room.x * VB_W;
              const y = room.y * vbH;
              const w = room.w * VB_W;
              const h = room.h * vbH;
              const zone = zoneOf(room.grade);
              const gradeMeta = room.grade && room.grade in ROOM_GRADE_META
                ? ROOM_GRADE_META[room.grade as RoomGrade]
                : null;

              return (
                <g
                  key={room.id}
                  onClick={() => setOpenRoomId(room.id)}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpenRoomId(room.id); }}
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}${
                    // Zone colour is never the only carrier of the grade.
                    gradeMeta ? `, grade ${gradeMeta.label}` : ''
                  }, ${statusClasses(status).label}, ${
                    roomRows.length
                  } instrument${roomRows.length === 1 ? '' : 's'}${
                    room.doors && room.doors.length > 0
                      ? `, ${room.doors.length} door${room.doors.length === 1 ? '' : 's'}`
                      : ''
                  }`}
                >
                  {/* Fill only, and the ONE place zone colour is allowed to
                      cover area. The walls are separate segments below, because
                      a stroked rect cannot have a door cut out of it. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill={zone.fill}
                    className="fp-room-fill"
                  />

                  {/* Corridor centre-line. Runs the room's long axis and makes
                      the corridors read as one connected circulation system
                      rather than as leftover space between rooms. */}
                  {room.grade === 'CIRCULATION' && (
                    w >= h ? (
                      <line
                        x1={x + 6} y1={y + h / 2} x2={x + w - 6} y2={y + h / 2}
                        stroke={PALETTE.centreLine} strokeWidth={1} strokeDasharray="6 5"
                      />
                    ) : (
                      <line
                        x1={x + w / 2} y1={y + 6} x2={x + w / 2} y2={y + h - 6}
                        stroke={PALETTE.centreLine} strokeWidth={1} strokeDasharray="6 5"
                      />
                    )
                  )}

                  {wallSegments({ x, y, w, h }, room.doors).map((s, i) => (
                    <line
                      key={`w${i}`}
                      x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={PALETTE.wall} strokeWidth={2.5} strokeLinecap="butt"
                    />
                  ))}

                  {/* Doors: leaf + swing arc in the door blue, which reads as an
                      opening and matches the operator's reference drawing. A door
                      carries no reading — nothing in this install senses one — so
                      it is never given STATUS colour, and it is never given ZONE
                      colour either: the zone already speaks through fill, code and
                      tab. */}
                  {doorPlacements({ x, y, w, h }, room.doors).map((d, i) => (
                    <g key={`d${i}`}>
                      <line
                        x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2}
                        stroke={PALETTE.door} strokeWidth={1.6}
                      />
                      <path d={d.arc} fill="none" stroke={PALETTE.door} strokeWidth={1} strokeDasharray="3 2" />
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

                  {/* Alarm halo. It NEVER repaints the fill: the fill is the
                      grade, and an alarm that recoloured it would make grade and
                      status argue over the same pixels. Skipped on a box too
                      small to inset without the stroke crossing itself. */}
                  {status === 'OUT_OF_SPEC' && w > 12 && h > 12 && (
                    <rect
                      className="fp-alarm-halo"
                      x={x + 4} y={y + 4} width={w - 8} height={h - 8}
                      fill="none" stroke={PALETTE.alarm} strokeWidth={2}
                      pointerEvents="none"
                    />
                  )}

                  {/* Grade tab. Omitted entirely when the room has no grade — an
                      absent tab is honest, a guessed grade is not. */}
                  {gradeMeta && w > 26 && h > 22 && (
                    <g pointerEvents="none">
                      <rect x={x + 4} y={y + 4} width={14} height={11} rx={2} fill={zone.ink} />
                      <text
                        x={x + 11} y={y + 12} textAnchor="middle"
                        fontSize={8} fontWeight={700} fill="#ffffff"
                      >
                        {gradeMeta.tab}
                      </text>
                    </g>
                  )}

                  {/* The room code is the one typographic move on the drawing:
                      uppercase and tracked, which is what gives it the character
                      of a drafting label. The tracking is not repeated anywhere
                      else. */}
                  <text
                    x={x + w / 2} y={y + 10} textAnchor="middle"
                    fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.86} fontWeight={700}
                    letterSpacing="0.08em" fill={zone.ink}
                  >
                    {room.code.toUpperCase()}
                  </text>
                  {room.label && tileLayout({ x, y, w, h }, roomRows.length).step === 'CODE_ONLY' && (
                    <text
                      x={x + w / 2} y={y + 22} textAnchor="middle"
                      fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.8} fill={PALETTE.labelInk}
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
                            rx={3} fill={PALETTE.tile} stroke={PALETTE.tileBorder} strokeWidth={0.8}
                          />
                          {layout.step === 'FULL' && (
                            <text
                              x={tcx} y={ty + layout.fontSize + 1} textAnchor="middle"
                              fontSize={layout.fontSize * 0.85} fontWeight={600}
                              letterSpacing="0.04em" fill={PALETTE.ink}
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
                                  style={{ fontVariantNumeric: 'tabular-nums' }}
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

      {/* Two legends, one bar, separated by a rule: the drawing carries two
          readings and both have to be decodable without asking anyone. Status is
          never colour alone — every chip keeps its glyph. */}
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

        <span className="hidden h-5 w-px bg-slate-200 sm:block" aria-hidden="true" />

        <span className="text-xs font-semibold text-slate-700">Room grade:</span>
        {ROOM_GRADES.map((g) => (
          <span key={g} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-block h-3.5 w-3.5 rounded-sm border"
              style={{ backgroundColor: ZONE[g].fill, borderColor: ZONE[g].ink }}
            />
            <span className="font-semibold" style={{ color: ZONE[g].ink }}>
              {ROOM_GRADE_META[g].label}
            </span>
            <span className="text-slate-500">— {ROOM_GRADE_META[g].name}</span>
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
