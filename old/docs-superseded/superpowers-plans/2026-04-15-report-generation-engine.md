# Report Generation Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side report generation engine that resolves variable tags, renders HTML with charts, converts to PDF via Puppeteer, and serves downloadable reports.

**Architecture:** Synchronous pipeline: parse template config → resolve variable tags via 5 data sources → build HTML with Handlebars → render charts as base64 PNG → generate PDF via Puppeteer → store to disk → return report instance. All in a single request-response cycle.

**Tech Stack:** Fastify, Prisma, Puppeteer, chartjs-node-canvas, Handlebars, TimescaleDB (pg pool), dayjs

---

## File Structure

```
apps/api/src/modules/reports/
  report.service.ts          — Orchestrator: generate, list, get, delete
  report.routes.ts           — 6 API endpoints
  variable-resolver.ts       — Parse {{tags}}, dispatch to data sources
  data-sources/
    attribute-source.ts      — Resolve attr.$slot.field
    identifier-source.ts     — Resolve ident.$slot.type
    telemetry-source.ts      — Resolve ts.$slot.key[modifier]
    timestamp-source.ts      — Resolve time.now, time.range.*
    meta-source.ts           — Resolve meta.report/user/org.*
  renderers/
    html-builder.ts          — Build full HTML document from resolved config
    chart-renderer.ts        — chartjs-node-canvas → base64 PNG string
    pdf-renderer.ts          — Puppeteer HTML → PDF Buffer
    styles.ts                — CSS string for PDF print layout
```

---

## Task 1: Data Source Interfaces + Timestamp & Meta Sources

**Files:**
- Create: `apps/api/src/modules/reports/data-sources/timestamp-source.ts`
- Create: `apps/api/src/modules/reports/data-sources/meta-source.ts`

These are the simplest sources — no DB queries for timestamp, minimal for meta.

- [ ] **Step 1: Create timestamp-source.ts**

Create `apps/api/src/modules/reports/data-sources/timestamp-source.ts`:

```typescript
import dayjs from 'dayjs';

export interface ResolutionContext {
  entitySlots: Record<string, string>;
  timeRange: { start: Date; end: Date };
  orgId: string;
  userId: string;
  userName: string;
  orgName: string;
  reportName: string;
  templateName: string;
}

export interface ResolvedValue {
  value: unknown;
  error?: string;
}

export function resolveTimestamp(path: string, ctx: ResolutionContext): ResolvedValue {
  switch (path) {
    case 'now':
      return { value: dayjs().format('DD/MM/YYYY HH:mm:ss') };
    case 'range.start':
      return { value: ctx.timeRange.start ? dayjs(ctx.timeRange.start).format('DD/MM/YYYY HH:mm') : '' };
    case 'range.end':
      return { value: ctx.timeRange.end ? dayjs(ctx.timeRange.end).format('DD/MM/YYYY HH:mm') : '' };
    default:
      return { value: '', error: `Unknown timestamp path: ${path}` };
  }
}
```

- [ ] **Step 2: Create meta-source.ts**

Create `apps/api/src/modules/reports/data-sources/meta-source.ts`:

```typescript
import type { ResolutionContext, ResolvedValue } from './timestamp-source.js';

export function resolveMeta(path: string, ctx: ResolutionContext): ResolvedValue {
  switch (path) {
    case 'report.name':
      return { value: ctx.reportName };
    case 'user.name':
      return { value: ctx.userName };
    case 'org.name':
      return { value: ctx.orgName };
    case 'template.name':
      return { value: ctx.templateName };
    default:
      return { value: '', error: `Unknown meta path: ${path}` };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reports/data-sources/
git commit -m "feat(reports): add timestamp and meta data sources with ResolutionContext type"
```

---

## Task 2: Attribute & Identifier Data Sources

**Files:**
- Create: `apps/api/src/modules/reports/data-sources/attribute-source.ts`
- Create: `apps/api/src/modules/reports/data-sources/identifier-source.ts`

- [ ] **Step 1: Create attribute-source.ts**

Create `apps/api/src/modules/reports/data-sources/attribute-source.ts`:

```typescript
import { prisma } from '../../../lib/prisma.js';
import type { ResolutionContext, ResolvedValue } from './timestamp-source.js';

export async function resolveAttribute(slotRef: string, field: string, ctx: ResolutionContext): Promise<ResolvedValue> {
  // slotRef is like "$primaryFilter" — strip the $ and look up in entitySlots
  const slotName = slotRef.startsWith('$') ? slotRef.slice(1) : slotRef;
  const entityId = ctx.entitySlots[slotName];
  if (!entityId) {
    return { value: '', error: `Entity slot "${slotName}" not found` };
  }

  const instance = await prisma.assetInstance.findUnique({
    where: { id: entityId },
    include: {
      template: { select: { name: true, attributeSchema: true } },
    },
  });

  if (!instance) {
    return { value: '', error: `Entity "${entityId}" not found` };
  }

  // field === '*' returns all attributes
  if (field === '*') {
    return { value: instance.attributes ?? {} };
  }

  const attrs = (instance.attributes as Record<string, unknown>) ?? {};

  // Check for built-in fields first
  if (field === 'name') return { value: instance.name };
  if (field === 'id') return { value: instance.id };
  if (field === 'template') return { value: instance.template?.name ?? '' };

  return { value: attrs[field] ?? '' };
}
```

