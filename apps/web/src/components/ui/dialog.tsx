import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Global dialog stack: only the topmost dialog should handle Escape key
const dialogStack: (() => void)[] = [];

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** When true, renders at a higher z-index (z-[60]) to appear above other dialogs */
  priority?: boolean;
}

export function Dialog({ open, onClose, children, className, priority }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * Focus, on open and on close.
   *
   * This dialog had none. Opening one left focus on the button behind it, so a
   * keyboard user's next Tab walked the page UNDERNEATH the overlay — including,
   * on the governed config screens, the form they had just been asked to
   * re-authenticate for. Closing it dropped focus to the top of the document,
   * losing their place entirely.
   *
   * The panel takes focus on open (tabIndex={-1}, so it is focusable
   * programmatically without joining the tab order) and the previously focused
   * element gets it back on close.
   */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    dialogStack.push(onClose);

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only the topmost dialog handles Escape
        if (dialogStack.length > 0 && dialogStack[dialogStack.length - 1] === onClose) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      const idx = dialogStack.lastIndexOf(onClose);
      if (idx !== -1) dialogStack.splice(idx, 1);
    };
  }, [open, onClose]);

  if (!open) return null;

  const zWrapper = priority ? 'z-[60]' : 'z-50';
  const zContent = priority ? 'z-[60]' : 'z-50';

  return (
    <div className={cn('fixed inset-0 flex items-center justify-center p-4', zWrapper)}>
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm animate-fade-in"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
        onMouseDown={(e) => e.preventDefault()}
      />
      <div
        ref={panelRef}
        // A dialog that is not announced as one is, to a screen reader, simply
        // more page: aria-modal tells assistive technology the content behind
        // it is inert, which is what the overlay already says visually.
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          `relative w-full max-w-lg rounded-[var(--radius-card)] bg-white p-6 focus:outline-none`,
          zContent,
          'shadow-[var(--elev-3)] border border-slate-200/60',
          'animate-fade-in',
          'max-h-[90vh] overflow-y-auto',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-5', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        'text-[19px] font-semibold leading-tight text-slate-800',
        className
      )}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mt-6 flex justify-end gap-3 pt-4 border-t border-slate-100',
        className
      )}
      {...props}
    />
  );
}
