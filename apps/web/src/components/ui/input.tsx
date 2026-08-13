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
          'flex h-11 w-full rounded-xl border-2 border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          'placeholder:text-slate-400',
          'focus:outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/20',
          'hover:border-slate-300',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-slate-50',
          'transition-all duration-200',
          className,
        )}
        {...secureHandlers}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
