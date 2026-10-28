import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { parseInstrumentAttributeKeys } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LocationPicker, NO_PLACEMENT, placedLocationId, usePlacementTree, type Placement } from './location-picker';
import { BulkReviewDialog, FromValue, type BulkPreview, type PlannedUpdate } from './bulk-review-dialog';

interface CreatedRow { id: string; code: string; name: string; token: string }
/** `column` is the heading as the file spells it; absent for a whole-row fault. */
interface ErrorRow { row: number; column?: string; message: string }
// `warnings` are whole-file advisories (a retired column that was ignored) —
// they fail nothing, so they are rendered apart from the rejected-row table.
// Optional so an older API build that omits the field still renders.
// `updated` / `unchanged` since 2026-10-28: an existing Instrument ID is
// updated with the cells that differ. Optional, like `warnings`.
interface BulkResult {
  created: CreatedRow[];
  updated?: PlannedUpdate[];
  unchanged?: { row: number; code: string }[];
  errors: ErrorRow[];
  warnings?: string[];
}

/** "2 created, 1 updated, 3 rejected" — a part that is zero is left out, except the two that always say something. */
function summary(res: BulkResult): string {
  const updated = res.updated?.length ?? 0;
  const unchanged = res.unchanged?.length ?? 0;
  return [
    `${res.created.length} created`,
    ...(updated ? [`${updated} updated`] : []),
    ...(unchanged ? [`${unchanged} unchanged`] : []),
    `${res.errors.length} rejected`,
  ].join(', ');
}

/**
 * The template is built per PROFILE (2026-09-16, operator: "in bulk upload
 * template only attributes display names should come"): `code`, then one
 * column per attribute the profile asks for, headed by its administered
 * DISPLAY NAME (the key itself where none is set), after an `Instrument ID`
 * column. No `name` column — the
 * create form has set name = code since the 2026-08-07 trim and the importer
 * now does the same. The importer maps each heading back to the KEY, so a file
 * headed by keys (an older template) still imports.
 */
const INSTRUMENT_ID_HEADING = 'Instrument ID';

