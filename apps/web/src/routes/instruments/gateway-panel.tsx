import { useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface ChildInstrument { id: string; code: string; name: string; isActive: boolean }

/**
 * Linked-instruments panel for a gateway's detail page. Only rendered by the
 * caller when `inst.isGateway` — this component assumes that precondition.
 */
export function GatewayPanel({ instrumentId, canEdit }: { instrumentId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const childrenKey = `/api/instruments/${instrumentId}/children`;
  const { data: children, mutate: mutateChildren } = useSWR<{ data: ChildInstrument[] }>(childrenKey);
  // Only fetched once the picker is open — this list can be large and is
  // irrelevant to the page until the operator asks to link something.
  const { data: eligible, mutate: mutateEligible } = useSWR<{ data: ChildInstrument[] }>(
    pickerOpen ? '/api/instruments/eligible-children' : null,
  );

  const rows = children?.data ?? [];

  // Both link and unlink write to the CHILD, not the gateway, and the
  // connection instructions shown above this panel are built from the
  // gateway's child codes — so a stale children list or stale parent record
  // would show a batch payload that no longer matches what was just linked.
  const refreshAfterLink = async () => {
    await Promise.all([
      mutateChildren(),
      globalMutate(`/api/instruments/${instrumentId}`),
    ]);
  };

  const link = async (childId: string) => {
    setLinkingId(childId);
    try {
      await apiClient.put(`/api/instruments/${childId}`, { gatewayId: instrumentId });
      await refreshAfterLink();
      void mutateEligible();
      toast.success('Instrument linked', 'It will now report through this gateway.');
    } catch (err: unknown) {
      toast.error('Link failed', (err as { message?: string })?.message ?? 'Could not link the instrument.');
    } finally {
      setLinkingId(null);
    }
  };

  const unlink = async (child: ChildInstrument) => {
    if (!window.confirm(`Unlink "${child.code}" from this gateway? It will need to report telemetry directly (or through another gateway).`)) return;
    setLinkingId(child.id);
    try {
      await apiClient.put(`/api/instruments/${child.id}`, { gatewayId: null });
      await refreshAfterLink();
      toast.success('Instrument unlinked', `"${child.code}" no longer reports through this gateway.`);
    } catch (err: unknown) {
      toast.error('Unlink failed', (err as { message?: string })?.message ?? 'Could not unlink the instrument.');
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Linked Instruments</CardTitle>
        {canEdit && <Button variant="secondary" onClick={() => setPickerOpen(true)}>Link Instrument</Button>}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            No instruments linked. This gateway cannot report for anything until you link some.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Status</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium text-slate-900">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    <Badge variant={c.isActive ? 'success' : 'secondary'}>{c.isActive ? 'Active' : 'Inactive'}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <Button
                        variant="secondary"
                        disabled={linkingId === c.id}
                        onClick={() => unlink(c)}
                      >
                        {linkingId === c.id ? 'Unlinking…' : 'Unlink'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <DialogHeader>
          <DialogTitle>Link an instrument</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!eligible ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : eligible.data.length === 0 ? (
            <p className="text-sm text-slate-500">
              No eligible instruments — every active instrument is either a gateway itself
              or already linked to one.
            </p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {eligible.data.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{c.name}</p>
                    <p className="font-mono text-xs text-slate-500">{c.code}</p>
                  </div>
                  <Button
                    disabled={linkingId === c.id}
                    onClick={async () => { await link(c.id); }}
                  >
                    {linkingId === c.id ? 'Linking…' : 'Link'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPickerOpen(false)}>Close</Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
