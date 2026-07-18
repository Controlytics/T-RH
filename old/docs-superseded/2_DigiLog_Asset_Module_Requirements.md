# DigiLog — Asset Module Requirements Document

> **Scope:** This document covers the Asset Management system within DigiLog. It is a standalone reference for the asset module and can be used independently by an AI assistant or development team to build the asset-related features.
>
> **Context:** DigiLog is a 21 CFR Part 11 compliant digital logbook application. Users fill checklists and log records digitally via a web app (React + Vite SPA) or Android app (Capacitor). The data flows to the platform and is digitally recorded with full audit trails, electronic signatures, and approval workflows.
>
> **Status (2026-04-04):** Asset module is IMPLEMENTED. The system currently has 57 Prisma models, 34 API modules, and supports the full asset lifecycle including Phase 2 Digital Filter Management System (cleaning profiles, filter operations, PM schedules, equipment groups).
>
> **Important distinction:** This document covers TWO separate but related modules:
> - **Asset Template Management** — Defining reusable blueprints for asset types (Section 2)
> - **Asset Management** — Creating, configuring, and operating actual asset instances (Section 3)

---

## 1. WHAT IS AN ASSET

### 1.1 Definition

An **asset** in DigiLog is any physical or logical entity that needs to be monitored, maintained, inspected, or logged. An asset is NOT limited to industrial equipment — it is intentionally broad.

**Examples of assets:**
- A production machine (reactor, centrifuge, filling line)
- A CCTV camera
- A room (clean room, warehouse, cold storage)
- A building or facility
- A vehicle (forklift, delivery truck)
- A utility system (HVAC, water purification, compressed air)
- A storage unit (refrigerator, freezer, cabinet)
- An IT system (server rack, network switch)
- A safety device (fire extinguisher, emergency shower, eyewash station)
- A measuring instrument (scale, pH meter, thermometer)
- Any other physical or logical item the organization needs to track

The system must be flexible enough to handle all of the above without hard-coding assumptions about what an asset "is."

### 1.2 What Every Asset Has

Regardless of type, every asset instance in the system has:

| Component | Description |
|---|---|
| **Unique ID** | System-generated, globally unique, never reused |
| **Name** | Human-readable display name |
| **Asset Type** | Which template it was created from (e.g., "CCTV Camera," "Clean Room," "Reactor") |
| **Attributes** | Static properties / metadata — each with a declared data type (see Section 1.3) |
| **Telemetry** | Dynamic, time-series data streams — each with a declared data type (see Section 1.4) |
| **Relationships** | Connections to other assets (see Section 1.5) |
| **Physical Identifiers** | QR Code, RFID, NFC, Barcode (see Section 1.6) |
| **Checklists** | One or more checklists for inspections, maintenance, etc. (see Section 1.7) |
| **Records** | Associated log records / register entries (see Section 1.8) |
| **Schedule** | Recurring task schedule with frequency and tolerance (see Section 1.9) |
| **Alarm Rules** | Conditions that trigger alarms or deviations (see Section 1.10) |
| **Status** | Active, Inactive, Under Maintenance, Decommissioned, etc. |
| **UNS Path** | Unified Namespace address for data retrieval |
| **Audit History** | Complete history of all changes to this asset |

### 1.3 Attributes (Static Properties)

Attributes are metadata fields that describe the asset. They rarely change and are not time-series.

**Examples:**
- Serial Number, Model, Manufacturer, Installation Date
- Location (Building, Floor, Room)
- Capacity, Material of Construction, Power Rating
- IP Address (for CCTV, network devices)
- Firmware Version
- Criticality Rating (Critical, Major, Minor)
- Regulatory Classification

**Rules:**
- Attributes are defined in the asset template (Section 2) — but additional attributes can be added to individual instances.
- Every attribute change is tracked in the audit trail with before/after values.
- **Every attribute MUST have an explicitly declared data type.** Supported attribute data types: Text, Integer, Float (Decimal), Date, DateTime, Boolean, Dropdown (from predefined list), URL, File Attachment.
- **For numeric attributes (Integer or Float):** Numeric Data Integrity Rules (Section 1.11) apply. The template or instance can define Min, Max, and Resolution constraints. The system enforces these constraints on all entry points — forms, inline edits, imports, and API inputs.
- **For Float attributes:** The display precision is governed by the Resolution value. If Resolution = 0.1, values display with 1 decimal place (e.g., 10 → "10.0"). If Resolution = 0.01, values display with 2 decimal places (e.g., 10 → "10.00"). See Section 1.11 for full rules.

### 1.4 Telemetry (Dynamic Data Streams)

Telemetry represents data that changes over time — measurements, readings, statuses. Telemetry can come from sensors (automatic) or from manual entry by users (via checklists or direct input).

**Examples:**
- Temperature, Pressure, Humidity, pH, Flow Rate
- CCTV: Recording Status (On/Off), Storage Usage (%), Last Footage Timestamp
- Room: Temperature, Humidity, Differential Pressure, Particle Count
- Machine: RPM, Vibration Level, Run Hours, Power Consumption

**Rules:**
- Telemetry is time-series data stored with timestamps (using TimescaleDB).
- **Every telemetry point MUST have an explicitly declared data type.** Supported telemetry data types: Integer, Float (Decimal), Boolean, String, Enum (predefined set of values).
- Each telemetry point has: Name, **Data Type** (Integer, Float, Boolean, String, Enum), Engineering Unit (°C, PSI, %, RPM), and optionally defined alarm limits (high, low, high-high, low-low).
- **For numeric telemetry points (Integer or Float):** Numeric Data Integrity Rules (Section 1.11) apply. The template or instance can define Min, Max, and Resolution constraints. These constraints are enforced on all entry points — manual entry forms, checklist fields linked to telemetry, bulk imports, and API/MQTT ingestion.
- **For Float telemetry points:** The display precision is governed by the Resolution value. If Resolution = 0.1, all displayed values show 1 decimal place (e.g., 25 → "25.0"). If Resolution = 0.01, values show 2 decimal places (e.g., 25 → "25.00"). This applies to dashboards, charts, tables, exports, and record printouts. See Section 1.11 for full rules.
- Telemetry can be auto-ingested from devices via MQTT (UNS topics) or manually entered.
- All telemetry values — whether from sensors or manual entry — are immutable once recorded. Corrections are made by adding a new value with a "correction" flag and reason, not by overwriting.

### 1.5 Asset Relationships

This is a critical feature. Assets do not exist in isolation — they relate to each other. DigiLog supports **flexible, bidirectional relationships** between any two assets.

#### 1.5.1 Relationship Types

The system supports the following relationship types (and is extensible for custom types):

| Relationship | Inverse | Meaning |
|---|---|---|
| **Contains** | **Contained In** | Parent-child physical containment. A Building contains Rooms. A Room contains Machines. A Machine contains Sensors. |
| **Connected To** | **Connected From** | Physical or logical connection. A pipe connects Reactor A to Filter B. A CCTV camera is connected to an NVR. |
| **Feeds** | **Fed By** | Material or data flow. A chiller feeds cooling water to a reactor. A sensor feeds data to a PLC. |
| **Depends On** | **Depended On By** | Operational dependency. A clean room depends on an HVAC system. A production line depends on a water purification unit. |
| **Backs Up** | **Backed Up By** | Redundancy. Generator B backs up Generator A. |
| **Monitors** | **Monitored By** | Observation relationship. A CCTV camera monitors a warehouse. A temperature probe monitors a cold room. |
| **Custom** | **Custom (Inverse)** | User-defined relationship type with custom label. For site-specific needs. |

#### 1.5.2 How Relationships Work

- A relationship is created between **two specific asset instances** (not templates).
- Every relationship is **bidirectional** — if Asset A "Contains" Asset B, then Asset B is automatically "Contained In" Asset A. The system maintains both directions.
- An asset can have **multiple relationships** of different types. A Room can "Contain" 5 machines AND be "Monitored By" 2 CCTV cameras AND "Depend On" 1 HVAC system.
- An asset can have **multiple relationships of the same type**. A Building can "Contain" 20 Rooms.
- Relationships form a **graph, not just a tree**. Unlike a strict hierarchy (which is a tree), relationships allow cross-links. A utility system can feed multiple production lines across different areas.
- The asset tree view (hierarchy) is built from "Contains/Contained In" relationships. Other relationship types are shown as cross-references.

#### 1.5.3 Relationship-Based Data Traversal

