import { type InputHTMLAttributes, forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * A checkbox with a real, visible state.
 *
 * The application had 43 raw `<input type="checkbox">` and no primitive to
 * migrate them onto, which is why they looked like a browser default on one
 * screen and something else on the next.
 *
 * Built on a REAL checkbox input rather than a div with a click handler: the
 * native control brings keyboard operation, form participation, the
 * indeterminate state and screen-reader semantics that a re-implementation
 * always ends up missing. It is visually hidden and drawn over with `peer-*`
 * styles, so nothing is given up to get the appearance.
 */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  /** Sits under the label, for the sentence that explains what enabling it does. */
  helper?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, helper, id, disabled, ...props }, ref) => {
    const auto = useId();
    const inputId = id ?? auto;

    return (
      <div className={cn('flex items-start gap-2.5', className)}>
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            disabled={disabled}
            className="peer h-5 w-5 cursor-pointer appearance-none rounded-[5px] border border-slate-300 bg-white transition-colors checked:border-transparent checked:bg-[var(--theme-primary,#2a78d6)] hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 checked:disabled:bg-slate-400"
            {...props}
          />
          {/* The tick is drawn over the input and never intercepts the click —
              the label and the box must both remain a single hit target. */}
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="pointer-events-none absolute h-3.5 w-3.5 scale-75 text-white opacity-0 transition-all peer-checked:scale-100 peer-checked:opacity-100"
          >
            <path
              d="M3.5 8.5l3 3 6-7"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        {(label || helper) && (
          <label
            htmlFor={inputId}
            className={cn(
              'select-none leading-tight',
              disabled ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer text-slate-700',
            )}
          >
            {label && <span className="block text-[14px] font-medium">{label}</span>}
            {helper && <span className="mt-0.5 block text-[12px] text-slate-500">{helper}</span>}
          </label>
        )}
      </div>
    );
  },
);
Checkbox.displayName = 'Checkbox';

/**
 * A titled group of checkboxes.
 *
 * Grouping is the point: the brief this came from asked for related options in a
 * section rather than scattered down a page, and a bordered group is what tells
 * an operator that four toggles answer one question.
 */
export function CheckboxGroup({
  legend, helper, columns = 1, children, className,
}: {
  legend: string;
  helper?: string;
  columns?: 1 | 2 | 3;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('rounded-[var(--radius-card)] border border-slate-200 bg-white p-4', className)}>
      <legend className="px-1 text-[13px] font-semibold text-slate-700">{legend}</legend>
      {helper && <p className="mb-3 text-[12px] text-slate-500">{helper}</p>}
      <div
        className={cn(
          'grid gap-3',
          columns === 2 && 'sm:grid-cols-2',
          columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        )}
      >
        {children}
      </div>
    </fieldset>
  );
}
