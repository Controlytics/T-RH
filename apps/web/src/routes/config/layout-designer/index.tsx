import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { getApiBase } from '@/lib/api-base';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import { PageHero } from '@/components/ui/page-hero';
import { ALL_RECORDS_PARAM, boundingBox, sharedEdges, unionRectilinear, type Polygon, type SharedEdge } from '@digilog/shared';
import type { RoomDoor, DoorKind } from '@/routes/dashboard/room-geometry';
import { continuationBase } from '@/routes/dashboard/floorplan-view';
import { DesignerCanvas, roomPolygon } from './canvas';
import { RoomPropertiesPanel, LinkPropertiesPanel, EMPTY_FORM, type RoomForm, type InstrumentRow } from './properties-panel';
import { reduce, initialState, closedPolygon, type Tool } from './tools';
import { CANVAS_PRESETS, normaliseAnnotations, isArchitectural, SCRIPT_DRAWN_PLANS, type DesignerAnnotations, type DesignerPlan, type DesignerRoom, type StructureLayer } from './types';
import { PlanPropertiesPanel } from './plan-panel';
import { StructurePropertiesPanel, type StructureElement } from './structure-panel';
import { limitChanges, numOrNull } from './room-limits';
import { RemarkDialog, type RemarkChange } from '@/routes/instruments/remark-dialog';
import { insertCornerMap, deleteCornerMap, geometricMap, remapDoors, remapOpenings, type SpanMap } from './reindex';

/**
 * LAYOUT DESIGNER (2026-09-22). Replaces the Floorplans editor at the same
 * address. Operator: "in configurations give one configuration prepare
 * layouts. like starts with empty one, draw shapes room redesigns and room to
 * room linking, or empty space in between rooms like corridor …".
 *
 * A plan starts BLANK (or from an uploaded tracing image); rooms and corridors
 * are drawn corner by corner as polygons; corners are dragged, added and
 * removed; doors sit on any edge; two rooms are linked by an opening in the
 * wall they share or by a connector line. Every save goes through the same
 * audited, re-authenticated room endpoints the old editor used, plus the three
 * link endpoints — a geometry change is saved on release, a new room on close
 * (after its code), a link on creation, properties on Save. Nothing batches.
 *
 * Design: docs/superpowers/specs/2026-09-22-layout-designer-design.md
 */

interface PlanList { data: DesignerPlan[] }


const BASE_TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Click a room to select it; drag to move; drag a corner to reshape; double-click a wall to add a corner' },
  { id: 'room', label: 'Draw room', hint: 'Click corner by corner; Enter or click the first corner to close; Escape to discard; Shift for straight walls' },
  { id: 'corridor', label: 'Draw corridor', hint: 'As Draw room, graded Corridor' },
  { id: 'door', label: 'Door', hint: 'Click a wall of a room to place a door' },
  { id: 'link', label: 'Link', hint: 'Click one room, then another: an opening if they share a wall, else a connector' },
];
/** The 2D layer's tools (2026-10-05) — shown only on a 2D plan; the standard drawing shows none of what they draw. */
const STRUCTURE_TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'column', label: 'Column', hint: 'Drag a box: a structural column, hatched on the floor' },
  { id: 'equipment', label: 'Equipment', hint: 'Drag a box: fixed plant, outlined on the floor' },
  { id: 'window', label: 'Window', hint: 'Click two points along a wall: a window set into it' },
  { id: 'wall', label: 'Wall stub', hint: 'Click two points: a partition the rooms do not describe' },
  { id: 'label', label: 'Label', hint: 'Click where a text label goes, then type it in the panel' },
];