Because of the UNS methodology, **all data across related assets is fetchable**:
- Given any asset, you can traverse its relationships to fetch telemetry and attributes from all connected/contained assets.
- Example: Fetch all temperature readings from every sensor contained in Room CR-101 → the system traverses Room → Contains → Machine A, Machine B → Contains → Temp Probe TP-1, TP-2, TP-3 → returns all temperature telemetry.
- This traversal works on any relationship type, not just "Contains."

### 1.6 Physical Identifiers

Each asset can have one or more physical identifiers linked to its unique system ID. These enable quick lookup via scanning.

**Supported identifier types:**

| Type | How It Works |
|---|---|
| **QR Code** | System generates a QR code embedding the asset's unique ID. Can be printed and physically attached to the asset. Scanning (via mobile app camera) navigates directly to the asset's dashboard — its checklists, telemetry, records, and schedule. |
| **Barcode** | Standard 1D barcode (Code 128, Code 39, etc.) linked to the asset's unique ID. Same scan-to-navigate behavior. |
| **RFID** | An external RFID tag's UID is registered in the system and mapped to the asset. When an RFID reader scans the tag, the system resolves it to the asset. |
| **NFC** | Same as RFID but for near-field (phone tap) use cases. Useful for assets where a user taps their phone to open the checklist. |
| **Manual / Visual Label** | For assets with printed labels — the identifier is manually typed in for lookup. |

**Rules:**
- An asset can have **multiple identifiers** (e.g., both QR and RFID). All map to the same unique ID.
- Identifiers are **unique across the tenant** — no two assets share the same QR value or RFID UID.
- The template defines which identifier types are expected (e.g., "CCTV Template requires QR Code"). Actual values are recorded when the instance is created.
- Scanning an identifier on the mobile app immediately opens the asset's context — checklists, telemetry, records, schedule.

### 1.7 Checklists

Each asset can have **one or more checklists** attached to it. Checklists are the primary way users interact with assets on a day-to-day basis — they fill them in during inspections, maintenance, rounds, etc.

#### 1.7.1 Checklist Types — Records vs. Checklists

An asset can have **two distinct types** of attached lists:

**a) Record List (Register):**
A static reference list or register associated with the asset. This is informational — it lists items, sub-items, or details that belong to this asset.

Example for CCTV:
> **"List of CCTV Cameras"** — A register showing all CCTV cameras in a zone: Camera ID, Location, IP Address, Model, Status (Online/Offline), Last Maintenance Date.

This list is maintained by the QA/Engineering Manager and serves as a reference. It can be viewed, filtered, and exported but is not a task to "perform."

**b) Checklist (Actionable):**
A set of items that a user must inspect, verify, fill in, or act on at a defined frequency. This is the operational checklist.

Example for CCTV:
> **"CCTV Daily Checklist"** — Check each camera: Is it powered on? Is recording active? Is the video feed clear? Is storage below 80%? Is the timestamp accurate? Note any issues.

Checklists are what users fill in via the app. Each completed checklist becomes a digital record.

#### 1.7.2 Checklist Question Types

Checklists support the following question/field types:

| Type | Description | Example |
|---|---|---|
| **Pass/Fail** | Binary check | "Is the camera powered on? Pass / Fail" |
| **Multiple Choice (MCQ)** | Select one from options | "Lens condition: (a) Clean (b) Dusty (c) Damaged (d) Obstructed" |
| **Multi-Select** | Select one or more | "Issues observed: [ ] Flickering [ ] No audio [ ] Blur [ ] None" |
| **Fill in the Blank (Text)** | Free text input | "Describe the issue: _____" |
| **Fill in the Blank (Numeric)** | Numeric input with declared data type (Integer or Float). Numeric Data Integrity Rules (Section 1.11) apply — Min, Max, Resolution are configurable. Display precision follows Resolution. | "Record the current temperature: _____ °C" (Float, Min: -10, Max: 50, Resolution: 0.1 → values shown as 23.5, accepted in 0.1 steps) |
| **Dropdown** | Select from predefined list. If dropdown options are numeric, each option must conform to the declared data type and Numeric Data Integrity Rules (Section 1.11) — values are auto-generated from Min, Max, and Resolution. | "Pressure setting: [10.0 / 10.5 / 11.0 / 11.5 / 12.0]" (Float, Min: 10, Max: 12, Resolution: 0.5) |
| **Numeric with Limits** | Number input with declared data type (Integer or Float), auto-validation against Min/Max, and Resolution enforcement per Section 1.11. Out-of-range or off-resolution values are rejected at input. Display precision follows Resolution. | "Pressure: _____ PSI (Range: 10.0–15.0 PSI, Resolution: 0.5)" — only accepts 10.0, 10.5, 11.0 ... 15.0. Auto-flags out-of-range. |
| **Photo/Evidence** | Capture or upload image | "Take a photo of the equipment label" |
| **Date/Time** | Date or timestamp entry | "Last calibration date: ____" |
| **Signature** | E-signature on specific item | "Supervisor sign-off for critical step" |
| **Yes/No with Comment** | Boolean with mandatory comment if No | "Is area clean? Yes / No → If No, describe:" |
| **Calculated Field** | Auto-computed from other fields. Result data type and display precision follow the field's declared type and Resolution. | "Differential Pressure = Field A − Field B" (Float, Resolution: 0.01 → result shown as "5.23") |
| **Conditional Field** | Shown only if a previous answer meets a condition | "If 'Fail' on Q3, then: Describe the failure:" |

#### 1.7.3 Performed By / Checked By / Verified By

Every checklist execution supports a **three-tier sign-off model**. Each tier is independently **enableable** per checklist template and **assignable to a role**.

**Tier 1 — Performed By (Always Required):**
The user who physically performed the inspection and filled in the checklist. This tier is always active — someone must do the work. The Performed By user signs with their electronic signature upon submission.

**Tier 2 — Checked By (Optional, Enableable):**
A second user who reviews the work. Typically someone from the same team or shift. When enabled:
- After Performed By submits, the checklist moves to **"Pending Check"** status.
- A **notification** is sent to all users in the Checked By role (or specific user).
- The checker reviews, and either approves (signs) → moves to next tier, or rejects → sends back to performer with comments.

**Tier 3 — Verified By (Optional, Enableable):**
A third user, usually higher authority (QA, Supervisor, Manager). When enabled:
- After Checked By approves, the checklist moves to **"Pending Verification"** status.
- A **notification** is sent to all users in the Verified By role.
- The verifier reviews, and either approves (signs) → status becomes **"Completed,"** or rejects → sends back.

**Configuration per checklist template:**
- Admin/SuperAdmin enables or disables Tier 2 and Tier 3 per checklist template.
- Each tier is assigned to a **role category** (e.g., "Checked By: Supervisor," "Verified By: QA Manager").
- **Segregation of Duties:** The same person cannot fill multiple tiers on the same checklist instance.
- All three signers' details appear on the final digital record: name, role, signature (image or login ID), timestamp, device used, and meaning of signature.

**Notification flow:**
```
Performer submits → Notification to Checked By role
  → Checker approves → Notification to Verified By role
    → Verifier approves → Record is Completed
  → Checker rejects → Notification back to Performer (with comments)
```

### 1.8 Records (Digital Log Entries)

Every completed checklist becomes a **digital record** — an immutable log entry stored in the system.

**What a record contains:**
- All checklist question responses (the data the user entered)
- Timestamps for every field entry
- Performed By user details + signature
- Checked By user details + signature (if enabled)
- Verified By user details + signature (if enabled)
- Asset unique ID and UNS path
- Schedule reference (which schedule triggered this, or "Ad-Hoc" if unscheduled)
- Whether it was on-time, early, late, or missed relative to schedule
- Any alarm or deviation flags triggered by the checklist data
- Device used (web or tablet), IP address, session ID
- Hash-chained link to audit trail

**Records format:** The exact record layout and display format will be developed in later stages. The system must be architected to support **configurable record templates** — different asset types may have different record display formats.

**Record immutability:** Once a record is completed (all required tiers signed), it is immutable. It cannot be edited or deleted. Corrections are made by creating a new record with a "Correction" type that references the original.

### 1.9 Schedule

Each asset (or each checklist attached to an asset) can have a **schedule** defining how often a task must be performed.

#### 1.9.1 Schedule Fields