- [ ] **Step 2: Create identifier-source.ts**

Create `apps/api/src/modules/reports/data-sources/identifier-source.ts`:

```typescript
import { prisma } from '../../../lib/prisma.js';
import type { ResolutionContext, ResolvedValue } from './timestamp-source.js';

export async function resolveIdentifier(slotRef: string, identType: string, ctx: ResolutionContext): Promise<ResolvedValue> {
  const slotName = slotRef.startsWith('$') ? slotRef.slice(1) : slotRef;
  const entityId = ctx.entitySlots[slotName];
  if (!entityId) {
    return { value: '', error: `Entity slot "${slotName}" not found` };
  }

  const identifiers = await prisma.assetIdentifier.findMany({
    where: { assetId: entityId },
  });

  if (identifiers.length === 0) {
    return { value: '', error: `No identifiers for entity "${entityId}"` };
  }

  // If identType is specific, find that type
  const match = identifiers.find(i => i.identifierType === identType);
  if (match) {
    return { value: match.identifierValue };
  }

  // Fallback: return first identifier value
  return { value: identifiers[0].identifierValue };
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reports/data-sources/
git commit -m "feat(reports): add attribute and identifier data sources"
```

---

## Task 3: Telemetry Data Source

**Files:**
- Create: `apps/api/src/modules/reports/data-sources/telemetry-source.ts`

- [ ] **Step 1: Create telemetry-source.ts**

Create `apps/api/src/modules/reports/data-sources/telemetry-source.ts`:

```typescript
import { getTsdbPool } from '@digilog/db';
import type { ResolutionContext, ResolvedValue } from './timestamp-source.js';

const WINDOW_MS: Record<string, number> = {
  '1h': 3600_000,
  '6h': 21600_000,
  '24h': 86400_000,
  '7d': 604800_000,
  '30d': 2592000_000,
};

function parseWindow(window: string): number {
  return WINDOW_MS[window] ?? 86400_000; // default 24h
}

export async function resolveTelemetry(
  slotRef: string,
  key: string,
  modifier: string,
  ctx: ResolutionContext,
): Promise<ResolvedValue> {
  const slotName = slotRef.startsWith('$') ? slotRef.slice(1) : slotRef;
  const entityId = ctx.entitySlots[slotName];
  if (!entityId) {
    return { value: null, error: `Entity slot "${slotName}" not found` };
  }

  const pool = getTsdbPool();

  // [last] — latest value
  if (modifier === 'last') {
    const result = await pool.query(
      `SELECT value_num, value_str FROM ts_telemetry
       WHERE entity_id = $1 AND key = $2
       ORDER BY time DESC LIMIT 1`,
      [entityId, key],
    );
    const row = result.rows[0];
    if (!row) return { value: null };
    return { value: row.value_num ?? row.value_str };
  }

  // [first] — oldest value in range
  if (modifier === 'first') {
    const result = await pool.query(
      `SELECT value_num, value_str FROM ts_telemetry
       WHERE entity_id = $1 AND key = $2 AND time >= $3 AND time <= $4
       ORDER BY time ASC LIMIT 1`,
      [entityId, key, ctx.timeRange.start, ctx.timeRange.end],
    );
    const row = result.rows[0];
    if (!row) return { value: null };
    return { value: row.value_num ?? row.value_str };
  }

  // [range] — full series for tables/charts
  if (modifier === 'range') {
    const result = await pool.query(
      `SELECT time AS timestamp, value_num AS value, value_str
       FROM ts_telemetry
       WHERE entity_id = $1 AND key = $2 AND time >= $3 AND time <= $4
       ORDER BY time ASC`,
      [entityId, key, ctx.timeRange.start, ctx.timeRange.end],
    );
    return { value: result.rows };
  }

  // [avg:24h], [min:24h], [max:24h], [sum:24h], [count:24h]
  const aggMatch = modifier.match(/^(avg|min|max|sum|count):(.+)$/);
  if (aggMatch) {
    const [, aggFn, window] = aggMatch;
    const windowMs = parseWindow(window);
    const since = new Date(Date.now() - windowMs);
    const sqlFn = aggFn.toUpperCase();

    const result = await pool.query(
      `SELECT ${sqlFn}(value_num) AS result FROM ts_telemetry
       WHERE entity_id = $1 AND key = $2 AND time >= $3`,
      [entityId, key, since],
    );
    const val = result.rows[0]?.result;
    return { value: val !== null && val !== undefined ? Number(val) : null };
  }

  return { value: null, error: `Unknown telemetry modifier: ${modifier}` };
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reports/data-sources/telemetry-source.ts
git commit -m "feat(reports): add telemetry data source with aggregation support"
```

---

## Task 4: Variable Resolver

**Files:**
- Create: `apps/api/src/modules/reports/variable-resolver.ts`

- [ ] **Step 1: Create variable-resolver.ts**

Create `apps/api/src/modules/reports/variable-resolver.ts`:

