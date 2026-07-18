import { useState } from 'react';

const DURATION_OPTIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];

function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface DryerDurationDialogProps {
  open: boolean;
  filterName: string;
  loading?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (minutes: number) => void;
}

export function DryerDurationDialog({ open, filterName, loading, error, onClose, onSubmit }: DryerDurationDialogProps) {
  const [minutes, setMinutes] = useState<number>(30);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-lg bg-white shadow-xl">
        <div className="rounded-t-lg bg-gradient-to-r from-blue-600 to-blue-500 px-5 py-4 text-white">
          <h2 className="text-lg font-semibold">Set Dryer Duration</h2>
          <p className="text-sm opacity-90">{filterName}</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Duration</label>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="w-full rounded border border-slate-300 px-3 py-2 text-slate-800 focus:border-blue-500 focus:outline-none"
              disabled={loading}
            >
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>{formatDuration(m)}</option>
              ))}
            </select>
            <p className="mt-2 text-xs text-slate-500">
              Temperature readings can be entered after half the duration has elapsed.
            </p>
          </div>
          {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSubmit(minutes)}
              disabled={loading}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Starting…' : 'Start Dryer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
