import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

// UNS topic-shape settings — controls how the pure topic-resolver
// (modules/instruments/topic-resolver.ts) derives topics for instruments.
// Renders through the dynamic config page (hasCustomPage: false — no bespoke route file).
export const unsSettingsDef: ModuleConfigDefinition = {
  moduleKey: 'uns-settings',
  moduleName: 'UNS Topic Settings',
  description: 'Controls how Unified Namespace topics are generated for instruments.',
  icon: 'network',
  category: 'advanced',
  sortOrder: 60,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  // No dedicated reauth action exists for this surface yet; UPDATE_CONFIG_PAGE is the
  // umbrella action reserved for exactly this case (see reauth-actions.ts comment above it).
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'prefix', type: 'string', label: 'Topic Prefix', default: 'controlyt',
      helpText: 'Leading namespace segment, e.g. the company slug. Leave blank to omit.',
      group: 'Topic Shape',
    },
    {
      key: 'separator', type: 'select', label: 'Separator', default: '/',
      options: [
        { value: '/', label: 'Slash (MQTT style)' },
        { value: '.', label: 'Dot' },
      ],
      group: 'Topic Shape',
    },
    {
      key: 'includeGateway', type: 'boolean', label: 'Include Gateway Segment', default: true,
      helpText: 'When enabled, a gateway-attached instrument includes the gateway slug in its topic.',
      group: 'Topic Shape',
    },
  ],
};