| Field | Description |
|---|---|
| **Last Performed Date** | The date/time the task was last successfully completed. See 1.9.2 for onboarding. |
| **Frequency** | How often the task must repeat. Options: Every N hours, Per-shift, Daily, Weekly, Monthly, Quarterly, Annually, Custom (cron expression). |
| **Tolerance** | A ± window around the due time. Example: Frequency = Daily, Tolerance = ±2 hours. Due at 08:00, acceptable from 06:00 to 10:00. |
| **Next Due Date** | Auto-calculated: Last Performed Date + Frequency. Displayed to users. |
| **Status** | Upcoming, Due, Overdue, Missed, Completed (On Time), Completed (Late), Completed (Early). |

#### 1.9.2 Onboarding Mode — "Last Performed Date: N/A"

When an asset is first added to the system (onboarded), the last performed date may not be known — the task was done on paper before, or it is a brand-new asset.

**How it works:**
- When setting up a schedule, the **Last Performed Date** field has an option: **"N/A — Not known (Onboarding Mode)."**
- When N/A is selected, the system does **not** immediately calculate a next due date or generate overdue alerts.
- Instead, the schedule enters **Onboarding Mode**: it waits for the **first actual performance** by a user.
- When a user completes the checklist for the first time, that completion date becomes the **anchor date.** From that point, the system calculates: Next Due = First Performance Date + Frequency.
- Onboarding mode is indicated in the UI: **"⏳ Onboarding — Awaiting first performance"**
- Once the first performance is recorded, onboarding mode automatically deactivates and the schedule runs normally.

#### 1.9.3 Schedule Display

Users can:
- View all scheduled tasks for an asset on a **calendar view** with date range selection.
- See a **timeline** showing planned (from schedule) vs. actual (from records) performance dates.
- Filter by status: Upcoming, Due Today, Overdue, Completed.
- All schedule data is part of reports and downloadable.

#### 1.9.4 Future Link to Work Orders / Tasks

> **Note for later development:** In future phases, the schedule system will be integrated with the Work Order / Task Manager module. When a scheduled task fires, it will automatically generate a Work Order that flows through the full assignment → performance → approval lifecycle. For now, the schedule generates notifications and tracks compliance — the formal Work Order integration will be added later.

### 1.10 Alarm Rules & Custom Logic on Checklists

Alarm rules can be defined at two levels: on telemetry points (standard threshold-based) and on checklists (custom logic / scripted conditions).

#### 1.10.1 Telemetry-Based Alarms (Standard)

Standard threshold alarms on any telemetry point:
- High Limit, Low Limit, High-High (Critical), Low-Low (Critical)
- Rate of Change (value changed too fast)
- Deadband (hysteresis to prevent alarm flapping)
- Boolean State (e.g., alarm if CCTV Recording Status = Off)

#### 1.10.2 Checklist-Based Alarm Rules (Custom Logic)

Beyond simple telemetry thresholds, the system supports **custom alarm rules that evaluate checklist data and schedule compliance**. These are scriptable conditions that fire when specific situations occur.

**Examples of custom logic:**

**a) Missed Schedule Alarm:**
```
IF checklist "CCTV Daily Check" is not completed within the tolerance window
THEN generate Deviation: "Missed scheduled CCTV inspection for {asset.name}"
AND notify: Supervisor role
```

**b) Value Out of Range in Checklist:**
```
IF checklist field "Temperature Reading" > 25°C OR < 18°C
THEN generate Alarm: "Temperature out of range: {value}°C for {asset.name}"
AND flag the checklist item as "Out of Spec"
AND notify: QA Manager role
```

**c) Consecutive Failures:**
```
IF checklist field "Lens Condition" = "Damaged" for 3 consecutive checklist completions
THEN generate Deviation: "Recurring damage on {asset.name} — requires investigation"
AND notify: Engineering Manager role
```

**d) Calculated Threshold:**
```
IF (checklist field "Inlet Pressure" - checklist field "Outlet Pressure") > 5 PSI
THEN generate Alarm: "Differential pressure exceeds limit for {asset.name}"
```

**e) Conditional Escalation:**
```
IF checklist field "Critical Safety Check" = "Fail"
THEN generate Deviation with priority: Critical
AND block state transition (asset cannot move to "Running" state)
AND notify: Site Director + QA Manager
```

**Implementation approach:**
- Alarm rules are configured via a **rule builder UI** (no-code for simple rules: field + operator + value → action).
- For complex logic, the system supports **custom scripts** (a lightweight scripting language or expression engine) that can reference any checklist field, telemetry value, schedule status, or asset attribute.
- Scripts are sandboxed — they cannot modify data directly, only evaluate conditions and trigger alarms/deviations/notifications.
- Scripts are versioned and require approval (by Admin or SuperAdmin) before activation.
- All alarm rule changes are tracked in the audit trail.

#### 1.10.3 What Happens When an Alarm/Deviation Is Generated

When any alarm rule (standard or custom) fires:
1. An **alarm or deviation record** is created with a snapshot of all relevant values at that moment (the snapshot is frozen — future changes to limits do not retroactively affect it).
2. The record is linked to the specific asset and checklist instance that triggered it.
3. Notifications are sent to the configured recipients (roles or specific users).
4. If the rule specifies it, the alarm can **block a state transition** or **flag the checklist** for mandatory review.
5. The alarm/deviation appears on the asset's dashboard, in the notification panel, and in compliance reports.

---

### 1.11 Numeric Data Integrity Rules (Cross-Cutting)

This section defines the rules for numeric data entry, validation, and display that apply **universally** across the entire DigiLog platform — attributes, telemetry, checklist fields, alarm thresholds, calculated fields, dropdowns, reports, exports, and API responses. These rules ensure data integrity, consistency, and regulatory compliance (ALCOA+ — Accurate, Attributable).

#### 1.11.1 Data Type Declaration (Mandatory)

**Every numeric field in the system MUST have an explicitly declared data type.** This applies to:
- Asset attributes (Section 1.3)
- Telemetry points (Section 1.4)
- Checklist question fields — Fill in the Blank (Numeric), Numeric with Limits, Calculated Fields (Section 1.7.2)
- Alarm rule thresholds (Section 1.10)
- Any other configurable numeric parameter

**Supported numeric data types:**

| Data Type | Storage | Description | Example Values |
|---|---|---|---|
| **Integer** | Whole number (no decimals) | For counts, quantities, whole-unit measurements | 0, 1, 42, -5, 1000 |
| **Float** | Decimal number (IEEE 754 double precision) | For measurements, readings, ratios requiring fractional values | 10.0, 23.45, -3.5, 0.001 |

The data type is set at the **template level** (for template-defined fields) or at the **instance level** (for custom fields added to an instance). Once a field is created with a data type, the type is immutable — changing the type requires creating a new field (to preserve data integrity of historical records).

#### 1.11.2 Numeric Constraint Parameters — Min, Max, Resolution

For any numeric field (Integer or Float), the following **optional but recommended** constraint parameters can be configured:

| Parameter | Type | Description | Default if not set |
|---|---|---|---|
| **Min** | Same as field data type | The minimum allowable value (inclusive). Values below this are rejected. | No minimum (unbounded) |
| **Max** | Same as field data type | The maximum allowable value (inclusive). Values above this are rejected. | No maximum (unbounded) |
| **Resolution** | Positive number | The smallest increment (step size) between valid values. Valid values are: Min, Min + Resolution, Min + 2×Resolution, ..., up to Max. | No resolution constraint (any value within Min–Max is accepted) |
| **Enable Constraints** | Boolean toggle | Master toggle to enable or disable numeric constraint enforcement for this field. When disabled, Min/Max/Resolution are stored but not enforced (useful during onboarding or migration). | Disabled |

**Where constraints are configured:**
- **Template level:** In the Asset Template editor (Section 2.1), when defining attribute schemas, telemetry schemas, and checklist field definitions.
- **Instance level:** When creating or editing an asset instance. Instance-level constraints can **override** template defaults — e.g., a specific reactor may have a tighter temperature range than the template default.
- **Checklist field level:** When building a checklist in the Template Editor or at the instance level for a specific checklist.

#### 1.11.3 Validation Rules

When numeric constraints are enabled, the system enforces the following rules at **every entry point** — web forms, mobile app forms, inline edits, bulk imports (CSV/Excel), API inputs, and MQTT ingestion:

**Rule 1 — Data Type Enforcement:**
- If data type is Integer: only whole numbers are accepted. Decimal values are rejected with error: *"This field requires a whole number."*
- If data type is Float: decimal values are accepted. The number of decimal places accepted and displayed is governed by Resolution (see Rule 4).

**Rule 2 — Min/Max Boundary Enforcement:**
- If a value is entered below Min: rejected with error: *"Value {value} is below the minimum allowed value of {Min}."*
- If a value is entered above Max: rejected with error: *"Value {value} exceeds the maximum allowed value of {Max}."*
- Boundary values (Min and Max themselves) ARE valid.

