import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { placeCard, avoidObstacles, placeRoomName, balanceLines } from '../room-geometry';

/**
 * The 2D ARCHITECTURAL style (2026-10-01, operator: "2d layout was good replace
 * with that QC layout"). A plan opts in through `annotations.style`; every
 * other plan draws exactly as before. Mounted for real.
 */
const room = (id: string, code: string, label: string | null, x: number, extra: Record<string, unknown> = {}) => ({
  id, code, label, grade: null, x, y: 0.1, w: 0.4, h: 0.6,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null, ...extra,
});
const ANN = { equipment: [], hvac: [], water: [], airflow: [], labels: [], columns: [{ x: 0.4, y: 0.6, w: 0.04, h: 0.06 }], windows: [], walls: [] };
const planOf = (style?: string) => ({
  id: 'p', name: 'Plan', imagePath: null, imageWidth: 1000, imageHeight: 600, isActive: true, sortOrder: 0,
  annotations: style ? { ...ANN, style } : ANN, links: [],
  rooms: [room('lab', 'R-LAB', 'LAB', 0.05), room('off', 'R-OFF', 'OFFICE', 0.55)],
});
const row = (over: Record<string, unknown>) => ({
  instrumentId: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', isActive: true,
  room: { id: 'lab', code: 'R-LAB', label: 'LAB', floorplanId: 'p' },
  locationAttribute: 'Wet lab (QC)', limits: { tempMin: 15, tempMax: 25, rhMin: 30, rhMax: 60 }, status: 'OK', reporting: true,
  temperature: { key: 't', value: 21.5 }, humidity: { key: 'h', value: 45 },
  decimals: { temperature: 1, humidity: 0 }, sensorError: null, rangeError: null, ...over,
});

let PLAN: ReturnType<typeof planOf> = planOf('architectural');
let ROWS: ReturnType<typeof row>[] = [row({})];
vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('../use-telemetry', async (orig) => ({
  ...(await orig<typeof import('../use-telemetry')>()),
  useFloorplans: () => ({ plans: [PLAN], isLoading: false, error: undefined }),
  useTelemetryOverview: () => ({ rows: ROWS, isLoading: false, error: undefined }),
}));

const { FloorplanView, cardTone, roomTone, archSummary, splitLabel, cardSpec, locationFont, chooseCard, LEGIBLE_LOC_FONT, ARCH, splitCode, codeFont, LEGEND_UNDER_RATIO, CARD_SHAPES, fillHeight } = await import('../floorplan-view');
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }
const mount = () => render(
  <MemoryRouter initialEntries={['/']}>
    <Routes><Route path="/" element={<FloorplanView />} /><Route path="*" element={<Where />} /></Routes>
  </MemoryRouter>,
);
const WORDS = { failure: 'Error', outOfRange: 'OL' };

describe('the style switch', () => {
  it('a plan WITHOUT the style draws as before: no 2D layer, no side panel, the legend bar', () => {
    PLAN = planOf(); ROWS = [row({})];
    mount();
    expect(screen.queryByTestId('fp-arch')).toBeNull();
    expect(screen.queryByTestId('fp-arch-panel')).toBeNull();
    expect(screen.getByText('Reading colour:')).toBeInTheDocument();
  });

  it('a plan WITH it draws walls, a card per instrument, the side panel, and no legend bar', () => {
    PLAN = planOf('architectural'); ROWS = [row({})];
    mount();
    expect(screen.getByTestId('fp-arch')).toBeInTheDocument();
    const card = screen.getByTestId('fp-card');
    expect(card).toHaveAttribute('data-tone', 'OK');
    expect(card).toHaveTextContent('CWH/RDU/001-00');
    expect(card).toHaveTextContent('Wet lab (QC)');
    expect(card).toHaveTextContent('21.5 °C');
    expect(card).toHaveTextContent('45 %RH');
    // The ID and the Location are large and BOLD (2026-10-01, operator).
    const id = [...card.querySelectorAll('text')].find((t) => t.textContent === 'CWH/RDU/001-00')!;
    const loc = [...card.querySelectorAll('text')].find((t) => t.textContent === 'Wet lab (QC)')!;
    expect(id.getAttribute('font-weight')).toBe('800');
    expect(Number(id.getAttribute('font-size'))).toBeCloseTo(15.5);
    expect(loc.getAttribute('font-weight')).toBe('700');
    expect(Number(loc.getAttribute('font-size'))).toBeCloseTo(14);
    expect(screen.getByTestId('fp-arch-panel')).toHaveTextContent('Plan north');
    expect(screen.queryByText('Reading colour:')).toBeNull();
  });

  it('the room floor is washed by its status, and an empty room prints its name and number', () => {
    PLAN = planOf('architectural'); ROWS = [row({ humidity: { key: 'h', value: 72 }, status: 'OUT_OF_SPEC' })];
    mount();
    expect(document.querySelector('g[aria-label^="R-LAB"] polygon')).toHaveAttribute('data-tone', 'OUT_OF_SPEC');
    expect(screen.getByTestId('fp-card')).toHaveAttribute('data-tone', 'OUT_OF_SPEC');
    expect(screen.getByText('OFFICE')).toBeInTheDocument();
    expect(screen.getByText('R-OFF')).toBeInTheDocument();
  });

  it('a card opens its instrument’s trend page', () => {
    PLAN = planOf('architectural'); ROWS = [row({})];
    mount();
    fireEvent.click(screen.getByTestId('fp-card'));
    expect(screen.getByTestId('where')).toHaveTextContent('/instruments/i1/trend');
  });

  it('the summary counts one bucket per instrument, so they sum', () => {
    PLAN = planOf('architectural');
    ROWS = [
      row({}),
      row({ instrumentId: 'i2', code: 'B', humidity: { key: 'h', value: 72 }, status: 'OUT_OF_SPEC' }),
      row({ instrumentId: 'i3', code: 'C', temperature: null, sensorError: { temperature: true, humidity: false } }),
      row({ instrumentId: 'i4', code: 'D', status: 'STALE', reporting: false }),
    ];
    mount();
    const panel = screen.getByTestId('fp-arch-panel');
    const value = (label: string) => panel.querySelector(`dt:not(:empty)`) && [...panel.querySelectorAll('dl > div')]
      .find((d) => d.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
    expect(value('Instruments')).toBe('4');
    expect(value('In limit')).toBe('1');
    expect(value('Out of limit')).toBe('1');
    expect(value('Sensor error')).toBe('1');
    expect(value('Offline / no data')).toBe('1');
  });
});

describe('cardTone / roomTone / archSummary', () => {
  it('a breach beats a failed probe beats the server status', () => {
    expect(cardTone(row({}) as never, WORDS)).toBe('OK');
    expect(cardTone(row({ humidity: { key: 'h', value: 72 } }) as never, WORDS)).toBe('OUT_OF_SPEC');
    expect(cardTone(row({ temperature: null, sensorError: { temperature: true, humidity: false } }) as never, WORDS)).toBe('ERROR');
    expect(cardTone(row({ status: 'STALE' }) as never, WORDS)).toBe('STALE');
    // The server's verdict is honoured even when no slot reads as breached here.
    expect(cardTone(row({ status: 'OUT_OF_SPEC' }) as never, WORDS)).toBe('OUT_OF_SPEC');
  });
  it('a room takes its worst instrument; no instruments = no tone', () => {
    expect(roomTone([], WORDS)).toBeNull();
    expect(roomTone([row({}), row({ status: 'STALE' })] as never, WORDS)).toBe('STALE');
    expect(roomTone([row({ status: 'STALE' }), row({ humidity: { key: 'h', value: 72 } })] as never, WORDS)).toBe('OUT_OF_SPEC');
  });
  it('the counts sum to the total', () => {
    const s = archSummary([row({}), row({ status: 'PARTIAL' }), row({ status: 'NO_DATA' })] as never, WORDS);
    expect(s).toEqual({ total: 3, ok: 1, outOfLimit: 0, fault: 0, other: 2 });
  });
});

describe('placeCard', () => {
  const box = { x: 0, y: 0, w: 300, h: 400 };
  it('a clear room gets a full-size card in its middle', () => {
    const c = placeCard(box, [], 196, 104)!;
    expect(c.k).toBe(1);
    expect(c.x + c.w / 2).toBeCloseTo(150, -1);
    expect(c.y + c.h / 2).toBeCloseTo(200, -1);
  });
  it('steps aside from an obstacle at full size rather than shrinking', () => {
    const swing = { x: 0, y: 150, w: 300, h: 60 }; // a band across the middle
    const c = placeCard(box, [swing], 196, 104)!;
    expect(c.k).toBe(1);
    expect(c.y + c.h <= swing.y || c.y >= swing.y + swing.h).toBe(true);
  });
  it('shrinks only when no full-size position is clear, and never past its last step', () => {
    const small = { x: 0, y: 0, w: 220, h: 120 };
    const c = placeCard(small, [{ x: 0, y: 70, w: 60, h: 50 }], 196, 104)!;
    expect(c.k).toBeLessThan(1);
    expect(placeCard({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 100, h: 100 }], 196, 104)).toBeNull();
  });
});

