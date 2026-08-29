import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SearchableOption {
  value: string;
  label: string;
}

export const MAX_VISIBLE_OPTIONS = 50;

/**
 * Rank groups. An exact match must outrank everything so it can never be cut
 * by MAX_VISIBLE_OPTIONS — see the spec's ranking rationale.
 */
const EXACT = 0;
const PREFIX = 1;
const CONTAINS = 2;

function rankOf(label: string, query: string): number {
  if (label === query) return EXACT;
  if (label.startsWith(query)) return PREFIX;
  return CONTAINS;
}

/**
 * Multi-keyword, case-insensitive substring match over an option list.
 *
 * Every whitespace-separated word must appear somewhere in the label, in any
 * order, so `hf 042` matches `HF-042`. Deliberately NOT fuzzy: on a 21 CFR
 * system, offering a near-miss invites logging work against the wrong asset.
 *
 * Matching runs over the whole list; callers cap only what they render.
 */
export function matchOptions(
  options: SearchableOption[],
  query: string,
): SearchableOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return options;

  const words = normalized.split(/\s+/);
  const matched = options.filter((option) => {
    const label = option.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });

  // Stable sort keeps the caller's (alphabetical) order inside each group.
  return matched
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const rankDiff =
        rankOf(a.option.label.toLowerCase(), normalized) -
        rankOf(b.option.label.toLowerCase(), normalized);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ option }) => option);
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Applied to the wrapper. */
  className?: string;
  /** Applied to the trigger button; wins over the defaults via twMerge. */
  triggerClassName?: string;
  /**
   * Which edge the panel is anchored to. The panel is wider than its trigger
   * (a trigger in a narrow grid cell would otherwise give an unreadable
   * ~90px list), so a trigger near the right edge must anchor 'right' or the
   * panel is clipped by the nearest scroll container — `overflow-y-auto`
   * computes `overflow-x` to `auto`, so there is no escaping it the way a
   * native <select> popup does.
   */
  align?: 'left' | 'right';
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Type to search…',
  disabled = false,
  className,
  triggerClassName,
  align = 'left',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const matches = useMemo(() => matchOptions(options, query), [options, query]);
  const visible = matches.slice(0, MAX_VISIBLE_OPTIONS);
  const hiddenCount = matches.length - visible.length;

  // Reset the query each time the panel opens so a stale search never hides
  // the list on reopen.
  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (optionValue: string) => {
    onChange(optionValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-[var(--radius-control)] px-3',
          'border border-slate-300 bg-white text-[0.875rem] text-slate-800',
          'transition-colors duration-150',
          'hover:border-slate-400',
          // The site theme, like Select and every other control. A primitive
          // with its own accent is the drift these components exist to prevent.
          'focus:border-[var(--theme-primary,#2a78d6)] focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary,#2a78d6)]/25',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:opacity-50',
          triggerClassName,
        )}
      >
        <span className={cn('truncate', !selected && 'text-slate-400')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cn(
            // Slate, like Select's chevron. This is an affordance, not an accent.
            'ml-1 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-2 overflow-hidden rounded-xl',
            // Never narrower than the trigger, but free to grow past a narrow
            // grid cell so labels stay readable — capped so it always fits
            // inside the scroll container that clips it.
            'w-max min-w-full max-w-[70vw]',
            align === 'right' ? 'right-0' : 'left-0',
            'border border-slate-200 bg-white shadow-[var(--elev-2)]',
          )}
        >
          <div className="relative border-b border-slate-200 p-2">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className={cn(
                'h-10 w-full rounded-lg bg-slate-50 pl-9 pr-9 text-sm text-slate-700',
                'placeholder:text-slate-400',
                'focus:bg-white focus:outline-none focus:ring-2 focus:ring-[var(--theme-primary,#2a78d6)]/25',
              )}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* max-h keeps the list reachable when the tablet's on-screen
              keyboard claims the lower half of the viewport. */}
          <ul role="listbox" className="max-h-64 overflow-y-auto overscroll-contain">
            {visible.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-400">No matches</li>
            )}
            {visible.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => select(option.value)}
                  className={cn(
                    // 90d6f2c themed this primitive's TRIGGER and search box and
                    // stopped at the popup, so the control still answered indigo
                    // the moment it was opened. The option row is the theme now,
                    // at the system's 40px rather than 44px.
                    'flex h-10 w-full items-center px-3 text-left text-sm',
                    'transition-colors duration-150 hover:bg-slate-50',
                    option.value === value
                      ? 'bg-[var(--theme-primary,#2a78d6)]/10 font-semibold text-[var(--theme-primary,#2a78d6)]'
                      : 'text-slate-700',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                </button>
              </li>
            ))}
          </ul>

          {hiddenCount > 0 && (
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-center text-xs text-slate-500">
              Showing {visible.length} of {matches.length.toLocaleString()} — keep typing to narrow
            </div>
          )}
        </div>
      )}
    </div>
  );
}