**Rule 3 — Resolution Enforcement (Step Validation):**
- When Resolution is defined, only values that align with the resolution grid are accepted.
- The resolution grid is: Min, Min + Resolution, Min + 2 × Resolution, ..., up to Max.
- If a value does not land on a grid point, it is rejected with error: *"Value {value} does not match the required resolution of {Resolution}. Nearest valid values are {lower} and {upper}."*
- **Example:** Min = -5, Max = 5, Resolution = 0.5 → Valid values: -5.0, -4.5, -4.0, -3.5, ..., 0.0, ..., 3.5, 4.0, 4.5, 5.0
- **Example:** Min = 0, Max = 100, Resolution = 1 → Valid values: 0, 1, 2, 3, ..., 100

**Rule 4 — Display Precision (Float Data Type):**
- **This is critical for regulatory compliance.** When a field's data type is Float, the display precision MUST match the Resolution value across the entire system.
- The number of decimal places displayed = the number of decimal places in the Resolution value.
- If Resolution = 0.1 → display 1 decimal place. A value entered as "10" is displayed as **"10.0"** everywhere.
- If Resolution = 0.01 → display 2 decimal places. A value entered as "10" is displayed as **"10.00"** everywhere.
- If Resolution = 0.5 → display 1 decimal place. A value entered as "3" is displayed as **"3.0"** everywhere.
- If Resolution = 0.001 → display 3 decimal places. A value entered as "7.5" is displayed as **"7.500"** everywhere.
- If Resolution = 1 and data type is Float → display 1 decimal place. A value of "10" is displayed as **"10.0"** (because it is explicitly a Float, not an Integer).
- If no Resolution is set but data type is Float → display at least 1 decimal place by default. Values are shown as entered but with a minimum of 1 decimal place (e.g., "10" → "10.0").
- **"Everywhere" means:** web dashboards, mobile app screens, checklist forms, record views, PDF exports, CSV exports, API responses, alarm displays, chart tooltips, reports, audit trail entries, and any other surface where the value appears.

**Rule 5 — Input Assistance (UX):**
- When Resolution is defined, numeric input fields SHOULD provide:
  - **Stepper controls** (▲/▼ buttons or +/- buttons) that increment/decrement by the Resolution value.
  - **Slider input** (optional, configurable) that snaps to valid resolution steps — particularly useful on mobile.
  - **Input masking** that auto-formats to the correct decimal places as the user types.
- When Min and Max are defined with Resolution, and the total number of valid values is **≤ 50**, the system SHOULD offer a **dropdown/picker mode** as an alternative to free-text input. This is especially useful for checklist fields where a limited set of values is expected.
  - Example: Min = -5, Max = 5, Resolution = 0.5 → 21 values → dropdown is offered: [-5.0, -4.5, -4.0, ..., 4.5, 5.0]
  - Example: Min = 0, Max = 1000, Resolution = 1 → 1001 values → dropdown is NOT offered (too many); free-text with stepper is used instead.
- Invalid values are highlighted with a red border and the specific error message from Rules 1–3 is shown inline.

#### 1.11.4 Numeric Dropdown Auto-Generation

When a checklist field or attribute is configured as a **Dropdown** type with numeric values, the dropdown options can be **auto-generated** from the numeric constraints:

- If Min, Max, and Resolution are all defined, the system auto-generates the list of valid values as dropdown options.
- Each option is displayed with the correct display precision per Rule 4.
- Example: Data Type = Float, Min = 10, Max = 12, Resolution = 0.5 → Dropdown options: [10.0, 10.5, 11.0, 11.5, 12.0]
- Example: Data Type = Float, Min = 0, Max = 1, Resolution = 0.01 → 101 options → system warns: *"Auto-generated dropdown has 101 options. Consider using a numeric input field instead."* Admin can proceed or switch to numeric input.
- The admin can also manually define dropdown options — in which case each option must still conform to the data type and resolution if constraints are enabled.

#### 1.11.5 Applicability Matrix

The following table shows where Numeric Data Integrity Rules apply:

| Context | Data Type Required | Min/Max | Resolution | Display Precision | Stepper/Slider | Dropdown Auto-Gen |
|---|---|---|---|---|---|---|
| **Asset Attributes (numeric)** | ✅ Yes | ✅ Optional | ✅ Optional | ✅ Yes (Float) | ✅ Yes | ❌ No (attributes are not dropdowns) |
| **Telemetry Points (numeric)** | ✅ Yes | ✅ Optional | ✅ Optional | ✅ Yes (Float) | ✅ Manual entry | ❌ No |
| **Checklist — Fill in the Blank (Numeric)** | ✅ Yes | ✅ Optional | ✅ Optional | ✅ Yes (Float) | ✅ Yes | ❌ No |
| **Checklist — Numeric with Limits** | ✅ Yes | ✅ Required | ✅ Optional | ✅ Yes (Float) | ✅ Yes | ✅ If ≤ 50 values |
| **Checklist — Dropdown (Numeric)** | ✅ Yes | ✅ If auto-gen | ✅ If auto-gen | ✅ Yes (Float) | ❌ N/A | ✅ Yes (primary use) |
| **Checklist — Calculated Field** | ✅ Yes (output) | ❌ No (result) | ✅ Output Res. | ✅ Yes (Float) | ❌ N/A | ❌ No |
| **Alarm Thresholds** | ✅ Inherits from field | ✅ N/A | ✅ Inherits | ✅ Yes (Float) | ✅ Yes | ❌ No |
| **CSV/Excel Import** | ✅ Validated | ✅ Validated | ✅ Validated | ✅ On display | ❌ N/A | ❌ N/A |
| **API / MQTT Ingestion** | ✅ Validated | ✅ Validated | ✅ Validated | ✅ On display | ❌ N/A | ❌ N/A |

#### 1.11.6 Configuration UI for Numeric Constraints

Wherever a numeric field is being defined (template editor, instance customization, checklist builder), the configuration form must include:

```
Field Name: [________________]
Data Type:  [ Integer ▾ ]  ← MANDATORY dropdown: Integer / Float

☐ Enable Numeric Constraints
  ├── Min Value:    [________]  (same data type as field)
  ├── Max Value:    [________]  (same data type as field)
  └── Resolution:   [________]  (positive number; for Integer, must be ≥ 1 whole number)

Engineering Unit: [________]  (e.g., °C, PSI, %, RPM)

Preview of valid values:  -5.0, -4.5, -4.0, ..., 4.5, 5.0  (21 values)
Display format preview:   "23.5" (1 decimal place based on Resolution = 0.5)
```

- The "Enable Numeric Constraints" toggle is the master switch. When off, Min/Max/Resolution values are stored but not enforced.
- The "Preview of valid values" line dynamically updates as the admin changes Min, Max, or Resolution — showing first few and last few values with "..." in between.
- The "Display format preview" line shows how a sample value will be rendered based on the current data type and resolution.
- **Validation on the configuration itself:** Max must be ≥ Min. Resolution must be > 0. Resolution must divide evenly into (Max - Min) — if not, a warning is shown: *"Resolution does not evenly divide the range. The maximum achievable value will be {calculated_max}, not {entered_max}."*

#### 1.11.7 Impact on Existing Features

**Alarm Rules (Section 1.10):**
- Alarm thresholds (High, Low, High-High, Low-Low) must conform to the data type and resolution of the telemetry point or checklist field they are configured for.
- When an admin enters an alarm threshold, the same validation (Min/Max/Resolution) applies.
- Alarm threshold display follows the same display precision rules.

**Records (Section 1.8):**
- All numeric values stored in completed records retain their full precision internally (stored as IEEE 754 double).
- When displayed or exported, the display precision rules from Section 1.11.3 Rule 4 apply.
- This ensures consistency: a value of 10 entered for a Float field with Resolution 0.1 is always shown as "10.0" in the record — never as "10."

**Schedule Tolerance (Section 1.9):**
- Tolerance values (e.g., ±2 hours) follow the same data type and display rules if they are numeric.

**Bulk Import (Section 3.4):**
- When importing via CSV/Excel, every numeric cell is validated against the target field's data type, Min, Max, and Resolution.
- Rows with invalid values are flagged and reported in an import validation summary. The admin can choose to skip invalid rows or reject the entire import.

**API / MQTT Ingestion (Section 1.4):**
- Incoming telemetry values via API or MQTT are validated against the field's constraints.
- Invalid values are rejected with an appropriate error code and logged. The rejection is visible in the asset's telemetry history as a "Rejected Value" entry with reason.