describe('avoidObstacles', () => {
  it('gives up the side a column stands on, and leaves a clear box alone', () => {
    const box = { x: 0, y: 0, w: 260, h: 140 };
    expect(avoidObstacles(box, [{ x: 225, y: 90, w: 60, h: 60 }])).toEqual({ x: 0, y: 0, w: 225, h: 140 });
    expect(avoidObstacles(box, [{ x: 400, y: 0, w: 10, h: 10 }])).toEqual(box);
  });
});

describe('a long Location stays readable (operator: "cwh/rdu/018-00 instrument location name is large its not visible increase the font")', () => {
  const LONG = 'Sieving& Sample destruction chamber room(QC)';
  it('splitLabel breaks a long label at the space nearest its middle, and leaves a short one alone', () => {
    expect(splitLabel('Wet lab (QC)')).toEqual(['Wet lab (QC)']);
    expect(splitLabel(LONG)).toEqual(['Sieving& Sample destruction', 'chamber room(QC)']);
    expect(splitLabel('Averyveryverylonglabelwithnospace')).toEqual(['Averyveryverylonglabelwithnospace']);
  });
  it('two lines make the card taller, and the font is sized by the longer half', () => {
    expect(cardSpec('std', LONG).h).toBeGreaterThan(cardSpec('std', 'Wet lab').h);
    const one = Math.min(14, (196 - 10) / (LONG.length * 0.6));
    expect(locationFont(cardSpec('std', LONG), 1)).toBeGreaterThan(one * 1.4);
  });
  it('in a SHORT room with a door swing, the card goes wide and prints the Location far larger', () => {
    // 018-00's room: wide and short, its door in the bottom wall towards the left.
    PLAN = {
      ...planOf('architectural'),
      rooms: [room('lab', 'R-LAB', 'SAMPLE DESTRUCTION ROOM', 0.05, {
        y: 0.1, w: 0.26, h: 0.2,
        doors: [{ edge: 2, offset: 0.55, width: 0.17, kind: 'ENTRY', hinge: 'start' }],
      })],
      annotations: { ...ANN, columns: [], style: 'architectural' },
    };
    ROWS = [row({ locationAttribute: LONG })];
    mount();
    const card = screen.getByTestId('fp-card');
    expect(card).toHaveAttribute('data-shape', 'wide');
    const loc = [...card.querySelectorAll('text')].find((t) => t.textContent === 'Sieving& Sample destruction')!;
    // On one line in the portrait card this room printed it at about 5 units;
    // the real room renders it at 11.6. Well clear of the defect, not of a guess.
    expect(Number(loc.getAttribute('font-size'))).toBeGreaterThan(9);
    PLAN = planOf('architectural');
  });
});

/**
 * The Microbiology floor (2026-10-01, operator: "same like qc layout there
 * Microbiology layout image in folder make layout as per that image same like
 * qc"). Its three LAF / BSC rooms are ~100 units wide and the WATER WET
 * ANALYSIS room has a door swing in one corner and a column in the other; with
 * the two design shapes alone their Locations printed at about 6 units.
 */
