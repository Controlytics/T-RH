# DigiLog Reports Module — Frontend Implementation Guide

**Target Path:** `apps/web/src/routes/reports/` and `apps/web/src/routes/report-templates/`
**Key Dependencies:** ReactFlow (existing), recharts (existing), react-hook-form + zod (existing)

---

## 1. Route Structure

```
apps/web/src/routes/
├── report-templates/
│   ├── index.tsx                    # Template list page
│   ├── [id]/
│   │   └── edit.tsx                 # Template designer/editor
│   ├── new.tsx                      # Create new template (redirects to editor)
│   └── components/
│       ├── template-list-table.tsx   # Template list with status badges
│       ├── template-designer.tsx     # Main designer component
│       ├── section-palette.tsx       # Draggable section types (sidebar)
│       ├── section-editor.tsx        # Section config forms
│       ├── section-preview.tsx       # Live preview of a section
│       ├── header-footer-editor.tsx  # Header/footer element editor
│       ├── variable-tag-picker.tsx   # Browse & insert variable tags
│       ├── table-column-editor.tsx   # Column config + conditional rules
│       ├── chart-config-editor.tsx   # Chart series + axis config
│       ├── entity-slot-editor.tsx    # Entity slot definitions
│       ├── signature-config.tsx      # Signature block settings
│       ├── conditional-rule-form.tsx # Condition builder (gt/lt/between + style)
│       └── template-preview.tsx      # Full template preview (read-only)
├── reports/
│   ├── index.tsx                    # Generated reports list
│   ├── [id]/
│   │   ├── index.tsx               # Report detail + PDF viewer
│   │   └── sign.tsx                # Signature collection page
│   ├── generate.tsx                # Report generation wizard
│   └── components/
│       ├── report-list-table.tsx    # Reports list with status/signature badges
│       ├── generation-wizard.tsx    # Step-by-step generation flow
│       ├── entity-slot-filler.tsx   # UI for selecting entities for slots
│       ├── time-range-picker.tsx    # Date range selector
│       ├── report-pdf-viewer.tsx    # Embedded PDF viewer (iframe or react-pdf)
│       ├── signature-dialog.tsx     # Re-auth + sign dialog
│       └── report-status-badge.tsx  # DRAFT/PENDING/SIGNED badges
```

---

## 2. React Router Routes

Add to the main router config:

```typescript
// Report Templates
{ path: '/report-templates', element: <ReportTemplateList />, permission: 'REPORT_TEMPLATE_READ' },
{ path: '/report-templates/new', element: <ReportTemplateEditor />, permission: 'REPORT_TEMPLATE_CREATE' },
{ path: '/report-templates/:id/edit', element: <ReportTemplateEditor />, permission: 'REPORT_TEMPLATE_UPDATE' },

// Reports
{ path: '/reports', element: <ReportList />, permission: 'REPORT_VIEW' },
{ path: '/reports/generate', element: <ReportGenerate />, permission: 'REPORT_GENERATE' },
{ path: '/reports/generate/:templateId', element: <ReportGenerate />, permission: 'REPORT_GENERATE' },
{ path: '/reports/:id', element: <ReportDetail />, permission: 'REPORT_VIEW' },
{ path: '/reports/:id/sign', element: <ReportSign />, permission: 'REPORT_SIGN' },
```

---

## 3. Sidebar Config

Add to sidebar navigation:

```json
{
  "label": "Reports",
  "icon": "FileText",
  "children": [
    { "label": "Report Templates", "path": "/report-templates", "permission": "REPORT_TEMPLATE_READ", "icon": "LayoutTemplate" },
    { "label": "Generated Reports", "path": "/reports", "permission": "REPORT_VIEW", "icon": "FileOutput" },
    { "label": "Generate Report", "path": "/reports/generate", "permission": "REPORT_GENERATE", "icon": "FilePlus" }
  ]
}
```

---

## 4. Key Page Implementations

### 4.1 Template Designer (`report-templates/[id]/edit.tsx`)

This is the most complex page — a visual template builder. Use a **vertical section list** with drag-to-reorder (not ReactFlow, since report layout is linear).

**Architecture:**
- Left sidebar: Section palette (drag source) + Entity slot editor
- Center: Live section list with inline preview + edit toggles
- Right panel: Active section's property editor
- Top bar: Template name, page settings, save, preview buttons

