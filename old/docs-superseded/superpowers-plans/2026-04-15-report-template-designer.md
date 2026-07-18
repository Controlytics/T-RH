# Report Template Designer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full template designer UI — a 3-panel editor where users create report layouts with drag-and-drop sections, variable tags, header/footer configuration, entity slots, and signature blocks.

**Architecture:** Single-page editor at `/report-templates/:id/edit` with left palette, center canvas (sortable section list), and right property panel. All state lives in a `TemplateConfig` object synced to the backend via PUT. Uses @dnd-kit for drag-and-drop reordering.

**Tech Stack:** React 19, @dnd-kit/core + @dnd-kit/sortable, SWR, Tailwind CSS 4, lucide-react icons, existing UI primitives (Dialog, Button, Input, Select)

---

## File Structure

```
apps/web/src/
  routes/report-templates/
    index.tsx                          # (EXISTS) List page — add Edit button + navigate
    editor.tsx                         # NEW — Main designer page (loads template, 3-panel layout)
    components/
      template-types.ts               # NEW — TypeScript interfaces for TemplateConfig
      section-palette.tsx              # NEW — Left panel: draggable section type buttons
      section-canvas.tsx              # NEW — Center panel: sortable section list
      section-canvas-item.tsx         # NEW — Single section card in the canvas
      section-editor.tsx              # NEW — Right panel: dispatches to type-specific editor
      text-section-editor.tsx         # NEW — Text section property editor
      table-section-editor.tsx        # NEW — Table section property editor
      table-column-editor.tsx         # NEW — Single column config within table editor
      conditional-rule-editor.tsx     # NEW — Conditional formatting rule row
      chart-section-editor.tsx        # NEW — Chart section property editor
      kv-section-editor.tsx           # NEW — Key-value section property editor
      signature-section-editor.tsx    # NEW — Signature section property editor
      header-footer-editor.tsx        # NEW — Header/footer element editor
      entity-slot-editor.tsx          # NEW — Entity slot definitions panel
      variable-tag-picker.tsx         # NEW — Tag browser/inserter
      page-settings-editor.tsx        # NEW — Page size, orientation, margins
  main.tsx                            # MODIFY — Add lazy route for editor
```

---

## Task 1: Install @dnd-kit and Define TypeScript Types

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/routes/report-templates/components/template-types.ts`

- [ ] **Step 1: Install @dnd-kit packages**

```bash
cd apps/web && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Create template-types.ts with all TypeScript interfaces**

Create `apps/web/src/routes/report-templates/components/template-types.ts`:

```typescript
// ── Section Types ──────────────────────────────────────────────

export type SectionType = 'text' | 'table' | 'chart' | 'key_value' | 'signature' | 'page_break';

export interface ConditionalRule {
  condition: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'contains' | 'empty' | 'not_empty';
  value?: string | number;
  min?: number;
  max?: number;
  style: CellStyle;
}

export interface CellStyle {
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline' | 'line-through';
  color?: string;
  backgroundColor?: string;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  textAlign?: 'left' | 'center' | 'right';
}

export interface ColumnFormat {
  type: 'text' | 'number' | 'datetime';
  decimalPlaces?: number;
  unit?: string;
  pattern?: string;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: string;
  format?: ColumnFormat;
  style?: CellStyle;
  conditionalRules?: ConditionalRule[];
}

export interface TableSettings {
  maxRowsPerPage: number;
  wrapText: boolean;
  showBorders: boolean;
  stripedRows: boolean;
  headerRepeat: boolean;
  emptyValue: string;
  bodyStyle: { fontSize: number; fontFamily: string };
  headerStyle: CellStyle;
}

export interface ChartSeries {
  source: string;
  label: string;
  color: string;
}

export interface ChartAxis {
  type?: 'time' | 'linear' | 'category';
  label: string;
  min?: number;
  max?: number;
}

export interface KVEntry {
  label: string;
  value: string;
  format?: ColumnFormat;
}

export interface SignerDef {
  role: string;
  label: string;
  required: boolean;
}

// ── Section Definitions ────────────────────────────────────────

interface BaseSection {
  id: string;
  type: SectionType;
}

export interface TextSection extends BaseSection {
  type: 'text';
  content: string;
  style: { fontSize: number; fontFamily: string; lineHeight: number };
}

export interface TableSection extends BaseSection {
  type: 'table';
  title: string;
  dataSource: string;
  columns: TableColumn[];
  tableSettings: TableSettings;
}

export interface ChartSection extends BaseSection {
  type: 'chart';
  title: string;
  chartType: 'line' | 'bar' | 'pie';
  width: string;
  height: number;
  dataSeries: ChartSeries[];
  xAxis: ChartAxis;
  yAxis: ChartAxis;
  showLegend: boolean;
  showGrid: boolean;
}

export interface KVSection extends BaseSection {
  type: 'key_value';
  title: string;
  layout: 'one_column' | 'two_column' | 'three_column';
  entries: KVEntry[];
}

export interface SignatureSection extends BaseSection {
  type: 'signature';
  label: string;
  signers: string[];
}

export interface PageBreakSection extends BaseSection {
  type: 'page_break';
}

export type Section = TextSection | TableSection | ChartSection | KVSection | SignatureSection | PageBreakSection;

// ── Header / Footer ───────────────────────────────────────────

export interface HeaderFooterElement {
  type: 'text' | 'image';
  content?: string;
  source?: string;
  position: 'left' | 'center' | 'right';
  width?: number;
  style?: { fontSize?: number; fontWeight?: string; color?: string };
}

export interface HeaderFooterConfig {
  enabled: boolean;
  height: number;
  elements: HeaderFooterElement[];
}

// ── Entity Slots ──────────────────────────────────────────────

export interface EntitySlot {
  name: string;
  label: string;
  type: 'asset_instance' | 'equipment_group' | 'uns_path';
  templateFilter?: string;
  pathPrefix?: string;
}

// ── Signature Config ──────────────────────────────────────────

export interface SignatureConfig {
  required: boolean;
  meaning: string;
  signers: SignerDef[];
}

// ── Page Settings ─────────────────────────────────────────────

export interface PageSettings {
  size: 'A4' | 'Letter' | 'Legal';
  orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };
}

// ── Full Template Config ──────────────────────────────────────

export interface TemplateConfig {
  pageSettings: PageSettings;
  header: HeaderFooterConfig;
  footer: HeaderFooterConfig;
  entitySlots: EntitySlot[];
  sections: Section[];
  signatureConfig: SignatureConfig;
}

// ── Defaults ──────────────────────────────────────────────────

let counter = 0;
export function genId(): string {
  return `sec_${Date.now()}_${++counter}`;
}

export function createDefaultSection(type: SectionType): Section {
  const id = genId();
  switch (type) {
    case 'text':
      return { id, type, content: '', style: { fontSize: 12, fontFamily: 'Arial', lineHeight: 1.5 } };
    case 'table':
      return {
        id, type, title: 'Data Table', dataSource: '', columns: [],
        tableSettings: {
          maxRowsPerPage: 30, wrapText: true, showBorders: true, stripedRows: true,
          headerRepeat: true, emptyValue: '\u2014',
          bodyStyle: { fontSize: 10, fontFamily: 'Arial' },
          headerStyle: { fontWeight: 'bold', backgroundColor: '#f1f5f9', textTransform: 'uppercase' },
        },
      };
    case 'chart':
      return {
        id, type, title: 'Chart', chartType: 'line', width: '100%', height: 300,
        dataSeries: [], xAxis: { type: 'time', label: 'Time' }, yAxis: { label: 'Value' },
        showLegend: true, showGrid: true,
      };
    case 'key_value':
      return { id, type, title: 'Details', layout: 'two_column', entries: [] };
    case 'signature':
      return { id, type, label: 'Electronic Signature', signers: [] };
    case 'page_break':
      return { id, type };
  }
}

export const SECTION_LABELS: Record<SectionType, string> = {
  text: 'Text Block',
  table: 'Data Table',
  chart: 'Chart',
  key_value: 'Key-Value',
  signature: 'Signature',
  page_break: 'Page Break',
};

export const SECTION_ICONS: Record<SectionType, string> = {
  text: 'Type',
  table: 'Table2',
  chart: 'BarChart3',
  key_value: 'List',
  signature: 'PenTool',
  page_break: 'SeparatorHorizontal',
};
```

