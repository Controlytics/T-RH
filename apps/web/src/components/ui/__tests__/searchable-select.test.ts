import { describe, expect, test } from 'vitest';
import { matchOptions, MAX_VISIBLE_OPTIONS } from '../searchable-select';

const opts = (...labels: string[]) => labels.map((label) => ({ value: label, label }));
const labelsOf = (result: { label: string }[]) => result.map((o) => o.label);

describe('matchOptions', () => {
  test('returns every option when the query is blank', () => {
    const options = opts('HF-042', 'PRE-1042', 'HEPA-7');

    expect(matchOptions(options, '')).toEqual(options);
    expect(matchOptions(options, '   ')).toEqual(options);
  });

  test('matches a single word anywhere in the label, case-insensitively', () => {
    const options = opts('HF-042', 'PRE-1042', 'HEPA-7');

    expect(labelsOf(matchOptions(options, '042'))).toEqual(['HF-042', 'PRE-1042']);
    expect(labelsOf(matchOptions(options, 'hepa'))).toEqual(['HEPA-7']);
  });

  test('requires every word to match, regardless of the order typed', () => {
    const options = opts('HF-042', 'PRE-FILTER-12', 'HEPA-7');

    expect(labelsOf(matchOptions(options, 'pre 12'))).toEqual(['PRE-FILTER-12']);
    expect(labelsOf(matchOptions(options, '12 pre'))).toEqual(['PRE-FILTER-12']);
  });

  test('returns nothing when no label contains every word', () => {
    const options = opts('HF-042', 'PRE-FILTER-12');

    expect(matchOptions(options, 'hf 12')).toEqual([]);
    expect(matchOptions(options, 'nonexistent')).toEqual([]);
  });

  test('ranks an exact match first even when it would sort past the render cap', () => {
    // 'HF-04' is an exact label, but sorts last alphabetically among 60 others
    // that also contain 'hf-04'. Without ranking it lands well past
    // MAX_VISIBLE_OPTIONS and the operator never sees it.
    const crowd = Array.from({ length: 60 }, (_, i) => `HF-04${i}-SECONDARY`);
    const options = opts(...crowd, 'HF-04');

    const result = matchOptions(options, 'HF-04');

    expect(result.length).toBeGreaterThan(MAX_VISIBLE_OPTIONS);
    expect(result[0].label).toBe('HF-04');
    expect(labelsOf(result.slice(0, MAX_VISIBLE_OPTIONS))).toContain('HF-04');
  });

  test('ranks prefix matches above mid-string matches', () => {
    // 'PRE-1042' and 'ZONE-042' only contain the query mid-string; '042-MAIN'
    // starts with it and must come first despite sorting last here.
    const options = opts('PRE-1042', 'ZONE-042', '042-MAIN');

    expect(labelsOf(matchOptions(options, '042'))).toEqual(['042-MAIN', 'PRE-1042', 'ZONE-042']);
  });

  test('ranks exact above prefix above mid-string', () => {
    const options = opts('HF-042-B', 'ZONE-HF-042', 'HF-042');

    expect(labelsOf(matchOptions(options, 'HF-042'))).toEqual([
      'HF-042',
      'HF-042-B',
      'ZONE-HF-042',
    ]);
  });

  test('preserves the incoming order within a rank group', () => {
    const options = opts('HF-001', 'HF-002', 'HF-003');

    expect(labelsOf(matchOptions(options, 'hf'))).toEqual(['HF-001', 'HF-002', 'HF-003']);
  });
});