```
┌──────────────────────────────────────────────────────────────┐
│  Template Name: [Monthly Filter Report]   [Settings] [Save] │
├─────────┬──────────────────────────────┬─────────────────────┤
│ PALETTE │        SECTION LIST          │  SECTION EDITOR     │
│         │                              │                     │
│ ○ Text  │ ┌────────────────────────┐   │  Table Settings     │
│ ○ Table │ │ HEADER (click to edit) │   │  ─────────────────  │
│ ○ Chart │ ├────────────────────────┤   │  Max rows/page: [40]│
│ ○ K/V   │ │ § Text Section         │   │  Wrap text:    [✓]  │
│ ○ Sign  │ ├────────────────────────┤   │  Borders:      [✓]  │
│ ○ Break │ │ § Table Section ← sel  │   │  Striped:      [✓]  │
│         │ ├────────────────────────┤   │  Font:    [Arial ▾] │
│ SLOTS   │ │ § Chart Section        │   │  Font size:    [10] │
│ ─────── │ ├────────────────────────┤   │                     │
│ + Add   │ │ § Signature Block      │   │  COLUMNS            │
│ ○ filter│ ├────────────────────────┤   │  ─────────────────  │
│ ○ ahu   │ │ FOOTER (click to edit) │   │  [+ Add Column]     │
│         │ └────────────────────────┘   │  Col 1: timestamp   │
│ TAGS    │                              │  Col 2: value       │
│ ─────── │                              │    → Cond Rules [+] │
│ {{...}} │                              │                     │
└─────────┴──────────────────────────────┴─────────────────────┘
```

**Implementation approach:**

```typescript
// template-designer.tsx
export function TemplateDesigner() {
  const [template, setTemplate] = useState<TemplateConfig>(defaultTemplate);
  const [selectedSectionIdx, setSelectedSectionIdx] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  // Drag-and-drop for section reordering
  // Use @dnd-kit/core or native HTML5 drag-and-drop

  const addSection = (type: SectionType) => {
    const newSection = createDefaultSection(type);
    setTemplate(prev => ({
      ...prev,
      sections: [...prev.sections, newSection],
    }));
    setSelectedSectionIdx(template.sections.length);
  };

  const updateSection = (idx: number, updated: Section) => {
    setTemplate(prev => ({
      ...prev,
      sections: prev.sections.map((s, i) => i === idx ? updated : s),
    }));
  };

  const removeSection = (idx: number) => {
    setTemplate(prev => ({
      ...prev,
      sections: prev.sections.filter((_, i) => i !== idx),
    }));
    setSelectedSectionIdx(null);
  };

  return (
    <div className="flex h-full">
      <SectionPalette onAdd={addSection} />
      <SectionList
        sections={template.sections}
        header={template.header}
        footer={template.footer}
        selected={selectedSectionIdx}
        onSelect={setSelectedSectionIdx}
        onReorder={handleReorder}
        onRemove={removeSection}
      />
      <SectionEditor
        section={selectedSectionIdx != null ? template.sections[selectedSectionIdx] : null}
        onUpdate={(updated) => updateSection(selectedSectionIdx!, updated)}
        entitySlots={template.entitySlots}
      />
    </div>
  );
}
```

### 4.2 Variable Tag Picker (`variable-tag-picker.tsx`)

A browsable tree/search component that helps users discover and insert variable tags:

