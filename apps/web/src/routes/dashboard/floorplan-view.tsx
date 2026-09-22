import { useEffect, useMemo, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useSensorWords } from '@/hooks/use-failure-text';
import { Link, useNavigate } from 'react-router-dom';
import {
  worstStatus,
  formatDecimals,
  rectanglePoints,
  largestInscribedRect,
  mirrorOpening,
  centroid,
  type InstrumentStatus,
  type Polygon,
  type EdgeOpening,
} from '@digilog/shared';
import { statusClasses } from './status';
import { outOfSpec, NOT_AVAILABLE } from './set-point';
import {
  useFloorplans,
  useTelemetryOverview,
  formatSlot,
  ROOM_GRADES,
  ROOM_GRADE_META,
  type RoomGrade,
  type FloorplanRoomShape,
  type FloorplanLinkShape,
  type OverviewRow,
} from './use-telemetry';
import { RoomDetail } from './room-detail';
import {
  polygonWalls, polygonDoorPlacements, polygonSharedOpenings, doorToEdgeOpening, tileLayout,
  CHIP_HEIGHT_FACTOR, CHIP_GAP, FULL_CODE_GAP, VALUES_TOP_GAP,
  CODE_LINE_H, TILE_CODE_FONT, LOCATION_LINE_H, TILE_LOCATION_FONT, TILE_HEADER_H,
} from './room-geometry';

/**
 * The base code of a continuation piece — `CWH-I/217 (2)` → `CWH-I/217` —
 * upper-cased for comparison, or null when the code carries no ` (N)` suffix.
 * The suffix is the drawing script's own convention for a corridor stored as
 * more than one rectangle (`SERVICE CORRIDOR (2)`, the QC `CWH-I/217 (2)`).
 */
/**
 * The outline a room draws, in viewBox units: its polygon when it has one
 * (Layout Designer, 2026-09-22), else its box as four corners. The ONE place
 * the rectangle-or-polygon question is answered on the dashboard.
 */
export function roomOutline(
  room: Pick<FloorplanRoomShape, 'x' | 'y' | 'w' | 'h' | 'points'>,
  vbW: number,
  vbH: number,
): Polygon {
  const pts = room.points ?? rectanglePoints({ x: room.x, y: room.y, w: room.w, h: room.h });
  return pts.map((p) => ({ x: p.x * vbW, y: p.y * vbH }));
}

/**
 * The link OPENINGS that land on THIS room's edges: its own as stored, and a
 * neighbour's mirrored onto the edge the two share. Only rooms actually DRAWN
 * count — in a scoped view an opening onto a hidden room would open a wall
 * onto nothing. Connectors add no opening.
 */
export function roomOpenings(
  room: FloorplanRoomShape,
  links: FloorplanLinkShape[],
  drawn: { room: FloorplanRoomShape }[],
  vbW: number,
  vbH: number,
): EdgeOpening[] {
  const out: EdgeOpening[] = [];
  for (const l of links) {
    if (l.kind !== 'OPENING' || l.fromEdge == null || l.offset == null || l.width == null) continue;
    if (l.fromRoomId === room.id) {
      if (drawn.some((d) => d.room.id === l.toRoomId)) out.push({ edge: l.fromEdge, offset: l.offset, width: l.width });
    } else if (l.toRoomId === room.id) {
      const from = drawn.find((d) => d.room.id === l.fromRoomId)?.room;
      if (!from) continue;
      const m = mirrorOpening(
        roomOutline(from, vbW, vbH),
        { edge: l.fromEdge, offset: l.offset, width: l.width },
        roomOutline(room, vbW, vbH),
        0.5,
      );
      if (m) out.push(m);
    }
  }
  return out;
}

