/**
 * A minimal Active Directory stand-in, spoken over the real LDAP wire protocol.
 *
 * WHY THIS EXISTS. There is no directory to develop against on this machine, and
 * none can be run: the LDAP work is Windows-local, and Docker/WSL2 are
 * unavailable (BIOS virtualisation off), which rules out samba-ad-dc or an
 * OpenLDAP container. Mocking `ldapts` in unit tests proves our branching but
 * proves nothing about the protocol conversation — whether our filter is
 * well-formed, whether a two-bind flow actually works, whether `memberOf` comes
 * back shaped the way the parser expects. This server closes that gap: the
 * application talks to it through the unmodified `ldapts` client over a real
 * TCP socket.
 *
 * WHAT IT MODELS FAITHFULLY (the parts our code depends on):
 *   - two-phase authentication: service-account bind → search → bind AS the user
 *   - `sAMAccountName` lookup and AD's attribute names (displayName, mail, …)
 *   - `memberOf` as a multi-valued list of group DNs
 *   - **nested groups, and the distinction that matters**: a plain
 *     `(memberOf=<parent>)` matches only DIRECT members, while
 *     `(memberOf:1.2.840.113556.1.4.1941:=<parent>)` walks the chain. That is
 *     precisely the trap in the customer's layout — employees sit in role
 *     sub-groups, not in the parent — so the harness has to reproduce it or the
 *     filter we recommend goes untested.
 *
 * WHAT IT DOES NOT MODEL — do not read a pass here as cover for these:
 *   - TLS. It listens on plain `ldap://`, so `tlsRejectUnauthorized` is inert
 *     and the §3.5 fix stays unit-verified only.
 *   - AD's own password policy, account lockout, expiry, or disabled accounts.
 *   - Referrals, paging, ranged `memberOf` retrieval on very large groups.
 *   - The full RFC 4515 grammar. The evaluator below understands the filter
 *     shapes this product actually emits, not arbitrary ones.
 *
 * Run standalone (for browser testing against the real app):
 *   npx tsx src/test-support/fake-ad-server.ts
 */
import { createRequire } from 'module';

// ldapjs 3.x is CommonJS and has no usable ESM default-import interop under
// this repo's NodeNext resolution; createRequire is the least-bad bridge and is
// confined to this dev-only module.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ldap = require('ldapjs');

export const BASE_DN = 'DC=corp,DC=local';
export const EMPLOYEES_OU = `OU=Employees,${BASE_DN}`;
export const GROUPS_OU = `OU=Groups,${BASE_DN}`;

export const SERVICE_ACCOUNT_DN = `CN=svc-compliance,OU=Service Accounts,${BASE_DN}`;
export const SERVICE_ACCOUNT_PASSWORD = 'SvcP@ssw0rd';

export const PARENT_GROUP_DN = `CN=Compliance-Users,${GROUPS_OU}`;

export const GROUP_DNS = {
  admin: `CN=Compliance-Admin,${GROUPS_OU}`,
  supervisor: `CN=Compliance-Supervisor,${GROUPS_OU}`,
  operator: `CN=Compliance-Operator,${GROUPS_OU}`,
  qa: `CN=Compliance-QA,${GROUPS_OU}`,
  maintenance: `CN=Compliance-Maintenance,${GROUPS_OU}`,
  /** Exists in the directory but is NOT under the parent — the outsider's group. */
  everyone: `CN=Domain Users,${GROUPS_OU}`,
  /** Mapped, in one test, to a role the application does not have. */
  contractors: `CN=Compliance-Contractors,${GROUPS_OU}`,
} as const;

/**
 * Group → its parent group. This is what makes membership *transitive*: an
 * employee in Compliance-QA is, in AD's eyes, also in Compliance-Users — but
 * only to a query that asks for the chain.
 */
const GROUP_PARENTS: Record<string, string> = {
  [GROUP_DNS.admin]: PARENT_GROUP_DN,
  [GROUP_DNS.supervisor]: PARENT_GROUP_DN,
  [GROUP_DNS.operator]: PARENT_GROUP_DN,
  [GROUP_DNS.qa]: PARENT_GROUP_DN,
  [GROUP_DNS.maintenance]: PARENT_GROUP_DN,
  [GROUP_DNS.contractors]: PARENT_GROUP_DN,
  // Domain Users deliberately has NO parent — that is the outsider's whole story.
};

