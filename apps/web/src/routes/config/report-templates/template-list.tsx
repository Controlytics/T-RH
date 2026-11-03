import { Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell, TableEmpty } from '@/components/ui/table';
import type { ReportTemplateRow } from '@digilog/shared';

/**
 * One template kind's templates for the selected scope — a profile's, or the
 * application-wide set of an application kind — the server's list, as served. Which template a DOWNLOAD uses is the server's to resolve
 * (`/resolve`); this list only says what the rows say: the default is starred,
 * and when no row is the default — none made yet, or the default was deleted —
 * it says the built-in is what prints (review focus 5: deleting the default
 * promotes nothing).
 */
export function TemplateList({
  rows, loading, typeLabel, formatDateTime, onNew, onEdit, onDuplicate, onSetDefault, onDelete,
}: {
  rows: ReportTemplateRow[];
  loading: boolean;
  typeLabel: string;
  formatDateTime: (iso: string) => string;
  onNew: () => void;
  onEdit: (row: ReportTemplateRow) => void;
  onDuplicate: (row: ReportTemplateRow) => void;
  onSetDefault: (row: ReportTemplateRow) => void;
  onDelete: (row: ReportTemplateRow) => void;
}) {
  const current = rows.find((r) => r.isDefault);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {current ? (
          <p data-testid="default-line" className="text-sm text-slate-600">
            {typeLabel} downloads use <span className="font-semibold text-slate-800">{current.name}</span>.
          </p>
        ) : rows.length > 0 ? (
          <p data-testid="no-default" role="status" className="rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
            No template is the default — {typeLabel} downloads use the built-in template.
          </p>
        ) : <span />}
        <Button onClick={onNew} icon={<Plus className="h-4 w-4" />}>New template</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Updated</TableHead>
            <TableHead scope="col">Updated by</TableHead>
            <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && rows.length === 0 ? (
            <TableRow><TableCell colSpan={4} className="px-4 py-4"><SkeletonRows rows={3} columns={4} /></TableCell></TableRow>
          ) : rows.length === 0 ? (
            <TableEmpty colSpan={4} title="No templates" description={`${typeLabel} downloads use the built-in template.`} />
          ) : rows.map((r) => (
            <TableRow key={r.id} data-template-id={r.id}>
              <TableCell className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">{r.name}</span>
                  {r.isDefault && (
                    <Badge variant="success" className="gap-1 px-2 py-0.5">
                      <Star aria-hidden className="h-3 w-3 fill-current" />
                      Default
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-700">{formatDateTime(r.updatedAt)}</TableCell>
              <TableCell className="px-4 py-3 text-slate-700">{r.updatedBy || '—'}</TableCell>
              <TableCell className="px-4 py-3">
                {/* The one action a row may lack comes FIRST, so Edit / Duplicate /
                    Delete sit in the same place on every row. */}
                <div className="flex flex-wrap justify-end gap-2">
                  {!r.isDefault && (
                    <Button size="sm" variant="ghost" aria-label={`Set ${r.name} as default`} onClick={() => onSetDefault(r)}>Set as default</Button>
                  )}
                  <Button size="sm" variant="outline" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r)}>Edit</Button>
                  <Button size="sm" variant="ghost" aria-label={`Duplicate ${r.name}`} onClick={() => onDuplicate(r)}>Duplicate</Button>
                  <Button size="sm" variant="destructive" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)}>Delete</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
