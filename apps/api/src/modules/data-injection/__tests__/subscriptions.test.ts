import { describe, it, expect } from 'vitest';
import { buildBaseTopic } from '../subscriptions.js';
import type { UnsSettings } from '../../instruments/topic-resolver.js';
import { resolveTopics } from '../../instruments/topic-resolver.js';

const S = (over: Partial<UnsSettings> = {}): UnsSettings =>
  ({ prefix: '', separator: '/', includeGateway: true, ...over });

describe('buildBaseTopic', () => {
  it('joins prefix, ancestry and gateway', () => {
    expect(buildBaseTopic(S({ prefix: 'acme' }), ['india', 'area-02'], 'gw-001'))
      .toBe('acme/india/area-02/gw-001');
  });

  it('omits a blank prefix rather than leaving a leading separator', () => {
    expect(buildBaseTopic(S(), ['india', 'area-02'], 'gw-001'))
      .toBe('india/area-02/gw-001');
  });

  it('omits the gateway when includeGateway is false', () => {
    expect(buildBaseTopic(S({ includeGateway: false }), ['india', 'area-02'], 'gw-001'))
      .toBe('india/area-02');
  });

  it('omits a null gateway', () => {
    expect(buildBaseTopic(S(), ['india'], null)).toBe('india');
  });

  it('honours a dot separator', () => {
    expect(buildBaseTopic(S({ separator: '.', prefix: 'acme' }), ['india'], 'gw-001'))
      .toBe('acme.india.gw-001');
  });

  it('varies with ancestry — the same gateway in two nodes yields two bases', () => {
    const a = buildBaseTopic(S(), ['acme', 'area-02'], 'gw-001');
    const b = buildBaseTopic(S(), ['acme', 'area-07'], 'gw-001');
    expect(a).not.toBe(b);
  });
});

// The whole design rests on the adapter subscribing to exactly what P1 tells the
// UI an instrument publishes to. If these two ever diverge, ingestion listens on
// topics no device uses and nothing arrives — with no error anywhere.
describe('buildBaseTopic agrees with P1 resolveTopics', () => {
  const cases: { settings: UnsSettings; ancestry: string[]; gw: string | null; slug: string }[] = [
    { settings: S({ prefix: 'acme' }), ancestry: ['india', 'area-02'], gw: 'gw-001', slug: 'temp001' },
    { settings: S(), ancestry: ['india'], gw: 'gw-001', slug: 'temp001' },
    { settings: S({ includeGateway: false }), ancestry: ['india', 'area-02'], gw: 'gw-001', slug: 'temp001' },
    { settings: S({ separator: '.' }), ancestry: ['india'], gw: 'gw-1', slug: 'rh002' },
    { settings: S({ prefix: 'acme' }), ancestry: [], gw: null, slug: 'standalone' },
  ];

  it.each(cases)('base + slug + category reproduces the derived topic (%#)', (c) => {
    const base = buildBaseTopic(c.settings, c.ancestry, c.gw);
    const derived = resolveTopics({
      settings: c.settings, ancestry: c.ancestry,
      gatewaySlug: c.gw, instrumentSlug: c.slug, overrides: {},
    }).TELEMETRY;

    const sep = c.settings.separator;
    const rebuilt = [base, c.slug, 'telemetry'].filter(p => p.length > 0).join(sep);
    expect(rebuilt).toBe(derived);
  });
});