---

**Asset Template Management** is the module where authorized users define **reusable blueprints** for asset types. A template is NOT an actual asset — it is the definition of what an asset of that type should look like.

### 2.1 What a Template Defines

An asset template is a blueprint containing:

| Component | What It Defines in the Template |
|---|---|
| **Template Name** | The asset type label (e.g., "CCTV Camera," "Bioreactor," "Clean Room") |
| **Template Description** | What this asset type is used for |
| **Attribute Schema** | Which attributes every instance of this type should have (field name, **data type** [Text/Integer/Float/Date/DateTime/Boolean/Dropdown/URL/File], required/optional, default value, **and for numeric types: Min, Max, Resolution, Enable Constraints toggle** — per Section 1.11) |
| **Telemetry Schema** | Which telemetry points every instance should have (point name, **data type** [Integer/Float/Boolean/String/Enum], engineering unit, default alarm limits, **and for numeric types: Min, Max, Resolution, Enable Constraints toggle** — per Section 1.11) |
| **Expected Relationships** | Which relationship types are typical (e.g., "CCTV Camera is typically Contained In a Room and Monitors a Zone") |
| **Expected Identifiers** | Which physical identifier types are expected (e.g., "Requires QR Code and RFID") |
| **Checklists** | One or more checklist templates: question items, question types, pass/fail criteria, limits for numeric fields |
| **Record Lists** | Any reference registers associated with this asset type (e.g., "List of CCTV Cameras" register) |
| **Default Alarm Rules** | Pre-configured alarm thresholds and custom logic scripts for telemetry and checklist fields |
| **Default Schedule** | Default frequency and tolerance for each checklist (e.g., "CCTV Daily Check: Daily, ±2 hours") |
| **Performed/Checked/Verified By Config** | Which tiers are enabled for each checklist, and which roles are assigned to each tier |
| **Default Status Lifecycle** | Which statuses this asset type supports (e.g., Active, Under Maintenance, Offline, Decommissioned) |

### 2.2 Template Example — CCTV Camera

To make this concrete, here is what a "CCTV Camera" template might look like:

```
Template: CCTV Camera
├── Attributes:
│   ├── Camera ID (Text, Required)
│   ├── IP Address (Text, Required)
│   ├── Model (Text)
│   ├── Manufacturer (Text)
│   ├── Resolution (Dropdown: 720p / 1080p / 4K)
│   ├── Location Description (Text)
│   ├── Installation Date (Date)
│   ├── Firmware Version (Text)
│   └── Focal Length (Float, Unit: mm, Min: 2.0, Max: 100.0, Resolution: 0.1, Constraints: Enabled)
│
├── Telemetry:
│   ├── Recording Status (Boolean: On/Off, Data Type: Boolean) — Alarm if Off
│   ├── Storage Usage (Data Type: Float, Unit: %, Min: 0.0, Max: 100.0, Resolution: 0.1, Constraints: Enabled) — Alarm if > 85.0%
│   ├── Uptime Hours (Data Type: Integer, Unit: hours, Min: 0, Constraints: Enabled)
│   └── Last Footage Timestamp (DateTime)
│
├── Expected Identifiers: QR Code (Required)
│
├── Expected Relationships:
│   ├── Contained In: Room or Zone
│   └── Monitors: Area, Corridor, or Room
│
├── Record List: "CCTV Register"
│   └── Fields: Camera ID, Location, IP, Model, Status, Last Maintenance
│
├── Checklist: "CCTV Daily Inspection"
│   ├── Q1: Is camera powered on? (Pass/Fail)
│   ├── Q2: Is recording active? (Pass/Fail)
│   ├── Q3: Video feed clarity? (MCQ: Clear / Blurry / No Feed)
│   ├── Q4: Storage usage? (Numeric with Limits, Data Type: Float, Min: 0.0, Max: 100.0, Resolution: 0.1, Display: "85.0%")
│   ├── Q5: Timestamp accurate? (Yes/No with Comment)
│   ├── Q6: Any physical damage? (Yes/No with Comment + Photo if Yes)
│   ├── Q7: Tilt angle adjustment needed? (Dropdown, Data Type: Float, Min: -5.0, Max: 5.0, Resolution: 0.5, Auto-Generated: [-5.0, -4.5, ..., 4.5, 5.0])
│   └── Q8: Notes (Fill in the Blank Text, Optional)
│   │
│   ├── Performed By: Operator (Enabled, Required)
│   ├── Checked By: Supervisor (Enabled)
│   └── Verified By: (Disabled)
│
├── Default Schedule: Daily, Tolerance ±2 hours
│
└── Alarm Rules:
    ├── IF Recording Status = Off → Alarm: "CCTV not recording"
    ├── IF Storage Usage > 85.0% → Alarm: "Storage nearly full"
    ├── IF Q3 = "No Feed" → Deviation: "CCTV feed lost"
    └── IF Daily Inspection missed → Deviation: "Missed CCTV inspection"
```

### 2.3 Template Versioning

- Every template change creates a new version (v1, v2, v3...).
- Existing asset instances that were created from v1 are not automatically updated when v2 is published. The Admin can choose to: (a) leave existing instances on v1, (b) migrate specific instances to v2, or (c) migrate all instances to v2.
- The version history shows: what changed, who changed it, when, and why.
- Template changes require confirmation and are logged in the audit trail.

---

## 3. ASSET MANAGEMENT (Instance Operations)

**Asset Management** is the module where users create, configure, operate, and maintain **actual asset instances** based on templates.

### 3.1 Creating an Asset Instance

1. User selects a template (e.g., "CCTV Camera").
2. All attribute fields, telemetry points, checklists, identifiers, alarm rules, and schedules are **auto-populated** from the template.
3. User fills in instance-specific values: actual serial number, actual IP address, actual location, actual RFID tag UID, etc.
4. User establishes relationships: "This camera is Contained In: Warehouse B, Floor 2" and "This camera Monitors: Loading Dock Area."
5. User sets the schedule: use the template default, override with custom values, or set Last Performed Date = N/A for onboarding.
6. Asset is created and becomes active.

### 3.2 Instance-Level Customization

After creation, an asset instance can be customized beyond the template:
- **Add extra attributes** not in the template (e.g., a note field specific to this camera).
- **Add extra telemetry points** not in the template.
- **Add extra checklists** beyond the template defaults.
- **Modify alarm limits** (overriding template defaults for this specific instance).
- **Add additional relationships** to other assets.
- **Add additional identifiers.**

These customizations are tracked separately from the template — so a template upgrade does not overwrite instance-level customizations.

### 3.3 Asset Dashboard (Per Asset)

Each asset has its own dashboard showing:
- Current status and key telemetry values (real-time if available)
- Active alarms and deviations
- Upcoming and overdue scheduled tasks
- Recent checklist records (completed logs)
- Relationship map (which assets it is connected to)
- Identifier details (QR code image, RFID tag info)
- Attribute summary
- Full audit history for this asset

### 3.4 Bulk Operations

- **Bulk create:** Create multiple assets from the same template in one action (e.g., onboarding 50 CCTV cameras via CSV import).
- **Bulk update:** Update an attribute across multiple assets at once (e.g., change firmware version for all cameras of Model X).
- **Bulk schedule:** Apply or modify schedules across a group of assets.
- All bulk operations are logged as individual audit trail entries per asset affected.

---

## 4. ACCESS CONTROL — WHO MANAGES WHAT

### 4.1 Default Access

By default, **SuperAdmin** has full access to both Asset Template Management and Asset Management.

### 4.2 Delegable Privileges

SuperAdmin can **delegate** asset-related privileges to other roles. The right to decide who gets access **always remains with SuperAdmin** — no other role can grant these privileges to others.

**Delegable privileges:**

| Privilege | What It Allows | Default Holder | Can Be Delegated To |
|---|---|---|---|
| **Manage Asset Templates** | Create, edit, version, delete asset templates | SuperAdmin | Any role (e.g., Engineering Manager, QA Manager) |
| **Create Asset Instances** | Create new assets from templates | SuperAdmin | Any role (e.g., Engineering Manager, Supervisor) |
| **Edit Asset Instances** | Modify attributes, telemetry config, alarm rules on existing assets | SuperAdmin | Any role |
| **Manage Relationships** | Create, edit, delete relationships between assets | SuperAdmin | Any role |
| **Manage Identifiers** | Register, update, remove physical identifiers | SuperAdmin | Any role |
| **Manage Checklists** | Add, edit, enable/disable checklists on assets | SuperAdmin | Any role |
| **Manage Schedules** | Create, edit, pause schedules | SuperAdmin | Any role |
| **Configure Alarm Rules** | Create, edit alarm rules and custom logic scripts | SuperAdmin | Any role |
| **Decommission Assets** | Change asset status to Decommissioned | SuperAdmin | Any role |
| **View Asset Data** | View attributes, telemetry, records, dashboards | All authenticated users | (Always available, can be restricted per asset) |
| **Perform Checklists** | Fill in and submit checklists | Operators, Supervisors | Any role |

