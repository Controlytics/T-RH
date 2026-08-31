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
 *
 * **Green for on, red for off** (operator, 2026-08-31), painted from the
 * application's own `--status-ok-*` / `--status-danger-*` tokens rather than raw
 * hex, so a switch matches the badges everywhere else. It does NOT follow
 * `--theme-primary` like the other controls: this one is reporting a STATE, and
 * a state colour that changes with the site palette stops meaning anything.
 *
 * The word "On" / "Off" sits beside it in the same colour, and that pairing is
 * not decoration — this application's rule is that **status colour never travels
 * alone**, because red and green are the pair a colour-blind reader is most
 * likely to lose. The switch position, the colour and the word all say the same
 * thing, so any one of them is enough.
 *
 * Note the consequence, since this component serves every dynamic config page:
 * a setting that is simply switched off now reads RED. On this page that is
 * right — alarms not being raised is the risky state — but "require an uppercase
 * letter: Off" will also read red, which is a stronger signal than that setting
 * deserves. Say so if it should be `--status-idle-*` for off instead.
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
              'peer h-6 w-11 cursor-pointer appearance-none rounded-full transition-colors',
              'bg-[var(--status-danger-dot)] checked:bg-[var(--status-ok-dot)]',
              'hover:opacity-90',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]',
              'disabled:cursor-not-allowed disabled:bg-slate-300 checked:disabled:bg-slate-400',
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

        {/* The word, beside the switch, in the switch's colour. Fixed width so
            the label after it does not shift left when On becomes Off. */}
        <span
          aria-hidden
          className={cn(
            'w-7 shrink-0 pt-0.5 text-[0.75rem] font-bold uppercase tracking-wide',
            disabled
              ? 'text-slate-400'
              : checked
                ? 'text-[var(--status-ok-ink)]'
                : 'text-[var(--status-danger-ink)]',
          )}
        >
          {checked ? 'On' : 'Off'}
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