function buildTemplate(attributeKeys: string[], labelFor: (key: string) => string): string {
  // Headed as the create form labels it (operator, 2026-09-16); the importer
  // reads `Instrument ID` and `code` alike. The heading ONLY (2026-10-28): the
  // sample row named CWH/RDU/001-00, a REAL instrument, so an untouched
  // template failed every upload ("already exists") — and now that an existing
  // ID is updated, a value typed into it would change that instrument.
  const header = [INSTRUMENT_ID_HEADING, ...attributeKeys.map(labelFor)];
  return `${header.join(',')}\n`;
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function InstrumentBulkCreatePage() {
  const { toast } = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  /**
   * ONE popup for every way an upload can go wrong (2026-09-16, operator: "if
   * upload failed then show a popup where it failed and reason, in which line
   * which cell like that"): rejected rows — row, cell, reason — the file-level
   * notes, and a request that failed outright with its message. Opens itself
   * on a bad result; the summary card underneath reopens it.
   */
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The preview, while it is on screen for review — only a file that changes existing instruments stops here. */
  const [review, setReview] = useState<BulkPreview | null>(null);
  const reauth = useReauth();

  // ONE profile for the whole upload — deliberately not a CSV column, so the
  // template and any file an operator already has on disk are unchanged.
  const [searchParams] = useSearchParams();
  const presetProfileId = searchParams.get('profileId');
  const { data: profiles } = useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles');
  const [profileId, setProfileId] = useState(presetProfileId ?? '');
  const presetProfileName = profiles?.data?.find((p) => p.id === presetProfileId)?.name;
  // The chosen profile's own key list — the template's columns depend on it.
  const { data: profile } = useSWR<{ attributeKeys: string | null }>(
    profileId ? `/api/instrument-profiles/${profileId}` : null,
  );
  const { labelFor } = useAttributeLabels();
  const templateKeys = parseInstrumentAttributeKeys(profile?.attributeKeys);
  // ONE functional location for the whole upload too (2026-10-26) — required
  // when the server says the caller's instrument view is limited, or every
  // instrument in the file would be created out of the uploader's own sight.
  const placementTree = usePlacementTree();
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const functionalLocationId = placedLocationId(placementTree.tree, placement);
  const placementMissing = placementTree.required && !functionalLocationId;
  const body = () => ({ csv, profileId, ...(functionalLocationId ? { functionalLocationId } : {}) });

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const failed = (err: unknown) => {
    setFailure((err as { message?: string })?.message ?? 'Could not process the CSV.');
    setProblemsOpen(true);
    setUploading(false);
  };

  // PREVIEWED first (2026-10-28): the server plans the file — which rows
  // create, which update and what each change replaces — and writes nothing.
  // A file that only creates goes straight on; one that changes an existing
  // instrument stops at the review dialog. Not signed: nothing is written.
  const upload = async () => {
    if (!csv.trim()) return;
    setUploading(true);
    let plan: BulkPreview;
    try {
      plan = await apiClient.post<BulkPreview>('/api/instruments/bulk/preview', body());
    } catch (err) {
      failed(err);
      return;
    }
    if ((plan.update?.length ?? 0) > 0) {
      setReview(plan);
      return;
    }
    await commit();
  };

  // Signed under CREATE_INSTRUMENT like the single form (audit 2026-10-03,
  // SEC-7): a bulk upload is N creates, and the route challenges it the same
  // way. The callback is idempotent — the re-auth hook REPLAYS it after a 401,
  // and a second POST of the same CSV would report every created row as
  // unchanged. The server plans the file again here; nothing from the preview
  // is sent but the remark.
  const commit = async (reason?: string) => {
    setUploading(true);
    const payload = { ...body(), ...(reason ? { reason } : {}) };
    let res: BulkResult | null = null;
    await reauth.execute('CREATE_INSTRUMENT', async (password?: string) => {
      if (res) return;
      res = password
        ? await apiClient.postWithReauth<BulkResult>('/api/instruments/bulk', payload, password)
        : await apiClient.post<BulkResult>('/api/instruments/bulk', payload);
    }, {
      onSuccess: () => {
        if (!res) return;
        setResult(res);
        setFailure(null);
        const problems = res.errors.length > 0 || (res.warnings?.length ?? 0) > 0;
        setProblemsOpen(problems);
        const changed = res.created.length + (res.updated?.length ?? 0);
        if (changed > 0) {
          toast.success('Upload complete', `${summary(res)}.`);
        } else if (res.errors.length === 0) {
          toast.success('Nothing to change', 'Every row already matches.');
        } else {
          toast.error('Nothing changed', `${summary(res)}.`);
        }
        setUploading(false);
      },
      onError: failed,
      onCancel: () => setUploading(false),
    });
  };

  const downloadResults = () => {
    const lines = ['name,code,token', ...result!.created.map((c) => `${c.name},${c.code},${c.token}`)];
    download('instrument-tokens.csv', lines.join('\n'));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* "Back to list" is gone: the Instruments breadcrumb goes to the same place. */}
      <PageHeader
        title="Bulk Upload Instruments"
        description="New Instrument IDs are created and existing ones get the values that changed — one typo does not reject the file."
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }, { label: 'Bulk Upload' }]}
      />

      <Card>
        <CardHeader><CardTitle>1. Choose the profile and location</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {presetProfileId ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="text-xs text-slate-500">Profile</span>
              <p className="text-sm font-medium text-slate-800">{presetProfileName ?? '…'}</p>
            </div>
          ) : (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Profile *</span>
              <select
                value={profileId} onChange={(e) => setProfileId(e.target.value)}
                className="ctl w-full"
              >
                <option value="">Select a profile…</option>
                {profiles?.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <LocationPicker
            tree={placementTree.tree}
            required={placementTree.required}
            value={placement}
            onChange={setPlacement}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Download the template</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            Columns: Instrument ID, then the attributes of the profile chosen above. A blank cell changes nothing.
          </p>
          <Button
            variant="secondary"
            disabled={!profileId || !profile}
            onClick={() => download('instrument-template.csv', buildTemplate(templateKeys, labelFor))}
          >
            Download template
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>3. Upload</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {/* The one file input in the product that is actually VISIBLE — the
              other five sit behind a drop zone with `hidden`. Left bare it
              rendered the browser's default "Choose File" button, which is the
              single most obviously unstyled control an operator meets. The
              `file:` variants style that button without replacing the input, so
              keyboard operation and the native file dialog are untouched. */}
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="block w-full text-[0.8125rem] text-slate-600
              file:mr-3 file:cursor-pointer file:rounded-[var(--radius-control)] file:border-0
              file:bg-[var(--theme-primary,#2a78d6)] file:px-4 file:py-2
              file:text-[0.8125rem] file:font-medium file:text-white
              hover:file:brightness-110"
          />
          {fileName && <p className="text-xs text-slate-500">Selected: {fileName}</p>}
          <Button onClick={upload} disabled={!csv.trim() || !profileId || placementMissing || uploading}>
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <>
          {(result.warnings?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-sm font-semibold text-amber-900">Import notes</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-amber-800">
                {result.warnings?.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          )}
          {(result.updated?.length ?? 0) > 0 && (
            <Card>
              <CardHeader><CardTitle>Updated ({result.updated!.length})</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Instrument ID</TableHead><TableHead>Field</TableHead><TableHead>Was</TableHead><TableHead>Now</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.updated!.flatMap((u) => u.changes.map((c) => (
                      <TableRow key={`${u.id}-${c.key}`} data-testid="updated-change">
                        <TableCell className="font-mono text-xs">{u.code}</TableCell>
                        <TableCell>{c.column}</TableCell>
                        <TableCell><FromValue value={c.from} /></TableCell>
                        <TableCell className="font-mono font-semibold text-slate-900">{c.to}</TableCell>
                      </TableRow>
                    )))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Created ({result.created.length})</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {result.created.length === 0 && (
                <p className="text-sm text-slate-500">
                  Nothing was created.
                  {(result.unchanged?.length ?? 0) > 0 && ` ${result.unchanged!.length} existing instrument(s) already matched the file.`}
                </p>
              )}
              {result.created.length > 0 && (
                <>
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                    <p className="text-sm font-semibold text-amber-900">
                      The download below contains device tokens in plain text.
                    </p>
                    <p className="mt-1 text-xs text-amber-800">
                      Store it securely and delete it once the devices are configured.
                      A single token can be revealed again from its instrument&apos;s
                      Access token panel, but only one at a time, each needing your
                      password and each recorded in the audit trail — this file is
                      the only place all of them appear together.
                    </p>
                  </div>
                  <Button onClick={downloadResults}>Download results CSV (contains tokens)</Button>
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Token</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.created.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>{c.name}</TableCell>
                          <TableCell className="font-mono text-xs">{c.code}</TableCell>
                          <TableCell className="font-mono text-xs break-all">{c.token}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Rejected rows ({result.errors.length})</CardTitle></CardHeader>
            <CardContent>
              {result.errors.length === 0
                ? <p className="text-sm text-slate-500">Every row was accepted.</p>
                : <Button variant="secondary" onClick={() => setProblemsOpen(true)}>Show problems</Button>}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={problemsOpen} onClose={() => setProblemsOpen(false)} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{failure ? 'Upload failed' : 'Upload problems'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-5 pb-5">
          {failure ? (
            <p className="text-sm text-red-700">{failure}</p>
          ) : result && (
            <>
              <p className="text-sm text-slate-700">
                {summary(result)}. Row numbers count the header row.
              </p>
              {result.errors.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Row</TableHead>
                      <TableHead className="w-44">Cell</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.errors.map((e, i) => (
                      <TableRow key={`${e.row}-${i}`} data-testid="upload-problem">
                        <TableCell className="font-mono text-xs">{e.row}</TableCell>
                        <TableCell className="text-sm text-slate-700">{e.column ?? 'Whole row'}</TableCell>
                        <TableCell className="text-sm text-red-700">{e.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {(result.warnings?.length ?? 0) > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
                  {result.warnings?.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={() => setProblemsOpen(false)}>Close</Button>
          </div>
        </div>
      </Dialog>
      <BulkReviewDialog
        plan={review}
        onConfirm={(reason) => { setReview(null); void commit(reason); }}
        onClose={() => { setReview(null); setUploading(false); }}
      />
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </div>
  );
}
