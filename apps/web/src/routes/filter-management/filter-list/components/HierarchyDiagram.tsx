import React from 'react';
import { STATUS_LABELS } from '../constants';
import type { CreateDialogState, DiagramFilterState, HierarchyNode } from '../types';

type DiagramType = NonNullable<DiagramFilterState>['type'];

type Perms = {
  canCreate: boolean;
  canEditHierarchy: boolean;
  canDeleteHierarchy: boolean;
};

type Handlers = {
  onNavigate: (type: DiagramType, id: string, name: string) => void;
  onAddChild: (next: CreateDialogState) => void;
  onEditNode: (node: HierarchyNode) => void;
  onDeleteNode: (node: HierarchyNode) => void;
};

type FilterDiagNodeProps = {
  filter: any;
  identifiersByAsset: Map<string, any[]>;
  onNavigate: Handlers['onNavigate'];
};

export function FilterDiagNode({ filter: f, identifiersByAsset, onNavigate }: FilterDiagNodeProps) {
  const rfidTags = (identifiersByAsset.get(f.id) ?? []).filter((i: any) => i.identifierType === 'RFID');
  const stateInfo = STATUS_LABELS[f.currentLifecycleState ?? ''] ?? { label: f.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned', color: 'bg-slate-100 text-slate-500 border-slate-300' };
  return (
    <div className="flex flex-col items-center">
      <button onClick={() => onNavigate('filter', f.id, f.name)}
        className="flex flex-col items-center px-3 py-2 rounded-xl border-2 border-slate-300 bg-white shadow-sm min-w-[100px] max-w-[130px] hover:border-[var(--theme-primary)] hover:bg-[var(--theme-primary-light)] hover:shadow-md cursor-pointer transition-all">
        <svg className="w-4 h-4 mb-0.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        <span className="text-[10px] font-bold text-center text-slate-700 truncate w-full">{f.name}</span>
        <span className={`text-[8px] mt-0.5 px-1.5 py-0.5 rounded-full border font-medium ${stateInfo.color}`}>{stateInfo.label}</span>
        {rfidTags.length > 0 && <span className="text-[7px] font-mono mt-0.5 truncate w-full text-center text-theme-primary">{rfidTags[0].identifierValue}</span>}
        {f.filterSet && <span className="text-[7px] text-slate-400 mt-0.5">{f.filterSet.replace('_', ' ')}</span>}
      </button>
    </div>
  );
}

/**
 * Connects a parent node to its children as an org-chart bus.
 *
 * Each child column is sized to its OWN content (`flex-shrink-0` + horizontal
 * padding for spacing) — never `flex-1` with a guessed `minWidth`. A deep/wide
 * subtree therefore widens its own column instead of overflowing and
 * overlapping its siblings (the old bug). The horizontal bus is drawn as
 * per-cell top-border segments trimmed to start/end at the first/last child's
 * centre, so it stays continuous without measuring widths.
 */
export function renderChildrenConnector(children: React.ReactNode[], _minWidth: number = 150) {
  if (children.length === 0) return null;
  return (
    <div className="flex flex-col items-center">
      <div className="w-px h-5 bg-slate-300" />
      <svg className="w-3 h-2 text-slate-400 -mt-px" viewBox="0 0 12 8">
        <path d="M0 0 L6 8 L12 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children.length === 1 ? (
        <div className="flex flex-col items-center">
          <div className="w-px h-3 bg-slate-300" />
          {children[0]}
        </div>
      ) : (
        <div className="flex items-start justify-center">
          {children.map((child, i) => {
            const isFirst = i === 0;
            const isLast = i === children.length - 1;
            const busPos = isFirst ? 'left-1/2 right-0' : isLast ? 'left-0 right-1/2' : 'left-0 right-0';
            return (
              <div key={i} className="relative flex flex-col items-center flex-shrink-0 px-3">
                {/* Horizontal bus segment (continuous across adjacent cells). */}
                <div className={`absolute top-0 h-px bg-slate-300 ${busPos}`} />
                {/* Vertical drop into this child. */}
                <div className="w-px h-4 bg-slate-300" />
                <svg className="w-3 h-2 text-slate-400 -mt-px" viewBox="0 0 12 8">
                  <path d="M0 0 L6 8 L12 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div className="h-1" />
                {child}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type AhuDiagNodeProps = {
  ahu: any;
  identifiersByAsset: Map<string, any[]>;
  perms: Perms;
  handlers: Handlers;
};

export function AhuDiagNode({ ahu, identifiersByAsset, perms, handlers }: AhuDiagNodeProps) {
  const filterNodes = (ahu.filters ?? []).map((f: any) => (
    <FilterDiagNode key={f.id} filter={f} identifiersByAsset={identifiersByAsset} onNavigate={handlers.onNavigate} />
  ));
  return (
    <div className="flex flex-col items-center group/ahu">
      <div className="relative">
        <button onClick={() => handlers.onNavigate('ahu', ahu.id, ahu.name)}
          className="flex flex-col items-center px-4 py-2.5 rounded-xl border-2 border-teal-500 bg-teal-50 shadow-sm min-w-[110px] max-w-[150px] hover:bg-teal-100 hover:shadow-md cursor-pointer transition-all">
          <svg className="w-5 h-5 mb-0.5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="text-xs font-bold text-center text-teal-800 truncate w-full">{ahu.name}</span>
          <span className="text-[9px] mt-0.5 text-teal-500">AHU</span>
        </button>
        <div className="absolute -top-2 -right-2 flex gap-1 opacity-0 group-hover/ahu:opacity-100 transition-opacity">
          {perms.canEditHierarchy && (
            <button onClick={(e) => { e.stopPropagation(); handlers.onEditNode({ id: ahu.id, name: ahu.name, entityType: 'AHU' }); }}
              className="w-6 h-6 rounded-full bg-white border border-amber-300 text-amber-600 hover:bg-amber-50 shadow-sm flex items-center justify-center" title="Edit AHU">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
          )}
          {perms.canDeleteHierarchy && (
            <button onClick={(e) => { e.stopPropagation(); handlers.onDeleteNode({ id: ahu.id, name: ahu.name, entityType: 'AHU' }); }}
              className="w-6 h-6 rounded-full bg-white border border-red-300 text-red-600 hover:bg-red-50 shadow-sm flex items-center justify-center" title="Delete AHU">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          )}
        </div>
      </div>
      {filterNodes.length > 0 && renderChildrenConnector(filterNodes, 130)}
    </div>
  );
}

type AreaDiagNodeProps = {
  area: any;
  identifiersByAsset: Map<string, any[]>;
  perms: Perms;
  handlers: Handlers;
};

export function AreaDiagNode({ area, identifiersByAsset, perms, handlers }: AreaDiagNodeProps) {
  const ahuNodes = (area.ahus ?? []).map((ahu: any) => (
    <AhuDiagNode key={ahu.id} ahu={ahu} identifiersByAsset={identifiersByAsset} perms={perms} handlers={handlers} />
  ));
  return (
    <div className="flex flex-col items-center group/area">
      <div className="relative">
        <button onClick={() => handlers.onNavigate('area', area.id, area.name)}
          className="flex flex-col items-center px-4 py-2.5 rounded-xl border-2 border-purple-500 bg-purple-50 shadow-sm min-w-[110px] max-w-[150px] hover:bg-purple-100 hover:shadow-md cursor-pointer transition-all">
          <svg className="w-5 h-5 mb-0.5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
          </svg>
          <span className="text-xs font-bold text-center text-purple-800 truncate w-full">{area.name}</span>
          <span className="text-[9px] mt-0.5 text-purple-500">Area</span>
        </button>
        {/* Hover: Add AHU / Edit / Delete */}
        <div className="absolute -top-2 -right-2 flex gap-0.5 opacity-0 group-hover/area:opacity-100 transition-opacity z-10">
          {perms.canCreate && (
            <button
              className="w-6 h-6 rounded-full bg-teal-500 text-white flex items-center justify-center shadow-sm hover:bg-teal-600 transition-colors"
              title="Add AHU"
              onClick={(e) => { e.stopPropagation(); handlers.onAddChild({ type: 'ahu', parentId: area.id, parentName: area.name }); }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
            </button>
          )}
          {perms.canEditHierarchy && (
            <button
              className="w-6 h-6 rounded-full bg-white border border-amber-300 text-amber-600 hover:bg-amber-50 shadow-sm flex items-center justify-center"
              title="Edit Area"
              onClick={(e) => { e.stopPropagation(); handlers.onEditNode({ id: area.id, name: area.name, entityType: 'Area' }); }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
          )}
          {perms.canDeleteHierarchy && (
            <button
              className="w-6 h-6 rounded-full bg-white border border-red-300 text-red-600 hover:bg-red-50 shadow-sm flex items-center justify-center"
              title="Delete Area"
              onClick={(e) => { e.stopPropagation(); handlers.onDeleteNode({ id: area.id, name: area.name, entityType: 'Area' }); }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          )}
        </div>
      </div>
      {ahuNodes.length > 0 && renderChildrenConnector(ahuNodes, 160)}
    </div>
  );
}