- [ ] **Step 3: Verify build**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/routes/report-templates/components/template-types.ts
git commit -m "feat(reports): add @dnd-kit and template designer TypeScript types"
```

---

## Task 2: Editor Page Shell + Route Registration

**Files:**
- Create: `apps/web/src/routes/report-templates/editor.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/routes/report-templates/index.tsx`

- [ ] **Step 1: Create the editor page shell**

Create `apps/web/src/routes/report-templates/editor.tsx`:

```typescript
import { useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '../../lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import type { TemplateConfig, Section } from './components/template-types';
import { createDefaultSection, type SectionType } from './components/template-types';
import { SectionPalette } from './components/section-palette';
import { SectionCanvas } from './components/section-canvas';
import { SectionEditor } from './components/section-editor';
import { HeaderFooterEditor } from './components/header-footer-editor';
import { EntitySlotEditor } from './components/entity-slot-editor';
import { VariableTagPicker } from './components/variable-tag-picker';
import { PageSettingsEditor } from './components/page-settings-editor';

const DEFAULT_CONFIG: TemplateConfig = {
  pageSettings: { size: 'A4', orientation: 'portrait', margins: { top: 20, right: 15, bottom: 20, left: 15 } },
  header: { enabled: true, height: 80, elements: [] },
  footer: { enabled: true, height: 40, elements: [] },
  entitySlots: [],
  sections: [],
  signatureConfig: { required: false, meaning: '', signers: [] },
};

type RightPanel = 'section' | 'header' | 'footer' | 'page-settings';

export function ReportTemplateEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const reauth = useReauth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canUpdate = isSuperAdmin || (user?.permissions ?? []).includes('REPORT_TEMPLATE_UPDATE');

  const { data: templateData, isLoading } = useSWR(id ? `/api/report-templates/${id}` : null);

  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [selectedSectionIdx, setSelectedSectionIdx] = useState<number | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>('section');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Initialize config from fetched data
  if (templateData && !config) {
    const fetched = templateData.latestConfig ?? DEFAULT_CONFIG;
    setConfig(fetched);
    setTemplateName(templateData.name ?? '');
    setTemplateDescription(templateData.description ?? '');
  }

  const updateConfig = useCallback((updater: (prev: TemplateConfig) => TemplateConfig) => {
    setConfig(prev => {
      if (!prev) return prev;
      setDirty(true);
      return updater(prev);
    });
  }, []);

  const addSection = useCallback((type: SectionType) => {
    updateConfig(prev => {
      const newSection = createDefaultSection(type);
      const sections = [...prev.sections, newSection];
      setSelectedSectionIdx(sections.length - 1);
      setRightPanel('section');
      return { ...prev, sections };
    });
  }, [updateConfig]);

  const updateSection = useCallback((idx: number, updated: Section) => {
    updateConfig(prev => ({
      ...prev,
      sections: prev.sections.map((s, i) => i === idx ? updated : s),
    }));
  }, [updateConfig]);

  const removeSection = useCallback((idx: number) => {
    updateConfig(prev => ({
      ...prev,
      sections: prev.sections.filter((_, i) => i !== idx),
    }));
    setSelectedSectionIdx(null);
  }, [updateConfig]);

  const reorderSections = useCallback((fromIdx: number, toIdx: number) => {
    updateConfig(prev => {
      const sections = [...prev.sections];
      const [moved] = sections.splice(fromIdx, 1);
      sections.splice(toIdx, 0, moved);
      // Adjust selected index
      if (selectedSectionIdx === fromIdx) setSelectedSectionIdx(toIdx);
      else if (selectedSectionIdx !== null) {
        if (fromIdx < selectedSectionIdx && toIdx >= selectedSectionIdx) setSelectedSectionIdx(selectedSectionIdx - 1);
        else if (fromIdx > selectedSectionIdx && toIdx <= selectedSectionIdx) setSelectedSectionIdx(selectedSectionIdx + 1);
      }
      return { ...prev, sections };
    });
  }, [updateConfig, selectedSectionIdx]);

  const handleSave = () => {
    if (!config || !id) return;
    reauth.execute('UPDATE_REPORT_TEMPLATE', async (password?: string) => {
      setSaving(true);
      try {
        const body = { name: templateName, description: templateDescription || undefined, config, changelog: 'Updated via designer' };
        if (password) await apiClient.putWithReauth(`/api/report-templates/${id}`, body, password);
        else await apiClient.put(`/api/report-templates/${id}`, body);
        setDirty(false);
        toast.success('Template saved');
      } catch (err: any) {
        toast.error('Save failed', err.message || 'Could not save template');
        throw err;
      } finally {
        setSaving(false);
      }
    });
  };

  if (isLoading || !config) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  const selectedSection = selectedSectionIdx !== null ? config.sections[selectedSectionIdx] : null;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/report-templates')} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <input value={templateName} onChange={e => { setTemplateName(e.target.value); setDirty(true); }}
              className="text-lg font-bold text-slate-800 bg-transparent border-none outline-none focus:ring-0 w-72"
              placeholder="Template Name" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-500 font-medium">Unsaved changes</span>}
          <button onClick={() => { setRightPanel('page-settings'); setSelectedSectionIdx(null); }}
            className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            Page Settings
          </button>
          {canUpdate && (
            <button onClick={handleSave} disabled={saving || !dirty}
              className="px-5 py-2 text-sm font-semibold text-white rounded-xl transition-all disabled:opacity-50 shadow-md"
              style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* 3-Panel Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel: Palette + Entity Slots + Variable Tags */}
        <div className="w-64 bg-white border-r border-slate-200 overflow-y-auto shrink-0">
          <SectionPalette onAdd={addSection} />
          <EntitySlotEditor
            slots={config.entitySlots}
            onChange={slots => updateConfig(prev => ({ ...prev, entitySlots: slots }))}
          />
          <VariableTagPicker entitySlots={config.entitySlots} />
        </div>

        {/* Center: Section Canvas */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Header click-to-edit */}
          <button onClick={() => { setRightPanel('header'); setSelectedSectionIdx(null); }}
            className={`w-full mb-3 p-3 rounded-xl border-2 border-dashed text-sm font-medium transition-colors ${rightPanel === 'header' ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-500'}`}>
            {config.header.enabled ? `Header (${config.header.elements.length} elements)` : 'Header (disabled)'}
          </button>

          <SectionCanvas
            sections={config.sections}
            selectedIdx={selectedSectionIdx}
            onSelect={(idx) => { setSelectedSectionIdx(idx); setRightPanel('section'); }}
            onReorder={reorderSections}
            onRemove={removeSection}
          />

          {/* Footer click-to-edit */}
          <button onClick={() => { setRightPanel('footer'); setSelectedSectionIdx(null); }}
            className={`w-full mt-3 p-3 rounded-xl border-2 border-dashed text-sm font-medium transition-colors ${rightPanel === 'footer' ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-500'}`}>
            {config.footer.enabled ? `Footer (${config.footer.elements.length} elements)` : 'Footer (disabled)'}
          </button>
        </div>

        {/* Right Panel: Section Editor / Header-Footer / Page Settings */}
        <div className="w-80 bg-white border-l border-slate-200 overflow-y-auto shrink-0">
          {rightPanel === 'section' && selectedSection ? (
            <SectionEditor
              section={selectedSection}
              onChange={(updated) => updateSection(selectedSectionIdx!, updated)}
              entitySlots={config.entitySlots}
              signatureConfig={config.signatureConfig}
              onSignatureConfigChange={sc => updateConfig(prev => ({ ...prev, signatureConfig: sc }))}
            />
          ) : rightPanel === 'header' ? (
            <HeaderFooterEditor
              label="Header"
              config={config.header}
              onChange={header => updateConfig(prev => ({ ...prev, header }))}
            />
          ) : rightPanel === 'footer' ? (
            <HeaderFooterEditor
              label="Footer"
              config={config.footer}
              onChange={footer => updateConfig(prev => ({ ...prev, footer }))}
            />
          ) : rightPanel === 'page-settings' ? (
            <PageSettingsEditor
              settings={config.pageSettings}
              onChange={pageSettings => updateConfig(prev => ({ ...prev, pageSettings }))}
            />
          ) : (
            <div className="p-6 text-center text-slate-400 text-sm">
              <p className="mt-4">Select a section to edit its properties</p>
            </div>
          )}
        </div>
      </div>

      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} />
    </div>
  );
}
```

- [ ] **Step 2: Add lazy route in main.tsx**

In `apps/web/src/main.tsx`, add the lazy import near the other lazy imports (around line 89):

```typescript
const ReportTemplateEditorPage = lazy(() => import("./routes/report-templates/editor").then(m => ({ default: m.ReportTemplateEditorPage })));
```

Add the route inside the `<Route element={<AppLayout />}>` block, right after the `/report-templates` route (around line 232):

```typescript
<Route path="/report-templates/:id/edit" element={<RequireRole permissions={[PERMISSIONS.REPORT_TEMPLATE_UPDATE]}><Suspense fallback={<LazyFallback />}><ReportTemplateEditorPage /></Suspense></RequireRole>} />
```

- [ ] **Step 3: Add Edit button to template list rows**

In `apps/web/src/routes/report-templates/index.tsx`, add an Edit button in the actions cell. Find the `{/* Duplicate */}` comment (around line 272) and add before it:

```typescript
{/* Edit */}
{canUpdate && (
  <button onClick={(e) => { e.stopPropagation(); navigate(`/report-templates/${t.id}/edit`); }}
    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors" title="Edit">
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
  </button>
)}
```

Also add `useNavigate` import at the top of the file:

```typescript
import { useNavigate } from 'react-router-dom';
```

And inside the component function, add:

```typescript
const navigate = useNavigate();
```

- [ ] **Step 4: Verify build compiles** (will fail until stub components are created — that's expected, move to Task 3)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/report-templates/editor.tsx apps/web/src/main.tsx apps/web/src/routes/report-templates/index.tsx
git commit -m "feat(reports): add template editor page shell with route and edit button"
```

