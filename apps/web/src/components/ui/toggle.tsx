import { type InputHTMLAttributes, forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * An on/off switch.
 *
 * **A toggle and a checkbox are not interchangeable, and the difference is
 * about when the change takes effect.** A checkbox states an intention that a
 * Save button later commits — tick three boxes, then save. A toggle reads as
 * something you have just DONE. Use this for a setting that turns a behaviour on
 * or off; keep `Checkbox` for selecting items in a list or a set of options
 * submitted together.
 *
 * Built on a REAL `<input type="checkbox">` rather than a div with a click
 * handler, for the same reason `Checkbox` is: the native control brings keyboard
 * operation, form participation and screen-reader semantics that a
 * re-implementation always ends up missing. It is visually hidden and drawn over
 * with `peer-*` styles, so nothing is given up to get the appearance.
 *
 * `role="switch"` is what tells a screen reader this is on/off rather than
 * checked/unchecked — the same distinction the visual makes.
 */
export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  label?: string;
  /** Sits under the label, for the sentence explaining what turning it on does. */
  helper?: string;
}

export const Toggle = forwardRef<HTMLInputElement, ToggleProps>(
  ({ className, label, helper, id, disabled, checked, ...props }, ref) => {
    const auto = useId();
    const inputId = id ?? auto;

    return (
      <div className={cn('flex items-start gap-3', className)}>
        <span className="relative inline-flex h-6 w-11 shrink-0 items-center">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            role="switch"
            checked={checked}
            disabled={disabled}
            className={cn(
              'peer h-6 w-11 cursor-pointer appearance-none rounded-full bg-slate-300 transition-colors',
              'checked:bg-[var(--theme-primary,#2a78d6)]',
              'hover:bg-slate-400 checked:hover:opacity-90',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]',
              'disabled:cursor-not-allowed disabled:bg-slate-200 checked:disabled:bg-slate-400',
            )}
            {...props}
          />
          {/* The knob is drawn OVER the input and never intercepts the click, so
              the switch and its label stay one hit target. */}
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-[var(--elev-1)]',
              'transition-transform peer-checked:translate-x-5',
            )}
          />
        </span>

        {(label || helper) && (
          <label
            htmlFor={inputId}
            className={cn(
              'select-none leading-tight',
              disabled ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer text-slate-700',
            )}
          >
            {label && <span className="block text-[0.875rem] font-medium">{label}</span>}
            {helper && <span className="mt-0.5 block text-[0.75rem] text-slate-500">{helper}</span>}
          </label>
        )}
      </div>
    );
  },
);
Toggle.displayName = 'Toggle';
