import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * The ONE browser reader of the attribute display names. Every screen that
 * prints an attribute key goes through `labelFor`, so the rule lives in one
 * place: the configured name when there is one, the KEY when there is not or
 * the map has not arrived yet. A screen that defaulted to '' while loading
 * would flash a nameless form field on every page load.
 */
const response = { current: undefined as { labels: Record<string, string> } | undefined };
const swrKeys: string[] = [];
vi.mock('swr', () => ({
  default: (key: string) => { swrKeys.push(key); return { data: response.current }; },
}));

const { useAttributeLabels } = await import('../use-attribute-labels');

beforeEach(() => { response.current = undefined; swrKeys.length = 0; });

describe('useAttributeLabels', () => {
  it('reads the narrow-slice route every authenticated user may call', () => {
    renderHook(() => useAttributeLabels());
    expect(swrKeys).toContain('/api/config/attribute-labels/current');
  });

  it('prints the configured display name for a key', () => {
    response.current = { labels: { Enable_Temp_NMT: 'High temperature alarm enabled' } };
    const { result } = renderHook(() => useAttributeLabels());
    expect(result.current.labelFor('Enable_Temp_NMT')).toBe('High temperature alarm enabled');
  });

  it('falls back to the key while the map is loading and for an unnamed key', () => {
    const { result: loading } = renderHook(() => useAttributeLabels());
    expect(loading.current.labelFor('Building')).toBe('Building');
    response.current = { labels: { Area: 'Zone' } };
    const { result } = renderHook(() => useAttributeLabels());
    expect(result.current.labelFor('Building')).toBe('Building');
  });

  it('matches a key case-insensitively, as every other attribute surface does', () => {
    response.current = { labels: { Building: 'Site building' } };
    const { result } = renderHook(() => useAttributeLabels());
    expect(result.current.labelFor('building')).toBe('Site building');
  });

  it('survives a malformed response without throwing', () => {
    response.current = { labels: 'nonsense' as unknown as Record<string, string> };
    const { result } = renderHook(() => useAttributeLabels());
    expect(result.current.labelFor('Building')).toBe('Building');
  });
});
