# DigiLog Reports Module — Backend Implementation Guide

**Target Path:** `apps/api/src/modules/reports/` and `apps/api/src/modules/report-templates/`
**Dependencies to Add:** `puppeteer`, `chartjs-node-canvas`, `handlebars`

---

## 1. New Prisma Models

Add these to `apps/api/prisma/schema.prisma`:

```prisma
// ─── Report Templates ───────────────────────────────────────

model ReportTemplate {
  id            String                @id @default(uuid())
  name          String
  description   String?
  status        ReportTemplateStatus  @default(ACTIVE)
  currentVersion Int                  @default(1)
  orgId         String
  org           Organization          @relation(fields: [orgId], references: [id])
  createdBy     String
  creator       User                  @relation("ReportTemplateCreator", fields: [createdBy], references: [id])
  createdAt     DateTime              @default(now())
  updatedAt     DateTime              @updatedAt
  versions      ReportTemplateVersion[]
  reportInstances ReportInstance[]

  @@index([orgId])
  @@index([status])
}

model ReportTemplateVersion {
  id              String          @id @default(uuid())
  templateId      String
  template        ReportTemplate  @relation(fields: [templateId], references: [id], onDelete: Cascade)
  version         Int
  config          Json            // Full template JSON (pageSettings, header, footer, sections, entitySlots, signatureConfig)
  changelog       String?
  createdBy       String
  creator         User            @relation("TemplateVersionCreator", fields: [createdBy], references: [id])
  createdAt       DateTime        @default(now())

  @@unique([templateId, version])
  @@index([templateId])
}

// ─── Report Instances ───────────────────────────────────────

model ReportInstance {
  id              String              @id @default(uuid())
  templateId      String
  template        ReportTemplate      @relation(fields: [templateId], references: [id])
  templateVersion Int                 // Snapshot of which version was used
  name            String              // Generated report name
  status          ReportStatus        @default(DRAFT)
  timeRangeStart  DateTime?
  timeRangeEnd    DateTime?
  entitySlots     Json?               // { slotName: resolvedEntityId } snapshot
  resolvedData    Json?               // Full resolved variable snapshot (for reproducibility)
  pdfPath         String?             // Path to generated PDF file
  pdfSize         Int?                // File size in bytes
  pageCount       Int?
  generatedBy     String
  generator       User                @relation("ReportGenerator", fields: [generatedBy], references: [id])
  orgId           String
  org             Organization        @relation(fields: [orgId], references: [id])
  generatedAt     DateTime            @default(now())
  signedAt        DateTime?
  expiresAt       DateTime?           // Signature window expiry
  signatures      ReportSignature[]

  @@index([orgId])
  @@index([templateId])
  @@index([status])
  @@index([generatedAt])
}

model ReportSignature {
  id              String          @id @default(uuid())
  reportId        String
  report          ReportInstance  @relation(fields: [reportId], references: [id], onDelete: Cascade)
  signerRole      String          // "operator", "reviewer", "approver"
  signerLabel     String          // "Prepared By", "Reviewed By"
  userId          String
  user            User            @relation("ReportSigner", fields: [userId], references: [id])
  meaning         String          // "I have reviewed and approve this report"
  signedAt        DateTime        @default(now())
  ipAddress       String?
  userAgent       String?

  @@unique([reportId, signerRole])
  @@index([reportId])
  @@index([userId])
}

// ─── Enums ──────────────────────────────────────────────────

enum ReportTemplateStatus {
  ACTIVE
  ARCHIVED
  DRAFT
}

enum ReportStatus {
  DRAFT
  PENDING_SIGNATURE
  SIGNED
  REJECTED
  EXPIRED
}
```

### User Model Additions

Add these relations to the existing `User` model:

```prisma
model User {
  // ... existing fields ...
  reportTemplatesCreated  ReportTemplate[]        @relation("ReportTemplateCreator")
  templateVersionsCreated ReportTemplateVersion[] @relation("TemplateVersionCreator")
  reportsGenerated        ReportInstance[]         @relation("ReportGenerator")
  reportSignatures        ReportSignature[]        @relation("ReportSigner")
}
```

### Organization Model Additions

```prisma
model Organization {
  // ... existing fields ...
  reportTemplates   ReportTemplate[]
  reportInstances   ReportInstance[]
}
```

---

## 2. Permissions

