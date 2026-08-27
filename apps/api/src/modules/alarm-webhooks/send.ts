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

/** 3 attempts total, ~2s apart, all inside this job. The default; see `maxAttempts`. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends to one target, retrying up to `maxAttempts`, writing a delivery row per attempt.
 * Returns true if any attempt succeeded.
 *
 * `maxAttempts` defaults to MAX_ATTEMPTS — an annunciation gets its three tries. The
 * TEST fire passes 1 deliberately: a test is a DIAGNOSTIC, not an annunciation, and
 * retrying it tells the operator nothing they did not learn on attempt 1 while keeping
 * the request (and the `ALARM_WEBHOOK_TESTED` audit row that follows it) open for ~19s
 * against a hooter that does not answer — which is the common case for that button.
 * Clamped to at least 1 so a caller cannot accidentally send nothing.
 */
export async function deliverToTarget(
  target: {
    id: string; url: string; method: string; headers: unknown; contentType: string;
    bodyTemplate: string; successRegex: string | null; timeoutMs: number;
  },
  event: string,
  alarmId: string | null,
  variables: Record<string, string>,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  const body = renderWebhookBody(target.bodyTemplate, variables, target.contentType);
  const headers =
    target.headers && typeof target.headers === 'object' && !Array.isArray(target.headers)
      ? (target.headers as Record<string, string>)
      : {};

  for (let attempt = 1; attempt <= attempts; attempt++) {
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
    if (attempt < attempts) await sleep(RETRY_DELAY_MS);
  }
  return false;
}
