export const JOB_PRIORITY = {
  ATTRIBUTE_UPDATE: 3,       // Important — config changes
  TELEMETRY: 5,              // Normal — sensor data (bulk)
  DEVICE_EVENT: 7,           // Low — connection status
  BINARY_METADATA: 8,        // Lowest — file metadata
} as const;

export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY];
