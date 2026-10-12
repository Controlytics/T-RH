import { Client } from 'ldapts';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { invalidateUserAuthCache } from '../../plugins/auth.js';
import { logger } from '../../lib/logger.js';
import { AppError, ValidationError } from '../../lib/errors.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** What GET /api/ldap/config shows for a stored bind password, and what the
 *  config page therefore sends back when nobody retyped it. */
export const LDAP_PASSWORD_MASK = '********';

/**
 * Is the incoming config aimed at the SAME directory account as the stored
 * one? Server URL compared trimmed and case-insensitively (scheme and host are
 * case-insensitive); bind DN likewise (AD DNs are).
 */
function sameBindTarget(a: Pick<LdapConfig, 'serverUrl' | 'bindDN'>, b: Pick<LdapConfig, 'serverUrl' | 'bindDN'>): boolean {
  const n = (v: unknown) => String(v ?? '').trim().toLowerCase();
  return n(a.serverUrl) === n(b.serverUrl) && n(a.bindDN) === n(b.bindDN);
}

/**
 * The bind password a request is allowed to use (application review
 * 2026-10-12, finding 2).
 *
 * The stored service-account password is used ONLY for the stored server and
 * bind DN. Test-connection used to merge the request over the stored config
 * and bind with the result, so a CONFIG_UPDATE holder could send just
 * `serverUrl: ldap://their-host` and receive the stored password in the clear
 * (a simple bind carries it as-is). Save had the same path: a changed
 * serverUrl saved with the mask kept the stored password, and the next login
 * bound to the new host with it. Now: a request that names a different target
 * must carry its own password, or it is refused.
 *
 * `absent` (omitted, or the page's mask) means "the stored one"; anything
 * else is the caller's own password and is used as given.
 */
function resolveBindPassword(
  incoming: Partial<LdapConfig>,
  stored: LdapConfig,
  merged: LdapConfig,
  absent: (v: unknown) => boolean,
): string {
  if (!absent(incoming.bindPassword)) return String(incoming.bindPassword ?? '');
  if (!stored.bindPassword || sameBindTarget(merged, stored)) return stored.bindPassword;
  throw new ValidationError(
    'The server URL or bind DN differs from the saved one: enter the bind password for it',
    { fieldErrors: { bindPassword: ['Required when the server URL or bind DN changes'] } },
  );
}

/**
 * Placeholder written to `users.password_hash` for directory-authenticated
 * accounts. Deliberately NOT a valid bcrypt hash: `bcrypt.compare()` against it
 * always returns false, so any credential path that forgets to consult
 * `authSource` fails closed rather than open.
 *
 * Declared here — the leaf that actually writes it — and re-exported by
 * `lib/ldap-identity.ts`, which reads it. The dependency runs one way only
 * (ldap-identity → ldap.service); declaring it in ldap-identity instead would
 * close the loop into an import cycle.
 */
export const LDAP_SENTINEL_HASH = 'LDAP_EXTERNAL_AUTH';

/**
 * Escape a string for safe use as an LDAP search-filter assertion value.
 *
 * Per RFC 4515 §3, the following characters MUST be escaped in filter
 * assertion values (this is search-filter escaping, NOT DN escaping —
 * the two character sets differ):
 *   \  → \5c   (MUST be substituted FIRST — later substitutions produce \, so
 *               processing \ first prevents those from being double-escaped)
 *   *  → \2a
 *   (  → \28
 *   )  → \29
 *   NUL → \00
 *
 * Audit finding reference: L-1 (Medium-LATENT) — LDAP filter injection.
 * LDAP is currently disabled (enabled: false) so this is a latent risk.
 */
