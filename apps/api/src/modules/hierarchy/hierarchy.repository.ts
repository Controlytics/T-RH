/**
 * Hierarchy repository — the ONLY place raw ltree SQL lives.
 *
 * `hierarchy_nodes.path` is an ltree column deliberately absent from
 * schema.prisma: Prisma maps ltree to Unsupported(), which would make the whole
 * model unselectable through the typed client. Everything below therefore uses
 * $queryRaw / $executeRaw, and every other module reaches the hierarchy through
 * these functions rather than touching the column.
 */
import { prisma } from '../../lib/prisma.js';
import { ValidationError } from '../../lib/errors.js';

export type HierarchyLevel =
  | 'COMPANY' | 'SITE' | 'PLANT' | 'BUILDING' | 'BLOCK' | 'AREA' | 'LINE';

export interface HierarchyNodeRow {
  id: string;
  parentId: string | null;
  level: HierarchyLevel;
  name: string;
  slug: string;
  path: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Sanitise a display name into a UNS path segment.
 * Ported from the upstream uns-path-builder. ltree labels accept only
 * [A-Za-z0-9_], so hyphens are encoded as underscores at the storage layer
 * (see toLabel) while the public slug keeps hyphens for readable topics.
 */
export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Normalise Unicode dash-like punctuation (en/em dash, figure dash, etc.)
    // to an ASCII hyphen before stripping — a dash is a separator, not a
    // character to be silently deleted like an accented letter is.
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** ltree labels forbid '-'; store as '_' and reverse on read. */
const toLabel = (slug: string) => slug.replace(/-/g, '_');
const fromLabel = (label: string) => label.replace(/_/g, '-');

export async function createNode(input: {
  parentId: string | null;
  level: HierarchyLevel;
  name: string;
  sortOrder?: number;
  createdBy?: string;
}): Promise<HierarchyNodeRow> {
  const slug = sanitizeSlug(input.name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const parentPath = input.parentId ? await getRawPath(input.parentId) : null;
  if (input.parentId && parentPath === null) {
    throw new ValidationError(`Parent node ${input.parentId} does not exist.`);
  }
  const path = parentPath ? `${parentPath}.${toLabel(slug)}` : toLabel(slug);

  const rows = await prisma.$queryRaw<HierarchyNodeRow[]>`
    INSERT INTO hierarchy_nodes (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at, created_by)
    VALUES (gen_random_uuid(), ${input.parentId}, ${input.level}::"HierarchyLevel", ${input.name},
            ${slug}, ${path}::ltree, ${input.sortOrder ?? 0}, true, now(), now(), ${input.createdBy ?? null})
    RETURNING id, parent_id AS "parentId", level, name, slug, path::text AS path,
              sort_order AS "sortOrder", is_active AS "isActive"`;
  return { ...rows[0], path: fromLabel(rows[0].path) };
}

async function getRawPath(nodeId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ path: string }[]>`
    SELECT path::text AS path FROM hierarchy_nodes WHERE id = ${nodeId}`;
  return rows[0]?.path ?? null;
}

/**
 * Full root→leaf slug chain in ONE query.
 * The upstream implementation walked the parent chain with one query per level
 * (N+1). `@>` is the ltree ancestor operator and uses the GiST index.
 */
export async function getAncestryPath(nodeId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ slug: string }[]>`
    SELECT a.slug
    FROM hierarchy_nodes n
    JOIN hierarchy_nodes a ON a.path @> n.path
    WHERE n.id = ${nodeId}
    ORDER BY nlevel(a.path)`;
  return rows.map(r => r.slug);
}

/** Reparent a node and rewrite every descendant's path in one statement. */
export async function moveNode(nodeId: string, newParentId: string | null): Promise<void> {
  const oldPath = await getRawPath(nodeId);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const newParentPath = newParentId ? await getRawPath(newParentId) : null;
  if (newParentId && newParentPath === null) {
    throw new ValidationError(`Target parent ${newParentId} does not exist.`);
  }
  // A node cannot move beneath itself or its own descendant.
  if (newParentPath && (newParentPath === oldPath || newParentPath.startsWith(`${oldPath}.`))) {
    throw new ValidationError('Cannot move a node beneath itself — that would create a cycle.');
  }

  const leaf = oldPath.split('.').pop()!;
  const newPath = newParentPath ? `${newParentPath}.${leaf}` : leaf;

  await prisma.$transaction([
    prisma.$executeRaw`UPDATE hierarchy_nodes SET parent_id = ${newParentId}, updated_at = now() WHERE id = ${nodeId}`,
    // Rewrite this node AND its whole subtree. `<@` is "is descendant of (or equal)".
    // subpath(path, offset) errors with "invalid positions" when offset == nlevel(path)
    // (i.e. for the moved node itself, whose path exactly equals oldPath) — it only
    // accepts an offset strictly less than the path's own length. The CASE guards
    // that exact-match row separately instead of asking subpath for an empty tail.
    prisma.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = CASE WHEN path = ${oldPath}::ltree
                       THEN ${newPath}::ltree
                       ELSE ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree))
                  END,
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`,
  ]);
}

/** Rename a node, re-deriving its slug and every descendant path. */
export async function renameNode(nodeId: string, name: string): Promise<void> {
  const slug = sanitizeSlug(name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const oldPath = await getRawPath(nodeId);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const parts = oldPath.split('.');
  parts[parts.length - 1] = toLabel(slug);
  const newPath = parts.join('.');

  await prisma.$transaction([
    prisma.$executeRaw`UPDATE hierarchy_nodes SET name = ${name}, slug = ${slug}, updated_at = now() WHERE id = ${nodeId}`,
    // Same exact-match guard as moveNode — see the comment there.
    prisma.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = CASE WHEN path = ${oldPath}::ltree
                       THEN ${newPath}::ltree
                       ELSE ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree))
                  END,
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`,
  ]);
}

export async function listTree(): Promise<HierarchyNodeRow[]> {
  const rows = await prisma.$queryRaw<HierarchyNodeRow[]>`
    SELECT id, parent_id AS "parentId", level, name, slug, path::text AS path,
           sort_order AS "sortOrder", is_active AS "isActive"
    FROM hierarchy_nodes ORDER BY path`;
  return rows.map(r => ({ ...r, path: fromLabel(r.path) }));
}
