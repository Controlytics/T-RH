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
}

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
