import React, { useRef, useState, useCallback, useEffect } from 'react';
import { AreaDiagNode, AhuDiagNode, renderChildrenConnector } from './HierarchyDiagram';
import type { CreateDialogState, HierarchyNode } from '../types';

type DiagramType = 'block' | 'area' | 'ahu' | 'filter';

type Perms = { canCreate: boolean; canEditHierarchy: boolean; canDeleteHierarchy: boolean };
type Handlers = {
  onNavigate: (type: DiagramType, id: string, name: string) => void;
  onAddChild: (next: CreateDialogState) => void;
  onEditNode: (node: HierarchyNode) => void;
  onDeleteNode: (node: HierarchyNode) => void;
};

type BlockChild =
  | { id: string; name: string; type: 'area'; ahus?: any[] }
  | { id: string; name: string; type: 'ahu'; filters?: any[] };

export type HierarchyCanvasProps = {
  block: { id: string; name: string };
  children: BlockChild[];
  identifiersByAsset: Map<string, any[]>;
  perms: Perms;
  handlers: Handlers;
  onAddBlockChild: (next: CreateDialogState) => void;
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;
const DRAG_THRESHOLD_PX = 4; // ignore micro-movements so button clicks still fire

export function HierarchyCanvas({
  block,
  children: blockChildren,
  identifiersByAsset,
  perms,
  handlers,
  onAddBlockChild,
}: HierarchyCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; scrollX: number; scrollY: number; activated: boolean } | null>(null);

  // Sync state with the browser's fullscreen status so the toolbar icon flips
  // when the user presses ESC (which fires fullscreenchange without going
  // through our toggle handler).
  useEffect(() => {
    const onChange = () => {
      const fsEl = document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
      setIsFullscreen(fsEl === wrapperRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = wrapperRef.current as (HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    }) | null;
    if (!el) return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const currentFsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    try {
      if (currentFsEl) {
        await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } else {
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      }
    } catch {
      // Fullscreen API can reject (iframe sandbox, permission policy, etc.).
      // Fall back to CSS-based "fixed inset-0" fullscreen so the user still
      // gets a maximised view, just inside the browser viewport.
      setIsFullscreen(prev => !prev);
    }
  }, []);

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Skip if user clicked an interactive control — let the click pass through.
    if ((e.target as HTMLElement).closest('button, a, [role="button"]')) return;
    if (!scrollRef.current) return;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollX: scrollRef.current.scrollLeft,
      scrollY: scrollRef.current.scrollTop,
      activated: false,
    };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState.current || !scrollRef.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (!dragState.current.activated) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      dragState.current.activated = true;
      setIsPanning(true);
    }
    scrollRef.current.scrollLeft = dragState.current.scrollX - dx;
    scrollRef.current.scrollTop = dragState.current.scrollY - dy;
  }, []);

  const endPan = useCallback(() => {
    dragState.current = null;
    setIsPanning(false);
  }, []);

  const centerScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, []);

  // Wrapper layout:
  // - Normal flow: fills the remaining viewport below the page chrome.
  // - When promoted via the browser's Fullscreen API, the element itself
  //   becomes the root render and is sized to the physical display by the
  //   browser. We force flex/full-size via the `fullscreen:*` Tailwind
  //   variants so the inner flex layout still works.
  // - CSS fallback (`isFullscreen` state when Fullscreen API rejected):
  //   we apply `fixed inset-0` ourselves.
  const fallbackFixed = isFullscreen && !(typeof document !== 'undefined' && (document.fullscreenElement || (document as any).webkitFullscreenElement));
  const wrapperClass = [
    'relative flex flex-col bg-white',
    fallbackFixed ? 'fixed inset-0 z-50 w-screen h-screen' : 'w-full h-[calc(100vh-260px)] min-h-[520px]',
    'fullscreen:!fixed fullscreen:!inset-0 fullscreen:!w-screen fullscreen:!h-screen',
  ].join(' ');

  return (
    <div ref={wrapperRef} className={wrapperClass}>
      {/* Slim title + legend strip — no card chrome. Sits above the canvas. */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-2 border-b border-slate-100 bg-white/80 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-slate-600">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
          <span className="text-sm font-semibold">Hierarchy</span>
          <span className="text-slate-300">·</span>
          <span className="text-xs text-slate-500 truncate max-w-[40vw]">{block.name}</span>
        </div>
        <div className="hidden md:flex items-center gap-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border-2 inline-block" style={{ borderColor: 'var(--theme-primary)', backgroundColor: 'var(--theme-primary-light)' }} /> Block</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border-2 border-purple-500 bg-purple-50 inline-block" /> Area</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border-2 border-teal-500 bg-teal-50 inline-block" /> AHU</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border-2 border-slate-300 bg-white inline-block" /> Filter</span>
        </div>
      </div>

      {/* Canvas area — fills the rest of the wrapper. */}
      <div className="relative flex-1 min-h-0">
        {/* Floating zoom + center + fullscreen toolbar */}
        <div className="absolute top-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/95 shadow-sm backdrop-blur px-1 py-1">
          <button
            type="button"
            onClick={() => setZoom(z => clampZoom(z - ZOOM_STEP))}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors"
            title="Zoom out"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => { setZoom(1); centerScroll(); }}
            className="px-2 h-7 rounded-md text-[11px] font-medium text-slate-600 hover:bg-slate-100 min-w-[44px] transition-colors"
            title="Reset zoom and center"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom(z => clampZoom(z + ZOOM_STEP))}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors"
            title="Zoom in"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <div className="w-px h-5 bg-slate-200 mx-0.5" />
          <button
            type="button"
            onClick={centerScroll}
            className="w-7 h-7 rounded-md text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors"
            title="Center view"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="w-7 h-7 rounded-md text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors"
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
          >
            {isFullscreen ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4M9 9H4m11 0V4m0 5h5M9 15v5m0-5H4m11 0v5m0-5h5" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l4 4m8 0V4m0 0h-4m4 0l-4 4m-8 4v4m0 0h4m-4 0l4-4m8 4l-4-4m4 4v-4m0 4h-4" />
              </svg>
            )}
          </button>
        </div>

        {/* Subtle dot grid for visual context (no card border) */}
        <div
          className="absolute inset-0 pointer-events-none opacity-50"
          style={{
            backgroundImage: 'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        {/* Scroll container.
            - `[justify-content:safe_center]` centers when content fits, falls
              back to flex-start when it overflows — fixes the can't-scroll-left
              bug caused by plain `justify-center` on a scrolling flex parent.
            - vertical scroll enabled too so deep trees don't push the viewport. */}
        <div
          ref={scrollRef}
          data-no-drag-pan
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endPan}
          onMouseLeave={endPan}
          className={`relative h-full w-full overflow-auto px-6 py-10 flex items-start [justify-content:safe_center] select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
        >
          <div
            className="min-w-fit transition-transform duration-150 ease-out"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          >
            <BlockNode block={block} perms={perms} onAddBlockChild={onAddBlockChild} onNavigate={handlers.onNavigate}>
              {blockChildren.length > 0 && renderChildrenConnector(
                blockChildren.map((child) =>
                  child.type === 'area'
                    ? <AreaDiagNode key={child.id} area={child} identifiersByAsset={identifiersByAsset} perms={perms} handlers={handlers} />
                    : <AhuDiagNode key={child.id} ahu={child} identifiersByAsset={identifiersByAsset} perms={perms} handlers={handlers} />,
                ),
                180,
              )}
            </BlockNode>
          </div>
        </div>
      </div>
    </div>
  );
}

type BlockNodeProps = {
  block: { id: string; name: string };
  perms: Perms;
  onAddBlockChild: (next: CreateDialogState) => void;
  onNavigate: Handlers['onNavigate'];
  children?: React.ReactNode;
};

function BlockNode({ block, perms, onAddBlockChild, onNavigate, children }: BlockNodeProps) {
  return (
    <div className="flex flex-col items-center group/block">
      <div className="relative">
        <button
          type="button"
          onClick={() => onNavigate('block', block.id, block.name)}
          className="flex flex-col items-center px-5 py-3 rounded-xl border-2 shadow-md ring-2 min-w-[130px] max-w-[170px] hover:shadow-lg cursor-pointer transition-all"
          style={{
            borderColor: 'var(--theme-primary)',
            backgroundColor: 'var(--theme-primary-light)',
            ['--tw-ring-color' as any]: 'var(--theme-primary-light)',
          }}
        >
          <svg className="w-5 h-5 mb-1 text-theme-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <span className="text-xs font-bold text-center truncate w-full" style={{ color: 'var(--theme-primary-dark)' }}>{block.name}</span>
          <span className="text-[9px] mt-0.5 text-theme-primary">Block</span>
        </button>
        {perms.canCreate && (
          <div className="absolute -top-2 -right-2 flex gap-0.5 opacity-0 group-hover/block:opacity-100 transition-opacity z-10">
            <button
              type="button"
              className="w-5 h-5 rounded-full bg-purple-500 text-white flex items-center justify-center shadow-sm hover:bg-purple-600 transition-colors"
              title="Add Area"
              onClick={(e) => { e.stopPropagation(); onAddBlockChild({ type: 'area', parentId: block.id, parentName: block.name }); }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
            </button>
            <button
              type="button"
              className="w-5 h-5 rounded-full bg-teal-500 text-white flex items-center justify-center shadow-sm hover:bg-teal-600 transition-colors"
              title="Add AHU"
              onClick={(e) => { e.stopPropagation(); onAddBlockChild({ type: 'ahu', parentId: block.id, parentName: block.name }); }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
