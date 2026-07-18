# DigiLog Reports Module — Feature Specification

**Version:** 1.0
**Date:** 2026-04-04
**Status:** Draft
**Phase:** Phase 4

---

## 1. Overview

The Reports module adds configurable report template design, server-side PDF generation with digital signatures, and dynamic data binding from DigiLog entities. Reports pull live data from attributes, identifiers, telemetry, UNS mappings, and computed expressions — then render into professionally formatted PDFs with tables, charts, conditional formatting, and 21 CFR Part 11 compliant electronic signatures.

---

## 2. Goals

1. **Configurable Templates** — Design reusable report layouts with drag-and-drop sections (header, footer, tables, charts, text blocks, signature blocks).
2. **Dynamic Data Binding** — Variable tags resolve at generation time from entity attributes, identifiers, telemetry (with aggregations), timestamps, and UNS paths with wildcard support.
3. **Rich Table Formatting** — Conditional formatting (bold/italic/color on threshold), text wrapping, row limits per page, font control, case transformation, decimal precision.
4. **Chart Support** — Line, bar, pie charts from telemetry data with configurable axes, time ranges, and series.
5. **Digital Signatures** — 21 CFR Part 11 compliant electronic signatures with meaning, timestamp, and user identity.
6. **PDF Output** — Server-side HTML-to-PDF rendering via Puppeteer for pixel-perfect output.
7. **Audit Trail** — All template changes and report generations logged with SHA-256 hash chain.

---

## 3. Terminology

| Term | Definition |
|------|-----------|
| **Report Template** | A saved layout definition with sections, variable tags, table configs, and styling rules. Versioned. |
| **Variable Tag** | A placeholder in a template that resolves to live data at generation time. Syntax: `{{source.path.field[modifier]}}` |
| **Data Source** | The origin of a variable's value — attribute, identifier, telemetry, timestamp, UNS, or computed. |
| **Section** | A discrete block in a template — header, footer, text, table, chart, signature, page-break. |
| **Conditional Rule** | A formatting rule applied to a table cell based on the cell's resolved value (e.g., `value > 100 → bold + red`). |
| **Report Instance** | A generated PDF from a template, with all variables resolved, signed, and stored. |

---

## 4. Variable Tag System

### 4.1 Tag Syntax

```
{{<source>.<path>[<modifier>]}}
```

### 4.2 Data Sources

| Source Prefix | Example | Description |
|---------------|---------|-------------|
| `attr` | `{{attr.<entityId>.temperature}}` | Entity attribute value |
| `attr` | `{{attr.<entityId>.*}}` | All attributes of entity |
| `ident` | `{{ident.<entityId>.serial_number}}` | Entity identifier value |
| `ts` | `{{ts.<entityId>.temperature[last]}}` | Latest telemetry value |
| `ts` | `{{ts.<entityId>.temperature[avg:24h]}}` | Aggregated telemetry (avg, min, max, sum, count) over time window |
| `ts` | `{{ts.<entityId>.temperature[range]}}` | Telemetry series for the report's time range (used in tables/charts) |
| `uns` | `{{uns.site/building/floor/*}}` | UNS path with wildcard resolution |
| `time` | `{{time.now}}` | Current timestamp at generation |
| `time` | `{{time.range.start}}` | Report time range start |
| `time` | `{{time.range.end}}` | Report time range end |
| `meta` | `{{meta.report.name}}` | Report metadata (name, generated_by, template_name) |
| `meta` | `{{meta.user.name}}` | Current user's display name |
| `meta` | `{{meta.org.name}}` | Organization name |
| `calc` | `{{calc.avg(ts.<id>.temp[range])}}` | Computed value from expression |
| `calc` | `{{calc.max(ts.<id>.temp[range]) - calc.min(ts.<id>.temp[range])}}` | Arithmetic on resolved values |

### 4.3 Modifiers (for telemetry)

| Modifier | Example | Description |
|----------|---------|-------------|
| `last` | `[last]` | Most recent value |
| `first` | `[first]` | Oldest value in range |
| `avg:<window>` | `[avg:24h]` | Average over window (1h, 6h, 24h, 7d, 30d) |
| `min:<window>` | `[min:24h]` | Minimum over window |
| `max:<window>` | `[max:24h]` | Maximum over window |
| `sum:<window>` | `[sum:24h]` | Sum over window |
| `count:<window>` | `[count:24h]` | Count over window |
| `range` | `[range]` | Full series within the report's time range |

### 4.4 Entity Resolution

