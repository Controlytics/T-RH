import type { KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { useOffsetKeys } from '@/hooks/use-offset-keys';

/**
 * The value box for one instrument attribute. Free text for every attribute —
 * EXCEPT a sensor offset (2026-10-01), which gets the operator's "+ or -
 * option": a sign choice beside the number, where + adds the offset to every
 * reading and - subtracts it. The value it emits is the signed string the
 * server stores (`+2`, `-1.5`); the server validates and normalises it again,
 * so this is presentation.
 */
export function AttributeValueInput({
  attrKey, value, onChange, ariaLabel, placeholder, className, onKeyDown,
}: {
  attrKey: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const isOffset = useOffsetKeys();
  if (!isOffset(attrKey)) {
    return (
      <Input
        className={className}
        value={value}
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    );
  }
  return <OffsetValueInput value={value} onChange={onChange} ariaLabel={ariaLabel ?? attrKey} className={className} onKeyDown={onKeyDown} />;
}

/** Split a stored offset into its sign and magnitude; no sign means +. */
export function splitOffset(value: string): { sign: '+' | '-'; magnitude: string } {
  const v = value.trim();
  if (v.startsWith('-')) return { sign: '-', magnitude: v.slice(1).trim() };
  if (v.startsWith('+')) return { sign: '+', magnitude: v.slice(1).trim() };
  return { sign: '+', magnitude: v };
}

export function OffsetValueInput({
  value, onChange, ariaLabel, className, onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { sign, magnitude } = splitOffset(value);
  const emit = (s: '+' | '-', m: string) => onChange(m.trim() === '' ? '' : `${s}${m.trim()}`);
  return (
    <div className={`flex min-w-0 items-stretch gap-1.5 ${className ?? ''}`} data-testid="offset-input">
      <select
        aria-label={`${ariaLabel} — add or subtract`}
        value={sign}
        onChange={(e) => emit(e.target.value as '+' | '-', magnitude)}
        className="ctl w-16 shrink-0 text-center font-semibold"
      >
        <option value="+">+</option>
        <option value="-">−</option>
      </select>
      <Input
        value={magnitude}
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder="0.0"
        onChange={(e) => emit(sign, e.target.value.replace(/^[+-]/, ''))}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
