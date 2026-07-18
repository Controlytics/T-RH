/**
 * Filter Management types — shared across filter-management frontend pages.
 */

export interface FilterInstance {
  id: string;
  name: string;
  description?: string | null;
  templateId: string;
  status: string;
  isActive: boolean;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterProfileId: string | null;
  filterSet: string | null;
  parentId?: string | null;
  attributes?: Record<string, any>;
  template?: { name: string };
}

export interface CleaningProfile {
  id: string;
  name: string;
  description?: string | null;
  flowMode: string;
  version: number;
  status: 'ACTIVE' | 'INACTIVE' | 'DRAFT' | 'ARCHIVED';
  stageCount: number;
  connectionCount: number;
  createdAt: string;
}

export interface CleaningCycle {
  id: string;
  cycleCode: string;
  filterId: string;
  filterName?: string;
  filterSet?: string;
  profileId: string;
  profileVersion: number;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED';
  sequenceNumber: number;
  startedAt: string;
  completedAt?: string | null;
  cleaningReasonKey: string;
  cleaningReasonLabel: string;
  cleaningJustification?: string | null;
  events?: FilterEvent[];
  // Version pins set at cycle start. Used by the Version History linkage on
  // the cycle history page to deep-link to the exact pinned version.
  equipmentGroupId?: string | null;
  equipmentGroupVersionPin?: number | null; // P1 (2026-05-02)
  checklistVersionPins?: Record<string, number>; // Phase A.1 — { [checklistProfileId]: versionNumber }
  // P2 (2026-06-03): ordered STAGE stateKeys this cycle's profile configures.
  // Cleaning Cycles renders "NA" for a column whose stage is not in this list.
  profileStages?: string[];
}

export interface FilterEvent {
  id: string;
  filterId: string;
  cycleId?: string | null;
  eventType: string;
  fromState?: string | null;
  toState?: string | null;
  performedBy: string;
  performedByName?: string;
  performedAt: string;
  attributes?: Record<string, any>;
  remarks?: string | null;
  deviationDetails?: Record<string, any> | null;
  checksum?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
