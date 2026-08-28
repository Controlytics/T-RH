import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * The one button.
 *
 * Three changes from the version this replaces, each fixing something visible:
 *
 *  - The primary variant now takes `--theme-primary` instead of a hardcoded
 *    `bg-blue-600`. The application ships ten colour themes and every primary
 *    button in it ignored them, so choosing a theme changed the sidebar and
 *    nothing else.
 *  - `border-2` became a hairline. A 2px border on a 40px control is the single
 *    biggest reason the old forms read as heavy rather than precise.
 *  - `loading` exists. Every screen previously wrote its own `disabled={saving}`
 *    with different wording, and a button that looks identical while a save is in
 *    flight is how an operator ends up submitting twice.
 *
 * `variants` keeps its old names so nothing that already imports this breaks.
 */
const variants = {
  /** The one action the screen exists for. At most one per view. */
  default:
    'bg-[var(--theme-primary,#2a78d6)] text-white shadow-[var(--elev-1)] hover:brightness-110 active:brightness-95',
  /** Confirms and saves, where green says "this completes something". */
  success: 'bg-emerald-600 text-white shadow-[var(--elev-1)] hover:bg-emerald-700',
  /** Deletes and other irreversibles. */
  destructive: 'bg-rose-600 text-white shadow-[var(--elev-1)] hover:bg-rose-700',
  /** Disables, retires, takes offline — recoverable, but not routine. */
  warning: 'bg-amber-500 text-white shadow-[var(--elev-1)] hover:bg-amber-600',
  /** The counterweight to a primary: Cancel, Back, Close. */
  outline: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400',
  secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  link: 'text-[var(--theme-primary,#2a78d6)] underline-offset-4 hover:underline',
} as const;

/**
 * ONE height for every control in the product, so a button beside a select
 * beside an input lines up without anyone nudging margins.
 */
const sizes = {
  default: 'h-10 px-4',
  sm: 'h-8 px-3 text-[13px]',
  lg: 'h-11 px-6',
  /** Square. For an icon-only action — which must still carry a title/aria-label. */
  icon: 'h-10 w-10',
  'icon-sm': 'h-8 w-8',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  /** Shows a spinner, disables the button, and keeps its width. */
  loading?: boolean;
  /** Replaces the label while `loading`, e.g. "Saving…". */
  loadingText?: string;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', loading, loadingText, icon, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-[var(--radius-control)] text-[14px] font-medium',
        'transition-[background-color,border-color,filter,box-shadow] duration-150',
        // A visible focus ring is not optional: this application is used with a
        // keyboard on a plant floor as often as with a mouse.
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary,#2a78d6)] focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-55',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0 animate-spin">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : icon}
      {loading && loadingText ? loadingText : children}
    </button>
  ),
);
Button.displayName = 'Button';
