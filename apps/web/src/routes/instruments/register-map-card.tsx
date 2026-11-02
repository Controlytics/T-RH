import { useState } from 'react';
import { modbusRegisterMapSchema, type ModbusRegisterMap } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { RegisterMapEditor, type JudgedAs } from './register-map-editor';
import type { TestTarget } from './modbus-test';
import { RemarkDialog } from './remark-dialog';

const count = (m: ModbusRegisterMap) => `${m.length} register${m.length === 1 ? '' : 's'}`;

/**
 * The register map of a stored TCP/IP instrument: read-only until a SUPER_ADMIN
 * edits it (the server answers 403 REGISTER_MAP_SA_ONLY to anyone else, so
 * hiding Edit here is a convenience, not the control). A change asks for a
 * reason and goes through `onSave`. Validity is the shared schema's — the one
 * the API runs. `testTarget` (the instrument's STORED address and Slave ID)
 * gives every row a per-key Test in both views (CR-1).
 */
export function RegisterMapCard({
  map, judged, canEdit, onSave, testTarget,
}: {
  map: ModbusRegisterMap;
  judged: Record<string, JudgedAs>;
  /** The caller is a SUPER_ADMIN. */
  canEdit: boolean;
  /** Writes the map with the operator's reason; resolves true once saved. */
  onSave: (map: ModbusRegisterMap, reason: string) => Promise<boolean>;
  testTarget?: TestTarget;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ModbusRegisterMap>(map);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const valid = draft.length > 0 && modbusRegisterMapSchema.safeParse(draft).success;

  const submit = async (reason: string) => {
    setBusy(true);
    const saved = await onSave(draft, reason);
    setBusy(false);
    setReasonOpen(false);
    if (saved) setEditing(false);
  };

  return (
    <div className="space-y-3" data-testid="register-map-card">
      {editing ? (
        <>
          <RegisterMapEditor value={draft} onChange={setDraft} judged={judged} testTarget={testTarget} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" disabled={!valid} onClick={() => setReasonOpen(true)}>Save</Button>
          </div>
        </>
      ) : (
        <>
          {map.length === 0
            ? <p className="text-sm text-slate-500">No register map yet — nothing is read from this device.</p>
            : <RegisterMapEditor value={map} onChange={() => undefined} judged={judged} readOnly testTarget={testTarget} />}
          {canEdit && (
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => { setDraft(map); setEditing(true); }}>Edit</Button>
            </div>
          )}
        </>
      )}
      <RemarkDialog
        open={reasonOpen}
        title="Change the register map"
        attributeKey=""
        from={count(map)}
        to={count(draft)}
        busy={busy}
        onSubmit={(reason) => void submit(reason)}
        onClose={() => setReasonOpen(false)}
      />
    </div>
  );
}
