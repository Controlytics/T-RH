/**
 * How the seed writes what an administrator may later change — pure, so it can be
 * tested without a database and bundled with the seed (`build-bundle.ps1` folds
 * local imports into `seed.mjs`, as it does `./seed-roles`).
 *
 * THE RULE (audit 2026-11-07 S2-C1 and its final review; the role half was 10-03
 * DATA-4, see `./seed-roles.ts`): an upgrade's reseed never rewrites what an
 * administrator set, and never creates an account. Every customer upgrade runs
 * "migrate deploy + seed" (`scripts/upgrade.ps1` → `apply-schema.ps1`,
 * `scripts/linux/digilog-lib.sh`). Until 2026-11-16 it wrote the shipped defaults
 * over `password-policy`, `login-security`, `session`, `datetime` and the
 * e-signature matrix `action-reauth` (→ `{}`), set `superadmin` ENABLED again,
 * re-created a deleted or renamed `superadmin`, and reset field labels and help
 * articles — all with no audit row.
 *
 * - A setting is CREATE-ONLY: a missing row is created whole, a stored one is never
 *   touched.
 * - `superadmin` is created only on a database with NO users (a fresh install).
 * - A field label keeps its administered `displayName`; the shipped default name,
 *   module and description stay current.
 * - A help article is CREATE-ONLY.
 *
 * WHAT THIS MEANS FOR A READER. A stored settings row now keeps the shape the
 * version that wrote it gave it. `configService.getConfig` resolves it through its
 * schema, so a key the row predates reads as the schema default. Several readers
 * read these rows RAW instead (`lib/password-validator.ts`, `auth.repository.ts`,
 * `plugins/auth.ts`, `password-expiry-sweep.ts`, `auth/routes.ts`,
 * `user.repository.ts`): for them a missing key is `undefined`, NOT the default.
 * Nothing diverges today — every stored row has the full seeded shape — but a
 * change that ADDS a key to one of these five rows must route its raw readers
 * through the schema (final review #4).
 */

import type { Prisma } from '@prisma/client';

export interface SeedSystemConfig {
  configKey: string;
  configValue: Prisma.InputJsonValue;
  configType: string;
  requiresReauth: boolean;
}

export function systemConfigUpsertArgs(config: SeedSystemConfig): Prisma.SystemConfigUpsertArgs {
  return {
    where: { configKey: config.configKey },
    update: {},
    create: config,
  };
}

/** The slice of a Prisma client `ensureSuperadmin` needs (so a test can fake it). */
export interface SuperadminClient {
  user: {
    count(): Promise<number>;
    create(args: { data: Prisma.UserCreateInput }): Promise<unknown>;
  };
}

/**
 * Create the first SUPER_ADMIN — only when the database has NO users. On an
 * upgrade (users exist) it creates nothing, so a `superadmin` an administrator
 * deleted, renamed or disabled stays that way. Returns whether it created one.
 */
export async function ensureSuperadmin(client: SuperadminClient, passwordHash: string): Promise<boolean> {
  if ((await client.user.count()) > 0) return false;
  await client.user.create({
    data: {
      username: 'superadmin',
      fullName: 'System Administrator',
      email: 'admin@digilog.local',
      passwordHash,
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
      createdBy: 'system',
    },
  });
  return true;
}

export interface SeedFieldId {
  fieldId: string;
  defaultName: string;
  displayName: string;
  module: string;
  description: string;
}

/** A field label: `displayName` is the administrator's (`PUT /api/config/field-ids/:id`, audited). */
export function fieldIdUpsertArgs(field: SeedFieldId): Prisma.FieldIdConfigUpsertArgs {
  return {
    where: { fieldId: field.fieldId },
    update: { defaultName: field.defaultName, module: field.module, description: field.description },
    create: field,
  };
}

export interface SeedHelpArticle {
  key: string;
  title: string;
  category: string;
  sortOrder: number;
}

/** A help article is administered (`HELP_ARTICLE_UPDATED`, audited): created once, never rewritten. */
export function helpArticleUpsertArgs(article: SeedHelpArticle, content: string): Prisma.HelpArticleUpsertArgs {
  return {
    where: { key: article.key },
    update: {},
    create: { key: article.key, title: article.title, content, category: article.category, sortOrder: article.sortOrder },
  };
}