```typescript
import type { ResolutionContext, ResolvedValue } from './data-sources/timestamp-source.js';
import { resolveTimestamp } from './data-sources/timestamp-source.js';
import { resolveMeta } from './data-sources/meta-source.js';
import { resolveAttribute } from './data-sources/attribute-source.js';
import { resolveIdentifier } from './data-sources/identifier-source.js';
import { resolveTelemetry } from './data-sources/telemetry-source.js';

const TAG_REGEX = /\{\{([^}]+)\}\}/g;

interface ParsedTag {
  raw: string;       // "attr.$primaryFilter.temperature"
  source: string;    // "attr"
  slotRef: string;   // "$primaryFilter"
  field: string;     // "temperature"
  modifier?: string; // "last", "avg:24h", "range"
}

function parseTag(raw: string): ParsedTag | null {
  const parts = raw.trim().split('.');
  if (parts.length < 2) return null;

  const source = parts[0]; // attr, ident, ts, time, meta, page

  // time and meta don't have slot refs
  if (source === 'time' || source === 'meta' || source === 'page') {
    return { raw, source, slotRef: '', field: parts.slice(1).join('.') };
  }

  // Everything else: source.slotRef.field[modifier]
  const slotRef = parts[1];
  const fieldPart = parts.slice(2).join('.');

  // Extract modifier from brackets: "temperature[last]" → field="temperature", modifier="last"
  const bracketMatch = fieldPart.match(/^([^[]+)\[([^\]]+)\]$/);
  if (bracketMatch) {
    return { raw, source, slotRef, field: bracketMatch[1], modifier: bracketMatch[2] };
  }

  return { raw, source, slotRef, field: fieldPart };
}

/**
 * Extract all unique {{tags}} from a JSON-serializable config object.
 */
export function extractTags(config: unknown): string[] {
  const json = JSON.stringify(config);
  const tags = new Set<string>();
  let match;
  while ((match = TAG_REGEX.exec(json)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

/**
 * Resolve a single tag to its value.
 */
async function resolveOne(parsed: ParsedTag, ctx: ResolutionContext): Promise<ResolvedValue> {
  switch (parsed.source) {
    case 'time':
      return resolveTimestamp(parsed.field, ctx);
    case 'meta':
      return resolveMeta(parsed.field, ctx);
    case 'attr':
      return resolveAttribute(parsed.slotRef, parsed.field, ctx);
    case 'ident':
      return resolveIdentifier(parsed.slotRef, parsed.field, ctx);
    case 'ts':
      return resolveTelemetry(parsed.slotRef, parsed.field, parsed.modifier ?? 'last', ctx);
    case 'page':
      // Page tags are resolved during PDF rendering, not here
      return { value: `{{page.${parsed.field}}}` };
    default:
      return { value: '', error: `Unknown source: ${parsed.source}` };
  }
}

/**
 * Resolve all variable tags in a template config.
 * Returns a map of raw tag string → resolved value.
 */
export async function resolveAllTags(
  config: unknown,
  ctx: ResolutionContext,
): Promise<Map<string, unknown>> {
  const tags = extractTags(config);
  const resolved = new Map<string, unknown>();

  for (const raw of tags) {
    const parsed = parseTag(raw);
    if (!parsed) {
      resolved.set(raw, '');
      continue;
    }
    const result = await resolveOne(parsed, ctx);
    resolved.set(raw, result.value);
  }

  return resolved;
}

/**
 * Replace all {{tags}} in a string with resolved values.
 * For scalar values, inserts the value directly.
 * For arrays/objects, inserts JSON (used for table data sources).
 */
export function substituteString(template: string, resolved: Map<string, unknown>): string {
  return template.replace(TAG_REGEX, (_, tag) => {
    const value = resolved.get(tag);
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/reports/variable-resolver.ts
git commit -m "feat(reports): add variable resolver with tag parsing and substitution"
```

---

## Task 5: Chart Renderer

**Files:**
- Create: `apps/api/src/modules/reports/renderers/chart-renderer.ts`

- [ ] **Step 1: Create chart-renderer.ts**

Create `apps/api/src/modules/reports/renderers/chart-renderer.ts`:

```typescript
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

interface ChartSeries {
  source: string;
  label: string;
  color: string;
}

interface ChartAxis {
  type?: string;
  label: string;
  min?: number;
  max?: number;
}

interface ChartSectionConfig {
  chartType: 'line' | 'bar' | 'pie';
  title: string;
  width: string;
  height: number;
  dataSeries: ChartSeries[];
  xAxis: ChartAxis;
  yAxis: ChartAxis;
  showLegend: boolean;
  showGrid: boolean;
}

const chartCanvas = new ChartJSNodeCanvas({
  width: 800,
  height: 400,
  backgroundColour: 'white',
});

/**
 * Render a chart section to a base64 PNG data URL.
 * resolvedSeries maps each series source tag to its resolved data array.
 */
export async function renderChart(
  config: ChartSectionConfig,
  resolvedSeries: Map<string, unknown>,
): Promise<string> {
  const datasets = config.dataSeries.map(series => {
    const data = resolvedSeries.get(series.source);
    const rows = Array.isArray(data) ? data : [];

    return {
      label: series.label,
      data: rows.map((row: any) => ({
        x: row.timestamp ?? row.time ?? row.x,
        y: row.value ?? row.y ?? row.value_num,
      })),
      borderColor: series.color,
      backgroundColor: config.chartType === 'pie'
        ? config.dataSeries.map(s => s.color)
        : `${series.color}33`,
      fill: config.chartType === 'line',
      tension: 0.3,
    };
  });

  const chartConfig: any = {
    type: config.chartType,
    data: {
      datasets,
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: !!config.title, text: config.title, font: { size: 14 } },
        legend: { display: config.showLegend },
      },
      scales: config.chartType !== 'pie' ? {
        x: {
          type: config.xAxis.type === 'time' ? 'time' : 'linear',
          title: { display: !!config.xAxis.label, text: config.xAxis.label },
          grid: { display: config.showGrid },
        },
        y: {
          title: { display: !!config.yAxis.label, text: config.yAxis.label },
          min: config.yAxis.min,
          max: config.yAxis.max,
          grid: { display: config.showGrid },
        },
      } : undefined,
    },
  };

  const buffer = await chartCanvas.renderToBuffer(chartConfig);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/reports/renderers/chart-renderer.ts
git commit -m "feat(reports): add chart renderer using chartjs-node-canvas"
```

