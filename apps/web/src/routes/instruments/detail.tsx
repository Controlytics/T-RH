import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { formatDecimals, TELEMETRY_DECIMALS_FALLBACK, ALL_RECORDS_PARAM } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { themeGradient } from '@/lib/theme-styles';
import { ConnectionInstructions } from './connection-instructions';
import { TokenDialog } from './token-dialog';
import { GatewayPanel } from './gateway-panel';
import { TokenPanel } from './token-panel';
import { AttributesPanel } from './attributes-panel';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/ui/page-header';

interface Instrument {
  id: string; name: string; code: string; isActive: boolean;
  instrumentType: string | null; manufacturer: string | null; model: string | null;
  serialNumber: string | null; description: string | null; expectedIntervalSec: number | null;
  tokenPrefix: string | null; lastSeenAt: string | null;
  /**
   * Whether `GET /:id/token` can actually return a value: the credential has
   * ciphertext AND the server has a usable INSTRUMENT_TOKEN_KEY. False for
   * anything issued before 2026-08-06. Says nothing about the value itself.
   */
  tokenRevealable: boolean;
  createdAt: string; createdBy: string | null;
  block: string | null; area: string | null; location: string | null;
  isGateway: boolean; gatewayId: string | null; lastSeenVia: string | null;
  profileId: string; profileName: string | null;
}
interface ChildInstrument { id: string; code: string; name: string; isActive: boolean }
interface Reading {
  key: string;
  value: unknown;
  valueType: string;
  ts: string;
  /** Which named slot the key maps to, resolved server-side. Null for a key that is
   *  neither temperature nor humidity. */
  slot?: 'temperature' | 'humidity' | null;
  /** This instrument's display precision for that slot. Null when there is no slot. */
  decimals?: number | null;
}

/**
 * A stored reading as text.
 *
 * A temperature or humidity is shown at the instrument's own precision so this
 * page agrees with the dashboard about the same number. Anything else keeps its
 * raw JSON — a battery level or a door contact has no declared precision, and
 * inventing one here would be this page asserting something nobody configured.
 */
function readingText(r: Reading): string {
  if (r.slot) {
    const text = formatDecimals(r.value, r.decimals ?? TELEMETRY_DECIMALS_FALLBACK);
    if (text !== null) return text;
  }
  return JSON.stringify(r.value);
}
interface DeadLetter { id: string; transport: string; reason: string; rawPayload: string | null; receivedAt: string }

