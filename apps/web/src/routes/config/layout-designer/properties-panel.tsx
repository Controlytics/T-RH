import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import { ROOM_GRADES, ROOM_GRADE_META } from '@/routes/dashboard/use-telemetry';
import type { DoorKind, RoomDoor } from '@/routes/dashboard/room-geometry';
import type { DesignerLink } from './types';

/** The editable fields of a room. Strings, because they are inputs; the page converts on save. */
export interface RoomForm {
  code: string;
  label: string;
  grade: string;
  tempMin: string; tempMax: string; rhMin: string; rhMax: string;
  instrumentIds: string[];
  doors: RoomDoor[];
}

export const EMPTY_FORM: RoomForm = { code: '', label: '', grade: '', tempMin: '', tempMax: '', rhMin: '', rhMax: '', instrumentIds: [], doors: [] };

export interface InstrumentRow { id: string; code: string; name: string }

export function RoomPropertiesPanel({
  mode, form, setForm, instruments, roomOfInstrument, roomId, saving, onSave, onDelete, onCancel, onMerge, mergeLabel,
}: {
  mode: 'new' | 'edit';
  form: RoomForm;
  setForm: (f: (prev: RoomForm) => RoomForm) => void;
  instruments: InstrumentRow[];
  roomOfInstrument: Map<string, { id: string; code: string }>;
  roomId: string | null;
  saving: boolean;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
  /** Merge the selected room with its one adjoining piece, when there is one. */
  onMerge: (() => void) | null;
  mergeLabel: string | null;
}) {
  const toggleInstrument = (id: string) =>
    setForm((f) => ({ ...f, instrumentIds: f.instrumentIds.includes(id) ? f.instrumentIds.filter((v) => v !== id) : [...f.instrumentIds, id] }));

  return (
    <FormSection title={mode === 'edit' ? `Room ${form.code || ''}` : 'New room'} columns={1}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="ld-code" className="mb-1 block text-xs font-medium text-slate-600">Room code</label>
          <Input id="ld-code" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        </div>
        <div>
          <label htmlFor="ld-label" className="mb-1 block text-xs font-medium text-slate-600">Name</label>
          <Input id="ld-label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        </div>
        <div>
          <label htmlFor="ld-grade" className="mb-1 block text-xs font-medium text-slate-600">Grade</label>
          <select id="ld-grade" value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} className="ctl w-full">
            <option value="">Not classified</option>
            {ROOM_GRADES.map((g) => <option key={g} value={g}>{ROOM_GRADE_META[g].label} — {ROOM_GRADE_META[g].name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {([['tempMin', 'Min temperature (°C)'], ['tempMax', 'Max temperature (°C)'], ['rhMin', 'Min humidity (%RH)'], ['rhMax', 'Max humidity (%RH)']] as const).map(([key, label]) => (
          <div key={key}>
            <label htmlFor={`ld-${key}`} className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
            <Input id={`ld-${key}`} type="number" value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-700">Doors</p>
        {form.doors.length === 0 ? (
          <p className="text-xs text-slate-500">None. Use the Door tool and click a wall.</p>
        ) : (
          <ul className="space-y-1">
            {form.doors.map((d, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="w-16 font-medium">{d.wall ?? `edge ${d.edge}`}</span>
                <select
                  value={d.kind}
                  aria-label={`Door ${i + 1} kind`}
                  onChange={(e) => { const kind = e.target.value as DoorKind; setForm((f) => ({ ...f, doors: f.doors.map((door, ix) => (ix === i ? { ...door, kind } : door)) })); }}
                  className="ctl ctl-sm"
                >
                  <option value="ENTRY">Entry</option>
                  <option value="EXIT">Exit</option>
                  <option value="PASSAGE">Passage</option>
                </select>
                <Button variant="ghost" size="sm" type="button" onClick={() => setForm((f) => ({ ...f, doors: f.doors.filter((_, ix) => ix !== i) }))}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-slate-700">Instruments in this room</p>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {instruments.length === 0 && <p className="p-2 text-sm text-slate-500">No instruments registered.</p>}
          {instruments.map((i) => {
            const elsewhere = roomOfInstrument.get(i.id);
            const isHere = elsewhere?.id === roomId;
            return (
              <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50">
                <input type="checkbox" checked={form.instrumentIds.includes(i.id)} onChange={() => toggleInstrument(i.id)} className="ctl-check" />
                <span className="text-sm font-medium text-slate-800">{i.code}</span>
                {elsewhere && !isHere && (
                  <span className="ml-auto rounded bg-amber-50 px-1.5 py-0.5 text-[0.6875rem] font-medium text-amber-700">in {elsewhere.code}</span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : mode === 'edit' ? 'Save room' : 'Create room'}</Button>
        {mode === 'edit' && <Button variant="outline" onClick={onDelete} disabled={saving}>Delete room</Button>}
        {mode === 'edit' && onMerge && <Button variant="outline" onClick={onMerge} disabled={saving} title={mergeLabel ?? undefined}>Merge pieces</Button>}
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </FormSection>
  );
}

export function LinkPropertiesPanel({
  link, fromCode, toCode, saving, onChange, onDelete, onCancel,
}: {
  link: DesignerLink;
  fromCode: string;
  toCode: string;
  saving: boolean;
  onChange: (patch: { door?: DoorKind | null; label?: string | null }) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <FormSection title={`${link.kind === 'OPENING' ? 'Opening' : 'Connector'}: ${fromCode} ↔ ${toCode}`} columns={1}>
      {link.kind === 'OPENING' ? (
        <div>
          <label htmlFor="ld-link-door" className="mb-1 block text-xs font-medium text-slate-600">Door</label>
          <select
            id="ld-link-door"
            value={link.door ?? ''}
            onChange={(e) => onChange({ door: (e.target.value || null) as DoorKind | null })}
            className="ctl w-full sm:w-64"
            disabled={saving}
          >
            <option value="">Open gap, no door</option>
            <option value="ENTRY">Entry</option>
            <option value="EXIT">Exit</option>
            <option value="PASSAGE">Passage</option>
          </select>
        </div>
      ) : (
        <div>
          <label htmlFor="ld-link-label" className="mb-1 block text-xs font-medium text-slate-600">Label</label>
          <Input
            id="ld-link-label"
            defaultValue={link.label ?? ''}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (link.label ?? '')) onChange({ label: v || null }); }}
            disabled={saving}
            className="sm:w-64"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onDelete} disabled={saving}>Delete link</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Close</Button>
      </div>
    </FormSection>
  );
}
