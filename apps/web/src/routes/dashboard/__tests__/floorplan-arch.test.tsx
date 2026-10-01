import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { placeCard, avoidObstacles, placeRoomName } from '../room-geometry';

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

const { FloorplanView, cardTone, roomTone, archSummary, splitLabel, cardSpec, locationFont, chooseCard, LEGIBLE_LOC_FONT } = await import('../floorplan-view');
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
      rooms: [room('lab', 'R-LAB', 'LAF-1', 0.05, { y: 0.1, w: 0.1, h: 0.5 })],
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
    expect(placeRoomName(box, [], 8, true)).toEqual({ cx: 100, cy: 50, fs: 15 });
    // An obstacle elsewhere in the room changes nothing.
    expect(placeRoomName(box, [{ x: 170, y: 0, w: 30, h: 20 }], 8, true)).toEqual({ cx: 100, cy: 50, fs: 15 });
  });

  it('a door swing over the middle moves the name to the nearest clear spot', () => {
    const swing = { x: 60, y: 40, w: 80, h: 60 };
    const p = placeRoomName(box, [swing], 8, true);
    expect(hits(nameBox(p, 8), swing)).toBe(false);
    expect(p.cy).toBeLessThan(50);            // above the swing
    expect(p.fs).toBeGreaterThan(9);          // moved, not crushed
    const b = nameBox(p, 8);
    expect(b.x).toBeGreaterThanOrEqual(box.x); expect(b.x + b.w).toBeLessThanOrEqual(box.w);
    expect(b.y).toBeGreaterThanOrEqual(box.y); expect(b.y + b.h).toBeLessThanOrEqual(box.h);
  });

  it('with no clear spot at all it stays in the middle rather than vanishing', () => {
    expect(placeRoomName(box, [{ x: 0, y: 0, w: 200, h: 100 }], 8, true)).toEqual({ cx: 100, cy: 50, fs: 15 });
  });
});