describe('small rooms get a card whose Location is legible', () => {
  // The measured rooms, in viewBox units, with the obstacles they really have.
  const LAF = { x: 0, y: 0, w: 97, h: 168 };
  const LAF_SWING = { x: 8, y: 0, w: 40, h: 40 };

  it('splitLabel breaks before a bracket when the label has no space', () => {
    expect(splitLabel('LAF-1(Microbiology)', 14)).toEqual(['LAF-1', '(Microbiology)']);
    expect(splitLabel('BSC Room (Microbiology)', 14)).toEqual(['BSC Room', '(Microbiology)']);
    // Short enough: left alone, bracket or not.
    expect(splitLabel('LAF-1(Microbiology)')).toEqual(['LAF-1(Microbiology)']);
  });

  it('a narrow room takes the TALL card and prints the Location half as large again', () => {
    const loc = 'LAF-1(Microbiology)';
    const card = chooseCard(LAF, [LAF_SWING], loc)!;
    expect(card.shape).toBe('tall');
    const std = cardSpec('std', loc);
    const stdFont = locationFont(std, placeCard(LAF, [LAF_SWING], std.w, std.h)!.k);
    const font = locationFont(cardSpec('tall', loc), card.k);
    expect(stdFont).toBeLessThan(7);
    expect(font).toBeGreaterThan(stdFont * 1.4);
    // ...and stays inside the room, clear of the swing.
    expect(card.x).toBeGreaterThanOrEqual(LAF.x); expect(card.x + card.w).toBeLessThanOrEqual(LAF.w);
    expect(card.y).toBeGreaterThanOrEqual(LAF_SWING.y + LAF_SWING.h);
  });

  it('a short room with a swing and a column takes the COMPACT card', () => {
    const room = { x: 0, y: 0, w: 145, h: 105 };
    const obstacles = [{ x: 12, y: 0, w: 39, h: 39 }, { x: 118, y: 52, w: 27, h: 53 }];
    const loc = 'Water wet analysis Room (Microbiology)';
    const card = chooseCard(room, obstacles, loc)!;
    expect(card.shape).toBe('compact');
    expect(locationFont(cardSpec('compact', loc), card.k)).toBeGreaterThan(7.5);
    for (const o of obstacles) {
      expect(card.x < o.x + o.w && card.x + card.w > o.x && card.y < o.y + o.h && card.y + card.h > o.y).toBe(false);
    }
  });

  it('a room the DESIGN card serves keeps it, even where a small-room shape would print larger', () => {
    // 140 units wide: the portrait card prints the Location at 9.1 — legible —
    // and the compact card would print it at 9.8. The design wins; this is
    // what keeps every card on the QC floor as it was.
    const room = { x: 0, y: 0, w: 140, h: 200 };
    const card = chooseCard(room, [], 'Chamber room (QC)')!;
    expect(card.shape).toBe('std');
    const font = locationFont(cardSpec('std', 'Chamber room (QC)'), card.k);
    expect(font).toBeGreaterThanOrEqual(LEGIBLE_LOC_FONT);
    const compact = cardSpec('compact', 'Chamber room (QC)');
    expect(locationFont(compact, placeCard(room, [], compact.w, compact.h)!.k)).toBeGreaterThan(font);
  });

  it('the tall card draws the two readings one above the other, centred', () => {
    PLAN = {
      ...planOf('architectural'),
      // 130 units wide: too narrow for the design cards, wide enough for the
      // tall card to print the ID on one line at a legible size.
      rooms: [room('lab', 'R-LAB', 'LAF-1', 0.05, { y: 0.1, w: 0.13, h: 0.5 })],
      annotations: { ...ANN, columns: [], style: 'architectural' },
    };
    ROWS = [row({ locationAttribute: 'LAF-1(Microbiology)' })];
    mount();
    const card = screen.getByTestId('fp-card');
    expect(card).toHaveAttribute('data-shape', 'tall');
    const text = (s: string) => [...card.querySelectorAll('text')].find((t) => t.textContent === s)!;
    expect(text('LAF-1')).toBeTruthy();
    expect(text('(Microbiology)')).toBeTruthy();
    const t = text('21.5 °C'), h = text('45 %RH');
    expect(t.getAttribute('text-anchor')).toBe('middle');
    expect(h.getAttribute('text-anchor')).toBe('middle');
    expect(t.getAttribute('x')).toBe(h.getAttribute('x'));
    expect(Number(h.getAttribute('y'))).toBeGreaterThan(Number(t.getAttribute('y')));
    // No TEMP / HUMIDITY captions on it: the units say which is which.
    expect(card).not.toHaveTextContent('HUMIDITY');
    PLAN = planOf('architectural');
  });
});

