// Shared types used across the extracted filter-list dialogs/panels.
//
// The orchestrator owns all state — these types describe the small POJOs
// that get passed in and out of dialogs as `open` flags / submit payloads.

export type StatusPanelFilter = { id: string; name: string; currentState: string | null };
export type FilterRef = { id: string; name: string };
export type EditFilterRef = {
  id: string;
  name: string;
  filterSet?: string;
  ahuType?: string;
  filterType?: string;
  micronSize?: string;
  filterSize?: string;
  lastCleaningDate?: string | null;
};
export type HierarchyNode = { id: string; name: string; entityType: string };
export type CreateDialogState = { type: 'block' | 'area' | 'ahu'; parentId?: string; parentName?: string };
export type DiagramFilterState = { type: 'block' | 'area' | 'ahu' | 'filter'; id: string; name: string } | null;

export type AhuOption = { id: string; name: string };

export type TemplateField = {
  fieldName: string;
  dataType?: string;
  required?: boolean;
  dropdownOptions?: string[];
  unit?: string;
};

export type BulkUploadStep = 'select' | 'preview' | 'uploading' | 'results';

// Re-export the field-options shape for parent + dialog use.
export type { FilterFieldOptions } from './components/FilterFieldOptionsSection';
export type { LastCleaningDateState } from './lib/lastCleaningDateState';
