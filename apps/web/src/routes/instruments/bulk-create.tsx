import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface CreatedRow { id: string; code: string; name: string; token: string }
interface ErrorRow { row: number; message: string }
// `warnings` are whole-file advisories (a retired column that was ignored) —
// they fail nothing, so they are rendered apart from the rejected-row table.
// Optional so an older API build that omits the field still renders.
interface BulkResult { created: CreatedRow[]; errors: ErrorRow[]; warnings?: string[] }

const TEMPLATE =
  'name,code,instrumentType,manufacturer,model,serialNumber,description\n'
  + 'Cleanroom probe A,PROBE-A1,Temperature,Vaisala,HMT330,SN-001,North wing\n';

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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">Bulk Upload Instruments</h1>
          <p className="text-sm text-slate-500">
            Valid rows are created even when others fail — one typo does not reject the file.
          </p>
        </div>
        <Link to="/instruments"><Button variant="secondary">Back to list</Button></Link>
      </div>

      <Card>
        <CardHeader><CardTitle>1. Prepare the file</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-600">
            Required columns: <code className="font-mono text-xs">name</code>,{' '}
            <code className="font-mono text-xs">code</code>. Optional:{' '}
            <code className="font-mono text-xs">instrumentType, manufacturer, model, serialNumber, description</code>.
          </p>
          <p className="text-sm text-slate-600">
            No profile column — every instrument in the file goes into the one profile you pick below.
          </p>
          <Button variant="secondary" onClick={() => download('instrument-template.csv', TEMPLATE)}>
            Download template
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Choose the profile</CardTitle></CardHeader>
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
        <CardHeader><CardTitle>3. Upload</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
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
