import { useId, useState } from 'react';
import type { RuleNodeConfigField } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RuleScriptKind } from './types';

/**
 * A node's JavaScript (filter, switch, transform, generator, log, alarm
 * details) with ThingsBoard's **Test script** (rule chains, 2026-11-04; spec
 * section 6). The test runs on the SERVER — `POST /api/rule-chains/test-script`,
 * the engine's own time-boxed VM — against a sample message typed here; the
 * browser runs no script. The result is printed as the server returned it,
 * in the shape the node handler sees (a switch's names as an array, a
 * transform's outputs as an array).
 */

export interface TestScriptBody {
  scriptType: RuleScriptKind;
  script: string;
  msg: unknown;
  metadata: Record<string, string>;
  msgType: string;
}

const SAMPLE_MSG = '{\n  "temperature": 22.5,\n  "humidity": 45\n}';
const SAMPLE_METADATA = '{\n  "instrumentCode": "TEST-001",\n  "instrumentName": "Test instrument",\n  "ts": "1700000000000"\n}';

type Outcome = { kind: 'result'; value: unknown } | { kind: 'error'; code?: string; message: string } | null;

export function ScriptField({ field, value, onChange, readOnly, testScript }: {
  field: RuleNodeConfigField;
  value: string;
  onChange: (script: string) => void;
  readOnly?: boolean;
  testScript?: (body: TestScriptBody) => Promise<unknown>;
}) {
  const id = useId();
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState(SAMPLE_MSG);
  const [metadata, setMetadata] = useState(SAMPLE_METADATA);
  const [msgType, setMsgType] = useState('POST_TELEMETRY_REQUEST');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const run = async () => {
    let parsedMsg: unknown;
    let parsedMeta: unknown;
    try { parsedMsg = JSON.parse(msg); } catch { setOutcome({ kind: 'error', message: 'msg is not valid JSON.' }); return; }
    try { parsedMeta = JSON.parse(metadata); } catch { setOutcome({ kind: 'error', message: 'metadata is not valid JSON.' }); return; }
    if (typeof parsedMeta !== 'object' || parsedMeta === null || Array.isArray(parsedMeta)) {
      setOutcome({ kind: 'error', message: 'metadata must be a JSON object of strings.' });
      return;
    }
    // ThingsBoard's metadata values are strings; send them as such.
    const meta = Object.fromEntries(Object.entries(parsedMeta as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    if (!testScript) return;
    setRunning(true);
    setOutcome(null);
    try {
      const result = await testScript({ scriptType: field.scriptKind ?? 'filter', script: value, msg: parsedMsg, metadata: meta, msgType: msgType.trim() || 'POST_TELEMETRY_REQUEST' });
      setOutcome({ kind: 'result', value: result });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setOutcome({ kind: 'error', code: err?.code, message: err?.message || 'The script could not be run.' });
    } finally {
      setRunning(false);
    }
  };

  const area = 'ctl w-full font-mono text-[0.8125rem] leading-5';

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[0.8125rem] font-semibold text-slate-700">
        {field.label}{field.required && <span className="text-rose-600"> *</span>}
      </label>
      <textarea
        id={id}
        rows={8}
        spellCheck={false}
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className={`${area} min-h-[9rem] bg-slate-950 text-slate-100 disabled:bg-slate-800 disabled:text-slate-300`}
      />
      {field.help && <p className="text-[0.75rem] text-slate-500">{field.help} Available: msg, metadata, msgType.</p>}
      {!readOnly && testScript && (
        <div className="space-y-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setTesting((t) => !t)} aria-expanded={testing}>
            Test script
          </Button>
          {testing && (
            <div className="space-y-2 rounded-[var(--radius-control)] border border-slate-200 bg-slate-50 p-3">
              <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${id}-msg`} className="block text-[0.75rem] font-semibold text-slate-600">Test message (msg)</label>
                  <textarea id={`${id}-msg`} rows={5} spellCheck={false} value={msg} onChange={(e) => setMsg(e.target.value)} className={area} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-meta`} className="block text-[0.75rem] font-semibold text-slate-600">Test metadata</label>
                  <textarea id={`${id}-meta`} rows={5} spellCheck={false} value={metadata} onChange={(e) => setMetadata(e.target.value)} className={area} />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <label htmlFor={`${id}-type`} className="block text-[0.75rem] font-semibold text-slate-600">Test message type</label>
                  <Input id={`${id}-type`} value={msgType} onChange={(e) => setMsgType(e.target.value)} />
                </div>
                <Button type="button" onClick={() => { void run(); }} loading={running} loadingText="Running…">Run</Button>
              </div>
              {outcome?.kind === 'result' && (
                <div data-testid="script-result" className="rounded-[var(--radius-control)] border border-emerald-200 bg-emerald-50 p-2">
                  <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-emerald-800">Result</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.8125rem] text-emerald-950">
                    {JSON.stringify(outcome.value, null, 2) ?? 'undefined'}
                  </pre>
                </div>
              )}
              {outcome?.kind === 'error' && (
                <div data-testid="script-error" role="alert" className="rounded-[var(--radius-control)] border border-rose-200 bg-rose-50 p-2 text-[0.8125rem] text-rose-800">
                  {outcome.code && <span className="mr-2 font-mono font-semibold">{outcome.code}</span>}
                  <span className="whitespace-pre-wrap break-words">{outcome.message}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
