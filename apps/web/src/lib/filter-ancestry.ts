export interface AncestryInstance {
  id: string;
  templateId?: string | null;
  parentId?: string | null;
}

export interface FilterAncestry {
  ahuId: string | null;
  areaId: string | null;
  blockId: string | null;
}

/** Guards against a parent cycle in the data spinning the render loop. */
const MAX_DEPTH = 16;

/**
 * Resolve a filter's AHU / Area / Block by walking its parent chain and
 * labelling each ancestor by WHAT IT IS, not by how far up it sits.
 *
 * The hierarchy is not a fixed depth in practice. Live data (2026-07-17) has 26
 * AHUs under an Area but 3 under a Block directly — Block > AHU > Filter, with
 * no Area. The previous positional walk (`ahu.parent` = area, `area.parent` =
 * block) mislabelled that Block as the area and reported `blockId: null`, so 28
 * filters silently disappeared whenever a block was selected.
 *
 * Kind comes from the asset TEMPLATE — `/api/assets/instances` returns
 * `templateId` but no `templateKind` — hence the injected `kindOf`.
 *
 * The NEAREST ancestor of each kind wins, and unrecognised kinds are stepped
 * over rather than ending the walk.
 */
export function resolveAncestry(
  filter: AncestryInstance,
  instById: Map<string, AncestryInstance>,
  kindOf: (instance: AncestryInstance) => string | null,
): FilterAncestry {
  const ancestry: FilterAncestry = { ahuId: null, areaId: null, blockId: null };
  const seen = new Set<string>([filter.id]);

  let current = filter.parentId ? instById.get(filter.parentId) : undefined;

  for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
    if (seen.has(current.id)) break;
    seen.add(current.id);

    switch (kindOf(current)) {
      case 'AHU':
        ancestry.ahuId ??= current.id;
        break;
      case 'AREA':
        ancestry.areaId ??= current.id;
        break;
      case 'BLOCK':
        ancestry.blockId ??= current.id;
        break;
      default:
        break;
    }

    current = current.parentId ? instById.get(current.parentId) : undefined;
  }

  return ancestry;
}