describe('placeRoomName', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const nameBox = (p: { cx: number; cy: number; fs: number }, chars: number) =>
    ({ x: p.cx - (chars * 0.75 * p.fs) / 2, y: p.cy - p.fs * 0.85, w: chars * 0.75 * p.fs, h: p.fs * 2.2 });
  const hits = (a: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) =>
    a.x < o.x + o.w && a.x + a.w > o.x && a.y < o.y + o.h && a.y + a.h > o.y;

  it('a room with nothing in the way keeps its name in the middle, at the size it always had', () => {
    expect(placeRoomName(box, [], 'CH.RM-03', true)).toEqual({ cx: 100, cy: 50, fs: 15, vertical: false, lines: ['CH.RM-03'] });
    // An obstacle elsewhere in the room changes nothing.
    expect(placeRoomName(box, [{ x: 170, y: 0, w: 30, h: 20 }], 'CH.RM-03', true)).toEqual({ cx: 100, cy: 50, fs: 15, vertical: false, lines: ['CH.RM-03'] });
  });

  it('a door swing over the middle moves the name to the nearest clear spot', () => {
    const swing = { x: 60, y: 40, w: 80, h: 60 };
    const p = placeRoomName(box, [swing], 'CH.RM-03', true);
    expect(hits(nameBox(p, 8), swing)).toBe(false);
    expect(p.cy).toBeLessThan(50);            // above the swing
    expect(p.fs).toBeGreaterThan(9);          // moved, not crushed
    const b = nameBox(p, 8);
    expect(b.x).toBeGreaterThanOrEqual(box.x); expect(b.x + b.w).toBeLessThanOrEqual(box.w);
    expect(b.y).toBeGreaterThanOrEqual(box.y); expect(b.y + b.h).toBeLessThanOrEqual(box.h);
  });

  it('with no clear spot at all it stays in the middle rather than vanishing', () => {
    expect(placeRoomName(box, [{ x: 0, y: 0, w: 200, h: 100 }], 'CH.RM-03', true)).toEqual({ cx: 100, cy: 50, fs: 15, vertical: false, lines: ['CH.RM-03'] });
  });

  // Microbiology's INCUBATOR ROOM-02: 104 units wide, 412 tall, a 17-character
  // name. Across the room it printed at 7 units; the drawing prints it up the room.
  it('a tall narrow room prints its name UP its length, much larger', () => {
    const tall = { x: 10, y: 20, w: 104, h: 412 };
    const p = placeRoomName(tall, [], 'INCUBATOR ROOM-02', true);
    expect(p.vertical).toBe(true);
    expect(p.fs).toBe(15);
    // Anchored on the room's long axis, half way up it.
    expect(p.cy).toBeCloseTo(20 + 412 / 2);
    expect(p.cx).toBeCloseTo(10 + 104 / 2);
    // ...and still steps clear of what is in the room: a swing across the middle
    // of its width pushes the turned name to one side of it.
    const swing = { x: 74, y: 180, w: 40, h: 90 };
    const q = placeRoomName(tall, [swing], 'INCUBATOR ROOM-02', true);
    expect(q.vertical).toBe(true);
    expect(q.cx + q.fs * 1.35).toBeLessThanOrEqual(swing.x);
  });

  it('a name that reads across stays across, however tall the room', () => {
    // A short name in the same room is legible across it: no turn.
    expect(placeRoomName({ x: 0, y: 0, w: 104, h: 412 }, [], 'OFFICE', true).vertical).toBe(false);
    // QC's corridor spine: 100 units wide, over a thousand tall, "CORRIDOR-08".
    // Across it the name prints at 10.2 — legible — so it stays across, though
    // turned it would print at 15. This is what leaves the QC plan as it was.
    const spine = placeRoomName({ x: 0, y: 0, w: 100, h: 1077 }, [], 'CORRIDOR-08', true);
    expect(spine.vertical).toBe(false);
    expect(spine.fs).toBeCloseTo(10.18, 1);
    // A wide room never turns its name.
    expect(placeRoomName({ x: 0, y: 0, w: 120, h: 130 }, [], 'INCUBATOR ROOM-02', true).vertical).toBe(false);
  });

  /**
   * QC 3's glass-ware rooms once the LCMS rooms beside them were drawn wider:
   * 45 units across, 103 along, names of thirty characters. One line up the
   * room needs 4 units; three lines across, 4. Two lines UP the room fit at 7.7.
   */
  describe('a tall narrow room whose name is too long for one line up it', () => {
    const NAME = 'UNCLEANED GLASS WARE HOLD ROOM';
    const glass = { x: 300, y: 10, w: 45, h: 103 };

    it('wraps the name ALONG the room: the lines run up it side by side, inside it', () => {
      const p = placeRoomName(glass, [], NAME, true);
      expect(p.vertical).toBe(true);
      expect(p.lines).toEqual(['UNCLEANED GLASS', 'WARE HOLD ROOM']);
      expect(p.fs).toBeGreaterThan(7.5);
      // Along the room: the longest line is inside its height.
      expect(15 * 0.75 * p.fs).toBeLessThanOrEqual(glass.h);
      // Across it: the first line's top to the room number under the last, inside its width.
      const left = p.cx - p.fs * 0.85, right = p.cx + 1.15 * p.fs + p.fs * 1.35;
      expect(left).toBeGreaterThanOrEqual(glass.x);
      expect(right).toBeLessThanOrEqual(glass.x + glass.w);
      // What it replaces: three lines across at half the size.
      expect((glass.w - 16) / (10 * 0.75)).toBeLessThan(p.fs / 1.9);
    });

    it('a pass box against one wall does not put it back on one line running out of the room', () => {
      // With the box in the way the name ACROSS shrinks to nothing, which made
      // one line UP the room look a third larger — at the 7-unit floor, 157
      // units long in a room of 103.
      const passBox = { x: 335, y: 50, w: 10, h: 14 };
      const p = placeRoomName(glass, [passBox], NAME, true);
      expect(p.vertical).toBe(true);
      expect(p.lines).toHaveLength(2);
      expect(15 * 0.75 * p.fs).toBeLessThanOrEqual(glass.h);
      // The lines and the room number are to the LEFT of the box.
      expect(p.cx + 1.15 * p.fs + p.fs * 1.35).toBeLessThanOrEqual(passBox.x);
    });

    it('a name one line serves up the room keeps one line', () => {
      expect(placeRoomName({ x: 10, y: 20, w: 104, h: 412 }, [], 'INCUBATOR ROOM-02', true).lines).toEqual(['INCUBATOR ROOM-02']);
    });

    // A name's block across the room: its first line's top to the room number under its last.
    const span = (p: ReturnType<typeof placeRoomName>) => [p.cy - p.fs * 0.85, p.cy + (p.lines.length - 1) * 1.15 * p.fs + p.fs * 1.35];
    const clearOf = (p: ReturnType<typeof placeRoomName>, bands: { y: number; h: number }[]) => {
      const [top, bottom] = span(p);
      return bands.every((b) => bottom <= b.y || top >= b.y + b.h);
    };

    it('stays ACROSS, clear of what stands in the room, when along it there is no clear run', () => {
      // GLASS WARE CLEANING & DRYING ROOM has a column and two pass boxes: here,
      // two bands across the whole width, leaving no run long enough for a
      // turned line and one tall enough for three lines across.
      const bands = [{ x: 300, y: 40, w: 45, h: 15 }, { x: 300, y: 75, w: 45, h: 5 }];
      const p = placeRoomName(glass, bands, NAME, true);
      expect(p.vertical).toBe(false);
      expect(p.lines).toHaveLength(3);
      expect(clearOf(p, bands)).toBe(true);
    });

    it('never takes more lines if that puts the name through an obstacle', () => {
      // Bands every 12 units: two lines fit between two of them, three do not.
      const bands = [22, 34, 46, 58, 70, 82, 94, 106].map((y) => ({ x: 300, y, w: 45, h: 3 }));
      const p = placeRoomName(glass, bands, NAME, true);
      expect(p.vertical).toBe(false);
      expect(p.lines).toHaveLength(2);
      expect(clearOf(p, bands)).toBe(true);
    });

    it('draws the turned lines in one rotated group, the room number after the last', () => {
      PLAN = {
        ...planOf('architectural'),
        rooms: [room('g', 'CWH-I/247', NAME, 0.3, { y: 0.1, w: 0.057, h: 0.2 }), room('lab', 'R-LAB', 'LAB', 0.5)],
        annotations: { ...ANN, columns: [], style: 'architectural' },
      };
      ROWS = [];
      mount();
      const a = screen.getByText('UNCLEANED GLASS'), b = screen.getByText('WARE HOLD ROOM'), code = screen.getByText('CWH-I/247');
      const g = a.parentElement!;
      expect(g).toHaveAttribute('data-vertical', 'true');
      expect(g.getAttribute('transform')).toMatch(/^rotate\(-90 /);
      expect(b.parentElement).toBe(g); expect(code.parentElement).toBe(g);
      // In the group's own frame the lines go down the page: turned, left to right.
      const y = (el: HTMLElement) => Number(el.getAttribute('y'));
      expect(y(b)).toBeGreaterThan(y(a)); expect(y(code)).toBeGreaterThan(y(b));
      PLAN = planOf('architectural');
    });
  });
});

