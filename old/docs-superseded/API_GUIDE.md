# DigiLog API Guide

## Base URL
```
Production: http://34.232.224.0/api
Development: http://localhost:3000/api
```

## Authentication

### Login
```bash
POST /api/auth/login
Content-Type: application/json

{"username": "superadmin", "password": "Admin@123", "force": true}
```

Response includes a JWT token. Use it in subsequent requests:
```
Authorization: Bearer <token>
```

### Interactive Docs
- Production Swagger UI: `http://34.232.224.0/docs`
- Development Swagger UI: `http://localhost:3000/docs`

## API Modules (34 total)

### Auth (`/api/auth`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | Authenticate and get JWT |
| POST | `/logout` | End session |
| GET | `/me` | Get current user profile |
| PUT | `/profile` | Update own profile |
| POST | `/change-password` | Change password |
| POST | `/refresh` | Refresh JWT token |
| POST | `/verify-password` | Re-authenticate for sensitive ops |
| POST | `/forgot-password` | Request password reset |

### Users (`/api/users`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List users (paginated, filterable) |
| POST | `/` | Create user |
| GET | `/:id` | Get user details |
| PUT | `/:id` | Update user |
| DELETE | `/:id` | Delete user |
| POST | `/:id/enable` | Enable user |
| POST | `/:id/disable` | Disable user |
| POST | `/:id/unlock` | Unlock locked account |
| GET | `/stats` | User statistics |
| POST | `/bulk-delete` | Bulk delete users |

### Roles (`/api/roles`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all roles |
| POST | `/` | Create custom role |
| PUT | `/:id` | Update role |
| DELETE | `/:id` | Delete role |

### Entity Templates (`/api/templates`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List templates |
| POST | `/` | Create template |
| GET | `/:id` | Get template with schema |
| PUT | `/:id` | Update template |
| DELETE | `/:id` | Soft-delete template |
| GET | `/:id/versions` | Version history |

### Entity Instances (`/api/instances`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List instances (paginated) |
| GET | `/tree` | Full hierarchy tree |
| POST | `/` | Create instance |
| GET | `/:id` | Get instance details |
| PUT | `/:id` | Update instance |
| DELETE | `/:id` | Cascade delete |
| GET | `/:id/children` | Direct children |

### Relationships (`/api/relationships`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List relationships |
| POST | `/` | Create bidirectional pair |
| DELETE | `/:id` | Delete pair |

### Identifiers (`/api/identifiers`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List identifiers |
| POST | `/` | Create identifier |
| DELETE | `/:id` | Delete identifier |
| POST | `/lookup` | Lookup entity by identifier value |

### Data Ingestion (`/api/v1`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/:token/telemetry` | Send telemetry data |
| POST | `/:token/attributes` | Update device attributes |
| GET | `/:token/attributes` | Get shared attributes |
| POST | `/:token/event` | Send device event |
| POST | `/:token/binary` | Upload binary data |

### Rule Chains (`/api/rule-chains`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List rule chains |
| POST | `/` | Create chain |
| GET | `/:id` | Get chain with nodes |
| PUT | `/:id` | Update chain |
| DELETE | `/:id` | Delete chain |
| POST | `/:id/save` | Atomic save (nodes + connections) |
| GET | `/node-types` | List 77 available node types |
| GET | `/:id/debug` | Get debug buffer |

### Telemetry Queries (`/api/queries/telemetry`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:entityId` | Latest telemetry values |
| GET | `/:entityId/history` | Historical data with aggregation |
| GET | `/:entityId/keys` | Available telemetry keys |

### Alarms (`/api/alarms`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List alarms (filterable) |
| GET | `/summary` | Active/acknowledged/cleared counts |
| POST | `/:id/acknowledge` | Acknowledge with e-signature |
| POST | `/:id/clear` | Clear with e-signature |

### UNS (`/api/uns`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tree` | Browse UNS hierarchy |
| GET | `/entity/:entityId` | Get entity UNS path |
| PUT | `/entity/:entityId` | Override UNS path |

### Notifications (`/api/notifications`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List notifications |
| GET | `/unread-count` | Unread badge count |
| POST | `/:id/read` | Mark as read |
| POST | `/read-all` | Mark all as read |

### Notification Rules (`/api/notification-rules`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List notification rules |
| POST | `/` | Create rule |
| PUT | `/:id` | Update rule |
| DELETE | `/:id` | Delete rule |

