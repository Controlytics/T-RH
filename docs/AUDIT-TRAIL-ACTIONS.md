# DigiLog — What Gets Recorded in the Audit Trail

Every important action in DigiLog is permanently recorded in a tamper-proof audit
log. Below is everything that gets logged, grouped by area. Each record also
captures **who** did it, **when**, and **from which device**.

## Login & Security
- User logs in successfully
- A login attempt fails (wrong password)
- User logs out
- A user's session is forcibly ended (someone logged in again elsewhere)
- An account gets locked after too many failed attempts
- A user changes their own password
- A login is blocked because the password expired
- A user updates their own profile
- A user is granted offline-replay access

## User Management
- A user is created, edited, or deleted
- A user is enabled or disabled
- Several users are deleted at once
- A locked account is unlocked
- An admin resets a user's password
- A password-reset request is approved or rejected
- A user submits an admin request (create / unlock / reset / modify)

## Roles & Groups
- A role is created, edited, or deleted
- A user group is created

## Filters & Equipment (Assets)
- A filter or asset is created, edited, or deleted
- A filter's status changes
- A template is created, edited, deleted, or a new version saved
- A hierarchy link (parent/child) is added or removed
- An RFID/identifier is assigned to or removed from a filter
- Filters are bulk-uploaded from a CSV file
- A filter's lifecycle stage is changed manually ("Edit Filter Status")
- An equipment group is created, edited, or deleted

## Cleaning Operations
- A cleaning cycle is started
- A cycle advances to the next stage
- A stage checklist is completed
- The dryer is started, and dryer temperature readings are recorded
- A stage is bypassed (deviation)
- A cycle is terminated
- A filter is retired or replaced
- A guest (not logged in) submits a cleaning request
- An operator requests cross-block cleaning approval

## Profiles
- A cleaning profile is created, edited, archived, or deleted
- A filter profile is created, edited, deleted, or assigned
- A checklist profile is created

## Preventive Maintenance (PM)
- A PM schedule is created, edited, deleted, or imported
- A PM entry is approved, rejected, reviewed, resubmitted, or its edit requested / review modified
- A PM task is started
- An AHU's PM filter-set mode is changed
- An overdue-PM deviation is acknowledged
- A deviation is opened or closed

## Replacement Schedules
- A replacement schedule is uploaded
- A replacement entry is approved, rejected, reviewed, resubmitted, or its review modified

## Reports
- A report is generated, digitally signed, rejected, or deleted
- A report template is created, edited, or deleted

## Notifications
- A notification rule is created, edited, or deleted
- Email (SMTP) settings are saved
- SMS settings are saved

## System & Configuration
- Any configuration page is saved (settings, roles, field IDs, etc.)
- A database backup is created or restored
- An audit record is redacted (single or in bulk)
- UNS settings are saved, a path is overridden, or a mapping is deleted
- LDAP / Active Directory settings are saved
- A help article is created, edited, or deleted
- A dashboard is created
- The MQTT broker access list (ACL) is refreshed

---

**Note:** A few things are listed as "loggable" in the system's template editor but
are **not currently recorded** — these are kept only for regulatory
(21 CFR Part 11) completeness: generic approvals, session timeouts, data
viewed/exported, unauthorized-action attempts, checklist review/approve/reject/reopen,
alarms, rule chains, device-credential regeneration, data retention/archival, and
server restarts.
