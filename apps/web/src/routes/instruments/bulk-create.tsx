import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { parseInstrumentAttributeKeys } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';

interface CreatedRow { id: string; code: string; name: string; token: string }
interface ErrorRow { row: number; message: string }
// `warnings` are whole-file advisories (a retired column that was ignored) —
// they fail nothing, so they are rendered apart from the rejected-row table.
// Optional so an older API build that omits the field still renders.
interface BulkResult { created: CreatedRow[]; errors: ErrorRow[]; warnings?: string[] }

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
  // reads `Instrument ID` and `code` alike.
  const header = [INSTRUMENT_ID_HEADING, ...attributeKeys.map(labelFor)];
  const sample = ['CWH/RDU/001-00', ...attributeKeys.map(() => '')];
  return `${header.join(',')}\n${sample.join(',')}\n`;
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

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const upload = async () => {
    if (!csv.trim()) return;
    setUploading(true);
    try {
      const res = await apiClient.post<BulkResult>('/api/instruments/bulk', { csv, profileId });
      setResult(res);
      if (res.created.length) {
        toast.success('Instruments created', `${res.created.length} created, ${res.errors.length} row(s) rejected.`);
      } else {
        toast.error('Nothing created', `All ${res.errors.length} row(s) were rejected.`);
      }
    } catch (err: unknown) {
      toast.error('Upload failed', (err as { message?: string })?.message ?? 'Could not process the CSV.');
    } finally {
      setUploading(false);
    }
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
        description="Valid rows are created even when others fail — one typo does not reject the file."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Instruments', to: '/instruments' }, { label: 'Bulk Upload' }]}
      />

      <Card>
        <CardHeader><CardTitle>1. Choose the profile</CardTitle></CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Download the template</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            Columns: Instrument ID, then the attributes of the profile chosen above.
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
          <Button onClick={upload} disabled={!csv.trim() || !profileId || uploading}>
            {uploading ? 'Uploading…' : 'Create instruments'}
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
          <Card>
            <CardHeader><CardTitle>Created ({result.created.length})</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {result.created.length === 0 && <p className="text-sm text-slate-500">Nothing was created.</p>}
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
              {result.errors.length === 0 && <p className="text-sm text-slate-500">Every row was accepted.</p>}
              {result.errors.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow><TableHead className="w-24">Row</TableHead><TableHead>Reason</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.errors.map((e, i) => (
                      <TableRow key={`${e.row}-${i}`}>
                        {/* Row numbers count the header, matching the spreadsheet */}
                        <TableCell className="font-mono text-xs">{e.row}</TableCell>
                        <TableCell className="text-sm text-red-700">{e.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
