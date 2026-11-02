import { MODBUS_INTERVAL } from '@digilog/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * How the server reads ONE TCP/IP (Modbus) instrument: its "Slave ID" (the
 * Modbus unit ID) and "Read every". Each instrument's own since change request
 * CR-1 (2026-11-02 — they were the profile's). One component for New
 * Instrument and the instrument page's connection card, so the presets and the
 * labels cannot drift. Two labelled fields and no wrapper: the caller lays them
 * out in its own grid or row. The limits are the shared ones (`MODBUS_INTERVAL`,
 * `MODBUS_UNIT_ID`); whether a value is ACCEPTED is the API's answer, shown by
 * the caller under the fields.
 */

/** Seconds, 10 s to 60 min. Every preset must lie inside `MODBUS_INTERVAL`. */
const PRESETS: { sec: number; label: string }[] = [
  { sec: 10, label: '10 seconds' },
  { sec: 30, label: '30 seconds' },
  { sec: 60, label: '1 minute' },
  { sec: 120, label: '2 minutes' },
  { sec: 300, label: '5 minutes' },
  { sec: 600, label: '10 minutes' },
  { sec: 900, label: '15 minutes' },
  { sec: 1800, label: '30 minutes' },
  { sec: 3600, label: '60 minutes' },
].filter((p) => p.sec >= MODBUS_INTERVAL.min && p.sec <= MODBUS_INTERVAL.max);

export function ModbusReadingFields({
  intervalSec, unitId, onIntervalChange, onUnitIdChange, idPrefix, unitIdError, intervalError, compact = false,
}: {
  intervalSec: number;
  unitId: string;
  onIntervalChange: (sec: number) => void;
  onUnitIdChange: (raw: string) => void;
  idPrefix: string;
  /** The message to print under Slave ID (the shared schema's or the API's). */
  unitIdError?: string;
  intervalError?: string;
  /** The connection card's edit row: smaller labels, a narrow Slave ID. */
  compact?: boolean;
}) {
  // A stored interval that is not a preset (set through the API) must still
  // show as itself rather than snap to the nearest preset.
  const options = PRESETS.some((p) => p.sec === intervalSec)
    ? PRESETS
    : [...PRESETS, { sec: intervalSec, label: `${intervalSec} seconds` }].sort((a, b) => a.sec - b.sec);
  const labelClass = compact ? 'text-sm text-slate-600' : 'text-sm font-medium text-slate-700';
  return (
    <>
      <label className="block space-y-1" htmlFor={`${idPrefix}-unit`}>
        <span className={labelClass}>Slave ID</span>
        {/* No min / max and `step="any"`: inside New Instrument's <form> the browser
            would stop 256 or 1.5 with its own bubble, in its own words. The
            shared schema's sentence ("Slave ID must be a whole number from 0
            to 255.") is printed under the field instead — the same wording on
            every browser and on the instrument page. */}
        <Input
          id={`${idPrefix}-unit`}
          type="number"
          inputMode="numeric"
          step="any"
          className={compact ? 'w-24 font-mono' : undefined}
          value={unitId}
          aria-invalid={unitIdError ? true : undefined}
          onChange={(e) => onUnitIdChange(e.target.value)}
        />
        {unitIdError && <p className="mt-1 text-xs text-red-600">{unitIdError}</p>}
      </label>
      <label className="block space-y-1" htmlFor={`${idPrefix}-interval`}>
        <span className={labelClass}>Read every</span>
        <Select
          id={`${idPrefix}-interval`}
          className={compact ? 'w-auto' : undefined}
          value={String(intervalSec)}
          aria-invalid={intervalError ? true : undefined}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
        >
          {options.map((p) => <option key={p.sec} value={String(p.sec)}>{p.label}</option>)}
        </Select>
        {intervalError && <p className="mt-1 text-xs text-red-600">{intervalError}</p>}
      </label>
    </>
  );
}
