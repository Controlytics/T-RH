/**
 * Hierarchy repository — the ONLY place raw ltree SQL lives.
 *
 * `hierarchy_nodes.path` is modeled in schema.prisma as `Unsupported("ltree")?`
 * so it stays tracked by migration diffing, but Prisma still can't select or
 * filter an Unsupported() field through the typed client. Everything below
 * therefore uses $queryRaw / $executeRaw, and every other module reaches the
 * hierarchy through these functions rather than touching the column.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ValidationError } from '../../lib/errors.js';

/**
 * Anything that can run a query — either the top-level Prisma client or a
 * `tx` handed in from a caller's `prisma.$transaction(async (tx) => ...)`.
 * Every mutation below accepts an optional client so a caller (routes.ts)
 * can compose the ltree write with an audit-log insert in one transaction —
 * see the module doc comment above and CLAUDE.md's "mutation + audit atomic"
 * rule. When no client is passed, mutations that need more than one
 * statement open their own transaction so standalone callers (e.g. this
 * repository's own tests) stay atomic too.
 */
type DbClient = typeof prisma | Prisma.TransactionClient;

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
 *
 * `_` is deliberately EXCLUDED from the allowed character class (final
 * branch review, finding I3): toLabel/fromLabel map '-'<->'_' 1:1 for ltree
 * storage, so if the slug itself could also contain '_', that mapping stops
 * being lossless — e.g. "Foo_Bar" would slug to "foo_bar", store as label
 * "foo_bar", and read back as "foo-bar", silently renaming the node on every
 * round-trip. Stripping '_' here (any input underscore is simply dropped,
 * same as any other disallowed character) keeps '-' the only separator the
 * slug ever contains, which is what makes toLabel/fromLabel reversible.
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
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** ltree labels forbid '-'; store as '_' and reverse on read. */
const toLabel = (slug: string) => slug.replace(/-/g, '_');
const fromLabel = (label: string) => label.replace(/_/g, '-');

/**
 * True for a unique-constraint violation raised through a $queryRaw /
 * $executeRaw statement (final branch review, finding I1).
 *
 * The typed Prisma client maps a unique violation to `P2002`, which
 * app.ts's global error handler already turns into a clean 409. Raw SQL
 * goes through a different path: Postgres raises SQLSTATE 23505, and Prisma
 * wraps that as `PrismaClientKnownRequestError` with code `P2010` (generic
 * "raw query failed") and the underlying Postgres code in `meta.code`. The
 * global handler's `P2002` check never matches that, so without this it
 * falls through to a 500 plus a spurious SYSTEM_ERROR notification —
 * exactly the gap the review found by creating two sibling nodes with the
 * same name. Every createNode/renameNode/moveNode caller in routes.ts
 * should catch this and re-throw a ConflictError naming what collided.
 */
export function isRawUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2010' &&
    (err.meta as { code?: string } | undefined)?.code === '23505'
  );
}