---

## Task 3: Section Palette (Left Panel)

**Files:**
- Create: `apps/web/src/routes/report-templates/components/section-palette.tsx`

- [ ] **Step 1: Create section-palette.tsx**

Create `apps/web/src/routes/report-templates/components/section-palette.tsx`:

```typescript
import { Type, Table2, BarChart3, List, PenTool, SeparatorHorizontal } from 'lucide-react';
import { SECTION_LABELS, type SectionType } from './template-types';

const PALETTE_ITEMS: { type: SectionType; icon: React.ReactNode; description: string }[] = [
  { type: 'text', icon: <Type className="w-4 h-4" />, description: 'Rich text with variable tags' },
  { type: 'table', icon: <Table2 className="w-4 h-4" />, description: 'Data table with formatting' },
  { type: 'chart', icon: <BarChart3 className="w-4 h-4" />, description: 'Line, bar, or pie chart' },
  { type: 'key_value', icon: <List className="w-4 h-4" />, description: 'Label-value pairs grid' },
  { type: 'signature', icon: <PenTool className="w-4 h-4" />, description: 'Electronic signature block' },
  { type: 'page_break', icon: <SeparatorHorizontal className="w-4 h-4" />, description: 'Force new page' },
];

interface Props {
  onAdd: (type: SectionType) => void;
}

export function SectionPalette({ onAdd }: Props) {
  return (
    <div className="p-4 border-b border-slate-100">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Sections</h3>
      <div className="space-y-1.5">
        {PALETTE_ITEMS.map(item => (
          <button key={item.type} onClick={() => onAdd(item.type)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-slate-50 transition-colors group">
            <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
              {item.icon}
            </div>
            <div>
              <div className="text-sm font-medium text-slate-700">{SECTION_LABELS[item.type]}</div>
              <div className="text-xs text-slate-400">{item.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/report-templates/components/section-palette.tsx
git commit -m "feat(reports): add section palette component"
```

---

## Task 4: Section Canvas with Drag-and-Drop

**Files:**
- Create: `apps/web/src/routes/report-templates/components/section-canvas.tsx`
- Create: `apps/web/src/routes/report-templates/components/section-canvas-item.tsx`

- [ ] **Step 1: Create section-canvas-item.tsx**

Create `apps/web/src/routes/report-templates/components/section-canvas-item.tsx`:

```typescript
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, Type, Table2, BarChart3, List, PenTool, SeparatorHorizontal } from 'lucide-react';
import type { Section } from './template-types';
import { SECTION_LABELS } from './template-types';

const SECTION_ICON: Record<string, React.ReactNode> = {
  text: <Type className="w-4 h-4" />,
  table: <Table2 className="w-4 h-4" />,
  chart: <BarChart3 className="w-4 h-4" />,
  key_value: <List className="w-4 h-4" />,
  signature: <PenTool className="w-4 h-4" />,
  page_break: <SeparatorHorizontal className="w-4 h-4" />,
};

interface Props {
  section: Section;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function getSummary(section: Section): string {
  switch (section.type) {
    case 'text': return section.content ? section.content.slice(0, 60) + (section.content.length > 60 ? '...' : '') : 'Empty text block';
    case 'table': return section.title || 'Untitled table';
    case 'chart': return `${section.chartType} chart: ${section.title || 'Untitled'}`;
    case 'key_value': return `${section.entries.length} entries: ${section.title || 'Untitled'}`;
    case 'signature': return `${section.signers.length} signers`;
    case 'page_break': return 'Page break';
  }
}

export function SectionCanvasItem({ section, index, isSelected, onSelect, onRemove }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}
      className={`flex items-center gap-2 p-3 rounded-xl border-2 bg-white cursor-pointer transition-colors ${isSelected ? 'border-blue-400 shadow-md' : 'border-slate-200 hover:border-slate-300'}`}
      onClick={onSelect}>
      {/* Drag handle */}
      <button {...attributes} {...listeners} className="p-1 rounded text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing" onClick={e => e.stopPropagation()}>
        <GripVertical className="w-4 h-4" />
      </button>

      {/* Icon + info */}
      <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 shrink-0">
        {SECTION_ICON[section.type]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-slate-500 uppercase">{SECTION_LABELS[section.type]}</div>
        <div className="text-sm text-slate-600 truncate">{getSummary(section)}</div>
      </div>

      {/* Remove */}
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="p-1 rounded text-slate-300 hover:text-red-500 transition-colors">
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create section-canvas.tsx**

Create `apps/web/src/routes/report-templates/components/section-canvas.tsx`:

```typescript
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import type { Section } from './template-types';
import { SectionCanvasItem } from './section-canvas-item';

interface Props {
  sections: Section[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onRemove: (idx: number) => void;
}

export function SectionCanvas({ sections, selectedIdx, onSelect, onReorder, onRemove }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = sections.findIndex(s => s.id === active.id);
    const toIdx = sections.findIndex(s => s.id === over.id);
    if (fromIdx !== -1 && toIdx !== -1) onReorder(fromIdx, toIdx);
  };

