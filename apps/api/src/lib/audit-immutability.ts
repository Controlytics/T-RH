/**
 * The `audit_trail_no_delete` trigger, and the two things that legitimately
 * need to step around it.
 *
 * 21 CFR Part 11 §11.10(e) requires an audit trail that cannot be modified or
 * obscured. This system enforces that at the DATABASE level: a Postgres
 * trigger, `audit_trail_no_delete`, refuses physical deletes on `audit_trail`
 * — so the guarantee holds even against a client with direct SQL access, not
 * just against the application.
 *
 * Two code paths still have to suspend it:
 *   1. `POST /api/audit/bulk-delete` and `DELETE /api/audit/:id` — the
 *      governed hard-delete surface (see AUDIT_HARD_DELETE_ENABLED below).
 *   2. `modules/backup` restore, which TRUNCATEs and reinserts every table.
 *
 * Before this module, that dance was written out three times (audit/routes.ts
 * twice, backup.repository.ts once). Three copies of the code that switches
 * off tamper-evidence is two too many: a fix to one — such as the `finally`
 * below — has to be remembered in the others.
 */

/**
 * Whether the governed hard-delete endpoints are available.
 *
 * DEFAULT: enabled, which is the behaviour this system has always had. The
 * flag is here so a validated install can turn the capability OFF without a
 * code change, not because the default has been decided for you.
 *
 * The endpoints it gates are already permission-gated (`AUDIT_DELETE`),
 * re-authenticated, rate-limited to 5/min, and write a meta-audit record
 * naming the deletion before it happens. They are nonetheless the one place
 * in the product where §11 history can be destroyed rather than redacted, and
 * `POST /api/audit/bulk-redact` covers the legitimate "this record contains
 * data that must not be retained" case without breaking the chain.
 *
 * Set `AUDIT_HARD_DELETE_ENABLED=false` to remove the capability entirely;
 * the routes then answer 403 AUDIT_HARD_DELETE_DISABLED and point at redact.
 * Whether that should become the default is a QA/regulatory decision, not an
 * engineering one — it is called out in docs/audit/2026-08-29 finding H3.
 */
export function isHardDeleteEnabled(): boolean {
  return process.env.AUDIT_HARD_DELETE_ENABLED !== 'false';
}

/** Message used wherever the hard-delete surface is refused. */
export const HARD_DELETE_DISABLED_MESSAGE =
  'Physical deletion of audit records is disabled on this installation '
  + '(AUDIT_HARD_DELETE_ENABLED=false). Use POST /api/audit/bulk-redact, which '
  + 'removes the record content without breaking the tamper-evident hash chain.';

/**
 * Run `fn` with the named triggers disabled on `table`, then re-enable them.
 *
 * MUST be called inside a transaction, and `tx` must be that transaction's
 * client. `ALTER TABLE ... DISABLE TRIGGER` takes an ACCESS EXCLUSIVE lock, so
 * for the duration no other connection can slip an unguarded delete through
 * the window this opens.
 *
 * The re-enable is in a `finally`. Previously each copy of this code
 * re-enabled on the success path only. That was not a live bug — the enclosing
 * `$transaction` rolls back the ALTER along with everything else, because DDL
 * is transactional in Postgres — but it made the guarantee depend on an
 * invariant nothing stated. Move one of those blocks outside a transaction
 * during a refactor and the trigger stays off permanently, with no error and
 * no sign on any screen: §11 immutability silently disabled for every future
 * delete. The `finally` costs nothing and removes that failure mode.
 *
 * Querying the triggers first (rather than naming them) means a database that
 * legitimately lacks the trigger still works.
 */
export async function withTriggersDisabled<T>(
  tx: {
    $queryRawUnsafe: <R = unknown>(sql: string, ...args: unknown[]) => Promise<R>;
    $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
  },
  table: string,
  triggerNames: string[],
  fn: () => Promise<T>,
): Promise<T> {
  assertSafeIdentifier(table);
  for (const t of triggerNames) assertSafeIdentifier(t);

  const found = await tx.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname::text AS tgname
       FROM pg_trigger
      WHERE tgrelid = '"${table}"'::regclass
        AND tgname = ANY($1::text[])`,
    triggerNames,
  );

  for (const t of found) {
    await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${t.tgname}"`);
  }
  try {
    return await fn();
  } finally {
    for (const t of found) {
      await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${t.tgname}"`);
    }
  }
}

/** The immutability trigger guarding `audit_trail`. */
export const AUDIT_NO_DELETE_TRIGGER = 'audit_trail_no_delete';

/** Convenience wrapper for the audit_trail case. */
export function withAuditDeletesAllowed<T>(
  tx: Parameters<typeof withTriggersDisabled>[0],
  fn: () => Promise<T>,
): Promise<T> {
  return withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], fn);
}

/**
 * Same identifier contract as backup.repository.ts. Duplicated deliberately
 * rather than imported: this module is on the §11 enforcement path and should
 * not take a dependency on the backup module to validate its own input.
 */
function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to use unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
}
