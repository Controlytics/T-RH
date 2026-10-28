import { describe, it, expect } from 'vitest';
import {
  DATA_KEY_SOURCES, DATA_KEY_MAX, DATA_KEYS_INSTRUMENTS_MAX, DATA_KEYS_PER_REQUEST_MAX,
  dataKeyRefSchema, latestValuesRequestSchema,
} from './data-keys.js';

/**
 * The contract a widget uses to name a key (2026-10-28, widget data keys). A key
 * is either a TELEMETRY key an instrument has sent or an ATTRIBUTE key it
 * carries, named exactly as stored. The caps bound one request: the widget
 * screens never need more, and an unbounded id list is a query nobody sized.
 */
const ID = '0f9c5ce9-1111-4222-8333-444455556666';

describe('dataKeyRefSchema', () => {
  it('accepts a telemetry or an attribute key', () => {
    expect(DATA_KEY_SOURCES).toEqual(['telemetry', 'attribute']);
    expect(dataKeyRefSchema.parse({ source: 'telemetry', key: 'p' })).toEqual({ source: 'telemetry', key: 'p' });
    expect(dataKeyRefSchema.parse({ source: 'attribute', key: 'Firmware' })).toEqual({ source: 'attribute', key: 'Firmware' });
  });

  it('trims the key', () => {
    expect(dataKeyRefSchema.parse({ source: 'telemetry', key: ' p ' }).key).toBe('p');
  });

  it('refuses a blank key, an over-long key and an unknown source', () => {
    expect(DATA_KEY_MAX).toBe(128);
    expect(dataKeyRefSchema.safeParse({ source: 'telemetry', key: '' }).success).toBe(false);
    expect(dataKeyRefSchema.safeParse({ source: 'telemetry', key: '   ' }).success).toBe(false);
    expect(dataKeyRefSchema.safeParse({ source: 'telemetry', key: 'k'.repeat(128) }).success).toBe(true);
    expect(dataKeyRefSchema.safeParse({ source: 'telemetry', key: 'k'.repeat(129) }).success).toBe(false);
    expect(dataKeyRefSchema.safeParse({ source: 'other', key: 'p' }).success).toBe(false);
  });
});

describe('latestValuesRequestSchema', () => {
  const key = { source: 'telemetry', key: 'p' } as const;

  it('accepts one instrument and one key', () => {
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: [ID], keys: [key] }).success).toBe(true);
  });

  it('caps instruments at 200 and keys at 20', () => {
    expect(DATA_KEYS_INSTRUMENTS_MAX).toBe(200);
    expect(DATA_KEYS_PER_REQUEST_MAX).toBe(20);
    const ids = (n: number) => Array.from({ length: n }, () => ID);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: ids(200), keys: [key] }).success).toBe(true);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: ids(201), keys: [key] }).success).toBe(false);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: [ID], keys: Array(20).fill(key) }).success).toBe(true);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: [ID], keys: Array(21).fill(key) }).success).toBe(false);
  });

  it('refuses an empty list and a non-uuid id', () => {
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: [], keys: [key] }).success).toBe(false);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: [ID], keys: [] }).success).toBe(false);
    expect(latestValuesRequestSchema.safeParse({ instrumentIds: ['not-a-uuid'], keys: [key] }).success).toBe(false);
  });
});