- **Single entity:** Direct entity ID reference — `{{attr.abc123.temperature}}`
- **Entity by identifier:** Resolve by QR/barcode — `{{attr.[ident:QR-001].temperature}}`
- **Entity group:** Reference an equipment group — `{{ts.[group:AHU-1].*.temperature[last]}}` returns array
- **UNS wildcard:** `{{uns.site/bldg1/floor2/*}}` resolves to all matching entity paths

### 4.5 Entity Selection at Generation Time

Templates can define **entity slots** — named placeholders that the user fills when generating a report:

```json
{
  "entitySlots": [
    { "name": "primaryFilter", "label": "Select Filter", "type": "asset_instance", "templateFilter": "HEPA Filter" },
    { "name": "ahu", "label": "Select AHU", "type": "equipment_group" },
    { "name": "room", "label": "Select Room", "type": "uns_path", "pathPrefix": "site/bldg1/" }
  ]
}
```

Tags then reference slots: `{{attr.$primaryFilter.pressure_drop}}` where `$primaryFilter` resolves to the user-selected entity at generation time.

---

## 5. Report Template Structure

### 5.1 Template JSON Schema

```json
{
  "id": "uuid",
  "name": "Monthly Filter Report",
  "description": "Monthly filter cleaning and status report",
  "version": 1,
  "status": "ACTIVE",
  "pageSettings": {
    "size": "A4",
    "orientation": "portrait",
    "margins": { "top": 20, "right": 15, "bottom": 20, "left": 15 }
  },
  "header": {
    "enabled": true,
    "height": 80,
    "elements": [
      { "type": "image", "source": "branding_logo", "position": "left", "width": 120 },
      { "type": "text", "content": "{{meta.org.name}}", "position": "center", "style": { "fontSize": 16, "fontWeight": "bold" } },
      { "type": "text", "content": "Generated: {{time.now}}", "position": "right", "style": { "fontSize": 9, "color": "#666" } }
    ]
  },
  "footer": {
    "enabled": true,
    "height": 40,
    "elements": [
      { "type": "text", "content": "Confidential — {{meta.org.name}}", "position": "left" },
      { "type": "text", "content": "Page {{page.current}} of {{page.total}}", "position": "right" }
    ]
  },
  "entitySlots": [],
  "sections": [],
  "signatureConfig": {
    "required": true,
    "meaning": "I have reviewed and approve this report",
    "signers": [
      { "role": "operator", "label": "Prepared By", "required": true },
      { "role": "reviewer", "label": "Reviewed By", "required": true },
      { "role": "approver", "label": "Approved By", "required": false }
    ]
  }
}
```

### 5.2 Section Types

#### Text Section
```json
{
  "type": "text",
  "content": "This report covers filter {{attr.$primaryFilter.name}} for the period {{time.range.start}} to {{time.range.end}}.",
  "style": { "fontSize": 12, "fontFamily": "Arial", "lineHeight": 1.5 }
}
```

#### Table Section
```json
{
  "type": "table",
  "title": "Telemetry Readings",
  "dataSource": "ts.$primaryFilter.temperature[range]",
  "columns": [
    {
      "key": "timestamp",
      "header": "Time",
      "width": "25%",
      "format": { "type": "datetime", "pattern": "DD/MM/YYYY HH:mm" },
      "style": { "textTransform": "none" }
    },
    {
      "key": "value",
      "header": "Temperature (°C)",
      "width": "25%",
      "format": { "type": "number", "decimalPlaces": 2 },
      "style": { "textAlign": "right" },
      "conditionalRules": [
        { "condition": "gt", "value": 25, "style": { "fontWeight": "bold", "color": "#dc2626" } },
        { "condition": "lt", "value": 15, "style": { "fontWeight": "bold", "color": "#2563eb" } },
        { "condition": "between", "min": 15, "max": 25, "style": { "color": "#16a34a" } }
      ]
    }
  ],
  "tableSettings": {
    "maxRowsPerPage": 30,
    "wrapText": true,
    "showBorders": true,
    "stripedRows": true,
    "headerStyle": { "fontWeight": "bold", "backgroundColor": "#f1f5f9", "textTransform": "uppercase" },
    "bodyStyle": { "fontSize": 10, "fontFamily": "Arial" },
    "pagination": "auto"
  }
}
```