/**
 * Operator, on the Microbiology floor in the dashboard: "width is small,rooms
 * and text are slightly no space and look is not good". That plan is 2.2 times
 * as wide as it is tall, so the panel's WIDTH sizes it — and the legend panel
 * beside it took a fifth of that width while the space under it stood empty.
 */
describe('a landscape plan gets the whole width', () => {
  // The rooms span 0.9 of the width and 0.6 of the height: 600 x 1400 is 0.64 wide-to-tall as drawn.
  const portrait = () => ({ ...planOf('architectural'), imageWidth: 600, imageHeight: 1400 });
  const wallWeight = () => Number(screen.getByTestId('fp-arch').querySelector(`line[stroke="${ARCH.wallOuter}"]`)!.getAttribute('stroke-width'));

  it('its legend is a STRIP under the drawing; a portrait plan keeps the panel beside it', () => {
    PLAN = planOf('architectural'); ROWS = [row({})];   // 1000 x 600, rooms across it: landscape
    const first = mount();
    const strip = screen.getByTestId('fp-arch-panel');
    expect(strip).toHaveAttribute('data-layout', 'strip');
    expect(strip.parentElement!.className).toContain('flex-col');
    // Under it: the drawing's box comes first in that column.
    expect(strip.previousElementSibling!.querySelector('svg[role="img"]')).not.toBeNull();
    // Nothing lost in the move: the same legend, the same counts, the north mark.
    expect(strip).toHaveTextContent('Structural column');
    expect(strip).toHaveTextContent('Instruments');
    expect(strip).toHaveTextContent('Plan north');
    first.unmount();

    PLAN = portrait() as typeof PLAN;
    mount();
    const side = screen.getByTestId('fp-arch-panel');
    expect(side).toHaveAttribute('data-layout', 'side');
    expect(side.parentElement!.className).not.toContain('flex-col');
    PLAN = planOf('architectural');
  });

  /**
   * Operator, on QC 3 (1.02 wide-to-tall): "increase widgth and give legend on
   * below the layout". Until then only a plan 1.5 times as wide as tall had it
   * under; now every plan but a portrait one.
   */
  it('a plan that is about SQUARE has its legend under it too', () => {
    // Rooms 0.9 x 0.6 of a 1000 x 1500 canvas: drawn 920 x 930 with the margin.
    PLAN = { ...planOf('architectural'), imageWidth: 1000, imageHeight: 1500 }; ROWS = [row({})];
    mount();
    const vb = document.querySelector('svg[role="img"]')!.getAttribute('viewBox')!.split(' ').map(Number);
    expect(vb[2] / vb[3]).toBeGreaterThan(LEGEND_UNDER_RATIO);
    expect(vb[2] / vb[3]).toBeLessThan(1.1);
    expect(screen.getByTestId('fp-arch-panel')).toHaveAttribute('data-layout', 'strip');
    expect(LEGEND_UNDER_RATIO).toBeLessThan(1);
    // QC, the portrait plan the side panel was designed for, is 0.74.
    expect(LEGEND_UNDER_RATIO).toBeGreaterThan(0.74);
    PLAN = planOf('architectural');
  });

  it('walls keep their weight IN THE DRAWING: lighter units on a wider canvas, never heavier than QC\'s', () => {
    PLAN = { ...planOf('architectural'), imageWidth: 2138, imageHeight: 1283 }; ROWS = [row({})];
    const wide = mount();
    expect(wallWeight()).toBeCloseTo(4);                // twice QC's canvas: half the units
    wide.unmount();
    PLAN = { ...planOf('architectural'), imageWidth: 1069, imageHeight: 641 };
    const qc = mount();
    expect(wallWeight()).toBe(8);                       // QC's own canvas: exactly as it was
    qc.unmount();
    PLAN = { ...planOf('architectural'), imageWidth: 500, imageHeight: 300 };
    mount();
    expect(wallWeight()).toBe(8);                       // a narrower canvas is not made heavier
    PLAN = planOf('architectural');
  });
});

/**
 * Operator, on the first Microbiology floor: "rooms dooars and room lines are
 * some places not matches with image". Laid over the drawing, the plan lacked
 * the lines the drawing has for a pass-through autoclave and a cross-over
 * bench, and its emergency exit swung into the room instead of out.
 */
