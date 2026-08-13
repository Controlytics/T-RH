import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useModulePalette } from '../use-module-palette';

function Probe() {
  useModulePalette();
  return null;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
    </MemoryRouter>,
  );
}

const read = (name: string) => document.documentElement.style.getPropertyValue(name);

afterEach(() => {
  cleanup();
  // The hook writes to a global; leaking values between cases would let a test
  // pass on the previous case's palette.
  document.documentElement.removeAttribute('style');
});

describe('useModulePalette', () => {
  it('writes the instruments palette for an instruments route', () => {
    renderAt('/instruments');
    expect(read('--mod-id')).toBe('instruments');
    expect(read('--mod-from')).toBe('#0891b2');
    expect(read('--mod-table-head')).toBe('#0f766e');
  });

  it('writes the config palette for a NESTED config route', () => {
    renderAt('/config/floorplans');
    expect(read('--mod-id')).toBe('config');
  });

  it('writes the dashboard palette at the root', () => {
    renderAt('/');
    expect(read('--mod-id')).toBe('dashboard');
  });

  it('writes the neutral fallback for an unknown route', () => {
    renderAt('/nope');
    expect(read('--mod-id')).toBe('fallback');
  });

  it('writes every property the stylesheet reads', () => {
    // app.css derives surfaces from these; a missing one silently yields
    // transparent backgrounds rather than an error.
    renderAt('/audit');
    for (const name of ['--mod-id', '--mod-from', '--mod-to', '--mod-table-head', '--mod-text', '--mod-muted']) {
      expect(read(name), `${name} was not written`).not.toBe('');
    }
  });
});
