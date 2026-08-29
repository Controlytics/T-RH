import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * One labelled field: label, required marker, control, helper, validation.
 *
 * Everything a field needs, in one place, so that a required marker looks the
 * same on the alarm page as on the instrument page. Before this, each screen
 * assembled its own and none of them assembled the same one.
 *
 * The label is a real `<label htmlFor>`, wired to the control by a generated id.
 * A `<p>` styled to look like a label does not move focus when clicked and is not
 * announced with the field, which is most of what a label is for.
 */
export function FormField({
  label, required, helper, error, success, htmlFor, group = false, children, className,
}: {
  label: string;
  required?: boolean;
  /** Guidance shown while the field is valid. Hidden once there is an error. */
  helper?: string;
  /** The problem, in the interface's voice: what is wrong and what to do. */
  error?: string | null;
  /** Confirmation for a field worth confirming. Use sparingly — a tick on every
   *  field is noise, and noise is what an operator learns to ignore. */
  success?: string | null;
  htmlFor?: string;
  /**
   * The field is a GROUP of controls (a set of checkboxes, a radio group), not
   * one control.
   *
   * `<label htmlFor>` can only point at a single labelable element, so on a
   * multiselect it pointed at an id nothing carried: clicking the label did
   * nothing and the group was announced without its name. With `group`, the
   * label becomes a referenced `<span>` and the wrapper becomes a real
   * `role="group"` that names itself from it — which is what a set of
   * checkboxes needs — and it is where `aria-describedby` lands too.
   */
  group?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const describedBy = error ? `${id}-error` : helper ? `${id}-helper` : undefined;

  const labelBody = (
    <>
      {label}
      {required && (
        // Marked with a symbol AND a screen-reader word: an asterisk alone is
        // silent to anyone not looking at it.
        <span className="ml-0.5 text-rose-600" aria-hidden>*</span>
      )}
      {required && <span className="sr-only"> (required)</span>}
    </>
  );
  const labelCls = 'block text-[13px] font-medium text-slate-700';

  return (
    <div className={cn('space-y-1.5', className)}>
      {group ? (
        <span id={`${id}-label`} className={labelCls}>{labelBody}</span>
      ) : (
        <label htmlFor={id} className={labelCls}>{labelBody}</label>
      )}

      {/* The control is cloned nothing — for a single control the caller passes
          the matching `id`/`aria-describedby`. Keeping this dumb means a
          searchable select and a plain input can both live here. A GROUP has no
          single control to point at, so the wrapper carries the semantics. */}
      <div
        data-field-id={id}
        data-described-by={describedBy}
        role={group ? 'group' : undefined}
        aria-labelledby={group ? `${id}-label` : undefined}
        aria-describedby={group ? describedBy : undefined}
      >
        {children}
      </div>

      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-[12px] text-rose-700" role="alert">
          <svg aria-hidden viewBox="0 0 16 16" className="mt-px h-3.5 w-3.5 shrink-0 fill-current">
            <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.75Zm0 5.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
          </svg>
          <span>{error}</span>
        </p>
      ) : success ? (
        <p className="flex items-start gap-1.5 text-[12px] text-emerald-700">
          <svg aria-hidden viewBox="0 0 16 16" className="mt-px h-3.5 w-3.5 shrink-0 fill-current">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.53 5.28-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L7 8.69l3.47-3.47a.75.75 0 1 1 1.06 1.06Z" />
          </svg>
          <span>{success}</span>
        </p>
      ) : helper ? (
        <p id={`${id}-helper`} className="text-[12px] text-slate-500">{helper}</p>
      ) : null}
    </div>
  );
}

/**
 * A titled group of fields inside a configuration screen.
 *
 * The unit that turns a stack of inputs into a form someone can scan: a heading
 * naming what the group decides, an optional sentence saying why it matters, and
 * a grid that puts related fields side by side instead of one per line.
 */
export function FormSection({
  title, description, icon, columns = 2, actions, children, className,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  /** Fields per row on a wide screen. Always one on a narrow one. */
  columns?: 1 | 2 | 3;
  /** Controls belonging to the section itself, not to a field. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]', className)}>
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-3.5">
        {icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-[16px] font-semibold leading-tight text-slate-800">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] text-slate-500">{description}</p>}
        </div>
        {actions && <div className="ml-auto shrink-0">{actions}</div>}
      </header>

      <div
        className={cn(
          'grid gap-x-5 gap-y-4 p-5',
          columns === 2 && 'md:grid-cols-2',
          columns === 3 && 'md:grid-cols-2 xl:grid-cols-3',
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The save/cancel bar at the foot of a configuration screen.
 *
 * Always in the same place, with the primary action last — the position a
 * confirming action holds everywhere else in this product. `sticky` so a long
 * form does not hide its own Save below the fold, which is the single most
 * common way a configuration screen loses someone's work.
 */
export function FormActions({
  children, sticky = false, note, className,
}: {
  children: ReactNode;
  sticky?: boolean;
  /** e.g. "Changes are recorded in the audit trail." */
  note?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 px-5 py-3.5 backdrop-blur',
        sticky && 'sticky bottom-0 z-10 rounded-b-[var(--radius-card)] shadow-[0_-2px_10px_-6px_rgb(15_23_42/0.2)]',
        className,
      )}
    >
      {note && <p className="text-[12px] text-slate-500">{note}</p>}
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