```typescript
export function VariableTagPicker({ entitySlots, onInsert }: Props) {
  const [search, setSearch] = useState('');

  const categories = [
    {
      label: 'Entity Attributes',
      prefix: 'attr',
      items: entitySlots.map(slot => ({
        tag: `{{attr.$${slot.name}.<field>}}`,
        description: `Attribute from ${slot.label}`,
      })),
    },
    {
      label: 'Telemetry',
      prefix: 'ts',
      items: [
        { tag: `{{ts.$<slot>.<key>[last]}}`, description: 'Latest telemetry value' },
        { tag: `{{ts.$<slot>.<key>[avg:24h]}}`, description: 'Average over time window' },
        { tag: `{{ts.$<slot>.<key>[range]}}`, description: 'Full series (for tables/charts)' },
      ],
    },
    {
      label: 'Identifiers', prefix: 'ident',
      items: [{ tag: `{{ident.$<slot>.<type>}}`, description: 'Entity identifier' }],
    },
    {
      label: 'Timestamps', prefix: 'time',
      items: [
        { tag: '{{time.now}}', description: 'Current time' },
        { tag: '{{time.range.start}}', description: 'Report range start' },
        { tag: '{{time.range.end}}', description: 'Report range end' },
      ],
    },
    {
      label: 'Metadata', prefix: 'meta',
      items: [
        { tag: '{{meta.report.name}}', description: 'Report name' },
        { tag: '{{meta.user.name}}', description: 'Generated by user' },
        { tag: '{{meta.org.name}}', description: 'Organization name' },
      ],
    },
    {
      label: 'UNS Paths', prefix: 'uns',
      items: [{ tag: '{{uns.<path>/*}}', description: 'UNS wildcard path' }],
    },
  ];

  return (
    <div className="variable-tag-picker">
      <input placeholder="Search tags..." value={search} onChange={e => setSearch(e.target.value)} />
      {categories.map(cat => (
        <div key={cat.prefix}>
          <h4>{cat.label}</h4>
          {cat.items
            .filter(i => !search || i.tag.includes(search) || i.description.includes(search))
            .map(item => (
              <button key={item.tag} onClick={() => onInsert(item.tag)} className="tag-item">
                <code>{item.tag}</code>
                <span>{item.description}</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}
```

### 4.3 Conditional Rule Builder (`conditional-rule-form.tsx`)

```typescript
export function ConditionalRuleForm({ rule, onChange, onRemove }: Props) {
  return (
    <div className="flex items-center gap-2 p-2 border rounded">
      <select value={rule.condition} onChange={e => onChange({ ...rule, condition: e.target.value })}>
        <option value="gt">Greater than</option>
        <option value="gte">Greater or equal</option>
        <option value="lt">Less than</option>
        <option value="lte">Less or equal</option>
        <option value="eq">Equals</option>
        <option value="neq">Not equals</option>
        <option value="between">Between</option>
        <option value="contains">Contains</option>
        <option value="empty">Is empty</option>
        <option value="not_empty">Is not empty</option>
      </select>

      {rule.condition === 'between' ? (
        <>
          <input type="number" placeholder="Min" value={rule.min} onChange={e => onChange({ ...rule, min: +e.target.value })} />
          <span>and</span>
          <input type="number" placeholder="Max" value={rule.max} onChange={e => onChange({ ...rule, max: +e.target.value })} />
        </>
      ) : !['empty', 'not_empty'].includes(rule.condition) ? (
        <input type="text" placeholder="Value" value={rule.value} onChange={e => onChange({ ...rule, value: e.target.value })} />
      ) : null}

      <span className="text-sm text-slate-500">→ Style:</span>

      <button
        className={`px-2 py-1 border rounded ${rule.style?.fontWeight === 'bold' ? 'bg-slate-200 font-bold' : ''}`}
        onClick={() => onChange({ ...rule, style: { ...rule.style, fontWeight: rule.style?.fontWeight === 'bold' ? 'normal' : 'bold' } })}
      >
        B
      </button>
      <button
        className={`px-2 py-1 border rounded ${rule.style?.fontStyle === 'italic' ? 'bg-slate-200 italic' : ''}`}
        onClick={() => onChange({ ...rule, style: { ...rule.style, fontStyle: rule.style?.fontStyle === 'italic' ? 'normal' : 'italic' } })}
      >
        I
      </button>
      <input
        type="color"
        value={rule.style?.color || '#000000'}
        onChange={e => onChange({ ...rule, style: { ...rule.style, color: e.target.value } })}
        title="Text color"
      />
      <input
        type="color"
        value={rule.style?.backgroundColor || '#ffffff'}
        onChange={e => onChange({ ...rule, style: { ...rule.style, backgroundColor: e.target.value } })}
        title="Background color"
      />

      <button onClick={onRemove} className="text-red-500 hover:text-red-700">✕</button>
    </div>
  );
}
```

### 4.4 Table Column Editor (`table-column-editor.tsx`)