export async function createNode(input: {
  parentId: string | null;
  level: HierarchyLevel;
  name: string;
  sortOrder?: number;
  createdBy?: string;
}, client: DbClient = prisma): Promise<HierarchyNodeRow> {
  const slug = sanitizeSlug(input.name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const parentPath = input.parentId ? await getRawPath(input.parentId, client) : null;
  if (input.parentId && parentPath === null) {
    throw new ValidationError(`Parent node ${input.parentId} does not exist.`);
  }
  const path = parentPath ? `${parentPath}.${toLabel(slug)}` : toLabel(slug);

  const rows = await client.$queryRaw<HierarchyNodeRow[]>`
    INSERT INTO hierarchy_nodes (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at, created_by)
    VALUES (gen_random_uuid(), ${input.parentId}, ${input.level}::"HierarchyLevel", ${input.name},
            ${slug}, ${path}::ltree, ${input.sortOrder ?? 0}, true, now(), now(), ${input.createdBy ?? null})
    RETURNING id, parent_id AS "parentId", level, name, slug, path::text AS path,
              sort_order AS "sortOrder", is_active AS "isActive"`;
  return { ...rows[0], path: fromLabel(rows[0].path) };
}

async function getRawPath(nodeId: string, client: DbClient = prisma): Promise<string | null> {
  const rows = await client.$queryRaw<{ path: string }[]>`
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

/**
 * Reparent a node and rewrite every descendant's path atomically.
 *
 * Accepts an optional transaction client so a caller (e.g. the route
 * handler) can run this in the SAME transaction as its audit-log write —
 * Prisma does not allow nesting `$transaction`, so when a client IS passed
 * we issue the two statements directly against it rather than opening our
 * own. When no client is passed (e.g. this repository's own unit tests
 * calling moveNode standalone) we still open a transaction ourselves so the
 * two-statement rewrite stays atomic.
 */
export async function moveNode(nodeId: string, newParentId: string | null, tx?: Prisma.TransactionClient): Promise<void> {
  const client = tx ?? prisma;
  const oldPath = await getRawPath(nodeId, client);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const newParentPath = newParentId ? await getRawPath(newParentId, client) : null;
  if (newParentId && newParentPath === null) {
    throw new ValidationError(`Target parent ${newParentId} does not exist.`);
  }
  // A node cannot move beneath itself or its own descendant.
  if (newParentPath && (newParentPath === oldPath || newParentPath.startsWith(`${oldPath}.`))) {
    throw new ValidationError('Cannot move a node beneath itself — that would create a cycle.');
  }

  const leaf = oldPath.split('.').pop()!;
  const newPath = newParentPath ? `${newParentPath}.${leaf}` : leaf;

  const run = async (c: DbClient) => {
    await c.$executeRaw`UPDATE hierarchy_nodes SET parent_id = ${newParentId}, updated_at = now() WHERE id = ${nodeId}`;
    // Rewrite this node AND its whole subtree. `<@` is "is descendant of (or equal)".
    // subpath(path, offset) errors with "invalid positions" when offset == nlevel(path)
    // (i.e. for the moved node itself, whose path exactly equals oldPath) — it only
    // accepts an offset strictly less than the path's own length. The CASE guards
    // that exact-match row separately instead of asking subpath for an empty tail.
    await c.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = CASE WHEN path = ${oldPath}::ltree
                       THEN ${newPath}::ltree
                       ELSE ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree))
                  END,
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`;
  };

  if (tx) {
    await run(tx);
  } else {
    await prisma.$transaction((txx) => run(txx));
  }
}

/**
 * Rename a node, re-deriving its slug and every descendant path atomically.
 * See moveNode's doc comment for why `tx` is optional and how nesting is avoided.
 */
export async function renameNode(nodeId: string, name: string, tx?: Prisma.TransactionClient): Promise<void> {
  const slug = sanitizeSlug(name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const client = tx ?? prisma;
  const oldPath = await getRawPath(nodeId, client);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const parts = oldPath.split('.');
  parts[parts.length - 1] = toLabel(slug);
  const newPath = parts.join('.');

  const run = async (c: DbClient) => {
    await c.$executeRaw`UPDATE hierarchy_nodes SET name = ${name}, slug = ${slug}, updated_at = now() WHERE id = ${nodeId}`;
    // Same exact-match guard as moveNode — see the comment there.
    await c.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = CASE WHEN path = ${oldPath}::ltree
                       THEN ${newPath}::ltree
                       ELSE ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree))
                  END,
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`;
  };

  if (tx) {
    await run(tx);
  } else {
    await prisma.$transaction((txx) => run(txx));
  }
}

export async function listTree(): Promise<HierarchyNodeRow[]> {
  const rows = await prisma.$queryRaw<HierarchyNodeRow[]>`
    SELECT id, parent_id AS "parentId", level, name, slug, path::text AS path,
           sort_order AS "sortOrder", is_active AS "isActive"
    FROM hierarchy_nodes ORDER BY path`;
  return rows.map(r => ({ ...r, path: fromLabel(r.path) }));
}
