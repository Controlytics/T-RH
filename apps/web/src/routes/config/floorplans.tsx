import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { api } from '@/lib/api-client';
import { getApiBase } from '@/lib/api-base';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { RoomDoor, DoorWall, DoorKind } from '@/routes/dashboard/room-geometry';
import { ROOM_GRADES, ROOM_GRADE_META } from '@/routes/dashboard/use-telemetry';

/**
 * Place rooms on a floor layout and give each one its environmental limits.
 *
 * Rooms are drawn by hand over the uploaded drawing. Nothing parses the PDF:
 * matching ~150 free-floating room labels to their enclosing polygons is a real
 * geometry problem, and only the rooms that actually contain instruments matter.
 *
 * Coordinates are stored NORMALIZED (0..1) against the image, never in pixels,
 * so a box holds its place at any zoom, any screen size, and survives
 * re-exporting the drawing at a different DPI. Every conversion goes through
 * `toNormalized` below, which also clamps — the client should never be able to
 * post geometry the server will reject.
 */

interface Room {
  id: string;
  code: string;
  label: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
  /** Cleanroom classification, or NULL when nobody has classified the room. */
  grade: string | null;
  doors: RoomDoor[] | null;
  instruments?: { id: string; code: string; name: string }[];
}

interface Plan {
  id: string;
  name: string;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  isActive: boolean;
  sortOrder: number;
  rooms: Room[];
}

/**
 * NOTE: `GET /api/instruments` returns no room information. Which room an
 * instrument belongs to comes from the plan detail response only — see
 * `planDetail` below.
 */
interface InstrumentRow {
  id: string;
  code: string;
  name: string;
}

/** A box being drawn or edited, in normalized units. */
interface Box { x: number; y: number; w: number; h: number }

type DragMode = { kind: 'draw' } | { kind: 'move'; roomId: string } | { kind: 'resize'; roomId: string };

const EMPTY_BOX: Box = { x: 0, y: 0, w: 0, h: 0 };

/** Pointer position → normalized image coordinates, clamped into the plan. */
function toNormalized(clientX: number, clientY: number, el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
  };
}

/** Two corners → a positive-extent box, whichever way the drag went. */
function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Blank string → null, so clearing a limit stores NULL rather than 0. */
function numOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const pct = (v: number) => `${v * 100}%`;

