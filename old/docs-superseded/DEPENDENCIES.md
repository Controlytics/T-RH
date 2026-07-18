# DigiLog — Dependency & Version Reference

> Generated: 2026-04-02

---

## 1. Runtime Environment

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | v24.14.1 | JavaScript runtime |
| npm | 11.11.0 | Package manager |
| TypeScript (root) | 6.0.2 | Root workspace |
| TypeScript (api) | 5.9.3 | Backend compiled TS |
| TypeScript (web) | 5.9.3 | Frontend compiled TS |
| TypeScript (packages) | 5.9.3 | Shared packages |

---

## 2. Infrastructure / Services

| Service | Version | Port(s) | Description |
|---------|---------|---------|-------------|
| PostgreSQL | 18.3 | 5432 | Primary application database (Prisma ORM) |
| TimescaleDB | (extension on PG 18) | 5432 | Time-series data (`digilog_tsdb`) |
| Redis | 5.0.14.1 | 6379 | Job queue (BullMQ), WebSocket pub/sub |
| EMQX | 5.0.26 | 1883, 18083 | MQTT broker for IoT telemetry |
| Nginx | (system) | 80, 443 | Reverse proxy & static file server (EC2) |
| PM2 | (system) | — | Process manager for API (EC2 production) |

---

## 3. Monorepo Tooling

| Package | Version | Purpose |
|---------|---------|---------|
| Turbo (turborepo) | 2.8.7 | Monorepo build orchestration |
| Vite (root) | 7.3.1 | Build tool (root workspace) |
| Vitest | 4.0.18 | Test runner |
| Puppeteer | 24.37.5 | PDF generation / browser automation |
| vite-plugin-pwa | 1.2.0 | Progressive Web App support |

---

## 4. Backend (`@digilog/api`) — Installed Versions

### Core Framework

| Package | Version | Purpose |
|---------|---------|---------|
| fastify | 5.7.4 | HTTP server framework |
| fastify-plugin | 5.1.0 | Plugin wrapper utility |
| @fastify/cors | 11.2.0 | Cross-origin resource sharing |
| @fastify/helmet | 13.0.2 | Security headers |
| @fastify/multipart | 9.4.0 | File upload handling |
| @fastify/rate-limit | 10.3.0 | API rate limiting |
| @fastify/static | 9.0.0 | Static file serving |
| @fastify/swagger | 9.7.0 | OpenAPI spec generation |
| @fastify/swagger-ui | 5.2.5 | Swagger UI dashboard |
| @fastify/websocket | 11.2.0 | WebSocket support |

### Database & ORM

| Package | Version | Purpose |
|---------|---------|---------|
| @prisma/client | 6.19.2 | Database ORM client |
| prisma | 6.19.2 | Prisma CLI (migrations, schema) |
| pg | 8.18.0 | PostgreSQL driver (TimescaleDB pool) |

### Queue & Messaging

| Package | Version | Purpose |
|---------|---------|---------|
| bullmq | 5.70.1 | Job queue (data ingestion, notifications) |
| ioredis | 5.9.3 | Redis client |
| mqtt | 5.15.0 | MQTT client for EMQX broker |

### Auth & Security

| Package | Version | Purpose |
|---------|---------|---------|
| jose | 6.1.3 | JWT creation & verification |
| bcrypt | 5.1.1 | Password hashing |
| ldapts | 8.1.7 | LDAP/Active Directory authentication |
| sanitize-html | 2.17.2 | HTML input sanitization (root dep) |

### Utilities

| Package | Version | Purpose |
|---------|---------|---------|
| zod | 3.25.76 | Schema validation |
| dotenv | 16.6.1 | Environment variable loading |
| pino | 9.14.0 | JSON logger |
| nodemailer | 8.0.2 | Email notifications |
| csv-parse | 6.2.1 | CSV file parsing (bulk upload) |
| adm-zip | 0.5.16 | ZIP file handling |
| qrcode | 1.5.4 | QR code generation |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| tsx | 4.21.0 | TypeScript execution (dev server) |
| @types/node | 22.19.11 | Node.js type definitions |
| @types/bcrypt | 5.0.2 | bcrypt type definitions |
| @types/nodemailer | 7.0.11 | Nodemailer type definitions |
| @types/adm-zip | 0.5.7 | adm-zip type definitions |

---

## 5. Frontend (`@digilog/web`) — Installed Versions

### Core Framework

| Package | Version | Purpose |
|---------|---------|---------|
| react | 19.2.4 | UI library |
| react-dom | 19.2.4 | React DOM renderer |
| react-router | 7.13.0 | Client-side routing |
| react-router-dom | 7.13.0 | Router DOM bindings |
| vite | 6.4.1 | Dev server & bundler |
| @vitejs/plugin-react | 4.7.0 | React plugin for Vite |

### Styling

| Package | Version | Purpose |
|---------|---------|---------|
| tailwindcss | 4.1.18 | Utility-first CSS framework |
| @tailwindcss/vite | 4.1.18 | Tailwind Vite integration |
| tailwind-merge | 2.6.1 | Tailwind class merging utility |
| clsx | 2.1.1 | Conditional className builder |

### UI Components & Visualization

| Package | Version | Purpose |
|---------|---------|---------|
| lucide-react | 0.474.0 | Icon library |
| reactflow | 11.11.4 | Visual node/edge editor (rule chains, pipelines) |
| recharts | 2.15.4 | Charts & graphs |
| @monaco-editor/react | 4.7.0 | Code editor (JSON rule config) |
| signature_pad | 5.1.3 | Digital signature capture |
| qrcode.react | 4.2.0 | QR code React component |

### Forms & Data Fetching

| Package | Version | Purpose |
|---------|---------|---------|
| react-hook-form | 7.71.1 | Form state management |
| @hookform/resolvers | 4.1.3 | Zod resolver for react-hook-form |
| swr | 2.4.0 | Data fetching with caching |
| zod | 3.25.76 | Schema validation (shared with API) |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @types/react | 19.2.14 | React type definitions |
| @types/react-dom | 19.2.3 | React DOM type definitions |

---

## 6. Shared Packages

### `@digilog/shared` (v0.1.0)

| Package | Version | Purpose |
|---------|---------|---------|
| zod | 3.25.76 | Validation schemas shared across API & web |

### `@digilog/db` (v0.1.0)

| Package | Version | Purpose |
|---------|---------|---------|
| @prisma/client | 6.19.2 | Prisma ORM client |
| pg | 8.18.0 | PostgreSQL driver |
| @types/pg | 8.16.0 | PG type definitions |

### `@digilog/queue` (v0.1.0)

| Package | Version | Purpose |
|---------|---------|---------|
| bullmq | 5.70.1 | Job queue library |
| ioredis | 5.9.3 | Redis client |
| zod | 3.25.76 | Schema validation |

---

## 7. Mobile (`apps/android`)

| Package | Version | Purpose |
|---------|---------|---------|
| @capacitor/core | 8.3.0 | Capacitor runtime |
| @capacitor/android | 8.3.0 | Android platform |
| @capacitor/cli | 8.3.0 | Capacitor CLI |

**Build requirements:** JDK 21, Android SDK (located at `C:\Users\hello\`)

---

## 8. Root Workspace Utilities

| Package | Version | Purpose |
|---------|---------|---------|
| jspdf | 4.2.1 | PDF document generation |
| jspdf-autotable | 5.0.7 | PDF table generation |
| html5-qrcode | 2.3.8 | QR/barcode scanner (camera) |
| sanitize-html | 2.17.2 | HTML sanitization |
| @types/sanitize-html | 2.16.1 | Type definitions |

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