**How delegation works:**
1. SuperAdmin navigates to Role Management.
2. Selects a role (e.g., "Engineering Manager").
3. Toggles on the desired privileges (e.g., "Manage Asset Templates: Enabled," "Configure Alarm Rules: Enabled").
4. Saves. From now on, all users with the Engineering Manager role can manage templates and configure alarms.
5. SuperAdmin can revoke the privilege at any time.
6. The delegation and revocation are logged in the audit trail.

**Rules:**
- Only SuperAdmin can delegate. An Engineering Manager who has "Manage Asset Templates" cannot give that privilege to an Operator — only SuperAdmin can.
- Delegation is at the **role level**, not the individual user level. If "Engineering Manager" has a privilege, all users with that role have it.
- SuperAdmin can optionally restrict privileges to **specific asset types** (e.g., "Engineering Manager can manage templates only for equipment types, not for rooms or buildings"). This is an advanced feature for granular control.

---

## 5. UNIFIED NAMESPACE (UNS) DATA ADDRESSING

All asset data is addressable via a UNS-style path:

```
{Tenant} / {Relationship Path} / {Asset Name} / {Data Point}
```

**Examples:**
```
AcmePharma / BuildingA / Floor2 / WarehouseB / CCTV-Cam-042 / RecordingStatus
AcmePharma / MfgAreaA / PL-1 / ReactorR201 / AgitatorAG201A / TempProbeTP201 / Temperature
AcmePharma / QCLab / HPLC-7 / RunHours
```

**Relationship-based path resolution:**
- The UNS path is built by traversing **"Contained In"** relationships upward from the asset to the tenant root.
- For assets with multiple "Contained In" parents (rare but possible), the system uses the **primary containment** (marked by the user when creating the relationship).
- Data from any asset in the hierarchy is fetchable by specifying the UNS path in API calls, MQTT subscriptions, or report queries.

---

## 6. MOBILE APP INTERACTION

Users interact with assets primarily through the **Android app (Flutter):**

1. **Scan to Open:** User scans QR code / RFID / NFC tag on the physical asset → app opens the asset's context (dashboard, checklists, telemetry).
2. **Fill Checklist:** User fills in the checklist items on the app — text, numbers, dropdowns, photos (camera capture), pass/fail toggles.
3. **Sign & Submit:** User signs with e-signature (image or login ID, per their onboarding configuration). Re-authentication required.
4. **Data Upload:** Completed checklist data is transmitted to the platform and digitally recorded.
5. **Offline Support:** If the device is offline, the completed checklist is queued locally (encrypted SQLite). When connectivity returns, it syncs to the platform. Sync status is visible to the user.
6. **Notifications:** After submission, notifications flow to the next tier (Checked By / Verified By) as configured.

---

## 7. ASSET MANAGEMENT UI — PAGE SPECIFICATIONS

This section defines the web application pages required for asset management. These are the screens users interact with to create assets, link them together, manage templates, and view asset data.

### 7.1 Asset Explorer Page (Main Landing Page)

This is the primary page users see when they navigate to "Assets" in the sidebar. It has two panels side by side.

**Left Panel — Asset Tree (Navigation):**
- Displays all assets in a collapsible tree structure built from "Contains / Contained In" relationships.
- Root nodes are top-level assets (Sites, Buildings) that are not contained in anything else.
- Each node shows: asset name, asset type icon (different icons for Machine, CCTV, Room, Building, Sensor, etc.), status indicator (color dot: green = active, amber = maintenance, red = offline/alarm), and count of direct children.
- Clicking a node selects it and loads its details in the right panel.
- Expanding a node reveals its children (assets it Contains).
- A **search bar** at the top of the tree lets users search by asset name, type, identifier value, or attribute value. Results highlight matching nodes in the tree.
- A **filter dropdown** lets users filter the tree by: asset type, status, or template.
- **Drag-and-drop** (optional, future): Users can drag an asset to a new parent to reassign the "Contained In" relationship.

**Right Panel — Asset Detail:**
- Shows full details for the selected asset (see Section 7.5 for detail view layout).
- If no asset is selected, shows a welcome message: "Select an asset from the tree, or create a new one."

**Top Action Bar:**
- **"+ Add Asset"** button — opens the Add Asset flow (Section 7.2).
- **"+ Link Assets"** button — opens the Link Assets dialog (Section 7.3).
- **"Import Assets"** button — opens bulk import from CSV/Excel.
- **"Export"** button — exports the current tree or filtered view as PDF / CSV.
- **View toggle**: Tree View (default) | List View (flat table of all assets) | Graph View (visual relationship map).

### 7.2 Add Asset Page / Dialog

Triggered by clicking **"+ Add Asset."** This can be a full page or a multi-step dialog/wizard.

**Step 1 — Select Template:**
- Shows a grid or list of all available asset templates.
- Each template card shows: template name, description, icon, number of attributes, number of checklists, and the template version.
- User clicks a template to select it (e.g., "CCTV Camera," "Clean Room," "Reactor").
- A search/filter bar lets users find templates quickly.
- If the user has "Manage Asset Templates" privilege, a **"+ Create New Template"** link is visible here.

**Step 2 — Fill Basic Info:**
- **Asset Name** (required): Human-readable name for this instance (e.g., "CCTV-Cam-042," "Clean Room CR-101").
- **Asset Description** (optional): Free text description.
- **Status**: Dropdown — Active, Inactive, Under Maintenance, Commissioning (default: Active).
- **Primary Location / Contained In**: A picker that lets the user select a parent asset from the tree. This establishes the primary "Contained In" relationship. Optional — an asset can be top-level (no parent).

**Step 3 — Fill Attributes:**
- The system displays all attribute fields defined in the selected template.
- Required fields are marked with asterisk (*). Optional fields are clearly labeled.
- Each field renders as the appropriate input type: text input, number input, date picker, dropdown, file upload — based on the attribute's data type defined in the template.
- **For numeric attributes (Integer or Float):** the input field enforces Numeric Data Integrity Rules (Section 1.11). If Min, Max, and Resolution are configured and enabled, the field validates input in real time, provides stepper controls (▲/▼), and displays the value with correct precision (e.g., Float with Resolution 0.1 shows "10.0"). Invalid entries are highlighted with inline error messages.
- **The data type is shown next to each field** as a subtle label (e.g., "[Float]", "[Integer]", "[Text]") so the user understands what kind of input is expected.
- Default values from the template are pre-filled where applicable. For Float fields, defaults are displayed with correct precision.
- An **"+ Add Custom Attribute"** button allows the user to add extra attributes not in the template: they enter a field name, **select a data type (mandatory)**, and if the type is Integer or Float, they can optionally configure Min, Max, Resolution, and the Enable Constraints toggle (per Section 1.11.6). Then they enter the value.

**Step 4 — Configure Telemetry:**
- Lists all telemetry points defined in the template: name, **data type (Integer/Float/Boolean/String/Enum)**, engineering unit, default alarm limits, **and numeric constraints (Min, Max, Resolution) if configured**.
- **Data type is prominently displayed** next to each telemetry point name (e.g., "Storage Usage [Float, %]", "Uptime Hours [Integer, hrs]").
- User can review and optionally **override alarm limits** for this specific instance. Alarm limit values must conform to the field's data type and resolution (Section 1.11).
- User can review and optionally **override numeric constraints** (Min, Max, Resolution) for this specific instance — tightening or loosening the template defaults.
- An **"+ Add Custom Telemetry Point"** button allows adding extra points not in the template. The user **must select a data type** (mandatory), and for Integer/Float types, can configure Min, Max, Resolution, and the Enable Constraints toggle (per Section 1.11.6).
- For each telemetry point, user can set: data source = "Manual Entry" (users enter values during checklists) or "Automatic" (data arrives via MQTT/API integration) or "Both."
- A **display preview** shows how a sample value will appear for Float telemetry points based on the configured resolution (e.g., "Display preview: 25.0" for Resolution = 0.1).

