import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * "Leave without saving?" while the editor holds unsaved changes (rule chains,
 * 2026-11-04; spec section 11: "a dirty leave prompts").
 *
 * React Router's `useBlocker` needs a DATA router and this app mounts the
 * declarative `<BrowserRouter>` (`main.tsx`), where it throws. So the guard is
 * built from what the page owns:
 * - closing the tab, reloading or typing a URL: `beforeunload` (the browser's
 *   own prompt);
 * - a click on any in-app link — the sidebar, a crumb, a row link: a
 *   capture-phase listener on `document` stops the click BEFORE React Router's
 *   `<Link>` sees it and asks first (`pendingTo`); Leave navigates there.
 * NOT covered: the browser's Back button inside the app (popstate cannot be
 * cancelled without a data router). The prompt is the browser's on a reload.
 */
export function useLeaveGuard(dirty: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  const here = location.pathname + location.search + location.hash;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome still needs returnValue set to show its prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.hasAttribute('download')) return;
      if (a.target && a.target !== '_self') return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === here) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingTo(to);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty, here]);

  /** A page's own navigation (after an import, say) — asks first when dirty. */
  const go = useCallback((to: string) => {
    if (dirty) setPendingTo(to); else navigate(to);
  }, [dirty, navigate]);

  const leave = useCallback(() => {
    const to = pendingTo;
    setPendingTo(null);
    if (to) navigate(to);
  }, [pendingTo, navigate]);

  const stay = useCallback(() => setPendingTo(null), []);

  return { pendingTo, go, leave, stay };
}