export interface FakeAdUser {
  sAMAccountName: string;
  password: string;
  displayName: string;
  mail: string;
  department: string;
  /** DIRECT group memberships, exactly as AD's `memberOf` reports them. */
  memberOf: string[];
}

export const AD_PASSWORD = 'ADp@ssw0rd1';

export const USERS: FakeAdUser[] = [
  { sAMAccountName: 'EMP1001', password: AD_PASSWORD, displayName: 'Ravi Kumar',
    mail: 'ravi.kumar@corp.local', department: 'Production', memberOf: [GROUP_DNS.admin] },
  { sAMAccountName: 'EMP1002', password: AD_PASSWORD, displayName: 'Priya Sharma',
    mail: 'priya.sharma@corp.local', department: 'Production', memberOf: [GROUP_DNS.supervisor] },
  { sAMAccountName: 'EMP1003', password: AD_PASSWORD, displayName: 'Arun Nair',
    mail: 'arun.nair@corp.local', department: 'Cleanroom', memberOf: [GROUP_DNS.operator] },
  { sAMAccountName: 'EMP1004', password: AD_PASSWORD, displayName: 'Meera Iyer',
    mail: 'meera.iyer@corp.local', department: 'Quality', memberOf: [GROUP_DNS.qa] },
  { sAMAccountName: 'EMP1005', password: AD_PASSWORD, displayName: 'Vikram Rao',
    mail: 'vikram.rao@corp.local', department: 'Engineering', memberOf: [GROUP_DNS.maintenance] },
  // In the directory, employed, authenticates fine — and must NOT get in.
  { sAMAccountName: 'EMP9999', password: AD_PASSWORD, displayName: 'Sunil Outsider',
    mail: 'sunil@corp.local', department: 'Sales', memberOf: [GROUP_DNS.everyone] },
  // Mapped (in one test) to a role the application does not have.
  { sAMAccountName: 'EMP1006', password: AD_PASSWORD, displayName: 'Deepa Contractor',
    mail: 'deepa@corp.local', department: 'External', memberOf: [GROUP_DNS.contractors] },
];

export function userDn(u: FakeAdUser): string {
  return `CN=${u.displayName},${EMPLOYEES_OU}`;
}

/** Every group the user belongs to, following the nesting chain (AD's IN_CHAIN). */
export function transitiveGroups(u: FakeAdUser): string[] {
  const out = new Set<string>();
  const walk = (dn: string) => {
    if (out.has(dn)) return;
    out.add(dn);
    const parent = GROUP_PARENTS[dn];
    if (parent) walk(parent);
  };
  u.memberOf.forEach(walk);
  return [...out];
}

const eqDn = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Evaluate the filter shapes this product emits.
 *
 * Deliberately hand-rolled rather than delegating to ldapjs's `filter.matches()`:
 * that helper has no notion of the IN_CHAIN matching rule, and treating an
 * extensible match as an ordinary equality would silently erase the direct-vs-
 * transitive distinction — the exact behaviour this harness exists to prove.
 */
export function evaluateFilter(filter: string, u: FakeAdUser): boolean {
  const f = filter.trim();

  const sam = /\(?\s*sAMAccountName\s*=\s*([^)\s]+)\s*\)?/i.exec(f);
  if (sam && !eqDn(sam[1], u.sAMAccountName)) return false;

  // Transitive: (memberOf:1.2.840.113556.1.4.1941:=<DN>)
  const chain = /memberOf:1\.2\.840\.113556\.1\.4\.1941:=([^)]+)\)/i.exec(f);
  if (chain) {
    const want = chain[1];
    if (!transitiveGroups(u).some((g) => eqDn(g, want))) return false;
  }

  // Direct only: (memberOf=<DN>) — no matching-rule OID.
  const direct = /\(memberOf=([^)]+)\)/i.exec(f);
  if (direct) {
    const want = direct[1];
    if (!u.memberOf.some((g) => eqDn(g, want))) return false;
  }

  return true;
}

export interface FakeAdServer {
  url: string;
  port: number;
  /** Binds attempted, in order — lets a test assert the two-phase flow happened. */
  bindLog: Array<{ dn: string; ok: boolean }>;
  searchLog: string[];
  close(): Promise<void>;
}