export function LayoutDesignerPage() {
  const { toast } = useToast();
  const reauth = useReauth();
  const { data: planData, mutate: mutatePlans } = useSWR<PlanList>('/api/floorplans');
  const { data: instrumentData } = useSWR<{ data: InstrumentRow[] }>(`/api/instruments?${ALL_RECORDS_PARAM}`);
  const plans = planData?.data ?? [];
  const instruments = useMemo(() => [...(instrumentData?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code)), [instrumentData]);

  const [planId, setPlanId] = useState('');
  const plan = plans.find((p) => p.id === planId) ?? null;
  const { data: planDetail, mutate: mutateDetail } = useSWR<DesignerPlan>(planId ? `/api/floorplans/${planId}` : null);
  useEffect(() => { if (!planId && plans.length > 0) setPlanId(plans[0].id); }, [plans, planId]);

  /** instrumentId → the room it sits in, on this plan (from the DETAIL, the only source of membership). */
  const roomOfInstrument = useMemo(() => {
    const map = new Map<string, { id: string; code: string }>();
    for (const room of planDetail?.rooms ?? []) for (const i of room.instruments ?? []) map.set(i.id, { id: room.id, code: room.code });
    return map;
  }, [planDetail]);

  const [state, dispatch] = useReducer(reduce, initialState);
  const codeOfSafe = (id: string) => plan?.rooms.find((r) => r.id === id)?.code ?? '?';
  const [pending, setPending] = useState<{ points: Polygon; corridor: boolean } | null>(null);
  const [form, setForm] = useState<RoomForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // A limit change waits here for its reason (DATA-11); null = no dialog open.
  const [limitReason, setLimitReason] = useState<{ changes: RemarkChange[] } | null>(null);
  const [guideOpacity, setGuideOpacity] = useState(0.35);
  const [showGrid, setShowGrid] = useState(true);
  const [newPlan, setNewPlan] = useState<{ name: string; preset: (typeof CANVAS_PRESETS)[number]['key'] } | null>(null);

  const selectedRoomId = state.selection?.kind === 'room' || state.selection?.kind === 'corner' || state.selection?.kind === 'door' ? state.selection.roomId : null;
  const selectedRoom = plan?.rooms.find((r) => r.id === selectedRoomId) ?? null;
  const selectedLinkId = state.selection?.kind === 'link' ? state.selection.linkId : null;
  const selectedLink = selectedLinkId ? plan?.links.find((l) => l.id === selectedLinkId) ?? null : null;
  // The 2D layer (2026-10-05): held whole, saved whole.
  const annotations = useMemo(() => normaliseAnnotations(plan?.annotations), [plan]);
  // The layer as LAST SENT (review, 2026-10-05): every structure edit PUTs the
  // whole object, and the plan list only revalidates after the save lands, so
  // two edits in quick succession built from `annotations` alone would have
  // the second replace the row with a copy that never saw the first. The ref
  // follows the server once it answers, and runs ahead of it in between.
  const latestAnnotations = useRef(annotations);
  useEffect(() => { latestAnnotations.current = annotations; }, [annotations]);
  // The plan VERSION the layer was loaded at (audit 2026-10-12 finding 4): sent
  // as `expectedUpdatedAt`, so a plan someone else saved since is refused 409
  // STALE instead of being overwritten whole. Follows the server; a successful
  // save moves it to the version that save produced.
  const planVersion = useRef<string | undefined>(plan?.updatedAt);
  useEffect(() => { planVersion.current = plan?.updatedAt; }, [plan?.id, plan?.updatedAt]);
  // ONE layer save at a time; later edits wait in the queue (see saveAnnotations).
  const annotationsInFlight = useRef(false);
  const annotationsQueue = useRef<{ build: (base: DesignerAnnotations) => DesignerAnnotations; done: { title: string; message?: string } | null; onDone?: (next: DesignerAnnotations, base: DesignerAnnotations) => void }[]>([]);
  const arch = isArchitectural(plan);
  const tools = arch ? [...BASE_TOOLS, ...STRUCTURE_TOOLS] : BASE_TOOLS;
  const selectedStructure = state.selection?.kind === 'structure' ? state.selection : null;

  // The panel follows the selection; membership from the detail response.
  useEffect(() => {
    if (!selectedRoom) return;
    const assigned = planDetail?.rooms.find((r) => r.id === selectedRoom.id)?.instruments ?? [];
    setForm({
      code: selectedRoom.code, label: selectedRoom.label ?? '', grade: selectedRoom.grade ?? '',
      tempMin: selectedRoom.tempMin?.toString() ?? '', tempMax: selectedRoom.tempMax?.toString() ?? '',
      rhMin: selectedRoom.rhMin?.toString() ?? '', rhMax: selectedRoom.rhMax?.toString() ?? '',
      instrumentIds: assigned.map((i) => i.id), doors: selectedRoom.doors ?? [],
    });
    setPending(null);
  }, [selectedRoomId, plan, planDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── One place every audited write goes through ─────────────────────────────
  const run = (action: 'UPDATE_FLOORPLAN' | 'UPDATE_FLOORPLAN_ROOM', work: (password?: string) => Promise<void>, done: { title: string; message?: string } | null, onDone?: () => void, onFail?: (e: unknown) => void) => {
    setSaving(true);
    reauth.execute(action, work, {
      onSuccess: async () => {
        await Promise.all([mutatePlans(), mutateDetail()]);
        setSaving(false);
        if (done) toast.success(done.title, done.message);
        onDone?.();
      },
      onError: (e: unknown) => {
        setSaving(false);
        onFail?.(e);
        const err = e as { error?: string; message?: string } | null;
        if (err?.error === 'STALE') toast.error('Plan changed elsewhere', 'Someone saved this plan after you opened it. It has been reloaded; make your change again.');
        else toast.error('Save failed', err?.message ?? 'The change was not saved.');
        void Promise.all([mutatePlans(), mutateDetail()]); // a failed geometry save springs the room back
      },
      onCancel: () => { setSaving(false); onFail?.(null); },
    });
  };
  const put = <T,>(url: string, body: unknown, password?: string) => (password ? apiClient.putWithReauth<T>(url, body, password) : apiClient.put<T>(url, body));
  const post = <T,>(url: string, body: unknown, password?: string) => (password ? apiClient.postWithReauth<T>(url, body, password) : apiClient.post<T>(url, body));
  const del = (url: string, password?: string) => (password ? apiClient.deleteWithReauth(url, password) : apiClient.delete(url));

  /**
   * The ONE write of the 2D layer: the whole object, replaced (the `doors` rule).
   *
   * Audit 2026-10-12 finding 4. Each save sends the plan version it builds on
   * (`expectedUpdatedAt`; a plan someone else saved since is refused 409
   * STALE). Saves are SERIALISED: an edit made while one is in flight waits
   * its turn and is BUILT then, from the layer as the previous save left it
   * (`build(base)`), so it carries the earlier edit and the version that save
   * produced. A save that is cancelled or refused is ROLLED BACK — the layer
   * returns to what the server has — and the edits queued behind it, built on
   * a change that never landed, are dropped and the user told.
   */
  type LayerSave = { build: (base: DesignerAnnotations) => DesignerAnnotations; done: { title: string; message?: string } | null; onDone?: (next: DesignerAnnotations, base: DesignerAnnotations) => void };
  const saveAnnotations = (build: LayerSave['build'], done: LayerSave['done'], onDone?: LayerSave['onDone']) => {
    if (!plan) return;
    if (annotationsInFlight.current) { annotationsQueue.current.push({ build, done, onDone }); return; }
    annotationsInFlight.current = true;
    const prev = latestAnnotations.current;
    const next = build(prev);
    latestAnnotations.current = next;
    run('UPDATE_FLOORPLAN', async (pw) => {
      const saved = await put<{ updatedAt?: string }>(`/api/floorplans/${plan.id}`, { annotations: next, expectedUpdatedAt: planVersion.current }, pw);
      if (saved?.updatedAt) planVersion.current = saved.updatedAt;
    }, done, () => {
      annotationsInFlight.current = false;
      onDone?.(next, prev);
      const queued = annotationsQueue.current.shift();
      if (queued) saveAnnotations(queued.build, queued.done, queued.onDone);
    }, () => {
      annotationsInFlight.current = false;
      latestAnnotations.current = prev;
      const dropped = annotationsQueue.current.length;
      annotationsQueue.current = [];
      if (dropped) dispatch({ type: 'flash', message: `${dropped} later change(s) to the plan were not saved, because the one before them was not.` });
    });
  };
  const addStructure = (layer: StructureLayer, element: StructureElement) => {
    saveAnnotations(
      (base) => ({ ...base, [layer]: [...base[layer], element] } as DesignerAnnotations),
      null,
      (_next, base) => dispatch({ type: 'select', selection: { kind: 'structure', layer, index: base[layer].length } }),
    );
  };
  const updateStructure = (layer: StructureLayer, index: number, element: StructureElement) => {
    saveAnnotations((base) => {
      const list = [...base[layer]] as StructureElement[];
      list[index] = element;
      return { ...base, [layer]: list } as DesignerAnnotations;
    }, null);
  };
  const removeStructure = (layer: StructureLayer, index: number) => {
    saveAnnotations(
      (base) => ({ ...base, [layer]: (base[layer] as StructureElement[]).filter((_, i) => i !== index) } as DesignerAnnotations),
      { title: 'Element removed' },
      () => dispatch({ type: 'select', selection: null }),
    );
  };

  const roomBody = (room: DesignerRoom, f: RoomForm, points: Polygon | null) => {
    const pts = points ?? room.points;
    const box = pts ? boundingBox(pts) : { x: room.x, y: room.y, w: room.w, h: room.h };
    return {
      code: f.code.trim(), label: f.label.trim() || null, grade: f.grade || null,
      ...box, points: pts,
      tempMin: numOrNull(f.tempMin), tempMax: numOrNull(f.tempMax), rhMin: numOrNull(f.rhMin), rhMax: numOrNull(f.rhMax),
      doors: f.doors.length > 0 ? f.doors : null,
    };
  };
  const formOf = (room: DesignerRoom): RoomForm => ({
    code: room.code, label: room.label ?? '', grade: room.grade ?? '',
    tempMin: room.tempMin?.toString() ?? '', tempMax: room.tempMax?.toString() ?? '',
    rhMin: room.rhMin?.toString() ?? '', rhMax: room.rhMax?.toString() ?? '',
    instrumentIds: [], doors: room.doors ?? [],
  });

  // ── Plans ──────────────────────────────────────────────────────────────────
  const createPlan = () => {
    if (!newPlan || !newPlan.name.trim()) { toast.error('Name required', 'Give the plan a name.'); return; }
    const preset = CANVAS_PRESETS.find((p) => p.key === newPlan.preset) ?? CANVAS_PRESETS[0];
    // A NEW plan is 2D (2026-10-05): the style the operator chose; Standard is a switch away on the Plan panel.
    const body = { name: newPlan.name.trim(), imagePath: null, imageWidth: preset.width, imageHeight: preset.height, annotations: { style: 'architectural' as const } };
    run('UPDATE_FLOORPLAN', async (pw) => {
      const made = await post<{ id: string }>('/api/floorplans', body, pw);
      setPlanId(made.id);
    }, { title: 'Plan created', message: `"${body.name}" is a blank ${preset.label.toLowerCase()} canvas in the 2D style. Draw rooms on it.` }, () => setNewPlan(null));
  };

  // Delete the whole plan (2026-10-01, operator: "add delete option in layout
  // designer configuration"): its rooms and links go with it (cascade) and
  // the instruments in those rooms become UNPLACED — they are not deleted,
  // and the confirm says how many. The same audited, re-authenticated
  // request the API has always had (`DELETE /api/floorplans/:id`,
  // FLOORPLAN_DELETED); nothing on the dashboard lists a plan that is gone.
  const deletePlan = () => {
    if (!plan) return;
    const rooms = plan.rooms.length;
    const placed = (planDetail?.id === plan.id ? planDetail.rooms : []).reduce((n, r) => n + (r.instruments?.length ?? 0), 0);
    const what = [`${rooms} room${rooms === 1 ? '' : 's'}`, ...(plan.links.length ? [`${plan.links.length} link${plan.links.length === 1 ? '' : 's'}`] : [])].join(' and ');
    if (!window.confirm(`Delete the plan "${plan.name}" with its ${what}?${placed ? ` ${placed} instrument${placed === 1 ? '' : 's'} become unplaced (not deleted).` : ''} This cannot be undone.`)) return;
    const name = plan.name;
    run('UPDATE_FLOORPLAN', async (pw) => {
      await del(`/api/floorplans/${plan.id}`, pw);
    }, { title: 'Plan deleted', message: `"${name}" and its rooms are gone${placed ? `; ${placed} instrument${placed === 1 ? ' is' : 's are'} unplaced` : ''}.` }, () => {
      dispatch({ type: 'setTool', tool: 'select' });
      setPending(null);
      setPlanId('');   // the list's first plan is picked, if one is left
    });
  };

  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadTracing = async (file: File) => {
    if (!plan) return;
    try {
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('That file could not be read as an image.'));
        img.src = URL.createObjectURL(file);
      });
      const fd = new FormData();
      fd.append('file', file);
      const up = await apiClient.postFormData<{ url: string }>('/api/uploads/floorplan', fd);
      run('UPDATE_FLOORPLAN', async (pw) => {
        await put(`/api/floorplans/${plan.id}`, { imagePath: up.url, imageWidth: dims.w, imageHeight: dims.h }, pw);
      }, { title: 'Tracing image set', message: 'The plan now uses the image\'s size; rooms keep their positions in plan units.' });
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : 'Could not upload that image.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // ── Drawing ────────────────────────────────────────────────────────────────
  const closePolygon = () => {
    const r = closedPolygon(state);
    if (!r.ok) { dispatch({ type: 'flash', message: r.error }); return; }
    const corridor = state.tool === 'corridor';
    setPending({ points: r.points, corridor });
    dispatch({ type: 'closePolygon' });
    dispatch({ type: 'select', selection: null });
    const n = (plan?.rooms.filter((x) => x.grade === 'CIRCULATION').length ?? 0) + 1;
    setForm({ ...EMPTY_FORM, grade: corridor ? 'CIRCULATION' : '', code: corridor ? `CORRIDOR-${String(n).padStart(2, '0')}` : '' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (e.key === 'Escape') { dispatch({ type: 'cancel' }); setPending(null); return; }
      if (e.key === 'Enter' && state.drawing) { e.preventDefault(); closePolygon(); return; }
      if (e.key === 'Backspace' && state.drawing) { e.preventDefault(); dispatch({ type: 'undoCorner' }); return; }
      if ((e.key === 'Delete') && state.selection) { e.preventDefault(); deleteSelection(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // every render on purpose: the handlers close over the latest state

  // ── Rooms ──────────────────────────────────────────────────────────────────
  const saveMembership = async (roomId: string, ids: string[], pw?: string) => {
    if (!plan) return;
    const res = await put<{ moved: { code: string; fromRoom: { code: string } | null }[] }>(`/api/floorplans/${plan.id}/rooms/${roomId}/instruments`, { instrumentIds: ids }, pw);
    if (res.moved?.length) toast.successToast('Instruments moved', res.moved.map((m) => `${m.code} moved from ${m.fromRoom?.code ?? 'another room'}`).join('; '));
  };

  const createRoom = () => {
    if (!plan || !pending) return;
    if (!form.code.trim()) { toast.error('Room code required', 'Give the room a code before creating it.'); return; }
    const body = { ...roomBody({ ...EMPTY_ROOM, points: pending.points }, form, pending.points) };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => {
      const saved = await post<{ id: string }>(`/api/floorplans/${plan.id}/rooms`, body, pw);
      if (form.instrumentIds.length) await saveMembership(saved.id, form.instrumentIds, pw);
      dispatch({ type: 'select', selection: { kind: 'room', roomId: saved.id } });
    }, { title: 'Room created', message: `"${body.code}" added to ${plan.name}.` }, () => setPending(null));
  };

  // A change to the room's LIMITS needs the operator's stated reason — the
  // server refuses it without one (400 REASON_REQUIRED, audit 2026-10-03
  // DATA-11). The reason is asked for BEFORE the request, through the same
  // dialog an instrument attribute change uses, so the operator sees the
  // before and after of what one remark will be recorded against. Label,
  // grade, doors, membership and geometry saves never ask: `limitChanges`
  // compares against the STORED row, as the server does.
  const saveRoomProps = (reason?: string) => {
    if (!plan || !selectedRoom) return;
    if (!form.code.trim()) { toast.error('Room code required', 'A room needs a code.'); return; }
    const room = selectedRoom;
    const changes = limitChanges(room, form);
    if (changes.length > 0 && !reason) { setLimitReason({ changes }); return; }
    const body = { ...roomBody(room, form, null), ...(reason ? { reason } : {}) };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => {
      await put(`/api/floorplans/${plan.id}/rooms/${room.id}`, body, pw);
      await saveMembership(room.id, form.instrumentIds, pw);
    }, { title: 'Room saved', message: `"${body.code}" saved on ${plan.name}.` });
  };

  /**
   * A geometry change: the stored room with new corners, saved on release.
   * With `map` — the outline's edges were RENUMBERED (a corner added or
   * deleted) — every door and every opening that starts on this room moves
   * with its wall, in the same request (`linkEdges`), or the change is
   * refused here when an opening would sit on no wall (audit 2026-10-12
   * finding 3). A move or a corner drag keeps the numbering and sends none.
   */
  const saveGeometry = (roomId: string, points: Polygon, map?: SpanMap) => {
    if (!plan) return;
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    let form = formOf(room);
    let linkEdges: { id: string; fromEdge: number; offset: number; width: number }[] = [];
    if (map) {
      const old = roomPolygon(room);
      const openings = remapOpenings(plan.links, room.id, map);
      if (openings.off.length) {
        dispatch({ type: 'flash', message: `That change takes ${openings.off.map((l) => `${codeOfSafe(l.fromRoomId)} ↔ ${codeOfSafe(l.toRoomId)}`).join(', ')} off its wall. Delete the opening first.` });
        return;
      }
      const moved = remapDoors(room.doors ?? [], old, map);
      if (moved.dropped && !window.confirm(`${moved.dropped} door(s) of "${room.code}" no longer sit on one wall of the new outline and will be removed. Continue?`)) return;
      form = { ...form, doors: moved.doors };
      linkEdges = openings.linkEdges;
    }
    const body = { ...roomBody(room, form, points), ...(linkEdges.length ? { linkEdges } : {}) };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => { await put(`/api/floorplans/${plan.id}/rooms/${room.id}`, body, pw); }, null);
  };

  /** A corner added on `edge` (double-click a wall): the edges after it are renumbered. */
  const insertCorner = (roomId: string, edge: number, point: { x: number; y: number }) => {
    const room = plan?.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const poly = roomPolygon(room);
    saveGeometry(roomId, [...poly.slice(0, edge + 1), point, ...poly.slice(edge + 1)], insertCornerMap(poly, edge, point));
  };

  const placeDoor = (roomId: string, door: RoomDoor) => {
    if (!plan) return;
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const f = { ...formOf(room), doors: [...(room.doors ?? []), door] };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => { await put(`/api/floorplans/${plan.id}/rooms/${room.id}`, roomBody(room, f, null), pw); }, null);
  };

  const deleteRoom = () => {
    if (!plan || !selectedRoom) return;
    const room = selectedRoom;
    const held = planDetail?.rooms.find((r) => r.id === room.id)?.instruments?.length ?? 0;
    const links = plan.links.filter((l) => l.fromRoomId === room.id || l.toRoomId === room.id).length;
    if ((held || links) && !window.confirm(`Delete "${room.code}"? ${held ? `${held} instrument(s) become unplaced. ` : ''}${links ? `${links} link(s) go with it.` : ''}`)) return;
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => { await del(`/api/floorplans/${plan.id}/rooms/${room.id}`, pw); },
      { title: 'Room deleted', message: `"${room.code}" removed.` }, () => dispatch({ type: 'select', selection: null }));
  };

  /** The one adjoining piece the selected room could merge with, if any. */
  const mergeCandidate = useMemo(() => {
    if (!plan || !selectedRoom) return null;
    const base = (code: string) => continuationBase(code) ?? code.toUpperCase();
    const a = selectedRoom;
    const cands = plan.rooms.filter((b) => b.id !== a.id
      && ((a.grade === 'CIRCULATION' && b.grade === 'CIRCULATION') || base(a.code) === base(b.code))
      && sharedEdges(roomPolygon(a), roomPolygon(b)).length > 0);
    if (cands.length !== 1) return null;
    const union = unionRectilinear(roomPolygon(a), roomPolygon(cands[0]));
    return union ? { other: cands[0], union } : null;
  }, [plan, selectedRoom]);

  const mergePieces = () => {
    if (!plan || !selectedRoom || !mergeCandidate) return;
    const a = selectedRoom, b = mergeCandidate.other;
    const union = mergeCandidate.union;
    // The outline is REPLACED, so doors and openings are found again on it by
    // geometry (finding 3): A's own, and B's doors too, wherever they still sit
    // on a wall of the union. An opening between the two pieces is inside the
    // merged room; B's other links go with B. ONE request (POST .../merge):
    // the server deletes the links, reshapes A, moves the instruments and
    // deletes B in one transaction, so a refusal leaves everything as it was.
    const between = plan.links.filter((l) => (l.fromRoomId === a.id && l.toRoomId === b.id) || (l.fromRoomId === b.id && l.toRoomId === a.id));
    const bOther = plan.links.filter((l) => (l.fromRoomId === b.id || l.toRoomId === b.id) && !between.includes(l));
    const openings = remapOpenings(plan.links.filter((l) => !between.includes(l)), a.id, geometricMap(roomPolygon(a), union));
    if (openings.off.length) {
      dispatch({ type: 'flash', message: `Merging takes ${openings.off.map((l) => `${codeOfSafe(l.fromRoomId)} ↔ ${codeOfSafe(l.toRoomId)}`).join(', ')} off its wall. Delete the opening first.` });
      return;
    }
    const aDoors = remapDoors(a.doors ?? [], roomPolygon(a), geometricMap(roomPolygon(a), union));
    const bDoors = remapDoors(b.doors ?? [], roomPolygon(b), geometricMap(roomPolygon(b), union));
    const dropped = aDoors.dropped + bDoors.dropped;
    const notes = [
      dropped ? `${dropped} door(s) no longer on a wall are removed.` : null,
      bOther.length ? `${bOther.length} link(s) of "${b.code}" are deleted with it.` : null,
    ].filter(Boolean).join(' ');
    if (!window.confirm(`Merge "${b.code}" into "${a.code}"? Its instruments move to "${a.code}" and "${b.code}" is deleted.${notes ? ` ${notes}` : ''}`)) return;
    const doors = [...aDoors.doors, ...bDoors.doors];
    const body = { otherRoomId: b.id, points: union, doors: doors.length ? doors : null, ...(openings.linkEdges.length ? { linkEdges: openings.linkEdges } : {}) };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => {
      await post(`/api/floorplans/${plan.id}/rooms/${a.id}/merge`, body, pw);
    }, { title: 'Pieces merged', message: `"${b.code}" is now part of "${a.code}".` });
  };

  // ── Links ──────────────────────────────────────────────────────────────────
  const createLink = (fromId: string, toId: string, shared: SharedEdge | null) => {
    if (!plan) return;
    const w = shared ? Math.min(0.3, shared.end - shared.start) : 0;
    const body = shared
      ? { fromRoomId: fromId, toRoomId: toId, kind: 'OPENING', fromEdge: shared.aEdge, offset: Math.round((shared.start + (shared.end - shared.start - w) / 2) * 1e6) / 1e6, width: Math.round(w * 1e6) / 1e6, door: null }
      : { fromRoomId: fromId, toRoomId: toId, kind: 'CONNECTOR', label: null };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => {
      const made = await post<{ id: string }>(`/api/floorplans/${plan.id}/links`, body, pw);
      dispatch({ type: 'cancel' });
      dispatch({ type: 'select', selection: { kind: 'link', linkId: made.id } });
    }, { title: shared ? 'Opening added' : 'Connector added' });
  };

  const updateLink = (patch: { door?: DoorKind | null; label?: string | null }) => {
    if (!plan || !selectedLink) return;
    const l = selectedLink;
    const body = { fromRoomId: l.fromRoomId, toRoomId: l.toRoomId, kind: l.kind, fromEdge: l.fromEdge, offset: l.offset, width: l.width, door: l.door, label: l.label, ...patch };
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => { await put(`/api/floorplans/${plan.id}/links/${l.id}`, body, pw); }, null);
  };

  const deleteLink = () => {
    if (!plan || !selectedLink) return;
    const l = selectedLink;
    run('UPDATE_FLOORPLAN_ROOM', async (pw) => { await del(`/api/floorplans/${plan.id}/links/${l.id}`, pw); },
      { title: 'Link deleted' }, () => dispatch({ type: 'select', selection: null }));
  };

  const deleteSelection = () => {
    if (!state.selection) return;
    // A structure element first: the Delete key takes the element, never a room selected beside it.
    if (state.selection.kind === 'structure') { removeStructure(state.selection.layer, state.selection.index); return; }
    if (state.selection.kind === 'link') deleteLink();
    else if (state.selection.kind === 'corner' && selectedRoom) {
      const poly = roomPolygon(selectedRoom);
      if (poly.length <= 3) { dispatch({ type: 'flash', message: 'A room needs at least three corners.' }); return; }
      const idx = state.selection.index;
      saveGeometry(selectedRoom.id, poly.filter((_, i) => i !== idx), deleteCornerMap(poly, idx));
      dispatch({ type: 'select', selection: { kind: 'room', roomId: selectedRoom.id } });
    } else if (state.selection.kind === 'door' && selectedRoom) {
      // Remove ONE door: the room's stored doors without that entry, saved at
      // once through the room endpoint (a door is part of the room record).
      const room = selectedRoom;
      const idx = state.selection.index;
      const doors = (room.doors ?? []).filter((_, i) => i !== idx);
      run('UPDATE_FLOORPLAN_ROOM', async (pw) => {
        await put(`/api/floorplans/${plan!.id}/rooms/${room.id}`, roomBody(room, { ...formOf(room), doors }, null), pw);
      }, { title: 'Door removed' }, () => dispatch({ type: 'select', selection: { kind: 'room', roomId: room.id } }));
    } else if (state.selection.kind === 'room') deleteRoom();
  };

  const selectionLabel = !state.selection ? null
    : state.selection.kind === 'room' ? `room ${selectedRoom?.code ?? ''}`
    : state.selection.kind === 'corner' ? `corner ${state.selection.index + 1} of ${selectedRoom?.code ?? ''}`
    : state.selection.kind === 'door' ? `door ${state.selection.index + 1} of ${selectedRoom?.code ?? ''}`
    : state.selection.kind === 'structure' ? `${state.selection.layer.replace(/s$/, '')} ${state.selection.index + 1}`
    : selectedLink ? `${selectedLink.kind === 'OPENING' ? 'opening' : 'connector'} ${codeOfSafe(selectedLink.fromRoomId)} ↔ ${codeOfSafe(selectedLink.toRoomId)}` : 'link';

  const tracingSrc = plan?.imagePath ? `${getApiBase()}${plan.imagePath}` : null;
  const codeOf = (id: string) => plan?.rooms.find((r) => r.id === id)?.code ?? '?';

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHero
        title="Layout Designer"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Layout Designer' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={planId}
              onChange={(e) => { setPlanId(e.target.value); dispatch({ type: 'setTool', tool: 'select' }); setPending(null); }}
              className="ctl h-8 text-slate-900"
              aria-label="Plan"
            >
              {plans.length === 0 && <option value="">No plans yet</option>}
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Button size="sm" className="border border-white/30 bg-white/10 text-white hover:bg-white/20" onClick={() => setNewPlan({ name: '', preset: 'landscape' })}>New plan</Button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadTracing(f); }} />
            {plan && <Button size="sm" className="border border-white/30 bg-white/10 text-white hover:bg-white/20" onClick={() => fileRef.current?.click()}>Tracing image</Button>}
            {plan && (
              <Button size="sm" className="border border-red-300/60 bg-red-500/25 text-white hover:bg-red-500/40" onClick={deletePlan} disabled={saving} aria-label={`Delete plan ${plan.name}`}>
                Delete plan
              </Button>
            )}
          </div>
        }
      />

      {newPlan && (
        <FormSection title="New plan" columns={1}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="ld-plan-name" className="mb-1 block text-xs font-medium text-slate-600">Name</label>
              <Input id="ld-plan-name" value={newPlan.name} onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="ld-plan-size" className="mb-1 block text-xs font-medium text-slate-600">Canvas</label>
              <select id="ld-plan-size" value={newPlan.preset} onChange={(e) => setNewPlan({ ...newPlan, preset: e.target.value as typeof newPlan.preset })} className="ctl w-full">
                {CANVAS_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={createPlan} disabled={saving}>Create plan</Button>
            <Button variant="ghost" onClick={() => setNewPlan(null)} disabled={saving}>Cancel</Button>
          </div>
        </FormSection>
      )}

      {!plan ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm text-slate-600">No plan yet.</p>
          <p className="mt-1 text-xs text-slate-500">Create a blank plan, or one from a drawing, to start designing.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)]">
          {/* Toolbar */}
          <div className="flex flex-row flex-wrap gap-1 lg:flex-col" role="toolbar" aria-label="Tools">
            {tools.map((t) => (
              <Button
                key={t.id}
                variant={state.tool === t.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => { dispatch({ type: 'setTool', tool: t.id }); setPending(null); }}
                aria-pressed={state.tool === t.id}
                title={t.hint}
                className="justify-start"
              >
                {t.label}
              </Button>
            ))}
            {/* REMOVE whatever is selected — a room, a corner, a door, a link
                (operator, 2026-09-22: "add remove option for lines or links or
                any other things"). The same act as the Delete key. */}
            <Button
              size="sm"
              variant="outline"
              onClick={deleteSelection}
              disabled={!state.selection || saving}
              title={selectionLabel ? `Remove ${selectionLabel} (Delete)` : 'Select a room, corner, door or link to remove it'}
              className="mt-2 justify-start border-red-200 text-red-700 hover:bg-red-50"
            >
              Remove{selectionLabel ? `: ${selectionLabel}` : ''}
            </Button>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} className="ctl-check" /> Snap to grid
            </label>
            {tracingSrc && (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                Guide
                <input type="range" min={0} max={1} step={0.05} value={guideOpacity} onChange={(e) => setGuideOpacity(Number(e.target.value))} className="w-20" aria-label="Tracing guide opacity" />
              </label>
            )}
            {state.drawing && (
              <div className="mt-2 flex flex-col gap-1">
                <Button size="sm" variant="outline" onClick={closePolygon}>Close outline</Button>
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'undoCorner' })}>Undo corner</Button>
              </div>
            )}
          </div>

          <div className="min-w-0 space-y-2">
            <DesignerCanvas
              plan={plan}
              state={state}
              dispatch={dispatch}
              pending={pending?.points ?? null}
              tracingSrc={tracingSrc}
              guideOpacity={guideOpacity}
              showGrid={showGrid}
              onClosePolygon={closePolygon}
              onMoveRoom={saveGeometry}
              onCornerChange={(roomId, points) => saveGeometry(roomId, points)}
              onInsertCorner={insertCorner}
              onPlaceDoor={placeDoor}
              onLink={createLink}
              annotations={annotations}
              arch={arch}
              onAddStructure={addStructure}
              onMoveStructure={updateStructure}
            />
            <p className="text-xs text-slate-500" role="status">
              {state.message
                ? <span className="font-medium text-red-700">{state.message}</span>
                : state.drawing
                  ? `${state.drawing.length} corner${state.drawing.length === 1 ? '' : 's'} — Enter or click the first corner to close, Escape to discard.`
                  : state.tool === 'link' && state.linkFrom
                    ? `Linking from ${codeOf(state.linkFrom)} — click the second room.`
                    : tools.find((t) => t.id === state.tool)?.hint}
            </p>
          </div>
        </div>
      )}

      {plan && !pending && !selectedRoom && !selectedLink && !selectedStructure && (
        <PlanPropertiesPanel
          planName={plan.name} annotations={annotations} saving={saving}
          scriptDrawn={SCRIPT_DRAWN_PLANS.includes(plan.name)}
          onSave={(next) => saveAnnotations(() => next, { title: 'Plan saved', message: `${plan.name}: ${next.style === 'architectural' ? '2D architectural' : 'standard'} style.` })}
        />
      )}
      {plan && pending && (
        <RoomPropertiesPanel
          mode="new" form={form} setForm={setForm} instruments={instruments} roomOfInstrument={roomOfInstrument}
          roomId={null} saving={saving} onSave={createRoom} onDelete={() => undefined} onCancel={() => setPending(null)}
          onMerge={null} mergeLabel={null}
        />
      )}
      {plan && !pending && selectedRoom && (
        <RoomPropertiesPanel
          mode="edit" form={form} setForm={setForm} instruments={instruments} roomOfInstrument={roomOfInstrument}
          roomId={selectedRoom.id} saving={saving} onSave={() => saveRoomProps()} onDelete={deleteRoom}
          onCancel={() => dispatch({ type: 'select', selection: null })}
          onMerge={mergeCandidate ? mergePieces : null}
          mergeLabel={mergeCandidate ? `Merge with ${mergeCandidate.other.code}` : null}
        />
      )}
      {plan && selectedLink && (
        <LinkPropertiesPanel
          link={selectedLink} fromCode={codeOf(selectedLink.fromRoomId)} toCode={codeOf(selectedLink.toRoomId)}
          saving={saving} onChange={updateLink} onDelete={deleteLink} onCancel={() => dispatch({ type: 'select', selection: null })}
        />
      )}

      {plan && selectedStructure && annotations[selectedStructure.layer][selectedStructure.index] && (
        <StructurePropertiesPanel
          layer={selectedStructure.layer} index={selectedStructure.index}
          element={annotations[selectedStructure.layer][selectedStructure.index] as StructureElement}
          saving={saving}
          onChange={(el) => updateStructure(selectedStructure.layer, selectedStructure.index, el)}
          onRefuse={(reason) => toast.error('Not saved', reason)}
          onDelete={() => removeStructure(selectedStructure.layer, selectedStructure.index)}
          onCancel={() => dispatch({ type: 'select', selection: null })}
        />
      )}

      <RemarkDialog
        open={limitReason !== null}
        title={`Change ${limitReason?.changes.length === 1 ? 'a room limit' : 'room limits'} — ${selectedRoom?.code ?? ''}`}
        attributeKey=""
        from=""
        changes={limitReason?.changes ?? []}
        busy={saving}
        onSubmit={(reason) => { setLimitReason(null); saveRoomProps(reason); }}
        onClose={() => setLimitReason(null)}
      />
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Save Layout"
      />
    </div>
  );
}

const EMPTY_ROOM: DesignerRoom = {
  id: '', code: '', label: null, x: 0, y: 0, w: 0, h: 0,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, grade: null, doors: null, points: null,
};