describe('the plant the drawing outlines, and a door that opens out', () => {
  // Dead centre of the LAB room (viewBox 200..300 x 180..300).
  const EQUIP = { x: 0.2, y: 0.3, w: 0.1, h: 0.2 };
  const withPlant = (style?: string) => ({
    ...planOf(style),
    annotations: { ...ANN, columns: [], equipment: [EQUIP], labels: [{ x: 0.25, y: 0.4, text: 'HPHV' }], ...(style ? { style } : {}) },
  });

  it('the 2D style draws the outline and its caption, and the card keeps clear of it', () => {
    PLAN = withPlant('architectural') as unknown as typeof PLAN; ROWS = [row({})];
    mount();
    const boxes = document.querySelectorAll('[data-structure="equipment"]');
    expect(boxes).toHaveLength(1);
    expect(Number(boxes[0].getAttribute('x'))).toBeCloseTo(200);
    expect(Number(boxes[0].getAttribute('width'))).toBeCloseTo(100);
    expect(screen.getByText('HPHV')).toBeInTheDocument();
    const r = screen.getByTestId('fp-card').querySelector('rect')!;
    const c = { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) };
    expect(c.x < 300 && c.x + c.w > 200 && c.y < 300 && c.y + c.h > 180).toBe(false);
    PLAN = planOf('architectural');
  });

  it('the standard style draws none of it', () => {
    PLAN = withPlant() as unknown as typeof PLAN; ROWS = [row({})];
    mount();
    expect(document.querySelectorAll('[data-structure="equipment"]')).toHaveLength(0);
    expect(screen.queryByText('HPHV')).toBeNull();
    PLAN = planOf('architectural');
  });

  it('the frame takes in a door that opens OUT of the building', () => {
    // One room whose top wall is at y 240; an exit 80 units wide in it.
    const door = { edge: 0, offset: 0.1, width: 0.2, kind: 'EXIT', hinge: 'start' };
    const top = (swing?: 'out') => {
      PLAN = {
        ...planOf('architectural'),
        rooms: [room('lab', 'R-LAB', 'LAB', 0.05, { y: 0.4, h: 0.4, doors: [swing ? { ...door, swing } : door] })],
        annotations: { ...ANN, columns: [], style: 'architectural' },
      };
      ROWS = [];
      const { unmount } = mount();
      const y = Number(document.querySelector('svg[role="img"]')!.getAttribute('viewBox')!.split(' ')[1]);
      unmount();
      return y;
    };
    const inward = top(), outward = top('out');
    expect(inward).toBeCloseTo(234);              // the room's top wall less the margin
    expect(outward).toBeLessThan(inward - 70);    // the leaf's 80 units above it are in frame
    PLAN = planOf('architectural');
  });
});

/**
 * The QC 3 floor (2026-10-01): its north row is five rooms about 70 units wide
 * with names of thirty characters, and one instrument's Location is 68.
 */
