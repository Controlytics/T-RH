# Rule Chain Engine

Visual DAG-based data processing with 77 built-in node types across 8 categories.

## Categories
- **INPUT** (1): Entry point
- **FILTER** (12): Message Type, Script Filter, Switch, Check Relation, Check Alarm, Entity Type, GPS Geofencing, etc.
- **ENRICHMENT** (10): Entity Attributes/Details, Originator Attributes/Telemetry/Fields, Related/Parent data, Calculate Delta, etc.
- **TRANSFORM** (9): Script Transform, Rename/Copy/Delete Keys, Calculated Fields, Math Function, JSON Path, Unit Conversion, Split Array
- **ACTION** (15+): Save Timeseries/Attributes, Create/Clear Alarm, Send Email/SMS/Notification, Change Status, RPC, Push to UNS
- **EXTERNAL** (9+): REST API Call, MQTT Publish, Kafka, RabbitMQ, AWS SNS/SQS/Lambda, Slack, AI Request
- **FLOW** (6): Delay, Checkpoint, Sub-chain delegation, Generator, Deduplication, Message Count
- **ANALYTICS** (4): Aggregate Latest/Stream, Alarms Count, Entity Count

## Visual Editor
React Flow canvas with drag-and-drop node palette, Monaco script editor for JavaScript nodes, real-time debug panel, version history with diff view, and test message execution with path highlighting.

## Scripting
Custom JavaScript in sandboxed VM (isolated-vm, configurable timeout and memory). Available context: msg, metadata, msgType, log().

## Debugging
Debug mode records input/output for each node in a ring buffer. Real-time streaming via WebSocket to the debug panel. View traces at Debug > Traces.

## Versioning
Every save creates a version snapshot. Restore any previous version. Export/import as JSON.

## Default Chains
Templates with alarm rules auto-generate a default rule chain: INPUT -> msg-type-filter -> save-timeseries/save-attributes with alarm threshold evaluation.

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
