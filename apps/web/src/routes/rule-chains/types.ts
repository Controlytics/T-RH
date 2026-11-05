import type { CSSProperties } from 'react';
import type { RuleChainDocument, RuleNodeGroup } from '@digilog/shared';

/**
 * The wire shapes of `/api/rule-chains` (rule chains, 2026-11-04) as the routes
 * send them — `apps/api/src/modules/rule-engine/routes.ts`. Nothing here is
 * decided in the browser: the list, the document, the stats and the debug
 * events are printed as returned.
 */

/** `GET /api/rule-chains` — root first, then by name. `updatedBy` is null on the seeded chain. */
export interface RuleChainSummary {
  id: string;
  name: string;
  root: boolean;
  debugMode: boolean;
  nodeCount: number;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * `GET /api/rule-chains/:id`. The document is read FORGIVINGLY by the server;
 * every stored credential comes back as `"***"`, to EVERY caller (ruling
 * T2-D), and a PUT that sends `"***"` keeps the stored value.
 */
export interface RuleChainDetail {
  id: string;
  name: string;
  root: boolean;
  debugMode: boolean;
  reEnterOnRuleNodeWrites: boolean;
  document: RuleChainDocument;
  updatedAt: string;
  updatedBy: string | null;
}

/** `GET /api/rule-chains/stats` — zeros in a process whose engine is not started. */
export interface RuleEngineStats {
  enabled: boolean;
  queueDepth: number;
  dropped: number;
  processedLastMinute: number;
  chains: { id: string; processedLastMinute: number }[];
}

/**
 * One row of `GET /api/rule-chains/:id/debug`, newest first. `relation` on an
 * IN row is the relation it ARRIVED on (null at a chain's first node); on an
 * OUT row the one it left on, with the engine's suffixes (`Failure
 * (unhandled)`, `<relation> (unconnected)`, `<label> (no caller)`).
 */
export interface RuleDebugEvent {
  id: string;
  chainId: string;
  nodeId: string;
  ts: string;
  direction: string;
  relation: string | null;
  msgId: string;
  msgType: string;
  originatorType: string;
  originatorId: string;
  data: unknown;
  metadata: unknown;
  error: string | null;
}

/** `POST /api/rule-chains/import` → 201. */
export interface RuleChainImportResult {
  id: string;
  warnings: string[];
}

export type RuleScriptKind = 'filter' | 'switch' | 'transform' | 'generator' | 'log' | 'details';

/** What the server sends in place of a stored credential, and keeps when it comes back. */
export const MASKED_SECRET = '***';

/** `RULE_CHAIN_REASON_MAX` in the API's service — a longer reason is a 400. */
export const RULE_CHAIN_REASON_MAX = 1000;

/** The canvas id of the fixed Input node. Never a document node: it IS the chain's `firstNodeId`. */
export const INPUT_NODE_ID = '__rule-chain-input';

/** The one re-auth action every rule chain write is signed with. */
export const RULE_CHAIN_REAUTH_ACTION = 'UPDATE_RULE_CHAIN';

/**
 * ThingsBoard's group colours, as TOKENS (`--rc-group-<group>`), set once on
 * the editor's root and read by the palette, the node cards and the minimap.
 * Each carries DARK ink (`--rc-ink`): every pair is at least 6:1, pinned by
 * `__tests__/group-colors.test.ts`.
 */
export const RULE_GROUP_COLORS: Readonly<Record<RuleNodeGroup, string>> = {
  filter: '#f1e861',
  enrichment: '#cdf1b5',
  transformation: '#79cef1',
  action: '#f1928f',
  external: '#fbc4ff',
  flow: '#d6cdf8',
};

/** The ink on every group colour (slate-800). */
export const RULE_GROUP_INK = '#1e293b';
/** A node with no counterpart here (Unsupported, later, none). */
export const RULE_UNSUPPORTED_COLOR = '#e2e8f0';
/** The fixed Input node. */
export const RULE_INPUT_COLOR = '#a7f3d0';

export function groupColorVar(group: RuleNodeGroup | null): string {
  return group ? `var(--rc-group-${group})` : 'var(--rc-unsupported)';
}

/** The tokens, as a style object for the editor's root element. */
export function ruleGroupTokens(): CSSProperties {
  const vars: Record<string, string> = {
    '--rc-ink': RULE_GROUP_INK,
    '--rc-unsupported': RULE_UNSUPPORTED_COLOR,
    '--rc-input': RULE_INPUT_COLOR,
  };
  for (const [group, colour] of Object.entries(RULE_GROUP_COLORS)) vars[`--rc-group-${group}`] = colour;
  return vars as CSSProperties;
}

/** WCAG 2.x contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
