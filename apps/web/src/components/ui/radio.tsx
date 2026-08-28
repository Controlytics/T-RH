import { type InputHTMLAttributes, forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * A radio with a visible selected state.
 *
 * Same construction as Checkbox and for the same reasons: a real `<input
 * type="radio">`, visually hidden and drawn over, so arrow-key navigation within
 * a group, form participation and screen-reader semantics all still work.
 *
 * Radios and checkboxes are NOT interchangeable and the shapes say so — a circle
 * for "one of these", a square for "any of these". Making them look alike would
 * remove the only cue an operator has about whether a choice is exclusive.
 */
export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  label?: string;
  helper?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ className, label, helper, id, disabled, ...props }, ref) => {
    const auto = useId();
    const inputId = id ?? auto;

    return (
      <div className={cn('flex items-start gap-2.5', className)}>
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <input
            ref={ref}
            id={inputId}
            type="radio"
            disabled={disabled}
            className="peer h-5 w-5 cursor-pointer appearance-none rounded-full border border-slate-300 bg-white transition-colors checked:border-[6px] checked:border-[var(--theme-primary,#2a78d6)] hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 checked:disabled:border-slate-400"
            {...props}
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
            {label && <span className="block text-[14px] font-medium">{label}</span>}
            {helper && <span className="mt-0.5 block text-[12px] text-slate-500">{helper}</span>}
          </label>
        )}
      </div>
    );
  },
);
Radio.displayName = 'Radio';

/**
 * A titled group of radios.
 *
 * `<fieldset>` and `<legend>` rather than a div and a heading: a screen reader
 * announces the legend with every option, so someone hearing "Offline" is told
 * which question it answers. A styled div says nothing.
 */
export function RadioGroup({
  legend, helper, inline = false, children, className,
}: {
  legend: string;
  helper?: string;
  /** Lay the options in a row. Only for two or three short ones. */
  inline?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={className}>
      <legend className="mb-1 text-[13px] font-medium text-slate-700">{legend}</legend>
      {helper && <p className="mb-2 text-[12px] text-slate-500">{helper}</p>}
      <div className={cn('gap-3', inline ? 'flex flex-wrap items-center gap-x-6' : 'grid')}>
        {children}
      </div>
    </fieldset>
  );
}
