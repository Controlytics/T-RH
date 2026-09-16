import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { ATTRIBUTE_LABELS_CONFIG_KEY } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { buildApp, loginAs, authGet, authPost, authPut } from './test-helper.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Bulk upload carries the profile's ATTRIBUTES (2026-09-16), headed by their
 * administered display names. End to end: the route resolves the profile's key
 * list and the display-name map, the parser turns a heading back into a KEY,
 * and each created instrument ends up with the attribute rows the file gave —
 * stored by key, audited per key, exactly as the single form's per-attribute
 * POSTs would have written them.
 */
describe('POST /api/instruments/bulk — attribute columns', () => {
  let app: FastifyInstance;
  let token: string;
  let profileId: string;
  let baseLabels: unknown;
  const created: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    profileId = await fixtureProfileId('fixture:bulk-attributes');
    await prisma.instrumentProfile.update({
      where: { id: profileId },
      data: { attributeKeys: 'Building\nEnable_Temp_NMT\nRoom' },
    });
    const row = await prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    baseLabels = row?.configValue ?? null;
    const put = await authPut(app, '/api/config/dynamic/attribute-labels', token, {
      labels: { Enable_Temp_NMT: 'High temperature alarm enabled', Room: 'Cleanroom number' },
    });
    expect(put.statusCode).toBe(200);
  });

  afterAll(async () => {
    // Config restore FIRST, guarded, so a failing test still hands back the row.
    try {
      if (baseLabels === null) {
        await prisma.systemConfig.deleteMany({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
      } else {
        await prisma.systemConfig.update({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY }, data: { configValue: baseLabels as object } });
      }
    } catch { /* leave the rest of the teardown to run */ }
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId: { in: created } } });
    await prisma.instrumentCredential.deleteMany({ where: { instrumentId: { in: created } } }).catch(() => undefined);
    await prisma.instrument.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('a file headed by display names lands as attributes stored by KEY, and one unknown heading warns once', async () => {
    const stamp = Date.now();
    const csv = [
      'Instrument ID,High temperature alarm enabled,Building,Cleanroom number,Colour',
      `BA-${stamp},1,CWH Block,101,blue`,
      `BB-${stamp},,Stability,,red`,
    ].join('\n');
    const res = await authPost(app, '/api/instruments/bulk', token, { csv, profileId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const c of body.created) created.push(c.id);
    expect(body.errors).toEqual([]);
    expect(body.created).toHaveLength(2);
    // Headed as the template prints it. No name column: the name is the code,
    // as the create form fills it.
    expect(body.created[0].name).toBe(`BA-${stamp}`);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/Colour/);

    const a = await authGet(app, `/api/instruments/${body.created[0].id}/attributes`, token);
    const aRows = Object.fromEntries((a.json().data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(aRows).toEqual({ Enable_Temp_NMT: '1', Building: 'CWH Block', Room: '101' });

    // Blank cells are NOT written as empty attributes.
    const b = await authGet(app, `/api/instruments/${body.created[1].id}/attributes`, token);
    const bRows = Object.fromEntries((b.json().data as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(bRows).toEqual({ Building: 'Stability' });

    // Each attribute is a §11 record of its own: one INSTRUMENT_ATTRIBUTE_SET
    // row per key, naming the code and the KEY (never the display name).
    const audit = await prisma.auditTrail.findMany({
      where: { action: 'INSTRUMENT_ATTRIBUTE_SET', targetId: body.created[0].id },
      select: { afterValue: true },
    });
    const audited = audit.map((r) => (r.afterValue as { attribute: string }).attribute).sort();
    expect(audited).toEqual(['Building', 'Enable_Temp_NMT', 'Room']);
  });
});
