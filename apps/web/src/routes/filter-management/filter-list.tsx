import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { FILTER_STATE_COLORS } from '@/lib/filter-constants';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { useCan } from '@/hooks/use-can';
import { ReauthDialog } from '@/components/reauth-dialog';
import { api } from '@/lib/api-client';
import { retireOrReplaceFilter } from '@/lib/filter-lifecycle-actions';
import { createReport } from '@/lib/pdf-report';
import { exportToExcel } from '@/lib/excel-export';
import { logReportExportOrWarn } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { ExportMenu } from '@/components/ExportMenu';
import { SendForReviewButton } from '@/components/SendForReviewButton';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { Pagination } from '@/components/ui/pagination';
import { themeGradientBr, themeButton } from '@/lib/theme-styles';

import { STATUS_LABELS, LIFECYCLE_STATE_OPTIONS } from './filter-list/constants';
import type { CreateDialogState, DiagramFilterState, HierarchyNode, StatusPanelFilter, EditFilterRef, FilterRef, FilterFieldOptions, LastCleaningDateState } from './filter-list/types';
import { encodeLastCleaningDate, decodeLastCleaningDate } from './filter-list/lib/lastCleaningDateState';
import { resolveBulkTargets } from '@/lib/resolve-bulk-targets';
import { HierarchyCanvas } from './filter-list/components/HierarchyCanvas';
import { StatusUpdatePanel } from './filter-list/dialogs/StatusUpdatePanel';
import { DeleteBlockDialog } from './filter-list/dialogs/DeleteBlockDialog';
import { RetireReplacePanel } from './filter-list/dialogs/RetireReplacePanel';
import { CreateHierarchyDialog } from './filter-list/dialogs/CreateHierarchyDialog';
import { RfidTagPanel } from './filter-list/dialogs/RfidTagPanel';
import { BulkStatusUpdatePanel } from './filter-list/dialogs/BulkStatusUpdatePanel';
import { BulkRetireReplacePanel } from './filter-list/dialogs/BulkRetireReplacePanel';
import { CreateFilterDialog } from './filter-list/dialogs/CreateFilterDialog';
import { HierarchyEditDialog } from './filter-list/dialogs/HierarchyEditDialog';
import { HierarchyDeleteDialog } from './filter-list/dialogs/HierarchyDeleteDialog';
import { EditFilterDialog } from './filter-list/dialogs/EditFilterDialog';
import { DeleteFilterDialog } from './filter-list/dialogs/DeleteFilterDialog';
import { BulkUploadDialog } from './filter-list/dialogs/BulkUploadDialog';
import { findMissingRequiredAttributes } from './filter-list/lib/validate-template-attributes';
import { apiUrl } from '@/lib/url-utils';

// A-01 T2.2: flatten the typed /api/hierarchy/tree (blocks → areas → ahus →
// filters, + direct-under-block ahus) into the legacy flat "instance" shape the
// page already consumes — each node carries `parentId` + `template.templateKind`
// so the existing tree-build / discrimination logic works unchanged. Filter
// nodes carry filterSet / currentLifecycleState / attributes (zipped server-side).
function flattenTypedTree(blocks: any[]): any[] {
  const out: any[] = [];
  const pushAhu = (ahu: any, parentId: string) => {
    out.push({ ...ahu, parentId, template: { templateKind: 'AHU' } });
    for (const f of ahu.filters ?? []) out.push({ ...f, parentId: ahu.id, template: { templateKind: 'FILTER' } });
  };
  for (const b of blocks ?? []) {
    out.push({ ...b, parentId: null, template: { templateKind: 'BLOCK' } });
    for (const a of b.areas ?? []) {
      out.push({ ...a, parentId: b.id, template: { templateKind: 'AREA' } });
      for (const ahu of a.ahus ?? []) pushAhu(ahu, a.id);
    }
    for (const ahu of b.ahus ?? []) pushAhu(ahu, b.id); // direct-under-block AHUs
  }
  return out;
}

