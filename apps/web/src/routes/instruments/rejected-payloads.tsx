import { useState } from 'react';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

export interface DeadLetter {
  id: string;
  transport: string;
  reason: string;
  rawPayload: string | null;
  receivedAt: string;
}

/**
 * The payload as a person reads it: JSON pretty-printed, anything else as it
 * was sent. A payload is rejected BECAUSE it is malformed often enough that
 * the parse failing is the normal case, not an error.
 */
export function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * The "Rejected payloads" card on the instrument detail page — the answer to
 * "the device says it is sending but nothing appears".
 *
 * THE WHOLE PAYLOAD IS IN THE CELL. Until 2026-10-06 the cell was `max-w-xs
 * truncate`, so one line of a 100-device gateway batch showed and the device
 * codes it named — the very thing the reason refers to — were hidden
 * (operator: "payload is cutting not showing fully"). The server stores up
 * to 4,000 characters and sends all of it; nothing here may cut it again.
 * The text wraps on any character (`break-all`) because a JSON payload has
 * no spaces to wrap on.
 */
export function RejectedPayloadsCard({ dead }: { dead: { data: DeadLetter[]; total: number } | undefined }) {
  const { formatDate, formatTime } = useDatetimeFormat();
  const stamp = (v: string | null) => (v ? `${formatDate(v)} ${formatTime(v)}` : '—');
  const [open, setOpen] = useState<DeadLetter | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rejected payloads ({dead?.total ?? 0})</CardTitle>
      </CardHeader>
      <CardContent>
        {!dead?.data?.length ? (
          <p className="text-sm text-slate-500">Nothing rejected — every payload this device sent was accepted.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dead.data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="whitespace-nowrap align-top text-sm">{stamp(d.receivedAt)}</TableCell>
                  <TableCell className="align-top text-xs">{d.transport}</TableCell>
                  <TableCell className="min-w-[14rem] align-top text-sm text-red-700">{d.reason}</TableCell>
                  <TableCell className="align-top">
                    <pre
                      data-testid={`rejected-payload-${d.id}`}
                      className="whitespace-pre-wrap break-all font-mono text-xs text-slate-600"
                    >
                      {d.rawPayload ?? '—'}
                    </pre>
                    {d.rawPayload !== null && (
                      <Button size="sm" variant="secondary" className="mt-2" onClick={() => setOpen(d)}>
                        Formatted
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={open !== null} onClose={() => setOpen(null)} className="max-w-3xl">
        {open && (
          <div className="space-y-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Rejected payload</h3>
              <p className="text-sm text-red-700">{open.reason}</p>
              <p className="text-xs text-slate-500">{stamp(open.receivedAt)} · {open.transport}</p>
            </div>
            <pre
              data-testid="rejected-payload-formatted"
              className="max-h-[60vh] overflow-auto rounded-[var(--radius-control)] border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800 whitespace-pre-wrap break-all"
            >
              {formatPayload(open.rawPayload ?? '')}
            </pre>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => { void navigator.clipboard?.writeText(open.rawPayload ?? ''); }}
              >
                Copy
              </Button>
              <Button onClick={() => setOpen(null)}>Close</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
