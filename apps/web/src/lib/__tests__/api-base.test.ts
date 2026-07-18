import { describe, it, expect, beforeEach } from 'vitest';
import { getApiBase, setApiBase, clearApiBase, normalizeServerUrl, initApiBaseFromStorage } from '../api-base';

describe('api-base', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; });

  it('returns "" when nothing is configured (desktop same-origin default)', () => {
    expect(getApiBase()).toBe('');
  });

  it('setApiBase persists to localStorage and getApiBase returns it', () => {
    setApiBase('https://192.168.1.55:3000');
    expect(getApiBase()).toBe('https://192.168.1.55:3000');
    expect(localStorage.getItem('digilog.serverUrl')).toBe('https://192.168.1.55:3000');
  });

  it('stored value takes precedence over window.__API_BASE__', () => {
    localStorage.setItem('digilog.serverUrl', 'https://stored:3000');
    (window as any).__API_BASE__ = 'https://window:3000';
    expect(getApiBase()).toBe('https://stored:3000');
  });

  it('falls back to window.__API_BASE__ when no stored value', () => {
    (window as any).__API_BASE__ = 'https://window:3000';
    expect(getApiBase()).toBe('https://window:3000');
  });

  it('normalizeServerUrl trims whitespace and strips a trailing slash', () => {
    expect(normalizeServerUrl('  https://x:3000/  ')).toBe('https://x:3000');
  });

  it('normalizeServerUrl throws when the scheme is missing', () => {
    expect(() => normalizeServerUrl('192.168.1.55:3000')).toThrow();
  });

  it('clearApiBase removes stored value and window global', () => {
    setApiBase('https://x:3000');
    clearApiBase();
    expect(getApiBase()).toBe('');
    expect((window as any).__API_BASE__).toBeUndefined();
  });

  it('initApiBaseFromStorage mirrors the stored value into window', () => {
    localStorage.setItem('digilog.serverUrl', 'https://boot:3000');
    initApiBaseFromStorage();
    expect((window as any).__API_BASE__).toBe('https://boot:3000');
  });
});