export function FilterListPage() {
  const { formatDate, formatDateTime } = useDatetimeFormat();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const reauth = useReauth();
  const can = useCan();
  const canCreate = can('filters.hierarchy_create');
  const canBulkUpload = can('filters.bulk_upload');
  const canCreateFilter = can('filters.create');
  const canEditFilter = can('filters.edit');
  const canDeleteFilter = can('filters.delete');
  const canEditHierarchy = can('filters.hierarchy_edit');
  const canDeleteHierarchy = can('filters.hierarchy_delete');
  const canRetire = can('filters.retire');
  const canReplace = can('filters.replace');
  const canStatusUpdate = can('filters.status_update');
  const canRfid = can('filters.rfid_manage');
  const canExport = can('filters.export');
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [panelFilter, setPanelFilter] = useState<FilterRef | null>(null);
  const [panelAction, setPanelAction] = useState<'retire' | 'replace'>('retire');
  const [panelRemarks, setPanelRemarks] = useState('');
  const [panelSubmitting, setPanelSubmitting] = useState(false);

  // Lifecycle state update panel
  const [statusPanelFilter, setStatusPanelFilter] = useState<StatusPanelFilter | null>(null);
  const [statusPanelState, setStatusPanelState] = useState('');
  const [statusPanelRemarks, setStatusPanelRemarks] = useState('');
  const [statusPanelSubmitting, setStatusPanelSubmitting] = useState(false);

  // RFID tag panel
  const [rfidPanel, setRfidPanel] = useState<FilterRef | null>(null);
  const [rfidTagValue, setRfidTagValue] = useState('');
  const [rfidSubmitting, setRfidSubmitting] = useState(false);

  // Multi-select
  const [selectedFilterIds, setSelectedFilterIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'status' | 'retire' | 'replace' | null>(null);

  // Pagination
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0] ?? 10);
  // Filters-tab search box: matches filter name / area / AHU / type / size / set /
  // status / RFID tag within the selected block's list.
  const [search, setSearch] = useState('');

  // Bulk upload
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  // Hierarchy node edit/delete (areas, AHUs — reuses the same instance routes)
  const [hierarchyEditDialog, setHierarchyEditDialog] = useState<HierarchyNode | null>(null);
  const [hierarchyEditName, setHierarchyEditName] = useState('');
  const [hierarchyEditSubmitting, setHierarchyEditSubmitting] = useState(false);
  const [hierarchyEditError, setHierarchyEditError] = useState('');
  const [hierarchyDeleteDialog, setHierarchyDeleteDialog] = useState<HierarchyNode | null>(null);
  const [hierarchyDeleteSubmitting, setHierarchyDeleteSubmitting] = useState(false);
  // Edit filter dialog
  const [editFilterDialog, setEditFilterDialog] = useState<EditFilterRef | null>(null);
  const [editFilterName, setEditFilterName] = useState('');
  // '' = no set assigned. Tri-state so that opening the dialog on a set-less
  // filter and saving doesn't silently assign it Set A.
  const [editFilterSet, setEditFilterSet] = useState<'A' | 'B' | ''>('');
  const [editFilterSubmitting, setEditFilterSubmitting] = useState(false);
  const [editFilterError, setEditFilterError] = useState('');

  // ── Filter Field Options config (Task 7) ──
  // Runtime read of the field-option dropdown values. The admin-side write
  // endpoint /api/config/dynamic/filter-field-options is SUPER_ADMIN-gated
  // (filter-field-options.def.ts → requiredRole) and 401s for operators /
  // supervisors / admins. The runtime sibling at /api/filters/field-options
  // (ASSET_READ) returns the same { value: {...} } shape — mirrors the
  // /reasons + /api/config/dynamic/filter-cleaning-reasons dual-endpoint
  // pattern in apps/api/src/modules/filter-operations/events-routes.ts.
  const { data: filterFieldOptionsConfig } = useSWR('/api/filters/field-options');
  const fieldOptions: FilterFieldOptions = (() => {
    const v = filterFieldOptionsConfig?.value as Partial<FilterFieldOptions> | undefined;
    return {
      ahuType: Array.isArray(v?.ahuType) ? v!.ahuType : ['Process', 'Non Process'],
      filterType: Array.isArray(v?.filterType) ? v!.filterType : [],
      micronSize: Array.isArray(v?.micronSize) ? v!.micronSize : [],
      filterSize: Array.isArray(v?.filterSize) ? v!.filterSize : [],
    };
  })();

  // Create-filter state additions
  const [createFilterAhuType, setCreateFilterAhuType] = useState('');
  const [createFilterFilterType, setCreateFilterFilterType] = useState('');
  const [createFilterMicronSize, setCreateFilterMicronSize] = useState('');
  const [createFilterFilterSize, setCreateFilterFilterSize] = useState('');
  const [createFilterLastCleaning, setCreateFilterLastCleaning] = useState<LastCleaningDateState>({ date: '', na: false });

  // Edit-filter state additions
  const [editFilterAhuType, setEditFilterAhuType] = useState('');
  const [editFilterFilterType, setEditFilterFilterType] = useState('');
  const [editFilterMicronSize, setEditFilterMicronSize] = useState('');
  const [editFilterFilterSize, setEditFilterFilterSize] = useState('');
  const [editFilterLastCleaning, setEditFilterLastCleaning] = useState<LastCleaningDateState>({ date: '', na: false });
  // Delete filter dialog
  const [deleteFilterDialog, setDeleteFilterDialog] = useState<FilterRef | null>(null);
  const [deleteFilterSubmitting, setDeleteFilterSubmitting] = useState(false);
  // Single-filter create dialog
  const [createFilterOpen, setCreateFilterOpen] = useState(false);
  const [createFilterAhu, setCreateFilterAhu] = useState('');
  // Optional Area pre-filter for the AHU dropdown. Empty string = no filter
  // (current behavior — show every AHU in the block). Selecting an Area
  // narrows the AHU options to AHUs whose parent is that Area.
  const [createFilterArea, setCreateFilterArea] = useState('');
  const [createFilterName, setCreateFilterName] = useState('');
  const [createFilterSet, setCreateFilterSet] = useState<'A' | 'B'>('A');
  // Reserved stub for the future "select cleaning profile at filter-create"
  // UX. CreateFilterDialog does not yet expose a profile picker; the value
  // stays '' so the conditional spread below never fires. Do not delete —
  // re-wire when the dialog grows a filter-profile selector.
  const [createFilterProfile, setCreateFilterProfile] = useState('');
  const [createFilterSubmitting, setCreateFilterSubmitting] = useState(false);
  const [createFilterError, setCreateFilterError] = useState('');
  const [bulkUploadAhu, setBulkUploadAhu] = useState('');
  // Optional Area pre-filter for the AHU dropdown in the bulk upload dialog.
  // Empty = no filter (show all AHUs in block). Selecting an Area narrows
  // the AHU list to AHUs under that area. Mirrors createFilterArea exactly.
  const [bulkUploadArea, setBulkUploadArea] = useState('');
  // Dialog-level fallback Set for CSV rows that omit `filterSet` column.
  // CSV row value still wins when present.
  const [bulkUploadFile, setBulkUploadFile] = useState<File | null>(null);
  const [bulkUploadStep, setBulkUploadStep] = useState<'select' | 'preview' | 'uploading' | 'results'>('select');
  const [bulkUploadRows, setBulkUploadRows] = useState<any[]>([]);
  const [bulkUploadError, setBulkUploadError] = useState('');
  const [bulkUploadResults, setBulkUploadResults] = useState<any[]>([]);
  const [bulkUploadCreated, setBulkUploadCreated] = useState(0);
  const [bulkUploadFailed, setBulkUploadFailed] = useState(0);

  const [blockTab, setBlockTab] = useState<'view' | 'filters'>('view');
  // Diagram click filter: narrows filters tab to a specific node
  const [diagramFilter, setDiagramFilter] = useState<DiagramFilterState>(null);
  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null);
  const [createName, setCreateName] = useState('');
  const [createAttrs, setCreateAttrs] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  // Block deletion
  const [deleteBlockDialog, setDeleteBlockDialog] = useState<FilterRef | null>(null);
  const [deletingBlock, setDeletingBlock] = useState(false);

  const { data: templatesData } = useSWR('/api/assets/templates');
  const { data: instancesData, isLoading } = useSWR('/api/hierarchy/tree', { refreshInterval: 30000 });

  // Fetch all identifiers to show RFID tags on filters
  const { data: identifiersData } = useSWR('/api/assets/identifiers');

  const templates = (templatesData?.data ?? []) as any[];
  // Flattened typed hierarchy (A-01 T2.2) — replaces the legacy flat instance list.
  const instances = useMemo(() => flattenTypedTree((instancesData ?? []) as any[]), [instancesData]);

  // Resolve canonical templates by kind, NOT by name. This decouples the
  // page from human-editable template names — admins can rename "Block" to
  // "Building" without breaking page logic.
  //
  // `filterTemplateIds` (Set) is used for "is this instance a filter"
  // membership checks — handles multiple FILTER-kind templates.
  const blockTemplateId = templates.find((t: any) => t.templateKind === 'BLOCK')?.id;
  const ahuTemplateId = templates.find((t: any) => t.templateKind === 'AHU')?.id;
  const filterTemplateIds = new Set(
    templates.filter((t: any) => t.templateKind === 'FILTER').map((t: any) => t.id),
  );

  const blocks = useMemo(() =>
    instances.filter((i: any) => i.template?.templateKind === 'BLOCK'),
    [instances]
  );

  const instanceMap = useMemo(() => {
    const map = new Map<string, any>();
    instances.forEach((i: any) => map.set(i.id, i));
    return map;
  }, [instances]);

  const blockIds = useMemo(() => new Set(blocks.map((b: any) => b.id)), [blocks]);

  const allFilters = useMemo(() =>
    // Templates-loaded path: Set membership. First-paint fallback: the
    // instance carries its eager-loaded `template.templateKind` per
    // assets/instance.repository.ts:16,37,112 — so we can classify
    // instances before templates SWR resolves on initial load.
    instances.filter((i: any) =>
      (filterTemplateIds.has(i.templateId) || i.template?.templateKind === 'FILTER') &&
      i.isActive !== false && i.status !== 'Retired',
    ),
    [instances, filterTemplateIds]
  );

  // Map of assetId -> identifiers (for RFID tag display)
  const identifiersByAsset = useMemo(() => {
    const map = new Map<string, any[]>();
    const items = (identifiersData as any)?.data ?? (Array.isArray(identifiersData) ? identifiersData : []);
    for (const id of items) {
      if (!map.has(id.assetId)) map.set(id.assetId, []);
      map.get(id.assetId)!.push(id);
    }
    return map;
  }, [identifiersData]);

  const areaTemplateId = templates.find((t: any) => t.templateKind === 'AREA' && t.isActive)?.id;

  // Build tree data: block -> areas -> AHUs -> filters
  const treeData = useMemo(() => {
    return blocks.map((block: any) => {
      const blockChildren = instances.filter((i: any) => i.parentId === block.id && i.isActive !== false && i.status !== 'Retired');
      const areas = blockChildren.filter((i: any) => i.template?.templateKind === 'AREA');
      const directAhus = blockChildren.filter((i: any) => i.template?.templateKind === 'AHU');

      const areaNodes = areas.map((area: any) => {
        const areaChildren = instances.filter((i: any) => i.parentId === area.id && i.isActive !== false && i.status !== 'Retired');
        const ahus = areaChildren.filter((i: any) => i.template?.templateKind === 'AHU');
        return {
          ...area, type: 'area' as const,
          ahus: ahus.map((ahu: any) => ({
            ...ahu, type: 'ahu' as const,
            filters: instances.filter((f: any) => f.parentId === ahu.id && (filterTemplateIds.has(f.templateId) || f.template?.templateKind === 'FILTER') && f.isActive !== false && f.status !== 'Retired'),
          })),
        };
      });

      // AHUs directly under block (no area level)
      const directAhuNodes = directAhus.map((ahu: any) => ({
        ...ahu, type: 'ahu' as const,
        filters: instances.filter((f: any) => f.parentId === ahu.id && (filterTemplateIds.has(f.templateId) || f.template?.templateKind === 'FILTER') && f.isActive !== false && f.status !== 'Retired'),
      }));

      return { ...block, type: 'block' as const, areas: areaNodes, directAhus: directAhuNodes };
    });
  }, [blocks, instances, areaTemplateId, ahuTemplateId, filterTemplateIds]);

  const getTemplateIdForType = (type: string) => {
    if (type === 'block') return blockTemplateId;
    if (type === 'area') return areaTemplateId;
    if (type === 'ahu') return ahuTemplateId;
    return '';
  };

  const getTemplateSchema = (type: string): any[] => {
    const tid = getTemplateIdForType(type);
    const tpl = templates.find((t: any) => t.id === tid);
    return tpl?.attributeSchema ?? [];
  };

  const handleCreate = async () => {
    if (!createDialog || !createName.trim()) return;
    const templateId = getTemplateIdForType(createDialog.type);

    // Build attributes from form fields, convert types
    const schema = getTemplateSchema(createDialog.type);

    // Audit H5 (2026-05-04): Block/Area/AHU templates can declare required
    // attributeSchema fields (location, capacity, etc.). Surface a single
    // inline error before posting so the operator doesn't have to wait on a
    // 400 from the create endpoint. Backend (`validateAttributeValues` in
    // `apps/api/src/modules/assets/helpers/attribute-validator.ts`) is still
    // authoritative — this is a UX guard.
    const missingRequired = findMissingRequiredAttributes(createAttrs, schema);
    if (missingRequired.length > 0) {
      toast.error('Missing required field(s)', missingRequired.join(', '));
      return;
    }

    setCreating(true);
    const attributes: Record<string, any> = {};
    for (const field of schema) {
      const val = createAttrs[field.fieldName] ?? '';
      if (field.dataType === 'FLOAT' || field.dataType === 'NUMBER') {
        attributes[field.fieldName] = val ? Number(val) : undefined;
      } else {
        attributes[field.fieldName] = val || undefined;
      }
    }

    const body: any = { name: createName.trim(), templateId, status: 'Active', attributes };
    if (createDialog.parentId) body.parentId = createDialog.parentId;

    // Backend enforces reauth on POST /api/assets/instances with action keys
    // CREATE_ASSET / CREATE_FILTER (instance.routes.ts). Filter creation has
    // its own handler (handleCreateFilter) that already wraps in
    // reauth.execute('CREATE_FILTER', …); block/area/AHU were missing the
    // matching CREATE_ASSET wrap, so the popup never appeared and the server
    // would 401 with REAUTH_REQUIRED.
    await reauth.execute(
      'CREATE_ASSET',
      async (password?: string) => {
        if (password) await api.postWithReauth('/api/assets/instances', body, password);
        else await api.post('/api/assets/instances', body);
      },
      {
        onSuccess: () => {
          toast.success('Created', `${createDialog.type.toUpperCase()} "${createName.trim()}" created`);
          setCreateDialog(null); setCreateName(''); setCreateAttrs({});
          mutate('/api/hierarchy/tree');
          setCreating(false);
        },
        onError: (e: any) => {
          toast.error('Error', e?.message ?? 'Failed');
          setCreating(false);
        },
      },
    );
  };

  const handleDeleteBlock = async () => {
    if (!deleteBlockDialog || deletingBlock) return;
    setDeletingBlock(true);
    try {
      await reauth.execute('DELETE_ASSET', async (password?) => {
        if (password) await api.deleteWithReauth(`/api/assets/instances/${deleteBlockDialog.id}`, password);
        else await api.delete(`/api/assets/instances/${deleteBlockDialog.id}`);
      }, {
        onSuccess: () => {
          toast.success('Deleted', `Block "${deleteBlockDialog.name}" deleted`);
          setDeleteBlockDialog(null);
          if (selectedBlock === deleteBlockDialog.id) setSelectedBlock(null);
          mutate('/api/hierarchy/tree');
          setDeletingBlock(false);
        },
        onError: (err: unknown) => {
          toast.error('Error', (err as any)?.message ?? 'Failed to delete block');
          setDeletingBlock(false);
        },
      });
    } catch (e: any) {
      toast.error('Error', e?.message ?? 'Failed to delete block');
      setDeletingBlock(false);
    }
  };

  // Walk up parent chain to find Block, Area and AHU ancestors. Name labels
  // for AHU + Area surface in the Filters table (conditionally, based on the
  // hierarchy-diagram scope). Block name not needed at row level.
  const resolveAncestors = (filterId: string) => {
    let ahuId: string | null = null;
    let ahuName = '-';
    let areaId: string | null = null;
    let areaName: string | null = null;
    let blockId: string | null = null;
    let currentId = instanceMap.get(filterId)?.parentId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const entity = instanceMap.get(currentId);
      if (!entity) break;
      if (entity.template?.templateKind === 'AHU' && !ahuId) {
        ahuId = entity.id;
        ahuName = entity.name;
      }
      if (entity.template?.templateKind === 'AREA' && !areaId) {
        areaId = entity.id;
        areaName = entity.name;
      }
      if (blockIds.has(entity.id)) {
        blockId = entity.id;
        break;
      }
      currentId = entity.parentId;
    }
    return { ahuId, ahuName, areaId, areaName, blockId };
  };

  const enrichedFilters = useMemo(() => {
    return allFilters.map((f: any) => {
      const { ahuId, ahuName, areaId, areaName, blockId } = resolveAncestors(f.id);
      return {
        id: f.id, name: f.name, filterSet: f.filterSet,
        currentState: f.currentLifecycleState,
        status: f.status ?? 'Active',
        ahuId, ahuName, areaId, areaName, blockId,
        filterType: f.attributes?.filterType ?? '-',
        ahuType: f.attributes?.ahuType ?? '-',
        micronSize: f.attributes?.micronSize ?? '-',
        filterSize: f.attributes?.filterSize ?? '-',
        // Manual seed kept for the Edit dialog + the 'NA' fallback below.
        lastCleaningDate: f.attributes?.lastCleaningDate ?? null,
        // Server-derived effective last-cleaned (GREATEST of latest completed
        // cycle + manual seed) — the value actually shown in the column. This
        // is what fixes "cleaned on Tab but Last Cleaned didn't update on Web".
        lastCleanedAt: f.lastCleanedAt ?? null,
        _rawAttributes: f.attributes ?? {},
      };
    });
  }, [allFilters, instanceMap, ahuTemplateId, blockIds]);

  // Count filters per block
  const blockCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    enrichedFilters.forEach(f => {
      if (f.blockId) counts[f.blockId] = (counts[f.blockId] ?? 0) + 1;
    });
    return counts;
  }, [enrichedFilters]);

  // Filters for the selected block, further narrowed by diagram click
  const blockFilters = useMemo(() => {
    if (!selectedBlock) return [];
    let filtered = enrichedFilters.filter(f => f.blockId === selectedBlock);
    if (diagramFilter) {
      if (diagramFilter.type === 'area') filtered = filtered.filter(f => f.areaId === diagramFilter.id);
      else if (diagramFilter.type === 'ahu') filtered = filtered.filter(f => f.ahuId === diagramFilter.id);
      else if (diagramFilter.type === 'filter') filtered = filtered.filter(f => f.id === diagramFilter.id);
      // 'block' shows all — no extra filter
    }
    const q = search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(f => {
        const rfid = (identifiersByAsset.get(f.id) ?? [])
          .filter((i: any) => i.identifierType === 'RFID')
          .map((i: any) => i.identifierValue);
        return [
          f.name, f.areaName, f.ahuName, f.ahuType, f.filterType,
          f.micronSize, f.filterSize, f.filterSet,
          (f.currentState ?? '').replace(/_/g, ' '), f.status, ...rfid,
        ].some(v => String(v ?? '').toLowerCase().includes(q));
      });
    }
    return filtered;
  }, [enrichedFilters, selectedBlock, diagramFilter, search, identifiersByAsset]);

  const selectedBlockName = selectedBlock ? (instanceMap.get(selectedBlock)?.name ?? 'Block') : '';

  // Pagination computed (client-side slice). safePage clamps page when the
  // filtered list shrinks below the current page (e.g. after a filter change).
  const totalPages = Math.max(1, Math.ceil(blockFilters.length / perPage));
  const safePage = Math.min(page, totalPages);
  const paginatedFilters = useMemo(() => {
    const start = (safePage - 1) * perPage;
    return blockFilters.slice(start, start + perPage);
  }, [blockFilters, safePage, perPage]);

  const openStatusPanel = (filter: { id: string; name: string; currentState: string | null }) => {
    // closePanel is declared further below — both are arrow consts and only
    // invoked from event handlers, so the temporal dead zone never trips.
    closePanel(); // close retire panel if open
    setStatusPanelFilter(filter);
    // Start blank ("Select status…") so the operator must actively choose a
    // valid next stage. The panel constrains the options to the filter's
    // cleaning-profile sequence and blocks out-of-sequence (skip) moves.
    setStatusPanelState('');
    setStatusPanelRemarks('');
  };

  const closeStatusPanel = () => {
    setStatusPanelFilter(null);
    setStatusPanelRemarks('');
    setStatusPanelSubmitting(false);
  };

  const handleStatusSubmit = (extra?: { cleaningReasonKey?: string; cleaningJustification?: string }) => {
    if (!statusPanelFilter || !statusPanelRemarks.trim() || !statusPanelState) return;
    if (statusPanelState === (statusPanelFilter.currentState ?? '')) return;
    setStatusPanelSubmitting(true);

    // M2 (audit 2026-05-04): UPDATE_FILTER_LIFECYCLE replaces generic
    // UPDATE_ASSET so cleanroom lifecycle moves are distinguishable in the
    // audit trail from ordinary asset edits.
    reauth.execute(
      'UPDATE_FILTER_LIFECYCLE',
      async (password?: string) => {
        // P3: when the move starts/restarts a cycle the panel passes the chosen
        // cleaning reason (+ justification); the server requires it.
        const body = {
          lifecycleState: statusPanelState,
          remarks: statusPanelRemarks.trim(),
          ...(extra?.cleaningReasonKey ? { cleaningReasonKey: extra.cleaningReasonKey } : {}),
          ...(extra?.cleaningJustification ? { cleaningJustification: extra.cleaningJustification } : {}),
        };
        if (password) {
          await api.patchWithReauth(`/api/assets/instances/${statusPanelFilter.id}/lifecycle-state`, body, password);
        } else {
          await api.patch(`/api/assets/instances/${statusPanelFilter.id}/lifecycle-state`, body);
        }
      },
      {
        onSuccess: () => {
          const label = LIFECYCLE_STATE_OPTIONS.find(o => o.value === statusPanelState)?.label ?? statusPanelState;
          toast.success('Status Updated', `${statusPanelFilter.name} updated to ${label}`);
          closeStatusPanel();
          mutate('/api/hierarchy/tree');
          // A "Cleaning Cycle Completed" status can force-complete an active cycle
          // server-side — revalidate the cycles/events caches so the Cleaning
          // Cycles view doesn't keep showing the old "In Progress" row.
          mutate((key) => typeof key === 'string' && (key.startsWith('/api/filters/cycles') || key.startsWith('/api/filters/events')));
        },
        onError: (err: any) => {
          toast.error('Update Failed', err.message ?? 'Something went wrong');
          setStatusPanelSubmitting(false);
        },
      },
    );
  };

  const openPanel = (filter: { id: string; name: string }) => {
    closeStatusPanel(); // close status panel if open
    setPanelFilter(filter);
    setPanelAction('retire');
    setPanelRemarks('');
  };

  const closePanel = () => {
    setPanelFilter(null);
    setPanelRemarks('');
    setPanelSubmitting(false);
  };

  // RFID Tag handlers
  const openRfidPanel = (filter: { id: string; name: string }) => {
    closePanel(); closeStatusPanel();
    setRfidPanel(filter);
    setRfidTagValue('');
  };
  const closeRfidPanel = () => { setRfidPanel(null); setRfidTagValue(''); setRfidSubmitting(false); };

  const handleAssignRfid = async () => {
    if (!rfidPanel || !rfidTagValue.trim()) return;
    setRfidSubmitting(true);
    reauth.execute('CREATE_ASSET_IDENTIFIER', async (password?: string) => {
      const body = { assetId: rfidPanel.id, identifierType: 'RFID', identifierValue: rfidTagValue.trim(), isPrimary: true };
      if (password) await api.postWithReauth('/api/assets/identifiers', body, password);
      else await api.post('/api/assets/identifiers', body);
    }, {
      onSuccess: () => {
        toast.success('RFID Assigned', `Tag "${rfidTagValue.trim()}" assigned to ${rfidPanel!.name}`);
        setRfidTagValue(''); setRfidSubmitting(false);
        mutate('/api/assets/identifiers');
      },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed to assign tag'); setRfidSubmitting(false); },
    });
  };

  const handleUnassignRfid = async (identifierId: string) => {
    setRfidSubmitting(true);
    reauth.execute('DELETE_ASSET_IDENTIFIER', async (password?: string) => {
      if (password) await api.deleteWithReauth(`/api/assets/identifiers/${identifierId}`, password);
      else await api.delete(`/api/assets/identifiers/${identifierId}`);
    }, {
      onSuccess: () => {
        toast.success('RFID Removed', 'Tag unassigned from filter');
        setRfidSubmitting(false);
        mutate('/api/assets/identifiers');
      },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed to remove tag'); setRfidSubmitting(false); },
    });
  };

  const handlePanelSubmit = async () => {
    if (!panelFilter || !panelRemarks.trim()) return;
    setPanelSubmitting(true);
    const action = panelAction;
    await retireOrReplaceFilter(reauth, action, panelFilter.id, panelRemarks, {
      onSuccess: (result) => {
        if (action === 'replace' && result?.newFilterName) {
          toast.success('Filter Replaced', `New filter created: ${result.newFilterName}`);
        } else {
          toast.success('Filter Retired', `${panelFilter!.name} has been retired`);
        }
        closePanel();
        mutate('/api/hierarchy/tree');
      },
      onError: (err: any) => {
        toast.error('Action Failed', err?.message ?? 'Something went wrong');
        setPanelSubmitting(false);
      },
    });
  };

  // ── Multi-select helpers ──
  const toggleFilterSelect = (id: string) => {
    setSelectedFilterIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectableFilters = blockFilters.filter(f => f.currentState !== 'RETIRED');
  const allSelected = selectableFilters.length > 0 && selectableFilters.every(f => selectedFilterIds.has(f.id));

  // The filters a bulk action will actually touch: the selection Set narrowed to
  // what the operator can currently SEE (search / diagram / block). The Set
  // outlives those narrowings, so acting on it raw hit invisible filters. Every
  // bulk surface — action, dialog list, dialog count, toolbar count — reads this
  // one value so they can never disagree.
  const visibleSelectedFilters = useMemo(
    () => resolveBulkTargets(selectedFilterIds, blockFilters),
    [selectedFilterIds, blockFilters],
  );
  // Selected but currently filtered off-screen — surfaced in the bulk bar so the
  // operator knows they exist instead of silently losing them.
  const hiddenSelectedCount = selectedFilterIds.size - visibleSelectedFilters.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedFilterIds(new Set());
    } else {
      setSelectedFilterIds(new Set(selectableFilters.map(f => f.id)));
    }
  };

  const openBulkStatusPanel = () => {
    if (visibleSelectedFilters.length === 0) return;
    closePanel(); closeRfidPanel();
    setBulkAction('status');
    setStatusPanelState(LIFECYCLE_STATE_OPTIONS[0].value);
    setStatusPanelRemarks('');
  };

  const openBulkRetirePanel = (action: 'retire' | 'replace') => {
    if (visibleSelectedFilters.length === 0) return;
    closeStatusPanel(); closeRfidPanel();
    setBulkAction(action);
    setPanelAction(action);
    setPanelRemarks('');
  };

  const closeBulkPanel = () => {
    setBulkAction(null);
    setStatusPanelRemarks('');
    setPanelRemarks('');
    setStatusPanelSubmitting(false);
    setPanelSubmitting(false);
  };

  const handleBulkStatusSubmit = (extra?: { cleaningReasonKey?: string; cleaningJustification?: string }) => {
    if (!statusPanelState || !statusPanelRemarks.trim() || visibleSelectedFilters.length === 0) return;
    setStatusPanelSubmitting(true);
    // Only the filters currently visible — never ones hidden by the search box.
    const ids = visibleSelectedFilters.map(f => f.id);
    const nameById = new Map(blockFilters.map(f => [f.id, f.name] as const));
    let completed = 0;
    let failed = 0;
    // Per-filter failures so the operator sees WHICH filters were skipped and
    // WHY — e.g. the target stage isn't in that filter's cleaning profile
    // ("Invalid stage movement…"), enforced server-side per filter.
    let failures: { name: string; message: string }[] = [];

    // M2 (audit 2026-05-04): UPDATE_FILTER_LIFECYCLE replaces generic
    // UPDATE_ASSET. Mirrors the single-filter path above.
    reauth.execute(
      'UPDATE_FILTER_LIFECYCLE',
      async (password?: string) => {
        // Reset on each (re)run so the reauth retry doesn't double-count.
        completed = 0; failed = 0; failures = [];
        for (const id of ids) {
          try {
            // Forward the cleaning reason (+ justification) when moving into a
            // cleaning stage; the server requires it for filters whose move
            // starts a cycle and ignores it for the rest.
            const body = {
              lifecycleState: statusPanelState,
              remarks: statusPanelRemarks.trim(),
              ...(extra?.cleaningReasonKey ? { cleaningReasonKey: extra.cleaningReasonKey } : {}),
              ...(extra?.cleaningJustification ? { cleaningJustification: extra.cleaningJustification } : {}),
            };
            if (password) {
              await api.patchWithReauth(`/api/assets/instances/${id}/lifecycle-state`, body, password);
            } else {
              await api.patch(`/api/assets/instances/${id}/lifecycle-state`, body);
            }
            completed++;
          } catch (e: any) {
            // Reauth errors MUST escape the loop so reauth.execute opens the
            // password dialog instead of silently counting them as failures
            // (which made bulk update appear to do nothing). api-client throws
            // either {error} or {code} shapes — check both.
            if (e?.error === 'REAUTH_REQUIRED' || e?.code === 'REAUTH_REQUIRED' ||
                e?.error === 'REAUTH_FAILED' || e?.code === 'REAUTH_FAILED') throw e;
            failed++;
            failures.push({ name: nameById.get(id) ?? id, message: e?.message ?? 'Update failed' });
          }
        }
      },
      {
        onSuccess: () => {
          const label = LIFECYCLE_STATE_OPTIONS.find(o => o.value === statusPanelState)?.label ?? statusPanelState;
          // Group skipped filters by reason so the message reads e.g.
          // "Invalid stage movement… — SA/00, SA/01".
          const byReason = new Map<string, string[]>();
          for (const f of failures) { const a = byReason.get(f.message) ?? []; a.push(f.name); byReason.set(f.message, a); }
          const detail = [...byReason.entries()]
            .map(([msg, names]) => `• ${msg} — ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6} more` : ''}`)
            .join('\n');
          if (completed === 0 && failed > 0) {
            toast.error('Bulk Status Update — none updated', detail);
          } else if (failed > 0) {
            toast.error(`Bulk Status Update — ${completed} updated, ${failed} skipped`, detail);
          } else {
            toast.success('Bulk Status Update', `${completed} filter(s) updated to ${label}`);
          }
          closeBulkPanel();
          setSelectedFilterIds(new Set());
          mutate('/api/hierarchy/tree');
          mutate((key) => typeof key === 'string' && (key.startsWith('/api/filters/cycles') || key.startsWith('/api/filters/events')));
        },
        onError: (err: any) => {
          toast.error('Update Failed', err.message ?? 'Something went wrong');
          setStatusPanelSubmitting(false);
        },
      },
    );
  };

  const handleBulkRetireSubmit = async () => {
    if (!panelRemarks.trim() || visibleSelectedFilters.length === 0) return;
    setPanelSubmitting(true);
    // Retire/replace is irreversible, so it may only touch filters the operator
    // can actually see — the same list the confirm panel showed them.
    const ids = visibleSelectedFilters.map(f => f.id);
    let completed = 0;
    let failed = 0;
    const action = bulkAction === 'replace' ? 'replace' : 'retire';
    const reauthAction = action === 'retire' ? 'RETIRE_FILTER' : 'REPLACE_FILTER';
    let firstError: string | null = null;

    // Wrap the whole loop in ONE reauth.execute so the operator is prompted
    // for a password ONCE, not 50× when retiring/replacing 50 filters. The
    // same password is then forwarded to every per-filter POST. Mirrors the
    // pattern in handleBulkStatusSubmit at L519-547.
    await reauth.execute(
      reauthAction,
      async (password?: string) => {
        // Reset on each (re)run so the reauth retry doesn't double-count.
        completed = 0; failed = 0; firstError = null;
        for (const id of ids) {
          try {
            const body = { remarks: panelRemarks.trim() };
            if (password) {
              await api.postWithReauth(`/api/filters/${id}/${action}`, body, password);
            } else {
              await api.post(`/api/filters/${id}/${action}`, body);
            }
            completed++;
          } catch (e: any) {
            // Reauth errors MUST escape so the password dialog opens (see
            // handleBulkStatusSubmit) instead of being counted as failures.
            if (e?.error === 'REAUTH_REQUIRED' || e?.code === 'REAUTH_REQUIRED' ||
                e?.error === 'REAUTH_FAILED' || e?.code === 'REAUTH_FAILED') throw e;
            failed++;
            if (!firstError) firstError = e?.message ?? null;
          }
        }
      },
      {
        onSuccess: () => {
          if (completed === 0 && failed > 0) {
            toast.error(
              action === 'retire' ? 'Bulk Retirement Failed' : 'Bulk Replacement Failed',
              `${failed} filter(s) failed${firstError ? ` — ${firstError}` : ''}`,
            );
          } else {
            toast.success(
              action === 'retire' ? 'Bulk Retirement' : 'Bulk Replacement',
              `${completed} filter(s) ${action === 'retire' ? 'retired' : 'replaced'}${failed ? `, ${failed} failed${firstError ? ` — ${firstError}` : ''}` : ''}`,
            );
          }
          closeBulkPanel();
          setSelectedFilterIds(new Set());
          mutate('/api/hierarchy/tree');
        },
        onError: (err: any) => {
          toast.error('Bulk action failed', err?.message ?? 'Something went wrong');
          setPanelSubmitting(false);
        },
      },
    );
  };

  // ── Bulk upload helpers ──
  // AHUs available for bulk upload — scoped by current diagram filter
  const bulkUploadAhus = useMemo(() => {
    if (!selectedBlock) return [];
    const blockTree = treeData.find((b: any) => b.id === selectedBlock);
    if (!blockTree) return [];
    const allAhus: { id: string; name: string }[] = [];
    if (diagramFilter?.type === 'ahu') {
      // Single AHU context
      allAhus.push({ id: diagramFilter.id, name: diagramFilter.name });
    } else if (diagramFilter?.type === 'area') {
      // AHUs under this area
      const area = blockTree.areas.find((a: any) => a.id === diagramFilter.id);
      if (area) area.ahus.forEach((h: any) => allAhus.push({ id: h.id, name: h.name }));
    } else {
      // All AHUs in the block
      blockTree.areas.forEach((a: any) => a.ahus.forEach((h: any) => allAhus.push({ id: h.id, name: h.name })));
      blockTree.directAhus.forEach((h: any) => allAhus.push({ id: h.id, name: h.name }));
    }
    return allAhus;
  }, [selectedBlock, treeData, diagramFilter]);

  // Areas in the selected block, for the Create Filter dialog's optional
  // Area dropdown. Read-only derivation from treeData — does NOT modify
  // the hierarchy logic. Bulk Upload does NOT use this list; only the
  // single-create-filter flow does.
  const createFilterAreas = useMemo(() => {
    if (!selectedBlock) return [];
    const blockTree = treeData.find((b: any) => b.id === selectedBlock);
    if (!blockTree) return [];
    return blockTree.areas.map((a: any) => ({ id: a.id, name: a.name }));
  }, [selectedBlock, treeData]);

  // AHUs in the selected block, optionally narrowed by `createFilterArea`.
  // Separate list from `bulkUploadAhus` so the bulk-upload flow stays
  // unchanged. Selecting an Area filters to AHUs whose parent is that
  // Area; leaving Area empty shows every AHU in the block (matches the
  // pre-2026-05-22 single-create behavior exactly).
  const createFilterAhusVisible = useMemo(() => {
    if (!selectedBlock) return [];
    const blockTree = treeData.find((b: any) => b.id === selectedBlock);
    if (!blockTree) return [];
    const all: { id: string; name: string; areaId: string | null }[] = [];
    blockTree.areas.forEach((a: any) => a.ahus.forEach((h: any) => all.push({ id: h.id, name: h.name, areaId: a.id })));
    blockTree.directAhus.forEach((h: any) => all.push({ id: h.id, name: h.name, areaId: null }));
    const filtered = createFilterArea
      ? all.filter(a => a.areaId === createFilterArea)
      : all;
    return filtered.map(({ id, name }) => ({ id, name }));
  }, [selectedBlock, treeData, createFilterArea]);

  // Areas in the selected block — for the Bulk Upload dialog's optional
  // Area dropdown. Same shape as createFilterAreas; separate memo so it
  // stays scoped to the bulk-upload flow.
  const bulkUploadAreas = useMemo(() => {
    if (!selectedBlock) return [];
    const blockTree = treeData.find((b: any) => b.id === selectedBlock);
    if (!blockTree) return [];
    return blockTree.areas.map((a: any) => ({ id: a.id, name: a.name }));
  }, [selectedBlock, treeData]);

  // AHUs visible in the Bulk Upload dialog — filtered by the selected
  // bulkUploadArea (empty = show all AHUs from `bulkUploadAhus`, which
  // already respects diagramFilter scope). When an Area is picked, we
  // restrict to AHUs whose parent is that Area. Kept separate from
  // `bulkUploadAhus` so any other consumer of that list (the diagram
  // create-AHU flow, etc.) keeps seeing the unfiltered list.
  const bulkUploadAhusVisible = useMemo(() => {
    if (!bulkUploadArea) return bulkUploadAhus;
    if (!selectedBlock) return [];
    const blockTree = treeData.find((b: any) => b.id === selectedBlock);
    if (!blockTree) return [];
    const area = blockTree.areas.find((a: any) => a.id === bulkUploadArea);
    if (!area) return [];
    return area.ahus.map((h: any) => ({ id: h.id, name: h.name }));
  }, [bulkUploadArea, bulkUploadAhus, selectedBlock, treeData]);

  // ── Hierarchy edit/delete helpers ──
  const openHierarchyEdit = (node: { id: string; name: string; entityType: string }) => {
    setHierarchyEditDialog(node);
    setHierarchyEditName(node.name);
    setHierarchyEditError('');
  };

  const submitHierarchyEdit = async () => {
    if (!hierarchyEditDialog || !hierarchyEditName.trim()) {
      setHierarchyEditError('Name is required.');
      return;
    }
    setHierarchyEditSubmitting(true);
    setHierarchyEditError('');
    const id = hierarchyEditDialog.id;
    await reauth.execute('EDIT_HIERARCHY_NODE', async (password?: string) => {
      const body = { name: hierarchyEditName.trim() };
      if (password) await api.putWithReauth(`/api/assets/instances/${id}`, body, password);
      else await api.put(`/api/assets/instances/${id}`, body);
    }, {
      onSuccess: () => {
        toast.success('Updated', `"${hierarchyEditName}" saved`);
        setHierarchyEditDialog(null);
        mutate('/api/hierarchy/tree');
        setHierarchyEditSubmitting(false);
      },
      onError: (err: any) => {
        setHierarchyEditError(err?.message ?? 'Failed to update');
        setHierarchyEditSubmitting(false);
      },
    });
  };

  const submitHierarchyDelete = async () => {
    if (!hierarchyDeleteDialog) return;
    setHierarchyDeleteSubmitting(true);
    const { id, name, entityType } = hierarchyDeleteDialog;
    await reauth.execute('DELETE_HIERARCHY_NODE', async (password?: string) => {
      if (password) await api.deleteWithReauth(`/api/assets/instances/${id}`, password);
      else await api.delete(`/api/assets/instances/${id}`);
    }, {
      onSuccess: () => {
        toast.success('Deleted', `${entityType} "${name}" removed`);
        setHierarchyDeleteDialog(null);
        mutate('/api/hierarchy/tree');
        setHierarchyDeleteSubmitting(false);
      },
      onError: (err: any) => {
        toast.error('Delete failed', err?.message ?? 'Could not delete');
        setHierarchyDeleteSubmitting(false);
      },
    });
  };

  // ── Edit filter helpers ──
  const openEditFilter = (f: {
    id: string; name: string; filterSet?: string;
    ahuType?: string; filterType?: string; micronSize?: string; filterSize?: string; lastCleaningDate?: string | null;
  }) => {
    setEditFilterDialog(f);
    setEditFilterName(f.name);
    // The API sends the raw Prisma enum ('SET_A'/'SET_B'/null) — see
    // hierarchy.service.ts. This used to compare against 'B', which never
    // matched, so the toggle silently pre-selected Set A for EVERY filter and
    // the unconditional PUT below then rewrote Set B filters to Set A.
    setEditFilterSet(f.filterSet === 'SET_B' ? 'B' : f.filterSet === 'SET_A' ? 'A' : '');
    setEditFilterAhuType(f.ahuType && f.ahuType !== '-' ? f.ahuType : '');
    setEditFilterFilterType(f.filterType && f.filterType !== '-' ? f.filterType : '');
    setEditFilterMicronSize(f.micronSize && f.micronSize !== '-' ? f.micronSize : '');
    setEditFilterFilterSize(f.filterSize && f.filterSize !== '-' ? f.filterSize : '');
    setEditFilterLastCleaning(decodeLastCleaningDate(f.lastCleaningDate ?? null));
    setEditFilterError('');
  };

  const submitEditFilter = async () => {
    if (!editFilterDialog || !editFilterName.trim()) {
      setEditFilterError('Filter name is required.');
      return;
    }
    setEditFilterSubmitting(true);
    setEditFilterError('');
    const id = editFilterDialog.id;
    await reauth.execute('EDIT_FILTER', async (password?: string) => {
      // Typed-direct update (A-01 T2.3) — concrete fields only. No templateId /
      // generic attributes. filter.service.ts overlays onto the stored
      // attributes: an OMITTED field means "don't touch", so a cleared field
      // must be sent as an explicit '' to clear it (omitting it would silently
      // keep the old value).
      const body: any = {
        name: editFilterName.trim(),
        // filterSet is the exception — enum-only, no '' clear on the wire. Omit
        // when unset; filter.service.ts treats undefined as "don't touch", so a
        // set-less filter stays set-less instead of being assigned Set A.
        ...(editFilterSet && { filterSet: editFilterSet }),
        ahuType: editFilterAhuType || '',
        filterType: editFilterFilterType || '',
        micronSize: editFilterMicronSize || '',
        filterSize: editFilterFilterSize || '',
        // encode returns undefined for "no date and not NA" — i.e. cleared.
        lastCleaningDate: encodeLastCleaningDate(editFilterLastCleaning) ?? '',
      };
      if (password) await api.putWithReauth(`/api/hierarchy/filters/${id}`, body, password);
      else await api.put(`/api/hierarchy/filters/${id}`, body);
    }, {
      onSuccess: () => {
        toast.success('Filter Updated', `"${editFilterName}" saved`);
        setEditFilterDialog(null);
        mutate('/api/hierarchy/tree');
        setEditFilterSubmitting(false);
      },
      onError: (err: any) => {
        setEditFilterError(err?.message ?? 'Failed to update filter');
        setEditFilterSubmitting(false);
      },
      // Cancelling the password prompt is a deliberate choice, not a failure —
      // unwind quietly instead of painting a red "Failed to update filter".
      onCancel: () => setEditFilterSubmitting(false),
    });
  };

  // ── Delete filter helpers ──
  const submitDeleteFilter = async () => {
    if (!deleteFilterDialog) return;
    setDeleteFilterSubmitting(true);
    const { id, name } = deleteFilterDialog;
    await reauth.execute('DELETE_FILTER', async (password?: string) => {
      if (password) await api.deleteWithReauth(`/api/hierarchy/filters/${id}`, password);
      else await api.delete(`/api/hierarchy/filters/${id}`);
    }, {
      onSuccess: () => {
        toast.success('Filter Deleted', `"${name}" removed`);
        setDeleteFilterDialog(null);
        setSelectedFilterIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        mutate('/api/hierarchy/tree');
        setDeleteFilterSubmitting(false);
      },
      onError: (err: any) => {
        toast.error('Delete failed', err?.message ?? 'Could not delete filter');
        setDeleteFilterSubmitting(false);
      },
      // A cancelled password prompt is not a delete failure — no error toast.
      onCancel: () => setDeleteFilterSubmitting(false),
    });
  };

  // ── Single-filter create helpers ──
  const openCreateFilter = () => {
    setCreateFilterOpen(true);
    // Start with no Area filter so the AHU dropdown shows every AHU in the
    // block (same behavior as the pre-Area-dropdown flow). Operator may
    // optionally narrow by Area afterwards.
    setCreateFilterArea('');
    // Pre-select when there is exactly one AHU in scope; the dialog still
    // shows it as a normal <select> (operators may want to verify the choice
    // before submit, hence we do not lock the dropdown).
    setCreateFilterAhu(bulkUploadAhus.length === 1 ? bulkUploadAhus[0].id : '');
    setCreateFilterName('');
    setCreateFilterSet('A');
    setCreateFilterProfile('');
    setCreateFilterAhuType('');
    setCreateFilterFilterType('');
    setCreateFilterMicronSize('');
    setCreateFilterFilterSize('');
    setCreateFilterLastCleaning({ date: '', na: false });
    setCreateFilterError('');
  };

  const submitCreateFilter = async () => {
    if (!createFilterAhu || !createFilterName.trim()) {
      setCreateFilterError('Please choose an AHU and enter a filter name.');
      return;
    }
    setCreateFilterSubmitting(true);
    setCreateFilterError('');
    try {
      await reauth.execute('CREATE_FILTER', async (password?: string) => {
        // Typed create (A-01 Slice 1) — concrete fields only, no templateId,
        // no generic attributes. Field-option values (ahuType/filterType/
        // micronSize) are validated server-side against the live
        // filter-field-options config.
        const body: any = {
          name: createFilterName.trim(),
          ahuId: createFilterAhu,
          filterSet: createFilterSet,
          ...(createFilterAhuType && { ahuType: createFilterAhuType }),
          ...(createFilterFilterType && { filterType: createFilterFilterType }),
          ...(createFilterMicronSize && { micronSize: createFilterMicronSize }),
          ...(createFilterFilterSize && { filterSize: createFilterFilterSize }),
          ...(createFilterProfile && { filterProfileId: createFilterProfile }),
        };
        const lastEnc = encodeLastCleaningDate(createFilterLastCleaning);
        if (lastEnc !== undefined) body.lastCleaningDate = lastEnc;
        if (password) await api.postWithReauth('/api/hierarchy/filters', body, password);
        else await api.post('/api/hierarchy/filters', body);
      }, {
        onSuccess: () => {
          toast.success('Filter Created', `"${createFilterName}" added`);
          setCreateFilterOpen(false);
          mutate('/api/hierarchy/tree');
          setCreateFilterSubmitting(false);
        },
        onError: (err: any) => {
          setCreateFilterError(err?.message ?? 'Failed to create filter');
          setCreateFilterSubmitting(false);
        },
      });
    } catch (err: any) {
      setCreateFilterError(err?.message ?? 'Failed to create filter');
      setCreateFilterSubmitting(false);
    }
  };

  const openBulkUpload = () => {
    setBulkUploadOpen(true);
    setBulkUploadStep('select');
    // Reset the picker so a previous session's choice doesn't leak in.
    setBulkUploadArea('');
    setBulkUploadAhu(bulkUploadAhus.length === 1 ? bulkUploadAhus[0].id : '');
    setBulkUploadFile(null);
    setBulkUploadRows([]);
    setBulkUploadError('');
    setBulkUploadResults([]);
    setBulkUploadCreated(0);
    setBulkUploadFailed(0);
  };

  const closeBulkUpload = () => { setBulkUploadOpen(false); };

  const handleBulkUploadFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBulkUploadFile(f);
    setBulkUploadError('');
    setBulkUploadResults([]);
    if (!bulkUploadAhu) { setBulkUploadError('Select a Target AHU before uploading the file.'); return; }

    // Server-side dry-run: parse + validate the .xlsx against the live master
    // data and return parsed rows + per-cell row/column/value errors. Binary
    // .xlsx can't be parsed client-side, and this reuses the exact validation
    // the real upload runs.
    try {
      const formData = new FormData();
      formData.append('file', f);
      formData.append('ahuId', bulkUploadAhu);
      if (selectedBlock) formData.append('blockId', selectedBlock);
      const token = sessionStorage.getItem('access_token');
      const res = await fetch(apiUrl('/api/assets/instances/bulk-upload-filters/validate'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) { setBulkUploadError(data.message || `Could not read file (HTTP ${res.status})`); return; }
      const rows = data.rows || [];
      if (rows.length === 0) { setBulkUploadError(data.results?.[0]?.error || 'No data rows found in the file'); return; }
      setBulkUploadRows(rows);
      setBulkUploadResults(data.results || []);
      setBulkUploadStep('preview');
    } catch (err: any) {
      setBulkUploadError(err?.message || 'Failed to read the .xlsx file');
    }
  };

  const handleBulkUploadSubmit = async () => {
    if (!bulkUploadFile || !bulkUploadAhu) return;

    // Bulk upload is multipart/form-data, so we cannot use api.postWithReauth
    // (which JSON-stringifies the body). Keep raw fetch + attach the reauth
    // password to the x-reauth-password header — server-side enforceReauth
    // accepts header OR body._currentPassword (see lib/reauth-check.ts:60).
    // Wrap in reauth.execute('BULK_UPLOAD_FILTERS', ...) for the password
    // prompt. Submission errors are surfaced through the existing inline
    // results panel rather than the reauth dialog so the user sees per-row
    // feedback instead of a generic "failed".
    await reauth.execute(
      'BULK_UPLOAD_FILTERS',
      async (password?: string) => {
        // Enter the spinner only once the request is actually in flight, and
        // fall back to 'preview' on any throw. Setting it before
        // reauth.execute — or leaving it set when the callback re-throws
        // REAUTH_FAILED for a re-prompt — strands the dialog on the spinner
        // with no way back once the operator cancels the password prompt.
        setBulkUploadStep('uploading');
        try {
          const formData = new FormData();
          formData.append('file', bulkUploadFile);
          formData.append('ahuId', bulkUploadAhu);
          if (selectedBlock) formData.append('blockId', selectedBlock);
          const token = sessionStorage.getItem('access_token');
          const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
          if (password) headers['x-reauth-password'] = password;
          const res = await fetch(apiUrl('/api/assets/instances/bulk-upload-filters'), {
            method: 'POST',
            headers,
            body: formData,
          });
          const data = await res.json().catch(() => ({} as any));
          if (!res.ok) {
            // Surface REAUTH_REQUIRED / REAUTH_FAILED back to the reauth hook
            // so the dialog can re-prompt; everything else flows into the
            // results panel. Match the api-client convention (throws an err
            // object with .error code).
            if (data?.error === 'REAUTH_REQUIRED' || data?.error === 'REAUTH_FAILED') {
              throw data;
            }
            setBulkUploadResults([{ row: 0, name: '', status: 'error', error: data.message || 'Upload failed' }]);
            setBulkUploadFailed(1);
            setBulkUploadStep('results');
            return;
          }
          setBulkUploadResults(data.results || []);
          setBulkUploadCreated(data.created || 0);
          setBulkUploadFailed(data.failed || 0);
          setBulkUploadStep('results');
          if (data.created > 0) mutate('/api/hierarchy/tree');
        } catch (err) {
          // Reauth re-prompt: leave the operator on the preview behind the
          // password dialog. Transport errors fall through to onError, which
          // overrides this with the results panel.
          setBulkUploadStep('preview');
          throw err;
        }
      },
      {
        onError: (e: any) => {
          // Network error or other unexpected throw — present in the results
          // panel like the legacy fetch path did.
          setBulkUploadResults([{ row: 0, name: '', status: 'error', error: e?.message || 'Network error' }]);
          setBulkUploadFailed(1);
          setBulkUploadStep('results');
        },
      },
    );
  };

  const downloadBulkTemplate = async () => {
    // Fetch the server-generated .xlsx — it carries Excel data-validation
    // dropdowns whose values reflect the CURRENT master data. No hardcoding
    // and no stale client copy.
    try {
      const token = sessionStorage.getItem('access_token');
      const res = await fetch(apiUrl('/api/assets/instances/filter-upload-template.xlsx'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const msg = res.status === 401 ? 'Session expired — please log in again.' : `HTTP ${res.status}`;
        toast.error('Template download failed', msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'filter-upload-template.xlsx';
      a.style.display = 'none';
      // Anchor MUST be in the DOM for the download to fire in Firefox/some
      // browsers, and the blob URL must NOT be revoked synchronously after
      // click() — that cancels the download in real browsers (Playwright
      // captures it regardless, which hid this). Revoke on a delay.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err: any) {
      toast.error('Template download failed', err?.message ?? 'Network error');
    }
  };

  // Export the currently-listed filters (the full filtered set for the block,
  // respecting the active diagram scope — NOT just the visible page) to CSV.
  // Client-side generation; mirrors the column set of the on-screen grid.
  // Build export rows for the currently-listed filters (the full filtered set
  // for the block, not just the visible page) — shared by the PDF + Excel export.
  const buildFiltersExport = () => {
    const dash = (v: string | null | undefined) => (v && v !== '-' ? v : '');
    const headers = ['S.No', 'Area', 'AHU', 'AHU Type', 'Filter', 'Filter Type', 'Micron Size', 'Filter Dimensions', 'Set', 'Last Cleaned', 'Status', 'RFID'];
    const body = blockFilters.map((f, idx) => {
      const stateLabel = STATUS_LABELS[f.currentState ?? '']?.label ?? (f.currentState?.replace(/_/g, ' ') ?? 'To Be Cleaned');
      const rfid = (identifiersByAsset.get(f.id) ?? [])
        .filter((i: any) => i.identifierType === 'RFID')
        .map((i: any) => i.identifierValue)
        .join(' ');
      const setLabel = f.filterSet === 'SET_A' ? 'Set A' : f.filterSet === 'SET_B' ? 'Set B' : '';
      const lastClean = f.lastCleanedAt ? formatDate(f.lastCleanedAt) : 'NA';
      return [
        idx + 1, f.areaId ? dash(f.areaName) : '', dash(f.ahuName), dash(f.ahuType),
        f.name, dash(f.filterType), dash(f.micronSize), dash(f.filterSize),
        setLabel, lastClean, stateLabel, rfid,
      ] as (string | number)[];
    });
    const safeName = (selectedBlockName || 'filters').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'filters';
    return { headers, body, safeName };
  };

  const exportFiltersExcel = async () => {
    const { headers, body, safeName } = buildFiltersExport();
    if (body.length === 0) return;
    if (body.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(body.length)); return; }
    await logReportExportOrWarn({ reportType: 'Filters', format: 'Excel', recordCount: body.length }, toast.warning);
    exportToExcel({ filename: `${safeName}-filters`, sheetName: 'Filters', head: headers, rows: body });
  };

  const buildFiltersReport = async () => {
    const { headers, body, safeName } = buildFiltersExport();
    if (body.length === 0) return null;
    if (body.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(body.length)); return null; }
    const report = await createReport({ reportKey: 'filters',
      title: 'Filters',
      subtitle: `Block: ${selectedBlockName || 'All'}  |  Total: ${body.length} filter(s)`,
      orientation: 'landscape',
      formatDateTime,
      legend: [{ abbr: 'NA', meaning: 'Not Applicable' }],
    });
    report.addTable({
      head: headers,
      body: body.map((r) => r.map((c) => String(c))),
      columnStyles: { 0: { halign: 'center', cellWidth: 14 } },
    });
    return { report, safeName, count: body.length };
  };

  const exportFiltersPdf = async () => {
    const built = await buildFiltersReport();
    if (!built) return;
    await logReportExportOrWarn({ reportType: 'Filters', format: 'PDF', recordCount: built.count }, toast.warning);
    built.report.save(`${built.safeName}-filters.pdf`);
  };

  const buildFiltersSnapshot = async () => { const built = await buildFiltersReport(); return built ? built.report.getSnapshot() : null; };

  // Navigate from diagram node to filters tab
  const navigateFromDiagram = (type: 'block' | 'area' | 'ahu' | 'filter', id: string, name: string) => {
    setDiagramFilter({ type, id, name });
    setBlockTab('filters');
    setPage(1);
    setSelectedFilterIds(new Set());
  };

  // Diagram handler bundle for child node components
  const diagramPerms = { canCreate, canEditHierarchy, canDeleteHierarchy };
  const diagramHandlers = {
    onNavigate: navigateFromDiagram,
    onAddChild: setCreateDialog,
    onEditNode: openHierarchyEdit,
    onDeleteNode: setHierarchyDeleteDialog,
  };

  // Summary stats for header
  const totalAhus = useMemo(() => {
    return instances.filter((i: any) => i.template?.templateKind === 'AHU' && i.isActive !== false).length;
  }, [instances, ahuTemplateId]);

  return (
    // Full-bleed: cancel AppLayout's <main> padding (p-3 sm:p-4 lg:p-6) with
    // matching negative margins, then apply a slim gutter — so the Filters grid
    // uses the full content-area width instead of sitting in doubled padding.
    <div className="py-6 space-y-6 -mx-3 sm:-mx-4 lg:-mx-6 px-3 sm:px-4">

      {/* ── Page Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {selectedBlock && (
            <button onClick={() => { setSelectedBlock(null); setBlockTab('view'); setSelectedFilterIds(new Set()); setDiagramFilter(null); }}
              className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <div>
            <h1 className="text-xl font-bold text-slate-800">
              {selectedBlock ? selectedBlockName : 'Filter Management'}
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {selectedBlock
                ? `${blockFilters.length} filter(s) in this block`
                : `${enrichedFilters.length} filters across ${blocks.length} blocks`
              }
            </p>
          </div>
        </div>

        {/* Tab toggle when block is selected */}
        {selectedBlock && (
          <div className="flex items-center bg-slate-100 rounded-lg p-1">
            <button onClick={() => { setBlockTab('view'); setDiagramFilter(null); }}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold transition-all ${
                blockTab === 'view'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
              Structure
            </button>
            <button onClick={() => { setBlockTab('filters'); setDiagramFilter(null); setPage(1); }}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-semibold transition-all ${
                blockTab === 'filters'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filters
            </button>
          </div>
        )}
      </div>

      {/* ── Summary Stats (block list screen only) ── */}
      {!selectedBlock && !isLoading && blocks.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Blocks', value: blocks.length, color: 'text-[var(--theme-primary-dark)]', bg: 'bg-[var(--theme-primary-light)] border-[var(--theme-primary-light)]' },
            { label: 'Total AHUs', value: totalAhus, color: 'text-teal-700', bg: 'bg-teal-50 border-teal-100' },
            { label: 'Active Filters', value: enrichedFilters.length, color: 'text-blue-700', bg: 'bg-blue-50 border-blue-100' },
            { label: 'With RFID', value: enrichedFilters.filter(f => (identifiersByAsset.get(f.id) ?? []).some((i: any) => i.identifierType === 'RFID')).length, color: 'text-violet-700', bg: 'bg-violet-50 border-violet-100' },
          ].map(stat => (
            <div key={stat.label} className={`rounded-xl border px-4 py-3.5 ${stat.bg}`}>
              <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">{stat.label}</p>
              <p className={`text-2xl font-bold mt-0.5 ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Block Selection Grid ── */}
      {!selectedBlock && (
        <>
          {isLoading ? (
            <div className="bg-white border border-slate-200 rounded-xl p-20 text-center">
              <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
              <p className="text-sm text-slate-400">Loading blocks...</p>
            </div>
          ) : blocks.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-20 text-center">
              <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <p className="text-slate-600 font-medium mb-1">No blocks found</p>
              <p className="text-sm text-slate-400 mb-4">{canCreate ? 'Create your first block to get started.' : 'No blocks available.'}</p>
              {canCreate && (
                <button onClick={() => setCreateDialog({ type: 'block' })}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-white rounded-lg text-sm font-semibold hover:shadow-xl transition-all"
                  style={themeButton}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                  Create Block
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {/* New Block card */}
              {canCreate && <button
                onClick={() => setCreateDialog({ type: 'block' })}
                className="bg-white border-2 border-dashed border-slate-300 rounded-xl p-5 text-center hover:border-[var(--theme-primary)] hover:bg-[var(--theme-primary-light)] transition-all group flex flex-col items-center justify-center min-h-[140px]"
              >
                <div className="w-10 h-10 rounded-lg bg-slate-100 group-hover:bg-[var(--theme-primary-light)] flex items-center justify-center mb-2 transition-colors">
                  <svg className="w-5 h-5 text-slate-400 group-hover:text-[var(--theme-primary)] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </div>
                <span className="text-sm font-medium text-slate-500 group-hover:text-[var(--theme-primary-dark)] transition-colors">New Block</span>
              </button>}
              {blocks.map((block: any) => {
                const count = blockCounts[block.id] ?? 0;
                const blockTree = treeData.find((b: any) => b.id === block.id);
                const ahuCount = blockTree ? blockTree.areas.reduce((s: number, a: any) => s + a.ahus.length, 0) + blockTree.directAhus.length : 0;
                return (
                  <div
                    key={block.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setSelectedBlock(block.id); setBlockTab('view'); setSelectedFilterIds(new Set()); setPage(1); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedBlock(block.id); setBlockTab('view'); setSelectedFilterIds(new Set()); setPage(1); } }}
                    className="bg-white border border-slate-200 rounded-xl p-5 text-left hover:border-[var(--theme-primary)] hover:shadow-md transition-all group cursor-pointer focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  >
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow" style={themeGradientBr}>
                        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                        </svg>
                      </div>
                      <h3 className="text-sm font-semibold text-slate-800 truncate flex-1">{block.name}</h3>
                      {canEditHierarchy && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openHierarchyEdit({ id: block.id, name: block.name, entityType: 'BLOCK' }); }}
                          className="w-7 h-7 rounded-lg bg-slate-50 text-slate-400 hover:bg-blue-50 hover:text-blue-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                          title="Edit block name"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                      )}
                      {can('filters.hierarchy_delete') && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteBlockDialog({ id: block.id, name: block.name }); }}
                          className="w-7 h-7 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                          title="Delete block"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <p className="text-2xl font-bold text-slate-800">{count}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">Filters</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-slate-500">{ahuCount}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">AHUs</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── Selected Block Content ── */}
      {selectedBlock && (
        <>
          {/* ── Structure Tab ── */}
          {blockTab === 'view' && (() => {
            const block = treeData.find((b: any) => b.id === selectedBlock);
            if (!block) return null;
            const allBlockChildren: { id: string; name: string; type: 'area' | 'ahu'; ahus?: any[]; filters?: any[] }[] = [
              ...block.areas.map((a: any) => ({ ...a, type: 'area' as const })),
              ...block.directAhus.map((h: any) => ({ ...h, type: 'ahu' as const })),
            ];
            return (
              <HierarchyCanvas
                block={{ id: block.id, name: block.name }}
                children={allBlockChildren}
                identifiersByAsset={identifiersByAsset}
                perms={diagramPerms}
                handlers={diagramHandlers}
                onAddBlockChild={(next) => setCreateDialog(next)}
              />
            );
          })()}

          {/* ── Filters Tab ── */}
          {blockTab === 'filters' && (
          <>
          {/* Filters tab toolbar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Search box — filters the current block's list by name / area / AHU /
                  type / size / set / status / RFID. */}
              <div className="relative">
                <svg className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search filters…"
                  className="w-56 pl-9 pr-8 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]"
                />
                {search && (
                  <button onClick={() => { setSearch(''); setPage(1); }} title="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
              {/* Active diagram filter chip */}
              {diagramFilter && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">Showing:</span>
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border font-medium text-xs ${
                    diagramFilter.type === 'block' ? 'bg-[var(--theme-primary-light)] text-[var(--theme-primary-dark)] border-[var(--theme-primary)]'
                    : diagramFilter.type === 'area' ? 'bg-purple-50 text-purple-700 border-purple-200'
                    : diagramFilter.type === 'ahu' ? 'bg-teal-50 text-teal-700 border-teal-200'
                    : 'bg-slate-50 text-slate-700 border-slate-200'
                  }`}>
                    {diagramFilter.type.toUpperCase()}: {diagramFilter.name}
                    <button onClick={() => { setDiagramFilter(null); setPage(1); }} className="ml-0.5 hover:text-red-500 transition-colors" title="Show all">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </span>
                </div>
              )}
            </div>
            {/* Action group — Export · Create Filter · Bulk Upload kept adjacent */}
            <div className="flex items-center gap-2">
              {blockFilters.length > 0 && (
                <>
                  {canExport && <ExportMenu surface="filters" onExportPdf={exportFiltersPdf} onExportExcel={exportFiltersExcel}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all" />}
                  <SendForReviewButton buildSnapshot={buildFiltersSnapshot}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all" />
                </>
              )}
              {canCreateFilter && bulkUploadAhus.length > 0 && (
                <button onClick={openCreateFilter}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                  Create Filter
                </button>
              )}
              {canBulkUpload && (
                <button onClick={openBulkUpload}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-white rounded-lg text-xs font-semibold shadow-sm hover:shadow-md transition-all"
                  style={themeButton}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                  Bulk Upload
                </button>
              )}
            </div>
          </div>

          {/* Bulk action bar. The count is the VISIBLE selection — the only thing a
              bulk action touches. Any selected-but-hidden filters are called out
              explicitly rather than folded into the total, so the number here always
              matches the number in the confirm panel. Clear stays reachable while a
              hidden selection exists. */}
          {selectedFilterIds.size > 0 && (
            <div className="rounded-xl px-5 py-3 flex items-center justify-between" style={{ backgroundColor: 'var(--theme-primary-light)', border: '1px solid var(--theme-primary)' }}>
              <span className="text-sm font-medium" style={{ color: 'var(--theme-primary-dark)' }}>
                {visibleSelectedFilters.length} filter(s) selected
                {hiddenSelectedCount > 0 && (
                  <span className="font-normal text-slate-600"> — {hiddenSelectedCount} hidden by the current search and excluded</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                {canStatusUpdate && (
                  <button onClick={openBulkStatusPanel} disabled={visibleSelectedFilters.length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 13.5V3.75m0 9.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 3.75V16.5m12-3V3.75m0 9.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 3.75V16.5m-6-9V3.75m0 3.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 9.75V10.5" /></svg>
                    Update Status
                  </button>
                )}
                {canRetire && (
                  <button onClick={() => openBulkRetirePanel('retire')} disabled={visibleSelectedFilters.length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                    Retire
                  </button>
                )}
                {canReplace && (
                  <button onClick={() => openBulkRetirePanel('replace')} disabled={visibleSelectedFilters.length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 text-white text-xs font-semibold rounded-lg hover:bg-orange-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    Replace
                  </button>
                )}
                <button onClick={() => setSelectedFilterIds(new Set())}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-800 transition-colors">
                  Clear
                </button>
              </div>
            </div>
          )}

          {blockFilters.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-16 text-center">
              <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <p className="text-slate-600 font-medium mb-1">{search.trim() ? 'No filters match your search' : 'No filters in this block'}</p>
              <p className="text-sm text-slate-400">{search.trim() ? `No filter matches “${search.trim()}” in this block.` : 'Filters will appear here once assigned to AHUs in this block.'}</p>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
              {/* Bounded-height scroll box (Option 1): the table scrolls BOTH ways
                  INSIDE this box, so the horizontal scrollbar sits at the bottom of
                  the visible table area — reachable without scrolling the whole page
                  to the bottom. Header is sticky; drag-to-scroll + Shift-wheel also work. */}
              <div className="overflow-auto max-h-[calc(100vh-16rem)]">
                {(() => {
                  // Column visibility follows the hierarchy-diagram scope:
                  // - no scope / Block clicked  → show Area + AHU (broadest view, needs both ancestors)
                  // - Area clicked              → show AHU only (Area is implied by the chip)
                  // - AHU / Filter clicked      → hide both (we're already at AHU level or below)
                  const scope = diagramFilter?.type ?? null;
                  const showAreaColumn = scope === null || scope === 'block';
                  const showAhuColumn  = scope === null || scope === 'block' || scope === 'area';
                  return (
                <table className="w-full">
                  <thead className="sticky top-0 z-20">
                    <tr className="bg-slate-50 border-b border-slate-200 [&>th]:bg-slate-50 [&>th]:whitespace-nowrap [&>th]:text-[11px] [&>th]:font-semibold [&>th]:text-slate-500 [&>th]:uppercase [&>th]:tracking-wider">
                      <th className="w-10 px-2 py-2">
                        <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                          className="w-4 h-4 rounded border-slate-300 text-[var(--theme-primary)] focus:ring-[var(--theme-focus-ring)] cursor-pointer" />
                      </th>
                      <th className="w-12 text-center px-2 py-2.5">S.No</th>
                      {showAreaColumn && (
                        <th className="text-left px-2 py-2">Area</th>
                      )}
                      {showAhuColumn && (
                        <>
                          <th className="text-left px-2 py-2">AHU</th>
                          <th className="text-left px-2 py-2">AHU Type</th>
                        </>
                      )}
                      <th className="text-left px-2 py-2">Filter</th>
                      <th className="text-left px-2 py-2">Filter Type</th>
                      <th className="text-left px-2 py-2">Micron Size</th>
                      <th className="text-left px-2 py-2">Filter Dimensions</th>
                      <th className="text-left px-2 py-2">Set</th>
                      <th className="text-left px-2 py-2">Last Cleaned</th>
                      <th className="text-left px-2 py-2">Status</th>
                      <th className="text-left px-2 py-2">RFID</th>
                      <th className="text-right px-2 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedFilters.map((f, idx) => {
                      const stateInfo = STATUS_LABELS[f.currentState ?? ''] ?? { label: f.currentState?.replace(/_/g, ' ') ?? 'To Be Cleaned', color: 'bg-slate-100 text-slate-500 border-slate-300' };
                      const tags = (identifiersByAsset.get(f.id) ?? []).filter((i: any) => i.identifierType === 'RFID');
                      const isSelected = selectedFilterIds.has(f.id);
                      const isRetired = f.currentState === 'RETIRED';
                      return (
                        <tr key={f.id} className={`transition-colors [&>td]:whitespace-nowrap ${isSelected ? 'bg-[var(--theme-primary-light)]' : 'hover:bg-slate-50/50'}`}>
                          <td className="w-10 px-2 py-2">
                            {!isRetired ? (
                              <input type="checkbox" checked={isSelected} onChange={() => toggleFilterSelect(f.id)}
                                className="w-4 h-4 rounded border-slate-300 text-[var(--theme-primary)] focus:ring-[var(--theme-focus-ring)] cursor-pointer" />
                            ) : <div className="w-4 h-4" />}
                          </td>
                          <td className="w-12 text-center px-2 py-2.5 text-sm text-slate-400 font-medium">{(safePage - 1) * perPage + idx + 1}</td>
                          {showAreaColumn && (
                            <td className="px-2 py-2">
                              {f.areaId ? (
                                <span className="block truncate max-w-[110px] text-sm font-medium text-purple-700" title={f.areaName ?? undefined}>{f.areaName ?? '--'}</span>
                              ) : (
                                <span className="text-sm text-slate-400">--</span>
                              )}
                            </td>
                          )}
                          {showAhuColumn && (
                            <>
                              <td className="px-2 py-2">
                                {f.ahuId ? (
                                  <Link to={`/ahus/${f.ahuId}`} className="block truncate max-w-[110px] text-sm hover:opacity-80 font-medium text-theme-primary" title={f.ahuName}>{f.ahuName}</Link>
                                ) : (
                                  <span className="text-sm text-slate-400">--</span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-xs text-slate-500">{f.ahuType !== '-' ? f.ahuType : '--'}</td>
                            </>
                          )}
                          <td className="px-2 py-2">
                            <div className="flex items-start gap-2">
                              <div className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${FILTER_STATE_COLORS[f.currentState ?? ''] ?? 'bg-gray-400'}`} />
                              <span className="min-w-0 break-words text-sm font-medium text-slate-800" title={f.name}>{f.name}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-500">
                            {f.filterType !== '-'
                              ? <span className="block truncate max-w-[100px]" title={f.filterType}>{f.filterType}</span>
                              : '--'}
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-500">
                            {f.micronSize !== '-' ? <>{f.micronSize} <span className="text-slate-400">µm</span></> : '--'}
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-500">
                            {f.filterSize !== '-'
                              ? <span className="block truncate max-w-[110px]" title={f.filterSize}>{f.filterSize}</span>
                              : '--'}
                          </td>
                          <td className="px-2 py-2">
                            {f.filterSet ? (
                              <span className={`text-[11px] px-2 py-0.5 rounded-md font-medium ${f.filterSet === 'SET_A' ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700'}`}>
                                {f.filterSet === 'SET_A' ? 'Set A' : 'Set B'}
                              </span>
                            ) : <span className="text-sm text-slate-300">--</span>}
                          </td>
                          <td className="px-2 py-2 text-xs text-slate-500"
                              title={f.lastCleanedAt ? `Last cleaned: ${formatDateTime(f.lastCleanedAt)}` : undefined}>
                            {/* Server-derived effective date (covers Tab or Web
                                cleaning); hover shows exact time. No date (never
                                cleaned / NA) → show 'NA'. */}
                            {f.lastCleanedAt
                              ? formatDate(f.lastCleanedAt)
                              : <span className="text-slate-400 italic">NA</span>}
                          </td>
                          <td className="px-2 py-2">
                            <span className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${stateInfo.color}`}>{stateInfo.label}</span>
                          </td>
                          <td className="px-2 py-2">
                            {tags.length > 0 ? (
                              <span className="text-[11px] font-mono px-2 py-0.5 rounded-md" style={{ color: 'var(--theme-primary-dark)', backgroundColor: 'var(--theme-primary-light)', border: '1px solid var(--theme-primary)' }} title={tags[0].identifierValue}>{tags[0].identifierValue}</span>
                            ) : (
                              <span className="text-sm text-slate-300">--</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-end gap-0.5">
                              {!isRetired && (
                                <>
                                  {canEditFilter && (
                                    <button onClick={() => openEditFilter({ id: f.id, name: f.name, filterSet: f.filterSet, ahuType: f.ahuType, filterType: f.filterType, micronSize: f.micronSize, filterSize: f.filterSize, lastCleaningDate: f.lastCleaningDate })}
                                      className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors" title="Edit Filter">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                      </svg>
                                    </button>
                                  )}
                                  {canDeleteFilter && (
                                    <button onClick={() => setDeleteFilterDialog({ id: f.id, name: f.name })}
                                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="Delete Filter">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                      </svg>
                                    </button>
                                  )}
                                  {canStatusUpdate && (
                                    <button onClick={() => openStatusPanel({ id: f.id, name: f.name, currentState: f.currentState })}
                                      className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="Update Status">
                                      {/* Adjustments/sliders glyph — visually distinct from the Edit pencil */}
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 13.5V3.75m0 9.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 3.75V16.5m12-3V3.75m0 9.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 3.75V16.5m-6-9V3.75m0 3.75a1.5 1.5 0 010 3m0-3a1.5 1.5 0 000 3m0 9.75V10.5" />
                                      </svg>
                                    </button>
                                  )}
                                  {(canRetire || canReplace) && (
                                    <button onClick={() => openPanel({ id: f.id, name: f.name })}
                                      className="p-1.5 rounded-lg text-slate-400 hover:text-orange-600 hover:bg-orange-50 transition-colors" title="Retire / Replace">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0" />
                                      </svg>
                                    </button>
                                  )}
                                  {canRfid && (
                                    <button onClick={() => openRfidPanel({ id: f.id, name: f.name })}
                                      className="p-1.5 rounded-lg text-slate-400 hover:text-[var(--theme-primary)] hover:bg-[var(--theme-primary-light)] transition-colors" title="RFID Tag">
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
                                      </svg>
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                  );
                })()}
              </div>
              {/* Pagination */}
              <Pagination
                className="border-t border-slate-100 bg-slate-50/60"
                page={safePage}
                pageSize={perPage}
                totalItems={blockFilters.length}
                onPageChange={setPage}
                onPageSizeChange={setPerPage}
                pageSizeOptions={paginationOptions}
              />
            </div>
          )}
          </>
          )}
        </>
      )}

      {/* Update Status Side Panel */}
      {statusPanelFilter && (
        <StatusUpdatePanel
          filter={statusPanelFilter}
          state={statusPanelState}
          remarks={statusPanelRemarks}
          submitting={statusPanelSubmitting}
          onStateChange={setStatusPanelState}
          onRemarksChange={setStatusPanelRemarks}
          onClose={closeStatusPanel}
          onSubmit={handleStatusSubmit}
        />
      )}

      {/* Delete Block Confirmation Dialog */}
      {deleteBlockDialog && (
        <DeleteBlockDialog
          name={deleteBlockDialog.name}
          deleting={deletingBlock}
          onCancel={() => setDeleteBlockDialog(null)}
          onConfirm={handleDeleteBlock}
        />
      )}

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update Status"
      />

      {/* Retire / Replace Side Panel */}
      {panelFilter && (
        <RetireReplacePanel
          filter={panelFilter}
          action={panelAction}
          remarks={panelRemarks}
          submitting={panelSubmitting}
          onActionChange={setPanelAction}
          onRemarksChange={setPanelRemarks}
          onClose={closePanel}
          onSubmit={handlePanelSubmit}
        />
      )}

      {/* Create Block/Area/AHU Dialog */}
      {createDialog && (
        <CreateHierarchyDialog
          dialog={createDialog}
          name={createName}
          attrs={createAttrs}
          schema={getTemplateSchema(createDialog.type)}
          creating={creating}
          onNameChange={setCreateName}
          onAttrChange={setCreateAttrs}
          onCancel={() => { setCreateDialog(null); setCreateName(''); setCreateAttrs({}); }}
          onSubmit={handleCreate}
        />
      )}

      {/* RFID Tag Panel */}
      {rfidPanel && (
        <RfidTagPanel
          filter={rfidPanel}
          tags={identifiersByAsset.get(rfidPanel.id) ?? []}
          tagValue={rfidTagValue}
          submitting={rfidSubmitting}
          onTagValueChange={setRfidTagValue}
          onClose={closeRfidPanel}
          onAssign={handleAssignRfid}
          onUnassign={handleUnassignRfid}
        />
      )}

      {/* Bulk Status Update Panel */}
      {bulkAction === 'status' && (
        <BulkStatusUpdatePanel
          selectedCount={visibleSelectedFilters.length}
          selectedFilters={visibleSelectedFilters}
          state={statusPanelState}
          remarks={statusPanelRemarks}
          submitting={statusPanelSubmitting}
          onStateChange={setStatusPanelState}
          onRemarksChange={setStatusPanelRemarks}
          onClose={closeBulkPanel}
          onSubmit={handleBulkStatusSubmit}
        />
      )}

      {/* Bulk Retire / Replace Panel */}
      {(bulkAction === 'retire' || bulkAction === 'replace') && (
        <BulkRetireReplacePanel
          action={bulkAction}
          selectedCount={visibleSelectedFilters.length}
          selectedFilters={visibleSelectedFilters}
          remarks={panelRemarks}
          submitting={panelSubmitting}
          onRemarksChange={setPanelRemarks}
          onClose={closeBulkPanel}
          onSubmit={handleBulkRetireSubmit}
        />
      )}

      {/* Create Filter Dialog */}
      {createFilterOpen && (
        <CreateFilterDialog
          ahu={createFilterAhu}
          area={createFilterArea}
          name={createFilterName}
          filterSet={createFilterSet}
          ahus={createFilterAhusVisible}
          areas={createFilterAreas}
          error={createFilterError}
          submitting={createFilterSubmitting}
          fieldOptions={fieldOptions}
          ahuType={createFilterAhuType}
          filterType={createFilterFilterType}
          micronSize={createFilterMicronSize}
          filterSize={createFilterFilterSize}
          lastCleaning={createFilterLastCleaning}
          onAhuChange={setCreateFilterAhu}
          // When the operator changes the Area selector the previously-picked
          // AHU may no longer be in the visible list — clear it so they pick
          // a fresh AHU from the narrowed set.
          onAreaChange={(v) => { setCreateFilterArea(v); setCreateFilterAhu(''); }}
          onNameChange={setCreateFilterName}
          onFilterSetChange={setCreateFilterSet}
          onAhuTypeChange={setCreateFilterAhuType}
          onFilterTypeChange={setCreateFilterFilterType}
          onMicronSizeChange={setCreateFilterMicronSize}
          onFilterSizeChange={setCreateFilterFilterSize}
          onLastCleaningChange={setCreateFilterLastCleaning}
          onClose={() => setCreateFilterOpen(false)}
          onSubmit={submitCreateFilter}
        />
      )}

      {/* Hierarchy Edit Dialog */}
      {hierarchyEditDialog && (
        <HierarchyEditDialog
          node={hierarchyEditDialog}
          name={hierarchyEditName}
          error={hierarchyEditError}
          submitting={hierarchyEditSubmitting}
          onNameChange={setHierarchyEditName}
          onClose={() => setHierarchyEditDialog(null)}
          onSubmit={submitHierarchyEdit}
        />
      )}

      {/* Hierarchy Delete Dialog */}
      {hierarchyDeleteDialog && (
        <HierarchyDeleteDialog
          node={hierarchyDeleteDialog}
          submitting={hierarchyDeleteSubmitting}
          onClose={() => setHierarchyDeleteDialog(null)}
          onSubmit={submitHierarchyDelete}
        />
      )}

      {/* Edit Filter Dialog */}
      {editFilterDialog && (
        <EditFilterDialog
          name={editFilterName}
          filterSet={editFilterSet}
          error={editFilterError}
          submitting={editFilterSubmitting}
          fieldOptions={fieldOptions}
          ahuType={editFilterAhuType}
          filterType={editFilterFilterType}
          micronSize={editFilterMicronSize}
          filterSize={editFilterFilterSize}
          lastCleaning={editFilterLastCleaning}
          onNameChange={setEditFilterName}
          onFilterSetChange={setEditFilterSet}
          onAhuTypeChange={setEditFilterAhuType}
          onFilterTypeChange={setEditFilterFilterType}
          onMicronSizeChange={setEditFilterMicronSize}
          onFilterSizeChange={setEditFilterFilterSize}
          onLastCleaningChange={setEditFilterLastCleaning}
          onClose={() => setEditFilterDialog(null)}
          onSubmit={submitEditFilter}
        />
      )}

      {/* Delete Filter Confirmation */}
      {deleteFilterDialog && (
        <DeleteFilterDialog
          name={deleteFilterDialog.name}
          submitting={deleteFilterSubmitting}
          onClose={() => setDeleteFilterDialog(null)}
          onSubmit={submitDeleteFilter}
        />
      )}

      {/* Bulk Upload Dialog */}
      {bulkUploadOpen && (
        <BulkUploadDialog
          step={bulkUploadStep}
          ahu={bulkUploadAhu}
          area={bulkUploadArea}
          ahus={bulkUploadAhusVisible}
          areas={bulkUploadAreas}
          file={bulkUploadFile}
          rows={bulkUploadRows}
          error={bulkUploadError}
          results={bulkUploadResults}
          created={bulkUploadCreated}
          failed={bulkUploadFailed}
          fieldOptions={fieldOptions}
          diagramFilter={diagramFilter}
          selectedBlockName={selectedBlockName}
          onAhuChange={setBulkUploadAhu}
          // When Area changes, the previously-picked AHU may no longer be
          // in the narrowed list — clear it so operator picks fresh.
          onAreaChange={(v) => { setBulkUploadArea(v); setBulkUploadAhu(''); }}
          onFileSelect={handleBulkUploadFileSelect}
          onSubmit={handleBulkUploadSubmit}
          onClose={closeBulkUpload}
          onChangeFile={() => { setBulkUploadStep('select'); setBulkUploadFile(null); setBulkUploadRows([]); }}
          onDownloadTemplate={downloadBulkTemplate}
        />
      )}
    </div>
  );
}
