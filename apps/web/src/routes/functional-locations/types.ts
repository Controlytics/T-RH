/**
 * The shape `GET /api/functional-locations` returns, shared by the list grid and
 * the detail page.
 *
 * Lives in its own module so the two lazy route chunks don't import each other:
 * a type-only import is erased at build time, but it puts `detail` and `index` in
 * the same module graph and the first non-type import would make it a real cycle.
 */
export interface FlNode {
  id: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  parentId: string | null;
  /** Instruments linked DIRECTLY to this location. */
  ownCount: number;
  /** A Block's own instruments PLUS every Area's. Equals ownCount for an Area. */
  totalCount: number;
  children?: FlNode[];
}