Add to `packages/shared/src/permissions.ts`:

```typescript
// Report Template permissions
REPORT_TEMPLATE_READ = 'REPORT_TEMPLATE_READ',
REPORT_TEMPLATE_CREATE = 'REPORT_TEMPLATE_CREATE',
REPORT_TEMPLATE_UPDATE = 'REPORT_TEMPLATE_UPDATE',
REPORT_TEMPLATE_DELETE = 'REPORT_TEMPLATE_DELETE',

// Report Instance permissions
REPORT_GENERATE = 'REPORT_GENERATE',
REPORT_VIEW = 'REPORT_VIEW',
REPORT_SIGN = 'REPORT_SIGN',
REPORT_DELETE = 'REPORT_DELETE',
REPORT_EXPORT = 'REPORT_EXPORT',
```

---

## 3. Module Structure

```
apps/api/src/modules/
├── report-templates/
│   ├── routes.ts              # Route registration
│   ├── handlers.ts            # Request handlers
│   ├── service.ts             # Business logic (CRUD, versioning)
│   ├── schemas.ts             # Zod validation schemas
│   └── types.ts               # TypeScript types
├── reports/
│   ├── routes.ts              # Route registration
│   ├── handlers.ts            # Request handlers
│   ├── service.ts             # Generation orchestration
│   ├── schemas.ts             # Zod validation
│   ├── types.ts               # TypeScript types
│   ├── variable-resolver.ts   # Tag parsing + data source resolution
│   ├── data-sources/
│   │   ├── attribute-source.ts    # Resolve attr.* tags
│   │   ├── identifier-source.ts   # Resolve ident.* tags
│   │   ├── telemetry-source.ts    # Resolve ts.* tags (queries TimescaleDB)
│   │   ├── uns-source.ts          # Resolve uns.* tags with wildcard
│   │   ├── timestamp-source.ts    # Resolve time.* tags
│   │   ├── meta-source.ts         # Resolve meta.* tags
│   │   └── calc-source.ts         # Resolve calc.* expressions
│   ├── renderers/
│   │   ├── html-renderer.ts       # Build HTML from resolved template
│   │   ├── pdf-renderer.ts        # Puppeteer HTML → PDF
│   │   ├── chart-renderer.ts      # chartjs-node-canvas → SVG/PNG
│   │   └── table-renderer.ts      # Table HTML with conditional formatting
│   ├── templates/
│   │   ├── report-base.hbs        # Handlebars base HTML template
│   │   ├── section-table.hbs      # Table section partial
│   │   ├── section-chart.hbs      # Chart section partial
│   │   ├── section-text.hbs       # Text section partial
│   │   ├── section-kv.hbs         # Key-value section partial
│   │   ├── section-signature.hbs  # Signature block partial
│   │   └── styles.css             # PDF print stylesheet
│   └── signature-service.ts   # E-signature logic
```

---

## 4. Key Service Implementations

### 4.1 Variable Resolver (`variable-resolver.ts`)

```typescript
import { AttributeSource } from './data-sources/attribute-source';
import { TelemetrySource } from './data-sources/telemetry-source';
// ... other sources

interface ResolvedTag {
  raw: string;           // Original tag: "{{ts.$primaryFilter.temperature[last]}}"
  source: string;        // "ts"
  path: string;          // "$primaryFilter.temperature"
  modifier?: string;     // "last"
  resolvedValue: any;    // 23.5
  error?: string;        // Resolution error if any
}

interface ResolutionContext {
  entitySlots: Record<string, string>;  // { primaryFilter: "entity-uuid-123" }
  timeRange: { start: Date; end: Date };
  orgId: string;
  userId: string;
}

export class VariableResolver {
  private sources: Map<string, DataSource>;

  constructor(prisma: PrismaClient, tsPool: Pool) {
    this.sources = new Map([
      ['attr', new AttributeSource(prisma)],
      ['ident', new IdentifierSource(prisma)],
      ['ts', new TelemetrySource(tsPool)],
      ['uns', new UnsSource(prisma)],
      ['time', new TimestampSource()],
      ['meta', new MetaSource(prisma)],
      ['calc', new CalcSource()],
    ]);
  }

  // Extract all tags from template config JSON
  extractTags(config: TemplateConfig): string[] {
    const tagRegex = /\{\{([^}]+)\}\}/g;
    const json = JSON.stringify(config);
    const tags: string[] = [];
    let match;
    while ((match = tagRegex.exec(json)) !== null) {
      tags.push(match[1]);
    }
    return [...new Set(tags)]; // Deduplicate
  }

  // Parse a single tag string into components
  parseTag(tag: string): ParsedTag {
    // Handle slot references: $slotName → resolved entity ID
    // Handle modifiers: [last], [avg:24h], [range]
    // Handle nested paths: attr.entityId.field
    // ...
  }

  // Resolve all tags in a template config
  async resolveAll(config: TemplateConfig, context: ResolutionContext): Promise<Map<string, ResolvedTag>> {
    const tags = this.extractTags(config);
    const resolved = new Map<string, ResolvedTag>();

    // Batch by source type for efficient querying
    const batched = this.batchBySource(tags);

    for (const [sourceKey, sourceTags] of batched) {
      const source = this.sources.get(sourceKey);
      if (!source) continue;
      const results = await source.resolveBatch(sourceTags, context);
      for (const [tag, result] of results) {
        resolved.set(tag, result);
      }
    }

    return resolved;
  }
}
```