  if (sections.length === 0) {
    return (
      <div className="border-2 border-dashed border-slate-200 rounded-2xl p-12 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-slate-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" /></svg>
        </div>
        <p className="text-slate-400 font-medium">No sections yet</p>
        <p className="text-slate-300 text-sm mt-1">Click a section type in the palette to add one</p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
      <SortableContext items={sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {sections.map((section, idx) => (
            <SectionCanvasItem
              key={section.id}
              section={section}
              index={idx}
              isSelected={selectedIdx === idx}
              onSelect={() => onSelect(idx)}
              onRemove={() => onRemove(idx)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
```

- [ ] **Step 3: Install @dnd-kit/modifiers (needed for restrictToVerticalAxis)**

```bash
cd apps/web && npm install @dnd-kit/modifiers
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/report-templates/components/section-canvas.tsx apps/web/src/routes/report-templates/components/section-canvas-item.tsx apps/web/package.json apps/web/package-lock.json
git commit -m "feat(reports): add drag-and-drop section canvas with sortable items"
```

---

## Task 5: Section Editor Dispatcher + Text Section Editor

**Files:**
- Create: `apps/web/src/routes/report-templates/components/section-editor.tsx`
- Create: `apps/web/src/routes/report-templates/components/text-section-editor.tsx`

- [ ] **Step 1: Create text-section-editor.tsx**

Create `apps/web/src/routes/report-templates/components/text-section-editor.tsx`:

```typescript
import type { TextSection } from './template-types';

interface Props {
  section: TextSection;
  onChange: (updated: TextSection) => void;
}

export function TextSectionEditor({ section, onChange }: Props) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Content</label>
        <textarea
          value={section.content}
          onChange={e => onChange({ ...section, content: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 resize-none outline-none focus:ring-2"
          style={{ '--tw-ring-color': 'color-mix(in srgb, var(--theme-primary) 20%, transparent)' } as React.CSSProperties}
          rows={6}
          placeholder="Enter text content. Use {{variable.tags}} for dynamic data..."
        />
        <p className="text-xs text-slate-400 mt-1">Supports variable tags like {'{{meta.org.name}}'} or {'{{attr.$slot.field}}'}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Font Family</label>
          <select value={section.style.fontFamily}
            onChange={e => onChange({ ...section, style: { ...section.style, fontFamily: e.target.value } })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 outline-none">
            <option value="Arial">Arial</option>
            <option value="Helvetica">Helvetica</option>
            <option value="Times New Roman">Times New Roman</option>
            <option value="Courier New">Courier New</option>
            <option value="Georgia">Georgia</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Font Size</label>
          <input type="number" min={8} max={36} value={section.style.fontSize}
            onChange={e => onChange({ ...section, style: { ...section.style, fontSize: Number(e.target.value) } })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 outline-none" />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Line Height</label>
        <input type="number" min={1} max={3} step={0.1} value={section.style.lineHeight}
          onChange={e => onChange({ ...section, style: { ...section.style, lineHeight: Number(e.target.value) } })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 outline-none" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create section-editor.tsx dispatcher**

Create `apps/web/src/routes/report-templates/components/section-editor.tsx`:

```typescript
import type { Section, EntitySlot, SignatureConfig } from './template-types';
import { SECTION_LABELS } from './template-types';
import { TextSectionEditor } from './text-section-editor';
import { TableSectionEditor } from './table-section-editor';
import { ChartSectionEditor } from './chart-section-editor';
import { KVSectionEditor } from './kv-section-editor';
import { SignatureSectionEditor } from './signature-section-editor';

interface Props {
  section: Section;
  onChange: (updated: Section) => void;
  entitySlots: EntitySlot[];
  signatureConfig: SignatureConfig;
  onSignatureConfigChange: (sc: SignatureConfig) => void;
}

export function SectionEditor({ section, onChange, entitySlots, signatureConfig, onSignatureConfigChange }: Props) {
  return (
    <div className="p-4">
      <h3 className="text-sm font-bold text-slate-800 mb-1">{SECTION_LABELS[section.type]}</h3>
      <p className="text-xs text-slate-400 mb-4">Configure this section's properties</p>

      {section.type === 'text' && <TextSectionEditor section={section} onChange={onChange as any} />}
      {section.type === 'table' && <TableSectionEditor section={section} onChange={onChange as any} entitySlots={entitySlots} />}
      {section.type === 'chart' && <ChartSectionEditor section={section} onChange={onChange as any} entitySlots={entitySlots} />}
      {section.type === 'key_value' && <KVSectionEditor section={section} onChange={onChange as any} />}
      {section.type === 'signature' && <SignatureSectionEditor section={section} onChange={onChange as any} signatureConfig={signatureConfig} onSignatureConfigChange={onSignatureConfigChange} />}
      {section.type === 'page_break' && (
        <div className="text-center text-slate-400 py-6">
          <p className="text-sm">Page break inserts a new page here.</p>
          <p className="text-xs mt-1">No configuration needed.</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/report-templates/components/section-editor.tsx apps/web/src/routes/report-templates/components/text-section-editor.tsx
git commit -m "feat(reports): add section editor dispatcher and text section editor"
```

---

## Task 6: Table Section Editor with Column Config + Conditional Rules

**Files:**
- Create: `apps/web/src/routes/report-templates/components/conditional-rule-editor.tsx`
- Create: `apps/web/src/routes/report-templates/components/table-column-editor.tsx`
- Create: `apps/web/src/routes/report-templates/components/table-section-editor.tsx`

- [ ] **Step 1: Create conditional-rule-editor.tsx**

Create `apps/web/src/routes/report-templates/components/conditional-rule-editor.tsx`:

```typescript
import { Trash2 } from 'lucide-react';
import type { ConditionalRule } from './template-types';

interface Props {
  rule: ConditionalRule;
  onChange: (updated: ConditionalRule) => void;
  onRemove: () => void;
}

const CONDITIONS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
  { value: 'between', label: 'Between' },
  { value: 'contains', label: 'Contains' },
  { value: 'empty', label: 'Empty' },
  { value: 'not_empty', label: 'Not Empty' },
] as const;

export function ConditionalRuleEditor({ rule, onChange, onRemove }: Props) {
  const needsValue = !['empty', 'not_empty'].includes(rule.condition);
  const isBetween = rule.condition === 'between';

  return (
    <div className="flex flex-wrap items-center gap-1.5 p-2 bg-slate-50 rounded-lg text-xs">
      <select value={rule.condition}
        onChange={e => onChange({ ...rule, condition: e.target.value as ConditionalRule['condition'] })}
        className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white outline-none">
        {CONDITIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>

      {isBetween ? (
        <>
          <input type="number" value={rule.min ?? ''} placeholder="Min"
            onChange={e => onChange({ ...rule, min: Number(e.target.value) })}
            className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white outline-none" />
          <span className="text-slate-400">-</span>
          <input type="number" value={rule.max ?? ''} placeholder="Max"
            onChange={e => onChange({ ...rule, max: Number(e.target.value) })}
            className="w-14 border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white outline-none" />
        </>
      ) : needsValue ? (
        <input type="text" value={rule.value ?? ''} placeholder="Value"
          onChange={e => onChange({ ...rule, value: e.target.value })}
          className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white outline-none" />
      ) : null}

      <span className="text-slate-300 mx-0.5">&rarr;</span>

      <button onClick={() => onChange({ ...rule, style: { ...rule.style, fontWeight: rule.style.fontWeight === 'bold' ? 'normal' : 'bold' } })}
        className={`w-6 h-6 rounded border text-xs font-bold ${rule.style.fontWeight === 'bold' ? 'bg-slate-200 border-slate-300' : 'bg-white border-slate-200'}`}>
        B
      </button>
      <button onClick={() => onChange({ ...rule, style: { ...rule.style, fontStyle: rule.style.fontStyle === 'italic' ? 'normal' : 'italic' } })}
        className={`w-6 h-6 rounded border text-xs italic ${rule.style.fontStyle === 'italic' ? 'bg-slate-200 border-slate-300' : 'bg-white border-slate-200'}`}>
        I
      </button>

      <input type="color" value={rule.style.color || '#000000'} title="Text color"
        onChange={e => onChange({ ...rule, style: { ...rule.style, color: e.target.value } })}
        className="w-6 h-6 rounded border border-slate-200 cursor-pointer" />
      <input type="color" value={rule.style.backgroundColor || '#ffffff'} title="Background"
        onChange={e => onChange({ ...rule, style: { ...rule.style, backgroundColor: e.target.value } })}
        className="w-6 h-6 rounded border border-slate-200 cursor-pointer" />

      <button onClick={onRemove} className="ml-auto p-0.5 text-slate-300 hover:text-red-500">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create table-column-editor.tsx**

Create `apps/web/src/routes/report-templates/components/table-column-editor.tsx`:

```typescript
import { ChevronDown, ChevronUp, Trash2, Plus } from 'lucide-react';
import { useState } from 'react';
import type { TableColumn, ConditionalRule } from './template-types';
import { ConditionalRuleEditor } from './conditional-rule-editor';

interface Props {
  column: TableColumn;
  index: number;
  onChange: (updated: TableColumn) => void;
  onRemove: () => void;
}

export function TableColumnEditor({ column, index, onChange, onRemove }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Collapsed header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-xs font-semibold text-slate-400 w-5">#{index + 1}</span>
        <span className="text-sm font-medium text-slate-700 flex-1 truncate">{column.header || column.key || 'New Column'}</span>
        <button onClick={e => { e.stopPropagation(); onRemove(); }} className="p-0.5 text-slate-300 hover:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </div>

      {expanded && (
        <div className="p-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-500">Data Key</label>
              <input value={column.key} onChange={e => onChange({ ...column, key: e.target.value })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" placeholder="field_name" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Header Label</label>
              <input value={column.header} onChange={e => onChange({ ...column, header: e.target.value })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" placeholder="Display Name" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-500">Width</label>
              <input value={column.width ?? ''} onChange={e => onChange({ ...column, width: e.target.value })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" placeholder="25% or 100px" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Align</label>
              <select value={column.style?.textAlign ?? 'left'}
                onChange={e => onChange({ ...column, style: { ...column.style, textAlign: e.target.value as any } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none">
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </div>

          {/* Format */}
          <div>
            <label className="text-xs font-medium text-slate-500">Format</label>
            <select value={column.format?.type ?? 'text'}
              onChange={e => onChange({ ...column, format: { ...column.format, type: e.target.value as any } })}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none">
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="datetime">Date/Time</option>
            </select>
          </div>

          {column.format?.type === 'number' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium text-slate-500">Decimals</label>
                <input type="number" min={0} max={10} value={column.format.decimalPlaces ?? ''}
                  onChange={e => onChange({ ...column, format: { ...column.format!, decimalPlaces: Number(e.target.value) } })}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500">Unit</label>
                <input value={column.format.unit ?? ''} placeholder="°C, Pa, %"
                  onChange={e => onChange({ ...column, format: { ...column.format!, unit: e.target.value } })}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
              </div>
            </div>
          )}

          {column.format?.type === 'datetime' && (
            <div>
              <label className="text-xs font-medium text-slate-500">Pattern</label>
              <input value={column.format.pattern ?? ''} placeholder="DD/MM/YYYY HH:mm"
                onChange={e => onChange({ ...column, format: { ...column.format!, pattern: e.target.value } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
          )}

          {/* Text transform */}
          <div>
            <label className="text-xs font-medium text-slate-500">Text Transform</label>
            <select value={column.style?.textTransform ?? 'none'}
              onChange={e => onChange({ ...column, style: { ...column.style, textTransform: e.target.value as any } })}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none">
              <option value="none">None</option>
              <option value="uppercase">UPPERCASE</option>
              <option value="lowercase">lowercase</option>
              <option value="capitalize">Capitalize</option>
            </select>
          </div>

          {/* Conditional rules */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-500">Conditional Formatting</label>
              <button onClick={() => onChange({ ...column, conditionalRules: [...(column.conditionalRules ?? []), { condition: 'gt', value: 0, style: {} }] })}
                className="flex items-center gap-1 text-xs font-medium hover:text-blue-500 transition-colors" style={{ color: 'var(--theme-primary)' }}>
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            <div className="space-y-1.5">
              {(column.conditionalRules ?? []).map((rule, rIdx) => (
                <ConditionalRuleEditor key={rIdx} rule={rule}
                  onChange={updated => {
                    const rules = [...(column.conditionalRules ?? [])];
                    rules[rIdx] = updated;
                    onChange({ ...column, conditionalRules: rules });
                  }}
                  onRemove={() => onChange({ ...column, conditionalRules: column.conditionalRules?.filter((_, i) => i !== rIdx) })}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create table-section-editor.tsx**

Create `apps/web/src/routes/report-templates/components/table-section-editor.tsx`:

```typescript
import { Plus } from 'lucide-react';
import type { TableSection, EntitySlot } from './template-types';
import { TableColumnEditor } from './table-column-editor';

interface Props {
  section: TableSection;
  onChange: (updated: TableSection) => void;
  entitySlots: EntitySlot[];
}

export function TableSectionEditor({ section, onChange, entitySlots }: Props) {
  const addColumn = () => {
    onChange({
      ...section,
      columns: [...section.columns, { key: '', header: '', style: {} }],
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Table Title</label>
        <input value={section.title} onChange={e => onChange({ ...section, title: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" placeholder="e.g. Telemetry Readings" />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Data Source</label>
        <input value={section.dataSource} onChange={e => onChange({ ...section, dataSource: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono outline-none" placeholder="ts.$slot.key[range]" />
        {entitySlots.length > 0 && (
          <p className="text-xs text-slate-400 mt-1">Slots: {entitySlots.map(s => `$${s.name}`).join(', ')}</p>
        )}
      </div>

      {/* Table settings */}
      <div>
        <label className="text-sm font-semibold text-slate-700">Table Settings</label>
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-500">Rows / Page</label>
              <input type="number" min={5} max={200} value={section.tableSettings.maxRowsPerPage}
                onChange={e => onChange({ ...section, tableSettings: { ...section.tableSettings, maxRowsPerPage: Number(e.target.value) } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Body Font Size</label>
              <input type="number" min={6} max={20} value={section.tableSettings.bodyStyle.fontSize}
                onChange={e => onChange({ ...section, tableSettings: { ...section.tableSettings, bodyStyle: { ...section.tableSettings.bodyStyle, fontSize: Number(e.target.value) } } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(['wrapText', 'showBorders', 'stripedRows', 'headerRepeat'] as const).map(key => (
              <label key={key} className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={section.tableSettings[key]}
                  onChange={e => onChange({ ...section, tableSettings: { ...section.tableSettings, [key]: e.target.checked } })}
                  className="rounded" />
                {key === 'wrapText' ? 'Wrap' : key === 'showBorders' ? 'Borders' : key === 'stripedRows' ? 'Striped' : 'Repeat Header'}
              </label>
            ))}
          </div>

          <div>
            <label className="text-xs font-medium text-slate-500">Empty Value</label>
            <input value={section.tableSettings.emptyValue}
              onChange={e => onChange({ ...section, tableSettings: { ...section.tableSettings, emptyValue: e.target.value } })}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" placeholder="\u2014" />
          </div>
        </div>
      </div>

      {/* Columns */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-slate-700">Columns ({section.columns.length})</label>
          <button onClick={addColumn}
            className="flex items-center gap-1 text-xs font-medium hover:text-blue-500 transition-colors" style={{ color: 'var(--theme-primary)' }}>
            <Plus className="w-3.5 h-3.5" /> Add Column
          </button>
        </div>
        <div className="space-y-2">
          {section.columns.map((col, idx) => (
            <TableColumnEditor key={idx} column={col} index={idx}
              onChange={updated => {
                const cols = [...section.columns];
                cols[idx] = updated;
                onChange({ ...section, columns: cols });
              }}
              onRemove={() => onChange({ ...section, columns: section.columns.filter((_, i) => i !== idx) })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/report-templates/components/conditional-rule-editor.tsx apps/web/src/routes/report-templates/components/table-column-editor.tsx apps/web/src/routes/report-templates/components/table-section-editor.tsx
git commit -m "feat(reports): add table section editor with columns and conditional formatting"
```

---

## Task 7: Chart Section Editor

**Files:**
- Create: `apps/web/src/routes/report-templates/components/chart-section-editor.tsx`

- [ ] **Step 1: Create chart-section-editor.tsx**

Create `apps/web/src/routes/report-templates/components/chart-section-editor.tsx`:

```typescript
import { Plus, Trash2 } from 'lucide-react';
import type { ChartSection, EntitySlot } from './template-types';

interface Props {
  section: ChartSection;
  onChange: (updated: ChartSection) => void;
  entitySlots: EntitySlot[];
}

const CHART_TYPES = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
] as const;

const DEFAULT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'];

export function ChartSectionEditor({ section, onChange, entitySlots }: Props) {
  const addSeries = () => {
    const color = DEFAULT_COLORS[section.dataSeries.length % DEFAULT_COLORS.length];
    onChange({
      ...section,
      dataSeries: [...section.dataSeries, { source: '', label: `Series ${section.dataSeries.length + 1}`, color }],
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Chart Title</label>
        <input value={section.title} onChange={e => onChange({ ...section, title: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" placeholder="Temperature Trend" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Chart Type</label>
          <select value={section.chartType}
            onChange={e => onChange({ ...section, chartType: e.target.value as any })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
            {CHART_TYPES.map(ct => <option key={ct.value} value={ct.value}>{ct.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Height (px)</label>
          <input type="number" min={100} max={800} value={section.height}
            onChange={e => onChange({ ...section, height: Number(e.target.value) })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" />
        </div>
      </div>

      <div className="flex gap-4">
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={section.showLegend}
            onChange={e => onChange({ ...section, showLegend: e.target.checked })} className="rounded" />
          Legend
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={section.showGrid}
            onChange={e => onChange({ ...section, showGrid: e.target.checked })} className="rounded" />
          Grid
        </label>
      </div>

      {/* Axes */}
      {section.chartType !== 'pie' && (
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700">Axes</label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-500">X Label</label>
              <input value={section.xAxis.label} onChange={e => onChange({ ...section, xAxis: { ...section.xAxis, label: e.target.value } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">X Type</label>
              <select value={section.xAxis.type ?? 'time'}
                onChange={e => onChange({ ...section, xAxis: { ...section.xAxis, type: e.target.value as any } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none">
                <option value="time">Time</option>
                <option value="linear">Linear</option>
                <option value="category">Category</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs font-medium text-slate-500">Y Label</label>
              <input value={section.yAxis.label} onChange={e => onChange({ ...section, yAxis: { ...section.yAxis, label: e.target.value } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Y Min</label>
              <input type="number" value={section.yAxis.min ?? ''} placeholder="Auto"
                onChange={e => onChange({ ...section, yAxis: { ...section.yAxis, min: e.target.value ? Number(e.target.value) : undefined } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500">Y Max</label>
              <input type="number" value={section.yAxis.max ?? ''} placeholder="Auto"
                onChange={e => onChange({ ...section, yAxis: { ...section.yAxis, max: e.target.value ? Number(e.target.value) : undefined } })}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
            </div>
          </div>
        </div>
      )}

      {/* Data Series */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-slate-700">Data Series ({section.dataSeries.length})</label>
          <button onClick={addSeries}
            className="flex items-center gap-1 text-xs font-medium hover:text-blue-500" style={{ color: 'var(--theme-primary)' }}>
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
        <div className="space-y-2">
          {section.dataSeries.map((series, idx) => (
            <div key={idx} className="p-2.5 border border-slate-200 rounded-xl space-y-2">
              <div className="flex items-center gap-2">
                <input type="color" value={series.color}
                  onChange={e => {
                    const ds = [...section.dataSeries];
                    ds[idx] = { ...series, color: e.target.value };
                    onChange({ ...section, dataSeries: ds });
                  }}
                  className="w-6 h-6 rounded border border-slate-200 cursor-pointer" />
                <input value={series.label} placeholder="Label"
                  onChange={e => {
                    const ds = [...section.dataSeries];
                    ds[idx] = { ...series, label: e.target.value };
                    onChange({ ...section, dataSeries: ds });
                  }}
                  className="flex-1 border border-slate-200 rounded-lg px-2 py-1 text-sm outline-none" />
                <button onClick={() => onChange({ ...section, dataSeries: section.dataSeries.filter((_, i) => i !== idx) })}
                  className="p-0.5 text-slate-300 hover:text-red-500">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <input value={series.source} placeholder="ts.$slot.key[range]"
                onChange={e => {
                  const ds = [...section.dataSeries];
                  ds[idx] = { ...series, source: e.target.value };
                  onChange({ ...section, dataSeries: ds });
                }}
                className="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm font-mono outline-none" />
            </div>
          ))}
        </div>
        {entitySlots.length > 0 && (
          <p className="text-xs text-slate-400 mt-1">Slots: {entitySlots.map(s => `$${s.name}`).join(', ')}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/report-templates/components/chart-section-editor.tsx
git commit -m "feat(reports): add chart section editor with series and axis config"
```

---

## Task 8: Key-Value + Signature Section Editors

**Files:**
- Create: `apps/web/src/routes/report-templates/components/kv-section-editor.tsx`
- Create: `apps/web/src/routes/report-templates/components/signature-section-editor.tsx`

- [ ] **Step 1: Create kv-section-editor.tsx**

Create `apps/web/src/routes/report-templates/components/kv-section-editor.tsx`:

```typescript
import { Plus, Trash2 } from 'lucide-react';
import type { KVSection } from './template-types';

interface Props {
  section: KVSection;
  onChange: (updated: KVSection) => void;
}

export function KVSectionEditor({ section, onChange }: Props) {
  const addEntry = () => {
    onChange({
      ...section,
      entries: [...section.entries, { label: '', value: '' }],
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Section Title</label>
        <input value={section.title} onChange={e => onChange({ ...section, title: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" placeholder="Filter Details" />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Layout</label>
        <select value={section.layout}
          onChange={e => onChange({ ...section, layout: e.target.value as any })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
          <option value="one_column">1 Column</option>
          <option value="two_column">2 Columns</option>
          <option value="three_column">3 Columns</option>
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-slate-700">Entries ({section.entries.length})</label>
          <button onClick={addEntry}
            className="flex items-center gap-1 text-xs font-medium hover:text-blue-500" style={{ color: 'var(--theme-primary)' }}>
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
        <div className="space-y-2">
          {section.entries.map((entry, idx) => (
            <div key={idx} className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg">
              <div className="flex-1 space-y-1.5">
                <input value={entry.label} placeholder="Label"
                  onChange={e => {
                    const entries = [...section.entries];
                    entries[idx] = { ...entry, label: e.target.value };
                    onChange({ ...section, entries });
                  }}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-medium outline-none bg-white" />
                <input value={entry.value} placeholder="{{attr.$slot.field}}"
                  onChange={e => {
                    const entries = [...section.entries];
                    entries[idx] = { ...entry, value: e.target.value };
                    onChange({ ...section, entries });
                  }}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono outline-none bg-white" />
                <select value={entry.format?.type ?? 'text'}
                  onChange={e => {
                    const entries = [...section.entries];
                    entries[idx] = { ...entry, format: { ...entry.format, type: e.target.value as any } };
                    onChange({ ...section, entries });
                  }}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white">
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="datetime">Date/Time</option>
                </select>
              </div>
              <button onClick={() => onChange({ ...section, entries: section.entries.filter((_, i) => i !== idx) })}
                className="p-1 text-slate-300 hover:text-red-500 mt-1">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create signature-section-editor.tsx**

Create `apps/web/src/routes/report-templates/components/signature-section-editor.tsx`:

```typescript
import { Plus, Trash2 } from 'lucide-react';
import type { SignatureSection, SignatureConfig, SignerDef } from './template-types';

interface Props {
  section: SignatureSection;
  onChange: (updated: SignatureSection) => void;
  signatureConfig: SignatureConfig;
  onSignatureConfigChange: (sc: SignatureConfig) => void;
}

export function SignatureSectionEditor({ section, onChange, signatureConfig, onSignatureConfigChange }: Props) {
  const addSigner = () => {
    const newSigner: SignerDef = { role: `signer_${signatureConfig.signers.length + 1}`, label: '', required: true };
    onSignatureConfigChange({
      ...signatureConfig,
      signers: [...signatureConfig.signers, newSigner],
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Block Label</label>
        <input value={section.label} onChange={e => onChange({ ...section, label: e.target.value })}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" placeholder="Electronic Signature" />
      </div>

      {/* Signature config (shared across template) */}
      <div className="border-t border-slate-100 pt-4">
        <label className="text-sm font-semibold text-slate-700">Signature Configuration</label>
        <p className="text-xs text-slate-400 mb-3">These settings apply to the entire template</p>

        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer mb-3">
          <input type="checkbox" checked={signatureConfig.required}
            onChange={e => onSignatureConfigChange({ ...signatureConfig, required: e.target.checked })}
            className="rounded" />
          Signatures required for this report
        </label>

        <div className="mb-3">
          <label className="text-xs font-medium text-slate-500">Signature Meaning</label>
          <textarea value={signatureConfig.meaning}
            onChange={e => onSignatureConfigChange({ ...signatureConfig, meaning: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none resize-none" rows={2}
            placeholder="I have reviewed and approve this report" />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold text-slate-500">Signers ({signatureConfig.signers.length})</label>
            <button onClick={addSigner}
              className="flex items-center gap-1 text-xs font-medium hover:text-blue-500" style={{ color: 'var(--theme-primary)' }}>
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="space-y-2">
            {signatureConfig.signers.map((signer, idx) => (
              <div key={idx} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg">
                <div className="flex-1 grid grid-cols-2 gap-1.5">
                  <input value={signer.role} placeholder="Role key"
                    onChange={e => {
                      const signers = [...signatureConfig.signers];
                      signers[idx] = { ...signer, role: e.target.value };
                      onSignatureConfigChange({ ...signatureConfig, signers });
                    }}
                    className="border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono outline-none bg-white" />
                  <input value={signer.label} placeholder="Display label"
                    onChange={e => {
                      const signers = [...signatureConfig.signers];
                      signers[idx] = { ...signer, label: e.target.value };
                      onSignatureConfigChange({ ...signatureConfig, signers });
                    }}
                    className="border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white" />
                </div>
                <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer whitespace-nowrap">
                  <input type="checkbox" checked={signer.required}
                    onChange={e => {
                      const signers = [...signatureConfig.signers];
                      signers[idx] = { ...signer, required: e.target.checked };
                      onSignatureConfigChange({ ...signatureConfig, signers });
                    }}
                    className="rounded" />
                  Req
                </label>
                <button onClick={() => onSignatureConfigChange({ ...signatureConfig, signers: signatureConfig.signers.filter((_, i) => i !== idx) })}
                  className="p-0.5 text-slate-300 hover:text-red-500">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Update section signers list to match config */}
        <div className="mt-3">
          <label className="text-xs font-medium text-slate-500">Signers in this block</label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {signatureConfig.signers.map(signer => (
              <label key={signer.role} className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer bg-slate-50 px-2 py-1 rounded-lg">
                <input type="checkbox" checked={section.signers.includes(signer.role)}
                  onChange={e => {
                    const signers = e.target.checked
                      ? [...section.signers, signer.role]
                      : section.signers.filter(r => r !== signer.role);
                    onChange({ ...section, signers });
                  }}
                  className="rounded" />
                {signer.label || signer.role}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/report-templates/components/kv-section-editor.tsx apps/web/src/routes/report-templates/components/signature-section-editor.tsx
git commit -m "feat(reports): add key-value and signature section editors"
```

---

## Task 9: Header/Footer Editor

**Files:**
- Create: `apps/web/src/routes/report-templates/components/header-footer-editor.tsx`

- [ ] **Step 1: Create header-footer-editor.tsx**

Create `apps/web/src/routes/report-templates/components/header-footer-editor.tsx`:

```typescript
import { Plus, Trash2 } from 'lucide-react';
import type { HeaderFooterConfig, HeaderFooterElement } from './template-types';

interface Props {
  label: string;
  config: HeaderFooterConfig;
  onChange: (updated: HeaderFooterConfig) => void;
}

export function HeaderFooterEditor({ label, config, onChange }: Props) {
  const addElement = (type: 'text' | 'image') => {
    const el: HeaderFooterElement = type === 'text'
      ? { type: 'text', content: '', position: 'left', style: { fontSize: 10 } }
      : { type: 'image', source: 'branding_logo', position: 'left', width: 120 };
    onChange({ ...config, elements: [...config.elements, el] });
  };

  return (
    <div className="p-4">
      <h3 className="text-sm font-bold text-slate-800 mb-1">{label}</h3>
      <p className="text-xs text-slate-400 mb-4">Configure {label.toLowerCase()} elements</p>

      <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer mb-4">
        <input type="checkbox" checked={config.enabled}
          onChange={e => onChange({ ...config, enabled: e.target.checked })}
          className="rounded" />
        Enable {label.toLowerCase()}
      </label>

      {config.enabled && (
        <>
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1">Height (px)</label>
            <input type="number" min={20} max={200} value={config.height}
              onChange={e => onChange({ ...config, height: Number(e.target.value) })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none" />
          </div>

          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-slate-700">Elements ({config.elements.length})</label>
            <div className="flex gap-1">
              <button onClick={() => addElement('text')}
                className="px-2 py-1 text-xs font-medium rounded-lg hover:bg-slate-100 transition-colors" style={{ color: 'var(--theme-primary)' }}>
                + Text
              </button>
              <button onClick={() => addElement('image')}
                className="px-2 py-1 text-xs font-medium rounded-lg hover:bg-slate-100 transition-colors" style={{ color: 'var(--theme-primary)' }}>
                + Image
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {config.elements.map((el, idx) => (
              <div key={idx} className="p-3 border border-slate-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 uppercase">{el.type}</span>
                  <button onClick={() => onChange({ ...config, elements: config.elements.filter((_, i) => i !== idx) })}
                    className="p-0.5 text-slate-300 hover:text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {el.type === 'text' ? (
                  <input value={el.content ?? ''} placeholder="Text or {{variable.tag}}"
                    onChange={e => {
                      const elements = [...config.elements];
                      elements[idx] = { ...el, content: e.target.value };
                      onChange({ ...config, elements });
                    }}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
                ) : (
                  <select value={el.source ?? 'branding_logo'}
                    onChange={e => {
                      const elements = [...config.elements];
                      elements[idx] = { ...el, source: e.target.value };
                      onChange({ ...config, elements });
                    }}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none">
                    <option value="branding_logo">Organization Logo</option>
                  </select>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-slate-500">Position</label>
                    <select value={el.position}
                      onChange={e => {
                        const elements = [...config.elements];
                        elements[idx] = { ...el, position: e.target.value as any };
                        onChange({ ...config, elements });
                      }}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none">
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  {el.type === 'text' && (
                    <div>
                      <label className="text-xs font-medium text-slate-500">Font Size</label>
                      <input type="number" min={6} max={24} value={el.style?.fontSize ?? 10}
                        onChange={e => {
                          const elements = [...config.elements];
                          elements[idx] = { ...el, style: { ...el.style, fontSize: Number(e.target.value) } };
                          onChange({ ...config, elements });
                        }}
                        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none" />
                    </div>
                  )}
                  {el.type === 'image' && (
                    <div>
                      <label className="text-xs font-medium text-slate-500">Width (px)</label>
                      <input type="number" min={20} max={400} value={el.width ?? 120}
                        onChange={e => {
                          const elements = [...config.elements];
                          elements[idx] = { ...el, width: Number(e.target.value) };
                          onChange({ ...config, elements });
                        }}
                        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/report-templates/components/header-footer-editor.tsx
git commit -m "feat(reports): add header/footer editor with text and image elements"
```

---

## Task 10: Entity Slot Editor + Variable Tag Picker

**Files:**
- Create: `apps/web/src/routes/report-templates/components/entity-slot-editor.tsx`
- Create: `apps/web/src/routes/report-templates/components/variable-tag-picker.tsx`

- [ ] **Step 1: Create entity-slot-editor.tsx**

Create `apps/web/src/routes/report-templates/components/entity-slot-editor.tsx`:

```typescript
import { Plus, Trash2 } from 'lucide-react';
import type { EntitySlot } from './template-types';

interface Props {
  slots: EntitySlot[];
  onChange: (slots: EntitySlot[]) => void;
}

export function EntitySlotEditor({ slots, onChange }: Props) {
  const addSlot = () => {
    onChange([...slots, { name: `slot_${slots.length + 1}`, label: '', type: 'asset_instance' }]);
  };

  return (
    <div className="p-4 border-b border-slate-100">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Entity Slots</h3>
        <button onClick={addSlot}
          className="p-1 rounded-lg hover:bg-slate-100 transition-colors" style={{ color: 'var(--theme-primary)' }}>
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-3">Define placeholders that users fill when generating reports</p>

      <div className="space-y-2">
        {slots.map((slot, idx) => (
          <div key={idx} className="p-2.5 bg-slate-50 rounded-xl space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">${slot.name}</span>
              <div className="flex-1" />
              <button onClick={() => onChange(slots.filter((_, i) => i !== idx))}
                className="p-0.5 text-slate-300 hover:text-red-500">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <input value={slot.name} placeholder="Variable name"
              onChange={e => {
                const s = [...slots];
                s[idx] = { ...slot, name: e.target.value };
                onChange(s);
              }}
              className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono outline-none bg-white" />
            <input value={slot.label} placeholder="Display label"
              onChange={e => {
                const s = [...slots];
                s[idx] = { ...slot, label: e.target.value };
                onChange(s);
              }}
              className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white" />
            <select value={slot.type}
              onChange={e => {
                const s = [...slots];
                s[idx] = { ...slot, type: e.target.value as any };
                onChange(s);
              }}
              className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white">
              <option value="asset_instance">Asset Instance</option>
              <option value="equipment_group">Equipment Group</option>
              <option value="uns_path">UNS Path</option>
            </select>
            {slot.type === 'asset_instance' && (
              <input value={slot.templateFilter ?? ''} placeholder="Template filter (optional)"
                onChange={e => {
                  const s = [...slots];
                  s[idx] = { ...slot, templateFilter: e.target.value };
                  onChange(s);
                }}
                className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white" />
            )}
            {slot.type === 'uns_path' && (
              <input value={slot.pathPrefix ?? ''} placeholder="Path prefix (optional)"
                onChange={e => {
                  const s = [...slots];
                  s[idx] = { ...slot, pathPrefix: e.target.value };
                  onChange(s);
                }}
                className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs outline-none bg-white" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create variable-tag-picker.tsx**

Create `apps/web/src/routes/report-templates/components/variable-tag-picker.tsx`:

```typescript
import { useState } from 'react';
import { Search, Copy, Check } from 'lucide-react';
import type { EntitySlot } from './template-types';

interface Props {
  entitySlots: EntitySlot[];
}

interface TagItem {
  tag: string;
  description: string;
}

interface TagCategory {
  label: string;
  items: TagItem[];
}

function buildCategories(entitySlots: EntitySlot[]): TagCategory[] {
  const categories: TagCategory[] = [];

  if (entitySlots.length > 0) {
    categories.push({
      label: 'Entity Attributes',
      items: entitySlots.flatMap(slot => [
        { tag: `{{attr.$${slot.name}.<field>}}`, description: `Attribute from ${slot.label || slot.name}` },
        { tag: `{{attr.$${slot.name}.*}}`, description: `All attributes of ${slot.label || slot.name}` },
      ]),
    });
    categories.push({
      label: 'Telemetry',
      items: entitySlots.flatMap(slot => [
        { tag: `{{ts.$${slot.name}.<key>[last]}}`, description: `Latest value` },
        { tag: `{{ts.$${slot.name}.<key>[avg:24h]}}`, description: `24h average` },
        { tag: `{{ts.$${slot.name}.<key>[range]}}`, description: `Full series (tables/charts)` },
      ]),
    });
    categories.push({
      label: 'Identifiers',
      items: entitySlots.map(slot => ({
        tag: `{{ident.$${slot.name}.<type>}}`,
        description: `Identifier of ${slot.label || slot.name}`,
      })),
    });
  }

  categories.push({
    label: 'Timestamps',
    items: [
      { tag: '{{time.now}}', description: 'Current time' },
      { tag: '{{time.range.start}}', description: 'Report range start' },
      { tag: '{{time.range.end}}', description: 'Report range end' },
    ],
  });

  categories.push({
    label: 'Metadata',
    items: [
      { tag: '{{meta.report.name}}', description: 'Report name' },
      { tag: '{{meta.user.name}}', description: 'Generated by' },
      { tag: '{{meta.org.name}}', description: 'Organization name' },
      { tag: '{{meta.template.name}}', description: 'Template name' },
    ],
  });

  categories.push({
    label: 'Page',
    items: [
      { tag: '{{page.current}}', description: 'Current page number' },
      { tag: '{{page.total}}', description: 'Total pages' },
    ],
  });

  return categories;
}

export function VariableTagPicker({ entitySlots }: Props) {
  const [search, setSearch] = useState('');
  const [copiedTag, setCopiedTag] = useState<string | null>(null);

  const categories = buildCategories(entitySlots);

  const filtered = search
    ? categories.map(cat => ({
        ...cat,
        items: cat.items.filter(i =>
          i.tag.toLowerCase().includes(search.toLowerCase()) ||
          i.description.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(cat => cat.items.length > 0)
    : categories;

  const copyTag = (tag: string) => {
    navigator.clipboard.writeText(tag);
    setCopiedTag(tag);
    setTimeout(() => setCopiedTag(null), 1500);
  };

  return (
    <div className="p-4">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Variable Tags</h3>

      <div className="relative mb-3">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="w-full border border-slate-200 rounded-lg pl-7 pr-3 py-1.5 text-xs outline-none"
          placeholder="Search tags..." />
      </div>

      <div className="space-y-3 max-h-80 overflow-y-auto">
        {filtered.map(cat => (
          <div key={cat.label}>
            <div className="text-xs font-semibold text-slate-400 mb-1">{cat.label}</div>
            <div className="space-y-0.5">
              {cat.items.map(item => (
                <button key={item.tag} onClick={() => copyTag(item.tag)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-blue-600 truncate">{item.tag}</div>
                    <div className="text-xs text-slate-400 truncate">{item.description}</div>
                  </div>
                  <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {copiedTag === item.tag ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-slate-400" />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {entitySlots.length === 0 && (
        <p className="text-xs text-amber-500 mt-2">Add entity slots above to see entity-specific tags</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/report-templates/components/entity-slot-editor.tsx apps/web/src/routes/report-templates/components/variable-tag-picker.tsx
git commit -m "feat(reports): add entity slot editor and variable tag picker"
```

---

## Task 11: Page Settings Editor

**Files:**
- Create: `apps/web/src/routes/report-templates/components/page-settings-editor.tsx`

- [ ] **Step 1: Create page-settings-editor.tsx**

Create `apps/web/src/routes/report-templates/components/page-settings-editor.tsx`:

```typescript
import type { PageSettings } from './template-types';

interface Props {
  settings: PageSettings;
  onChange: (updated: PageSettings) => void;
}

export function PageSettingsEditor({ settings, onChange }: Props) {
  return (
    <div className="p-4">
      <h3 className="text-sm font-bold text-slate-800 mb-1">Page Settings</h3>
      <p className="text-xs text-slate-400 mb-4">Configure page layout for PDF output</p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Page Size</label>
          <select value={settings.size}
            onChange={e => onChange({ ...settings, size: e.target.value as any })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm outline-none">
            <option value="A4">A4 (210 x 297 mm)</option>
            <option value="Letter">Letter (8.5 x 11 in)</option>
            <option value="Legal">Legal (8.5 x 14 in)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Orientation</label>
          <div className="flex gap-2">
            {(['portrait', 'landscape'] as const).map(o => (
              <button key={o} onClick={() => onChange({ ...settings, orientation: o })}
                className={`flex-1 py-2 rounded-xl text-sm font-medium border-2 transition-colors ${settings.orientation === o ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                {o.charAt(0).toUpperCase() + o.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Margins (mm)</label>
          <div className="grid grid-cols-2 gap-3">
            {(['top', 'right', 'bottom', 'left'] as const).map(side => (
              <div key={side}>
                <label className="text-xs font-medium text-slate-500 capitalize">{side}</label>
                <input type="number" min={0} max={50} value={settings.margins[side]}
                  onChange={e => onChange({ ...settings, margins: { ...settings.margins, [side]: Number(e.target.value) } })}
                  className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm outline-none" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/report-templates/components/page-settings-editor.tsx
git commit -m "feat(reports): add page settings editor"
```

---

## Task 12: Build Verification + Fix Compilation

**Files:**
- Potentially fix any imports or type issues across all new files

- [ ] **Step 1: Run TypeScript check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 2: Fix any compilation errors that appear**

Common issues to watch for:
- Missing imports (ensure all component imports in `editor.tsx` match the filenames)
- Type mismatches between `Section` union type and editor props
- Any `as any` casts that TypeScript rejects

- [ ] **Step 3: Start dev server and verify the editor loads**

```bash
cd apps/web && npx vite
```

Navigate to `http://localhost:5175/report-templates`, create a template, then click the Edit button. Verify:
- 3-panel layout renders (palette left, canvas center, properties right)
- Adding sections from palette works
- Selecting a section shows its editor in the right panel
- Drag-and-drop reordering works
- Header/footer click opens the correct editor
- Page settings button works
- Save button calls the API and shows toast

- [ ] **Step 4: Fix any runtime issues found during testing**

- [ ] **Step 5: Commit all fixes**

```bash
git add -A
git commit -m "fix(reports): resolve compilation and runtime issues in template designer"
```

---

## Task 13: Polish + Unsaved Changes Warning

**Files:**
- Modify: `apps/web/src/routes/report-templates/editor.tsx`

- [ ] **Step 1: Add beforeunload warning for unsaved changes**

In `editor.tsx`, add this effect after the state declarations:

```typescript
import { useState, useCallback, useEffect } from 'react';

// ... inside the component, after the `dirty` state:

useEffect(() => {
  const handler = (e: BeforeUnloadEvent) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, [dirty]);
```

- [ ] **Step 2: Add keyboard shortcut Ctrl+S to save**

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && canUpdate) handleSave();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [dirty, canUpdate, handleSave]);
```

Note: `handleSave` needs to be wrapped in `useCallback` for this to work properly. Update the `handleSave` definition:

```typescript
const handleSave = useCallback(() => {
  if (!config || !id) return;
  reauth.execute('UPDATE_REPORT_TEMPLATE', async (password?: string) => {
    setSaving(true);
    try {
      const body = { name: templateName, description: templateDescription || undefined, config, changelog: 'Updated via designer' };
      if (password) await apiClient.putWithReauth(`/api/report-templates/${id}`, body, password);
      else await apiClient.put(`/api/report-templates/${id}`, body);
      setDirty(false);
      toast.success('Template saved');
    } catch (err: any) {
      toast.error('Save failed', err.message || 'Could not save template');
      throw err;
    } finally {
      setSaving(false);
    }
  });
}, [config, id, templateName, templateDescription, reauth, toast]);
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/report-templates/editor.tsx
git commit -m "feat(reports): add unsaved changes warning and Ctrl+S save shortcut"
```

---

## Task 14: Final Integration Test

- [ ] **Step 1: Start the API and frontend dev servers**

```bash
# Terminal 1 - API (if not already running)
cd apps/api && npx tsx src/app.ts

# Terminal 2 - Frontend
cd apps/web && npx vite
```

- [ ] **Step 2: End-to-end verification**

1. Go to `/report-templates`
2. Create a new template "Test Report"
3. Click Edit button on the new template
4. Verify the 3-panel layout loads
5. Add one of each section type from the palette (text, table, chart, key-value, signature, page break)
6. Configure each section: enter text content, add table columns with conditional rules, add chart series, add KV entries, configure signers
7. Drag sections to reorder them
8. Click header to edit: add a text element and an image element
9. Click footer to edit: add page number text
10. Add an entity slot named "primaryFilter"
11. Verify variable tag picker shows entity-specific tags
12. Click Page Settings, change to landscape
13. Click Save, verify reauth dialog appears, confirm, verify success toast
14. Reload page, verify all settings persisted
15. Go back to list, verify the template version incremented

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "feat(reports): complete Phase B template designer UI"
```
