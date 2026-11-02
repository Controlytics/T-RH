import { useState } from 'react';
import useSWR from 'swr';
import { MODBUS_INTERVAL, updateInstrumentSchema, type ModbusRegisterMap } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { ErrorState } from '@/components/ui/empty-state';
import { RemarkDialog, type RemarkChange } from './remark-dialog';
import { TestConnectionPanel } from './test-connection-panel';
import { ModbusReadingFields } from './modbus-reading-fields';
import type { JudgedAs } from './register-map-editor';

/**
 * `GET /api/instruments/:id/modbus-status` — the server's answer, printed as
 * received. `state`, the reason and every figure are decided there (the Reader's
 * own rule); nothing on this card re-derives whether the device is being read.
 */
export interface ModbusStatus {
  state: 'reading' | 'failing' | 'not-read';
  notReadReason?: string;
  notReadDetail?: string;
  readBy: 'server';
  /**
   * The instrument's Read every and the readings a day it implies. NULL for a
   * stored value the Reader refuses (a hand-edited interval — `notReadReason`
   * INVALID_CONFIG, CR-1): no figure is printed rather than "null" or "NaN".
   */
  intervalSec: number | null;
  lastSuccessAt: string | null;
  failingSince: string | null;
  lastError?: { code: string; message: string; at: string };
  stored24h: number;
  expected24h: number | null;
  inactivityAlarmsOff: boolean;
}

/** Only the word and the colour are the card's; the sentence under them is the server's. */
const STATE: Record<ModbusStatus['state'], { tone: StatusTone; word: string }> = {
  reading: { tone: 'ok', word: 'Reading' },
  failing: { tone: 'danger', word: 'Not answering' },
  'not-read': { tone: 'idle', word: 'Not read' },
};

/**
 * What an Edit changes: ONLY the fields that differ from the stored ones
 * (CR-1 — the Slave ID and Read every are the instrument's own since then).
 */
export type ModbusConnectionChange = Partial<{
  modbusHost: string;
  modbusPort: number;
  modbusUnitId: number;
  modbusIntervalSec: number;
}>;

/** "60 s" — how Read every is named in the reason dialog. */
const seconds = (sec: number | null) => (sec === null ? '' : `${sec} s`);
/** A Port or Slave ID as typed → a number; blank is NaN, which the shared schema names. */
const asNumber = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw));

/** The sentence an off Inactivity Alarms setting needs beside a device the server reads (spec §7.5). */
export const INACTIVITY_OFF_SENTENCE =
  'No alarm is raised when this device stops answering — Inactivity Alarms are off (Configuration → Inactivity Alarms).';

