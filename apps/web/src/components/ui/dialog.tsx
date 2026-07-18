import { useEffect, type ReactNode } from 'react';
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
        className={cn(
          `relative w-full max-w-lg rounded-2xl bg-white p-6`,
          zContent,
          'shadow-2xl border border-slate-200/60',
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
        'text-xl font-semibold text-slate-800',
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
