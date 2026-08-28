import { type SelectHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * The one select.
 *
 * What this replaces, and why each went: an indigo-to-violet gradient chevron
 * that appeared nowhere else in the product and ignored all ten colour themes;
 * `border-2` and `ring-4`, which made a 44px control read as heavy; and three
 * variants (`default` / `filled` / `outlined`) that gave four screens four
 * different-looking dropdowns for the same job.
 *
 * One appearance now. The variants are kept as accepted props so existing
 * callers keep compiling, but they no longer change how it looks — a select
 * should not be a place where screens differ.
 *
 * A NATIVE `<select>`, deliberately. On a plant floor this gets used with a
 * keyboard, with a touchscreen, and by people relying on the operating system's
 * own accessibility settings; a div-based replacement gives up all three to win
 * control over the option list. For long lists there is `SearchableSelect`,
 * which earns its custom implementation by doing something native cannot.
 */
interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Accepted for source compatibility. No longer changes the appearance. */
  variant?: 'default' | 'filled' | 'outlined';
  selectSize?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
}

/** A single grey chevron. Inherits nothing, matches everything. */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24'%3E%3Cpath stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")";

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, selectSize = 'md', variant: _variant, icon: _icon, ...props }, ref) => {
    const size = {
      sm: 'h-8 text-[13px] pl-2.5 pr-8 bg-[length:1rem] bg-[right_0.5rem_center]',
      md: 'h-10 text-[14px] pl-3 pr-9 bg-[length:1.15rem] bg-[right_0.6rem_center]',
      lg: 'h-11 text-[15px] pl-3.5 pr-10 bg-[length:1.25rem] bg-[right_0.7rem_center]',
    }[selectSize];

    return (
      <select
        ref={ref}
        className={cn(
          'flex w-full cursor-pointer appearance-none rounded-[var(--radius-control)] bg-no-repeat',
          'border border-slate-300 bg-white text-slate-800',
          'hover:border-slate-400',
          'focus:border-[var(--theme-primary,#2a78d6)] focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary,#2a78d6)]/25',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
          'aria-[invalid=true]:border-rose-400 aria-[invalid=true]:focus:ring-rose-200',
          'transition-colors duration-150',
          size,
          className,
        )}
        style={{ backgroundImage: CHEVRON }}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';