---

## Task 6: HTML Builder + PDF Styles

**Files:**
- Create: `apps/api/src/modules/reports/renderers/styles.ts`
- Create: `apps/api/src/modules/reports/renderers/html-builder.ts`

- [ ] **Step 1: Create styles.ts**

Create `apps/api/src/modules/reports/renderers/styles.ts`:

```typescript
export const PDF_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1e293b; line-height: 1.4; }

  .report-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 2px solid #0891b2; margin-bottom: 16px; }
  .report-header .left { display: flex; align-items: center; gap: 12px; }
  .report-header .center { text-align: center; flex: 1; }
  .report-header .right { text-align: right; font-size: 9pt; color: #64748b; }
  .report-header img { max-height: 50px; }

  .report-footer { display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #cbd5e1; margin-top: 16px; font-size: 8pt; color: #94a3b8; }

  .section { margin-bottom: 20px; break-inside: avoid; }
  .section-title { font-size: 12pt; font-weight: bold; color: #0f172a; margin-bottom: 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }

  .text-section { white-space: pre-wrap; }

  table.data-table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.data-table thead th { background: #f1f5f9; font-weight: bold; text-transform: uppercase; font-size: 8pt; letter-spacing: 0.5px; padding: 6px 8px; text-align: left; border: 1px solid #cbd5e1; }
  table.data-table tbody td { padding: 5px 8px; border: 1px solid #e2e8f0; }
  table.data-table tbody tr:nth-child(even) { background: #f8fafc; }
  table.data-table.no-borders th, table.data-table.no-borders td { border: none; }
  table.data-table.no-stripes tbody tr:nth-child(even) { background: transparent; }

  .kv-grid { display: grid; gap: 4px 16px; }
  .kv-grid.cols-1 { grid-template-columns: 1fr; }
  .kv-grid.cols-2 { grid-template-columns: 1fr 1fr; }
  .kv-grid.cols-3 { grid-template-columns: 1fr 1fr 1fr; }
  .kv-entry { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dotted #e2e8f0; }
  .kv-label { font-weight: 600; color: #475569; min-width: 120px; font-size: 9pt; }
  .kv-value { color: #1e293b; font-size: 9pt; }

  .chart-section { text-align: center; }
  .chart-section img { max-width: 100%; }

  .signature-block { margin-top: 24px; page-break-inside: avoid; }
  .signature-row { display: flex; gap: 40px; margin-top: 16px; }
  .signature-slot { flex: 1; border-top: 1px solid #1e293b; padding-top: 4px; }
  .signature-slot .sig-label { font-size: 9pt; font-weight: 600; }
  .signature-slot .sig-name { font-size: 8pt; color: #64748b; margin-top: 2px; }
  .signature-slot .sig-date { font-size: 8pt; color: #94a3b8; }

  .page-break { page-break-after: always; }
`;
```

- [ ] **Step 2: Create html-builder.ts**

Create `apps/api/src/modules/reports/renderers/html-builder.ts`:

```typescript
import dayjs from 'dayjs';
import { PDF_STYLES } from './styles.js';
import { renderChart } from './chart-renderer.js';
import { substituteString } from '../variable-resolver.js';

interface TemplateConfig {
  pageSettings: { size: string; orientation: string; margins: Record<string, number> };
  header: { enabled: boolean; height: number; elements: any[] };
  footer: { enabled: boolean; height: number; elements: any[] };
  sections: any[];
  entitySlots: any[];
  signatureConfig: { required: boolean; meaning: string; signers: any[] };
}

interface ConditionalRule {
  condition: string;
  value?: string | number;
  min?: number;
  max?: number;
  style: Record<string, string>;
}

