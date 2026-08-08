import { prisma } from '../lib/prisma.js';

/**
 * Resolve (creating once) a throwaway instrument profile for a test file.
 *
 * Instruments have required a profile since migration 20260808120000, so every
 * fixture that registers one needs somewhere to put it. Each test file passes
 * its own name, which keeps files independent: one file's cleanup can never
 * remove a profile another file's instruments are still pointing at — and since
 * the foreign key is ON DELETE RESTRICT, that would fail loudly rather than
 * silently, wasting someone's afternoon.
 *
 * Upsert, not create: the suite runs against a persistent test database, so the
 * profile survives between runs. The in-process cache spares the repeat lookups
 * when a file registers many instruments.
 */
const cache = new Map<string, string>();

export async function fixtureProfileId(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit) return hit;

  const profile = await prisma.instrumentProfile.upsert({
    where: { name },
    update: {},
    create: { name, description: 'Test fixture — safe to delete when no instruments reference it' },
  });
  cache.set(name, profile.id);
  return profile.id;
}
