import { describe, it, expect } from 'vitest';
import { centredX } from '../pdf-report';

/**
 * The centred report header (operator, 2026-09-01: *"make company name and
 * project name to Center"*).
 *
 * `centredX` is the only part of that change with a decision in it. The rest is
 * font sizes, which a unit test can only restate. What this protects is the case
 * that goes wrong silently: jsPDF draws a centred string over a logo without
 * complaint, so an overlap ships looking like a rendering glitch rather than a
 * layout bug — and it only appears for LONG company names on NARROW pages, which
 * is exactly the combination nobody has on their own screen.
 *
 * A4 portrait is 210mm; the left margin, and `logoEndX` when there is no logo,
 * is 14mm.
 */

const A4 = 210;

describe('centredX', () => {
  it('centres on the page when there is no logo', () => {
    expect(centredX(60, A4, 14)).toBe(105);
  });

  it('centres on the page when the logo is nowhere near the text', () => {
    // A 20mm logo ending at x=38, against a 60mm name starting at x=75.
    expect(centredX(60, A4, 38)).toBe(105);
  });

  it('nudges right by exactly enough to clear a logo it would overlap', () => {
    /**
     * The case this exists for. A 120mm company name centred on 210mm starts at
     * x=45, which is 15mm INSIDE a logo ending at 60. The centre moves to
     * 60 + 60 = 120, putting the text's left edge exactly on the logo's right.
     */
    expect(centredX(120, A4, 60)).toBe(120);
  });

  it('never moves LEFT — a short name stays page-centred', () => {
    // Otherwise a narrow logo would drag the heading off-centre for no reason.
    expect(centredX(10, A4, 14)).toBe(105);
    expect(centredX(0, A4, 14)).toBe(105);
  });

  it('keeps the text clear of the logo for every width that could overlap', () => {
    // The property, rather than three sampled points: the left edge is never
    // inside the logo.
    const logoEndX = 55;
    for (let w = 0; w <= 200; w += 5) {
      const leftEdge = centredX(w, A4, logoEndX) - w / 2;
      expect(leftEdge).toBeGreaterThanOrEqual(logoEndX - 0.001);
    }
  });

  it('is page-relative, so landscape centres wider', () => {
    // The chrome is shared: the audit and trend reports are landscape.
    expect(centredX(60, 297, 14)).toBe(148.5);
  });
});
