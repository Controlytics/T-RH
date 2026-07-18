/**
 * Filter Operations — leaf helpers extracted from filter-operations.service.ts.
 *
 * Pure / side-effecting helper functions that the service file used at
 * top-level scope. Split out so the orchestrator class is easier to read.
 * No behavioral changes — these are byte-equivalent moves.
 */
import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

export function computeChecksum(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Format a Date as its LOCAL calendar day 'YYYY-MM-DD' — server-local is the
 * site's local time on this single-site local-Windows deployment.
 *
 * Used for the filter's `lastCleaningDate` stamp. `toISOString().slice(0,10)`
 * yields the UTC day, which is off-by-one for the operator near local midnight:
 * a cleaning completed 02:00 IST (UTC+5:30) has an ISO instant of the PREVIOUS
 * calendar day, so "Last Cleaned" recorded yesterday. `getFullYear/getMonth/
 * getDate` read local-time components, so this reflects the operator's real day.
 */
export function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Pretty-print a stateKey like "WASH_IN" → "Wash In" for operator-facing error messages. */
export function prettyStageLabel(stateKey: string | null | undefined): string {
  if (!stateKey) return 'this stage';
  return stateKey
    .split('_')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Walk the pipeline from a given stage and collect CHECKLIST nodes
 * that sit between it and the next STAGE/END node.
 */
export function collectChecklistsAfterStage(
  stage: any,
  allStages: any[],
  connections: any[],
): any[] {
  const checklists: any[] = [];
  const visited = new Set<string>();

  function walk(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const outConns = connections.filter((c: any) => c.fromStageId === nodeId);
    for (const conn of outConns) {
      const next = allStages.find((s: any) => s.id === conn.toStageId);
      if (!next) continue;
      if (next.nodeType === 'CHECKLIST') {
        checklists.push(next);
        walk(next.id);
      }
    }
  }

  walk(stage.id);
  return checklists;
}

/**
 * Resolve checklist questions for CHECKLIST pipeline nodes.
 *
 * Phase A.1: when `versionPins` is provided (cycle's pinned-version map), we
 * resolve questions through the immutable ChecklistProfileVersion snapshot
 * for that exact version. Edits to the live profile after the cycle started
 * have NO effect on the questions the operator sees. When `versionPins` is
 * not provided (legacy cycles started before this column existed, or
 * out-of-cycle preview), we fall back to live profile resolution.
 */
export async function resolveChecklistQuestions(
  checklistNodes: any[],
  versionPins?: Record<string, number> | null,
): Promise<any[]> {
  const profileIds = [...new Set(
    checklistNodes.map(n => (n.configuration as any)?.checklistProfileId).filter(Boolean),
  )];
  if (profileIds.length === 0) return [];

  // Resolve from pinned versions where pinned, live profile otherwise.
  type ResolvedProfile = { id: string; name: string; version: number; questions: any[] };
  const resolved = new Map<string, ResolvedProfile>();

  // 1. Pinned-version resolution: load each pin from ChecklistProfileVersion.
  const pinnedIds: string[] = [];
  if (versionPins) {
    for (const id of profileIds) {
      if (typeof versionPins[id] === 'number') pinnedIds.push(id);
    }
  }
  if (pinnedIds.length > 0) {
    const versions = await prisma.checklistProfileVersion.findMany({
      where: {
        OR: pinnedIds.map(id => ({ profileId: id, versionNumber: versionPins![id] })),
      },
    });
    for (const v of versions) {
      const snap = (v.snapshot as any) ?? {};
      resolved.set(v.profileId, {
        id: v.profileId,
        name: snap.name ?? '(unnamed)',
        version: v.versionNumber,
        questions: Array.isArray(snap.questions) ? snap.questions : [],
      });
    }
  }

  // 2. Live fallback for any unresolved IDs (legacy cycles, out-of-cycle previews).
  const unresolvedIds = profileIds.filter(id => !resolved.has(id));
  if (unresolvedIds.length > 0) {
    const profiles = await prisma.checklistProfile.findMany({
      where: { id: { in: unresolvedIds } },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
    for (const p of profiles) {
      resolved.set(p.id, {
        id: p.id,
        name: p.name,
        version: p.version,
        questions: p.questions,
      });
    }
  }

  const result: any[] = [];
  for (const node of checklistNodes) {
    const checklistProfileId = (node.configuration as any)?.checklistProfileId;
    const profile = checklistProfileId ? resolved.get(checklistProfileId) : undefined;
    if (!profile) continue;

    result.push({
      pipelineNodeId: node.id,
      checklistProfileId: profile.id,
      checklistProfileName: profile.name,
      profileVersion: profile.version,
      questions: profile.questions.map((q: any) => ({
        id: q.id,
        question: q.question,
        questionType: q.questionType,
        required: q.required,
        section: q.section ?? null,
        description: q.description ?? null,
        options: q.options ?? [],
        validation: q.validation ?? {},
        sortOrder: q.sortOrder,
      })),
    });
  }
  return result;
}
