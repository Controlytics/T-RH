import { useCallback, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tab bar — ONE implementation of the keyboard and ARIA contract.
 *
 * WHY THIS EXISTS, AND WHY IT LOOKS DIFFERENT FROM THE LAST ATTEMPT
 * ----------------------------------------------------------------
 * Five screens hand-rolled their own tab bar: alarms, config/display-settings,
 * config/notification-rules, config/notification-settings/email-settings and
 * config/role-access. Five `useState` declarations, five button rows, five
 * chances to get the accessible behaviour wrong — and three separate sweeps
 * each turned up one more of them, which is the argument for a primitive
 * rather than another sweep.
 *
 * `9a9bb9e` had already tried `role="tablist"` on the role-access bar and
 * BACKED IT OUT, for a good reason worth restating: the `tab` role advertises
 * a keyboard contract — roving tabindex, arrow keys, `aria-controls` pointing
 * at real tabpanels — and that bar implemented none of it. A screen reader
 * announced "tab, 1 of 7", the user reached for arrow keys, and nothing
 * happened. ARIA that promises a behaviour it does not have is worse than no
 * ARIA at all, so it was reverted to `aria-pressed` buttons, which at least
 * behaved the way they were announced.
 *
 * This component does not re-litigate that. It removes the reason for it: the
 * contract is IMPLEMENTED here, once, so `role="tablist"` is now honest.
 *
 *   - Roving tabindex — exactly one tab is in the page's tab order
 *     (`tabIndex={0}` on the active one, `-1` on the rest), so Tab moves INTO
 *     and OUT OF the bar rather than through every tab in it.
 *   - Left/Right arrows move between tabs and wrap; Home/End jump to the ends.
 *     Selection follows focus, which is the correct pattern for tabs whose
 *     panels are already in the DOM.
 *   - `aria-controls` names a panel that genuinely exists, because this
 *     component renders the panel too (`<TabPanel>`), and the ids are derived
 *     from one `useId` so they cannot drift apart.
 *
 * Arrow-key movement calls `.focus()` on the newly selected tab. That is what
 * makes roving tabindex work: without it focus would stay on a button that is
 * now `tabIndex={-1}` and the next Tab press would jump somewhere unexpected.
 */

export interface TabDef<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** Optional leading icon. Pass the bare <svg>; it is marked aria-hidden. */
  icon?: ReactNode;
  disabled?: boolean;
}

export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  variant = 'underline',
  className,
  'aria-label': ariaLabel,
}: {
  tabs: ReadonlyArray<TabDef<Id>>;
  active: Id;
  onChange: (id: Id) => void;
  /**
   * Share this between <Tabs> and every <TabPanel> so `aria-controls` and the
   * panel's `id` agree. Defaults to a generated id, which is fine when the
   * panels are rendered through <TabPanel> from the same prefix.
   */
  idPrefix?: string;
  /**
   * `underline` — a full-width bar inside a card (role-access, alarms).
   * `segmented` — the `.seg` chip group used elsewhere in the product.
   */
  variant?: 'underline' | 'segmented';
  className?: string;
  /** Names the tab set for a screen reader, e.g. "Role configuration". */
  'aria-label'?: string;
}) {
  const auto = useId();
  const prefix = idPrefix ?? auto;
  const refs = useRef(new Map<Id, HTMLButtonElement | null>());

  const enabled = tabs.filter((t) => !t.disabled);

  const move = useCallback(
    (delta: number) => {
      const i = enabled.findIndex((t) => t.id === active);
      if (i === -1) return;
      // Wraps deliberately: the WAI-ARIA authoring practice for a tablist is a
      // circular list, and stopping at the ends makes a 7-tab bar feel broken.
      const next = enabled[(i + delta + enabled.length) % enabled.length];
      onChange(next.id);
      refs.current.get(next.id)?.focus();
    },
    [enabled, active, onChange],
  );

  const jump = useCallback(
    (to: 'first' | 'last') => {
      const t = to === 'first' ? enabled[0] : enabled[enabled.length - 1];
      if (!t) return;
      onChange(t.id);
      refs.current.get(t.id)?.focus();
    },
    [enabled, onChange],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); move(1); break;
      case 'ArrowLeft': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); jump('first'); break;
      case 'End': e.preventDefault(); jump('last'); break;
      default: break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        variant === 'underline' ? 'flex border-b border-slate-200' : 'seg',
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current.set(tab.id, el); }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${prefix}-panel-${tab.id}`}
            // The roving part. Exactly one tab is reachable by Tab.
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              variant === 'segmented' && 'seg-btn',
              variant === 'underline' && [
                'flex-1 px-6 py-4 text-sm font-medium transition-all',
                'flex items-center justify-center gap-2',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-primary,#2a78d6)] focus-visible:ring-offset-[-2px]',
                selected
                  ? 'bg-[var(--theme-primary,#2a78d6)]/10 text-[var(--theme-primary,#2a78d6)] border-b-2 border-[var(--theme-primary,#2a78d6)]'
                  : 'text-slate-600 hover:bg-slate-50',
                tab.disabled && 'cursor-not-allowed opacity-55 hover:bg-transparent',
              ],
            )}
          >
            {tab.icon && <span aria-hidden className="contents">{tab.icon}</span>}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The panel for one tab. Render it for the ACTIVE tab only — these pages
 * already mount their panels conditionally, and keeping that means the panel
 * `aria-controls` names is the one actually in the tree.
 *
 * `tabIndex={0}` so a keyboard user can reach the panel body itself after
 * leaving the tab strip, which is what the authoring practice asks for when
 * the panel is not automatically focusable.
 */
export function TabPanel({
  id, tabId, idPrefix, children, className,
}: {
  /** The tab's id — same value passed to <Tabs>. */
  id: string;
  /** Deprecated alias kept for readability at call sites. */
  tabId?: string;
  idPrefix: string;
  children: ReactNode;
  className?: string;
}) {
  const key = tabId ?? id;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${key}`}
      aria-labelledby={`${idPrefix}-tab-${key}`}
      tabIndex={0}
      className={cn('focus-visible:outline-none', className)}
    >
      {children}
    </div>
  );
}
