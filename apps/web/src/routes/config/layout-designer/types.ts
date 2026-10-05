import type { RoomDoor } from '@/routes/dashboard/room-geometry';
import type { FloorplanLinkShape } from '@/routes/dashboard/use-telemetry';

/** A room as the plan list returns it, plus the membership the plan DETAIL adds. */
export interface DesignerRoom {
  id: string;
  code: string;
  label: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
  grade: string | null;
  doors: RoomDoor[] | null;
  points: { x: number; y: number }[] | null;
  instruments?: { id: string; code: string; name: string }[];
}

export type DesignerLink = FloorplanLinkShape;

export interface DesignerPlan {
  id: string;
  name: string;
  imagePath: string | null;
  imageWidth: number;
  imageHeight: number;
  isActive: boolean;
  sortOrder: number;
  rooms: DesignerRoom[];
  links: DesignerLink[];
  /** The 2D layer (any shape the API returns); `normaliseAnnotations` is the ONE reader. */
  annotations?: unknown;
}

/** The 2D layer of a plan as the designer holds it: every array present. */
export interface StructureBox { x: number; y: number; w: number; h: number }
export interface StructureSegment { x1: number; y1: number; x2: number; y2: number }
export interface StructureLabel { x: number; y: number; text: string }
export type StructureLayer = 'columns' | 'windows' | 'walls' | 'equipment' | 'labels';
export interface DesignerAnnotations {
  style: 'standard' | 'architectural';
  columns: StructureBox[];
  windows: StructureBox[];
  equipment: StructureBox[];
  walls: StructureSegment[];
  labels: StructureLabel[];
  floor: { group: string; label: string; order: number } | null;
  north: number | null;
  /** The trace scripts' own layers, carried through untouched. */
  hvac?: unknown[]; water?: unknown[]; airflow?: unknown[];
}
export const EMPTY_ANNOTATIONS: DesignerAnnotations = {
  style: 'standard', columns: [], windows: [], equipment: [], walls: [], labels: [], floor: null, north: null,
};

/** A plan's stored `annotations` (any shape the API returns) as the designer's full object. */
export function normaliseAnnotations(a: unknown): DesignerAnnotations {
  if (!a || typeof a !== 'object') return { ...EMPTY_ANNOTATIONS };
  const o = a as Record<string, unknown>;
  const arr = <T,>(k: string): T[] => (Array.isArray(o[k]) ? (o[k] as T[]) : []);
  const floor = o.floor && typeof o.floor === 'object' ? (o.floor as DesignerAnnotations['floor']) : null;
  return {
    style: o.style === 'architectural' ? 'architectural' : 'standard',
    columns: arr('columns'), windows: arr('windows'), equipment: arr('equipment'), walls: arr('walls'), labels: arr('labels'),
    floor, north: typeof o.north === 'number' ? o.north : null,
    ...(Array.isArray(o.hvac) ? { hvac: o.hvac } : {}),
    ...(Array.isArray(o.water) ? { water: o.water } : {}),
    ...(Array.isArray(o.airflow) ? { airflow: o.airflow } : {}),
  };
}

export function isArchitectural(plan: { annotations?: unknown } | null | undefined): boolean {
  const a = plan?.annotations;
  return !!a && typeof a === 'object' && (a as { style?: unknown }).style === 'architectural';
}

/** A window drawn along a wall is stored as a thin box this deep, centred on the wall line. */
export const WINDOW_DEPTH = 0.008;

/**
 * Plans drawn by a script (`draw-architectural-floor.ts`, `draw-qc-layout-2.ts`):
 * editable here, but the script's `*-layout.ts` is their source of truth and a
 * re-run overwrites what the designer changed. The Plan panel says so.
 */
export const SCRIPT_DRAWN_PLANS = [
  'CWH — QC', 'CWH — QC Microbiology', 'CWH — QC 3', 'CWH — Module-E',
  'CWH — Module-F — Ground Floor', 'CWH — Module-F — First Floor',
];

/** The canvas presets a blank plan can start at (width × height, the aspect the plan is drawn at). */
export const CANVAS_PRESETS = [
  { key: 'landscape', label: 'Landscape (4:3)', width: 1600, height: 1200 },
  { key: 'portrait', label: 'Portrait (3:4)', width: 1200, height: 1600 },
  { key: 'square', label: 'Square', width: 1200, height: 1200 },
] as const;

/** Default door width as a fraction of its edge; six doors per room, as the API allows. */
export const DOOR_WIDTH = 0.12;
export const MAX_DOORS = 6;

/** The fill the designer paints a room with, by grade. Decoration, never status. */
export const DESIGNER_FILL: Record<string, string> = {
  A: '#e0f2fe', B: '#dcfce7', C: '#fef9c3', D: '#fee2e2', CIRCULATION: '#f1f5f9', UTILITY: '#f5f5f4',
};
