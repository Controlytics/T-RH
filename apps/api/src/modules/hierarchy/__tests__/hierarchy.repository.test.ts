import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  sanitizeSlug, createNode, getAncestryPath, moveNode, renameNode, isRawUniqueViolation,
} from '../hierarchy.repository.js';

describe('sanitizeSlug', () => {
  it('lowercases, hyphenates spaces and strips specials', () => {
    expect(sanitizeSlug('  Plant #01  ')).toBe('plant-01');
    expect(sanitizeSlug('Block A / Area 2')).toBe('block-a-area-2');
    expect(sanitizeSlug('Área—02')).toBe('rea-02');
  });
  it('collapses and trims hyphens', () => {
    expect(sanitizeSlug('a   ---   b')).toBe('a-b');
    expect(sanitizeSlug('---x---')).toBe('x');
  });
  it('strips underscores instead of preserving them, so the "-"<->"_" ltree label mapping stays lossless (I3)', () => {
    // If '_' survived into the slug, "Foo_Bar" would slug to "foo_bar", store
    // as ltree label "foo_bar" (toLabel only encodes '-' -> '_'), and read
    // back via fromLabel as "foo-bar" — a different slug than what was
    // written. Stripping '_' up front closes that round-trip mismatch.
    expect(sanitizeSlug('Foo_Bar')).toBe('foobar');
    expect(sanitizeSlug('Foo_Bar')).not.toContain('_');
  });
});

describe('hierarchy repository (ltree)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "hierarchy_nodes" CASCADE');
  });

  it('materialises the path on create', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    expect(co.path).toBe('controlyt');
    expect(site.path).toBe('controlyt.india');
  });

  it('returns full ancestry in ONE query', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    const plant = await createNode({ parentId: site.id, level: 'PLANT', name: 'Plant 01' });
    expect(await getAncestryPath(plant.id)).toEqual(['controlyt', 'india', 'plant-01']);
  });

  it('supports gaps — a skipped level is simply absent', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    // SITE and PLANT skipped entirely; AREA hangs directly off COMPANY
    const area = await createNode({ parentId: co.id, level: 'AREA', name: 'Area 02' });
    expect(await getAncestryPath(area.id)).toEqual(['controlyt', 'area-02']);
  });

  it('rewrites EVERY descendant path when a node moves', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const s1 = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    const s2 = await createNode({ parentId: co.id, level: 'SITE', name: 'Germany' });
    const plant = await createNode({ parentId: s1.id, level: 'PLANT', name: 'Plant 01' });
    const line = await createNode({ parentId: plant.id, level: 'LINE', name: 'Packing' });

    await moveNode(plant.id, s2.id);

    expect(await getAncestryPath(plant.id)).toEqual(['controlyt', 'germany', 'plant-01']);
    expect(await getAncestryPath(line.id)).toEqual(['controlyt', 'germany', 'plant-01', 'packing']);
  });

  it('rewrites descendant paths on rename', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await renameNode(co.id, 'Controlytics');
    expect(await getAncestryPath(site.id)).toEqual(['controlytics', 'india']);
  });

  it('rejects a move that would make a node its own ancestor', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await expect(moveNode(co.id, site.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects duplicate slugs under one parent with a raw-SQL unique violation isRawUniqueViolation recognises (finding I1)', async () => {
    // `rejects.toThrow()` alone (the prior assertion here) passes for ANY
    // thrown error, including a generic 500 — it doesn't prove routes.ts's
    // isRawUniqueViolation() catch actually fires for this collision.
    // Assert the concrete Postgres/Prisma shape instead.
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    let caught: unknown;
    try {
      await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isRawUniqueViolation(caught)).toBe(true);
  });
});
