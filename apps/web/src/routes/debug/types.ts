// ---------------------------------------------------------------------------
// Pipeline Debug Trace shared types
// ---------------------------------------------------------------------------

export interface StageResult {
  stage: number;
  name: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  warnings?: string[];
  details?: Record<string, unknown>;
}

export interface PipelineTrace {
  id: string;
  time: string;
  messageId: string;
  entityId?: string;
  entityName?: string;
  transport: string;
  messageType: string;
  payloadSize?: number;
  stages: StageResult[];
  finalStatus: 'SUCCESS' | 'SUCCESS_WITH_WARNINGS' | 'FAILED' | 'DLQ';
  failedStage?: string;
  errorCode?: string;
  errorMessage?: string;
  warnings?: string[];
  totalDurationMs: number;
}

export interface PaginatedTracesResponse {
  data: PipelineTrace[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface TraceStats {
  successRate1h: number;
  successRate24h: number;
  avgDurationMs: number;
  topErrors: Array<{ code: string; count: number }>;
  byTransport: Record<string, { total: number; failed: number }>;
}
