/**
 * Sends one alarm-webhook event to one target, with bounded retry and a delivery
 * row per attempt.
 *
 * Lives here rather than in the worker so `apps/api/src/workers/alarm-webhook.worker.ts`
 * and a later "send test" HTTP route can both import it — a route importing from
 * `workers/` would invert this codebase's layering, where shared logic lives under
 * `modules/`.
 */

import { prisma } from '../../lib/prisma.js';
import { renderWebhookBody } from './render-body.js';
import { attemptDelivery } from './deliver.js';

/** 3 attempts total, ~2s apart, all inside this job. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends to one target, retrying up to MAX_ATTEMPTS, writing a delivery row per attempt.
 * Returns true if any attempt succeeded.
 */
export async function deliverToTarget(
  target: {
    id: string; url: string; method: string; headers: unknown; contentType: string;
    bodyTemplate: string; successRegex: string | null; timeoutMs: number;
  },
  event: string,
  alarmId: string | null,
  variables: Record<string, string>,
): Promise<boolean> {
  const body = renderWebhookBody(target.bodyTemplate, variables, target.contentType);
  const headers =
    target.headers && typeof target.headers === 'object' && !Array.isArray(target.headers)
      ? (target.headers as Record<string, string>)
      : {};

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptDelivery({
      url: target.url,
      method: target.method,
      headers,
      contentType: target.contentType,
      body,
      timeoutMs: target.timeoutMs,
      successRegex: target.successRegex,
    });

    // A row PER ATTEMPT, success or failure. An annunciation this system claims it
    // made needs evidence, and so does one it failed to make.
    await prisma.alarmWebhookDelivery.create({
      data: {
        targetId: target.id,
        alarmId,
        event,
        url: target.url,
        requestBody: body,
        httpStatus: result.httpStatus,
        responseSnippet: result.responseSnippet,
        attempt,
        status: result.ok ? 'SENT' : 'FAILED',
        error: result.error,
        sentAt: result.ok ? new Date() : null,
      },
    });

    if (result.ok) return true;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return false;
}
