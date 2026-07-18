import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient } from '../../lib/api-client';
import { CLEANING_STAGES_EDITOR } from '../../lib/filter-constants';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

/* ── Constants ─────────────────────────────────────────────── */
const NODE_W = 160, NODE_H = 64, PORT_R = 6;
const STAGE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  START:     { bg: '#166534', border: '#22c55e', text: '#bbf7d0' },
  END:       { bg: '#991b1b', border: '#ef4444', text: '#fecaca' },
  STAGE:     { bg: '#1e40af', border: '#3b82f6', text: '#bfdbfe' },
  CHECKLIST: { bg: '#6b21a8', border: '#a855f7', text: '#e9d5ff' },
};
const CLEANING_STAGES = CLEANING_STAGES_EDITOR;

interface PipelineNode {
  id?: string; stateKey: string | null; nodeType: string; configuration: any;
  positionX: number; positionY: number; sortOrder: number;
}
interface Connection {
  id?: string; fromIndex: number; toIndex: number; label: string;
}

/* ── Port positions ────────────────────────────────────────── */
function outPort(n: PipelineNode) { return { x: n.positionX + NODE_W, y: n.positionY + NODE_H / 2 }; }
function inPort(n: PipelineNode)  { return { x: n.positionX,         y: n.positionY + NODE_H / 2 }; }

/* ── Bezier path ───────────────────────────────────────────── */
function bezierPath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/* ── Node label ────────────────────────────────────────────── */
function nodeLabel(n: PipelineNode) {
  if (n.nodeType === 'STAGE' && n.stateKey) return n.stateKey.replace(/_/g, ' ');
  if (n.nodeType === 'CHECKLIST') return 'Checklist';
  return n.nodeType;
}