### 4.2 Telemetry Source (`data-sources/telemetry-source.ts`)

```typescript
export class TelemetrySource implements DataSource {
  constructor(private tsPool: Pool) {}

  async resolveBatch(tags: ParsedTag[], context: ResolutionContext): Promise<Map<string, ResolvedTag>> {
    const results = new Map();

    for (const tag of tags) {
      const entityId = this.resolveEntityRef(tag.path, context);
      const field = tag.field;
      const modifier = tag.modifier;

      if (modifier === 'last') {
        // Query latest_telemetry table
        const row = await this.tsPool.query(
          `SELECT value, ts FROM latest_telemetry WHERE entity_id = $1 AND key = $2`,
          [entityId, field]
        );
        results.set(tag.raw, { ...tag, resolvedValue: row.rows[0]?.value });
      }
      else if (modifier === 'range') {
        // Query time-series range for tables/charts
        const rows = await this.tsPool.query(
          `SELECT ts, value FROM telemetry
           WHERE entity_id = $1 AND key = $2 AND ts BETWEEN $3 AND $4
           ORDER BY ts ASC`,
          [entityId, field, context.timeRange.start, context.timeRange.end]
        );
        results.set(tag.raw, { ...tag, resolvedValue: rows.rows });
      }
      else if (modifier?.startsWith('avg:') || modifier?.startsWith('min:') || modifier?.startsWith('max:') || modifier?.startsWith('sum:') || modifier?.startsWith('count:')) {
        const [aggFn, window] = modifier.split(':');
        const windowMs = parseWindow(window); // "24h" → ms
        const since = new Date(Date.now() - windowMs);
        const sqlFn = aggFn === 'avg' ? 'AVG' : aggFn === 'min' ? 'MIN' : aggFn === 'max' ? 'MAX' : aggFn === 'sum' ? 'SUM' : 'COUNT';
        const row = await this.tsPool.query(
          `SELECT ${sqlFn}((value)::numeric) as result FROM telemetry
           WHERE entity_id = $1 AND key = $2 AND ts >= $3`,
          [entityId, field, since]
        );
        results.set(tag.raw, { ...tag, resolvedValue: row.rows[0]?.result });
      }
    }

    return results;
  }
}
```

### 4.3 PDF Renderer (`renderers/pdf-renderer.ts`)

```typescript
import puppeteer from 'puppeteer';

export class PdfRenderer {
  private browser: puppeteer.Browser | null = null;

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
  }

  async renderPdf(html: string, options: PdfOptions): Promise<Buffer> {
    if (!this.browser) await this.initialize();

    const page = await this.browser!.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: options.pageSize || 'A4',
      landscape: options.orientation === 'landscape',
      margin: {
        top: `${options.margins?.top || 20}mm`,
        right: `${options.margins?.right || 15}mm`,
        bottom: `${options.margins?.bottom || 20}mm`,
        left: `${options.margins?.left || 15}mm`,
      },
      displayHeaderFooter: false, // We handle header/footer in HTML for more control
      printBackground: true,
    });

    await page.close();
    return Buffer.from(pdfBuffer);
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}
```

### 4.4 Chart Renderer (`renderers/chart-renderer.ts`)