export async function startFakeAdServer(port = 1389): Promise<FakeAdServer> {
  const server = ldap.createServer();
  const bindLog: Array<{ dn: string; ok: boolean }> = [];
  const searchLog: string[] = [];

  server.bind(BASE_DN, (req: any, res: any, next: any) => {
    const dn = req.dn.toString();
    const password = req.credentials ?? '';

    if (eqDn(dn, SERVICE_ACCOUNT_DN)) {
      const ok = password === SERVICE_ACCOUNT_PASSWORD;
      bindLog.push({ dn, ok });
      if (!ok) return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    }

    const user = USERS.find((u) => eqDn(userDn(u), dn));
    const ok = !!user && password === user.password;
    bindLog.push({ dn, ok });
    // An empty password must never succeed: LDAP treats a bind with no
    // credentials as ANONYMOUS and returns success, which is a classic
    // authentication-bypass footgun. Our client never sends one, and this
    // rejects it regardless.
    if (!ok || password === '') return next(new ldap.InvalidCredentialsError());
    res.end();
    return next();
  });

  server.search(BASE_DN, (req: any, res: any, next: any) => {
    const filter = req.filter.toString();
    searchLog.push(filter);

    // Requested-attribute list, lower-cased. Empty means "everything".
    const requested: string[] = (req.attributes ?? []).map((a: string) => a.toLowerCase());

    for (const u of USERS) {
      if (!evaluateFilter(filter, u)) continue;

      const all: Record<string, unknown> = {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: u.sAMAccountName,
        displayName: u.displayName,
        mail: u.mail,
        department: u.department,
        // AD hands back a bare string for a single-valued memberOf and an array
        // for several. Reproduced deliberately — `authenticateUser` has an
        // Array.isArray branch for exactly this, and a harness that always sent
        // an array would never exercise it.
        memberOf: u.memberOf.length === 1 ? u.memberOf[0] : u.memberOf,
      };

      // Attribute-name matching must be CASE-INSENSITIVE (RFC 4512 §2.5:
      // attribute descriptions are case-insensitive; real AD honours that).
      // ldapjs lower-cases the entry's keys and then compares them to the
      // requested list case-SENSITIVELY, so a request for `sAMAccountName` —
      // AD's canonical spelling and this product's default — came back
      // present-but-empty, while `samaccountname` worked. `mail` and
      // `department` survived only because they are already lower-case.
      //
      // The cure is one line: `search_response.js` compares a LOWER-CASED entry
      // key against `res.attributes` verbatim, so lower-casing that list makes
      // the comparison case-insensitive — which is the conformant behaviour.
      // Entry keys keep AD's canonical spelling (`sAMAccountName`), which is
      // what `authenticateUser` indexes them by, and narrowing still works.
      res.attributes = (res.attributes ?? []).map((a: string) => a.toLowerCase());

      const attributes: Record<string, unknown> = {};
      if (requested.length === 0) {
        Object.assign(attributes, all);
      } else {
        for (const want of req.attributes as string[]) {
          const canonical = Object.keys(all).find((k) => k.toLowerCase() === want.toLowerCase());
          if (canonical) attributes[canonical] = all[canonical];
        }
      }

      res.send({ dn: userDn(u), attributes });
    }
    res.end();
    return next();
  });

  // Track live sockets so shutdown is deterministic.
  //
  // `server.close()` stops accepting but WAITS for existing connections to end,
  // and `ldapts` keeps its socket open after a failed bind (there is nothing to
  // unbind). Several tests deliberately fail binds, so those sockets outlive the
  // test and close() never calls back — which surfaced as "Hook timed out in
  // 10000ms" in afterAll, only during a full-suite run. Destroying them here
  // makes teardown bounded regardless of how a test left the client.
  const sockets = new Set<{ destroy(): void }>();
  server.server.on('connection', (socket: any) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `ldap://127.0.0.1:${port}`,
    port,
    bindLog,
    searchLog,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    }),
  };
}

// Standalone mode — for driving the real application in a browser.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('fake-ad-server.ts')) {
  const port = Number(process.env.FAKE_AD_PORT ?? 1389);
  startFakeAdServer(port).then((s) => {
    console.log(`Fake AD listening on ${s.url}`);
    console.log(`  Bind DN        : ${SERVICE_ACCOUNT_DN}`);
    console.log(`  Bind Password  : ${SERVICE_ACCOUNT_PASSWORD}`);
    console.log(`  Search Base    : ${EMPLOYEES_OU}`);
    console.log(`  Parent group   : ${PARENT_GROUP_DN}`);
    console.log(`  Every user's password: ${AD_PASSWORD}`);
    console.log('  Users:');
    for (const u of USERS) {
      console.log(`    ${u.sAMAccountName}  ${u.displayName.padEnd(18)} ${u.memberOf.join(', ')}`);
    }
  });
}