function applyConditionalStyle(value: unknown, rules?: ConditionalRule[]): string {
  if (!rules || rules.length === 0) return '';
  const num = typeof value === 'number' ? value : Number(value);
  const str = String(value ?? '');

  for (const rule of rules) {
    let match = false;
    switch (rule.condition) {
      case 'gt': match = !isNaN(num) && num > Number(rule.value); break;
      case 'gte': match = !isNaN(num) && num >= Number(rule.value); break;
      case 'lt': match = !isNaN(num) && num < Number(rule.value); break;
      case 'lte': match = !isNaN(num) && num <= Number(rule.value); break;
      case 'eq': match = str === String(rule.value); break;
      case 'neq': match = str !== String(rule.value); break;
      case 'between': match = !isNaN(num) && num >= Number(rule.min) && num <= Number(rule.max); break;
      case 'contains': match = str.includes(String(rule.value)); break;
      case 'empty': match = str === '' || value === null || value === undefined; break;
      case 'not_empty': match = str !== '' && value !== null && value !== undefined; break;
    }
    if (match) {
      const styles: string[] = [];
      if (rule.style.fontWeight) styles.push(`font-weight:${rule.style.fontWeight}`);
      if (rule.style.fontStyle) styles.push(`font-style:${rule.style.fontStyle}`);
      if (rule.style.color) styles.push(`color:${rule.style.color}`);
      if (rule.style.backgroundColor) styles.push(`background-color:${rule.style.backgroundColor}`);
      if (rule.style.textDecoration) styles.push(`text-decoration:${rule.style.textDecoration}`);
      return styles.join(';');
    }
  }
  return '';
}

