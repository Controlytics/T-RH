import { z } from 'zod';
import { ALWAYS_ON_REAUTH_ACTIONS } from '../types/reauth-actions.js';

// Config shape: { "DELETE_USER": ["ADMIN", "SUPERVISOR"], "RESTORE_BACKUP": ["ADMIN"] }
//
// Always-on actions are REJECTED as keys. They are enforced by
// `enforceReauthAlways`, which never reads this config, so an entry for one is
// inert — but "inert" is not "harmless". Both reauth editors render those
// actions as locked, so accepting the write meant the API persisted a policy
// the UI states cannot exist. An administrator reading the stored config back,
// or an inspector reading it during an audit, would see `ACKNOWLEDGE_ALARM: []`
// and reasonably conclude the 21 CFR §11.50 signature had been switched off for
// every role — when in fact it is always required.
//
// Rejecting here rather than only in the editors matters because both editors
// POST the WHOLE config seeded from GET: a pre-existing bad entry would
// otherwise be faithfully re-persisted on every unrelated save, and only a
// schema-level refusal breaks that cycle. The frontend guards become defence in
// depth rather than the sole barrier.
export const actionReauthConfigSchema = z.record(
  z.string().refine(
    (key) => !(ALWAYS_ON_REAUTH_ACTIONS as readonly string[]).includes(key),
    (key) => ({
      message: `"${key}" always requires an electronic signature and cannot be configured `
        + 'per role. Remove it from the request — the password challenge is intrinsic to '
        + 'the action and is enforced regardless of this configuration.',
    }),
  ),
  z.array(z.string()),
).default({});

export type ActionReauthConfig = z.infer<typeof actionReauthConfigSchema>;
