import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const userIdDef: ModuleConfigDefinition = {
  moduleKey: 'user-id',
  moduleName: 'User ID Format',
  description: 'Configure User ID format and rules',
  icon: 'id-card',
  category: 'user',
  sortOrder: 20,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/user-id',
  settings: [
    { key: 'format', type: 'select', label: 'Format', group: 'Format',
      options: [
        { value: 'NUMBERS_ONLY', label: 'Numbers Only' },
        { value: 'LETTERS_ONLY', label: 'Letters Only' },
        { value: 'LETTERS_NUMBERS', label: 'Letters & Numbers' },
        { value: 'PREFIX_NUMBERS', label: 'Prefix + Numbers' },
        { value: 'PREFIX_LETTERS', label: 'Prefix + Letters' },
        { value: 'PREFIX_LETTERS_NUMBERS', label: 'Prefix + Letters & Numbers' },
        { value: 'CUSTOM_PATTERN', label: 'Custom Pattern' },
      ] },
    { key: 'length', type: 'number', label: 'Length', min: 3, max: 20, default: 6, group: 'Format' },
    { key: 'autoGenerate', type: 'boolean', label: 'Auto Generate', default: false, group: 'Generation' },
  ],
};
