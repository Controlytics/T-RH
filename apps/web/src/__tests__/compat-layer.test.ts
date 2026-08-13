import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from '@tailwindcss/node';

/**
 * Guards the compatibility layer in app.css against a Tailwind upgrade silently
 * reversing what wave 0 established. Everything here is a property of the
 * COMPILED CSS, so none of it can be checked by rendering a component — which is
 * the whole reason it exists: this app cannot be driven in a browser from the dev
 * environment (the mkcert cert blocks Playwright's XHR at login).
 */

const CSS_PATH = resolve(__dirname, '../app.css');

async function build(candidates: string[]): Promise<string> {
  const css = readFileSync(CSS_PATH, 'utf8');
  const compiler = await compile(css, {
    base: resolve(__dirname, '..'),
    onDependency() {},
  });
  return compiler.build(candidates);
}

describe('compatibility layer', () => {
  it('emits the bg-white override AFTER tailwind\'s own rule, so cascade order wins', async () => {
    const out = await build(['bg-white']);
    const tailwindOwn = out.indexOf('var(--color-white)');
    const ours = out.lastIndexOf('var(--color-surface)');
    expect(tailwindOwn, 'tailwind did not emit its own bg-white').toBeGreaterThan(-1);
    expect(ours, 'the override was not emitted').toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(tailwindOwn);
  });

  it('uses no !important — that would beat inline style={{background}} on buttons', async () => {
    const out = await build(['bg-white', 'bg-slate-50', 'hover:bg-slate-50', 'border-slate-200']);
    expect(out).not.toMatch(/--color-surface\)?\s*!important/);
    expect(out).not.toMatch(/--color-surface-alt\)?\s*!important/);
    expect(out).not.toMatch(/--color-border-tint\)?\s*!important/);
  });

  it('overrides hover variants, or un-tuned tinted rows flash white on hover', async () => {
    const out = await build(['hover:bg-slate-50', 'hover:bg-slate-100']);
    expect(out).toMatch(/\.hover\\:bg-slate-50:hover[^}]*--color-surface-alt/);
    expect(out).toMatch(/\.hover\\:bg-slate-100:hover[^}]*--color-surface-alt/);
  });

  it('leaves translucent white overlays alone — they sit on the DARK sidebar', async () => {
    const out = await build(['bg-white/10', 'bg-white/20', 'border-white/20']);
    expect(out).not.toMatch(/\.bg-white\\\/10\s*\{[^}]*--color-surface/);
    expect(out).not.toMatch(/\.bg-white\\\/20\s*\{[^}]*--color-surface/);
    expect(out).not.toMatch(/\.border-white\\\/20\s*\{[^}]*--color-border-tint/);
  });

  it('generates the bg-surface utilities from the @theme tokens', async () => {
    const out = await build(['bg-surface', 'bg-surface-alt', 'bg-surface-raised', 'border-border-tint']);
    expect(out).toMatch(/\.bg-surface\s*\{[^}]*var\(--color-surface\)/);
    expect(out).toMatch(/\.bg-surface-alt\s*\{[^}]*var\(--color-surface-alt\)/);
    expect(out).toMatch(/\.bg-surface-raised\s*\{[^}]*var\(--color-surface-raised\)/);
    expect(out).toMatch(/\.border-border-tint\s*\{[^}]*var\(--color-border-tint\)/);
  });

  it('scopes the secondary-text remap to the canvas, never globally', async () => {
    const out = await build(['text-slate-400', 'text-slate-500']);
    // The remap must be a DESCENDANT rule. A bare `.text-slate-400 { #475569 }`
    // would darken the sidebar's muted text, which sits on a dark background and
    // gets WORSE contrast that way.
    expect(out).toMatch(/\.bg-module-canvas\s+\.text-slate-400/);
    expect(out).toMatch(/\.bg-module-canvas\s+\.text-slate-500/);
    expect(out).not.toMatch(/^\.text-slate-400\s*\{\s*color:\s*#475569/m);
  });

  it('defines --mod-* defaults on :root so unauthenticated screens are not transparent', async () => {
    // use-module-palette only mounts inside AppLayout. On /login, /change-password
    // and the error boundaries there is no --mod-from, and an empty var makes
    // color-mix invalid at computed-value time -> bg-white cards render
    // TRANSPARENT, not white. The defaults in app.css are what prevent that.
    const out = await build(['bg-white']);
    expect(out).toMatch(/--mod-from:\s*#475569/);
    expect(out).toMatch(/--mod-to:\s*#334155/);
    expect(out).toMatch(/--mod-table-head:\s*#334155/);
  });

  it('keeps the surface-plain opt-out available', async () => {
    const out = await build(['bg-white']);
    expect(out).toMatch(/\.surface-plain/);
  });
});
