import type { PipelineTrace, StageResult } from './types';

// ---------------------------------------------------------------------------
// Stage name map (fallback for missing names in data)
// ---------------------------------------------------------------------------

// Stage indices 6 (Rule Chain Eval) + 8 (Alarm Check) removed 2026-05-17
// (rule-chain + alarm subsystems retired). Remaining stages renumbered
// when the ingestion pipeline trace was reorganised — debug trace rows
// emit `stageIndex` directly so missing keys just fall through to the
// raw index in the timeline rendering.
export const STAGE_NAMES: Record<number, string> = {
  1: 'Auth & Rate Limit',
  2: 'Schema Validation',
  3: 'Entity Resolution',
  4: 'Payload Normalisation',
  5: 'Attribute Merge',
  7: 'UNS Path Build',
  9: 'Telemetry Batch',
  10: 'DLQ Fallback',
  11: 'Audit Emit',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function getStatusBadgeClass(status: PipelineTrace['finalStatus']): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'SUCCESS_WITH_WARNINGS':
      return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'FAILED':
      return 'bg-red-100 text-red-700 border-red-200';
    case 'DLQ':
      return 'bg-yellow-100 text-yellow-700 border-yellow-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

export function getTransportBadgeClass(transport: string): string {
  switch (transport.toUpperCase()) {
    case 'MQTT':
      return 'bg-violet-100 text-violet-700 border-violet-200';
    case 'HTTP':
      return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'WEBSOCKET':
    case 'WS':
      return 'bg-cyan-100 text-cyan-700 border-cyan-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

export function getMessageTypeBadgeClass(type: string): string {
  switch (type.toUpperCase()) {
    case 'TELEMETRY':
      return 'bg-indigo-100 text-indigo-700 border-indigo-200';
    case 'ATTRIBUTES':
      return 'bg-teal-100 text-teal-700 border-teal-200';
    case 'RPC':
      return 'bg-pink-100 text-pink-700 border-pink-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-200';
  }
}

export function getStageBgClass(status: StageResult['status']): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-emerald-500';
    case 'FAILED':
      return 'bg-red-500';
    case 'SKIPPED':
      return 'bg-slate-300';
    default:
      return 'bg-slate-200';
  }
}

export function getStageTimelineClass(status: StageResult['status']): string {
  switch (status) {
    case 'SUCCESS':
      return 'border-emerald-300 bg-emerald-50';
    case 'FAILED':
      return 'border-red-300 bg-red-50';
    case 'SKIPPED':
      return 'border-slate-200 bg-slate-50';
    default:
      return 'border-slate-200 bg-white';
  }
}

export function getStageDotClass(status: StageResult['status']): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-emerald-500 border-emerald-300';
    case 'FAILED':
      return 'bg-red-500 border-red-300';
    case 'SKIPPED':
      return 'bg-slate-300 border-slate-200';
    default:
      return 'bg-slate-200 border-slate-200';
  }
}
