import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import type { StructureBox, StructureLabel, StructureLayer, StructureSegment } from './types';

export type StructureElement = StructureBox | StructureSegment | StructureLabel;

const TITLE: Record<StructureLayer, string> = { columns: 'Column', windows: 'Window', walls: 'Wall stub', equipment: 'Equipment', labels: 'Label' };

/**
 * The selected structure element's numbers (Layout Designer 2D, 2026-10-05),
 * editable in place: a box's x / y / w / h, a segment's two ends, a label's
 * position and text. Plan units, shown to four places. Save replaces the one
 * element; the page writes the whole layer.
 */
export function StructurePropertiesPanel({ layer, index, element, saving, onChange, onDelete, onCancel }: {
  layer: StructureLayer; index: number; element: StructureElement; saving: boolean;
  onChange: (next: StructureElement) => void; onDelete: () => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(element)) d[k] = typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v);
    setDraft(d);
  }, [element]);
  const fields = layer === 'walls' ? ['x1', 'y1', 'x2', 'y2'] : layer === 'labels' ? ['x', 'y', 'text'] : ['x', 'y', 'w', 'h'];
  const label = (k: string) => (k === 'text' ? 'Text' : k.toUpperCase());
  const save = () => {
    const next: Record<string, number | string> = {};
    for (const k of fields) next[k] = k === 'text' ? (draft[k] ?? '').trim() : Math.min(1, Math.max(0, Number(draft[k]) || 0));
    onChange(next as unknown as StructureElement);
  };
  return (
    <FormSection title={`${TITLE[layer]} ${index + 1}`} columns={1}>
      <div className="grid gap-3 sm:grid-cols-4">
        {fields.map((k) => (
          <div key={k}>
            <label htmlFor={`ld-st-${k}`} className="mb-1 block text-xs font-medium text-slate-600">{label(k)}</label>
            <Input id={`ld-st-${k}`} type={k === 'text' ? 'text' : 'number'} step={k === 'text' ? undefined : 0.001} maxLength={k === 'text' ? 60 : undefined}
              value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save element'}</Button>
        <Button variant="outline" onClick={onDelete} disabled={saving}>Delete element</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </FormSection>
  );
}