#### Chart Section
```json
{
  "type": "chart",
  "title": "Temperature Trend",
  "chartType": "line",
  "width": "100%",
  "height": 300,
  "dataSeries": [
    { "source": "ts.$primaryFilter.temperature[range]", "label": "Temperature", "color": "#3b82f6" },
    { "source": "ts.$primaryFilter.humidity[range]", "label": "Humidity", "color": "#10b981" }
  ],
  "xAxis": { "type": "time", "label": "Time" },
  "yAxis": { "label": "Value", "min": 0, "max": 100 },
  "showLegend": true,
  "showGrid": true
}
```

#### Signature Section
```json
{
  "type": "signature",
  "label": "Electronic Signature",
  "signers": ["operator", "reviewer", "approver"]
}
```

#### Page Break
```json
{
  "type": "page_break"
}
```

#### Key-Value Section (for attribute/identifier summaries)
```json
{
  "type": "key_value",
  "title": "Filter Details",
  "layout": "two_column",
  "entries": [
    { "label": "Filter Name", "value": "{{attr.$primaryFilter.name}}" },
    { "label": "Serial Number", "value": "{{ident.$primaryFilter.serial_number}}" },
    { "label": "Location", "value": "{{attr.$primaryFilter.location}}" },
    { "label": "Last Cleaned", "value": "{{attr.$primaryFilter.last_cleaned}}", "format": { "type": "datetime" } },
    { "label": "Pressure Drop", "value": "{{ts.$primaryFilter.pressure_drop[last]}}", "format": { "type": "number", "decimalPlaces": 2, "unit": "Pa" } }
  ]
}
```

---

## 6. Conditional Formatting Rules

### 6.1 Supported Conditions

| Condition | Params | Description |
|-----------|--------|-------------|
| `gt` | `value` | Greater than |
| `gte` | `value` | Greater than or equal |
| `lt` | `value` | Less than |
| `lte` | `value` | Less than or equal |
| `eq` | `value` | Equals (string or number) |
| `neq` | `value` | Not equals |
| `between` | `min`, `max` | Value in range (inclusive) |
| `contains` | `value` | String contains |
| `empty` | — | Value is null/empty |
| `not_empty` | — | Value is not null/empty |

### 6.2 Applicable Styles

| Property | Values | Description |
|----------|--------|-------------|
| `fontWeight` | `normal`, `bold` | Bold text |
| `fontStyle` | `normal`, `italic` | Italic text |
| `textDecoration` | `none`, `underline`, `line-through` | Text decoration |
| `color` | hex color | Text color |
| `backgroundColor` | hex color | Cell background |
| `textTransform` | `none`, `uppercase`, `lowercase`, `capitalize` | Case transformation |

### 6.3 Rule Evaluation

- Rules evaluated top-to-bottom; first match wins (unless `applyAll: true`).
- Rules can reference other columns: `{ "condition": "gt", "valueRef": "column:threshold" }` compares against another column's value in the same row.

---

## 7. Table Formatting Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRowsPerPage` | number | 40 | Max data rows per page before auto-pagination |
| `wrapText` | boolean | true | Wrap long text in cells |
| `showBorders` | boolean | true | Show cell borders |
| `stripedRows` | boolean | false | Alternate row background |
| `fontSize` | number | 10 | Body font size in pt |
| `fontFamily` | string | "Arial" | Font family |
| `textTransform` | string | "none" | Case: uppercase, lowercase, capitalize, none |
| `decimalPlaces` | number | — | Limit decimal places for number columns |
| `textAlign` | string | "left" | left, center, right |
| `headerRepeat` | boolean | true | Repeat header on each page |
| `columnWidths` | string[] | auto | Column widths as % or px |
| `emptyValue` | string | "—" | Display value for null/empty cells |

---

## 8. Digital Signature

### 8.1 Signature Flow

1. User generates report → PDF rendered with unsigned signature block (empty lines with labels).
2. User reviews the PDF preview.
3. User clicks "Sign Report" → re-authentication dialog (password required).
4. On success: electronic signature record created with meaning, timestamp, IP, user ID.
5. Signature block in PDF updated with signer name, timestamp, meaning.
6. If multiple signers required: report enters "PENDING_SIGNATURE" state; each signer signs in sequence.
7. Final PDF watermarked as "SIGNED" with all signatures; hash-chained to audit trail.

### 8.2 Signature Record (uses existing ElectronicSignature model)

```
{
  userId, entityType: 'REPORT', entityId: reportInstanceId,
  meaning: "I have reviewed and approve this report",
  timestamp, ipAddress, userAgent
}
```

### 8.3 Signature States

