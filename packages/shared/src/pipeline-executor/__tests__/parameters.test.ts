/**
 * Phase 8.5 — parameters.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertParametersInRange,
  assertParametersRequired,
  extractParameterDefs,
} from '../index.js';
import type { LocalContext } from '../index.js';

const ctx = {} as LocalContext;

const defs = [
  { key: 'pressure', label: 'Pressure', required: true, min: 1, max: 10 },
  { key: 'temperature', label: 'Temperature', required: false, min: 0, max: 100 },
];

describe('assertParametersRequired', () => {
  it('passes when all required keys provided', () => {
    expect(
      assertParametersRequired(ctx, { pressure: { value: 5 } }, defs),
    ).toEqual({ ok: true });
  });
  it('rejects with PARAM_REQUIRED on first missing required', () => {
    expect(assertParametersRequired(ctx, {}, defs)).toMatchObject({
      ok: false,
      code: 'PARAM_REQUIRED',
      message: 'Required parameter missing: Pressure',
    });
  });
  it('passes when no required defs', () => {
    expect(
      assertParametersRequired(ctx, {}, [{ key: 'x', label: 'X', required: false }]),
    ).toEqual({ ok: true });
  });
});

describe('assertParametersInRange', () => {
  it('passes when values are within bounds', () => {
    expect(
      assertParametersInRange(ctx, { pressure: { value: 5 }, temperature: { value: 50 } }, defs),
    ).toEqual({ ok: true });
  });
  it('rejects with PARAM_OUT_OF_RANGE for below-min', () => {
    expect(
      assertParametersInRange(ctx, { pressure: { value: 0 } }, defs),
    ).toMatchObject({
      ok: false,
      code: 'PARAM_OUT_OF_RANGE',
      message: 'Pressure below minimum (1)',
    });
  });
  it('rejects with PARAM_OUT_OF_RANGE for above-max', () => {
    expect(
      assertParametersInRange(ctx, { pressure: { value: 11 } }, defs),
    ).toMatchObject({
      ok: false,
      code: 'PARAM_OUT_OF_RANGE',
      message: 'Pressure above maximum (10)',
    });
  });
  it('passes when parameters is null/undefined', () => {
    expect(assertParametersInRange(ctx, null, defs)).toEqual({ ok: true });
    expect(assertParametersInRange(ctx, undefined, defs)).toEqual({ ok: true });
  });
});

describe('extractParameterDefs', () => {
  it('returns defs from PARAM_CAPTURE blocks', () => {
    const nodes = [
      { nodeType: 'STAGE', configuration: {} },
      {
        nodeType: 'PARAM_CAPTURE',
        configuration: { parameters: defs },
      },
      {
        nodeType: 'PARAM_CAPTURE',
        configuration: { parameters: [{ key: 'extra', label: 'Extra' }] },
      },
    ];
    const out = extractParameterDefs(nodes);
    expect(out).toHaveLength(3);
    expect(out.map(d => d.key)).toEqual(['pressure', 'temperature', 'extra']);
  });
  it('skips non-PARAM_CAPTURE nodes', () => {
    const nodes = [{ nodeType: 'STAGE', configuration: { parameters: defs } }];
    expect(extractParameterDefs(nodes)).toEqual([]);
  });
});