export function escapeLdapFilterValue(v: string): string {
  return v
    .replace(/\\/g, '\\5c')   // MUST be first — subsequent substitutions produce \ in output
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

export interface LdapConfig {
  enabled: boolean;
  serverUrl: string;
  bindDN: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  fullNameAttribute: string;
  departmentAttribute: string;
  groupAttribute: string;
  tlsRejectUnauthorized: boolean;
  connectionTimeout: number;
  roleMappings: Array<{ ldapGroup: string; role: string }>;
  defaultRole: string;
  defaultOrganizationId?: string;
  syncAttributes: boolean;
  /**
   * Groups a directory user MUST belong to before they are allowed in at all
   * (checked in code, after the bind, against the resolved group list).
   *
   * Until this existed, access restriction lived ENTIRELY in whether the
   * administrator happened to type a `memberOf` clause into `searchFilter`.
   * With the default filter — `(sAMAccountName={{username}})` — every employee
   * in the whole directory could log in and be auto-provisioned onto
   * `defaultRole`. That is a silent, one-typo-wide door, and nothing in the
   * product enforced or even warned about it.
   *
   * Empty array = no restriction (previous behaviour, preserved for existing
   * installs). Matching uses the same whole-value-or-exact-RDN rule as
   * `roleMappings`, so an operator can enter either the full group DN or just
   * its CN.
   *
   * This is defence in depth, not a replacement for a scoped `searchFilter`:
   * the filter keeps non-members from being looked up at all, this keeps them
   * out if the filter is wrong.
   */
  requiredGroups: string[];
  /**
   * Refuse the login when a `roleMappings` entry names a role that does not
   * exist (or is inactive) in the Roles table, instead of falling back to
   * `defaultRole`.
   *
   * Default false — fall back and audit — because the failure mode this guards
   * is a *typo in configuration*, and locking every matching employee out of
   * the application is a worse first response than admitting them at the
   * default (usually least-privileged) role with a loud audit row. Sites that
   * would rather fail closed can flip it.
   */
  strictRoleMapping: boolean;
}

export interface LdapAuthResult {
  success: boolean;
  userDn: string;
  attributes: {
    fullName: string;
    email: string;
    department: string;
  };
  groups: string[];
}

const DEFAULT_CONFIG: LdapConfig = {
  enabled: false,
  serverUrl: '',
  bindDN: '',
  bindPassword: '',
  searchBase: '',
  searchFilter: '(sAMAccountName={{username}})',
  usernameAttribute: 'sAMAccountName',
  emailAttribute: 'mail',
  fullNameAttribute: 'displayName',
  departmentAttribute: 'department',
  groupAttribute: 'memberOf',
  // Secure by default. This was `false`, which meant an ldaps:// bind accepted
  // ANY certificate — an on-path attacker could present a self-signed cert and
  // harvest the service-account bindPassword plus every user's password in
  // cleartext. Operators with an internal CA can still opt out explicitly.
  tlsRejectUnauthorized: true,
  connectionTimeout: 5000,
  roleMappings: [],
  defaultRole: 'OPERATOR',
  defaultOrganizationId: '',
  syncAttributes: true,
  requiredGroups: [],
  strictRoleMapping: false,
};

/**
 * Does an LDAP group value (typically a full DN from `memberOf`, e.g.
 * "CN=Cleanroom Admins,OU=Groups,DC=corp,DC=local") match a configured mapping?
 *
 * Matches on the whole value or on an exact RDN component — so a mapping of
 * "Cleanroom Admins" still resolves a full DN, which is how operators actually
 * configure this. What it no longer does is substring-match: the previous
 * `.includes()` meant a mapping for "admin" also matched "CN=BackupAdmins",
 * silently handing the admin role to members of any group whose name merely
 * contained the word.
 *
 * `ldapGroupLower` must already be lower-cased by the caller.
 */
function matchesLdapGroup(group: string, ldapGroupLower: string): boolean {
  const g = group.toLowerCase().trim();
  if (g === ldapGroupLower) return true;
  // Compare each RDN's value: "cn=cleanroom admins" -> "cleanroom admins".
  return g.split(',').some((rdn) => {
    const eq = rdn.indexOf('=');
    const value = (eq === -1 ? rdn : rdn.slice(eq + 1)).trim();
    return value === ldapGroupLower;
  });
}

/**
 * Build an LDAP client for this configuration.
 *
 * **`tlsOptions` is passed ONLY for `ldaps://`.** ldapts decides whether to run
 * a TLS handshake with
 *   `secure = isSecureProtocol || hasTlsOptions`
 * — so merely *supplying* `tlsOptions` forces TLS regardless of the URL scheme.
 * All three call sites used to pass it unconditionally, which meant a plain
 * `ldap://host:389` connection attempted a TLS handshake against a cleartext
 * port and died with
 *   "Client network socket disconnected before secure TLS connection was established"
 * — an error that points an operator at their certificates when the real
 * problem is that we asked for TLS on a non-TLS port. The config page offers
 * `ldap://` in as many words ("or ldap:// for plain (port 389)"), so this made a
 * documented, offered option silently impossible. Found 2026-08-08 the first
 * time the code was pointed at a real LDAP server rather than a mock.
 *
 * Security is unaffected: `ldaps://` still gets `rejectUnauthorized`, still
 * defaulting to true. An operator choosing `ldap://` has chosen cleartext, and
 * a TLS setting was never going to protect them.
 */
function buildClient(cfg: Pick<LdapConfig, 'serverUrl' | 'connectionTimeout' | 'tlsRejectUnauthorized'>): Client {
  const isSecure = cfg.serverUrl.trim().toLowerCase().startsWith('ldaps:');
  return new Client({
    url: cfg.serverUrl,
    connectTimeout: cfg.connectionTimeout || 5000,
    ...(isSecure
      ? { tlsOptions: { rejectUnauthorized: cfg.tlsRejectUnauthorized ?? true } }
      : {}),
  });
}

export const ldapService = {
  async getConfig(): Promise<LdapConfig> {
    const config = await prisma.systemConfig.findFirst({ where: { configKey: 'ldap' } });
    if (!config?.configValue) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...(config.configValue as Record<string, unknown>) } as LdapConfig;
  },

  async saveConfig(config: Partial<LdapConfig>, updatedBy: string, tx?: Tx): Promise<void> {
    const existing = await this.getConfig();

    // The mask (or no password at all) keeps the stored one — but only for the
    // stored server and bind DN (finding 2). An explicit '' still clears it.
    const merged = { ...existing, ...config };
    merged.bindPassword = resolveBindPassword(config, existing, merged, (v) => v === undefined || v === LDAP_PASSWORD_MASK);

    await (tx ?? prisma).systemConfig.upsert({
      where: { configKey: 'ldap' },
      update: { configValue: merged as any, updatedBy, updatedAt: new Date() },
      create: { configKey: 'ldap', configValue: merged as any, configType: 'security', requiresReauth: true, updatedBy },
    });
  },

  /**
   * The config a connection test binds with: the stored config with the
   * request laid over it, and the bind password resolved by the finding-2 rule
   * above (a blank, the mask or no password = the stored one, for the stored
   * target only). Exposed so the route can audit WHAT was tested.
   */
  async resolveTestConfig(config?: Partial<LdapConfig>): Promise<LdapConfig> {
    const stored = await this.getConfig();
    if (!config) return stored;
    const merged = { ...stored, ...config };
    merged.bindPassword = resolveBindPassword(config, stored, merged, (v) => v === undefined || v === '' || v === LDAP_PASSWORD_MASK);
    return merged;
  },

  /**
   * Finding 7 (application review 2026-10-12): `roleMappings` and `defaultRole`
   * decide what role a directory user is GIVEN, so writing them is granting a
   * role. A non-SUPER_ADMIN may only name roles that exist and sit below its
   * own level, never SUPER_ADMIN, never its own. A mapping already stored, and
   * an unchanged default role, are grandfathered — otherwise one mapping a
   * SUPER_ADMIN made would stop a lower admin saving any LDAP field at all.
   */
  async assertRoleTargetsWithinCaller(callerRole: string, incoming: Partial<LdapConfig>): Promise<void> {
    if (callerRole === 'SUPER_ADMIN') return;
    const stored = await this.getConfig();
    const key = (m: { ldapGroup?: unknown; role?: unknown }) => `${String(m.ldapGroup ?? '').trim().toLowerCase()}\u0000${String(m.role ?? '')}`;
    const kept = new Set((stored.roleMappings ?? []).map(key));
    const named = new Set<string>();
    for (const m of Array.isArray(incoming.roleMappings) ? incoming.roleMappings : []) {
      if (!kept.has(key(m))) named.add(String(m?.role ?? ''));
    }
    if (incoming.defaultRole !== undefined && incoming.defaultRole !== stored.defaultRole) named.add(String(incoming.defaultRole));
    if (named.size === 0) return;

    const caller = await prisma.role.findUnique({ where: { name: callerRole }, select: { hierarchyLevel: true } });
    if (!caller) throw new AppError(403, 'FORBIDDEN', 'Your role is not recognized');
    const rows = await prisma.role.findMany({ where: { name: { in: [...named] } }, select: { name: true, hierarchyLevel: true } });
    const level = new Map(rows.map((r) => [r.name, r.hierarchyLevel]));
    const refused = [...named].filter((r) =>
      r === 'SUPER_ADMIN' || r === callerRole || !level.has(r) || (level.get(r) as number) >= caller.hierarchyLevel);
    if (refused.length > 0) {
      throw new AppError(403, 'FORBIDDEN', `You cannot map directory users to a role at or above your own: ${refused.join(', ')}`);
    }
  },

  async testConnection(config?: Partial<LdapConfig>): Promise<{ success: boolean; message: string }> {
    const cfg = await this.resolveTestConfig(config);

    if (!cfg.serverUrl || !cfg.bindDN || !cfg.bindPassword) {
      return { success: false, message: 'Server URL, Bind DN, and Bind Password are required' };
    }

    const client = buildClient(cfg);

    try {
      await client.bind(cfg.bindDN, cfg.bindPassword);
      await client.unbind();
      return { success: true, message: 'Successfully connected and authenticated to LDAP server' };
    } catch (err: any) {
      return { success: false, message: `LDAP connection failed: ${err.message || err}` };
    }
  },

  async authenticateUser(username: string, password: string): Promise<LdapAuthResult | null> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return null;

    const client = buildClient(cfg);

    try {
      // Step 1: Bind as service account
      await client.bind(cfg.bindDN, cfg.bindPassword);

      // Step 2: Search for the user
      // Escape the user-supplied username before substitution to prevent LDAP
      // filter injection (RFC 4515 §3). An unescaped * or () could allow
      // user enumeration or wildcard-targeting even though auth bypass is not
      // possible (bind still requires the real password).
      const safeUsername = escapeLdapFilterValue(username);
      const filter = cfg.searchFilter.replace(/\{\{username\}\}/g, safeUsername);
      const { searchEntries } = await client.search(cfg.searchBase, {
        scope: 'sub',
        filter,
        attributes: [
          cfg.usernameAttribute,
          cfg.emailAttribute,
          cfg.fullNameAttribute,
          cfg.departmentAttribute,
          cfg.groupAttribute,
          'dn',
        ],
      });

      if (searchEntries.length === 0) {
        await client.unbind();
        return null;
      }

      const entry = searchEntries[0];
      const userDn = entry.dn;

      // Extract attributes
      const getAttribute = (attr: string): string => {
        const val = entry[attr];
        if (!val) return '';
        if (Array.isArray(val)) return String(val[0] || '');
        return String(val);
      };

      const fullName = getAttribute(cfg.fullNameAttribute);
      const email = getAttribute(cfg.emailAttribute);
      const department = getAttribute(cfg.departmentAttribute);

      // Extract groups
      const groupVal = entry[cfg.groupAttribute];
      const groups: string[] = [];
      if (groupVal) {
        if (Array.isArray(groupVal)) {
          groups.push(...groupVal.map(String));
        } else {
          groups.push(String(groupVal));
        }
      }

      await client.unbind();

      // Step 3: Verify user's password by binding as the user
      const userClient = buildClient(cfg);

      try {
        await userClient.bind(userDn, password);
        await userClient.unbind();
      } catch {
        return null; // Invalid password
      }

      // Access gate — checked AFTER the user's own bind succeeds, deliberately.
      // Checking it earlier would let an unauthenticated caller probe group
      // membership by watching which usernames fail fast; checking it here
      // means only the account holder learns they lack access. See the
      // `requiredGroups` doc comment for why this exists at all.
      if (cfg.requiredGroups?.length) {
        const permitted = cfg.requiredGroups.some((required) => {
          const wanted = required.toLowerCase().trim();
          return wanted !== '' && groups.some((g) => matchesLdapGroup(g, wanted));
        });
        if (!permitted) {
          logger.warn(
            `[LDAP] "${username}" authenticated but is not a member of any required group `
            + `(${cfg.requiredGroups.join(', ')}) — access refused.`,
          );
          return null;
        }
      }

      return {
        success: true,
        userDn,
        attributes: { fullName, email, department },
        groups,
      };
    } catch (err: any) {
      logger.error('[LDAP] Authentication error:', err.message);
      // Best-effort unbind. If the socket is already torn down by the
      // server (common on auth failures), unbind() rejects with "client
      // is not connected" — that's not an actionable error for the caller,
      // but log so a flood of unbind failures (a real server-side issue)
      // is still visible.
      try {
        await client.unbind();
      } catch (unbindErr: any) {
        logger.warn('[LDAP] unbind after auth error failed:', unbindErr?.message ?? unbindErr);
      }
      return null;
    }
  },

  matchesLdapGroup,

  /**
   * Every role a user's groups map to, in STORED order, de-duplicated.
   * An LDAP mapping must never confer SUPER_ADMIN — such a user is unusable
   * anyway (auth.service.ts refuses the LDAP bind branch for SUPER_ADMIN and the
   * sentinel passwordHash then 401s) — so those entries are skipped.
   */
  matchedRoles(groups: string[], config: LdapConfig): string[] {
    const out: string[] = [];
    for (const mapping of config.roleMappings ?? []) {
      if (mapping.role === 'SUPER_ADMIN') continue;
      const ldapGroupLower = String(mapping.ldapGroup ?? '').toLowerCase();
      if (groups.some((g) => matchesLdapGroup(g, ldapGroupLower)) && !out.includes(mapping.role)) out.push(mapping.role);
    }
    return out;
  },

  /**
   * THE PRECEDENCE RULE (application review 2026-10-12, follow-up 5): when a
   * user's groups match several mappings, the HIGHEST-PRIVILEGE role wins —
   * the greatest `hierarchyLevel` in `levels`; the stored order only breaks a
   * tie between roles at the same level. With no `levels` (or no mapped role
   * known in it) every candidate ties, which reduces to the stored order.
   *
   * It used to be "first match in stored order", which made the role a person
   * received depend on row order nobody could see or set on the config page
   * (it has no reorder control), and let anyone who could re-save the list
   * change it by deleting and re-adding a row. Highest-privilege is what the
   * integration guide already told operators to arrange by hand ("list
   * most-privileged first"), so for a correctly ordered list nothing changes;
   * for any other list it removes the order dependence. A user in both
   * "Operators" and "Admins" is an admin — the directory says they are one.
   *
   * Roles absent from `levels` (missing or inactive) lose to any present one.
   */
  mapGroupsToRole(groups: string[], config: LdapConfig, levels?: Map<string, number>): string {
    const candidates = this.matchedRoles(groups, config);
    if (candidates.length === 0) return config.defaultRole || 'OPERATOR';
    if (!levels) return candidates[0];
    let best = candidates[0];
    let bestLevel = levels.get(best) ?? -Infinity;
    for (const role of candidates.slice(1)) {
      const level = levels.get(role) ?? -Infinity;
      if (level > bestLevel) { best = role; bestLevel = level; }
    }
    return best;
  },

  /**
   * `mapGroupsToRole` + a existence check against the Roles table.
   *
   * `provisionUser`/`syncUserAttributes` write the mapped name straight into
   * `users.role`, which is a plain VarChar with no FK to `roles.name`. A typo in
   * a mapping — or mapping to a role an admin later deleted or deactivated —
   * therefore produced a user with a dangling role: every permission lookup
   * missed, so they logged in successfully to an application with nothing in it
   * and no error anywhere explaining why. This is the likely first-run
   * experience for a client mapping a role like "QA" that they have not created
   * in Roles & Access yet.
   *
   * Returns the role to use plus whether a fallback happened, so the caller can
   * record the mismatch in the audit trail rather than swallowing it.
   */
  async resolveMappedRole(
    groups: string[],
    config: LdapConfig,
  ): Promise<{ role: string; mappedRole: string; fellBack: boolean }> {
    // Levels of the ACTIVE roles the groups match, so the precedence rule
    // above can pick the highest; an inactive or missing role is not in the
    // map and therefore never beats one that exists.
    const candidates = this.matchedRoles(groups, config);
    const known = candidates.length
      ? await prisma.role.findMany({ where: { name: { in: candidates }, isActive: true }, select: { name: true, hierarchyLevel: true } })
      : [];
    const mappedRole = this.mapGroupsToRole(groups, config, new Map(known.map((r) => [r.name, r.hierarchyLevel])));
    const exists = await prisma.role.findFirst({
      where: { name: mappedRole, isActive: true },
      select: { name: true },
    });
    if (exists) return { role: mappedRole, mappedRole, fellBack: false };

    if (config.strictRoleMapping) {
      throw new Error(
        `LDAP role mapping resolved to "${mappedRole}", which is not an active role in this application. `
        + 'Create it under Configuration → Roles & Access, or correct the mapping.',
      );
    }

    // Fall back to the configured default — but only if THAT exists, otherwise
    // we would just swap one dangling role for another.
    const fallback = config.defaultRole || 'OPERATOR';
    const fallbackExists = await prisma.role.findFirst({
      where: { name: fallback, isActive: true },
      select: { name: true },
    });
    logger.error(
      `[LDAP] Mapped role "${mappedRole}" does not exist or is inactive. `
      + (fallbackExists
        ? `Falling back to default role "${fallback}".`
        : `Default role "${fallback}" is ALSO missing — the user will have no permissions.`),
    );
    return { role: fallbackExists ? fallback : mappedRole, mappedRole, fellBack: true };
  },

  async provisionUser(username: string, ldapResult: LdapAuthResult, config: LdapConfig) {
    const { role, mappedRole, fellBack } = await this.resolveMappedRole(ldapResult.groups, config);

    const user = await prisma.user.create({
      data: {
        username,
        fullName: ldapResult.attributes.fullName || username,
        email: ldapResult.attributes.email || `${username}@ldap.local`,
        passwordHash: LDAP_SENTINEL_HASH,
        role,
        authSource: 'ldap',
        ldapDn: ldapResult.userDn,
        department: ldapResult.attributes.department || null,
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        // Anchor the expiry clock at provisioning even though directory users
        // are exempt from password expiry (lib/password-expiry consumers skip
        // them). Leaving it null made the row indistinguishable from a legacy
        // local user whose column predates the feature, which is exactly the
        // ambiguity that let the expiry sweep force-expire AD accounts.
        passwordChangedAt: new Date(),
      },
    });

    // 21 CFR §11.10(e): auto-provisioning creates a user record with a
    // group-mapped role — with an ADMIN mapping, an unknown directory user
    // becomes an ADMIN. The local-admin path emits USER_CREATED; so must this.
    // Best-effort: the caller (auth.service.login) swallows provisioning errors,
    // so an audit failure must not fail an otherwise valid login. Logged loudly.
    try {
      await auditLog({
        userId: username, userRole: role,
        action: 'USER_CREATED', targetType: 'user', targetId: user.id,
        afterValue: {
          username, role, authSource: 'ldap', ldapDn: ldapResult.userDn,
          status: 'ENABLED', ldapGroups: ldapResult.groups,
          // Only present when the group mapping named a role this application
          // does not have — an inspector reading the row needs to see that the
          // role granted is NOT the role the directory mapping asked for.
          ...(fellBack ? { mappedRoleNotFound: mappedRole } : {}),
        },
        reason: 'LDAP auto-provisioning on first successful directory login',
        signatureMeaning: fellBack
          ? `User "${username}" auto-provisioned from LDAP with fallback role "${role}" `
            + `(mapped role "${mappedRole}" does not exist)`
          : `User "${username}" auto-provisioned from LDAP with role "${role}"`,
      });
    } catch (auditErr: any) {
      logger.error('[LDAP] Audit write failed for auto-provisioned user:', auditErr?.message ?? auditErr);
    }

    return user;
  },

  async syncUserAttributes(userId: string, ldapResult: LdapAuthResult, config: LdapConfig) {
    if (!config.syncAttributes) return;

    const updates: Record<string, any> = {};
    if (ldapResult.attributes.fullName) updates.fullName = ldapResult.attributes.fullName;
    if (ldapResult.attributes.email) updates.email = ldapResult.attributes.email;
    if (ldapResult.attributes.department) updates.department = ldapResult.attributes.department;
    updates.ldapDn = ldapResult.userDn;

    // Update role if group mapping changed. Validated against the Roles table —
    // an admin deactivating a role must not turn every AD user mapped to it
    // into a permission-less ghost on their next login.
    const { role: newRole } = await this.resolveMappedRole(ldapResult.groups, config);
    if (newRole) updates.role = newRole;

    if (Object.keys(updates).length > 0) {
      // Read the prior state so the audit row can show what actually changed —
      // a directory group change can silently escalate this user's role here.
      const before = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, fullName: true, email: true, department: true, role: true, ldapDn: true },
      });
      await prisma.user.update({ where: { id: userId }, data: updates });
      invalidateUserAuthCache(userId);

      // Only audit fields that actually changed — this runs on EVERY LDAP login,
      // and a row per login with no delta is noise that buries the real ones.
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(updates)) {
        const prior = (before as Record<string, any> | null)?.[key];
        if (prior !== value) changed[key] = { from: prior ?? null, to: value };
      }

      if (Object.keys(changed).length > 0) {
        const roleChanged = changed.role !== undefined;
        // Best-effort: auth.service wraps this call in a try/catch, so an audit
        // failure must not break login.
        try {
          await auditLog({
            userId: before?.username ?? userId, userRole: before?.role ?? undefined,
            action: 'USER_UPDATED', targetType: 'user', targetId: userId,
            beforeValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
            afterValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
            reason: 'LDAP attribute sync on login',
            signatureMeaning: roleChanged
              ? `User "${before?.username ?? userId}" role changed "${changed.role.from}" → "${changed.role.to}" by LDAP group mapping`
              : `User "${before?.username ?? userId}" attributes synced from LDAP`,
          });
        } catch (auditErr: any) {
          logger.error('[LDAP] Audit write failed for attribute sync:', auditErr?.message ?? auditErr);
        }
      }
    }
  },
};
