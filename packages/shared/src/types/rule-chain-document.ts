/**
 * The rule chain DOCUMENT — rule chains (2026-11-03).
 *
 * Design: docs/superpowers/specs/2026-11-03-rule-chains-design.md §4, §5, §8.
 *
 * One rule chain = one document: its nodes (type, name, debug mode, ThingsBoard
 * configuration, canvas position), the labelled connections between them, and
 * the node the chain's Input feeds (`firstNodeId`; the Input itself is not a
 * node). The document is the source of truth; the API projects it into node and
 * connection rows on every save (ruling D-1).
 *
 * Two readers, on purpose, as for the dashboard document:
 *   `parseRuleChainDocument` is STRICT — every write. An unknown node type, a
 *     configuration its node's schema refuses, a dangling connection, a
 *     duplicate id: a ZodError whose message names the node. A write that keeps
 *     less than the author drew while reporting success is the trap.
 *   `readRuleChainDocument` is FORGIVING — every read. A node it cannot run
 *     reads as `tb:unsupported` (keeping its name, position and what it was), a
 *     dangling connection is dropped. One bad node must not blank a stored chain.
 *
 * ThingsBoard interchange: `toThingsboardExport` writes ThingsBoard's export
 * shape (`ruleChain` + `metadata.nodes / connections / firstNodeIndex`);
 * `fromThingsboardExport` reads it back — and reads a real ThingsBoard export:
 * 3.x `debugMode`, master's `debugAll` / `debugFailures`, 4.0-4.2's
 * `debugSettings`. Import MINTS NEW node ids (importing one file twice must not
 * collide) and never refuses a node: an unknown class, or a known one whose
 * configuration does not fit, becomes `tb:unsupported` with a warning; a
 * `later` / `none` class imports as itself, with a warning that it sends every
 * message to Failure.
 * `ruleChainsEqual` therefore compares STRUCTURE (node order), not ids.
 * Each node's `configurationVersion` (absent = 0) is brought up to the version
 * the catalogue models with ThingsBoard's own upgrade (`upgradeThingsboardConfig`)
 * BEFORE the string-scalar coercion and the validation; an older version with
 * no mirrored upgrade imports with a warning to review it. The export writes
 * the version each node's configuration is at (ruling CV-1).
 * Between the upgrade and the coercion, `fromThingsboardConfig` turns
 * ThingsBoard's exchange form into the ONE shape stored here (ruling CV-3 —
 * Save time series' `processingSettings` sets its toggle; a strategy not built
 * here warns once, naming it; ruling TB-L — a TBEL script node becomes
 * JavaScript running its TBEL script, one warning per node); the export writes
 * it back with `toThingsboardConfig`.
 */
import { z, ZodError, type ZodIssue } from 'zod';
import {
  RULE_NODE_TYPE_BY_ID, RULE_NODE_TYPE_BY_TB_CLASS, UNSUPPORTED_NODE_TYPE, RULE_DEBUG_MODES,
  RULE_NODE_NAME_MAX, RULE_CHAIN_NAME_MAX, RULE_CHAIN_NODES_MAX, RULE_RELATION_MAX,
  RULE_RELATION_OTHER, newRuleNodeConfig, coerceThingsboardScalars, upgradeThingsboardConfig,
  fromThingsboardConfig, toThingsboardConfig, entityTypeSwitchLabelFromThingsboard, entityTypeSwitchLabelToThingsboard,
  type RuleDebugMode,
} from './rule-nodes.js';

/** The one node whose connection LABELS are entity-type names (ruling SW-1). */
const ENTITY_TYPE_SWITCH = 'tb:filter:entity-type-switch';

export const RULE_CHAIN_DOCUMENT_VERSION = 1;
/** Connections one chain may hold. */
export const RULE_CHAIN_CONNECTIONS_MAX = 2_000;

/** ThingsBoard's name for its shipped root chain. */
export const DEFAULT_ROOT_CHAIN_NAME = 'Root Rule Chain';

/**
 * The shipped root chain's node ids. FIXED, because the migration that seeds the
 * chain writes them into SQL and a test compares the seeded row with
 * `defaultRootChainDocument()`. Never change one.
 */
