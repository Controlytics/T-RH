import { z } from 'zod';

export const ingestionMessageSchema = z.object({
  messageId: z.string(),
  entityId: z.string().uuid(),
  entityName: z.string().optional(),
  templateId: z.string().uuid().optional(),
  transport: z.enum(['MQTT', 'HTTP', 'WebSocket']),
  messageType: z.enum(['TELEMETRY', 'ATTRIBUTES', 'RPC', 'CHECKLIST', 'BINARY', 'EVENT']),
  unsPath: z.string(),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime().optional(),
  sourceIp: z.string().optional(),
  traceEnabled: z.boolean().default(false),
  credentialId: z.string().optional(),
});
export type IngestionMessage = z.infer<typeof ingestionMessageSchema>;

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

export const exportJobSchema = z.object({
  requestId: z.string(),
  userId: z.string(),
  entityId: z.string().uuid().optional(),
  exportType: z.enum(['telemetry', 'attributes', 'checklists', 'audit']),
  format: z.enum(['csv', 'json', 'pdf']),
  dateRange: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  filters: z.record(z.unknown()).optional(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const maintenanceJobSchema = z.object({
  task: z.enum(['dlq_check', 'connectivity_check', 'cleanup', 'retention']),
  params: z.record(z.unknown()).optional(),
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;
