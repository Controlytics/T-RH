import dns from 'node:dns';
import net, { type LookupFunction } from 'node:net';
import { blockedAddressReason } from '../../../../lib/outbound-guard.js';

/**
 * Where a rule chain's HTTP request may go (rule chains, ruling S-6, 2026-11-04).
 *
 * THE THREAT. A REST API call node's URL is typed by a RULE_CHAIN_MANAGE holder
 * and templated from message data. Pointed at `http://169.254.169.254/` it reads
 * the cloud instance metadata service (an IMDSv2 token by PUT, then the instance
 * role's credentials) — the server's cloud identity, which a chain author is not
 * meant to hold.
 *
 * WHAT IS REFUSED: link-local and unspecified addresses — 169.254.0.0/16,
 * 0.0.0.0/8, fe80::/10, `::` — and EC2's IPv6 metadata endpoint fd00:ec2::254,
 * also when spelled as an IPv4-mapped / -compatible / NAT64 IPv6 address.
 * WHAT IS ALLOWED (an accepted risk, S-6): loopback and the private ranges —
 * ThingsBoard allows them, and a plant's systems live on private networks.
 *
 * ONE RULE with the alarm webhooks and the SMS gateway: the address judgement
 * is `lib/outbound-guard.ts`'s `blockedAddressReason`, which ALSO refuses
 * loopback; this guard puts PLAIN loopback back (127.0.0.0/8 and `::1`).
 * Loopback spelled as a mapped / compatible / NAT64 address stays refused —
 * stricter than S-6, never looser. (Folding: give outbound-guard an
 * `allowLoopback` option; not this task's file.)
 *
 * WHEN. An IP literal is judged before any I/O. A NAME is resolved ONCE, by
 * `ruleTargetLookup` inside the connect: if ANY address it resolves to is
 * refused the connection is, and otherwise the socket gets exactly the addresses
 * that were judged — there is no second lookup a rebinding DNS answer could slip
 * into. Redirects are never followed (http.ts).
 */
export function targetNotAllowed(address: string): string | null {
  const a = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(a);
  if (family === 0) return null;
  if (blockedAddressReason(a) === null) return null;
  if (family === 4 && a.split('.')[0] === '127') return null;
  if (family === 6 && a.toLowerCase() === '::1') return null;
  return `TARGET_NOT_ALLOWED: ${a} is a link-local / unspecified address`;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The `lookup` the rule engine's requests connect with: one resolution, judged, handed to the socket as it is. */
export const ruleTargetLookup: LookupFunction = (hostname, options, callback) => {
  const cb = callback as unknown as LookupCallback;
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      const refused = targetNotAllowed(a.address);
      if (refused) return cb(Object.assign(new Error(refused), { code: 'TARGET_NOT_ALLOWED' }), []);
    }
    if (list.length === 0) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
    if ((options as { all?: boolean } | undefined)?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
};