export const DEFAULT_ROOT_CHAIN_NODE_IDS = Object.freeze({
  messageTypeSwitch: 'b1a7e000-0000-4000-8000-000000000001',
  saveTimeseries: 'b1a7e000-0000-4000-8000-000000000002',
  saveAttributes: 'b1a7e000-0000-4000-8000-000000000003',
  logOther: 'b1a7e000-0000-4000-8000-000000000004',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RuleChainNode {
  id: string;
  /** A catalogue id (`tb:filter:script` …) or `tb:unsupported`. */
  type: string;
  name: string;
  debugMode: RuleDebugMode;
  /** ThingsBoard's configuration keys for the type; for `tb:unsupported`, an `UnsupportedNodeConfig`. */
  config: Record<string, unknown>;
  x: number;
  y: number;
}

export interface RuleChainConnection {
  from: string;
  to: string;
  relation: string;
}

export interface RuleChainDocument {
  version: 1;
  firstNodeId: string | null;
  nodes: RuleChainNode[];
  connections: RuleChainConnection[];
}

/** What a `tb:unsupported` node remembers about the node it stands in for. */
export interface UnsupportedNodeConfig {
  /** ThingsBoard's class, when known — an export writes the node back as this class. */
  tbClass?: string;
  /** Our type id, when the node came from a stored document. */
  type?: string;
  /** The original configuration, untouched. */
  configuration?: unknown;
  /** The ThingsBoard configurationVersion it came with (when the export carried one). */
  configurationVersion?: number;
  /** Why it could not be read as its own type. */
  reason?: string;
}

// ─── Strict ──────────────────────────────────────────────────────────────────

const nodeIdSchema = z.string().regex(UUID_RE, 'Not a node id');

const nodeSchema = z.object({
  id: nodeIdSchema,
  type: z.string().min(1, 'A node needs a type').max(160),
  name: z.string().trim().min(1, 'A node needs a name').max(RULE_NODE_NAME_MAX, `A node name is at most ${RULE_NODE_NAME_MAX} characters`),
  debugMode: z.enum(RULE_DEBUG_MODES),
  config: z.record(z.unknown()),
  x: z.number().finite(),
  y: z.number().finite(),
});

const connectionSchema = z.object({
  from: nodeIdSchema,
  to: nodeIdSchema,
  relation: z.string().trim().min(1, 'A connection needs a relation').max(RULE_RELATION_MAX),
});

const documentShapeSchema = z.object({
  version: z.literal(RULE_CHAIN_DOCUMENT_VERSION),
  firstNodeId: nodeIdSchema.nullable(),
  nodes: z.array(nodeSchema).max(RULE_CHAIN_NODES_MAX, `A rule chain holds at most ${RULE_CHAIN_NODES_MAX} nodes`),
  connections: z.array(connectionSchema).max(RULE_CHAIN_CONNECTIONS_MAX, `A rule chain holds at most ${RULE_CHAIN_CONNECTIONS_MAX} connections`),
});

const issue = (path: (string | number)[], message: string): ZodIssue => ({ code: z.ZodIssueCode.custom, path, message });

/**
 * The STRICT writer. Returns the document (names and relations trimmed) or
 * throws a ZodError whose messages name the offending node or connection.
 */
export function parseRuleChainDocument(value: unknown): RuleChainDocument {
  const doc = documentShapeSchema.parse(value) as RuleChainDocument;
  const issues: ZodIssue[] = [];
  const names = new Map<string, string>();

  doc.nodes.forEach((n, i) => {
    if (names.has(n.id)) {
      issues.push(issue(['nodes', i, 'id'], `Node "${n.name}": id ${n.id} is already used by node "${names.get(n.id)}"`));
      return;
    }
    names.set(n.id, n.name);
    if (n.type === UNSUPPORTED_NODE_TYPE) return;
    const spec = RULE_NODE_TYPE_BY_ID.get(n.type);
    if (!spec) {
      issues.push(issue(['nodes', i, 'type'], `Node "${n.name}": unknown node type "${n.type}"`));
      return;
    }
    const r = spec.configSchema.safeParse(n.config);
    if (!r.success) {
      for (const e of r.error.issues) {
        const where = e.path.length ? e.path.join('.') : 'configuration';
        issues.push(issue(['nodes', i, 'config', ...e.path], `Node "${n.name}" (${spec.label}): ${where} — ${e.message}`));
      }
    }
  });

  const seen = new Set<string>();
  doc.connections.forEach((c, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!names.has(c[end])) issues.push(issue(['connections', i, end], `Connection "${c.relation}": node ${c[end]} is not in the chain`));
    }
    const key = `${c.from}|${c.to}|${c.relation}`;
    if (seen.has(key)) {
      issues.push(issue(['connections', i], `Connection "${c.relation}" from "${names.get(c.from)}" to "${names.get(c.to)}" appears twice`));
    }
    seen.add(key);
  });

  if (doc.firstNodeId !== null && !names.has(doc.firstNodeId)) {
    issues.push(issue(['firstNodeId'], `The first node ${doc.firstNodeId} is not in the chain`));
  }

  if (issues.length) throw new ZodError(issues);
  return doc;
}

