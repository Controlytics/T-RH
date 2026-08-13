/**
 * Exercises the REAL visibility resolver against the real database.
 *
 * Not a test file: it mutates role_configs to walk through each scope state and puts
 * it back. Kept as a script so the behaviour can be demonstrated on live data without
 * a second user account or an HTTP round trip. Restores the original scope in a
 * `finally`, so an exception cannot leave a role scoped.
 */
import { prisma } from '../src/lib/prisma.js';
import { resolveVisibility, withVisibility } from '../src/modules/instruments/visibility.js';

const ROLE = 'VIEWER';

async function countFor(scope: unknown, label: string) {
  await prisma.roleConfig.update({
    where: { role: ROLE },
    data: { instrumentScope: scope === undefined ? null : (scope as never) },
  });
  const { scope: effective, where } = await resolveVisibility({ userId: '__probe__', userRole: ROLE });
  const n = await prisma.instrument.count({ where: withVisibility(undefined, where) as never });
  const shown = effective === null ? 'null (unrestricted)' : JSON.stringify(effective).slice(0, 42);
  console.log(`  ${label.padEnd(36)} scope=${shown.padEnd(46)} -> ${n} instruments`);
}

async function main() {
  const before = await prisma.roleConfig.findUnique({ where: { role: ROLE }, select: { instrumentScope: true } });
  const total = await prisma.instrument.count();
  const locs = await prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true } });
  const id = (name: string) => locs.find((l) => l.name === name)!.id;
  console.log(`\ntotal instruments in the database: ${total}`);
  console.log(`locations: ${locs.map((l) => `${l.name}(${l.type})`).join(', ')}\n`);

  try {
    await countFor(undefined, 'NULL — unrestricted');
    await countFor([id('CWH')], '[CWH] — block, expands to areas');
    await countFor([id('Module-E')], '[Module-E] — area only');
    await countFor([id('Block C')], '[Block C]');
    await countFor([id('CWH'), id('Block C')], '[CWH, Block C] — both');
    await countFor([], '[] — SEES NOTHING');
    await countFor(['00000000-0000-0000-0000-000000000000'], '[stale id] — must NOT widen');
    const sa = await resolveVisibility({ userId: '__probe__', userRole: 'SUPER_ADMIN' });
    console.log(`  ${'SUPER_ADMIN (scope ignored)'.padEnd(36)} scope=${String(sa.scope).padEnd(46)} -> ${await prisma.instrument.count()} instruments`);
  } finally {
    await prisma.roleConfig.update({
      where: { role: ROLE },
      data: { instrumentScope: (before?.instrumentScope ?? null) as never },
    });
    console.log(`\n  restored ${ROLE}.instrument_scope to ${JSON.stringify(before?.instrumentScope ?? null)}`);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