```typescript
export function TableColumnEditor({ column, onChange, entitySlots }: Props) {
  return (
    <div className="space-y-3 p-3 border rounded">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label>Column Key (data field)</label>
          <input value={column.key} onChange={e => onChange({ ...column, key: e.target.value })} />
        </div>
        <div>
          <label>Header Label</label>
          <input value={column.header} onChange={e => onChange({ ...column, header: e.target.value })} />
        </div>
        <div>
          <label>Width</label>
          <input placeholder="25% or 100px" value={column.width} onChange={e => onChange({ ...column, width: e.target.value })} />
        </div>
        <div>
          <label>Text Align</label>
          <select value={column.style?.textAlign || 'left'} onChange={e => onChange({ ...column, style: { ...column.style, textAlign: e.target.value } })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
      </div>

      {/* Number formatting */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label>Format Type</label>
          <select value={column.format?.type || 'text'} onChange={e => onChange({ ...column, format: { ...column.format, type: e.target.value } })}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="datetime">Date/Time</option>
          </select>
        </div>
        {column.format?.type === 'number' && (
          <>
            <div>
              <label>Decimal Places</label>
              <input type="number" min={0} max={10} value={column.format.decimalPlaces ?? ''} onChange={e => onChange({ ...column, format: { ...column.format, decimalPlaces: +e.target.value } })} />
            </div>
            <div>
              <label>Unit</label>
              <input placeholder="°C, Pa, %" value={column.format.unit ?? ''} onChange={e => onChange({ ...column, format: { ...column.format, unit: e.target.value } })} />
            </div>
          </>
        )}
        {column.format?.type === 'datetime' && (
          <div>
            <label>Pattern</label>
            <input placeholder="DD/MM/YYYY HH:mm" value={column.format.pattern ?? ''} onChange={e => onChange({ ...column, format: { ...column.format, pattern: e.target.value } })} />
          </div>
        )}
      </div>

      {/* Text transform */}
      <div>
        <label>Text Transform</label>
        <select value={column.style?.textTransform || 'none'} onChange={e => onChange({ ...column, style: { ...column.style, textTransform: e.target.value } })}>
          <option value="none">None</option>
          <option value="uppercase">UPPERCASE</option>
          <option value="lowercase">lowercase</option>
          <option value="capitalize">Capitalize</option>
        </select>
      </div>

      {/* Conditional Rules */}
      <div>
        <div className="flex justify-between items-center">
          <label className="font-medium">Conditional Formatting</label>
          <button onClick={() => onChange({ ...column, conditionalRules: [...(column.conditionalRules || []), { condition: 'gt', value: 0, style: {} }] })}>
            + Add Rule
          </button>
        </div>
        {(column.conditionalRules || []).map((rule, idx) => (
          <ConditionalRuleForm
            key={idx}
            rule={rule}
            onChange={(updated) => {
              const rules = [...(column.conditionalRules || [])];
              rules[idx] = updated;
              onChange({ ...column, conditionalRules: rules });
            }}
            onRemove={() => onChange({ ...column, conditionalRules: column.conditionalRules?.filter((_, i) => i !== idx) })}
          />
        ))}
      </div>
    </div>
  );
}
```

### 4.5 Report Generation Wizard (`reports/generate.tsx`)

