import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  sanitizeSlug, createNode, getAncestryPath, moveNode, renameNode,
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

  it('rejects duplicate slugs under one parent', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await expect(createNode({ parentId: co.id, level: 'SITE', name: 'India' })).rejects.toThrow();
  });
});
