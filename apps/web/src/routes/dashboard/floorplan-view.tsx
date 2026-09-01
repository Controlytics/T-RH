import { useMemo, useState } from 'react';
import { useSensorWords } from '@/hooks/use-failure-text';
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
import { wallSegments, doorPlacements, tileLayout, captionHeader } from './room-geometry';
import { Button } from '@/components/ui/button';

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
  /* Annotation marks. Warm for equipment, green for plant, and NEITHER is a
     status colour: the semantic reds and ambers live in CHIP and nowhere near
     these, so a hatched block can never be misread as an alarm. */
  equipFill: '#fdf0e3',
  equipInk: '#d97757',
  hvacFill: '#eaf5ec',
  hvacInk: '#3f8f5c',
  airflow: '#2f9e5e',
} as const;

/** The drawing's legend, in the drawing's own order. */
const PLAN_SYMBOLS = [
  { key: 'door', label: 'Door' },
  { key: 'airflow', label: 'Airflow direction' },
  { key: 'hvac', label: 'HVAC / exhaust' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'water', label: 'Water' },
  { key: 'wall', label: 'Wall' },
] as const;

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
  const sensorWords = useSensorWords();
  const navigate = useNavigate();
  const { plans, isLoading: plansLoading } = useFloorplans();
  // Scoped server-side. When a functional location is selected the rows are only
  // that location's instruments, so the rooms drawn below narrow with it.
  const { rows } = useTelemetryOverview({ functionalLocationId, directOnly });

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
            <Button
              variant="ghost"
              size="sm"
              key={p.id}
              type="button"
              onClick={() => setPlanId(p.id)}
              // This bar is a dark gradient, so ghost's slate ink is invisible
              // on it. The variant is still right — no fill, no border — it just
              // has to be the inverse ink here.
              className="text-white/80 hover:bg-white/15 hover:text-white"
            >
              {p.name}
            </Button>
          ))}
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
              // What the drawing prints under the room name. `captionHeader`
              // costs the lines against the tile grid and drops them if they
              // would hide a reading — see the reasoning there.
              const fit = captionHeader({ x, y, w, h }, roomRows.length, {
                name: Boolean(room.label),
                lines: (room.meta?.fch ? 1 : 0) + (room.meta?.dims ? 1 : 0),
              });
              const caption = fit.captions ? room.meta : undefined;
              const headerH = fit.headerH;
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
                  {/* `meta.fill` is the colour the DRAUGHTSMAN used, and it wins
                      on a traced plan. The two statements do not conflict: the
                      drawing's colour says what a room is FOR, the zone tint says
                      how it is classified, and since the grade legend and tab were
                      both removed the tint is decoration anyway. On a generated
                      plan `meta` is null and this is the zone tint exactly as
                      before. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill={room.meta?.fill ?? zone.fill}
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

                  {/* The grade TAB was removed 2026-08-24 at the operator's
                      request, along with the grade legend below. The zone TINT
                      stays: it still groups a floor visually. Note the
                      consequence — with no tab and no legend, that tint is now
                      decoration rather than a readable classification, so do not
                      rely on it to tell A from B. Status colour is unaffected
                      and keeps its glyph and its legend. */}

                  {/* The room code is the one typographic move on the drawing:
                      uppercase and tracked, which is what gives it the character
                      of a drafting label. The tracking is not repeated anywhere
                      else.

                      SUPPRESSED when it would only repeat what the tile below
                      already says. Where a room is named for the single
                      instrument in it, printing the code here AND on the tile
                      shows the same identifier twice in two sizes — which reads
                      as two different things at a glance, and costs the room the
                      vertical space its readings need. The tile wins because it
                      is the thing carrying the values. */}
                  {!(roomRows.length === 1
                    && roomRows[0].code.toUpperCase() === room.code.toUpperCase()
                    && tileLayout({ x, y, w, h }, roomRows.length, headerH).step === 'FULL') && (
                    <text
                      x={x + w / 2} y={y + 10} textAnchor="middle"
                      fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.86} fontWeight={700}
                      letterSpacing="0.08em" fill={zone.ink}
                    >
                      {room.code.toUpperCase()}
                    </text>
                  )}
                  {/* The room NAME. On a traced plan it is always shown, because
                      the drawing names every room and a plan of numbered boxes is
                      not the drawing. On a generated plan the old rule stands: the
                      name only appears where no tile is competing for the space. */}
                  {room.label && (caption || tileLayout({ x, y, w, h }, roomRows.length, headerH).step === 'CODE_ONLY') && (
                    <text
                      x={x + w / 2} y={y + 22} textAnchor="middle"
                      fontSize={Math.max(8, Math.min(12, w / 10, h / 6)) * 0.8} fill={PALETTE.labelInk}
                    >
                      {room.label}
                    </text>
                  )}

                  {/* Ceiling height and floor dimensions, exactly as written on
                      the plan. Transcribed strings — NEVER computed from `w`/`h`,
                      which would print a number the drawing does not carry, since
                      the drawing is schematic and not to scale. */}
                  {caption?.fch && (
                    <text
                      x={x + w / 2} y={y + 32} textAnchor="middle"
                      fontSize={7.5} fill={PALETTE.labelInk}
                    >
                      FCH: {caption.fch}
                    </text>
                  )}
                  {caption?.dims && (
                    <text
                      x={x + w / 2} y={y + (caption.fch ? 41.5 : 32)} textAnchor="middle"
                      fontSize={7.5} fill={PALETTE.labelInk}
                    >
                      {caption.dims}
                    </text>
                  )}

                  {(() => {
                    const layout = tileLayout({ x, y, w, h }, roomRows.length, headerH);
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

                      // A failed sensor gets a tile of its own rather than being
                      // omitted: a room whose probe has died must not look like a
                      // room with nothing in it. OUT_OF_SPEC tone, because a
                      // reading nobody has is a condition nobody is watching.
                      const values: { text: string; st: InstrumentStatus }[] = [];
                      if (row.rangeError?.temperature) {
                        values.push({ text: sensorWords.outOfRange, st: 'OUT_OF_SPEC' });
                      } else if (row.sensorError?.temperature) {
                        values.push({ text: sensorWords.failure, st: 'OUT_OF_SPEC' });
                      } else if (tempV !== null) {
                        values.push({
                          text: `${formatDecimals(tempV, row.decimals.temperature)}°`,
                          st: chipFor(tempBad),
                        });
                      }
                      if (row.rangeError?.humidity) {
                        values.push({ text: sensorWords.outOfRange, st: 'OUT_OF_SPEC' });
                      } else if (row.sensorError?.humidity) {
                        values.push({ text: sensorWords.failure, st: 'OUT_OF_SPEC' });
                      } else if (rhV !== null) {
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
                            tempV !== null ? `, ${formatDecimals(tempV, row.decimals.temperature)} degrees${tempBad ? ' out of limit' : ''}` : ''
                          }${rhV !== null ? `, ${formatDecimals(rhV, row.decimals.humidity)} percent humidity${rhBad ? ' out of limit' : ''}` : ''}`}
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
                    const layout = tileLayout({ x, y, w, h }, roomRows.length, headerH);
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

            {/* -- THE ANNOTATION LAYER --------------------------------------
                Everything the drawing carries that is not a room. Drawn AFTER
                the rooms so a symbol sitting against a partition is not buried
                under the neighbouring room fill, and pointerEvents="none"
                throughout so none of it can swallow a click meant for the room
                underneath - these are marks on a drawing, not controls.

                None of it ever takes a status colour. An HVAC block is where a
                unit is DRAWN; nothing in this install senses one, and colouring
                it by health would assert a reading nobody measured. */}
            {plan?.annotations && (
              <g pointerEvents="none">
                <defs>
                  {/* Hatched, because a solid block at this size reads as an
                      alarm swatch. The hatch is the drawing's own idiom. */}
                  <pattern id="fp-equip" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width={4} height={4} fill={PALETTE.equipFill} />
                    <line x1={0} y1={0} x2={0} y2={4} stroke={PALETTE.equipInk} strokeWidth={1.4} />
                  </pattern>
                </defs>

                {plan.annotations.equipment.map((e, i) => (
                  <rect
                    key={`eq${i}`}
                    x={e.x * VB_W} y={e.y * vbH} width={e.w * VB_W} height={e.h * vbH}
                    fill="url(#fp-equip)" stroke={PALETTE.equipInk} strokeWidth={1.2} rx={1.5}
                  />
                ))}

                {plan.annotations.hvac.map((u, i) => {
                  const ux = u.x * VB_W, uy = u.y * vbH, uw = u.w * VB_W, uh = u.h * vbH;
                  return (
                    <g key={`hv${i}`}>
                      <rect x={ux} y={uy} width={uw} height={uh}
                        fill={PALETTE.hvacFill} stroke={PALETTE.hvacInk} strokeWidth={1.2} rx={1.5} />
                      {/* A fan: four blades round a hub. Legible at 10px, which
                          a text label would not be. */}
                      {uw > 6 && uh > 6 && [0, 90, 180, 270].map((deg) => (
                        <line key={deg}
                          x1={ux + uw / 2} y1={uy + uh / 2}
                          x2={ux + uw / 2 + Math.cos((deg * Math.PI) / 180) * (uw / 2 - 1.5)}
                          y2={uy + uh / 2 + Math.sin((deg * Math.PI) / 180) * (uh / 2 - 1.5)}
                          stroke={PALETTE.hvacInk} strokeWidth={1.1} />
                      ))}
                    </g>
                  );
                })}

                {plan.annotations.water.map((pt, i) => (
                  <g key={`wt${i}`}>
                    <circle cx={pt.x * VB_W} cy={pt.y * vbH} r={6}
                      fill={PALETTE.paper} stroke={PALETTE.door} strokeWidth={1.3} />
                    <text x={pt.x * VB_W} y={pt.y * vbH + 3} textAnchor="middle"
                      fontSize={7.5} fontWeight={700} fill={PALETTE.door}>W</text>
                  </g>
                ))}

                {/* Airflow: dashed, with a head at BOTH ends, because the
                    drawing claims the corridor is swept in both directions. A
                    single head would state a direction nobody specified. */}
                {plan.annotations.airflow.map((f, i) => {
                  const ay = f.y * vbH, ax0 = f.x0 * VB_W, ax1 = f.x1 * VB_W;
                  return (
                    <g key={`af${i}`}>
                      <line x1={ax0 + 7} y1={ay} x2={ax1 - 7} y2={ay}
                        stroke={PALETTE.airflow} strokeWidth={1.4} strokeDasharray="7 5" />
                      <path d={`M ${ax0} ${ay} l 7 -3.5 l 0 7 Z`} fill={PALETTE.airflow} />
                      <path d={`M ${ax1} ${ay} l -7 -3.5 l 0 7 Z`} fill={PALETTE.airflow} />
                    </g>
                  );
                })}

                {/* A note on a drawing sits wherever it needs to, including
                    across a wall — so it gets a plate behind it, or the wall
                    strikes through the word and neither is readable. */}
                {plan.annotations.labels.map((l, i) => {
                  const lx = l.x * VB_W, ly = l.y * vbH;
                  const plateW = l.text.length * 5.4 + 10;
                  return (
                    <g key={`lb${i}`}>
                      <rect
                        x={lx - plateW / 2} y={ly - 7} width={plateW} height={12}
                        fill={PALETTE.paper} stroke={PALETTE.wall} strokeWidth={0.8} rx={1.5}
                      />
                      <text
                        x={lx} y={ly + 2} textAnchor="middle"
                        fontSize={8} fontWeight={700} letterSpacing="0.06em" fill={PALETTE.ink}>
                        {l.text}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        </div>
      )}

      {/* The drawing's own legend. Shown ONLY for a plan that has an annotation
          layer: a legend naming symbols a plan never draws is furniture, and it
          would teach a reader to look for equipment on a floor that has none. */}
      {plan?.annotations && (
        <div className="flex flex-wrap items-center gap-5 rounded-xl border border-slate-200/70 px-4 py-3">
          <span className="text-xs font-semibold text-slate-700">Plan symbols:</span>
          {PLAN_SYMBOLS.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5 text-xs text-slate-600">
              <svg width={22} height={12} aria-hidden="true">
                {item.key === 'door' && (
                  <>
                    <line x1={2} y1={10} x2={2} y2={2} stroke={PALETTE.door} strokeWidth={1.6} />
                    <path d="M 2 2 A 8 8 0 0 1 10 10" fill="none" stroke={PALETTE.door} strokeWidth={1} strokeDasharray="3 2" />
                  </>
                )}
                {item.key === 'airflow' && (
                  <>
                    <line x1={4} y1={6} x2={16} y2={6} stroke={PALETTE.airflow} strokeWidth={1.4} strokeDasharray="4 3" />
                    <path d="M 21 6 l -5 -2.5 l 0 5 Z" fill={PALETTE.airflow} />
                  </>
                )}
                {item.key === 'hvac' && (
                  <>
                    <rect x={5} y={1} width={11} height={10} fill={PALETTE.hvacFill} stroke={PALETTE.hvacInk} strokeWidth={1.1} rx={1.5} />
                    <line x1={10.5} y1={2.5} x2={10.5} y2={9.5} stroke={PALETTE.hvacInk} strokeWidth={1} />
                    <line x1={7} y1={6} x2={14} y2={6} stroke={PALETTE.hvacInk} strokeWidth={1} />
                  </>
                )}
                {item.key === 'equipment' && (
                  <rect x={5} y={1} width={11} height={10} fill={PALETTE.equipFill} stroke={PALETTE.equipInk} strokeWidth={1.2} rx={1.5} />
                )}
                {item.key === 'water' && (
                  <>
                    <circle cx={10.5} cy={6} r={5} fill={PALETTE.paper} stroke={PALETTE.door} strokeWidth={1.2} />
                    <text x={10.5} y={8.5} textAnchor="middle" fontSize={7} fontWeight={700} fill={PALETTE.door}>W</text>
                  </>
                )}
                {item.key === 'wall' && (
                  <line x1={2} y1={6} x2={20} y2={6} stroke={PALETTE.wall} strokeWidth={2.5} />
                )}
              </svg>
              {item.label}
            </span>
          ))}
        </div>
      )}

      {/* Status legend. The room-grade legend was removed 2026-08-24 at the
          operator's request. Status is never colour alone — every chip keeps
          its glyph, and that pairing is what this bar exists to teach. */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200/70 px-4 py-3">
        <span className="text-xs font-semibold text-slate-700">Reading colour:</span>
        {(['OK', 'OUT_OF_SPEC', 'STALE', 'PARTIAL', 'NO_DATA'] as InstrumentStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-bold text-white"
              style={{ backgroundColor: CHIP[s].bg }}
            >
              {CHIP[s].glyph || '21.7'}
            </span>
            {statusClasses(s).label}
          </span>
        ))}

      </div>

      {unplaced.length > 0 && (
        <div className="rounded-2xl border border-slate-200/70 p-4">
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
                    <span className={`flex items-center gap-1 text-[0.6875rem] font-medium ${c.text}`}>
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