```typescript
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

export class ChartRenderer {
  private chartJSNodeCanvas: ChartJSNodeCanvas;

  constructor() {
    this.chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: 800,
      height: 400,
      backgroundColour: 'white',
    });
  }

  async renderChart(chartConfig: ChartSectionConfig, resolvedData: Map<string, any>): Promise<string> {
    const datasets = chartConfig.dataSeries.map(series => {
      const data = resolvedData.get(series.source); // Array of { ts, value }
      return {
        label: series.label,
        data: data.map((d: any) => ({ x: d.ts, y: parseFloat(d.value) })),
        borderColor: series.color,
        backgroundColor: series.color + '20',
        fill: false,
      };
    });

    const configuration = {
      type: chartConfig.chartType,
      data: { datasets },
      options: {
        scales: {
          x: { type: 'time', title: { display: true, text: chartConfig.xAxis?.label } },
          y: { title: { display: true, text: chartConfig.yAxis?.label }, min: chartConfig.yAxis?.min, max: chartConfig.yAxis?.max },
        },
        plugins: { legend: { display: chartConfig.showLegend } },
      },
    };

    const imageBuffer = await this.chartJSNodeCanvas.renderToBuffer(configuration as any);
    return `data:image/png;base64,${imageBuffer.toString('base64')}`;
  }
}
```

### 4.5 Table Renderer with Conditional Formatting (`renderers/table-renderer.ts`)

```typescript
export class TableRenderer {
  renderTable(config: TableSectionConfig, data: any[]): string {
    const { columns, tableSettings } = config;
    const maxRows = tableSettings?.maxRowsPerPage || 40;
    const pages = this.paginate(data, maxRows);

    let html = '';
    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      html += `<div class="table-page">`;
      if (config.title) html += `<h3 class="table-title">${config.title}</h3>`;
      html += `<table class="report-table ${tableSettings?.stripedRows ? 'striped' : ''}">`;

      // Header
      html += `<thead><tr>`;
      for (const col of columns) {
        const headerStyle = this.buildStyleString(tableSettings?.headerStyle || {});
        html += `<th style="${headerStyle}; width: ${col.width || 'auto'}">${col.header}</th>`;
      }
      html += `</tr></thead>`;

      // Body rows
      html += `<tbody>`;
      for (const row of pages[pageIdx]) {
        html += `<tr>`;
        for (const col of columns) {
          let value = row[col.key];
          value = this.formatValue(value, col.format);
          const cellStyle = this.evaluateConditionalRules(value, row, col.conditionalRules);
          const textTransform = col.style?.textTransform || tableSettings?.bodyStyle?.textTransform || 'none';
          value = this.applyTextTransform(value, textTransform);
          const wrapStyle = tableSettings?.wrapText ? 'word-wrap: break-word;' : 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
          html += `<td style="${cellStyle}; ${wrapStyle}; text-align: ${col.style?.textAlign || 'left'}; font-size: ${tableSettings?.bodyStyle?.fontSize || 10}pt;">${value ?? tableSettings?.emptyValue ?? '—'}</td>`;
        }
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;

      // Page break between table pages (not after last)
      if (pageIdx < pages.length - 1) {
        html += `<div class="page-break"></div>`;
      }
    }

    return html;
  }

  private evaluateConditionalRules(value: any, row: any, rules?: ConditionalRule[]): string {
    if (!rules || rules.length === 0) return '';
    const numValue = parseFloat(value);

    for (const rule of rules) {
      let match = false;
      const compareValue = rule.valueRef?.startsWith('column:')
        ? parseFloat(row[rule.valueRef.replace('column:', '')])
        : rule.value;

      switch (rule.condition) {
        case 'gt':  match = numValue > compareValue; break;
        case 'gte': match = numValue >= compareValue; break;
        case 'lt':  match = numValue < compareValue; break;
        case 'lte': match = numValue <= compareValue; break;
        case 'eq':  match = String(value) === String(compareValue); break;
        case 'neq': match = String(value) !== String(compareValue); break;
        case 'between': match = numValue >= rule.min && numValue <= rule.max; break;
        case 'contains': match = String(value).includes(String(compareValue)); break;
        case 'empty': match = value == null || value === ''; break;
        case 'not_empty': match = value != null && value !== ''; break;
      }

      if (match) {
        return this.buildStyleString(rule.style);
      }
    }
    return '';
  }

  private formatValue(value: any, format?: ColumnFormat): string {
    if (value == null) return '';
    if (format?.type === 'number' && format.decimalPlaces != null) {
      const num = parseFloat(value);
      if (!isNaN(num)) return num.toFixed(format.decimalPlaces) + (format.unit ? ` ${format.unit}` : '');
    }
    if (format?.type === 'datetime' && format.pattern) {
      // Use dayjs or date-fns to format
      return formatDate(value, format.pattern);
    }
    return String(value);
  }

  private applyTextTransform(value: string, transform: string): string {
    switch (transform) {
      case 'uppercase': return value.toUpperCase();
      case 'lowercase': return value.toLowerCase();
      case 'capitalize': return value.replace(/\b\w/g, c => c.toUpperCase());
      default: return value;
    }
  }

  private paginate(data: any[], maxRows: number): any[][] {
    const pages: any[][] = [];
    for (let i = 0; i < data.length; i += maxRows) {
      pages.push(data.slice(i, i + maxRows));
    }
    return pages.length > 0 ? pages : [[]];
  }

  private buildStyleString(style: Record<string, any>): string {
    const map: Record<string, string> = {
      fontWeight: 'font-weight', fontStyle: 'font-style', textDecoration: 'text-decoration',
      color: 'color', backgroundColor: 'background-color', textTransform: 'text-transform',
      fontSize: 'font-size',
    };
    return Object.entries(style)
      .map(([k, v]) => `${map[k] || k}: ${typeof v === 'number' ? v + 'pt' : v}`)
      .join('; ');
  }
}
```