export function ModbusConnectionCard({
  instrumentId, profileId, host, port, unitId, intervalSec, map, canEdit, onSave, onJudged,
}: {
  instrumentId: string;
  profileId: string;
  host: string | null;
  port: number | null;
  /** The instrument's stored Slave ID (`modbusUnitId`). */
  unitId: number | null;
  /** The instrument's stored Read every, in seconds (`modbusIntervalSec`). */
  intervalSec: number | null;
  map: ModbusRegisterMap;
  /** `instruments.edit` — the server still decides (INSTRUMENT_UPDATE, re-auth). */
  canEdit: boolean;
  /** Writes ONLY the changed fields with the operator's reason; resolves true once saved. */
  onSave: (fields: ModbusConnectionChange, reason: string) => Promise<boolean>;
  onJudged: (judged: Record<string, JudgedAs>) => void;
}) {
  const { formatDate, formatTime } = useDatetimeFormat();
  const stamp = (v: string | null) => (v ? `${formatDate(v)} ${formatTime(v)}` : '—');
  const { data: status, error: statusError, mutate } = useSWR<ModbusStatus>(
    `/api/instruments/${instrumentId}/modbus-status`,
    { refreshInterval: 15_000 },
  );
  // The server's own message when it sent one (apiClient throws an Error carrying it).
  const statusErrorMessage = statusError instanceof Error ? statusError.message : '';

  const [editing, setEditing] = useState(false);
  const [hostDraft, setHostDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  const [unitDraft, setUnitDraft] = useState('');
  const [intervalDraft, setIntervalDraft] = useState<number>(MODBUS_INTERVAL.default);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setHostDraft(host ?? '');
    setPortDraft(port === null ? '502' : String(port));
    // A stored Slave ID that is somehow absent is left blank to be filled —
    // never guessed here.
    setUnitDraft(unitId === null ? '' : String(unitId));
    setIntervalDraft(intervalSec ?? MODBUS_INTERVAL.default);
    setEditing(true);
  };
  const portNumber = asNumber(portDraft);
  const unitNumber = asNumber(unitDraft);
  // The Slave ID's words are the shared schema's — the ones the API's 400 carries.
  const unitCheck = updateInstrumentSchema.shape.modbusUnitId.safeParse(unitNumber);
  const unitError = unitDraft.trim() !== '' && !unitCheck.success ? unitCheck.error.issues[0]!.message : undefined;
  const address = host !== null && port !== null ? `${host} : ${port}` : '—';

  /** Only what differs from the stored values travels, and only that is signed for. */
  const changed: ModbusConnectionChange = {
    ...(hostDraft.trim() !== (host ?? '') ? { modbusHost: hostDraft.trim() } : {}),
    ...(portNumber !== port ? { modbusPort: portNumber } : {}),
    ...(unitNumber !== unitId ? { modbusUnitId: unitNumber } : {}),
    ...(intervalDraft !== intervalSec ? { modbusIntervalSec: intervalDraft } : {}),
  };
  const changes: RemarkChange[] = [
    ...('modbusHost' in changed ? [{ label: 'IP address', from: host ?? '', to: hostDraft.trim() }] : []),
    ...('modbusPort' in changed ? [{ label: 'Port', from: port === null ? '' : String(port), to: portDraft.trim() }] : []),
    ...('modbusUnitId' in changed ? [{ label: 'Slave ID', from: unitId === null ? '' : String(unitId), to: unitDraft.trim() }] : []),
    ...('modbusIntervalSec' in changed ? [{ label: 'Read every', from: seconds(intervalSec), to: seconds(intervalDraft) }] : []),
  ];
  const draftReady = hostDraft.trim() !== '' && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
    && unitCheck.success && changes.length > 0;

  const submit = async (reason: string) => {
    setBusy(true);
    const saved = await onSave(changed, reason);
    setBusy(false);
    if (saved) {
      setReasonOpen(false);
      setEditing(false);
      void mutate();
    } else {
      setReasonOpen(false);
    }
  };

  const s = status ? STATE[status.state] : null;

  return (
    <div className="space-y-4" data-testid="modbus-connection-card">
      {!status ? (
        // A failed request is a different thing from one still loading (final
        // review F-8): this panel reports device health, so it must never sit
        // on "Checking the connection…" while the request has already failed.
        statusError ? (
          <ErrorState
            title="Could not load the connection status."
            detail={statusErrorMessage || undefined}
            onRetry={() => void mutate()}
          />
        ) : (
          <p className="text-sm text-slate-500">Checking the connection…</p>
        )
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {s && <StatusBadge tone={s.tone} label={s.word} />}
            {status.state === 'not-read' && status.notReadDetail && (
              <span className="text-sm text-slate-600">{status.notReadDetail}</span>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Address</dt>
            <dd className="font-mono text-slate-800">{address}</dd>
            <dt className="text-slate-500">Slave ID</dt>
            <dd className="font-mono text-slate-800">{unitId ?? '—'}</dd>
            <dt className="text-slate-500">Read by</dt>
            <dd>{status.intervalSec === null ? 'This server' : `This server, every ${status.intervalSec} s`}</dd>
            <dt className="text-slate-500">Stored in 24 h</dt>
            <dd>
              {status.expected24h === null
                ? `stored ${status.stored24h} in 24 h`
                : `stored ${status.stored24h} of ${status.expected24h} in 24 h`}
            </dd>
            <dt className="text-slate-500">Last answered</dt>
            <dd>{stamp(status.lastSuccessAt)}</dd>
            {/* Only while the server is ASKING (final review F-2): a not-read
                instrument keeps the stale failingSince it had when it was last
                read, and "Not answering since" beside "Not read" would say the
                device is silent when nobody is asking it. The last failure
                below still records what happened. */}
            {status.state === 'failing' && status.failingSince && (
              <>
                <dt className="text-slate-500">Not answering since</dt>
                <dd>{stamp(status.failingSince)}</dd>
              </>
            )}
          </dl>

          {status.lastError && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-testid="modbus-last-error">
              <div className="text-xs font-medium text-slate-500">Last failure · {stamp(status.lastError.at)}</div>
              <div className="text-slate-800">{status.lastError.message}</div>
            </div>
          )}

          {status.inactivityAlarmsOff && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="inactivity-off">
              {INACTIVITY_OFF_SENTENCE}
            </p>
          )}
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1">
              <span className="text-sm text-slate-600">IP address</span>
              <Input value={hostDraft} aria-label="IP address" className="font-mono" autoComplete="off"
                onChange={(e) => setHostDraft(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-slate-600">Port</span>
              <Input value={portDraft} aria-label="Port" inputMode="numeric" className="w-24 font-mono"
                onChange={(e) => setPortDraft(e.target.value)} />
            </label>
            <ModbusReadingFields
              idPrefix={`instrument-${instrumentId}`}
              compact
              unitId={unitDraft}
              intervalSec={intervalDraft}
              onUnitIdChange={setUnitDraft}
              onIntervalChange={setIntervalDraft}
              unitIdError={unitError}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" disabled={!draftReady} onClick={() => setReasonOpen(true)}>Save</Button>
          </div>
        </div>
      ) : (
        canEdit && (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={startEdit}>Edit</Button>
          </div>
        )
      )}

      {!editing && host !== null && port !== null && map.length > 0 && (
        <TestConnectionPanel
          profileId={profileId} host={host} port={port}
          // An absent stored Slave ID is not guessed: the panel says it needs one.
          unitId={unitId ?? Number.NaN}
          map={map}
          instrumentId={instrumentId} onJudged={onJudged}
        />
      )}

      <RemarkDialog
        open={reasonOpen}
        title="Change the TCP/IP connection"
        attributeKey=""
        from=""
        changes={changes}
        busy={busy}
        onSubmit={(reason) => void submit(reason)}
        onClose={() => setReasonOpen(false)}
      />
    </div>
  );
}
