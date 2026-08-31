import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * The password box for a 21 CFR §11 e-signature.
 *
 * **This exists because `autocomplete="off"` does not work.** Chrome deliberately
 * ignores it on credential fields — the password manager was designed to override
 * sites that try to opt out. On an e-signature that is not a nuisance, it is a
 * defect with regulatory weight: §11.200 requires the signature to be executed by
 * its owner, and a password the browser types means anyone at an unlocked
 * workstation can sign as whoever the browser remembers.
 *
 * It also has a second, stranger symptom, which is how this was found. A
 * `type="password"` input that is NOT inside a `<form>` makes Chrome scan the
 * whole document for something to treat as the username field — and it will fill
 * an unrelated text box elsewhere on the page. On the Alarms screen it typed the
 * logged-in username into the SEARCH box the moment the acknowledge dialog
 * opened, which looks like a bug in the search box and is not.
 *
 * Four measures, all needed together:
 *
 *  1. **Mount as `type="text"`, become `type="password"` a tick later.** The
 *     password manager's scan runs when the field appears; at that moment there
 *     is no password field to fill or to pair a username with. This is the one
 *     that actually stops the fill.
 *  2. **`autoComplete="one-time-code"`** — a value Chrome honours by not
 *     offering saved credentials, unlike `off`.
 *  3. **A `name` it has never seen**, generated per mount. A stable name is a key
 *     the browser can save a credential against and offer back later.
 *  4. **`secureField`**, which blocks copy, cut, paste and drag. Established for
 *     e-signature passwords across this app, not new here.
 *
 * Do not "simplify" any of these away individually — each defeats a different
 * heuristic, and the failure is silent: the field looks fine and is simply
 * pre-filled for the next person who opens it.
 */
export function SignaturePasswordInput({
  id, value, onChange, onEnter, placeholder, autoFocus = true, className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Submit on Enter, when the surrounding dialog supports it. */
  onEnter?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  const [ready, setReady] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Per MOUNT, not per render: regenerating it on every keystroke would replace
  // the field's identity mid-typing.
  const nameRef = useRef(`sig-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true);
      if (autoFocus) ref.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [autoFocus]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <Input
        ref={ref}
        id={id}
        type={!ready || show ? 'text' : 'password'}
        secureField
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter && value) onEnter(); }}
        placeholder={placeholder}
        className="pr-11"
        autoComplete="one-time-code"
        name={nameRef.current}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        // Out of the tab order: tabbing from the password should reach the
        // signing button, not a visibility toggle.
        tabIndex={-1}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
      >
        {show ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        )}
      </button>
    </div>
  );
}
