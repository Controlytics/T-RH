import { z } from 'zod';
import type { ModuleConfigDefinition, SettingDefinition } from '../../../lib/config-registry.js';
import {
  RULE_ENGINE_CONFIG_KEY, RULE_ENGINE_CONFIG_DEFAULTS, RULE_ENGINE_NUMBER_SETTINGS, invalidateRuleEngineConfigCache,
} from '../../rule-engine/config.js';

/**
 * Configuration → Rule Engine (rule chains, 2026-11-03; spec §10).
 *
 * How the rule engine runs: on or off, whether Save nodes skip a message ingest
 * already stored, and its limits (script time-box, queue, concurrency, debug
 * retention, HTTP timeout, hop limit). Read ONLY through `getRuleEngineConfig()`
 * (`modules/rule-engine/config.ts`), which applies each default key by key and
 * clamps a hand-edited number to its bounds; `afterUpdate` drops its 10 s cache
 * so a save applies at once.
 *
 * - `enabled` defaults ON: the shipped root chain is ThingsBoard's and changes
 *   nothing (spec §5, ruling S-3). OFF stops processing and empties the queue.
 * - The dynamic PUT REPLACES the stored row with the body, so the zod schema
 *   requires EVERY key: a body without one would silently put it back to its
 *   default. Every number also carries `min` / `max`, which the generic
 *   validator enforces by field before the schema runs.
 * - SUPER_ADMIN only (a card under Super Admin Settings, the dynamic page); each
 *   change is a CONFIG_CHANGED audit row.
 */
const NUMBER_LABELS: Record<keyof typeof RULE_ENGINE_NUMBER_SETTINGS, { label: string; description: string }> = {
  scriptTimeoutMs: {
    label: 'Script timeout (ms)',
    description: 'How long a script node (filter, switch, transformation, log, generator, alarm details) may run before the message goes out on Failure. At most 5000: a script runs on the one event loop the whole server shares, and a script that times out three times in a row is switched off until its chain is saved.',
  },
  queueCapacity: {
    label: 'Queue capacity (messages)',
    description: 'How many messages wait for processing. When it is full, the oldest message of the instrument with the most waiting is dropped and counted.',
  },
  concurrency: {
    label: 'Concurrency',
    description: 'How many instruments\' messages are processed at once. The messages of one instrument are always processed in order.',
  },
  debugRetentionHours: {
    label: 'Keep debug events (hours)',
    description: 'Debug events older than this are deleted.',
  },
  debugMaxEventsPerNode: {
    label: 'Debug events kept per node',
    description: 'When a node has more debug events than this, the oldest are deleted.',
  },
  httpTimeoutMs: {
    label: 'HTTP timeout (ms)',
    description: 'The longest a REST API call or Slack node waits for an answer when the node sets no timeout of its own.',
  },
  hopLimit: {
    label: 'Hop limit',
    description: 'The most nodes one message may pass through (across chains). A message that reaches it goes out on Failure — this is what ends a loop.',
  },
};

const numberSettings: SettingDefinition[] = (Object.keys(RULE_ENGINE_NUMBER_SETTINGS) as (keyof typeof RULE_ENGINE_NUMBER_SETTINGS)[])
  .map((key) => ({
    key,
    type: 'number' as const,
    label: NUMBER_LABELS[key].label,
    description: NUMBER_LABELS[key].description,
    default: RULE_ENGINE_NUMBER_SETTINGS[key].default,
    min: RULE_ENGINE_NUMBER_SETTINGS[key].min,
    max: RULE_ENGINE_NUMBER_SETTINGS[key].max,
    required: true,
    group: 'Limits',
  }));

const int = (key: keyof typeof RULE_ENGINE_NUMBER_SETTINGS) => {
  const { min, max } = RULE_ENGINE_NUMBER_SETTINGS[key];
  const { label } = NUMBER_LABELS[key];
  return z.number({ required_error: `${label} is required`, invalid_type_error: `${label} must be a number` })
    .int(`${label} must be a whole number`).min(min, `${label} must be at least ${min}`).max(max, `${label} must be ${max} or less`);
};

export const ruleEngineDef: ModuleConfigDefinition = {
  moduleKey: RULE_ENGINE_CONFIG_KEY,
  moduleName: 'Rule Engine',
  description: 'Whether rule chains run, and the rule engine\'s limits: script timeout, queue, concurrency, debug retention, HTTP timeout and hop limit.',
  icon: 'git-branch',
  category: 'system',
  sortOrder: 17,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  // Re-auth on save is governed by the UPDATE_CONFIG_PAGE entry under Action
  // Re-authentication (audit 2026-10-12 #7; ruling D8-1): this SUPER_ADMIN def had no
  // action at all, so no policy could ever ask for the password here.
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Run rule chains',
      description: 'When on, every reading, attribute report and alarm enters the root rule chain. When off, nothing is processed and waiting messages are dropped. Readings are stored either way.',
      default: RULE_ENGINE_CONFIG_DEFAULTS.enabled,
      required: true,
      group: 'Rule Engine',
    },
    {
      key: 'skipSaveNodesForIngestOrigin',
      type: 'boolean',
      label: 'Skip Save nodes for readings already stored',
      description: 'When on, Save time series and Save attributes do nothing for a message that came from a device — the reading or attribute is already stored. Turn off only if a chain changes the message before saving it.',
      default: RULE_ENGINE_CONFIG_DEFAULTS.skipSaveNodesForIngestOrigin,
      required: true,
      group: 'Rule Engine',
    },
    ...numberSettings,
  ],
  zodSchema: z.object({
    enabled: z.boolean({ required_error: 'Run rule chains is required' }),
    skipSaveNodesForIngestOrigin: z.boolean({ required_error: 'Skip Save nodes for readings already stored is required' }),
    scriptTimeoutMs: int('scriptTimeoutMs'),
    queueCapacity: int('queueCapacity'),
    concurrency: int('concurrency'),
    debugRetentionHours: int('debugRetentionHours'),
    debugMaxEventsPerNode: int('debugMaxEventsPerNode'),
    httpTimeoutMs: int('httpTimeoutMs'),
    hopLimit: int('hopLimit'),
  }),
  hooks: {
    afterUpdate: async () => { invalidateRuleEngineConfigCache(); },
  },
};
