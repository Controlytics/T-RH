/**
 * The three audit records the Audit Trail export fixtures were captured from
 * (`audit-report-builtin.json`, 2026-11-03): a login; an attribute change; a
 * redacted record with no IP and no role, whose redaction note runs the
 * description past the 80-character cut.
 */
export const AUDIT_RECORDS = [
  {
    id: 'r1', timestamp: '2026-09-21T10:00:00.000Z', action: 'LOGIN', userId: 'superadmin', userName: 'superadmin', userRole: 'SUPER_ADMIN',
    targetType: 'user', targetId: 'superadmin', targetName: 'superadmin', ipAddress: '10.0.0.5', beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 1, redactedAt: null,
  },
  {
    id: 'r2', timestamp: '2026-09-21T10:05:00.000Z', action: 'INSTRUMENT_ATTRIBUTE_UPDATED', userId: 'qa.lead', userName: 'qa.lead', userRole: 'QA',
    targetType: 'instrument', targetId: '6f1c2b8e-3d4a-4b5c-8d9e-0f1a2b3c4d5e', targetName: 'CWH/RDU/046-00', ipAddress: '10.0.0.7',
    beforeValue: { key: 'Location', value: 'Room 1' },
    afterValue: { key: 'Location', value: 'LCMS Room-II beside the dissolution laboratory on the north corridor' },
    reason: 'Relabelled after the layout change', signatureMeaning: null, chainPosition: 2, redactedAt: null,
  },
  {
    id: 'r3', timestamp: '2026-09-21T10:10:00.000Z', action: 'USER_UPDATED', userId: 'admin', userName: 'admin', userRole: null,
    targetType: 'user', targetId: 'operator1', targetName: 'operator1', ipAddress: null, beforeValue: null, afterValue: null,
    reason: null, signatureMeaning: null, chainPosition: 3,
    redactedAt: '2026-09-22T08:00:00.000Z', redactedByName: 'superadmin', redactionReason: 'Personal data removed on request',
  },
];