export function continuationBase(code: string): string | null {
  const m = /^(.+) \(\d+\)$/.exec(code.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Whether two rooms are ONE space the schema had to store as two rectangles:
 * both circulation (a corridor and its legs), or pieces of one code
 * (`X` and `X (2)`, or `X (2)` and `X (3)`). The view draws no wall along
 * the seam between such a pair.
 */
export function sameSpace(
  a: { code: string; grade: string | null },
  b: { code: string; grade: string | null },
): boolean {
  if (a.grade === 'CIRCULATION' && b.grade === 'CIRCULATION') return true;
  const baseA = continuationBase(a.code) ?? a.code.trim().toUpperCase();
  const baseB = continuationBase(b.code) ?? b.code.trim().toUpperCase();
  return baseA === baseB;
}
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
 * A value chip prints the READING WITH ITS UNIT and nothing else — "21.5 °C",
 * "45 %RH" — and its COLOUR carries the state (operator, 2026-09-22: "just
 * show value with units"). Until then each chip also carried a glyph (▲ ◷ ◑ ·)
 * so that colour never stood alone; the operator chose the bare value, and
 * the consequence is stated once here: on the floor, status is now colour
 * alone, named by the legend under the plan. The room's own state word
 * survives in the tile's aria-label, and the readings table still pairs
 * colour with a word.
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
 *
 * FOUR colours, one per condition (operator, 2026-09-22: "if in limits green
 * color, if its crossed or below the limits show red, if error highlight with
 * other color, if offline also show with other color"): green = in limit,
 * red = a limit crossed, VIOLET = the probe itself has failed or saturated
 * (the administered `Error` / `OL` word), amber = offline (the reading is old)
 * or partial. Until that day a failed probe painted the same red as a breach,
 * so a dead sensor and a real excursion were one colour, and a dead sensor is
 * a THIRD thing: not a breach (nothing was measured) and not a silence (the
 * logger is still talking). `ERROR` is a chip tone, not an `InstrumentStatus`:
 * the server reports it as `sensorError` / `rangeError` beside a null slot,
 * and nothing here re-derives it.
 */
export type ChipTone = InstrumentStatus | 'ERROR';
const CHIP: Record<ChipTone, { bg: string }> = {
  OUT_OF_SPEC: { bg: '#dc2626' },
  ERROR: { bg: '#7c3aed' },
  STALE: { bg: '#d97706' },
  PARTIAL: { bg: '#d97706' },
  NO_DATA: { bg: '#64748b' },
  OK: { bg: '#15803d' },
};

/**
 * The legend's order and wording: in limit, then the three faults, then the
 * two "cannot say". `sample` is what a chip of that tone actually prints, so
 * the legend shows the reader the very thing they will see on the floor.
 */
const LEGEND: readonly { tone: ChipTone; label: string; sample: string }[] = [
  { tone: 'OK', label: statusClasses('OK').label, sample: '21.7 °C' },
  { tone: 'OUT_OF_SPEC', label: statusClasses('OUT_OF_SPEC').label, sample: '28.4 °C' },
  { tone: 'ERROR', label: 'Sensor error', sample: 'Error' },
  { tone: 'STALE', label: statusClasses('STALE').label, sample: '21.7 °C' },
  { tone: 'PARTIAL', label: statusClasses('PARTIAL').label, sample: '21.7 °C' },
  { tone: 'NO_DATA', label: statusClasses('NO_DATA').label, sample: NOT_AVAILABLE },
];

/**
 * The two value chips an instrument tile prints, each with its tone. Pure and
 * exported so the colour rule above is pinned by a test rather than by eye.
 *
 * A failed or saturated probe gets a chip of its own rather than being
 * omitted: a room whose probe has died must not look like a room with nothing
 * in it. A slot the server judged out of limit is red whatever the instrument's
 * overall status; a slot inside its limits on an instrument that is OUT_OF_SPEC
 * (because the OTHER slot breached) is green, not red. One chip per reading is
 * the whole reason status lives on the chips and not on the room.
 *
 * A slot with NO reading prints `NA` in grey (NO_DATA), the word the readings
 * table uses for the same fact — so a tile ALWAYS has its two rows (operator,
 * 2026-09-22: "below the instrument ID temperature and humidity data was not
 * showing"; on that day 98 of 100 instruments had never reported, and their
 * tiles printed the code over nothing, which reads as a broken tile rather
 * than as a silent instrument).
 */
export function tileValues(
  row: Pick<OverviewRow, 'temperature' | 'humidity' | 'limits' | 'status' | 'decimals' | 'sensorError' | 'rangeError'>,
  words: { failure: string; outOfRange: string },
): { text: string; st: ChipTone; bad: boolean }[] {
  const tempV = row.temperature?.value ?? null;
  const rhV = row.humidity?.value ?? null;
  const lim = row.limits;
  const tempBad = outOfSpec(tempV, lim?.tempMin, lim?.tempMax);
  const rhBad = outOfSpec(rhV, lim?.rhMin, lim?.rhMax);
  const toneFor = (bad: boolean): ChipTone =>
    bad ? 'OUT_OF_SPEC' : row.status === 'OUT_OF_SPEC' ? 'OK' : row.status;

  const values: { text: string; st: ChipTone; bad: boolean }[] = [];
  if (row.rangeError?.temperature) {
    values.push({ text: words.outOfRange, st: 'ERROR', bad: false });
  } else if (row.sensorError?.temperature) {
    values.push({ text: words.failure, st: 'ERROR', bad: false });
  } else if (tempV !== null) {
    values.push({ text: formatSlot(row.temperature, row.decimals.temperature, '°C'), st: toneFor(tempBad), bad: tempBad });
  } else {
    values.push({ text: NOT_AVAILABLE, st: 'NO_DATA', bad: false });
  }
  if (row.rangeError?.humidity) {
    values.push({ text: words.outOfRange, st: 'ERROR', bad: false });
  } else if (row.sensorError?.humidity) {
    values.push({ text: words.failure, st: 'ERROR', bad: false });
  } else if (rhV !== null) {
    values.push({ text: formatSlot(row.humidity, row.decimals.humidity, '%RH'), st: toneFor(rhBad), bad: rhBad });
  } else {
    values.push({ text: NOT_AVAILABLE, st: 'NO_DATA', bad: false });
  }
  return values;
}

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

  // There is NO "not placed on any plan" tray here any more (operator,
  // 2026-09-22: "in graphical view dont show not placed on any panel section").
  // It listed every instrument in the selection with no room, under the plan,
  // so nothing could be silently absent from the graphical view. Consequence,
  // stated once: an instrument with no room now appears ONLY in the Tabular
  // view (its Room column) and on the Instruments page; the drawn floor shows
  // the rooms and nothing else. Place it in a room (Config -> Floorplans) to
  // see it here.

  /**
   * FULL SCREEN (operator, 2026-09-22: "the layout should complete visible in
   * full screen"). The view leaves its panel for a fixed overlay over the whole
   * viewport and, being contained (see the root below), the WHOLE plan is then
   * visible at once at the largest size the screen allows. Escape leaves it —
   * a fixed overlay with no keyboard way out is a trap — and so does the same
   * button. The Data Report widget's pattern (`history-widget.tsx`).
   */
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

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
    // A flex column filling the panel, so the drawing below can take WHAT IS
    // LEFT and no more (operator, 2026-09-22: "decrease the space in rooms,
    // layout rooms taking so much large"). Until then the SVG was `w-full
    // h-auto`: it spanned the panel's width and the plan's aspect ratio set its
    // height, so a portrait plan (QC is 1000x1360) ran to ~1,500px inside an
    // 880px panel and scrolled, every room drawn far bigger than the screen.
    // Now the plan is CONTAINED in the panel; to see it bigger, make the panel
    // bigger (Arrange), which is the one panel where dragging taller does
    // something — see `AUTO_HEIGHT_PANELS`.
    <div
      className={fullscreen
        ? 'fixed inset-0 z-50 flex flex-col gap-4 bg-white p-4'
        : 'flex h-full flex-col gap-4'}
      data-testid="floorplan-view"
      data-fullscreen={fullscreen ? 'true' : undefined}
    >
      {/* Dark title bar: current plan on the left, the others as links on the
          right — the reference drawing's chrome. A <select> hid which other plans
          existed behind a click; these are visible at a glance. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl px-4 py-2.5"
        style={{ background: 'linear-gradient(135deg, var(--theme-sidebar-bg), var(--theme-primary-dark))' }}
      >
        <h3 className="text-sm font-bold tracking-wide text-white">{plan?.name ?? 'Floor plan'}</h3>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Exit full screen — floor plan' : 'Full screen — floor plan'}
            title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            className="text-white/80 hover:bg-white/15 hover:text-white"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </Button>
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
        <div className="min-h-0 flex-1 overflow-hidden rounded-b-2xl border border-slate-300 bg-white p-3 shadow-soft">
          <svg
            viewBox={`0 0 ${VB_W} ${vbH}`}
            className="h-full w-full"
            preserveAspectRatio="xMidYMin meet"
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
              // A ROOM PRINTS NOTHING OF ITS OWN (operator, 2026-09-22: "in rooms
              // show Instrument ID, Location and Values dont show any other
              // things"). Until then the room printed its code, its name and,
              // on a traced plan, the drawing's ceiling height and dimensions
              // (`captionHeader` costed those lines against the tiles). All of
              // that is gone; the tile grid starts at the room's top edge, and
              // each tile prints the instrument ID, its Location attribute and
              // the two readings. Consequence, stated once: a room with no
              // instrument is an unlabelled box, and the traced plans' room
              // numbers and names no longer appear on the floor (they are still
              // stored and still on the Config -> Floorplans editor).
              const headerH = 0;
              const gradeMeta = room.grade && room.grade in ROOM_GRADE_META
                ? ROOM_GRADE_META[room.grade as RoomGrade]
                : null;

              // A corridor is ONE space that the schema stores as several
              // rectangles (a room is a rectangle; an L is two). The seam
              // between two adjoining CIRCULATION rooms is therefore not a
              // wall, and is cut out like a door — without a leaf, since
              // nothing is there. Operator, 2026-09-21: "in layout image
              // corridor single line, not divided into separately". Only the
              // rooms actually DRAWN count as neighbours: in a scoped view a
              // hidden piece would otherwise open a wall onto nothing.
              // Two rooms are one space when both are circulation, OR when
              // one is a continuation piece of the other — an L-shaped lab
              // stored as `INCUBATOR-01` + `INCUBATOR-01 (2)` (Microbiology,
              // 2026-09-21) has no wall between its halves either.
              // The outline (a polygon since 2026-09-22; a rectangle is its
              // four-corner case) and everything cut out of its walls: its own
              // doors, the seams it shares with the rooms it is one space with,
              // and the OPENING links the designer drew.
              const outline = roomOutline(room, VB_W, vbH);
              const doorOpenings = (room.doors ?? []).flatMap((d) => {
                const o = doorToEdgeOpening(d, room.points ?? null);
                return o ? [o] : [];
              });
              const openings = [
                ...polygonSharedOpenings(
                  outline,
                  roomViews
                    .filter((o) => o.room.id !== room.id && sameSpace(room, o.room))
                    .map((o) => roomOutline(o.room, VB_W, vbH)),
                ),
                ...roomOpenings(room, plan?.links ?? [], roomViews, VB_W, vbH),
              ];
              // The readings tiles lay out in the largest rectangle INSIDE the
              // outline, so an L-shaped room never hangs a tile outside a wall.
              // For a rectangle that IS the box, and nothing moves.
              const tileBox = largestInscribedRect(outline);
              const outlinePoints = outline.map((p) => `${p.x},${p.y}`).join(' ');
              // A continuation piece (`CWH-I/217 (2)`) whose first piece is
              // on the plan prints no code and no name of its own — with the
              // seam gone, a second label inside the same space is the
              // "divided" reading the seam gave.
              const continuationOf = continuationBase(room.code);
              const isContinuation = continuationOf !== null
                && roomViews.some((o) => o.room.id !== room.id && o.room.code.toUpperCase() === continuationOf);

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
                  <polygon
                    points={outlinePoints}
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

                  {polygonWalls(outline, [...doorOpenings, ...openings]).map((s, i) => (
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
                  {polygonDoorPlacements(outline, [
                    ...(room.doors ?? []),
                    // An OPENING link with a door leaf, on the from-room's edge.
                    ...(plan?.links ?? [])
                      .filter((l) => l.kind === 'OPENING' && l.fromRoomId === room.id && l.door && l.fromEdge != null && l.offset != null && l.width != null)
                      .map((l) => ({ edge: l.fromEdge!, offset: l.offset!, width: l.width!, kind: l.door! })),
                  ]).map((d, i) => (
                    <g key={`d${i}`}>
                      <line
                        x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2}
                        stroke={PALETTE.door} strokeWidth={1.6}
                      />
                      <path d={d.arc} fill="none" stroke={PALETTE.door} strokeWidth={1} strokeDasharray="3 2" />
                      {/* No IN / OUT word (operator, 2026-09-22: nothing but
                          ID, Location and values in a room). The kind still
                          shapes the leaf and rides in the room's aria-label. */}
                    </g>
                  ))}

                  {/* Alarm halo. It NEVER repaints the fill: the fill is the
                      grade, and an alarm that recoloured it would make grade and
                      status argue over the same pixels. Skipped on a box too
                      small to inset without the stroke crossing itself. */}
                  {status === 'OUT_OF_SPEC' && w > 12 && h > 12 && (
                    // A stroke clipped to the outline: only its inner half shows,
                    // which is an inset band on ANY outline without inset maths.
                    <>
                      <clipPath id={`fp-halo-${room.id}`}><polygon points={outlinePoints} /></clipPath>
                      <polygon
                        className="fp-alarm-halo"
                        points={outlinePoints}
                        fill="none" stroke={PALETTE.alarm} strokeWidth={8}
                        clipPath={`url(#fp-halo-${room.id})`}
                        pointerEvents="none"
                      />
                    </>
                  )}

                  {/* No room code, grade tab or caption here — see the note at
                      `headerH` above. The zone TINT stays as decoration.

                      A room with NO instrument prints its LOCATION — the room's
                      name, falling back to its code — and nothing else
                      (operator, 2026-09-22: "which doesnt have instrument ids
                      for rooms there show Location"). It is the same text an
                      instrument's Location attribute carries for the room it
                      sits in, so the floor reads one vocabulary. A continuation
                      piece of a corridor prints nothing; its base piece does.
                      Sized to the room: never wider than the box, never taller
                      than a third of it. */}
                  {roomRows.length === 0 && !isContinuation && (room.label || room.code) && (() => {
                    const text = (room.label || room.code).trim();
                    const fontSize = Math.max(6, Math.min(
                      TILE_LOCATION_FONT + 1.5,
                      (w - 6) / (Math.max(1, text.length) * 0.55),
                      h / 3,
                    ));
                    const c = centroid(outline);
                    return (
                      <text
                        x={c.x} y={c.y + fontSize * 0.35} textAnchor="middle"
                        fontSize={fontSize} fill={PALETTE.labelInk}
                        pointerEvents="none"
                      >
                        {text}
                      </text>
                    );
                  })()}

                  {(() => {
                    const layout = tileLayout(tileBox, roomRows.length, headerH);
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
                      // The chips and their tones: see `tileValues` for the rule.
                      const values = tileValues(row, sensorWords);
                      // The code is SMALL and FIXED (TILE_CODE_FONT), never the
                      // reading font, and shrinks further to fit a narrow tile
                      // rather than overrunning it: the readings are what a
                      // control room reads first, the identity is a caption.
                      const codeFontSize = Math.min(
                        TILE_CODE_FONT,
                        Math.max(7, (layout.tile.w - 6) / (Math.max(1, row.code.length) * 0.6)),
                      );
                      // The instrument's own `Location` ATTRIBUTE (the dashboard
                      // table's Location column) — never the room's code or name.
                      const location = row.locationAttribute?.trim() || null;
                      const locationFontSize = location
                        ? Math.min(TILE_LOCATION_FONT, Math.max(6.5, (layout.tile.w - 6) / (location.length * 0.55)))
                        : 0;

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
                              x={tcx} y={ty + CODE_LINE_H - 2} textAnchor="middle"
                              fontSize={codeFontSize} fontWeight={600}
                              letterSpacing="0.04em" fill={PALETTE.ink}
                            >
                              {row.code}
                            </text>
                          )}
                          {layout.step === 'FULL' && location && (
                            <text
                              x={tcx} y={ty + CODE_LINE_H + LOCATION_LINE_H - 3} textAnchor="middle"
                              fontSize={locationFontSize} fill={PALETTE.labelInk}
                            >
                              {location}
                            </text>
                          )}
                          {values.map((v, vi) => {
                            const paint = CHIP[v.st];
                            // The value with its unit, nothing else (operator,
                            // 2026-09-22, "just show value with units").
                            const label = v.text;
                            // The chip is as wide as its text, capped at the
                            // tile (operator, 2026-09-22: "dont cover entire room
                            // width for room values, just card background should
                            // come till the value only"). It spanned the tile for
                            // a few hours that day. 0.6em per glyph + 4 of padding
                            // is the SAME estimate `fillFont` sizes the font by.
                            const cw = Math.min(layout.tile.w - 6, label.length * layout.fontSize * 0.6 + 4);
                            const chipH = layout.fontSize * CHIP_HEIGHT_FACTOR;
                            const cyTop =
                              ty + (layout.step === 'FULL' ? TILE_HEADER_H + FULL_CODE_GAP : VALUES_TOP_GAP)
                              + vi * (chipH + CHIP_GAP);
                            if (cyTop + chipH > ty + layout.tile.h) return null;
                            return (
                              <g key={vi}>
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
                    const layout = tileLayout(tileBox, roomRows.length, headerH);
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

            {/* CONNECTOR links (Layout Designer, 2026-09-22): a dashed line
                between the centres of two rooms that do not touch, in the door
                blue because it is an opening in spirit, never a status colour.
                Drawn after the rooms so it rides over both fills; no pointer
                events so it cannot swallow a click meant for a room. */}
            {(plan?.links ?? []).filter((l) => l.kind === 'CONNECTOR').map((l) => {
              const a = roomViews.find((v) => v.room.id === l.fromRoomId)?.room;
              const b = roomViews.find((v) => v.room.id === l.toRoomId)?.room;
              if (!a || !b) return null;
              const ca = centroid(roomOutline(a, VB_W, vbH)), cb = centroid(roomOutline(b, VB_W, vbH));
              return (
                <g key={l.id} pointerEvents="none">
                  <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke={PALETTE.door} strokeWidth={1.4} strokeDasharray="6 4" />
                  {l.label && (
                    <text x={(ca.x + cb.x) / 2} y={(ca.y + cb.y) / 2 - 3} textAnchor="middle" fontSize={8} fill={PALETTE.door}>
                      {l.label}
                    </text>
                  )}
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
          operator's request. Since 2026-09-22 a chip carries no glyph, so this
          bar is the ONE place the colours are named — do not remove it. */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200/70 px-4 py-3">
        <span className="text-xs font-semibold text-slate-700">Reading colour:</span>
        {LEGEND.map(({ tone, label, sample }) => (
          <span key={tone} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-bold text-white"
              style={{ backgroundColor: CHIP[tone].bg }}
            >
              {sample}
            </span>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