### 4.6 Report Generation Service (`reports/service.ts`)

```typescript
export class ReportService {
  constructor(
    private prisma: PrismaClient,
    private tsPool: Pool,
    private variableResolver: VariableResolver,
    private htmlRenderer: HtmlRenderer,
    private pdfRenderer: PdfRenderer,
    private chartRenderer: ChartRenderer,
  ) {}

  async generateReport(input: GenerateReportInput, userId: string, orgId: string): Promise<ReportInstance> {
    // 1. Load template + active version
    const template = await this.prisma.reportTemplate.findUnique({
      where: { id: input.templateId },
      include: { versions: { where: { version: undefined }, orderBy: { version: 'desc' }, take: 1 } },
    });
    const latestVersion = template.versions[0];
    const config = latestVersion.config as TemplateConfig;

    // 2. Build resolution context
    const context: ResolutionContext = {
      entitySlots: input.entitySlots || {},
      timeRange: { start: new Date(input.timeRangeStart), end: new Date(input.timeRangeEnd) },
      orgId, userId,
    };

    // 3. Resolve all variable tags
    const resolvedTags = await this.variableResolver.resolveAll(config, context);

    // 4. Render charts (produce base64 images)
    const chartImages = new Map<number, string>();
    for (let i = 0; i < config.sections.length; i++) {
      if (config.sections[i].type === 'chart') {
        const img = await this.chartRenderer.renderChart(config.sections[i], resolvedTags);
        chartImages.set(i, img);
      }
    }

    // 5. Build HTML
    const html = await this.htmlRenderer.render(config, resolvedTags, chartImages, context);

    // 6. Convert to PDF
    const pdfBuffer = await this.pdfRenderer.renderPdf(html, config.pageSettings);

    // 7. Store PDF
    const pdfPath = `storage/reports/${orgId}/${Date.now()}-${template.name.replace(/\s+/g, '_')}.pdf`;
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(pdfPath, pdfBuffer);

    // 8. Create report instance
    const report = await this.prisma.reportInstance.create({
      data: {
        templateId: template.id,
        templateVersion: latestVersion.version,
        name: `${template.name} - ${new Date().toISOString().split('T')[0]}`,
        status: config.signatureConfig?.required ? 'PENDING_SIGNATURE' : 'SIGNED',
        timeRangeStart: context.timeRange.start,
        timeRangeEnd: context.timeRange.end,
        entitySlots: input.entitySlots,
        resolvedData: Object.fromEntries(resolvedTags), // Snapshot for reproducibility
        pdfPath,
        pdfSize: pdfBuffer.length,
        pageCount: null, // Can extract from Puppeteer
        generatedBy: userId,
        orgId,
        expiresAt: config.signatureConfig?.required
          ? new Date(Date.now() + (72 * 60 * 60 * 1000))  // From config
          : null,
      },
    });

    // 9. Audit trail
    await this.auditLog('REPORT_GENERATED', report.id, userId, orgId);

    return report;
  }

  async signReport(reportId: string, signerRole: string, meaning: string, userId: string, ip: string, userAgent: string) {
    return await this.prisma.$transaction(async (tx) => {
      const report = await tx.reportInstance.findUniqueOrThrow({ where: { id: reportId }, include: { signatures: true, template: { include: { versions: true } } } });

      if (report.status !== 'PENDING_SIGNATURE' && report.status !== 'DRAFT') {
        throw new Error('Report is not in a signable state');
      }

      // Create signature
      const signature = await tx.reportSignature.create({
        data: {
          reportId, signerRole, signerLabel: this.getSignerLabel(report, signerRole),
          userId, meaning, ipAddress: ip, userAgent,
        },
      });

      // Check if all required signatures collected
      const config = report.template.versions[0]?.config as any;
      const requiredSigners = (config?.signatureConfig?.signers || []).filter((s: any) => s.required);
      const collectedRoles = [...report.signatures.map(s => s.signerRole), signerRole];
      const allSigned = requiredSigners.every((s: any) => collectedRoles.includes(s.role));

      if (allSigned) {
        await tx.reportInstance.update({ where: { id: reportId }, data: { status: 'SIGNED', signedAt: new Date() } });
        // Re-render PDF with filled signature block
        // ... (re-generate final PDF with signatures)
      }

      await this.auditLog('REPORT_SIGNED', reportId, userId, report.orgId);
      return signature;
    });
  }
}
```