```typescript
export function ReportGenerate() {
  const [step, setStep] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [entitySlots, setEntitySlots] = useState<Record<string, string>>({});
  const [timeRange, setTimeRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [generating, setGenerating] = useState(false);
  const navigate = useNavigate();

  const { data: templates } = useSWR('/api/report-templates?status=ACTIVE');
  const { data: templateDetail } = useSWR(selectedTemplate ? `/api/report-templates/${selectedTemplate}` : null);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await api.post('/api/reports/generate', {
        templateId: selectedTemplate,
        entitySlots,
        timeRangeStart: timeRange.start,
        timeRangeEnd: timeRange.end,
      });
      navigate(`/reports/${res.data.id}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-6">Generate Report</h1>

      {/* Step 1: Select Template */}
      {step === 1 && (
        <div>
          <h2 className="font-medium mb-3">Step 1: Select Template</h2>
          <div className="grid gap-3">
            {templates?.map((t: any) => (
              <button
                key={t.id}
                className={`p-4 border rounded text-left ${selectedTemplate === t.id ? 'border-blue-500 bg-blue-50' : ''}`}
                onClick={() => { setSelectedTemplate(t.id); setStep(2); }}
              >
                <div className="font-medium">{t.name}</div>
                <div className="text-sm text-slate-500">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Fill Entity Slots */}
      {step === 2 && templateDetail && (
        <div>
          <h2 className="font-medium mb-3">Step 2: Select Entities</h2>
          {templateDetail.config.entitySlots?.map((slot: any) => (
            <EntitySlotFiller
              key={slot.name}
              slot={slot}
              value={entitySlots[slot.name]}
              onChange={(value) => setEntitySlots(prev => ({ ...prev, [slot.name]: value }))}
            />
          ))}
          <button onClick={() => setStep(3)} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded">
            Next
          </button>
        </div>
      )}

      {/* Step 3: Time Range */}
      {step === 3 && (
        <div>
          <h2 className="font-medium mb-3">Step 3: Time Range</h2>
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          <button onClick={handleGenerate} disabled={generating} className="mt-4 px-4 py-2 bg-green-600 text-white rounded">
            {generating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      )}
    </div>
  );
}
```

### 4.6 Report Detail + PDF Viewer (`reports/[id]/index.tsx`)

```typescript
export function ReportDetail() {
  const { id } = useParams();
  const { data: report } = useSWR(`/api/reports/${id}`);

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold">{report?.name}</h1>
          <ReportStatusBadge status={report?.status} />
        </div>
        <div className="flex gap-2">
          {report?.status === 'PENDING_SIGNATURE' && (
            <Link to={`/reports/${id}/sign`} className="px-4 py-2 bg-blue-600 text-white rounded">
              Sign Report
            </Link>
          )}
          <a href={`/api/reports/${id}/pdf`} download className="px-4 py-2 border rounded">
            Download PDF
          </a>
        </div>
      </div>

      {/* PDF Preview */}
      <div className="border rounded bg-white" style={{ height: 'calc(100vh - 200px)' }}>
        <iframe
          src={`/api/reports/${id}/preview`}
          className="w-full h-full"
          title="Report Preview"
        />
      </div>

      {/* Signatures */}
      {report?.signatures?.length > 0 && (
        <div className="mt-4">
          <h3 className="font-medium mb-2">Signatures</h3>
          {report.signatures.map((sig: any) => (
            <div key={sig.id} className="flex items-center gap-3 p-2 border-b">
              <span className="font-medium">{sig.signerLabel}:</span>
              <span>{sig.user?.name}</span>
              <span className="text-slate-500 text-sm">{new Date(sig.signedAt).toLocaleString()}</span>
              <span className="text-xs text-slate-400 italic">&ldquo;{sig.meaning}&rdquo;</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 5. SWR API Hooks

```typescript
// hooks/use-report-templates.ts
export function useReportTemplates(params?: { status?: string }) {
  return useSWR(`/api/report-templates?${new URLSearchParams(params)}`);
}

export function useReportTemplate(id: string | undefined) {
  return useSWR(id ? `/api/report-templates/${id}` : null);
}

// hooks/use-reports.ts
export function useReports(params?: { status?: string; templateId?: string }) {
  return useSWR(`/api/reports?${new URLSearchParams(params)}`);
}

export function useReport(id: string | undefined) {
  return useSWR(id ? `/api/reports/${id}` : null);
}
```

---

## 6. New Dependencies

```bash
cd apps/web
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
# For drag-and-drop section reordering in the template designer
# Alternative: use react-beautiful-dnd if already familiar
```

No other new frontend deps needed — recharts, react-hook-form, zod, lucide-react are already installed.

---

## 7. Code Splitting

Add to Vite chunk config:

```typescript
// vite.config.ts manualChunks
'report-templates': [/routes\/report-templates/],
'reports': [/routes\/reports/],
```

Both pages should be lazy-loaded:

```typescript
const ReportTemplateList = lazy(() => import('./routes/report-templates/index'));
const ReportTemplateEditor = lazy(() => import('./routes/report-templates/[id]/edit'));
const ReportList = lazy(() => import('./routes/reports/index'));
const ReportGenerate = lazy(() => import('./routes/reports/generate'));
const ReportDetail = lazy(() => import('./routes/reports/[id]/index'));
const ReportSign = lazy(() => import('./routes/reports/[id]/sign'));
```