### Configuration (`/api/config`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/registry/manifest` | All config modules (23 definitions) |
| GET | `/dynamic/:moduleKey` | Get module config |
| PUT | `/dynamic/:moduleKey` | Update module config |

### Audit Trail (`/api/audit`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Search audit entries |
| GET | `/:id` | Get entry with integrity check |
| DELETE | `/:id` | Delete entry (SUPER_ADMIN) |

### Help Articles (`/api/help`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List articles |
| GET | `/:key` | Get article by key |
| POST | `/` | Create article |
| PUT | `/:id` | Update article |
| DELETE | `/:id` | Soft-delete article |
| GET | `/:id/versions` | Version history |

### Retention (`/api/retention`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config/retention` | Get retention policies |
| PUT | `/config/retention` | Update retention policies |
| POST | `/retention/execute` | Delete old data |
| POST | `/retention/execute-range` | Delete by time range |
| POST | `/retention/delete-keys` | Delete specific keys |
| POST | `/retention/delete-records` | Delete specific records |

### Backup (`/api/backup`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/export` | Export database (JSON/SQL/CSV) |
| POST | `/validate` | Validate backup file |
| POST | `/restore` | Restore from backup |

### Connectivity (`/api/connectivity`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:entityId` | Get connectivity status |
| POST | `/:entityId/token` | Provision access token |
| DELETE | `/:entityId/token` | Revoke token |
| POST | `/:entityId/test` | Test connectivity |
| GET | `/:entityId/snippets` | Generate code snippets |

### LDAP (`/api/ldap`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config` | Get LDAP configuration |
| PUT | `/config` | Update LDAP configuration |
| POST | `/test` | Test LDAP connection |

### System Health (`/api/system-health`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | System health metrics |

### Entity Assignments (`/api/entity-assignments`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List entity assignments |
| POST | `/` | Create assignment |
| DELETE | `/:id` | Delete assignment |

### User Groups (`/api/user-groups`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List user groups |
| POST | `/` | Create group |
| PUT | `/:id` | Update group |
| DELETE | `/:id` | Delete group |

### QR Codes (`/api/qr-codes`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/generate` | Generate QR code |
| GET | `/:entityId` | Get QR code |
| GET | `/:entityId/svg` | Get QR as SVG |
| DELETE | `/:entityId` | Delete QR code |

---

## Phase 2: Filter Operations API

### Cleaning Profiles (`/api/filter-cleaning-profiles`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List cleaning profiles |
| GET | `/:id` | Get profile with pipeline |
| POST | `/` | Create profile with stages/connections |
| PUT | `/:id` | Update (creates new version) |

### Filter Profiles (`/api/filter-profiles`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List filter profiles |
| POST | `/` | Create filter profile |
| PUT | `/:id` | Update filter profile |
| DELETE | `/:id` | Delete filter profile |

### Filter Operations (`/api/filters`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:id/current-state` | Get filter state, next stages, pending checklists |
| POST | `/:id/start-cycle` | Start cleaning cycle (requires cleaningReasonKey) |
| POST | `/:id/advance` | Advance to next stage (enforces checklist completion) |
| POST | `/:id/submit-checklist` | Submit checklist answers |
| POST | `/:id/bypass` | Bypass stage (BYPASS_ENABLED profiles only) |

### Events & Cycles (`/api/filter`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events` | List filter events (filterId, cycleId, eventType filters) |
| GET | `/cycles` | List cleaning cycles (includeEvents=true for events) |
| GET | `/cycles/:id` | Get cycle detail with events and performer names |
| GET | `/reasons` | Get cleaning reasons |

### Checklist Profiles (`/api/checklist-profiles`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List checklist profiles |
| GET | `/:id` | Get profile with questions |
| POST | `/` | Create checklist profile |
| POST | `/:id/questions` | Add question |
| PUT | `/:id/questions/:qid` | Update question |
| DELETE | `/:id` | Delete (blocked if referenced by pipelines) |

### PM Schedules (`/api/pm-schedules`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:entityId` | Get PM schedule for AHU |
| POST | `/` | Create PM schedule |
| PUT | `/:id` | Update PM schedule |

### Equipment Groups (`/api/equipment-groups`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List equipment groups |
| GET | `/:id` | Get group with instruments |
| POST | `/` | Create equipment group |
| PUT | `/:id` | Update equipment group |
| DELETE | `/:id` | Delete equipment group |

---

## Error Responses

All errors follow this format:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "details": {}
}
```

Common codes: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `SESSION_CONFLICT`, `RATE_LIMITED`

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