export function InstrumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const reauth = useReauth();
  const can = useCan();
  const { user } = useAuth();
  /**
   * The Connection card is SUPER_ADMIN only (operator request, 2026-08-19).
   *
   * It is the device-wiring runbook — broker host, topic scheme, the paste-ready
   * publish command — and commissioning a device is a super-admin job here. Note
   * what this is and is not: the panel renders entirely from the API base URL and
   * shared constants, so hiding it removes the INSTRUCTIONS from the page, not the
   * endpoints. The credential itself is not protected by this — that is the token
   * panel's reveal, which costs a password and writes an audit row either way.
   */
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const { formatDate, formatTime } = useDatetimeFormat();

  const { data: inst, mutate } = useSWR<Instrument>(id ? `/api/instruments/${id}` : null);
  const { data: telemetry } = useSWR<{ latest: Reading[]; history: Reading[]; historyTotal: number }>(
    id ? `/api/instruments/${id}/telemetry?${ALL_RECORDS_PARAM}` : null,
    { refreshInterval: 15_000 },
  );
  const { data: dead } = useSWR<{ data: DeadLetter[]; total: number }>(
    id ? `/api/instruments/${id}/dead-letters?${ALL_RECORDS_PARAM}` : null,
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
  // The fallback window for an instrument that declares no expected interval.
  const { data: activityConfig } = useSWR<{ activeWindowMinutes?: number }>('/api/config/instrument-activity/current');
  // Offered so an instrument can be MOVED between profiles from the one page
  // that already owns every other edit to it.

  const activeWindow = activityConfig?.activeWindowMinutes ?? INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Instrument>>({});
  const [newToken, setNewToken] = useState<string | null>(null);
  /**
   * The revealed token. Route-local `useState` ON PURPOSE — it unmounts when
   * the operator navigates away, which IS the required re-hide. Putting it in
   * SWR would keep it in the cache across unmount and redisplay a live device
   * credential on return with no re-auth, which on a shared workstation is the
   * failure this whole feature invites. Do not "lift" it into a fetch hook.
   */
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  /**
   * Which action the one shared ReauthDialog is currently challenging for. It
   * used to be hardcoded to "Regenerate Instrument Token"; with reveal and set
   * sharing the dialog that label would be a lie two times out of three, and a
   * password prompt that misnames what it is authorising is worse than none.
   */
  const [reauthLabel, setReauthLabel] = useState('Instrument Token');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /**
   * ENABLE/DISABLE is its own action, not a checkbox buried in the edit form
   * (2026-08-07 request). Disabling stops the broker accepting this device's
   * data immediately, which is an operational act with a consequence — it
   * deserves its own confirm rather than riding along with a rename.
   */
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [toggling, setToggling] = useState(false);

  // The detail page resolves to an identity block over stacked panels.
  if (!inst) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 3 }, (_, i) => <SkeletonCard key={i} lines={3} />)}
      </div>
    );
  }

  const startEdit = () => { setDraft({ ...inst }); setEditing(true); };

  const save = async () => {
    try {
      // TWO fields (2026-09-16, operator: "user can edit Instrument ID &
      // Profile Type and is gateway selection i dont need other options", then
      // "remove profile change option in instrument page"). Only those travel:
      // an omitted field leaves the stored value alone, so this form cannot
      // blank a description or an interval nobody typed, and cannot move the
      // profile. The code goes only when it changed — it is the MQTT client
      // id, and the server moves the broker slots; the device must reconnect
      // with the new id (name follows the code when it was the code).
      const newCode = (draft.code ?? inst.code).trim();
      await apiClient.put(`/api/instruments/${inst.id}`, {
        ...(newCode && newCode !== inst.code ? { code: newCode } : {}),
        isGateway: draft.isGateway ?? false,
      });
      setEditing(false);
      void mutate();
      toast.success('Instrument updated', newCode !== inst.code
        ? `Instrument ID is now ${newCode}. Reconnect the device with the new ID.`
        : `"${inst.code}" saved.`);
    } catch (err: unknown) {
      // D6: disabling Is Gateway while children remain is refused with a 409
      // whose message already names the children — surface it verbatim rather
      // than writing a generic one, it carries the detail the operator needs.
      toast.error('Update failed', (err as { message?: string })?.message ?? 'Could not save.');
    }
  };

  /**
   * All three token actions go through `reauth.execute()`, and none of them is
   * listed in `REAUTH_ACTIONS` any more — they use `enforceReauthAlways`
   * server-side, so there is no per-role policy for `my-actions` to report.
   * That means `needsReauth()` is always false here and the dialog does NOT
   * pre-open: the first attempt goes out with no password, the backend answers
   * 401 `REAUTH_REQUIRED`, and `execute` opens the dialog retroactively and
   * replays the call with the password. That retroactive path already exists
   * for stale-SWR cases and is tested; reusing it keeps one code path for every
   * gated action on the page instead of a bespoke prompt for these three.
   *
   * The cost is one wasted round trip per action. Accepted: the alternative is
   * a second prompt implementation that would drift from the shared one.
   */
  const regenerate = async () => {
    setReauthLabel('Regenerate Instrument Token');
    await reauth.execute('REGENERATE_INSTRUMENT_TOKEN', async (password?: string) => {
      const res = password
        ? await apiClient.postWithReauth<{ token: string }>(`/api/instruments/${inst.id}/regenerate-token`, {}, password)
        : await apiClient.post<{ token: string }>(`/api/instruments/${inst.id}/regenerate-token`, {});
      // The old value is dead — clear it so the connection panel cannot keep
      // showing a revoked credential in a command a technician might paste.
      setRevealedToken(null);
      setNewToken(res.token);
      void mutate();
    }, {
      onError: (err: unknown) =>
        toast.error('Regeneration failed', (err as { message?: string })?.message ?? 'Could not regenerate the token.'),
    });
  };

  const revealToken = async () => {
    setReauthLabel('Reveal Instrument Token');
    await reauth.execute('REVEAL_INSTRUMENT_TOKEN', async (password?: string) => {
      const res = password
        ? await apiClient.getWithReauth<{ token: string }>(`/api/instruments/${inst.id}/token`, password)
        : await apiClient.get<{ token: string }>(`/api/instruments/${inst.id}/token`);
      setRevealedToken(res.token);
    }, {
      // The backend distinguishes TOKEN_NOT_RECOVERABLE / TOKEN_KEY_MISSING /
      // TOKEN_DECRYPT_FAILED because each has a different remedy, and its
      // messages say which. Surface them verbatim rather than flattening all
      // three into "could not reveal".
      onError: (err: unknown) =>
        toast.error('Could not reveal the token', (err as { message?: string })?.message ?? 'The token could not be shown.'),
    });
  };

  const setToken = async (token: string) => {
    setReauthLabel('Set Instrument Token');
    await reauth.execute('SET_INSTRUMENT_TOKEN', async (password?: string) => {
      if (password) await apiClient.putWithReauth(`/api/instruments/${inst.id}/token`, { token }, password);
      else await apiClient.put(`/api/instruments/${inst.id}/token`, { token });
      // The response returns only the prefix — the value is never echoed. Show
      // the one the operator just typed: they already know it, and it is what
      // the connection command below has to carry to be runnable.
      setRevealedToken(token);
      void mutate();
      toast.success('Token replaced', `${inst.code} must be reconfigured with the new token.`);
    }, {
      onError: (err: unknown) =>
        toast.error('Could not set the token', (err as { message?: string })?.message ?? 'The token was not changed.'),
    });
  };

  const remove = async () => {
    // `deleting` is new with the confirm dialog (2026-08-06). The old
    // `window.confirm` path had no in-flight guard at all: the button stayed
    // live during the request, so a double click sent a second DELETE and the
    // operator got a spurious 404 toast for a row that had just been removed.
    setDeleting(true);
    try {
      await apiClient.delete(`/api/instruments/${inst.id}`);
      toast.success('Instrument deleted', `"${inst.code}" removed.`);
      // No `setDeleting(false)` / dialog close on success — we navigate away,
      // and this component unmounts.
      navigate('/instruments');
    } catch (err: unknown) {
      setConfirmDelete(false);
      setDeleting(false);
      toast.error('Delete failed', (err as { message?: string })?.message ?? 'Could not delete.');
    }
  };

  const toggleEnabled = async () => {
    setToggling(true);
    try {
      await apiClient.put(`/api/instruments/${inst.id}`, { isActive: !inst.isActive });
      setConfirmToggle(false);
      void mutate();
      toast.success(
        inst.isActive ? 'Instrument disabled' : 'Instrument enabled',
        inst.isActive
          ? `${inst.code} will no longer be accepted by the broker.`
          : `${inst.code} may report again.`,
      );
    } catch (err: unknown) {
      setConfirmToggle(false);
      toast.error('Could not change this instrument', (err as { message?: string })?.message ?? 'Nothing was changed.');
    } finally {
      setToggling(false);
    }
  };

  const stamp = (v: string | null) => (v ? `${formatDate(v)} ${formatTime(v)}` : '—');

  /**
   * A section heading with an icon chip. The chips are tinted per section
   * rather than all brand-coloured, so the page reads as four distinct
   * concerns — what it is, how to reach it, what its credential is, what it has
   * said — instead of one long scroll of identical white cards.
   */
  const sectionIcon = (tint: string, path: string) => (
    <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${tint}`}>
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
      </svg>
    </span>
  );
  const ICON = {
    details: 'M4 6h16M4 12h16M4 18h7',
    connection: 'M13 10V3L4 14h7v7l9-11h-7z',
    token: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z',
    readings: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  };

  const reporting = isInstrumentReporting(inst.lastSeenAt, inst.expectedIntervalSec, activeWindow);

  return (
    <div className="space-y-6">
      {/* The profile is deliberately NOT a crumb: the hero already links to it
          ('in {profileName}'), and two identical links an inch apart is one
          more than the page needs. The trail answers 'how do I get back out',
          which is Instruments. */}
      <Breadcrumbs
        crumbs={[
          { label: 'Home', to: '/' },
          { label: 'Instruments', to: '/instruments' },
          { label: inst.code },
        ]}
      />
      {/* The hero leads with the CODE, not the name: the code is what the device
          authenticates as, what its topics are built from, and what a
          technician is holding on a label. The name is for people; the code is
          the identity everything else on this page is keyed to. */}
      <div className="relative overflow-hidden rounded-[var(--radius-card)] p-6 text-white shadow-[var(--elev-2)]" style={themeGradient}>
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.2em] text-white/70">Instrument ID</p>
              {inst.isGateway && (
                <span className="rounded-md border border-white/40 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide">
                  Gateway
                </span>
              )}
              {gatewayInst && (
                <Link
                  to={`/instruments/${gatewayInst.id}`}
                  className="rounded-md border border-white/40 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide hover:bg-white/10"
                >
                  Child of {gatewayInst.code}
                </Link>
              )}
            </div>
            <h1 className="mt-0.5 truncate font-mono text-2xl font-bold tracking-tight">{inst.code}</h1>
            {inst.profileName && (
              <Link
                to={`/instruments/profiles/${inst.profileId}`}
                className="mt-1 inline-block text-xs text-white/70 hover:text-white"
              >
                in {inst.profileName}
              </Link>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* OBSERVED: is telemetry arriving? */}
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  reporting ? 'bg-emerald-50 text-emerald-700' : 'bg-white/15 text-white ring-1 ring-white/30'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${reporting ? 'bg-emerald-500' : 'bg-white/60'}`} />
                {reporting ? 'Active' : 'Inactive'}
              </span>
              {/* DECLARED: has an operator switched it off? A different fact. */}
              {!inst.isActive && (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                  Disabled — not accepting data
                </span>
              )}
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/80 ring-1 ring-white/20">
                {inst.expectedIntervalSec
                  ? `Expected every ${inst.expectedIntervalSec}s`
                  : `Inactive after ${activeWindow} min without data`}
              </span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/80 ring-1 ring-white/20">
                Last seen {stamp(inst.lastSeenAt)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/instruments">
              <Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Back</Button>
            </Link>
            {can('instruments.edit') && (
              <Button
                className="border border-white/30 bg-white/10 text-white hover:bg-white/20"
                disabled={toggling}
                onClick={() => setConfirmToggle(true)}
              >
                {inst.isActive ? 'Disable' : 'Enable'}
              </Button>
            )}
            {can('instruments.delete') && (
              <Button variant="destructive" disabled={deleting} onClick={() => setConfirmDelete(true)}>Delete</Button>
            )}
          </div>
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute -right-2 bottom-0 flex items-end gap-1.5 opacity-15">
          {[18, 34, 52, 74].map((h) => (
            <span key={h} className="w-3 rounded-t bg-white" style={{ height: h }} />
          ))}
        </div>
      </div>

      {/* Two columns that do NOT stretch (2026-09-16, operator: "details
          section taking so much empty space, dont show empty page, remove the
          gap and adjust below cards in that empty space"). The Attributes
          panel lists thirty rows on this install while Details has four, and
          a stretched grid row painted the difference as blank card. The
          cards that used to sit BELOW the grid now stack under Details in
          this column; the Gateway panel stays full width after it, since a
          gateway's child roster is a wide table. */}
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="space-y-6">
        <Card data-testid="details-card">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">{sectionIcon('bg-slate-100 text-slate-600', ICON.details)}Details</CardTitle>
            {can('instruments.edit') && !editing && (
              <Button size="sm" variant="secondary" onClick={startEdit}>Edit</Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {!editing ? (
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                {/* Trimmed 2026-08-07 and again 2026-09-16 (operator: no
                    Block / Area / Location / Description / expected interval
                    here). The free-text placement COLUMNS are superseded — the
                    functional location and the Location ATTRIBUTE are the
                    facts now, and both print on the Attributes panel below.
                    Everything removed is still stored; nothing here edits it. */}
                <dt className="text-slate-500">Instrument ID</dt>
                <dd className="font-mono font-medium text-slate-800">{inst.code}</dd>
                <dt className="text-slate-500">Profile</dt>
                <dd>{inst.profileName || '—'}</dd>
                <dt className="text-slate-500">Gateway</dt>
                <dd>{inst.isGateway ? 'Yes — reports for its linked instruments' : gatewayInst ? `Child of ${gatewayInst.code}` : 'No'}</dd>
                <dt className="text-slate-500">Created</dt>
                <dd>{stamp(inst.createdAt)}{inst.createdBy ? ` by ${inst.createdBy}` : ''}</dd>
              </dl>
            ) : (
              <div className="space-y-3">
                {/* TWO fields (2026-09-16, operator). The Active switch left
                    this form too: Enable / Disable is its own confirmed action
                    on this page (2026-08-07), and a second, unconfirmed copy of
                    it inside an edit form was a duplicate with a weaker
                    control. The Profile select left the same day ("remove
                    profile change option in instrument page"): the profile is
                    shown in the read view and changes nowhere on this page. */}
                {/* The profile, read-only, so the operator knows which list of
                    attributes this instrument answers to while editing it. */}
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="text-slate-600">Profile</span>
                  <span className="font-medium text-slate-800">{inst.profileName || '—'}</span>
                </div>
                <label className="block space-y-1">
                  <span className="text-sm text-slate-600">Instrument ID</span>
                  <Input
                    value={draft.code ?? inst.code}
                    autoComplete="off"
                    aria-label="Instrument ID"
                    className="font-mono"
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={draft.isGateway ?? false}
                    onChange={(e) => setDraft({ ...draft, isGateway: e.target.checked })}
                  className="ctl-check" />
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
        <CardHeader><CardTitle className="flex items-center gap-2">{sectionIcon('bg-amber-100 text-amber-600', ICON.token)}Access token</CardTitle></CardHeader>
        <CardContent>
          <TokenPanel
            code={inst.code}
            tokenPrefix={inst.tokenPrefix}
            tokenRevealable={inst.tokenRevealable}
            canEdit={can('instruments.edit')}
            token={revealedToken}
            onHide={() => setRevealedToken(null)}
            onReveal={revealToken}
            onSetToken={setToken}
            onRegenerate={regenerate}
          />
        </CardContent>
      </Card>

      {isSuperAdmin && (
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">{sectionIcon('bg-sky-100 text-sky-600', ICON.connection)}Connection</CardTitle></CardHeader>
        <CardContent>
          {/* The revealed value flows all the way through: the labelled
              Token / Username rows AND the paste-ready command. A command
              showing <ACCESS_TOKEN> when the operator has just unmasked the
              real one is worse than showing none — it looks runnable. */}
          <ConnectionInstructions
            code={inst.code}
            token={revealedToken ?? undefined}
            isGateway={inst.isGateway}
            childCodes={children?.data.map((c) => c.code)}
            gatewayCode={gatewayInst?.code}
          />
          {!revealedToken && (
            <p className="mt-3 text-xs text-slate-500">
              <span className="font-mono">&lt;ACCESS_TOKEN&gt;</span> above is a
              placeholder. Show the token above to fill it in.
            </p>
          )}
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">{sectionIcon('bg-emerald-100 text-emerald-600', ICON.readings)}Latest readings</CardTitle></CardHeader>
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
                    <TableCell>{readingText(r)}</TableCell>
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
        </div>

        <AttributesPanel instrumentId={inst.id} profileId={inst.profileId} canEdit={can('instruments.edit')} />
      </div>

      {inst.isGateway && <GatewayPanel instrumentId={inst.id} canEdit={can('instruments.edit')} />}

      {newToken && (
        <TokenDialog
          open
          title="New access token issued"
          code={inst.code}
          token={newToken}
          onClose={() => setNewToken(null)}
        />
      )}

      <ConfirmDialog
        open={confirmToggle}
        title={inst.isActive ? 'Disable instrument' : 'Enable instrument'}
        message={
          inst.isActive
            ? <>Stop accepting data from <span className="font-semibold text-red-700">{inst.code}</span>?</>
            : <>Allow <span className="font-semibold text-red-700">{inst.code}</span> to report again?</>
        }
        warning={inst.isActive ? 'The broker refuses this device\u2019s telemetry from the moment this is saved. Readings it sends while disabled are lost, not queued.' : undefined}
        confirmLabel={inst.isActive ? 'Disable instrument' : 'Enable instrument'}
        busyLabel={inst.isActive ? 'Disabling…' : 'Enabling…'}
        busy={toggling}
        onConfirm={() => void toggleEnabled()}
        onClose={() => setConfirmToggle(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete instrument"
        message={<>Delete <span className="font-semibold text-red-700">{inst.code}</span>?</>}
        warning="Its credentials are removed and the device stops being able to send data. Telemetry already recorded is kept."
        confirmLabel="Delete instrument"
        busyLabel="Deleting…"
        busy={deleting}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel={reauthLabel}
      />
    </div>
  );
}