function formatValue(value: unknown, format?: { type: string; decimalPlaces?: number; unit?: string; pattern?: string }): string {
  if (value === null || value === undefined) return '\u2014';
  if (!format || format.type === 'text') return String(value);

  if (format.type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return String(value);
    const formatted = format.decimalPlaces !== undefined ? num.toFixed(format.decimalPlaces) : String(num);
    return format.unit ? `${formatted} ${format.unit}` : formatted;
  }

  if (format.type === 'datetime') {
    return dayjs(value as string).format(format.pattern || 'DD/MM/YYYY HH:mm');
  }

  return String(value);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderHeaderFooter(config: { enabled: boolean; elements: any[] }, resolved: Map<string, unknown>): string {
  if (!config.enabled || config.elements.length === 0) return '';
  const positions: Record<string, string[]> = { left: [], center: [], right: [] };

  for (const el of config.elements) {
    const pos = el.position || 'left';
    if (el.type === 'text') {
      const text = substituteString(el.content ?? '', resolved);
      const style = el.style ? `font-size:${el.style.fontSize ?? 10}pt;${el.style.fontWeight ? `font-weight:${el.style.fontWeight}` : ''}${el.style.color ? `;color:${el.style.color}` : ''}` : '';
      positions[pos].push(`<span style="${style}">${escapeHtml(text)}</span>`);
    } else if (el.type === 'image') {
      positions[pos].push(`<span style="font-size:14pt;font-weight:bold;color:#0891b2;">&#9632; Report</span>`);
    }
  }

  return `<div class="report-header">
    <div class="left">${positions.left.join('')}</div>
    <div class="center">${positions.center.join('')}</div>
    <div class="right">${positions.right.join('')}</div>
  </div>`;
}

function renderTableSection(section: any, resolved: Map<string, unknown>): string {
  const dataSource = substituteString(section.dataSource ?? '', resolved);
  let rows: any[] = [];

  // Try to get data from resolved tags
  for (const [tag, val] of resolved) {
    if (section.dataSource && section.dataSource.includes(`{{${tag}}}`)) {
      if (Array.isArray(val)) rows = val;
    }
  }
  // Also check if dataSource itself was a tag that got resolved
  if (rows.length === 0) {
    const tagMatch = (section.dataSource ?? '').match(/\{\{([^}]+)\}\}/);
    if (tagMatch) {
      const val = resolved.get(tagMatch[1]);
      if (Array.isArray(val)) rows = val;
    }
  }

  const settings = section.tableSettings ?? {};
  const classes = ['data-table'];
  if (!settings.showBorders) classes.push('no-borders');
  if (!settings.stripedRows) classes.push('no-stripes');

  let html = `<div class="section">`;
  if (section.title) html += `<div class="section-title">${escapeHtml(section.title)}</div>`;
  html += `<table class="${classes.join(' ')}" style="font-size:${settings.bodyStyle?.fontSize ?? 10}pt;font-family:${settings.bodyStyle?.fontFamily ?? 'Arial'}">`;

  // Header
  if (section.columns?.length > 0) {
    html += '<thead><tr>';
    for (const col of section.columns) {
      const style = col.width ? `width:${col.width};` : '';
      const align = col.style?.textAlign ? `text-align:${col.style.textAlign};` : '';
      html += `<th style="${style}${align}">${escapeHtml(col.header || col.key)}</th>`;
    }
    html += '</tr></thead>';
  }

  // Body
  html += '<tbody>';
  const maxRows = settings.maxRowsPerPage ?? 200;
  const displayRows = rows.slice(0, maxRows);

  for (const row of displayRows) {
    html += '<tr>';
    for (const col of (section.columns ?? [])) {
      const rawValue = row[col.key] ?? row.value ?? '';
      const formatted = formatValue(rawValue, col.format);
      const condStyle = applyConditionalStyle(rawValue, col.conditionalRules);
      const align = col.style?.textAlign ? `text-align:${col.style.textAlign};` : '';
      const transform = col.style?.textTransform && col.style.textTransform !== 'none' ? `text-transform:${col.style.textTransform};` : '';
      html += `<td style="${align}${transform}${condStyle}">${escapeHtml(formatted)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  if (rows.length > maxRows) {
    html += `<div style="font-size:8pt;color:#94a3b8;margin-top:4px;">Showing ${maxRows} of ${rows.length} rows</div>`;
  }
  html += '</div>';
  return html;
}

function renderKVSection(section: any, resolved: Map<string, unknown>): string {
  const layoutClass = section.layout === 'three_column' ? 'cols-3' : section.layout === 'two_column' ? 'cols-2' : 'cols-1';
  let html = `<div class="section">`;
  if (section.title) html += `<div class="section-title">${escapeHtml(section.title)}</div>`;
  html += `<div class="kv-grid ${layoutClass}">`;

  for (const entry of (section.entries ?? [])) {
    const value = substituteString(entry.value ?? '', resolved);
    const formatted = formatValue(value, entry.format);
    html += `<div class="kv-entry"><span class="kv-label">${escapeHtml(entry.label)}</span><span class="kv-value">${escapeHtml(formatted)}</span></div>`;
  }

  html += '</div></div>';
  return html;
}

function renderSignatureSection(section: any, signatureConfig: any): string {
  let html = `<div class="signature-block section">`;
  if (section.label) html += `<div class="section-title">${escapeHtml(section.label)}</div>`;
  if (signatureConfig.meaning) html += `<div style="font-size:9pt;color:#475569;margin-bottom:12px;font-style:italic;">"${escapeHtml(signatureConfig.meaning)}"</div>`;
  html += '<div class="signature-row">';

  const signerRoles = section.signers ?? [];
  const signerDefs = signatureConfig.signers ?? [];

  for (const role of signerRoles) {
    const def = signerDefs.find((s: any) => s.role === role);
    const label = def?.label || role;
    html += `<div class="signature-slot">
      <div class="sig-label">${escapeHtml(label)}</div>
      <div class="sig-name" style="margin-top:30px;">Name: ___________________</div>
      <div class="sig-date">Date: ___________________</div>
    </div>`;
  }

  html += '</div></div>';
  return html;
}

/**
 * Build the full HTML document for PDF rendering.
 */
export async function buildHtml(
  config: TemplateConfig,
  resolved: Map<string, unknown>,
): Promise<string> {
  const sectionsHtml: string[] = [];

  for (const section of config.sections) {
    switch (section.type) {
      case 'text': {
        const content = substituteString(section.content ?? '', resolved);
        const style = `font-size:${section.style?.fontSize ?? 12}pt;font-family:${section.style?.fontFamily ?? 'Arial'};line-height:${section.style?.lineHeight ?? 1.5}`;
        sectionsHtml.push(`<div class="section text-section" style="${style}">${escapeHtml(content)}</div>`);
        break;
      }
      case 'table':
        sectionsHtml.push(renderTableSection(section, resolved));
        break;
      case 'chart': {
        // Resolve series data
        const seriesData = new Map<string, unknown>();
        for (const series of (section.dataSeries ?? [])) {
          const tagMatch = series.source.match(/\{\{([^}]+)\}\}/) ?? [null, series.source];
          // Try to find resolved data that matches this source
          for (const [tag, val] of resolved) {
            if (series.source.includes(tag) || tag.includes(series.source.replace(/\{\{|\}\}/g, ''))) {
              seriesData.set(series.source, val);
            }
          }
        }
        const chartImg = await renderChart(section, seriesData);
        sectionsHtml.push(`<div class="section chart-section">${section.title ? `<div class="section-title">${escapeHtml(section.title)}</div>` : ''}<img src="${chartImg}" style="max-width:100%;height:${section.height}px;" /></div>`);
        break;
      }
      case 'key_value':
        sectionsHtml.push(renderKVSection(section, resolved));
        break;
      case 'signature':
        sectionsHtml.push(renderSignatureSection(section, config.signatureConfig));
        break;
      case 'page_break':
        sectionsHtml.push('<div class="page-break"></div>');
        break;
    }
  }

  const headerHtml = renderHeaderFooter(config.header, resolved);
  const footerHtml = renderHeaderFooter(config.footer, resolved);

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>${PDF_STYLES}</style>
</head><body>
${headerHtml}
${sectionsHtml.join('\n')}
${footerHtml}
</body></html>`;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/reports/renderers/
git commit -m "feat(reports): add HTML builder with styles, table formatting, and chart rendering"
```

---

## Task 7: PDF Renderer

**Files:**
- Create: `apps/api/src/modules/reports/renderers/pdf-renderer.ts`

- [ ] **Step 1: Create pdf-renderer.ts**

Create `apps/api/src/modules/reports/renderers/pdf-renderer.ts`:

```typescript
import puppeteer, { type Browser } from 'puppeteer';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

interface PdfOptions {
  pageSize: string;
  orientation: string;
  margins: { top: number; right: number; bottom: number; left: number };
}

/**
 * Render HTML string to a PDF buffer using Puppeteer.
 */
export async function renderPdf(html: string, options: PdfOptions): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });

    const pdfUint8 = await page.pdf({
      format: (options.pageSize || 'A4') as any,
      landscape: options.orientation === 'landscape',
      margin: {
        top: `${options.margins.top ?? 20}mm`,
        right: `${options.margins.right ?? 15}mm`,
        bottom: `${options.margins.bottom ?? 20}mm`,
        left: `${options.margins.left ?? 15}mm`,
      },
      printBackground: true,
    });

    return Buffer.from(pdfUint8);
  } finally {
    await page.close();
  }
}

