import { z } from 'zod';

// Config shape: { "DELETE_USER": ["ADMIN", "SUPERVISOR"], "RESTORE_BACKUP": ["ADMIN"] }
export const actionReauthConfigSchema = z.record(
  z.string(),
  z.array(z.string()),
).default({});

export type ActionReauthConfig = z.infer<typeof actionReauthConfigSchema>;