describe('long words in small rooms', () => {
  const NAME = 'UNCLEANED GLASS WARE HOLD ROOM';
  // The room as drawn: 71 units wide, 79 tall, nothing in the way of its name.
  const small = { x: 100, y: 10, w: 71, h: 79 };

  it('balanceLines breaks at spaces so the longest line is as short as it can be', () => {
    expect(balanceLines(NAME, 2)).toEqual(['UNCLEANED GLASS', 'WARE HOLD ROOM']);
    expect(balanceLines(NAME, 3)).toEqual(['UNCLEANED', 'GLASS WARE', 'HOLD ROOM']);
    // Fewer words than lines: left whole.
    expect(balanceLines('CH.RM-03', 2)).toEqual(['CH.RM-03']);
  });

  it('a long name WRAPS and stays inside its room — on one line it ran across both neighbours', () => {
    const p = placeRoomName(small, [], NAME, true);
    expect(p.lines).toEqual(['UNCLEANED', 'GLASS WARE', 'HOLD ROOM']);
    expect(p.vertical).toBe(false);
    const widest = Math.max(...p.lines.map((l) => l.length)) * 0.75 * p.fs;
    expect(widest).toBeLessThanOrEqual(small.w);
    // What it replaced: one line at the 7-unit floor, twice the room's width.
    expect(NAME.length * 0.75 * 7).toBeGreaterThan(small.w * 2);
    // The block of lines is centred on the room, not hung from its middle.
    const mid = p.cy + ((p.lines.length - 1) * 1.15 * p.fs) / 2;
    expect(mid).toBeCloseTo(small.y + small.h / 2, 5);
  });

  it('a name that is legible on one line is left on one line', () => {
    expect(placeRoomName({ x: 0, y: 0, w: 300, h: 120 }, [], 'TRAINING/MEETING ROOM', true).lines).toEqual(['TRAINING/MEETING ROOM']);
  });

  it('the wrapped lines are drawn top to bottom with the room number under the last', () => {
    PLAN = {
      ...planOf('architectural'),
      rooms: [room('g', 'CWH-I/247', NAME, 0.05, { y: 0.1, w: 0.071, h: 0.13 }), room('lab', 'R-LAB', 'LAB', 0.3)],
      annotations: { ...ANN, columns: [], style: 'architectural' },
    };
    ROWS = [];
    mount();
    const ys = ['UNCLEANED', 'GLASS WARE', 'HOLD ROOM', 'CWH-I/247'].map((t) => Number(screen.getByText(t).getAttribute('y')));
    expect(ys[1]).toBeGreaterThan(ys[0]); expect(ys[2]).toBeGreaterThan(ys[1]); expect(ys[3]).toBeGreaterThan(ys[2]);
    expect(screen.queryByText(NAME)).toBeNull();
    PLAN = planOf('architectural');
  });

  // CWH/RDU/003-00's Location, as stored.
  const LONG3 = 'Working standard & reference Standard storage Room (or) stability Room';
  it('a Location whose halves are still far too long takes THREE lines; one two lines serve keeps two', () => {
    const three = splitLabel(LONG3);
    expect(three).toHaveLength(3);
    expect(three.join(' ')).toBe(LONG3);
    expect(Math.max(...three.map((l) => l.length))).toBeLessThan(30);
    // 018-00's on the QC floor: 27 / 16 in two lines — within half as long again.
    expect(splitLabel('Sieving& Sample destruction chamber room(QC)')).toHaveLength(2);
  });

  /**
   * Operator, on QC 3: "rooms are very small at top". The two LCMS rooms are
   * 65 units wide, as the drawing has them; a 14-character instrument ID on
   * one line cannot print legibly inside. The `mini` card breaks it in two.
   */
  describe('a room too narrow for the instrument ID', () => {
    // LCMS ROOM-II as drawn: 64 x 79 units, its door swing in a bottom corner.
    const LCMS = { x: 0, y: 0, w: 64, h: 79 };
    const SWING = { x: 36, y: 56, w: 23, h: 23 };
    const CODE = 'CWH/RDU/002-01';

    it('splitCode breaks an ID after its last slash, and leaves one it cannot break alone', () => {
      expect(splitCode(CODE, 2)).toEqual(['CWH/RDU/', '002-01']);
      expect(splitCode(CODE, 1)).toEqual([CODE]);
      expect(splitCode('IOTGW01', 2)).toEqual(['IOTGW01']);
      expect(splitCode('TRAILING/', 2)).toEqual(['TRAILING/']);
    });

    it('takes the MINI card: the Location prints the same, the ID nearly twice as large', () => {
      const loc = 'LCMS Room-II';
      const card = chooseCard(LCMS, [SWING], loc, CODE)!;
      expect(card.shape).toBe('mini');
      const tall = cardSpec('tall', loc);
      const tallK = placeCard(LCMS, [SWING], tall.w, tall.h)!.k;
      const mini = cardSpec('mini', loc);
      // The Location alone would not have chosen it...
      expect(Math.abs(locationFont(mini, card.k) - locationFont(tall, tallK))).toBeLessThan(0.25);
      expect(chooseCard(LCMS, [SWING], loc)!.shape).toBe('tall');
      // ...the ID does.
      expect(codeFont(tall, tallK, CODE)).toBeLessThan(5);
      expect(codeFont(mini, card.k, CODE)).toBeGreaterThan(codeFont(tall, tallK, CODE) * 1.6);
    });

    it('a room the other shapes serve never gets it', () => {
      // 110 units wide: the tall card prints both headings at a legible size, so
      // the two-line ID is not even tried.
      const room110 = { x: 0, y: 0, w: 110, h: 168 }, swing = { x: 8, y: 0, w: 40, h: 40 };
      const card = chooseCard(room110, [swing], 'LAF-1(Microbiology)', 'CWH/RDU/045-00')!;
      expect(card.shape).toBe('tall');
      const tall = cardSpec('tall', 'LAF-1(Microbiology)');
      expect(Math.min(locationFont(tall, card.k), codeFont(tall, card.k, 'CWH/RDU/045-00'))).toBeGreaterThanOrEqual(LEGIBLE_LOC_FONT);
      // ...though the mini card WOULD print the ID larger there: it is the last resort, not a rival.
      const mini = cardSpec('mini', 'LAF-1(Microbiology)');
      const miniK = placeCard(room110, [swing], mini.w, mini.h)!.k;
      expect(codeFont(mini, miniK, 'CWH/RDU/045-00')).toBeGreaterThan(codeFont(tall, card.k, 'CWH/RDU/045-00') + 0.25);
      expect(chooseCard({ x: 0, y: 0, w: 300, h: 300 }, [], 'Wet lab (QC)', 'CWH/RDU/022-00')!.shape).toBe('std');
    });

    /**
     * Operator, after the mini card: "rooms are very small and those data was
     * showing very small", "increase widgth". The north row is drawn larger
     * since; a card is scaled down to its room and never up, so the mini card is
     * drawn at the other cards' type sizes and grows with the room.
     */
    it('GROWS with the room: in the LCMS room as now drawn the ID prints at 13, not 8', () => {
      // 94 x 107 units inside the walls, the door swing in a bottom corner.
      const big = { x: 0, y: 0, w: 94, h: 107 }, swing = { x: 71, y: 84, w: 23, h: 23 };
      const loc = 'LCMS Room-II';
      const card = chooseCard(big, [swing], loc, CODE)!;
      expect(card.shape).toBe('mini');
      const mini = cardSpec('mini', loc);
      expect(codeFont(mini, card.k, CODE)).toBeGreaterThan(12.5);
      expect(mini.valFont * card.k).toBeGreaterThan(12.5);
      expect(locationFont(mini, card.k)).toBeGreaterThan(9.5);
      // The one-line cards cannot: the room's width caps a 14-character line near 8.
      const tall = cardSpec('tall', loc);
      expect(codeFont(tall, placeCard(big, [swing], tall.w, tall.h)!.k, CODE)).toBeLessThan(LEGIBLE_LOC_FONT);
      // Never scaled UP: in a room larger than the card it prints at its own size.
      expect(placeCard({ x: 0, y: 0, w: 400, h: 400 }, [], mini.w, mini.h)!.k).toBe(1);
      expect(CARD_SHAPES.mini.idFont).toBeGreaterThanOrEqual(CARD_SHAPES.std.idFont);
    });

    it('the same rule reaches Microbiology\'s LAF rooms: 98 units wide, the ID was 8.5 on one line', () => {
      const laf = { x: 0, y: 0, w: 98, h: 168 }, swing = { x: 52, y: 0, w: 46, h: 46 };
      const card = chooseCard(laf, [swing], 'LAF-1(Microbiology)', 'CWH/RDU/045-00')!;
      expect(card.shape).toBe('mini');
      const mini = cardSpec('mini', 'LAF-1(Microbiology)'), tall = cardSpec('tall', 'LAF-1(Microbiology)');
      const tallK = placeCard(laf, [swing], tall.w, tall.h)!.k;
      expect(codeFont(tall, tallK, 'CWH/RDU/045-00')).toBeLessThan(LEGIBLE_LOC_FONT);
      expect(codeFont(mini, card.k, 'CWH/RDU/045-00')).toBeGreaterThan(13);
      // Its Location wraps before the bracket; the card grows by its own line height.
      expect(mini.lines).toEqual(['LAF-1', '(Microbiology)']);
      expect(mini.h).toBe(CARD_SHAPES.mini.h + CARD_SHAPES.mini.line);
      // Nothing is lost for it: the Location prints as large as it did.
      expect(locationFont(mini, card.k)).toBeGreaterThanOrEqual(locationFont(tall, tallK) - 0.25);
    });

    it('draws the ID on two lines in the band, one size, the second under the first', () => {
      PLAN = {
        ...planOf('architectural'),
        rooms: [room('lab', 'CWH-I/250', 'LCMS ROOM-II', 0.05, { y: 0.1, w: 0.064, h: 0.13 })],
        annotations: { ...ANN, columns: [], style: 'architectural' },
      };
      ROWS = [row({ code: CODE, locationAttribute: 'LCMS Room-II' })];
      mount();
      const card = screen.getByTestId('fp-card');
      expect(card).toHaveAttribute('data-shape', 'mini');
      const text = (s: string) => [...card.querySelectorAll('text')].find((t) => t.textContent === s)!;
      const a = text('CWH/RDU/'), b = text('002-01');
      expect(a).toBeTruthy(); expect(b).toBeTruthy();
      expect(a.getAttribute('font-size')).toBe(b.getAttribute('font-size'));
      expect(Number(b.getAttribute('y'))).toBeGreaterThan(Number(a.getAttribute('y')));
      expect(Number(a.getAttribute('font-size'))).toBeGreaterThan(7);
      // The whole ID is still what a screen reader hears.
      expect(card.getAttribute('aria-label')).toContain(CODE);
      PLAN = planOf('architectural');
    });
  });

  it('each extra line makes the card one line taller, and the font is sized by the longest', () => {
    const one = cardSpec('std', 'Wet Lab'), three = cardSpec('std', LONG3);
    expect(three.h - one.h).toBe(30);
    const twoLineFont = (196 - 10) / (35 * 0.6);     // its longer half, 35 characters
    expect(locationFont(three, 1)).toBeGreaterThan(twoLineFont * 1.3);
  });
});

