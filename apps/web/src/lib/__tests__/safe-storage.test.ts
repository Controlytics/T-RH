import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeStorage } from '../safe-storage';

/**
 * audit 2026-10-03, WEB-3. The one door to web storage must never throw: a
 * browser that blocks site data throws on ACCESS to `window.localStorage`, and
 * the auth hook reads the token during render.
 */

const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage');
const realSession = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

function blockStorage() {
  const throwing = {
    configurable: true,
    get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
  };
  Object.defineProperty(window, 'localStorage', throwing);
  Object.defineProperty(window, 'sessionStorage', throwing);
}

afterEach(() => {
  if (realLocal) Object.defineProperty(window, 'localStorage', realLocal);
  if (realSession) Object.defineProperty(window, 'sessionStorage', realSession);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('safeStorage', () => {
  it('round-trips a value through each area', () => {
    expect(safeStorage.local.set('k', 'v')).toBe(true);
    expect(safeStorage.local.get('k')).toBe('v');
    expect(safeStorage.local.remove('k')).toBe(true);
    expect(safeStorage.local.get('k')).toBeNull();

    expect(safeStorage.session.set('t', '1')).toBe(true);
    expect(safeStorage.session.get('t')).toBe('1');
    expect(window.sessionStorage.getItem('t')).toBe('1');
    expect(window.localStorage.getItem('t')).toBeNull();
  });

  it('reads null and reports a failed write when the accessor itself throws', () => {
    blockStorage();
    expect(() => window.localStorage).toThrow();
    expect(safeStorage.local.get('k')).toBeNull();
    expect(safeStorage.session.get('access_token')).toBeNull();
    expect(safeStorage.local.set('k', 'v')).toBe(false);
    expect(safeStorage.session.remove('access_token')).toBe(false);
  });

  it('reports a failed write when setItem throws (quota)', () => {
    // On the prototype: jsdom's Storage treats a property assignment on the
    // instance as `setItem('setItem', …)`, so patching the instance stores a key.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      expect(safeStorage.local.set('k', 'v')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