/**
 * Close the shared browser instance (call on app shutdown).
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/reports/renderers/pdf-renderer.ts
git commit -m "feat(reports): add Puppeteer PDF renderer with shared browser instance"
```

---

## Task 8: Report Service (Orchestrator)

**Files:**
- Create: `apps/api/src/modules/reports/report.service.ts`

- [ ] **Step 1: Create report.service.ts**

Create `apps/api/src/modules/reports/report.service.ts`:

```typescript
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import type { RequestContext } from '../../types/context.js';
import { resolveAllTags } from './variable-resolver.js';
import { buildHtml } from './renderers/html-builder.js';
import { renderPdf } from './renderers/pdf-renderer.js';
import type { ResolutionContext } from './data-sources/timestamp-source.js';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = path.resolve('uploads/reports');

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

interface GenerateInput {
  templateId: string;
  entitySlots: Record<string, string>;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  name?: string;
}

export class ReportService {

  async generate(ctx: RequestContext, input: GenerateInput) {
    // 1. Load template with latest config
    const template = await prisma.reportTemplate.findUnique({
      where: { id: input.templateId },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (!template) throw { statusCode: 404, message: 'Template not found' };
    if (template.status !== 'ACTIVE') throw { statusCode: 400, message: 'Template is not active' };

    const config = (template.versions[0]?.config ?? {}) as any;
    const version = template.currentVersion;

    // 2. Get org name for meta resolution
    const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId ?? template.orgId } });
    const user = await prisma.user.findUnique({ where: { id: ctx.userSub } });

    const reportName = input.name || `${template.name} - ${new Date().toLocaleDateString()}`;

    // 3. Build resolution context
    const resCtx: ResolutionContext = {
      entitySlots: input.entitySlots ?? {},
      timeRange: {
        start: input.timeRangeStart ? new Date(input.timeRangeStart) : new Date(Date.now() - 86400_000),
        end: input.timeRangeEnd ? new Date(input.timeRangeEnd) : new Date(),
      },
      orgId: ctx.organizationId ?? template.orgId,
      userId: ctx.userSub,
      userName: user?.fullName ?? ctx.userId,
      orgName: org?.name ?? '',
      reportName,
      templateName: template.name,
    };

    // 4. Resolve all variable tags
    const resolved = await resolveAllTags(config, resCtx);

    // 5. Build HTML
    const html = await buildHtml(config, resolved);

    // 6. Generate PDF
    const pdfBuffer = await renderPdf(html, config.pageSettings ?? { pageSize: 'A4', orientation: 'portrait', margins: { top: 20, right: 15, bottom: 20, left: 15 } });

    // 7. Store PDF to disk
    await ensureUploadDir();
    const reportId = crypto.randomUUID();
    const pdfPath = path.join(UPLOAD_DIR, `${reportId}.pdf`);
    await fs.writeFile(pdfPath, pdfBuffer);

    // 8. Create report instance record
    const report = await prisma.reportInstance.create({
      data: {
        id: reportId,
        templateId: input.templateId,
        templateVersion: version,
        name: reportName,
        status: config.signatureConfig?.required ? 'PENDING_SIGNATURE' : 'DRAFT',
        timeRangeStart: resCtx.timeRange.start,
        timeRangeEnd: resCtx.timeRange.end,
        entitySlots: input.entitySlots,
        resolvedData: Object.fromEntries(resolved),
        pdfPath,
        pdfSize: pdfBuffer.length,
        generatedBy: ctx.userSub,
        orgId: resCtx.orgId,
      },
    });

    // 9. Audit log
    await auditLog({
      userId: ctx.userId,
      userRole: ctx.userRole,
      action: 'REPORT_GENERATED',
      targetType: 'report_instance',
      targetId: report.id,
      afterValue: { name: report.name, templateId: input.templateId, templateVersion: version },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      sessionId: ctx.sessionId,
    });

    return report;
  }

  async list(ctx: RequestContext, query: { page?: number; limit?: number; status?: string; templateId?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const where: any = {};

    // Org scoping
    if (ctx.userRole !== 'SUPER_ADMIN' && ctx.organizationId) {
      where.orgId = ctx.organizationId;
    }
    if (query.status) where.status = query.status;
    if (query.templateId) where.templateId = query.templateId;

    const [data, total] = await Promise.all([
      prisma.reportInstance.findMany({
        where,
        include: {
          template: { select: { name: true } },
          generator: { select: { fullName: true, username: true } },
          signatures: { select: { signerRole: true, signerLabel: true, signedAt: true } },
        },
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.reportInstance.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getById(ctx: RequestContext, id: string) {
    const report = await prisma.reportInstance.findUnique({
      where: { id },
      include: {
        template: { select: { name: true } },
        generator: { select: { fullName: true, username: true } },
        signatures: {
          include: { user: { select: { fullName: true, username: true } } },
        },
      },
    });
    if (!report) throw { statusCode: 404, message: 'Report not found' };
    return report;
  }

  async getPdfPath(id: string): Promise<string> {
    const report = await prisma.reportInstance.findUnique({
      where: { id },
      select: { pdfPath: true, name: true },
    });
    if (!report?.pdfPath) throw { statusCode: 404, message: 'PDF not found' };

    // Verify file exists
    try {
      await fs.access(report.pdfPath);
    } catch {
      throw { statusCode: 404, message: 'PDF file missing from storage' };
    }
    return report.pdfPath;
  }

  async delete(ctx: RequestContext, id: string) {
    const report = await prisma.reportInstance.findUnique({ where: { id } });
    if (!report) throw { statusCode: 404, message: 'Report not found' };

    // Delete PDF file
    if (report.pdfPath) {
      try { await fs.unlink(report.pdfPath); } catch { /* file may already be deleted */ }
    }

    await prisma.reportInstance.delete({ where: { id } });

    await auditLog({
      userId: ctx.userId,
      userRole: ctx.userRole,
      action: 'REPORT_DELETED',
      targetType: 'report_instance',
      targetId: id,
      beforeValue: { name: report.name },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      sessionId: ctx.sessionId,
    });

    return { success: true };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/reports/report.service.ts