export function CleaningProfileEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const reauth = useReauth();
  const isNew = id === 'new';
  const { data: profile } = useSWR(!isNew && id ? `/api/filter-cleaning-profiles/${id}` : null);
  const { data: checklistsData } = useSWR('/api/checklist-profiles?limit=500&isActive=true');
  const canvasRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState('');
  const [flowMode, setFlowMode] = useState<'STRICT' | 'BYPASS_ENABLED'>('STRICT');
  const [alarmFlags, setAlarmFlags] = useState({ forwardSkip: true, backwardJump: true, outOfSequence: true });
  const [nodes, setNodes] = useState<PipelineNode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [selectedConn, setSelectedConn] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Dragging state
  const [draggingNode, setDraggingNode] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  // Empty-canvas pan state (drag blank space to scroll the canvas). A ref, not
  // state, so panning doesn't re-render on every mousemove. Node/port mousedowns
  // stopPropagation, so this only starts on genuinely empty canvas space.
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  // Wire-dragging state (from output port)
  const [wireFrom, setWireFrom] = useState<number | null>(null);
  const [wireMouse, setWireMouse] = useState({ x: 0, y: 0 });

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  useEffect(() => {
    if (profile) {
      setName(profile.name); setFlowMode(profile.flowMode);
      setAlarmFlags({ forwardSkip: profile.alarmOnForwardSkip, backwardJump: profile.alarmOnBackwardJump, outOfSequence: profile.alarmOnOutOfSequence });
      setNodes(profile.stages?.map((s: any) => ({
        id: s.id, stateKey: s.stateKey, nodeType: s.nodeType,
        configuration: s.configuration, positionX: s.positionX, positionY: s.positionY, sortOrder: s.sortOrder,
      })) ?? []);
      setConnections(profile.connections?.map((c: any) => ({
        id: c.id, fromIndex: profile.stages.findIndex((s: any) => s.id === c.fromStageId),
        toIndex: profile.stages.findIndex((s: any) => s.id === c.toStageId), label: c.label ?? 'Next',
      })) ?? []);
    } else if (isNew) {
      setNodes([
        { stateKey: null, nodeType: 'START', configuration: {}, positionX: 60, positionY: 220, sortOrder: 0 },
        { stateKey: null, nodeType: 'END', configuration: {}, positionX: 800, positionY: 220, sortOrder: 99 },
      ]);
    }
  }, [profile, isNew]);

  /* ── Canvas mouse handlers ──────────────────────────────── */
  const canvasXY = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const el = canvasRef.current;
    if (!rect || !el) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left + el.scrollLeft, y: e.clientY - rect.top + el.scrollTop };
  }, []);

  // Start an empty-canvas pan. Only fires on blank canvas / grid / SVG backdrop —
  // node + port mousedowns call stopPropagation, so they never reach here.
  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.style.cursor = 'grabbing';
  }, []);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    // Pan takes priority and is mutually exclusive with node/wire drags.
    if (panRef.current) {
      const el = canvasRef.current;
      if (el) {
        el.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.x);
        el.scrollTop = panRef.current.st - (e.clientY - panRef.current.y);
      }
      return;
    }
    if (draggingNode !== null) {
      const p = canvasXY(e);
      setNodes(prev => prev.map((n, i) => i === draggingNode ? { ...n, positionX: Math.max(0, p.x - dragOffset.x), positionY: Math.max(0, p.y - dragOffset.y) } : n));
    }
    if (wireFrom !== null) {
      setWireMouse(canvasXY(e));
    }
  }, [draggingNode, wireFrom, dragOffset, canvasXY]);

  const onCanvasMouseUp = useCallback(() => {
    if (panRef.current) {
      panRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = '';
    }
    setDraggingNode(null);
    if (wireFrom !== null) setWireFrom(null);
  }, [wireFrom]);

  /* ── Node mouse down (drag start) ──────────────────────── */
  const onNodeMouseDown = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.target as HTMLElement).dataset.port) return;
    const p = canvasXY(e);
    setDragOffset({ x: p.x - nodes[idx].positionX, y: p.y - nodes[idx].positionY });
    setDraggingNode(idx);
    setSelectedNode(idx); setSelectedConn(null);
  };

  /* ── Output port mouse down (wire start) ───────────────── */
  const onOutputPortDown = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    setWireFrom(idx);
    setWireMouse(canvasXY(e));
  };

  /* ── Input port mouse up (wire end) ────────────────────── */
  const onInputPortUp = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (wireFrom !== null && wireFrom !== idx) {
      const exists = connections.some(c => c.fromIndex === wireFrom && c.toIndex === idx);
      if (!exists) setConnections(prev => [...prev, { fromIndex: wireFrom, toIndex: idx, label: 'Next' }]);
    }
    setWireFrom(null);
  };

  const addNode = (type: string, stateKey?: string) => {
    setNodes(prev => [...prev, {
      stateKey: stateKey ?? null, nodeType: type, configuration: {},
      positionX: 100 + prev.length * 140, positionY: 220, sortOrder: prev.length,
    }]);
  };

  const removeNode = useCallback((idx: number) => {
    if (!window.confirm("Delete this node? Connected wires will also be removed.")) return;
    if (nodes[idx].nodeType === 'START' || nodes[idx].nodeType === 'END') return;
    setNodes(prev => prev.filter((_, i) => i !== idx));
    setConnections(prev => prev.filter(c => c.fromIndex !== idx && c.toIndex !== idx)
      .map(c => ({ ...c, fromIndex: c.fromIndex > idx ? c.fromIndex - 1 : c.fromIndex, toIndex: c.toIndex > idx ? c.toIndex - 1 : c.toIndex })));
    setSelectedNode(null);
  }, [nodes]);

  /* ── Delete key handler ─────────────────────────────────── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't handle delete if user is typing in an input/select/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedConn !== null) {
          setConnections(prev => prev.filter((_, i) => i !== selectedConn));
          setSelectedConn(null);
        } else if (selectedNode !== null && nodes[selectedNode]?.nodeType !== 'START' && nodes[selectedNode]?.nodeType !== 'END') {
          removeNode(selectedNode);
        }
      }
      if (e.key === 'Escape') { setSelectedNode(null); setSelectedConn(null); setWireFrom(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedConn, selectedNode, nodes, removeNode]);

  const save = async () => {
    // Validate before saving
    if (!name.trim()) { setToast({ type: 'error', message: 'Profile name is required' }); return; }
    const stageNodes = nodes.filter(n => n.nodeType === 'STAGE');
    for (const sn of stageNodes) {
      if (!sn.stateKey) { setToast({ type: 'error', message: 'All stage nodes must have a stage selected' }); return; }
    }
    const checklistNodes = nodes.filter(n => n.nodeType === 'CHECKLIST');
    for (const cn of checklistNodes) {
      if (!cn.configuration?.checklistProfileId) { setToast({ type: 'error', message: 'All checklist nodes must have a checklist profile selected' }); return; }
    }
    const startNode = nodes.find(n => n.nodeType === 'START');
    const endNode = nodes.find(n => n.nodeType === 'END');
    if (!startNode || !endNode) { setToast({ type: 'error', message: 'Pipeline must have START and END nodes' }); return; }
    const startConns = connections.filter(c => c.fromIndex === nodes.indexOf(startNode));
    if (startConns.length === 0) { setToast({ type: 'error', message: 'START node must have at least one outgoing connection' }); return; }
    const endIdx = nodes.indexOf(endNode);
    const endConns = connections.filter(c => c.toIndex === endIdx);
    if (endConns.length === 0) { setToast({ type: 'error', message: 'END node must have at least one incoming connection' }); return; }
    const disconnected = nodes.filter((n, i) => n.nodeType !== 'START' && n.nodeType !== 'END' && !connections.some(c => c.fromIndex === i || c.toIndex === i));
    if (disconnected.length > 0) { setToast({ type: 'error', message: `${disconnected.length} disconnected node(s) found. Connect all nodes.` }); return; }

    setSaving(true);
    const action = isNew ? 'CREATE_CLEANING_PROFILE' : 'UPDATE_CLEANING_PROFILE';
    reauth.execute(action, async (password?: string) => {
      try {
        const body = {
          name, flowMode,
          alarmOnForwardSkip: alarmFlags.forwardSkip, alarmOnBackwardJump: alarmFlags.backwardJump, alarmOnOutOfSequence: alarmFlags.outOfSequence,
          stages: nodes.map((n, i) => ({ ...n, sortOrder: i })),
          connections: connections.map(c => ({ fromIndex: c.fromIndex, toIndex: c.toIndex, label: c.label })),
        };
        if (isNew) {
          const result = password
            ? await apiClient.postWithReauth('/api/filter-cleaning-profiles', body, password)
            : await apiClient.post('/api/filter-cleaning-profiles', body);
          navigate(`/filter-cleaning-profiles/${(result as any).id}/edit`, { replace: true });
        } else {
          const result = password
            ? await apiClient.putWithReauth(`/api/filter-cleaning-profiles/${id}`, body, password)
            : await apiClient.put(`/api/filter-cleaning-profiles/${id}`, body);
          const newId = (result as any).id;
          if (newId && newId !== id) navigate(`/filter-cleaning-profiles/${newId}/edit`, { replace: true });
          else mutate(`/api/filter-cleaning-profiles/${id}`);
        }
        setToast({ type: 'success', message: 'Cleaning profile saved successfully' });
      } catch (e: any) { setToast({ type: 'error', message: e.message || 'Failed to save profile' }); throw e; }
      finally { setSaving(false); }
    });
    setSaving(false);
  };

  /* ── Compute incoming/outgoing connections for selected node ── */
  const getNodeConnections = (idx: number) => {
    const incoming = connections
      .map((c, ci) => ({ ...c, connIndex: ci }))
      .filter(c => c.toIndex === idx);
    const outgoing = connections
      .map((c, ci) => ({ ...c, connIndex: ci }))
      .filter(c => c.fromIndex === idx);
    return { incoming, outgoing };
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm font-medium ${toast.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <span>{toast.type === 'success' ? '\u2713' : '\u2717'}</span>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss notification" className="ml-2 text-white/50 hover:text-white/80">&times;</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="bg-white border-b border-slate-200 px-4 py-2.5 flex items-center gap-4 shrink-0">
        <button onClick={() => navigate('/filter-cleaning-profiles')} className="text-slate-500 hover:text-slate-700 text-sm">&larr; Back</button>
        <div className="w-px h-6 bg-slate-100" />
        <input className="bg-slate-50 border border-slate-300 rounded px-3 py-1.5 text-slate-800 font-semibold w-60 text-sm" value={name}
          onChange={e => setName(e.target.value)} placeholder="Profile Name" />
        <select className="bg-slate-50 border border-slate-300 rounded px-2 py-1.5 text-slate-800 text-xs" value={flowMode}
          onChange={e => setFlowMode(e.target.value as any)}>
          <option value="STRICT">Strict</option>
          <option value="BYPASS_ENABLED">Bypass Enabled</option>
        </select>
        {flowMode === 'BYPASS_ENABLED' && (
          <div className="flex gap-3 text-[11px] text-slate-500">
            <label className="flex items-center gap-1"><input type="checkbox" checked={alarmFlags.forwardSkip} onChange={e => setAlarmFlags({ ...alarmFlags, forwardSkip: e.target.checked })} className="w-3 h-3" /> Fwd Skip</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={alarmFlags.backwardJump} onChange={e => setAlarmFlags({ ...alarmFlags, backwardJump: e.target.checked })} className="w-3 h-3" /> Bwd Jump</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={alarmFlags.outOfSequence} onChange={e => setAlarmFlags({ ...alarmFlags, outOfSequence: e.target.checked })} className="w-3 h-3" /> Out of Seq</label>
          </div>
        )}
        <div className="flex-1" />
        {!isNew && profile && <span className="text-[11px] text-slate-400">v{profile.version}</span>}
        <button onClick={save} disabled={saving} className="px-5 py-1.5 bg-cyan-600 text-white rounded-lg text-sm font-medium hover:bg-cyan-500 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left Sidebar ── */}
        <div className="w-52 bg-slate-50 border-r border-slate-200/60 p-3 overflow-y-auto shrink-0">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Cleaning Stages</div>
          {CLEANING_STAGES.map((s) => (
            <button key={s.key} onClick={() => addNode('STAGE', s.key)}
              className="w-full text-left px-3 py-2 mb-1 rounded-lg bg-white/60 hover:bg-white text-sm text-slate-600 transition-colors flex items-center gap-2.5 group">
              <div className="w-2.5 h-2.5 rounded-full ring-2 ring-offset-1 ring-offset-white" style={{ backgroundColor: s.color }} />
              <span className="group-hover:text-slate-800">{s.name}</span>
            </button>
          ))}
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-4 mb-2">Additional</div>
          <button onClick={() => addNode('CHECKLIST')}
            className="w-full text-left px-3 py-2 mb-1 rounded-lg bg-white/60 hover:bg-white text-sm text-slate-600 transition-colors flex items-center gap-2.5 group">
            <div className="w-2.5 h-2.5 rounded-full bg-purple-500 ring-2 ring-purple-500 ring-offset-1 ring-offset-white" />
            <span className="group-hover:text-slate-800">Checklist</span>
          </button>
          <div className="mt-6 px-1 text-[10px] text-slate-300 leading-relaxed">
            Drag from <span className="text-cyan-500">output port</span> (right) to <span className="text-cyan-500">input port</span> (left) to connect nodes. Click a connection then press <kbd className="px-1 py-0.5 bg-white rounded text-slate-500">Del</kbd> to remove.
          </div>
        </div>

        {/* ── Canvas ── */}
        <div ref={canvasRef}
          data-no-drag-pan
          className="flex-1 overflow-auto relative select-none cursor-grab"
          style={{ background: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px', backgroundColor: '#f8fafc' }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
          onClick={() => { setSelectedNode(null); setSelectedConn(null); }}>

          <svg className="absolute inset-0 w-full h-full" style={{ minWidth: '2000px', minHeight: '1000px' }}>
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,3 L0,6" fill="#4B5563" />
              </marker>
              <marker id="arrowhead-sel" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,3 L0,6" fill="#22d3ee" />
              </marker>
            </defs>

            {/* Connections */}
            {connections.map((c, i) => {
              const from = nodes[c.fromIndex];
              const to = nodes[c.toIndex];
              if (!from || !to) return null;
              const p1 = outPort(from), p2 = inPort(to);
              const isSel = selectedConn === i;
              return (
                <g key={i} className="group cursor-pointer" onClick={(e) => { e.stopPropagation(); setSelectedConn(i); setSelectedNode(null); }}>
                  <path d={bezierPath(p1.x, p1.y, p2.x, p2.y)} fill="none" stroke="transparent" strokeWidth="14" />
                  <path d={bezierPath(p1.x, p1.y, p2.x, p2.y)} fill="none"
                    stroke={isSel ? '#22d3ee' : '#4B5563'} strokeWidth={isSel ? 2.5 : 1.5}
                    markerEnd={isSel ? 'url(#arrowhead-sel)' : 'url(#arrowhead)'}
                    className={isSel ? '' : 'group-hover:stroke-slate-400'}
                    style={{ transition: 'stroke 0.15s' }} />
                  {isSel && (() => {
                    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                    return (
                      <g onClick={(e) => { e.stopPropagation(); setConnections(prev => prev.filter((_, ci) => ci !== i)); setSelectedConn(null); }} className="cursor-pointer">
                        <circle cx={mx} cy={my} r="10" fill="#0f0f1a" stroke="#ef4444" strokeWidth="1.5" />
                        <line x1={mx - 3.5} y1={my - 3.5} x2={mx + 3.5} y2={my + 3.5} stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                        <line x1={mx + 3.5} y1={my - 3.5} x2={mx - 3.5} y2={my + 3.5} stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                      </g>
                    );
                  })()}
                </g>
              );
            })}

            {/* Dragging wire preview */}
            {wireFrom !== null && nodes[wireFrom] && (
              <path d={bezierPath(outPort(nodes[wireFrom]).x, outPort(nodes[wireFrom]).y, wireMouse.x, wireMouse.y)}
                fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray="6 4" opacity="0.7" className="pointer-events-none" />
            )}
          </svg>

          {/* ── Nodes ── */}
          {nodes.map((node, idx) => {
            const colors = STAGE_COLORS[node.nodeType] ?? STAGE_COLORS.STAGE;
            const isSelected = selectedNode === idx;
            const stageColor = node.nodeType === 'STAGE' && node.stateKey ? CLEANING_STAGES.find(s => s.key === node.stateKey)?.color : null;
            return (
              <div key={idx}
                className="absolute group"
                style={{ left: node.positionX, top: node.positionY, width: NODE_W, height: NODE_H, zIndex: isSelected ? 20 : 10 }}
                onMouseDown={(e) => onNodeMouseDown(idx, e)}
                onClick={(e) => e.stopPropagation()}>

                {/* Node body */}
                <div className={`w-full h-full rounded-xl border-2 flex flex-col items-center justify-center transition-shadow duration-150 ${isSelected ? 'shadow-lg shadow-cyan-500/20' : 'shadow-md shadow-black/30'}`}
                  style={{
                    backgroundColor: stageColor ? `${stageColor}22` : colors.bg,
                    borderColor: isSelected ? '#22d3ee' : (stageColor ?? colors.border),
                  }}>
                  <div className="text-[11px] font-bold tracking-wide" style={{ color: stageColor ?? colors.text }}>{nodeLabel(node)}</div>
                  {node.nodeType === 'CHECKLIST' && node.configuration?.checklistProfileName && (
                    <div className="text-[9px] text-slate-500 mt-0.5 truncate max-w-[130px]">{node.configuration.checklistProfileName}</div>
                  )}
                  {node.nodeType !== 'START' && node.nodeType !== 'END' && (
                    <div className="text-[9px] text-slate-400 mt-0.5 uppercase tracking-wider">{node.nodeType}</div>
                  )}
                </div>

                {/* Input port (left) — not on START */}
                {node.nodeType !== 'START' && (
                  <div data-port="in"
                    className="absolute w-3.5 h-3.5 rounded-full border-2 border-gray-500 bg-white hover:border-cyan-400 hover:bg-cyan-900 transition-colors cursor-crosshair"
                    style={{ left: -PORT_R - 1, top: NODE_H / 2 - PORT_R - 1 }}
                    onMouseUp={(e) => onInputPortUp(idx, e)} />
                )}

                {/* Output port (right) — not on END */}
                {node.nodeType !== 'END' && (
                  <div data-port="out"
                    className="absolute w-3.5 h-3.5 rounded-full border-2 border-gray-500 bg-white hover:border-cyan-400 hover:bg-cyan-900 transition-colors cursor-crosshair"
                    style={{ right: -PORT_R - 1, top: NODE_H / 2 - PORT_R - 1 }}
                    onMouseDown={(e) => onOutputPortDown(idx, e)} />
                )}

                {/* Delete button (top-right, non-START/END) */}
                {node.nodeType !== 'START' && node.nodeType !== 'END' && (
                  <button
                    className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-white border border-slate-300 text-slate-400 hover:bg-red-900 hover:border-red-500 hover:text-red-600 text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center"
                    onClick={(e) => { e.stopPropagation(); removeNode(idx); }}>&times;</button>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Right Sidebar — Node Properties ── */}
        {selectedNode !== null && nodes[selectedNode] && (() => {
          const node = nodes[selectedNode];
          const { incoming, outgoing } = getNodeConnections(selectedNode);
          const stageInfo = node.nodeType === 'STAGE' && node.stateKey ? CLEANING_STAGES.find(s => s.key === node.stateKey) : null;
          const colors = STAGE_COLORS[node.nodeType] ?? STAGE_COLORS.STAGE;

          return (
            <div className="w-72 bg-slate-50 border-l border-slate-200/60 overflow-y-auto shrink-0">
              {/* Header */}
              <div className="px-4 py-3 border-b border-slate-200/60 flex items-center justify-between"
                style={{ backgroundColor: stageInfo ? `${stageInfo.color}15` : `${colors.bg}30` }}>
                <div className="flex items-center gap-2.5">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stageInfo?.color ?? colors.border }} />
                  <h4 className="text-sm font-bold text-slate-800">{nodeLabel(node)}</h4>
                </div>
                <button onClick={() => setSelectedNode(null)} className="text-slate-400 hover:text-slate-600 w-6 h-6 flex items-center justify-center rounded hover:bg-white">&times;</button>
              </div>

              <div className="p-4 space-y-4">
                {/* Node Type Badge */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Node Type</div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
                    style={{ backgroundColor: `${colors.bg}60`, color: colors.text, border: `1px solid ${colors.border}40` }}>
                    {node.nodeType}
                  </span>
                </div>

                {/* Position */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Position</div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-slate-300">X</label>
                      <input type="number" className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-slate-700 text-xs"
                        value={Math.round(node.positionX)}
                        onChange={e => {
                          const ns = [...nodes];
                          ns[selectedNode] = { ...ns[selectedNode], positionX: Number(e.target.value) };
                          setNodes(ns);
                        }} />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-slate-300">Y</label>
                      <input type="number" className="w-full bg-white border border-slate-200 rounded px-2 py-1 text-slate-700 text-xs"
                        value={Math.round(node.positionY)}
                        onChange={e => {
                          const ns = [...nodes];
                          ns[selectedNode] = { ...ns[selectedNode], positionY: Number(e.target.value) };
                          setNodes(ns);
                        }} />
                    </div>
                  </div>
                </div>

                {/* STAGE: Change stage key */}
                {node.nodeType === 'STAGE' && (
                  <div>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Stage</div>
                    <select className="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-slate-700 text-sm"
                      value={node.stateKey ?? ''}
                      onChange={e => {
                        const ns = [...nodes];
                        ns[selectedNode] = { ...ns[selectedNode], stateKey: e.target.value || null };
                        setNodes(ns);
                      }}>
                      <option value="">-- Select Stage --</option>
                      {CLEANING_STAGES.map(s => (
                        <option key={s.key} value={s.key}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* CHECKLIST: Select checklist profile */}
                {node.nodeType === 'CHECKLIST' && (
                  <div>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Checklist Profile</div>
                    <select className="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-slate-700 text-sm"
                      value={node.configuration?.checklistProfileId ?? ''}
                      onChange={e => {
                        const cpId = e.target.value;
                        const cp = (checklistsData?.data ?? []).find((c: any) => c.id === cpId);
                        const ns = [...nodes];
                        ns[selectedNode!] = { ...ns[selectedNode!], configuration: cp ? { checklistProfileId: cpId, checklistProfileName: cp.name, questionCount: cp.questionCount } : {} };
                        setNodes(ns);
                      }}>
                      <option value="">-- Select Checklist --</option>
                      {(checklistsData?.data ?? []).map((c: any) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.questionCount} questions)</option>
                      ))}
                    </select>
                    {node.configuration?.checklistProfileName && (
                      <div className="mt-2 px-3 py-2 bg-purple-900/20 border border-purple-800/40 rounded-lg">
                        <div className="text-xs text-purple-300 font-medium">{node.configuration.checklistProfileName}</div>
                        <div className="text-[10px] text-purple-400/70 mt-0.5">{node.configuration.questionCount} question(s)</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Connections Info */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Connections</div>
                  <div className="space-y-1.5">
                    {incoming.length > 0 && (
                      <div>
                        <div className="text-[10px] text-slate-300 mb-0.5">Incoming ({incoming.length})</div>
                        {incoming.map((c, i) => {
                          const fromNode = nodes[c.fromIndex];
                          return fromNode ? (
                            <div key={i} className="flex items-center gap-1.5 text-xs text-slate-500 py-0.5">
                              <span className="text-cyan-500">&larr;</span>
                              <span>{nodeLabel(fromNode)}</span>
                            </div>
                          ) : null;
                        })}
                      </div>
                    )}
                    {outgoing.length > 0 && (
                      <div>
                        <div className="text-[10px] text-slate-300 mb-0.5">Outgoing ({outgoing.length})</div>
                        {outgoing.map((c, i) => {
                          const toNode = nodes[c.toIndex];
                          return toNode ? (
                            <div key={i} className="flex items-center gap-1.5 text-xs text-slate-500 py-0.5">
                              <span className="text-cyan-500">&rarr;</span>
                              <span>{nodeLabel(toNode)}</span>
                            </div>
                          ) : null;
                        })}
                      </div>
                    )}
                    {incoming.length === 0 && outgoing.length === 0 && (
                      <div className="text-[10px] text-slate-300 italic">No connections</div>
                    )}
                  </div>
                </div>

                {/* Sort Order */}
                <div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Sort Order</div>
                  <input type="number" className="w-20 bg-white border border-slate-200 rounded px-2 py-1 text-slate-700 text-xs"
                    value={node.sortOrder}
                    onChange={e => {
                      const ns = [...nodes];
                      ns[selectedNode] = { ...ns[selectedNode], sortOrder: Number(e.target.value) };
                      setNodes(ns);
                    }} />
                </div>

                {/* ID (for existing nodes) */}
                {node.id && (
                  <div>
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">ID</div>
                    <div className="text-[10px] text-slate-300 font-mono break-all">{node.id}</div>
                  </div>
                )}

                {/* Delete Button */}
                {node.nodeType !== 'START' && node.nodeType !== 'END' && (
                  <button onClick={() => removeNode(selectedNode)} className="w-full py-2 bg-red-50 border border-red-200/50 text-red-600 rounded-lg text-sm hover:bg-red-900/50 transition-colors mt-2">
                    Delete Node
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>
      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} />
    </div>
  );
}
