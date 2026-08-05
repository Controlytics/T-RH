import { prisma } from '../../lib/prisma.js';

/**
 * Last-seen lives on the instrument, not on its credential (spec D9). A child
 * reported through its gateway never presents its own credential, so a
 * credential-based column reads "Never" for precisely the instruments the
 * gateway feature exists to serve.
 */
const WINDOW_MS = 10_000;
const lastStamped = new Map<string, { at: number; via: string }>();

/** Test seam. Never call from production code. */
export function resetLastSeenThrottle(): void { lastStamped.clear(); }

export async function stampLastSeen(
  instrumentIds: string[],
  via: 'direct' | 'gateway',
): Promise<void> {
  const now = Date.now();
  // A source change is stamped immediately even inside the window: "is this
  // device reporting directly or through its gateway?" is the question this
  // column exists to answer, and a stale answer is worse than none.
  const due = instrumentIds.filter((id) => {
    const prev = lastStamped.get(id);
    return !prev || prev.via !== via || now - prev.at >= WINDOW_MS;
  });
  if (due.length === 0) return;

  for (const id of due) lastStamped.set(id, { at: now, via });
  await prisma.instrument.updateMany({
    where: { id: { in: due } },
    data: { lastSeenAt: new Date(now), lastSeenVia: via },
  }).catch(() => {
    // Never fail an accepted reading over a telemetry-about-telemetry write.
  });
}