// ─── Forgiving ───────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().slice(0, RULE_NODE_NAME_MAX).trim() : '';
  return s || fallback;
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function cleanRelation(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length <= RULE_RELATION_MAX ? s : '';
}

/**
 * The FORGIVING reader: never throws, and what it returns always passes
 * `parseRuleChainDocument`. A node with no usable id is dropped (nothing could
 * key it); a node whose type is unknown or whose configuration its schema
 * refuses reads as `tb:unsupported`; a dangling or duplicate connection is
 * dropped; an unknown first node reads as none.
 */
export function readRuleChainDocument(value: unknown): RuleChainDocument {
  if (!isPlainObject(value) || !Array.isArray(value.nodes)) return emptyRuleChainDocument();

  const nodes: RuleChainNode[] = [];
  const ids = new Set<string>();
  for (const raw of value.nodes) {
    if (nodes.length >= RULE_CHAIN_NODES_MAX) break;
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && UUID_RE.test(raw.id) ? raw.id : null;
    if (!id || ids.has(id)) continue;
    ids.add(id);

    const type = typeof raw.type === 'string' ? raw.type : '';
    const config = isPlainObject(raw.config) ? raw.config : {};
    const spec = RULE_NODE_TYPE_BY_ID.get(type);
    let finalType = type;
    let finalConfig: Record<string, unknown> = config;
    if (type !== UNSUPPORTED_NODE_TYPE) {
      if (!spec) {
        finalType = UNSUPPORTED_NODE_TYPE;
        finalConfig = { type, configuration: config, reason: `Unknown node type "${type}"` };
      } else {
        const r = spec.configSchema.safeParse(config);
        if (!r.success) {
          const e = r.error.issues[0];
          finalType = UNSUPPORTED_NODE_TYPE;
          finalConfig = { tbClass: spec.tbClass, type, configuration: config, reason: `${e.path.join('.') || 'configuration'} — ${e.message}` };
        }
      }
    }
    const debugMode = (RULE_DEBUG_MODES as readonly unknown[]).includes(raw.debugMode) ? (raw.debugMode as RuleDebugMode) : 'off';
    nodes.push({
      id, type: finalType, name: cleanName(raw.name, spec?.label ?? 'Unsupported node'), debugMode,
      config: finalConfig, x: finite(raw.x), y: finite(raw.y),
    });
  }

  const connections: RuleChainConnection[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.connections) ? value.connections : []) {
    if (connections.length >= RULE_CHAIN_CONNECTIONS_MAX) break;
    if (!isPlainObject(raw)) continue;
    const { from, to } = raw;
    const relation = cleanRelation(raw.relation);
    if (typeof from !== 'string' || typeof to !== 'string' || !ids.has(from) || !ids.has(to) || !relation) continue;
    const key = `${from}|${to}|${relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    connections.push({ from, to, relation });
  }

  const firstNodeId = typeof value.firstNodeId === 'string' && ids.has(value.firstNodeId) ? value.firstNodeId : null;
  return { version: RULE_CHAIN_DOCUMENT_VERSION, firstNodeId, nodes, connections };
}

export function emptyRuleChainDocument(): RuleChainDocument {
  return { version: RULE_CHAIN_DOCUMENT_VERSION, firstNodeId: null, nodes: [], connections: [] };
}

/**
 * The shipped root chain (spec §5): ThingsBoard's default root chain as far as
 * it exists here — Input → Message Type Switch → `Post telemetry` → Save
 * Timeseries · `Post attributes` → Save Attributes · `Other` → Log Other.
 * ThingsBoard's RPC nodes are left out (no device RPC here; `RPC Request from
 * Device` goes nowhere), so the chain has FOUR nodes; the Input is not a node.
 * Names and canvas positions are ThingsBoard's; ids are FIXED.
 */
export function defaultRootChainDocument(): RuleChainDocument {
  const ids = DEFAULT_ROOT_CHAIN_NODE_IDS;
  return {
    version: RULE_CHAIN_DOCUMENT_VERSION,
    firstNodeId: ids.messageTypeSwitch,
    nodes: [
      { id: ids.messageTypeSwitch, type: 'tb:filter:message-type-switch', name: 'Message Type Switch', debugMode: 'off', config: newRuleNodeConfig('tb:filter:message-type-switch'), x: 566, y: 302 },
      { id: ids.saveTimeseries, type: 'tb:action:save-timeseries', name: 'Save Timeseries', debugMode: 'off', config: newRuleNodeConfig('tb:action:save-timeseries'), x: 999, y: 271 },
      // CLIENT_SCOPE, as ThingsBoard's root chain saves what a device reports.
      { id: ids.saveAttributes, type: 'tb:action:save-attributes', name: 'Save Attributes', debugMode: 'off', config: { ...newRuleNodeConfig('tb:action:save-attributes'), scope: 'CLIENT_SCOPE' }, x: 1000, y: 167 },
      { id: ids.logOther, type: 'tb:action:log', name: 'Log Other', debugMode: 'off', config: newRuleNodeConfig('tb:action:log'), x: 1000, y: 494 },
    ],
    connections: [
      { from: ids.messageTypeSwitch, to: ids.saveTimeseries, relation: 'Post telemetry' },
      { from: ids.messageTypeSwitch, to: ids.saveAttributes, relation: 'Post attributes' },
      { from: ids.messageTypeSwitch, to: ids.logOther, relation: RULE_RELATION_OTHER },
    ],
  };
}

// ─── ThingsBoard interchange ─────────────────────────────────────────────────

export interface ThingsboardNodeExport {
  type: string;
  name: string;
  /** ThingsBoard 3.x. */
  debugMode: boolean;
  /** ThingsBoard master. */
  debugAll: boolean;
  debugFailures: boolean;
  /** The ThingsBoard configuration version `configuration` is at; absent for a later / none node (unknown). */
  configurationVersion?: number;
  configuration: unknown;
  additionalInfo: { layoutX: number; layoutY: number; description?: string };
}

export interface ThingsboardRuleChainExport {
  ruleChain: { name: string; type: 'CORE'; root: boolean; debugMode: boolean; configuration: null; additionalInfo: null };
  metadata: {
    firstNodeIndex: number | null;
    nodes: ThingsboardNodeExport[];
    connections: { fromIndex: number; toIndex: number; type: string }[];
    ruleChainConnections: [];
  };
}

export interface ThingsboardImportResult {
  name: string;
  root: boolean;
  document: RuleChainDocument;
  warnings: string[];
}

/** ThingsBoard's export JSON for a document. */
export function toThingsboardExport(name: string, root: boolean, doc: RuleChainDocument): ThingsboardRuleChainExport {
  const index = new Map(doc.nodes.map((n, i) => [n.id, i]));
  const nodes = doc.nodes.map((n): ThingsboardNodeExport => {
    const spec = RULE_NODE_TYPE_BY_ID.get(n.type);
    const unsupported = n.type === UNSUPPORTED_NODE_TYPE || !spec;
    const tbClass = unsupported
      ? (typeof n.config.tbClass === 'string' ? n.config.tbClass : spec?.tbClass ?? UNSUPPORTED_NODE_TYPE)
      : spec.tbClass;
    // A built node in ThingsBoard's exchange form (ruling CV-3: Save time series' toggle → processingSettings).
    const configuration = unsupported ? (n.config.configuration ?? {}) : toThingsboardConfig(spec.id, n.config);
    // The version the configuration is AT: a built node's is the one its entry models (it was
    // upgraded on import); an Unsupported node's is the one it came with. A later / none node's
    // configuration is kept as it came and its version was not recorded — none is written.
    const configurationVersion = !unsupported
      ? spec.tbConfigurationVersion
      : Number.isInteger(n.config.configurationVersion) ? n.config.configurationVersion as number : null;
    return {
      type: tbClass,
      name: n.name,
      debugMode: n.debugMode !== 'off',
      debugAll: n.debugMode === 'all',
      debugFailures: n.debugMode === 'failures',
      ...(configurationVersion === null ? {} : { configurationVersion }),
      configuration: cloneJson(configuration),
      additionalInfo: { layoutX: n.x, layoutY: n.y },
    };
  });
  const typeOf = new Map(doc.nodes.map((n) => [n.id, n.type]));
  const connections = doc.connections
    .filter((c) => index.has(c.from) && index.has(c.to))
    .map((c) => ({
      fromIndex: index.get(c.from)!,
      toIndex: index.get(c.to)!,
      // Ruling SW-1: ThingsBoard's Entity type switch says "Device" / "Tenant" where this one says "Instrument" / "System".
      type: typeOf.get(c.from) === ENTITY_TYPE_SWITCH ? entityTypeSwitchLabelToThingsboard(c.relation) : c.relation,
    }));
  return {
    ruleChain: { name, type: 'CORE', root, debugMode: false, configuration: null, additionalInfo: null },
    metadata: {
      firstNodeIndex: doc.firstNodeId !== null && index.has(doc.firstNodeId) ? index.get(doc.firstNodeId)! : null,
      nodes,
      connections,
      ruleChainConnections: [],
    },
  };
}

function debugModeOf(raw: Record<string, unknown>): RuleDebugMode {
  const settings = isPlainObject(raw.debugSettings) ? raw.debugSettings : {};
  if (raw.debugAll === true || settings.allEnabled === true) return 'all';
  if (raw.debugFailures === true || settings.failuresEnabled === true) return 'failures';
  if (raw.debugMode === true) return 'all';
  return 'off';
}

/**
 * Reads a ThingsBoard rule chain export (the object, or its JSON text). Throws
 * only when the input is not a rule chain export at all, or holds more nodes
 * than a chain may; everything else imports, with a warning per thing that did
 * not come across as itself. The document always passes the strict parse.
 */
export function fromThingsboardExport(json: unknown, opts: { newId?: () => string } = {}): ThingsboardImportResult {
  let value = json;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('The file is not JSON.'); }
  }
  if (!isPlainObject(value) || !isPlainObject(value.metadata) || !Array.isArray(value.metadata.nodes)) {
    throw new Error('Not a ThingsBoard rule chain export: it has no metadata.nodes.');
  }
  const meta = value.metadata;
  const rawNodes = meta.nodes as unknown[];
  if (rawNodes.length > RULE_CHAIN_NODES_MAX) {
    throw new Error(`The rule chain has ${rawNodes.length} nodes; a rule chain holds at most ${RULE_CHAIN_NODES_MAX}.`);
  }
  const chain = isPlainObject(value.ruleChain) ? value.ruleChain : {};
  const name = typeof chain.name === 'string' && chain.name.trim()
    ? chain.name.trim().slice(0, RULE_CHAIN_NAME_MAX).trim()
    : 'Imported rule chain';
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const warnings: string[] = [];

  const nodes: RuleChainNode[] = [];
  const idAt: (string | null)[] = [];
  rawNodes.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      warnings.push(`Node ${i + 1} is not a node; it was left out.`);
      idAt.push(null);
      return;
    }
    const tbClass = typeof raw.type === 'string' ? raw.type : '';
    const spec = RULE_NODE_TYPE_BY_TB_CLASS.get(tbClass);
    const nodeName = cleanName(raw.name, spec?.label ?? 'Unsupported node');
    const configuration = raw.configuration;
    const configObject = isPlainObject(configuration) ? cloneJson(configuration) : {};
    // ThingsBoard's configurationVersion; absent = 0, as ThingsBoard reads it.
    const sourceVersion = Number.isInteger(raw.configurationVersion) && (raw.configurationVersion as number) >= 0
      ? raw.configurationVersion as number
      : null;
    const fromVersion = sourceVersion ?? 0;
    // An Unsupported node remembers what it came as, version included, for the export back.
    const unsupportedConfig = (): Record<string, unknown> => ({
      tbClass,
      configuration: configuration === undefined ? null : cloneJson(configuration),
      ...(sourceVersion === null ? {} : { configurationVersion: sourceVersion }),
    });
    let type: string;
    let config: Record<string, unknown>;
    if (!spec) {
      type = UNSUPPORTED_NODE_TYPE;
      config = unsupportedConfig();
      warnings.push(`Node "${nodeName}": ThingsBoard class ${tbClass || '(none)'} is not known here; it was imported as Unsupported and passes messages to Failure.`);
    } else if (spec.status !== 'built') {
      // A later / none node imports as ITSELF (its configuration kept for the
      // export back), but nothing runs it: the engine ends its messages on Failure.
      type = spec.id;
      config = configObject;
      warnings.push(`Node "${nodeName}": ${spec.label} has no counterpart here and will send every message to Failure.`);
    } else {
      // 1. ThingsBoard's own upgrade from the exported configurationVersion (ruling CV-1):
      //    an older version read as the current one can mean the OPPOSITE (Check relation
      //    presence's direction). No upgrade mirrored for this node's version → flag it.
      const upgrade = upgradeThingsboardConfig(spec.id, fromVersion, configObject);
      if (upgrade.outcome === 'not-upgraded') {
        warnings.push(`Node "${nodeName}": configuration version ${fromVersion} is older than ${spec.tbConfigurationVersion} — review its settings.`);
      }
      // 2. ThingsBoard's exchange form → the ONE shape stored here (ruling CV-3): Save time
      //    series' processingSettings sets its toggle; what is not built here is named.
      const boundary = fromThingsboardConfig(spec.id, upgrade.config);
      // 3. ThingsBoard 3.6.0–3.6.3 exported some booleans / numbers as strings — read them.
      const coerced = coerceThingsboardScalars(spec.id, boundary.config);
      // 4. Validate.
      const r = spec.configSchema.safeParse(coerced);
      if (!r.success) {
        const e = r.error.issues[0];
        type = UNSUPPORTED_NODE_TYPE;
        config = unsupportedConfig();
        warnings.push(`Node "${nodeName}" (${spec.label}): its configuration does not fit here (${e.path.join('.') || 'configuration'} — ${e.message}); it was imported as Unsupported.`);
      } else {
        type = spec.id;
        config = coerced;
        // Save time series / attributes: a strategy not built here; a script node: its TBEL script now runs as JavaScript (TB-L).
        if (boundary.notHonoured) warnings.push(`Node "${nodeName}" (${spec.label}): ${boundary.notHonoured}`);
      }
    }
    const info = isPlainObject(raw.additionalInfo) ? raw.additionalInfo : {};
    const id = newId();
    idAt.push(id);
    nodes.push({ id, type, name: nodeName, debugMode: debugModeOf(raw), config, x: finite(info.layoutX), y: finite(info.layoutY) });
  });

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  const typeOfId = (id: string) => nodes.find((n) => n.id === id)?.type;
  const connections: RuleChainConnection[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(meta.connections) ? meta.connections : []) {
    const r = isPlainObject(raw) ? raw : {};
    const from = Number.isInteger(r.fromIndex) ? idAt[r.fromIndex as number] : undefined;
    const to = Number.isInteger(r.toIndex) ? idAt[r.toIndex as number] : undefined;
    if (!from || !to) {
      warnings.push(`A connection from node ${String(r.fromIndex)} to node ${String(r.toIndex)} names a node that is not in the chain; it was left out.`);
      continue;
    }
    const label = cleanRelation(r.type);
    if (!label) {
      warnings.push(`The connection from "${nameOf(from)}" to "${nameOf(to)}" has no usable relation label; it was left out.`);
      continue;
    }
    // Ruling SW-1: the switch EMITS this system's labels, so ThingsBoard's "Device" / "Tenant" are read as them.
    const relation = typeOfId(from) === ENTITY_TYPE_SWITCH ? entityTypeSwitchLabelFromThingsboard(label) : label;
    const key = `${from}|${to}|${relation}`;
    if (seen.has(key)) continue;
    if (connections.length >= RULE_CHAIN_CONNECTIONS_MAX) {
      warnings.push(`Connections beyond ${RULE_CHAIN_CONNECTIONS_MAX} were left out.`);
      break;
    }
    seen.add(key);
    connections.push({ from, to, relation });
    // Ruling DP-1: a BUILT node with fixed relations that never sends this label leaves the connection
    // dead — named, one warning per connection, and kept (it exports back). A node that names its
    // relations at run time is never judged; a later / none / Unsupported node already warned that
    // every message goes to Failure.
    const source = nodes.find((n) => n.id === from)!;
    const spec = RULE_NODE_TYPE_BY_ID.get(source.type);
    if (spec && spec.status === 'built' && spec.relations !== 'dynamic' && !spec.relations.includes(relation)) {
      const sends = spec.relations.length === 0 ? 'it sends nothing on' : `it sends only ${spec.relations.join(', ')}`;
      warnings.push(`Node "${source.name}" (${spec.label}): its "${relation}" connection to "${nameOf(to)}" is never taken — ${sends}.`);
    }
  }

  if (Array.isArray(meta.ruleChainConnections) && meta.ruleChainConnections.length > 0) {
    warnings.push(`${meta.ruleChainConnections.length} connection(s) to other rule chains in ThingsBoard's old format were left out; use a Rule chain node.`);
  }

  let firstNodeId: string | null = null;
  if (Number.isInteger(meta.firstNodeIndex)) {
    firstNodeId = idAt[meta.firstNodeIndex as number] ?? null;
    if (!firstNodeId) warnings.push(`The first node (index ${String(meta.firstNodeIndex)}) is not in the chain; the chain starts nowhere until one is connected.`);
  }

  const document = parseRuleChainDocument({ version: RULE_CHAIN_DOCUMENT_VERSION, firstNodeId, nodes, connections });
  return { name, root: chain.root === true, document, warnings };
}

