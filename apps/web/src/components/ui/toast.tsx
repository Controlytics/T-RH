import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  message?: string;
  variant: ToastVariant;
  duration?: number;
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: 'bg-emerald-50 border-emerald-300 text-emerald-800',
  error: 'bg-red-50 border-red-300 text-red-800',
  warning: 'bg-amber-50 border-amber-300 text-amber-800',
  info: 'bg-blue-50 border-blue-300 text-blue-800',
};

/*
 * Drawn icons, not text glyphs.
 *
 * These were four bare Unicode glyphs (heavy check, heavy multiply, warning
 * sign, information source). A bare codepoint is drawn by whatever font on the
 * machine happens to carry it, so the confirmation mark differed between two
 * workstations in the same room \u2014 and the warning sign resolves to a COLOUR
 * EMOJI on some Windows font stacks, which lands a yellow cartoon triangle in
 * the middle of a Part 11 confirmation. An inline SVG renders identically
 * everywhere and inherits the toast's own colour.
 */
const VARIANT_ICONS: Record<ToastVariant, ReactNode> = {
  success: (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.53 5.28-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L7 8.69l3.47-3.47a.75.75 0 1 1 1.06 1.06Z" />
    </svg>
  ),
  error: (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM5.72 5.72a.75.75 0 0 1 1.06 0L8 6.94l1.22-1.22a.75.75 0 1 1 1.06 1.06L9.06 8l1.22 1.22a.75.75 0 1 1-1.06 1.06L8 9.06l-1.22 1.22a.75.75 0 0 1-1.06-1.06L6.94 8 5.72 6.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  ),
  warning: (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.75Zm0 5.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    </svg>
  ),
  info: (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm1 8.25H7a.75.75 0 0 1 0-1.5h.25V8.5H7a.75.75 0 0 1 0-1.5h1a.75.75 0 0 1 .75.75v3h.25a.75.75 0 0 1 0 1.5Z" />
    </svg>
  ),
};

function ToastEntry({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger slide-in
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(toast.id), 200);
    }, toast.duration ?? 5000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 rounded-[var(--radius-card)] border shadow-[var(--elev-2)] max-w-sm transition-all duration-200',
        VARIANT_STYLES[toast.variant],
        visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0',
      )}
    >
      <span className="mt-0.5 shrink-0">{VARIANT_ICONS[toast.variant]}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{toast.title}</p>
        {toast.message && <p className="text-xs mt-0.5 opacity-80 whitespace-pre-line">{toast.message}</p>}
      </div>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(toast.id), 200);
        }}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-[var(--radius-control)] p-1 transition-colors hover:bg-black/5"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    /*
      ANNOUNCED. Without a live region the toast is a purely visual event: a
      screen-reader user pressed Save, the request succeeded, and nothing said
      so. "polite" rather than "assertive" because a save confirmation should
      wait for a natural pause rather than interrupt whatever is being read —
      the errors that genuinely must interrupt are raised in a dialog, not here.
    */
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastEntry key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
