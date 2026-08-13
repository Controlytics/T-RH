import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveModulePalette, type ModulePalette } from '@/lib/module-palettes';

/**
 * Writes the active module's palette to CSS custom properties on :root, the same
 * way `applyTheme()` in lib/themes.ts does for --theme-*.
 *
 * Custom properties rather than classes on purpose: `app.css` derives every
 * surface tint from --mod-from with color-mix, so navigating recolours the whole
 * page — canvas, cards, tables, borders — without re-rendering any page content.
 *
 * Mount ONCE, in AppLayout, ABOVE its early returns. Below them the hook would
 * run conditionally and React would throw.
 */
export function useModulePalette(): ModulePalette {
  const { pathname } = useLocation();
  const palette = resolveModulePalette(pathname);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mod-id', palette.id);
    root.style.setProperty('--mod-from', palette.from);
    root.style.setProperty('--mod-to', palette.to);
    root.style.setProperty('--mod-table-head', palette.tableHead);
    root.style.setProperty('--mod-text', palette.text);
    root.style.setProperty('--mod-muted', palette.muted);
  }, [palette]);

  return palette;
}
