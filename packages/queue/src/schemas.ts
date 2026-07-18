import { z } from 'zod';

export const notificationJobSchema = z.object({
  type: z.string(),
  entityId: z.string().uuid().optional(),
  checklistId: z.string().optional(),
  targetUserId: z.string().optional(),
  targetRole: z.string().optional(),
  title: z.string(),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type NotificationJob = z.infer<typeof notificationJobSchema>;
