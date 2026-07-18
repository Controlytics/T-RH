# Telemetry

Time-series data from devices stored in TimescaleDB (database: digilog_tsdb).

## Ingestion
- MQTT: topic `v1/devices/me/telemetry` (via Mosquitto 2.0 broker — Phase 1 of windows-friendly-rewrite swapped from EMQX)
- HTTP: `POST /api/v1/{token}/telemetry`
- Payload formats: simple (`{"temp": 72}`), timestamped (`{"ts": ..., "values": {...}}`), batch (`[{...}, ...]`)

## Storage
- Full history in digilog_tsdb (TimescaleDB hypertable with compression)
- Latest values in PostgreSQL (LatestTelemetry table for fast reads)
- Continuous aggregates: telemetry_hourly, telemetry_daily

## Data Types
Numeric (double), String, Boolean, JSON

## Querying
- Latest values: GET /api/telemetry/latest/:entityId (from LatestTelemetry cache)
- History: GET /api/telemetry/timeseries/:entityId
  - interval: raw, 1h (uses hourly aggregate), 1d (uses daily aggregate)
  - aggregation: AVG, MIN, MAX, SUM, COUNT, LAST
  - Time buckets for downsampling
- Keys: GET /api/telemetry/keys/:entityId (all keys with types and units)

## Retention
Configurable per data type via `retention` config definition. Default: 365 days for telemetry, 48 hours for pipeline traces.

## Pipeline Processing
Telemetry flows through the 11-stage ingestion pipeline: normalization, validation, rule chain execution, persistence, audit, and event emission. Write batching for performance (flush before job acknowledgment for data safety).

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
