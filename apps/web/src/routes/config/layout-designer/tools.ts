import { validatePolygon, type Point, type Polygon } from '@digilog/shared';
import type { StructureLayer } from './types';

/**
 * The Layout Designer's tool state, as a pure reducer. The canvas turns
 * pointer and key events into these actions; nothing here touches the DOM or
 * the server, which is what makes the drawing rules testable one at a time.
 *
 * `drawing` is the OPEN outline of a room being drawn corner by corner. It is
 * unsaved state and the only thing undo covers: a saved change is a §11 record
 * and is reversed by another edit, never silently.
 */
export type Tool = 'select' | 'room' | 'corridor' | 'door' | 'link' | 'column' | 'equipment' | 'window' | 'wall' | 'label';

export type Selection =
  | { kind: 'room'; roomId: string }
  | { kind: 'corner'; roomId: string; index: number }
  | { kind: 'door'; roomId: string; index: number }
  | { kind: 'link'; linkId: string }
  | { kind: 'structure'; layer: StructureLayer; index: number }
  | null;

export interface DesignerState {
  tool: Tool;
  drawing: Point[] | null;
  selection: Selection;
  /** The first room clicked with the Link tool, until the second. */
  linkFrom: string | null;
  /** A one-line refusal shown beside the canvas ("the outline crosses itself"). */
  message: string | null;
}

export const initialState: DesignerState = { tool: 'select', drawing: null, selection: null, linkFrom: null, message: null };

export type DesignerAction =
  | { type: 'setTool'; tool: Tool }
  | { type: 'addCorner'; point: Point }
  | { type: 'undoCorner' }
  | { type: 'closePolygon' }
  | { type: 'cancel' }
  | { type: 'select'; selection: Selection }
  | { type: 'linkFirst'; roomId: string }
  | { type: 'flash'; message: string | null };

const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

export function reduce(s: DesignerState, a: DesignerAction): DesignerState {
  switch (a.type) {
    // A tool change is a fresh start: no half-drawn room, no pending link, no
    // selection carried into a tool that cannot act on it.
    case 'setTool': return { ...initialState, tool: a.tool };
    case 'addCorner': {
      const d = s.drawing ?? [];
      // A double click on the same spot is one corner, not two.
      if (d.length && same(d[d.length - 1], a.point)) return s;
      return { ...s, drawing: [...d, a.point], message: null };
    }
    case 'undoCorner': {
      if (!s.drawing || s.drawing.length === 0) return s;
      const d = s.drawing.slice(0, -1);
      return { ...s, drawing: d.length ? d : null };
    }
    case 'closePolygon': return { ...s, drawing: null, message: null };
    case 'cancel': return { ...s, drawing: null, linkFrom: null, message: null };
    case 'select': return { ...s, selection: a.selection };
    case 'linkFirst': return { ...s, linkFrom: a.roomId, message: null };
    case 'flash': return { ...s, message: a.message };
  }
}

/** The 2D structure tools (2026-10-05): a box is dragged, a segment is two clicks, a label is one. */
export const isBoxTool = (t: Tool): boolean => t === 'column' || t === 'equipment';
export const isSegmentTool = (t: Tool): boolean => t === 'window' || t === 'wall';
export const isStructureTool = (t: Tool): boolean => isBoxTool(t) || isSegmentTool(t) || t === 'label';
export function layerOfTool(t: Tool): StructureLayer | null {
  switch (t) {
    case 'column': return 'columns';
    case 'equipment': return 'equipment';
    case 'window': return 'windows';
    case 'wall': return 'walls';
    case 'label': return 'labels';
    default: return null;
  }
}

/** The open outline as a room, or the reason it is not one yet. */
export function closedPolygon(s: DesignerState): { ok: true; points: Polygon } | { ok: false; error: string } {
  if (!s.drawing) return { ok: false, error: 'nothing drawn' };
  return validatePolygon(s.drawing);
}