---

## 5. BullMQ Job Queue

For large reports, use async generation via BullMQ:

```typescript
// apps/api/src/modules/reports/report-queue.ts
import { Queue, Worker } from 'bullmq';

export const reportQueue = new Queue('report-generation', { connection: redisConnection });

export const reportWorker = new Worker('report-generation', async (job) => {
  const { templateId, entitySlots, timeRange, userId, orgId } = job.data;
  const reportService = getReportService(); // From DI container
  const report = await reportService.generateReport(
    { templateId, entitySlots, timeRangeStart: timeRange.start, timeRangeEnd: timeRange.end },
    userId, orgId
  );
  return report.id;
}, {
  connection: redisConnection,
  concurrency: 3, // Max concurrent PDF generations
});
```

---

## 6. Config Definition

Create `apps/api/src/modules/config/definitions/report-settings.def.ts`:

```typescript
import { defineConfig } from '../config-registry';

export default defineConfig({
  key: 'report-settings',
  label: 'Report Settings',
  category: 'reports',
  schema: z.object({
    defaultPageSize: z.enum(['A4', 'Letter', 'Legal']).default('A4'),
    defaultOrientation: z.enum(['portrait', 'landscape']).default('portrait'),
    signatureExpiryHours: z.number().min(1).max(720).default(72),
    maxConcurrentGenerations: z.number().min(1).max(10).default(3),
    maxPagesPerReport: z.number().min(1).max(500).default(200),
    maxTelemetryRowsPerTable: z.number().min(100).max(100000).default(10000),
    pdfStoragePath: z.string().default('./storage/reports'),
    defaultFont: z.string().default('Arial'),
    defaultFontSize: z.number().min(6).max(24).default(10),
    enableWatermark: z.boolean().default(true),
    draftWatermarkText: z.string().default('DRAFT'),
  }),
  defaults: {
    defaultPageSize: 'A4',
    defaultOrientation: 'portrait',
    signatureExpiryHours: 72,
    maxConcurrentGenerations: 3,
    maxPagesPerReport: 200,
    maxTelemetryRowsPerTable: 10000,
    pdfStoragePath: './storage/reports',
    defaultFont: 'Arial',
    defaultFontSize: 10,
    enableWatermark: true,
    draftWatermarkText: 'DRAFT',
  },
});
```

---

## 7. Zod Schemas

Create `apps/api/src/modules/report-templates/schemas.ts`:

