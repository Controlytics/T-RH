import { type FastifyInstance } from 'fastify';
import { REPORT_KINDS } from '@digilog/shared';
import { loadReportDownloads } from '../../report-reviews/load-downloads.js';

const policySchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['DIRECT', 'REQUEST'] },
    remarksRequired: { type: 'boolean' },
    passwordRequired: { type: 'boolean' },
  },
  required: ['mode', 'remarksRequired', 'passwordRequired'],
} as const;

/**
 * How each report type downloads (2026-10-01) — read by every authenticated
 * user, because every report dialog shapes itself from it: Download or Request
 * approval, a remarks box or none, a password field or none. Already coerced
 * through `coerceReportDownloads`. The def is SUPER_ADMIN-only.
 *
 * EVERY kind is declared: Fastify strips an undeclared key silently, and a
 * dialog reading a missing kind would fall back to Request.
 */
export async function reportDownloadsRoutes(app: FastifyInstance) {
  app.get('/report-downloads/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get how each report type downloads',
      response: {
        200: {
          type: 'object',
          properties: Object.fromEntries(REPORT_KINDS.map((k) => [k.key, policySchema])),
          required: REPORT_KINDS.map((k) => k.key),
        },
      },
    },
  }, async () => loadReportDownloads());
}