/**
 * Operator, 2026-10-01: "when i opened microbiology layout in full screen its
 * exactly filt to full screen but, QC 3 and QC layouts only there is center of
 * the screen not adjusted to full screen". Microbiology is about a screen's
 * shape as drawn; QC 3 is square and QC portrait. In full screen a 2D plan is
 * now laid out to the SCREEN's proportions.
 */
describe('full screen fills the screen', () => {
  const SCREEN = { w: 1896, h: 1004 };
  // jsdom lays nothing out: give the drawing's box the size a 1920 x 1080 screen leaves it.
  const withBox = (box: { w: number; h: number } | null, run: () => void) => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (box && this.dataset.testid === 'fp-full-box') {
        return { x: 0, y: 0, left: 0, top: 0, right: box.w, bottom: box.h, width: box.w, height: box.h, toJSON() {} } as DOMRect;
      }
      return real.call(this);
    };
    try { run(); } finally { HTMLElement.prototype.getBoundingClientRect = real; }
  };
  const aspect = (root: ParentNode = document) => {
    const vb = root.querySelector('svg[role="img"]')!.getAttribute('viewBox')!.split(' ').map(Number);
    return vb[2] / vb[3];
  };
  // Rooms 0.9 x 0.6 of a 1000 x 1500 canvas: about square, like QC 3.
  const square = (style?: string) => ({ ...planOf(style), imageWidth: 1000, imageHeight: 1500 });

  it('fillHeight: the height at which the drawn extent has the box\'s proportions', () => {
    const flat = () => ({ w: 0.92, h: 0.62 });
    const h = fillHeight(1500, flat, SCREEN);
    expect((0.92 * 1000) / (0.62 * h)).toBeCloseTo(SCREEN.w / SCREEN.h, 6);
    // An outward door's swing keeps its size while the canvas gets shorter, so
    // the extent depends on the height: it still settles on the box's shape.
    const withSwing = (vbH: number) => ({ w: 0.92, h: 0.6 + 22 / vbH });
    const h2 = fillHeight(1500, withSwing, SCREEN);
    expect((0.92 * 1000) / (withSwing(h2).h * h2)).toBeCloseTo(SCREEN.w / SCREEN.h, 2);
    // No box measured yet: the drawing's own height.
    expect(fillHeight(1500, flat, null)).toBe(1500);
    expect(fillHeight(1500, flat, { w: 0, h: 500 })).toBe(1500);
  });

  it('a square 2D plan is drawn to the screen\'s shape in full screen, and to the drawing\'s outside it', () => {
    PLAN = square('architectural') as typeof PLAN; ROWS = [row({})];
    withBox(SCREEN, () => {
      mount();
      const drawn = aspect();
      expect(drawn).toBeGreaterThan(0.9); expect(drawn).toBeLessThan(1.1);
      fireEvent.click(screen.getByRole('button', { name: /^Full screen/ }));
      const full = document.querySelector('[data-fullscreen="true"]')!;
      expect(aspect(full)).toBeCloseTo(SCREEN.w / SCREEN.h, 2);
      // The ROOMS are re-proportioned, not the picture: no stretch on the svg,
      // and the card is still drawn at its own shape.
      const svg = full.querySelector('svg[role="img"]')!;
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMin meet');
      const r = within(full as HTMLElement).getByTestId('fp-card').querySelector('rect')!;
      const shape = CARD_SHAPES[within(full as HTMLElement).getByTestId('fp-card').getAttribute('data-shape') as keyof typeof CARD_SHAPES];
      expect(Number(r.getAttribute('width')) / Number(r.getAttribute('height'))).toBeCloseTo(shape.w / shape.h, 1);
      // Back in the panel: the drawing's proportions again.
      fireEvent.click(screen.getByRole('button', { name: /^Exit full screen/ }));
      expect(aspect()).toBeCloseTo(drawn, 6);
    });
    PLAN = planOf('architectural');
  });

  it('a plan in the STANDARD style keeps its proportions in full screen', () => {
    PLAN = square() as typeof PLAN; ROWS = [row({})];
    withBox(SCREEN, () => {
      mount();
      const drawn = aspect();
      fireEvent.click(screen.getByRole('button', { name: /^Full screen/ }));
      expect(aspect(document.querySelector('[data-fullscreen="true"]')!)).toBeCloseTo(drawn, 6);
    });
    PLAN = planOf('architectural');
  });

  it('with no box measured it stays as drawn rather than collapsing', () => {
    PLAN = square('architectural') as typeof PLAN; ROWS = [row({})];
    withBox(null, () => {
      mount();
      const drawn = aspect();
      fireEvent.click(screen.getByRole('button', { name: /^Full screen/ }));
      expect(aspect(document.querySelector('[data-fullscreen="true"]')!)).toBeCloseTo(drawn, 6);
    });
    PLAN = planOf('architectural');
  });
});