export function FloorplansConfigPage() {
  const { toast } = useToast();
  const reauth = useReauth();
  const { data: planData, mutate: mutatePlans } = useSWR<{ data: Plan[] }>('/api/floorplans');
  const { data: instrumentData } = useSWR<{ data: InstrumentRow[] }>('/api/instruments?limit=500');

  const plans = planData?.data ?? [];
  const instruments = useMemo(
    () => [...(instrumentData?.data ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [instrumentData],
  );

  const [planId, setPlanId] = useState<string>('');
  const plan = plans.find((p) => p.id === planId) ?? null;

  /**
   * The plan DETAIL response, which is the only place that says which
   * instruments are in which room.
   *
   * `GET /api/instruments` does NOT return `roomId` — an earlier version of
   * this page filtered on it, so every checkbox rendered unchecked no matter
   * what was actually assigned, and each save silently overwrote the room's
   * membership with whatever happened to be ticked. Read membership from the
   * server's own answer instead of inferring it.
   */
  const { data: planDetail, mutate: mutateDetail } = useSWR<Plan>(
    planId ? `/api/floorplans/${planId}` : null,
  );

  useEffect(() => {
    if (!planId && plans.length > 0) setPlanId(plans[0].id);
  }, [plans, planId]);

  /** instrumentId → the room it currently sits in, on this plan. */
  const roomOfInstrument = useMemo(() => {
    const map = new Map<string, { id: string; code: string }>();
    for (const room of planDetail?.rooms ?? []) {
      for (const i of room.instruments ?? []) map.set(i.id, { id: room.id, code: room.code });
    }
    return map;
  }, [planDetail]);

  // ── Room selection + form state ──────────────────────────────────────────
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const [form, setForm] = useState({
    code: '', label: '',
    // '' is the wire's NULL: "Not classified" is a real, common answer here and
    // must be selectable, not just the state before anyone touched the field.
    grade: '',
    tempMin: '', tempMax: '', rhMin: '', rhMax: '',
    instrumentIds: [] as string[],
    doors: [] as RoomDoor[],
  });
  const [saving, setSaving] = useState(false);
  /** How strongly the plan image shows through while tracing. */
  const [guideOpacity, setGuideOpacity] = useState(0.35);

  const selectedRoom = plan?.rooms.find((r) => r.id === selectedRoomId) ?? null;

  useEffect(() => {
    if (!selectedRoom) return;
    // Membership comes from the plan detail, never from the instruments list.
    const assigned = planDetail?.rooms.find((r) => r.id === selectedRoom.id)?.instruments ?? [];
    setForm({
      code: selectedRoom.code,
      label: selectedRoom.label ?? '',
      grade: selectedRoom.grade ?? '',
      tempMin: selectedRoom.tempMin?.toString() ?? '',
      tempMax: selectedRoom.tempMax?.toString() ?? '',
      rhMin: selectedRoom.rhMin?.toString() ?? '',
      rhMax: selectedRoom.rhMax?.toString() ?? '',
      instrumentIds: assigned.map((i) => i.id),
      doors: selectedRoom.doors ?? [],
    });
    setDraft({ x: selectedRoom.x, y: selectedRoom.y, w: selectedRoom.w, h: selectedRoom.h });
  }, [selectedRoomId, plan, planDetail]);

  // ── Dragging ─────────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ mode: DragMode; origin: { x: number; y: number }; start: Box } | null>(null);
  const [dragBox, setDragBox] = useState<Box | null>(null);

  const beginDraw = (e: React.PointerEvent) => {
    if (!canvasRef.current || e.button !== 0) return;
    const p = toNormalized(e.clientX, e.clientY, canvasRef.current);
    dragRef.current = { mode: { kind: 'draw' }, origin: p, start: EMPTY_BOX };
    setDragBox({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const beginMove = (e: React.PointerEvent, room: Room) => {
    if (!canvasRef.current || e.button !== 0) return;
    e.stopPropagation();
    setSelectedRoomId(room.id);
    const p = toNormalized(e.clientX, e.clientY, canvasRef.current);
    dragRef.current = { mode: { kind: 'move', roomId: room.id }, origin: p, start: { ...room } };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const beginResize = (e: React.PointerEvent, room: Room) => {
    if (!canvasRef.current || e.button !== 0) return;
    e.stopPropagation();
    setSelectedRoomId(room.id);
    const p = toNormalized(e.clientX, e.clientY, canvasRef.current);
    dragRef.current = { mode: { kind: 'resize', roomId: room.id }, origin: p, start: { ...room } };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !canvasRef.current) return;
    const p = toNormalized(e.clientX, e.clientY, canvasRef.current);

    if (d.mode.kind === 'draw') {
      setDragBox(boxFrom(d.origin, p));
      return;
    }
    if (d.mode.kind === 'move') {
      // Clamp the whole box inside the plan rather than letting an edge escape:
      // the server rejects x + w > 1, and a drag that silently fails to save is
      // worse than one that stops at the edge.
      const dx = p.x - d.origin.x;
      const dy = p.y - d.origin.y;
      setDraft({
        x: Math.min(1 - d.start.w, Math.max(0, d.start.x + dx)),
        y: Math.min(1 - d.start.h, Math.max(0, d.start.y + dy)),
        w: d.start.w, h: d.start.h,
      });
      return;
    }
    // resize from the bottom-right corner
    setDraft({
      x: d.start.x, y: d.start.y,
      w: Math.min(1 - d.start.x, Math.max(0.005, p.x - d.start.x)),
      h: Math.min(1 - d.start.y, Math.max(0.005, p.y - d.start.y)),
    });
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;

    if (d.mode.kind === 'draw') {
      const box = dragBox;
      setDragBox(null);
      // A click, not a drag. Deselect rather than creating a hotspot nobody can
      // hit.
      if (!box || box.w < 0.005 || box.h < 0.005) return;
      setSelectedRoomId(null);
      setDraft(box);
      setForm({ code: '', label: '', grade: '', tempMin: '', tempMax: '', rhMin: '', rhMax: '', instrumentIds: [], doors: [] });
    }
  };

  // ── Plan upload ──────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const uploadPlan = async (file: File) => {
    setUploading(true);
    try {
      // Read the natural dimensions here. The browser has already decoded the
      // image to display it; the server would need an image-parsing dependency
      // for a value only used as the aspect ratio the normalized coordinates
      // are drawn against.
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error('That file could not be read as an image.'));
        img.src = URL.createObjectURL(file);
      });

      const fd = new FormData();
      fd.append('file', file);
      const up = await api.postFormData<{ url: string }>('/api/uploads/floorplan', fd);

      const name = file.name.replace(/\.[^.]+$/, '');
      await api.post('/api/floorplans', {
        name, imagePath: up.url, imageWidth: dims.w, imageHeight: dims.h,
      });
      await Promise.all([mutatePlans(), mutateDetail()]);
      toast.success('Floorplan added', `"${name}" uploaded. Drag on it to place a room.`);
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : 'Could not upload that image.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // ── Doors ────────────────────────────────────────────────────────────────
  const DOOR_WIDTH = 0.12;

  /** Place a door centred on the click, clamped so it finishes on its wall. */
  const addDoor = (wall: DoorWall, t: number) => {
    if (form.doors.length >= 6) {
      toast.error('Too many doors', 'A room can carry at most six doors.');
      return;
    }
    const offset = Math.min(Math.max(t - DOOR_WIDTH / 2, 0), 1 - DOOR_WIDTH);
    const next: RoomDoor = { wall, offset, width: DOOR_WIDTH, kind: 'ENTRY' };
    // The server rejects overlaps; refusing here means the operator finds out on
    // the click rather than on the save, with the room already half-edited.
    const clash = form.doors.some(
      (d) => d.wall === wall && offset < d.offset + d.width && d.offset < offset + DOOR_WIDTH,
    );
    if (clash) {
      toast.error('Doors overlap', 'There is already a door here. Move or delete it first.');
      return;
    }
    setForm((f) => ({ ...f, doors: [...f.doors, next] }));
  };

  // ── Save / delete ────────────────────────────────────────────────────────
  const saveRoom = () => {
    if (!plan || !draft) return;
    if (!form.code.trim()) {
      toast.error('Room code required', 'Give the room the code it carries on the drawing, e.g. CWH-I/142.');
      return;
    }

    const body = {
      code: form.code.trim(),
      label: form.label.trim() || null,
      grade: form.grade || null,
      x: draft.x, y: draft.y, w: draft.w, h: draft.h,
      tempMin: numOrNull(form.tempMin), tempMax: numOrNull(form.tempMax),
      rhMin: numOrNull(form.rhMin), rhMax: numOrNull(form.rhMax),
      doors: form.doors.length > 0 ? form.doors : null,
    };

    setSaving(true);
    reauth.execute(
      'UPDATE_FLOORPLAN_ROOM',
      async (password?: string) => {
        const roomUrl = selectedRoom
          ? `/api/floorplans/${plan.id}/rooms/${selectedRoom.id}`
          : `/api/floorplans/${plan.id}/rooms`;

        const saved = selectedRoom
          ? (password ? await api.putWithReauth<Room>(roomUrl, body, password) : await api.put<Room>(roomUrl, body))
          : (password ? await api.postWithReauth<Room>(roomUrl, body, password) : await api.post<Room>(roomUrl, body));

        const memberUrl = `/api/floorplans/${plan.id}/rooms/${saved.id}/instruments`;
        const memberBody = { instrumentIds: form.instrumentIds };
        const res = password
          ? await api.putWithReauth<{ moved: { code: string; fromRoom: { code: string } | null }[] }>(memberUrl, memberBody, password)
          : await api.put<{ moved: { code: string; fromRoom: { code: string } | null }[] }>(memberUrl, memberBody);

        // An instrument can only be in one room, so assigning it here removed it
        // from wherever it was. Say so — discovering it later is worse.
        if (res.moved?.length) {
          // Non-blocking: the save succeeded, this is a consequence worth
          // surfacing, not something to make the operator acknowledge.
          toast.successToast(
            'Instruments moved',
            res.moved.map((m) => `${m.code} moved from ${m.fromRoom?.code ?? 'another room'}`).join('; '),
          );
        }
        setSelectedRoomId(saved.id);
      },
      {
        onSuccess: async () => {
          await Promise.all([mutatePlans(), mutateDetail()]);
          setSaving(false);
          toast.success('Room saved', `"${body.code}" saved on ${plan.name}.`);
        },
        onError: (e: unknown) => {
          setSaving(false);
          const msg = (e as { message?: string })?.message ?? 'Could not save the room.';
          toast.error('Save failed', msg);
        },
        onCancel: () => setSaving(false),
      },
    );
  };

  const deleteRoom = () => {
    if (!plan || !selectedRoom) return;
    const room = selectedRoom;
    setSaving(true);
    reauth.execute(
      'UPDATE_FLOORPLAN_ROOM',
      async (password?: string) => {
        const url = `/api/floorplans/${plan.id}/rooms/${room.id}`;
        if (password) await api.deleteWithReauth(url, password);
        else await api.delete(url);
      },
      {
        onSuccess: async () => {
          await Promise.all([mutatePlans(), mutateDetail()]);
          setSelectedRoomId(null);
          setDraft(null);
          setSaving(false);
          toast.success('Room deleted', `"${room.code}" removed. Its instruments are now unplaced.`);
        },
        onError: (e: unknown) => {
          setSaving(false);
          toast.error('Delete failed', (e as { message?: string })?.message ?? 'Could not delete the room.');
        },
        onCancel: () => setSaving(false),
      },
    );
  };

  const toggleInstrument = (id: string) => {
    setForm((f) => ({
      ...f,
      instrumentIds: f.instrumentIds.includes(id)
        ? f.instrumentIds.filter((v) => v !== id)
        : [...f.instrumentIds, id],
    }));
  };

  const liveBox = dragBox ?? draft;
  const imageSrc = plan ? `${getApiBase()}${plan.imagePath}` : '';

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Floorplans</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a floor layout, drag a box over each room that holds instruments, and set that room&rsquo;s
          temperature and humidity limits. The dashboard colours each room against these limits.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Plan</CardTitle>
          <div className="flex items-center gap-2">
            <select
              value={planId}
              onChange={(e) => { setPlanId(e.target.value); setSelectedRoomId(null); setDraft(null); }}
              className="ctl"
            >
              {plans.length === 0 && <option value="">No floorplans yet</option>}
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPlan(f); }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload plan'}
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {!plan ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
              <p className="text-sm text-slate-600">No floorplan yet.</p>
              <p className="mt-1 text-xs text-slate-500">
                Upload the floor layout image to start placing rooms.
              </p>
            </div>
          ) : (
            <div
              ref={canvasRef}
              onPointerDown={beginDraw}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              className="relative w-full select-none overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
              // Reserve the image's aspect ratio up front so the room overlay
              // does not jump once the image finishes loading.
              style={{ aspectRatio: `${plan.imageWidth} / ${plan.imageHeight}`, cursor: 'crosshair' }}
            >
              {/* TRACING GUIDE ONLY. The dashboard draws the rooms and never
                  shows this image, so it is faded here to sit behind the shapes
                  being drawn rather than compete with them. */}
              <img
                src={imageSrc}
                alt={`${plan.name} layout, tracing guide`}
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                style={{ opacity: guideOpacity }}
                draggable={false}
              />

              {plan.rooms.map((room) => {
                const isSelected = room.id === selectedRoomId;
                const box = isSelected && draft ? draft : room;
                return (
                  <div
                    key={room.id}
                    onPointerDown={(e) => beginMove(e, room)}
                    // Drawn the way the dashboard draws it — solid fill and a
                    // wall stroke — so tracing shows what the operator will
                    // actually get, not a transparent hotspot.
                    className={`absolute flex flex-col items-center justify-center overflow-hidden border-[2.5px] ${
                      isSelected
                        ? 'border-sky-600 bg-sky-100'
                        : 'border-slate-500 bg-slate-100 hover:bg-slate-200'
                    }`}
                    style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h), cursor: 'move' }}
                    title={`${room.code}${room.label ? ` — ${room.label}` : ''}`}
                  >
                    <span className="max-w-full truncate px-1 text-[10px] font-bold leading-tight text-slate-800">
                      {room.code}
                    </span>
                    {room.label && (
                      <span className="max-w-full truncate px-1 text-[9px] leading-tight text-slate-500">
                        {room.label}
                      </span>
                    )}
                    {isSelected && (
                      <span
                        onPointerDown={(e) => beginResize(e, room)}
                        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-sm border border-white bg-sky-600"
                        style={{ cursor: 'nwse-resize' }}
                      />
                    )}

                    {isSelected && (['top', 'right', 'bottom', 'left'] as DoorWall[]).map((wall) => {
                      const vertical = wall === 'left' || wall === 'right';
                      return (
                        <span
                          key={wall}
                          title={`Add a door on the ${wall} wall`}
                          onPointerDown={(e) => {
                            // Stop the room's own move-drag: placing a door must
                            // not also nudge the room out from under the pointer.
                            e.stopPropagation();
                            const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                            const t = vertical
                              ? (e.clientY - rect.top) / rect.height
                              : (e.clientX - rect.left) / rect.width;
                            addDoor(wall, t);
                          }}
                          className="absolute bg-sky-500/0 hover:bg-sky-500/40"
                          style={
                            vertical
                              ? { top: 0, bottom: 0, width: 8, [wall]: -4, cursor: 'copy' }
                              : { left: 0, right: 0, height: 8, [wall]: -4, cursor: 'copy' }
                          }
                        />
                      );
                    })}

                    {isSelected && form.doors.map((d, i) => {
                      const vertical = d.wall === 'left' || d.wall === 'right';
                      return (
                        <span
                          key={`${d.wall}-${i}`}
                          className="absolute bg-sky-600"
                          style={
                            vertical
                              ? { [d.wall]: -2, top: `${d.offset * 100}%`, height: `${d.width * 100}%`, width: 4 }
                              : { [d.wall]: -2, left: `${d.offset * 100}%`, width: `${d.width * 100}%`, height: 4 }
                          }
                        />
                      );
                    })}
                  </div>
                );
              })}

              {/* A box being drawn, or a new unsaved one */}
              {!selectedRoomId && liveBox && liveBox.w > 0 && (
                <div
                  className="pointer-events-none absolute border-2 border-dashed border-sky-600 bg-sky-500/20"
                  style={{ left: pct(liveBox.x), top: pct(liveBox.y), width: pct(liveBox.w), height: pct(liveBox.h) }}
                />
              )}
            </div>
          )}

          {plan && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                Drag on an empty area to draw a new room. Drag a box to move it, or its corner handle to resize.
                {plan.rooms.length > 0 && ` ${plan.rooms.length} room${plan.rooms.length === 1 ? '' : 's'} drawn.`}
              </p>
              <label className="flex items-center gap-2 text-xs text-slate-500">
                Guide
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={guideOpacity}
                  onChange={(e) => setGuideOpacity(Number(e.target.value))}
                  className="w-28"
                  aria-label="Tracing guide opacity"
                />
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      {plan && draft && (
        <Card>
          <CardHeader>
            <CardTitle>{selectedRoom ? `Edit ${selectedRoom.code}` : 'New room'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Room code</label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="CWH-I/142"
                />
                <p className="mt-1 text-xs text-slate-500">As it appears on the drawing.</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Label</label>
                <Input
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="WET LAB"
                />
                <p className="mt-1 text-xs text-slate-500">Optional, shown beside the code.</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Cleanroom grade</label>
                <select
                  value={form.grade}
                  onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))}
                  className="ctl w-full"
                >
                  <option value="">Not classified</option>
                  {ROOM_GRADES.map((g) => (
                    <option key={g} value={g}>
                      {ROOM_GRADE_META[g].label} — {ROOM_GRADE_META[g].name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Tints the room on the graphical view. Leave unclassified rather than guessing.
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-700">Limits</h3>
              <p className="mb-2 text-xs text-slate-500">
                Leave a field blank to leave that bound unchecked. A room with no limits is never out of limit.
              </p>
              <div className="grid gap-4 sm:grid-cols-4">
                {([
                  ['tempMin', 'Min temperature (°C)'],
                  ['tempMax', 'Max temperature (°C)'],
                  ['rhMin', 'Min humidity (%RH)'],
                  ['rhMax', 'Max humidity (%RH)'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
                    <Input
                      type="number"
                      value={form[key]}
                      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                      placeholder="—"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2">
              <p className="mb-1 text-xs font-semibold text-slate-700">Doors</p>
              {form.doors.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Click a wall of the selected room to place a door.
                </p>
              ) : (
                <ul className="space-y-1">
                  {form.doors.map((d, i) => (
                    <li key={`${d.wall}-${i}`} className="flex items-center gap-2 text-xs text-slate-600">
                      <span className="w-14 font-medium capitalize">{d.wall}</span>
                      <select
                        value={d.kind}
                        onChange={(e) => {
                          const kind = e.target.value as DoorKind;
                          setForm((f) => ({
                            ...f,
                            doors: f.doors.map((door, ix) => (ix === i ? { ...door, kind } : door)),
                          }));
                        }}
                        className="ctl ctl-sm"
                      >
                        <option value="ENTRY">Entry</option>
                        <option value="EXIT">Exit</option>
                        <option value="PASSAGE">Passage</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, doors: f.doors.filter((_, ix) => ix !== i) }))}
                        className="text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-700">Instruments in this room</h3>
              <p className="mb-2 text-xs text-slate-500">
                An instrument belongs to one room. Ticking it here moves it out of any room it is already in.
              </p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {instruments.length === 0 && (
                  <p className="p-2 text-sm text-slate-500">No instruments registered.</p>
                )}
                {instruments.map((i) => {
                  const elsewhere = roomOfInstrument.get(i.id);
                  const isHere = elsewhere?.id === selectedRoom?.id;
                  return (
                    <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={form.instrumentIds.includes(i.id)}
                        onChange={() => toggleInstrument(i.id)}
                      className="ctl-check" />
                      <span className="text-sm font-medium text-slate-800">{i.code}</span>
                      <span className="text-xs text-slate-500">{i.name}</span>
                      {/* Say where it already is, so a move is visible BEFORE
                          saving rather than discovered afterwards. */}
                      {elsewhere && !isHere && (
                        <span className="ml-auto rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                          in {elsewhere.code}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={saveRoom} disabled={saving}>
                {saving ? 'Saving…' : selectedRoom ? 'Save room' : 'Create room'}
              </Button>
              {selectedRoom && (
                <Button variant="outline" onClick={deleteRoom} disabled={saving}>
                  Delete room
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => { setSelectedRoomId(null); setDraft(null); }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Save Floorplan Room"
      />
    </div>
  );
}
