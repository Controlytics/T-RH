import { MODBUS_INTERVAL, MODBUS_UNIT_ID } from '@digilog/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * How the server reads a TCP/IP (Modbus) profile's instruments: "Read every"
 * and "Unit ID". One component for the create form and the attributes page, so
 * the presets and the labels cannot drift. The limits are the shared ones
 * (`MODBUS_INTERVAL`, `MODBUS_UNIT_ID`); whether a value is ACCEPTED is the
 * API's answer, shown by the caller under the fields.
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

/** "120 s" — how a stored interval is printed on a card. */
export const intervalText = (sec: number): string => `${sec} s`;

export function ModbusReadingFields({
  intervalSec, unitId, onIntervalChange, onUnitIdChange, idPrefix,
}: {
  intervalSec: number;
  unitId: string;
  onIntervalChange: (sec: number) => void;
  onUnitIdChange: (raw: string) => void;
  idPrefix: string;
}) {
  // A stored interval that is not a preset (set through the API) must still
  // show as itself rather than snap to the nearest preset.
  const options = PRESETS.some((p) => p.sec === intervalSec)
    ? PRESETS
    : [...PRESETS, { sec: intervalSec, label: `${intervalSec} seconds` }].sort((a, b) => a.sec - b.sec);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className="block space-y-1" htmlFor={`${idPrefix}-interval`}>
        <span className="text-sm font-medium text-slate-700">Read every</span>
        <Select
          id={`${idPrefix}-interval`}
          value={String(intervalSec)}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
        >
          {options.map((p) => <option key={p.sec} value={String(p.sec)}>{p.label}</option>)}
        </Select>
      </label>
      <label className="block space-y-1" htmlFor={`${idPrefix}-unit`}>
        <span className="text-sm font-medium text-slate-700">Unit ID</span>
        <Input
          id={`${idPrefix}-unit`}
          type="number"
          inputMode="numeric"
          min={MODBUS_UNIT_ID.min}
          max={MODBUS_UNIT_ID.max}
          step={1}
          value={unitId}
          onChange={(e) => onUnitIdChange(e.target.value)}
        />
      </label>
    </div>
  );
}
