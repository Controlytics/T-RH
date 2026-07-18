import type { FastifyInstance } from 'fastify';
import { errorResponses } from '../../lib/error-schemas.js';
import { stripHtml } from '../../lib/sanitize.js';
import { createNotification } from '../notifications/notification.service.js';
import { auditLog } from '../../lib/audit.js';

// Lightweight in-memory per-IP throttle for the PUBLIC guest endpoint (no
// @fastify/rate-limit dependency — same in-process style as reauth-check). Sliding
// window: at most MAX_PER_WINDOW requests per IP per WINDOW_MS. Bounded memory.
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_PER_WINDOW = 5;
const guestHits = new Map<string, number[]>();

function allowGuestRequest(ip: string): boolean {
  const now = Date.now();
  const recent = (guestHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    guestHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  guestHits.set(ip, recent);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (guestHits.size > 5000) {
    for (const [k, v] of guestHits) {
      if (v.every((t) => now - t >= WINDOW_MS)) guestHits.delete(k);
    }
  }
  return true;
}

// Registered at /api/guest (see app.ts). PUBLIC — no auth (guest login flow).
// The only endpoint is a guest "filter cleaning request" that drops a
// GUEST_CLEANING_REQUEST notification, gated to the configured recipient roles.
export default async function guestRoutes(app: FastifyInstance) {
  const clean = (v: unknown, max: number) => stripHtml(String(v ?? '')).trim().slice(0, max);

  app.post('/cleaning-request', {
    schema: {
      tags: ['Guest'],
      summary: 'Submit a guest filter cleaning request (public)',
      body: {
        type: 'object',
        required: ['name', 'employeeId', 'block', 'area', 'ahu', 'filter'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          employeeId: { type: 'string', minLength: 1, maxLength: 60 },
          block: { type: 'string', minLength: 1, maxLength: 120 },
          area: { type: 'string', minLength: 1, maxLength: 120 },
          ahu: { type: 'string', minLength: 1, maxLength: 120 },
          filter: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    if (!allowGuestRequest(req.ip)) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' });
    }
    const b = req.body as Record<string, unknown>;
    const name = clean(b.name, 120);
    const employeeId = clean(b.employeeId, 60);
    const block = clean(b.block, 120);
    const area = clean(b.area, 120);
    const ahu = clean(b.ahu, 120);
    const filter = clean(b.filter, 120);

    if (!name || !employeeId || !block || !area || !ahu || !filter) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'All fields are required.' });
    }

    // forRole left null — visibility is gated to the configured recipient roles
    // (config 'guest-cleaning-requests'.recipientRoles) by notification.service.
    await createNotification({
      type: 'GUEST_CLEANING_REQUEST',
      title: `Filter Cleaning Request from ${name} (${employeeId})`,
      message: [`Block: ${block}`, `Area: ${area}`, `AHU: ${ahu}`, `Filter: ${filter}`].join('\n'),
      metadata: { name, employeeId, block, area, ahu, filter, source: 'guest' },
    });

    // 21 CFR §11.10(e): record the guest activity in the tamper-evident audit
    // trail. No user account exists, so the guest's self-declared name + employee
    // ID identify the actor; userRole 'GUEST' marks it as an unauthenticated path.
    await auditLog({
      userId: `${name} (${employeeId})`,
      userName: name,
      userRole: 'GUEST',
      action: 'GUEST_CLEANING_REQUEST_SUBMITTED',
      targetType: 'guest_cleaning_request',
      // `guestName`, not `name`: the audit template renders 'Guest cleaning
      // request submitted for filter "{targetName}"', and the resolver takes
      // {targetName} from `after.name` first — so this row used to read
      // 'submitted for filter "Ravi Kumar"', naming the PERSON as the filter
      // while the real filter sat unread in `after.filter`. Renaming the key
      // lets the resolver's existing fallback reach `filterName`. The guest is
      // still identified by userId/userName above.
      afterValue: { guestName: name, employeeId, block, area, ahu, filter, filterName: filter },
      reason: `Guest filter cleaning request — ${block} / ${area} / ${ahu} / ${filter}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return { success: true };
  });
}
