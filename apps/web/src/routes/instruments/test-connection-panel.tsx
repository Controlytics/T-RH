import { useEffect, useRef, useState } from 'react';
import { PlugZap } from 'lucide-react';
import type { ModbusRegisterMap } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { JudgedAs } from './register-map-editor';

/** `POST /api/instruments/modbus/test` — the server's answer, as it sends it. */
type TestAnswer =
  | {
    ok: true;
    elapsedMs: number;
    requests: number;
    values: { key: string; value: unknown; judgedAs: JudgedAs }[];
    rejected: { key: string; reason: string }[];
  }
  | { ok: false; code: string; message: string };

/** A request the server refused outright (400 / 403 / 429): its message and code. */
interface Refusal { refused: true; code: string | undefined; message: string }

/**
 * The pill for a failure. The CODE picks only the word and the colour; the
 * sentence beside it is the server's `message`, printed verbatim. A device
 * that failed is red; a setting or another instrument standing in the way is
 * amber. A code not listed (a 429, a 403) still prints its message.
 */
const PILL: Record<string, { tone: StatusTone; word: string }> = {
  NO_ANSWER: { tone: 'danger', word: 'No answer' },
  REFUSED: { tone: 'danger', word: 'Refused' },
  DEVICE_EXCEPTION: { tone: 'danger', word: 'Register refused' },
  BAD_RESPONSE: { tone: 'danger', word: 'Bad answer' },
  READING_OFF: { tone: 'warn', word: 'Reading off' },
  ADDRESS_IN_USE: { tone: 'warn', word: 'In use' },
  ADDRESS_NOT_ALLOWED: { tone: 'warn', word: 'Not allowed' },
  VALIDATION_ERROR: { tone: 'warn', word: 'Invalid' },
};
const NOT_TESTED = { tone: 'danger' as StatusTone, word: 'Not tested' };

/**
 * Test connection (spec §8): read the device ONCE with this form's address and
 * register map, store nothing, and show every key's value — or why it could
 * not. A wrong byte order does not fail, it reads a believable wrong number,
 * which is what this exists to show before anything is saved.
 *
 * Nothing is decided here. The values, the failure sentence and which key is
 * judged (`judgedAs`, handed up through `onJudged` for the map's Judged as
 * column) are the response's. A result describes the address and map it was
 * read with: when any of them changes it is dropped, and the judgement with it,
 * so values read with one map never sit beside another.
 *
 * Shared by New Instrument and the instrument page; `instrumentId` names a
 * stored instrument so its own address is not reported as in use.
 */
export function TestConnectionPanel({
  profileId, host, port, map, instrumentId, onJudged,
}: {
  profileId: string;
  host: string;
  port: number;
  map: ModbusRegisterMap;
  instrumentId?: string;
  onJudged: (judged: Record<string, JudgedAs>) => void;
}) {
  const body = {
    profileId,
    modbusHost: host,
    modbusPort: port,
    modbusRegisters: map,
    ...(instrumentId ? { instrumentId } : {}),
  };
  /** The request, serialised: what a result was read WITH. */
  const signature = JSON.stringify(body);
  const [result, setResult] = useState<{ signature: string; answer: TestAnswer | Refusal } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(signature);
  live.current = signature;
  const onJudgedRef = useRef(onJudged);
  onJudgedRef.current = onJudged;

  // The form changed under a result: drop it, and the judgement it carried.
  useEffect(() => {
    if (result && result.signature !== signature) {
      setResult(null);
      onJudgedRef.current({});
    }
  }, [signature, result]);

  const ready = host.trim() !== '' && Number.isInteger(port) && map.length > 0;

  const run = async () => {
    const sent = signature;
    setBusy(true);
    let answer: TestAnswer | Refusal;
    try {
      answer = await apiClient.post<TestAnswer>('/api/instruments/modbus/test', body);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      answer = { refused: true, code: e.code, message: e.message ?? 'The test could not be run.' };
    }
    setBusy(false);
    // Answered for a form that has since changed: it describes nothing on screen.
    if (live.current !== sent) return;
    setResult({ signature: sent, answer });
    onJudgedRef.current(
      'ok' in answer && answer.ok
        ? Object.fromEntries(answer.values.map((v) => [v.key, v.judgedAs]))
        : {},
    );
  };

  const shown = result && result.signature === signature ? result.answer : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button" variant="secondary" onClick={run}
          disabled={!ready} loading={busy} loadingText="Testing…"
          icon={<PlugZap className="h-4 w-4" aria-hidden />}
        >
          Test connection
        </Button>
        <span className="text-xs text-slate-500">
          {ready
            ? 'Reads the device once — nothing is stored.'
            : 'Enter the IP address and port, and at least one key, to test.'}
        </span>
      </div>

      {shown && ('ok' in shown && shown.ok ? <Answered answer={shown} /> : <Failed answer={shown as Refusal | Extract<TestAnswer, { ok: false }>} />)}
    </div>
  );
}

function Answered({ answer }: { answer: Extract<TestAnswer, { ok: true }> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="status">
        <StatusBadge tone="ok" label="Connected" />
        <span className="text-sm text-slate-700">
          Connected in {answer.elapsedMs} ms · {answer.requests} read request{answer.requests === 1 ? '' : 's'}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Value read now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {answer.values.map((v) => (
            <TableRow key={v.key}>
              <TableCell className="font-medium text-slate-800">{v.key}</TableCell>
              <TableCell data-testid={`test-value-${v.key}`} className="tabular-nums">{String(v.value)}</TableCell>
            </TableRow>
          ))}
          {answer.rejected.map((r) => (
            <TableRow key={`rejected-${r.key}`} accent="danger">
              <TableCell className="font-medium text-slate-800">{r.key}</TableCell>
              <TableCell data-testid={`test-value-${r.key}`}>
                <span className="font-medium text-rose-700">Not readable</span>
                <span className="text-slate-600"> — {r.reason}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Failed({ answer }: { answer: Refusal | Extract<TestAnswer, { ok: false }> }) {
  const pill = (answer.code && PILL[answer.code]) || NOT_TESTED;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-3 rounded-[var(--radius-card)] border border-slate-200 bg-slate-50 px-4 py-3"
    >
      <span data-testid="test-pill"><StatusBadge tone={pill.tone} label={pill.word} /></span>
      <p className="min-w-0 flex-1 text-sm text-slate-800">{answer.message}</p>
    </div>
  );
}