git commit -m "feat(reports): add report service orchestrator with generate/list/get/delete"
```

---

## Task 9: Report Routes + App Registration

**Files:**
- Create: `apps/api/src/modules/reports/report.routes.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Create report.routes.ts**

Create `apps/api/src/modules/reports/report.routes.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { ReportService } from './report.service.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import fs from 'fs/promises';

export default async function reportRoutes(app: FastifyInstance) {
  const service = new ReportService();

  // POST /api/reports/generate — Generate report from template
  app.post('/generate', {
    preHandler: [app.requirePermission('REPORT_GENERATE')],
    schema: {
      body: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'string' },
          entitySlots: { type: 'object', additionalProperties: { type: 'string' } },
          timeRangeStart: { type: 'string' },
          timeRangeEnd: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('GENERATE_REPORT', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const result = await service.generate(ctx, req.body as any);
    return reply.code(201).send(result);
  });

  // GET /api/reports — List generated reports
  app.get('/', {
    preHandler: [app.requirePermission('REPORT_VIEW')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          limit: { type: 'number' },
          status: { type: 'string' },
          templateId: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.list(ctx, req.query as any);
  });

  // GET /api/reports/:id — Get report details
  app.get('/:id', {
    preHandler: [app.requirePermission('REPORT_VIEW')],
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.getById(ctx, id);
  });

  // GET /api/reports/:id/pdf — Download PDF
  app.get('/:id/pdf', {
    preHandler: [app.requirePermission('REPORT_EXPORT')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const pdfPath = await service.getPdfPath(id);
    const buffer = await fs.readFile(pdfPath);

    const report = await service.getById(buildContext(req), id);
    const filename = `${report.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.pdf`;

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buffer.length)
      .send(buffer);
  });

  // GET /api/reports/:id/preview — Inline PDF preview
  app.get('/:id/preview', {
    preHandler: [app.requirePermission('REPORT_VIEW')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const pdfPath = await service.getPdfPath(id);
    const buffer = await fs.readFile(pdfPath);

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline')
      .header('Content-Length', buffer.length)
      .send(buffer);
  });

  // DELETE /api/reports/:id — Delete report
  app.delete('/:id', {
    preHandler: [app.requirePermission('REPORT_DELETE')],
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_REPORT', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.delete(ctx, id);
  });
}
```

- [ ] **Step 2: Register routes in app.ts**

In `apps/api/src/app.ts`, add the import at the top with other module imports:

```typescript
import reportRoutes from './modules/reports/report.routes.js';
```

Add the route registration near the existing `reportTemplateRoutes` registration:

```typescript
await app.register(reportRoutes, { prefix: '/api/reports' });
```

- [ ] **Step 3: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/reports/report.routes.ts apps/api/src/app.ts
git commit -m "feat(reports): add report routes and register in app"
```

---

## Task 10: Build Verification + API Test

- [ ] **Step 1: Compile backend**

```bash
cd /home/ubuntu/21cfrlogbook
npx tsc -p apps/api/tsconfig.json
```

Fix any compilation errors.

- [ ] **Step 2: Restart API**

```bash
pm2 restart digilog-api
```

- [ ] **Step 3: Test the generate endpoint**

First create or find a template:

```bash
curl -s http://localhost:3000/api/report-templates | jq '.data[0].id'
```

Then generate a report (use superadmin token):

```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"superadmin","password":"Admin@123"}' | jq -r '.token')

# Generate report
curl -s -X POST http://localhost:3000/api/reports/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"templateId":"<TEMPLATE_ID>","entitySlots":{},"timeRangeStart":"2026-04-01T00:00:00Z","timeRangeEnd":"2026-04-15T23:59:59Z"}' | jq .
```

- [ ] **Step 4: Test PDF download**

```bash
REPORT_ID=<from_previous_response>
curl -s http://localhost:3000/api/reports/$REPORT_ID/pdf \
  -H "Authorization: Bearer $TOKEN" \
  -o test-report.pdf
ls -la test-report.pdf
```

- [ ] **Step 5: Test list endpoint**

```bash
curl -s http://localhost:3000/api/reports \
  -H "Authorization: Bearer $TOKEN" | jq '.total, .data[0].name'
```

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(reports): resolve compilation and runtime issues in generation engine"
```
