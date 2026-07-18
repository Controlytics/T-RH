/**
 * Format a numeric value to the decimal precision of its least count.
 *
 * - leastCount = 1     → "25"
 * - leastCount = 0.5   → "25.0"
 * - leastCount = 0.1   → "25.0"
 * - leastCount = 0.01  → "25.00"
 *
 * Used for equipment-group instrument limits and readings so the displayed
 * precision always matches the instrument's least count — online and offline.
 */

export function getLeastCountDecimals(leastCount: number | null | undefined): number {
  const lc = Number(leastCount);
  if (!lc || lc <= 0 || !isFinite(lc)) return 0;
  const str = lc.toString();
  if (str.includes('e-')) {
    // e.g. 1e-3 → 3 decimals
    const exp = parseInt(str.split('e-')[1], 10);
    return isNaN(exp) ? 0 : exp;
  }
  if (!str.includes('.')) return 0;
  return str.split('.')[1].length;
}

export function formatByLeastCount(
  value: number | string | null | undefined,
  leastCount: number | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!isFinite(num)) return String(value);
  return num.toFixed(getLeastCountDecimals(leastCount));
}