| State | Description |
|-------|-------------|
| `DRAFT` | Report generated but not yet signed |
| `PENDING_SIGNATURE` | Awaiting one or more signatures |
| `SIGNED` | All required signatures collected |
| `REJECTED` | A signer rejected the report |
| `EXPIRED` | Signature window expired (configurable) |

---

## 9. Permissions

| Permission | Description |
|------------|-------------|
| `REPORT_TEMPLATE_READ` | View report templates |
| `REPORT_TEMPLATE_CREATE` | Create new templates |
| `REPORT_TEMPLATE_UPDATE` | Edit templates |
| `REPORT_TEMPLATE_DELETE` | Delete templates |
| `REPORT_GENERATE` | Generate reports from templates |
| `REPORT_VIEW` | View generated report instances |
| `REPORT_SIGN` | Sign reports |
| `REPORT_DELETE` | Delete generated reports |
| `REPORT_EXPORT` | Download report PDFs |

---

## 10. API Endpoints Summary

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | /api/report-templates | REPORT_TEMPLATE_READ | List templates |
| GET | /api/report-templates/:id | REPORT_TEMPLATE_READ | Get template with full config |
| POST | /api/report-templates | REPORT_TEMPLATE_CREATE | Create template |
| PUT | /api/report-templates/:id | REPORT_TEMPLATE_UPDATE | Update template (creates new version) |
| DELETE | /api/report-templates/:id | REPORT_TEMPLATE_DELETE | Delete template |
| PATCH | /api/report-templates/:id/toggle-status | REPORT_TEMPLATE_UPDATE | Activate/archive |
| GET | /api/report-templates/:id/versions | REPORT_TEMPLATE_READ | List template versions |
| POST | /api/reports/generate | REPORT_GENERATE | Generate report from template |
| GET | /api/reports | REPORT_VIEW | List generated reports |
| GET | /api/reports/:id | REPORT_VIEW | Get report instance |
| GET | /api/reports/:id/pdf | REPORT_EXPORT | Download PDF |
| GET | /api/reports/:id/preview | REPORT_VIEW | Preview HTML (before signing) |
| POST | /api/reports/:id/sign | REPORT_SIGN | Sign report |
| POST | /api/reports/:id/reject | REPORT_SIGN | Reject report |
| DELETE | /api/reports/:id | REPORT_DELETE | Delete report instance |
| POST | /api/reports/bulk-delete | REPORT_DELETE | Bulk delete reports |

---

## 11. Report Generation Flow

```
1. User selects template
2. User fills entity slots (select filter, AHU, date range, etc.)
3. POST /api/reports/generate { templateId, entitySlots, timeRange }
4. Backend:
   a. Load template (latest active version)
   b. Resolve all entity slots → concrete entity IDs
   c. For each variable tag in template:
      - Parse tag syntax
      - Query data source (attribute/identifier/telemetry/UNS)
      - Apply modifiers (aggregation, formatting)
   d. For each table section:
      - Query telemetry range data
      - Apply conditional formatting rules
      - Paginate based on maxRowsPerPage
   e. For each chart section:
      - Query telemetry series data
      - Render chart as SVG (server-side via chartjs-node-canvas or similar)
   f. Render HTML template with all resolved data
   g. Convert HTML → PDF via Puppeteer
   h. Store PDF binary + metadata
   i. Create audit trail entry
   j. Return report instance with preview URL
5. User reviews preview
6. User signs → re-auth → electronic signature created
7. PDF finalized with signature block filled
```

---

## 12. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| PDF generation time | < 10s for standard report (< 50 pages) |
| Max report size | 200 pages |
| Max telemetry rows per table | 10,000 |
| PDF file size limit | 50 MB |
| Template versioning | Immutable versions, latest-active pattern |
| Concurrent generation | Queue-based via BullMQ (max 3 concurrent) |
| Signature validity window | Configurable (default: 72 hours) |
| Storage | Local filesystem (dev) / S3 (prod) |

---

## 13. Config Definition

New config key: `report-settings`

```json
{
  "defaultPageSize": "A4",
  "defaultOrientation": "portrait",
  "signatureExpiryHours": 72,
  "maxConcurrentGenerations": 3,
  "maxPagesPerReport": 200,
  "maxTelemetryRowsPerTable": 10000,
  "pdfStoragePath": "./storage/reports",
  "defaultFont": "Arial",
  "defaultFontSize": 10,
  "chartRenderEngine": "chartjs",
  "enableWatermark": true,
  "watermarkText": "CONFIDENTIAL",
  "draftWatermarkText": "DRAFT"
}
```
