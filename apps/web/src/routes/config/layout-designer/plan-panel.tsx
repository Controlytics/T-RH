import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import type { DesignerAnnotations } from './types';

/**
 * The PLAN's own properties (Layout Designer 2D, 2026-10-05): style, floor,
 * north. Shown when nothing on the canvas is selected. Saved as ONE PUT of
 * the whole `annotations` object — the structure arrays ride along
 * untouched, which is what lets a switch back to Standard keep them.
 */
export function PlanPropertiesPanel({ planName, annotations, saving, scriptDrawn, onSave }: {
  planName: string;
  annotations: DesignerAnnotations;
  saving: boolean;
  scriptDrawn: boolean;
  onSave: (next: DesignerAnnotations) => void;
}) {
  const [style, setStyle] = useState(annotations.style);
  const [group, setGroup] = useState(annotations.floor?.group ?? '');
  const [label, setLabel] = useState(annotations.floor?.label ?? '');
  const [order, setOrder] = useState(annotations.floor ? String(annotations.floor.order) : '0');
  const [north, setNorth] = useState(annotations.north == null ? '' : String(annotations.north));
  useEffect(() => {
    setStyle(annotations.style);
    setGroup(annotations.floor?.group ?? ''); setLabel(annotations.floor?.label ?? '');
    setOrder(annotations.floor ? String(annotations.floor.order) : '0');
    setNorth(annotations.north == null ? '' : String(annotations.north));
  }, [annotations]);

  const save = () => {
    const g = group.trim(), l = label.trim();
    const n = north.trim() === '' ? null : Number(north);
    onSave({
      ...annotations,
      style,
      floor: g || l ? { group: g || l, label: l || g, order: Math.max(0, Math.min(99, Math.round(Number(order) || 0))) } : null,
      north: n != null && Number.isFinite(n) ? ((n % 360) + 360) % 360 : null,
    });
  };

  return (
    <FormSection title={`Plan ${planName}`} columns={1}>
      {scriptDrawn && (
        <p className="text-xs text-amber-700">This plan is drawn by a script; re-running it overwrites edits made here.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-5">
        <div>
          <label htmlFor="ld-style" className="mb-1 block text-xs font-medium text-slate-600">Style</label>
          <select id="ld-style" value={style} onChange={(e) => setStyle(e.target.value as DesignerAnnotations['style'])} className="ctl w-full">
            <option value="standard">Standard</option>
            <option value="architectural">2D architectural</option>
          </select>
        </div>
        <div>
          <label htmlFor="ld-floor-group" className="mb-1 block text-xs font-medium text-slate-600">Floor group</label>
          <Input id="ld-floor-group" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Building, when it has several floors" />
        </div>
        <div>
          <label htmlFor="ld-floor-label" className="mb-1 block text-xs font-medium text-slate-600">Floor label</label>
          <Input id="ld-floor-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ground Floor" />
        </div>
        <div>
          <label htmlFor="ld-floor-order" className="mb-1 block text-xs font-medium text-slate-600">Floor order</label>
          <Input id="ld-floor-order" type="number" min={0} max={99} value={order} onChange={(e) => setOrder(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ld-north" className="mb-1 block text-xs font-medium text-slate-600">North (degrees)</label>
          <Input id="ld-north" type="number" min={0} max={359} value={north} onChange={(e) => setNorth(e.target.value)} placeholder="blank = no compass" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
      </div>
    </FormSection>
  );
}
