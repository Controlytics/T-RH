/**
 * PM Schedules — shared types used by the My Tasks page and the service
 * layer. Lifted out of `pm-schedule.service.ts` during the module split so
 * each helper file can import them without pulling in the whole service.
 */

export type DueFilterStatus = 'pending' | 'cleaned_in_window' | 'in_progress';
export type DueOverallStatus = 'pending' | 'in_progress' | 'complete' | 'overdue';

export interface DueFilterRow {
  filterId: string;
  filterName: string;
  status: DueFilterStatus;
  /** Current cleaning lifecycle stage (WASH_IN / WASH_OUT / … ) or null when idle. */
  currentStage: string | null;
  lastCycleCompletedAt: Date | null;
}

export interface DueDeviationContext {
  deviationId: string;
  deviationNumber: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED';
  overdueDays: number;
  acknowledged: boolean;
  acknowledgedByName: string | null;
}

export interface DueTaskRow {
  entryId: string;
  ahuId: string;
  ahuName: string;
  // Hierarchy context (AHU → Area → Block) for the My Tasks block/area filters.
  areaId: string | null;
  areaName: string | null;
  blockId: string | null;
  blockName: string | null;
  plannedDate: Date;
  toleranceDays: number;
  windowStart: Date;
  windowEnd: Date;
  totalFilters: number;
  cleanedCount: number;
  overallStatus: DueOverallStatus;
  filters: DueFilterRow[];
  // Read-only deviation context (null unless an overdue deviation exists).
  deviation?: DueDeviationContext | null;
}
