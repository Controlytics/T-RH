import { useEffect, useRef, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { modbusRegisterMapSchema, type ModbusRegisterMap } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  isAnswered, pillFor, runModbusTest, targetProblem, testBody,
  type Failure, type JudgedAs, type TestAnswer, type TestOutcome,
} from './modbus-test';

/**
 * Test connection (spec §8): read the device ONCE with this form's address,
 * Slave ID and register map, store nothing, and show every key's value — or
 * why it could not. A wrong byte order does not fail, it reads a believable
 * wrong number, which is what this exists to show before anything is saved.
 *
 * Nothing is decided here. The values, the failure sentence and which key is
 * judged (`judgedAs`, handed up through `onJudged` for the map's Judged as
 * column) are the response's. A result describes the address and map it was
 * read with: when any of them changes it is dropped, and the judgement with it,
 * so values read with one map never sit beside another.
 *
 * The request, the answer's shape and the failure words are `./modbus-test`'s,
 * shared with the register map's per-key Test (CR-1). A map the shared schema
 * refuses (a row whose data type was cleared by its Quantity) is not sent.
 *
 * Shared by New Instrument and the instrument page; `instrumentId` names a
 * stored instrument so its own address is not reported as in use.
 */
export function TestConnectionPanel({
  profileId, host, port, unitId, map, instrumentId, onJudged,
}: {
  profileId: string;
  host: string;
  port: number;
  /** The Slave ID, sent as `modbusUnitId` (CR-1: each instrument's own). */
  unitId: number;
  map: ModbusRegisterMap;
  instrumentId?: string;
  onJudged: (judged: Record<string, JudgedAs>) => void;
}) {
  const body = testBody({ profileId, host, port, unitId, instrumentId }, map);
  /** The request, serialised: what a result was read WITH. */
  const signature = JSON.stringify(body);
  const [result, setResult] = useState<{ signature: string; answer: TestOutcome } | null>(null);
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

  const problem = targetProblem({ host, port, unitId })
    ?? (map.length === 0 ? 'Add at least one key to test.' : null)
    ?? (modbusRegisterMapSchema.safeParse(map).success ? null : 'Fix the register map rows marked, to test.');
  const ready = problem === null;

  const run = async () => {
    const sent = signature;
    setBusy(true);
    const answer = await runModbusTest(body);
    setBusy(false);
    // Answered for a form that has since changed: it describes nothing on screen.
    if (live.current !== sent) return;
    setResult({ signature: sent, answer });
    onJudgedRef.current(
      isAnswered(answer) ? Object.fromEntries(answer.values.map((v) => [v.key, v.judgedAs])) : {},
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
          {ready ? 'Reads the device once — nothing is stored.' : problem}
        </span>
      </div>

      {shown && (isAnswered(shown) ? <Answered answer={shown} /> : <Failed answer={shown as Failure} />)}
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

function Failed({ answer }: { answer: Failure }) {
  const pill = pillFor(answer);
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