**Step 5 — Register Identifiers:**
- Shows which identifier types the template expects (e.g., "QR Code: Required," "RFID: Optional").
- For QR Code: A **"Generate QR Code"** button auto-generates a QR code linked to the asset's unique ID. The QR image can be previewed and a **"Print QR Label"** button generates a printable label.
- For RFID / NFC: An input field where the user types or scans the tag's UID.
- For Barcode: Auto-generated or manually entered.
- An **"+ Add Identifier"** button allows adding additional identifier types.

**Step 6 — Set Schedule:**
- For each checklist defined in the template, the schedule settings are displayed:
  - **Frequency**: Dropdown or custom input (Hourly, Per-Shift, Daily, Weekly, Monthly, etc.)
  - **Tolerance**: ± input field (e.g., ±2 hours, ±1 day)
  - **Last Performed Date**: Date picker with a checkbox: **"☐ N/A — Not known (Onboarding Mode)"**
  - **Next Due Date**: Auto-calculated and displayed (or "Awaiting first performance" if onboarding).
- Default values from the template are pre-filled. User can override.
- A **"Use template defaults"** toggle resets all schedule fields to template values.

**Step 7 — Review & Create:**
- Summary page showing everything the user configured: basic info, attributes, telemetry, identifiers, schedule, alarm rules.
- User reviews and clicks **"Create Asset."**
- The asset is created and the user is taken to the Asset Detail page (Section 7.5).
- The creation event is logged in the audit trail.

### 7.3 Link Assets Dialog

Triggered by clicking **"+ Link Assets"** from the Asset Explorer, or from the Relationships tab on an asset's detail page.

**The dialog has three parts:**

**Part 1 — Select Source Asset (From):**
- A searchable asset picker. User types to search by name, ID, or type.
- The currently selected asset in the explorer is pre-filled as the source (but can be changed).
- Shows: asset name, type, location path.

**Part 2 — Select Relationship Type:**
- A dropdown listing all available relationship types:
  - Contains → Contained In
  - Connected To → Connected From
  - Feeds → Fed By
  - Depends On → Depended On By
  - Backs Up → Backed Up By
  - Monitors → Monitored By
  - Custom (with editable label fields for forward and inverse names)
- Each option shows a brief description of what the relationship means.
- When a type is selected, the directional labels update: **"[Source Asset] —Contains→ [Target Asset]"** so the user clearly sees the direction.

**Part 3 — Select Target Asset (To):**
- Another searchable asset picker. User types to search.
- The picker can also show a mini tree view for browsing.
- User selects the target asset.

**Part 4 — Confirm:**
- Shows a clear summary: **"Building A — Contains → Clean Room CR-101"**
- And the automatic inverse: **"Clean Room CR-101 — Contained In → Building A"**
- Optional **notes/reason** field for audit trail.
- **"Link Assets"** button creates the relationship.
- Both directions are created simultaneously.
- The link event is logged in the audit trail.

**Validation rules:**
- Cannot create a duplicate relationship (same source, same type, same target).
- Cannot create a "Contains" loop (A contains B, B contains A).
- Self-referencing is blocked (A cannot contain A).
- Warnings for unusual patterns (e.g., a Room "Contains" a Building — probably wrong direction).

### 7.4 Relationship Map View

Accessible from the Asset Explorer's **"Graph View"** toggle or from an individual asset's Relationships tab.

**What it shows:**
- A visual node-and-edge diagram showing the selected asset at the center and all its relationships radiating outward.
- Each node is an asset, displayed with its name, type icon, and status color.
- Each edge (line) is a relationship, labeled with the relationship type and direction (arrow showing the direction, e.g., an arrow from Building to Room with label "Contains").
- Different relationship types are shown in different colors or line styles:
  - Contains/Contained In: solid line
  - Connected To: dashed line
  - Feeds/Fed By: dotted line with arrow
  - Monitors: dot-dash line
  - Depends On: thick line
- Users can click on any node to navigate to that asset's detail page.
- Users can click on any edge to see relationship details or delete the relationship.
- **Depth control**: A slider or dropdown lets users choose how many levels deep to show (1 hop, 2 hops, 3 hops, all). Default: 2 hops.
- **Filter by relationship type**: Toggle specific relationship types on/off to simplify the view.
- Zoom and pan controls for navigating large graphs.

### 7.5 Asset Detail Page

This is the full detail view for a single asset. It appears in the right panel of the Asset Explorer or as a standalone page when navigating directly to an asset (e.g., via QR scan).

**Header Section:**
- Asset name (large, prominent)
- Asset type badge (e.g., "CCTV Camera")
- Status badge (Active / Maintenance / Offline / etc.)
- UNS path breadcrumb (e.g., AcmePharma / BuildingA / Floor2 / CCTV-Cam-042)
- Identifiers: QR code thumbnail (clickable to enlarge/print), RFID tag UID, etc.
- Action buttons: **"Edit Asset," "Link to Another Asset," "Add Checklist," "Decommission"**

**Tabbed Content Area:**

**Tab 1 — Overview:**
- Key telemetry values displayed as live cards (current temperature, recording status, etc.)
- Active alarms and deviations (count + list)
- Next scheduled task and its due date
- Last completed checklist with date and performer
- Quick stats: total checklists completed, compliance rate, open tasks

**Tab 2 — Attributes:**
- Table showing all attributes: field name, **data type** (shown as badge: [Text], [Integer], [Float], [Date], etc.), current value, unit, last modified date, modified by.
- **For Float attributes:** values are displayed with precision matching the configured Resolution (Section 1.11.3 Rule 4). E.g., a value of 10 for a Float field with Resolution 0.1 is shown as "10.0".
- **For numeric attributes with constraints enabled:** a subtle indicator shows the valid range (e.g., "Range: -5.0 to 5.0, Step: 0.5") on hover or in a details tooltip.
- Inline editing for users with edit permission — click a value to edit. **Numeric fields enforce data type, Min/Max, and Resolution validation inline (Section 1.11).** Change requires reason and is logged.
- **"+ Add Attribute"** button for adding custom attributes — **requires data type selection** and optionally numeric constraints for Integer/Float types.
- **"View Change History"** link on each attribute shows the full modification history (all before/after values with timestamps and users). Numeric values in history are displayed with correct precision.

**Tab 3 — Telemetry:**
- List of all telemetry points with: name, **data type badge** ([Integer], [Float], [Boolean], etc.), current value (displayed with correct precision per Section 1.11.3 Rule 4), unit, timestamp of last update, and alarm status (normal / warning / alarm).
- **For Float telemetry points:** current values, chart values, and all historical values are displayed with precision matching the configured Resolution. E.g., Resolution = 0.01 → "25.30" not "25.3".
- **Constraint indicator:** For numeric points with constraints enabled, a small icon or tooltip shows the valid range and resolution (e.g., "0.0–100.0, step 0.1").
- Clicking a telemetry point opens a **time-series chart** showing historical values over a selectable date range. **Y-axis labels and tooltip values follow the display precision rules.**
- Alarm limits are shown as horizontal lines on the chart (displayed with correct precision).
- Manual data entry button for telemetry points configured as "Manual Entry." **The entry form enforces data type, Min/Max, Resolution validation per Section 1.11.**

**Tab 4 — Relationships:**
- Table listing all relationships for this asset:
  - Columns: Relationship Type, Direction (→ or ←), Related Asset Name, Related Asset Type, Related Asset Status
  - Example row: "Contains → | Temp Probe TP-201 | Sensor | Active"
- **"+ Add Relationship"** button opens the Link Assets dialog (Section 7.3) with this asset pre-filled as source.
- **"Remove"** action on each row (with confirmation and audit trail logging).
- **"View Map"** button opens the Relationship Map (Section 7.4) centered on this asset.
- The relationship table is sortable and filterable by relationship type.

**Tab 5 — Checklists & Records:**
- Lists all checklists attached to this asset: checklist name, frequency, last completed, next due, compliance status (on-time %, overdue count).
- Clicking a checklist name shows the checklist template (questions and structure).
- Below the checklist list: a **records table** showing all completed checklist records for this asset, newest first.
  - Columns: Record ID, Checklist Name, Performed By, Checked By, Verified By, Date, Status (On Time / Late / etc.)
  - Clicking a record opens the full record detail (all responses, signatures, timestamps).
- **"+ Add Checklist"** button to attach additional checklists to this asset.

**Tab 6 — Schedule:**
- Shows all schedules for this asset's checklists:
  - Checklist name, frequency, tolerance, last performed date (or "N/A — Onboarding"), next due date, status.
