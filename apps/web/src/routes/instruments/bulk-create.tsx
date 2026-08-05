import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface CreatedRow { id: string; code: string; name: string; token: string }
interface ErrorRow { row: number; message: string }
interface BulkResult { created: CreatedRow[]; errors: ErrorRow[] }

const TEMPLATE =
  'name,code,transport,instrumentType,manufacturer,model,serialNumber,description\n'
  + 'Cleanroom probe A,PROBE-A1,http,Temperature,Vaisala,HMT330,SN-001,North wing\n';

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
      const res = await apiClient.post<BulkResult>('/api/instruments/bulk', { csv });
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
          <h1 className="text-2xl font-semibold text-slate-900">Bulk Upload Instruments</h1>
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
            <code className="font-mono text-xs">code</code>,{' '}
            <code className="font-mono text-xs">transport</code>. Optional:{' '}
            <code className="font-mono text-xs">instrumentType, manufacturer, model, serialNumber, description</code>.
          </p>
          <Button variant="secondary" onClick={() => download('instrument-template.csv', TEMPLATE)}>
            Download template
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Upload</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
          {fileName && <p className="text-xs text-slate-500">Selected: {fileName}</p>}
          <Button onClick={upload} disabled={!csv.trim() || uploading}>
            {uploading ? 'Uploading…' : 'Create instruments'}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <>
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
                      Tokens cannot be retrieved later — they exist only here and in
                      whatever you save now.
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