// ─── Equality ────────────────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Two documents describe the same chain: the same nodes IN THE SAME ORDER (type,
 * name, debug mode, configuration regardless of key order, position), the same
 * connections between the same positions, the same first node. Node ids are NOT
 * compared — an import mints new ones.
 */
export function ruleChainsEqual(a: RuleChainDocument, b: RuleChainDocument): boolean {
  if (a.version !== b.version || a.nodes.length !== b.nodes.length) return false;
  const ia = new Map(a.nodes.map((n, i) => [n.id, i]));
  const ib = new Map(b.nodes.map((n, i) => [n.id, i]));
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (x.type !== y.type || x.name !== y.name || x.debugMode !== y.debugMode || x.x !== y.x || x.y !== y.y) return false;
    if (canonical(x.config) !== canonical(y.config)) return false;
  }
  const first = (d: RuleChainDocument, idx: Map<string, number>) => (d.firstNodeId === null ? -1 : idx.get(d.firstNodeId) ?? -2);
  if (first(a, ia) !== first(b, ib)) return false;
  const edges = (d: RuleChainDocument, idx: Map<string, number>) =>
    d.connections.map((c) => `${idx.get(c.from) ?? '?'}|${idx.get(c.to) ?? '?'}|${c.relation}`).sort();
  const ea = edges(a, ia);
  const eb = edges(b, ib);
  return ea.length === eb.length && ea.every((e, i) => e === eb[i]);
}