- Calendar view toggle: shows scheduled tasks plotted on a calendar for the selected date range.
- Planned vs. Performed timeline view.
- **"Edit Schedule"** button for each row (opens inline editor or dialog).

**Tab 7 — Alarms & Deviations:**
- Active alarms table: alarm name, triggered value, limit, timestamp, severity, status (open / acknowledged / closed).
- Deviation history: all deviations ever generated for this asset.
- Alarm rule configuration: list of all alarm rules on this asset — clickable to edit (for users with "Configure Alarm Rules" privilege).
- **"+ Add Alarm Rule"** button.

**Tab 8 — Audit History:**
- Complete audit trail filtered to this specific asset.
- Shows all changes: creation, attribute modifications, relationship changes, checklist completions, alarm events, schedule changes, identifier updates.
- Filterable by date range, action type, and user.
- Exportable as PDF.

### 7.6 Asset Template Manager Page

A separate page (accessible from Settings or a top-level menu item) for managing asset templates.

**Template List View:**
- Table of all asset templates: template name, description, version, number of instances created from it, last modified date, modified by.
- Search and filter by name or type.
- **"+ Create Template"** button.
- Click a template to open the Template Editor.

**Template Editor:**
- A multi-section form for building or editing a template:
  - **Basic Info:** Template name, description, icon selection, category.
  - **Attributes Section:** Add/remove/reorder attribute definitions. Each attribute has: field name, **data type (mandatory selection: Text / Integer / Float / Date / DateTime / Boolean / Dropdown / URL / File Attachment)**, required flag, default value. **For Integer and Float types:** an expandable "Numeric Constraints" panel is shown with the configuration UI described in Section 1.11.6 — Min, Max, Resolution, Enable Constraints toggle, valid value preview, and display format preview.
  - **Telemetry Section:** Add/remove telemetry point definitions. Each point has: name, **data type (mandatory selection: Integer / Float / Boolean / String / Enum)**, unit, default alarm limits. **For Integer and Float types:** an expandable "Numeric Constraints" panel is shown with Min, Max, Resolution, Enable Constraints toggle per Section 1.11.6. Alarm limit fields auto-validate against the configured constraints.
  - **Checklists Section:** Add/remove checklists. Each checklist opens a **Checklist Builder** — a drag-and-drop or sequential editor where you add question items, set their type, **declare data type for numeric question types (Fill in the Blank Numeric, Numeric with Limits, Dropdown with numeric values, Calculated Field)**, configure numeric constraints (Min, Max, Resolution per Section 1.11.6), define limits for numeric fields, configure conditional fields, and set the Performed/Checked/Verified By configuration.
  - **Record Lists Section:** Define reference registers (static lists) associated with this template.
  - **Identifiers Section:** Define which identifier types are expected (required/optional per type).
  - **Default Schedule Section:** Set default frequency and tolerance for each checklist.
  - **Default Alarm Rules Section:** Define threshold alarms and custom logic scripts.
  - **Status Lifecycle Section:** Define which statuses this asset type supports and allowed transitions.
- **Preview:** A preview panel showing what an instance created from this template would look like.
- **Save as Draft / Publish:** Templates can be drafted before publishing. Publishing creates a new version.
- **Version History:** View and compare previous versions of the template.

### 7.7 Quick Actions Available Across All Pages

These actions are available from context menus, right-click, or action buttons throughout the asset UI:

| Action | Where Available | What It Does |
|---|---|---|
| **Add Asset** | Explorer top bar, empty states, context menu | Opens the Add Asset wizard (Section 7.2) |
| **Link Assets** | Explorer top bar, asset detail Relationships tab, context menu | Opens the Link dialog (Section 7.3) |
| **Unlink Assets** | Relationship table rows, graph view edges | Removes a relationship (with confirmation + audit) |
| **Scan Identifier** | Mobile app, web camera access | Opens camera to scan QR/Barcode → navigates to asset |
| **Print QR Label** | Asset detail header, identifier section | Generates a printable QR label for the asset |
| **Clone Asset** | Asset detail action menu | Creates a new asset with the same template and pre-filled attributes (user must give it a new name and unique identifiers) |
| **Decommission** | Asset detail action menu | Changes status to Decommissioned, disables schedules, archives the asset |
| **Export Asset Data** | Asset detail, explorer toolbar | Exports asset data (attributes, telemetry, records) as PDF or CSV |
| **View in Graph** | Asset detail Relationships tab | Opens the graph view centered on this asset |

### 7.8 UI Behavior Rules

- **Real-time updates:** If another user modifies an asset or completes a checklist while someone is viewing it, the detail page should update in real time (via WebSocket/Socket.io) or show a "Data has changed — click to refresh" banner.
- **Unsaved changes warning:** If a user is editing an asset or template and navigates away, the system warns: "You have unsaved changes. Discard?"
- **Responsive design:** The asset explorer works on both desktop (side-by-side panels) and tablet (single panel with back navigation). On mobile, the tree collapses to a searchable list.
- **Keyboard shortcuts:** Ctrl+N for new asset, Ctrl+L for link assets, Ctrl+F for search, Escape to close dialogs.
- **Breadcrumb navigation:** Every page shows a breadcrumb trail (e.g., Assets → Building A → Floor 2 → Clean Room CR-101 → Attributes) for quick navigation up the hierarchy.
- **Empty states:** When there are no assets yet, the explorer shows a friendly onboarding message: "No assets yet. Start by creating your first asset or importing from a spreadsheet" with prominent action buttons.

| Version | Date | What Changed |
|---|---|---|
| v1.2 | Feb 18, 2026 | Added Section 1.11 — Numeric Data Integrity Rules (cross-cutting): mandatory data type declaration for all numeric fields (Integer vs Float), configurable Min/Max/Resolution constraints with Enable toggle, display precision rules (Float values always shown with decimal places matching Resolution — e.g., Resolution 0.1 → "10.0", Resolution 0.01 → "10.00"), step validation (values must land on resolution grid), input UX guidance (steppers, sliders, auto-dropdown for ≤50 values), numeric dropdown auto-generation from constraints, applicability matrix across attributes/telemetry/checklists/alarms/imports/APIs, and configuration UI specification. Updated Sections 1.3, 1.4, 1.7.2, 2.1, 2.2, 7.2, 7.5, and 7.6 to reference and integrate numeric integrity rules. Split "Fill in the Blank" checklist type into Text and Numeric variants. Added data type badges and constraint indicators to all display surfaces. |
| v1.1 | Feb 16, 2026 | Added Section 7 — Asset Management UI page specifications: Asset Explorer (tree + detail panels), Add Asset wizard (7-step template-based creation), Link Assets dialog (source → relationship type → target with validation), Relationship Map (visual graph view), Asset Detail page (8 tabs: overview, attributes, telemetry, relationships, checklists/records, schedule, alarms, audit), Asset Template Manager page with checklist builder, quick actions table, and UI behavior rules. |
| v1.0 | Feb 16, 2026 | Initial standalone asset module document — covers asset definition, attributes, telemetry, relationships (Contains/Contained In, Connected To, Monitors, etc.), physical identifiers, checklists with question types, Performed/Checked/Verified By model, records, schedules with onboarding mode, alarm rules with custom scripted logic, asset templates, asset management instances, access control with delegable privileges, UNS addressing, and mobile app interaction. |

---

## FUTURE DEVELOPMENT NOTES

Items explicitly noted for later phases:

1. **Record Format & Display Templates** — Configurable layouts for how completed records are displayed and printed. To be designed in a future iteration.
2. **Work Order / Task Integration** — Schedules will generate formal Work Orders that flow through the full assignment → performance → approval lifecycle. Architecture should support this from Day 1 even if the UI is not built yet.
3. **Bulk Import/Migration Tools** — For large-scale onboarding of existing assets from spreadsheets or legacy systems.
4. **Analytics & Trending** — Trend charts on telemetry over time, compliance trend reports, predictive maintenance triggers.
5. **Integration APIs** — REST and MQTT APIs for third-party systems to push telemetry, query asset data, or trigger checklists.


## Phase 2: Filter-Specific Asset Extensions

Asset instances now support filter management with additional columns:
- `filter_profile_id` (UUID, FK to filter_profiles) — assigns a cleaning profile
- `current_lifecycle_state` (VARCHAR) — current cleaning stage
- `current_cycle_id` (UUID, FK to cleaning_cycles) — active cleaning cycle
- `filter_set` (VARCHAR) — SET_A or SET_B for dual-set management


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
