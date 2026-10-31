import { useState } from 'react';
import useSWR from 'swr';
import { Copy } from 'lucide-react';
import { ALL_RECORDS_PARAM, type ModbusRegisterMap } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { Select } from '@/components/ui/select';

interface TcpipInstrument { id: string; code: string; name: string; profileName: string | null }

/**
 * "Copy from instrument…" (spec §12, plan ruling P4): take another TCP/IP
 * instrument's register map, so identical devices are not typed twice.
 *
 * The list is `GET /api/instruments?connection=MODBUS_TCP` — the instruments of
 * TCP/IP profiles in the CALLER's view, the server's filter, not one applied
 * here — fetched only while the dialog is open. The map itself is read from
 * `GET /api/instruments/:id`, which returns it through the server's forgiving
 * reader. An instrument with no keys is said to have none; copying it would
 * silently empty the form.
 */
export function CopyMapDialog({
  open, onClose, onCopy,
}: { open: boolean; onClose: () => void; onCopy: (map: ModbusRegisterMap) => void }) {
  return (
    <Dialog open={open} onClose={onClose}>
      {open && <CopyMapBody onClose={onClose} onCopy={onCopy} />}
    </Dialog>
  );
}

function CopyMapBody({ onClose, onCopy }: { onClose: () => void; onCopy: (map: ModbusRegisterMap) => void }) {
  const { data, error, isLoading } = useSWR<{ data: TcpipInstrument[] }>(
    `/api/instruments?connection=MODBUS_TCP&${ALL_RECORDS_PARAM}`,
  );
  const instruments = data?.data ?? [];
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const copy = async () => {
    const chosen = instruments.find((i) => i.id === pick);
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    try {
      const inst = await apiClient.get<{ modbusRegisters: ModbusRegisterMap | null }>(`/api/instruments/${chosen.id}`);
      const map = inst.modbusRegisters ?? [];
      if (map.length === 0) {
        setProblem(`${chosen.code} has no register map to copy.`);
        return;
      }
      onCopy(map);
    } catch (err) {
      setProblem((err as { message?: string })?.message ?? 'Could not read that instrument.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogBanner title="Copy register map" subtitle="Replaces the keys in this form" icon={<Copy className="h-4 w-4" />} />
      <label className="block space-y-1" htmlFor="copy-map-instrument">
        <span className="text-sm font-medium text-slate-700">Instrument</span>
        <Select
          id="copy-map-instrument"
          value={pick}
          onChange={(e) => { setPick(e.target.value); setProblem(null); }}
          disabled={isLoading || instruments.length === 0}
        >
          <option value="">
            {isLoading ? 'Loading…' : instruments.length === 0 ? 'No TCP/IP instruments' : 'Choose an instrument…'}
          </option>
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.code}{i.profileName ? ` (${i.profileName})` : ''}
            </option>
          ))}
        </Select>
      </label>
      {error && (
        <p role="alert" className="mt-3 text-xs text-rose-600">
          {(error as { message?: string })?.message ?? 'Could not load the TCP/IP instruments.'}
        </p>
      )}
      {problem && <p role="alert" className="mt-3 text-xs text-rose-600">{problem}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={copy} disabled={!pick || busy} loading={busy}>Copy map</Button>
      </DialogFooter>
    </>
  );
}