```typescript
import { z } from 'zod';

const conditionalRuleSchema = z.object({
  condition: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between', 'contains', 'empty', 'not_empty']),
  value: z.union([z.number(), z.string()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  valueRef: z.string().optional(),
  style: z.record(z.string()).default({}),
});

const columnFormatSchema = z.object({
  type: z.enum(['number', 'datetime', 'text']),
  decimalPlaces: z.number().min(0).max(10).optional(),
  pattern: z.string().optional(),
  unit: z.string().optional(),
});

const tableColumnSchema = z.object({
  key: z.string(),
  header: z.string(),
  width: z.string().optional(),
  format: columnFormatSchema.optional(),
  style: z.record(z.string()).optional(),
  conditionalRules: z.array(conditionalRuleSchema).optional(),
});

const tableSettingsSchema = z.object({
  maxRowsPerPage: z.number().min(1).max(200).default(40),
  wrapText: z.boolean().default(true),
  showBorders: z.boolean().default(true),
  stripedRows: z.boolean().default(false),
  headerStyle: z.record(z.string()).optional(),
  bodyStyle: z.record(z.string()).optional(),
  headerRepeat: z.boolean().default(true),
  emptyValue: z.string().default('—'),
});

const sectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), content: z.string(), style: z.record(z.string()).optional() }),
  z.object({ type: z.literal('table'), title: z.string().optional(), dataSource: z.string(), columns: z.array(tableColumnSchema), tableSettings: tableSettingsSchema.optional() }),
  z.object({ type: z.literal('chart'), title: z.string().optional(), chartType: z.enum(['line', 'bar', 'pie', 'scatter', 'area']), dataSeries: z.array(z.object({ source: z.string(), label: z.string(), color: z.string().optional() })), xAxis: z.record(z.any()).optional(), yAxis: z.record(z.any()).optional(), width: z.string().optional(), height: z.number().optional(), showLegend: z.boolean().optional(), showGrid: z.boolean().optional() }),
  z.object({ type: z.literal('key_value'), title: z.string().optional(), layout: z.enum(['single_column', 'two_column', 'three_column']).optional(), entries: z.array(z.object({ label: z.string(), value: z.string(), format: columnFormatSchema.optional() })) }),
  z.object({ type: z.literal('signature'), label: z.string().optional(), signers: z.array(z.string()) }),
  z.object({ type: z.literal('page_break') }),
]);

const entitySlotSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['asset_instance', 'equipment_group', 'uns_path']),
  templateFilter: z.string().optional(),
  pathPrefix: z.string().optional(),
});

const signerConfigSchema = z.object({
  role: z.string(),
  label: z.string(),
  required: z.boolean().default(true),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  config: z.object({
    pageSettings: z.object({
      size: z.enum(['A4', 'Letter', 'Legal']).default('A4'),
      orientation: z.enum(['portrait', 'landscape']).default('portrait'),
      margins: z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }).optional(),
    }),
    header: z.object({ enabled: z.boolean(), height: z.number().optional(), elements: z.array(z.any()) }).optional(),
    footer: z.object({ enabled: z.boolean(), height: z.number().optional(), elements: z.array(z.any()) }).optional(),
    entitySlots: z.array(entitySlotSchema).optional(),
    sections: z.array(sectionSchema),
    signatureConfig: z.object({
      required: z.boolean().default(false),
      meaning: z.string().optional(),
      signers: z.array(signerConfigSchema).optional(),
    }).optional(),
  }),
});

export const generateReportSchema = z.object({
  templateId: z.string().uuid(),
  entitySlots: z.record(z.string()).optional(),
  timeRangeStart: z.string().datetime(),
  timeRangeEnd: z.string().datetime(),
  name: z.string().optional(),
});

export const signReportSchema = z.object({
  signerRole: z.string(),
  meaning: z.string().min(1),
  password: z.string().min(1), // For re-authentication
});
```

---

## 8. Dependencies to Install

```bash
cd apps/api
npm install puppeteer chartjs-node-canvas chart.js handlebars dayjs
npm install -D @types/handlebars
```

**Production note:** On EC2, Puppeteer needs Chromium dependencies:
```bash
sudo apt-get install -y libx11-xcb1 libxcomposite1 libxdamage1 libxi6 libxtst6 libnss3 \
  libcups2 libxss1 libxrandr2 libasound2 libatk1.0-0 libatk-bridge2.0-0 libpangocairo-1.0-0 \
  libgtk-3-0 libgbm1 fonts-liberation
```

---

## 9. Migration Steps

1. Add Prisma models → run `npx prisma migrate dev --name add-reports-module`
2. Add permissions to seed file
3. Register modules in `app.ts`
4. Add config definition
5. Create storage directory structure
