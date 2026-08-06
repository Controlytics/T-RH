import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ConnectionInstructions } from './connection-instructions';
import { TokenDialog } from './token-dialog';
import { GatewayPanel } from './gateway-panel';

interface Instrument {
  id: string; name: string; code: string; isActive: boolean;
  instrumentType: string | null; manufacturer: string | null; model: string | null;
  serialNumber: string | null; description: string | null; expectedIntervalSec: number | null;
  tokenPrefix: string | null; lastSeenAt: string | null;
  createdAt: string; createdBy: string | null;
  block: string | null; area: string | null; location: string | null;
  isGateway: boolean; gatewayId: string | null; lastSeenVia: string | null;
}
interface ChildInstrument { id: string; code: string; name: string; isActive: boolean }
interface Reading { key: string; value: unknown; valueType: string; ts: string }
interface DeadLetter { id: string; transport: string; reason: string; rawPayload: string | null; receivedAt: string }

export function InstrumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const reauth = useReauth();
  const can = useCan();
  const { formatDate, formatTime } = useDatetimeFormat();

  const { data: inst, mutate } = useSWR<Instrument>(id ? `/api/instruments/${id}` : null);
  const { data: telemetry } = useSWR<{ latest: Reading[]; history: Reading[]; historyTotal: number }>(
    id ? `/api/instruments/${id}/telemetry?limit=50` : null,
    { refreshInterval: 15_000 },
  );
  const { data: dead } = useSWR<{ data: DeadLetter[]; total: number }>(
    id ? `/api/instruments/${id}/dead-letters?limit=20` : null,
  );
  // Same key GatewayPanel uses below — SWR dedupes, so this doesn't double the
  // request. Needed here too because the batch payload shown in the Connection
  // card above the panel has to reflect the real linked children.
  const { data: children } = useSWR<{ data: ChildInstrument[] }>(
    id ? `/api/instruments/${id}/children` : null,
  );
  // A child instrument shows which gateway (if any) also reports it. The
  // instrument record only carries `gatewayId`, so the parent's code needs
  // its own lookup.
  const { data: gatewayInst } = useSWR<Instrument>(
    id && inst?.gatewayId ? `/api/instruments/${inst.gatewayId}` : null,
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Instrument>>({});
  const [newToken, setNewToken] = useState<string | null>(null);

  if (!inst) return <div className="py-10 text-center text-slate-400">Loading…</div>;

  const startEdit = () => { setDraft({ ...inst }); setEditing(true); };

  const save = async () => {
    try {
      // `code` is intentionally absent: it is immutable server-side (it is baked
      // into the MQTT topic and the device's own configuration).
      await apiClient.put(`/api/instruments/${inst.id}`, {
        name: draft.name, isActive: draft.isActive,
        instrumentType: draft.instrumentType || null, manufacturer: draft.manufacturer || null,
        model: draft.model || null, serialNumber: draft.serialNumber || null,
        description: draft.description || null,
        expectedIntervalSec: draft.expectedIntervalSec ? Number(draft.expectedIntervalSec) : null,
        block: draft.block || null, area: draft.area || null, location: draft.location || null,
        isGateway: draft.isGateway ?? false,
      });
      setEditing(false);
      void mutate();
      toast.success('Instrument updated', `"${inst.code}" saved.`);
    } catch (err: unknown) {
      // D6: disabling Is Gateway while children remain is refused with a 409
      // whose message already names the children — surface it verbatim rather
      // than writing a generic one, it carries the detail the operator needs.
      toast.error('Update failed', (err as { message?: string })?.message ?? 'Could not save.');
    }
  };

  const regenerate = async () => {
    await reauth.execute('REGENERATE_INSTRUMENT_TOKEN', async (password?: string) => {
      const res = password
        ? await apiClient.postWithReauth<{ token: string }>(`/api/instruments/${inst.id}/regenerate-token`, {}, password)
        : await apiClient.post<{ token: string }>(`/api/instruments/${inst.id}/regenerate-token`, {});
      setNewToken(res.token);
      void mutate();
    }, {
      onError: (err: unknown) =>
        toast.error('Regeneration failed', (err as { message?: string })?.message ?? 'Could not regenerate the token.'),
    });
  };

  const remove = async () => {
    if (!window.confirm(`Delete instrument "${inst.code}"? Its credentials are removed and the device stops being able to send data. Telemetry already recorded is kept.`)) return;
    try {
      await apiClient.delete(`/api/instruments/${inst.id}`);
      toast.success('Instrument deleted', `"${inst.code}" removed.`);
      navigate('/instruments');
    } catch (err: unknown) {
      toast.error('Delete failed', (err as { message?: string })?.message ?? 'Could not delete.');
    }
  };

  const stamp = (v: string | null) => (v ? `${formatDate(v)} ${formatTime(v)}` : '—');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900">{inst.name}</h1>
            <Badge variant={inst.isActive ? 'success' : 'secondary'}>{inst.isActive ? 'Active' : 'Inactive'}</Badge>
            {inst.isGateway && <Badge variant="outline">Gateway</Badge>}
          </div>
          <p className="font-mono text-sm text-slate-500">{inst.code}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/instruments"><Button variant="secondary">Back</Button></Link>
          {can('instruments.edit') && !editing && <Button variant="secondary" onClick={startEdit}>Edit</Button>}
          {can('instruments.edit') && <Button variant="secondary" onClick={regenerate}>Regenerate token</Button>}
          {can('instruments.delete') && <Button variant="destructive" onClick={remove}>Delete</Button>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!editing ? (
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Type</dt><dd>{inst.instrumentType || '—'}</dd>
                <dt className="text-slate-500">Manufacturer</dt><dd>{inst.manufacturer || '—'}</dd>
                <dt className="text-slate-500">Model</dt><dd>{inst.model || '—'}</dd>
                <dt className="text-slate-500">Serial</dt><dd>{inst.serialNumber || '—'}</dd>
                <dt className="text-slate-500">Expected interval</dt>
                <dd>{inst.expectedIntervalSec ? `${inst.expectedIntervalSec}s` : 'Exempt'}</dd>
                <dt className="text-slate-500">Token prefix</dt>
                <dd className="font-mono text-xs">{inst.tokenPrefix ? `${inst.tokenPrefix}…` : '—'}</dd>
                <dt className="text-slate-500">Last seen</dt>
                <dd>
                  {stamp(inst.lastSeenAt)}
                  {inst.lastSeenVia === 'gateway' && <span className="ml-1 text-xs text-slate-400">(via gateway)</span>}
                </dd>
                <dt className="text-slate-500">Created</dt>
                <dd>{stamp(inst.createdAt)}{inst.createdBy ? ` by ${inst.createdBy}` : ''}</dd>
                <dt className="text-slate-500">Description</dt><dd>{inst.description || '—'}</dd>
                <dt className="text-slate-500">Block</dt><dd>{inst.block || '—'}</dd>
                <dt className="text-slate-500">Area</dt><dd>{inst.area || '—'}</dd>
                <dt className="text-slate-500">Location</dt><dd>{inst.location || '—'}</dd>
              </dl>
            ) : (
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className="text-sm text-slate-600">Name</span>
                  <Input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={draft.isActive ?? false}
                    onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                  />
                  Active — unchecking stops this device&apos;s data being accepted immediately
                </label>
                <label className="block space-y-1">
                  <span className="text-sm text-slate-600">Expected interval (seconds)</span>
                  <Input
                    type="number" min={1}
                    value={draft.expectedIntervalSec ?? ''}
                    onChange={(e) => setDraft({ ...draft, expectedIntervalSec: e.target.value ? Number(e.target.value) : null })}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm text-slate-600">Description</span>
                  <Input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block space-y-1">
                    <span className="text-sm text-slate-600">Block</span>
                    <Input value={draft.block ?? ''} onChange={(e) => setDraft({ ...draft, block: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-slate-600">Area</span>
                    <Input value={draft.area ?? ''} onChange={(e) => setDraft({ ...draft, area: e.target.value })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-slate-600">Location</span>
                    <Input value={draft.location ?? ''} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={draft.isGateway ?? false}
                    onChange={(e) => setDraft({ ...draft, isGateway: e.target.checked })}
                  />
                  Is Gateway — reports telemetry on behalf of the instruments linked to it
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button onClick={save}>Save</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
          <CardContent>
            <ConnectionInstructions
              code={inst.code}
              isGateway={inst.isGateway}
              childCodes={children?.data.map((c) => c.code)}
              gatewayCode={gatewayInst?.code}
            />
            <p className="mt-3 text-xs text-slate-500">
              The token is not shown here — it is stored hashed. Use
              &ldquo;Regenerate token&rdquo; to issue a new one, which revokes the current one.
            </p>
          </CardContent>
        </Card>
      </div>

      {inst.isGateway && <GatewayPanel instrumentId={inst.id} canEdit={can('instruments.edit')} />}

      <Card>
        <CardHeader><CardTitle>Latest readings</CardTitle></CardHeader>
        <CardContent>
          {!telemetry?.latest?.length ? (
            <p className="text-sm text-slate-500">No telemetry received yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Key</TableHead><TableHead>Value</TableHead><TableHead>Type</TableHead><TableHead>Timestamp</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {telemetry.latest.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono text-xs">{r.key}</TableCell>
                    <TableCell>{JSON.stringify(r.value)}</TableCell>
                    <TableCell className="text-xs text-slate-500">{r.valueType}</TableCell>
                    <TableCell className="text-sm">{stamp(r.ts)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rejected payloads ({dead?.total ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {/* The answer to "the device says it is sending but nothing appears" */}
          {!dead?.data?.length ? (
            <p className="text-sm text-slate-500">Nothing rejected — every payload this device sent was accepted.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>When</TableHead><TableHead>Transport</TableHead><TableHead>Reason</TableHead><TableHead>Payload</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {dead.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-sm">{stamp(d.receivedAt)}</TableCell>
                    <TableCell className="text-xs">{d.transport}</TableCell>
                    <TableCell className="text-sm text-red-700">{d.reason}</TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-xs text-slate-500">{d.rawPayload ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {newToken && (
        <TokenDialog
          open
          title="New access token issued"
          code={inst.code}
          token={newToken}
          onClose={() => setNewToken(null)}
        />
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Regenerate Instrument Token"
      />
    </div>
  );
}
