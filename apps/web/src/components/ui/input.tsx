import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  secureField?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, secureField, ...props }, ref) => {
    const secureHandlers = secureField
      ? {
          onCopy: (e: React.ClipboardEvent) => e.preventDefault(),
          onPaste: (e: React.ClipboardEvent) => e.preventDefault(),
          onCut: (e: React.ClipboardEvent) => e.preventDefault(),
          onDragStart: (e: React.DragEvent) => e.preventDefault(),
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        }
      : {};

    return (
      <input
        ref={ref}
        className={cn(
          // Hairline, not border-2: a 2px border on a 40px control is most of
          // why the old forms read as heavy rather than precise. One height
          // (--control-h) so an input lines up with the button beside it.
          'flex h-10 w-full rounded-[var(--radius-control)] border border-slate-300 bg-white px-3 text-[14px] text-slate-800',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'placeholder:text-slate-400',
          // Focus follows the site theme, like every other focusable control.
          'focus:outline-none focus:border-[var(--theme-primary,#2a78d6)] focus:ring-2 focus:ring-[var(--theme-primary,#2a78d6)]/25',
          'hover:border-slate-400',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
          // An invalid field is bordered red on its own, so validation does not
          // depend on a message the operator may have scrolled past.
          'aria-[invalid=true]:border-rose-400 aria-[invalid=true]:focus:ring-rose-200',
          'transition-colors duration-150',
          className,
        )}
        {...secureHandlers}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
