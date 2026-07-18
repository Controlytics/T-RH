import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const datetimeDef: ModuleConfigDefinition = {
  moduleKey: 'datetime',
  moduleName: 'Date/Time Format',
  description: 'Set application date and time display format',
  icon: 'calendar',
  category: 'display',
  sortOrder: 10,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/datetime',
  settings: [
    { key: 'dateFormat', type: 'select', label: 'Date Format', default: 'DD/MM/YYYY', group: 'Format',
      options: [
        { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
        { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
        { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
        { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY' },
        { value: 'MMM DD, YYYY', label: 'MMM DD, YYYY' },
      ] },
    { key: 'timeFormat', type: 'select', label: 'Time Format', default: '12-hour', group: 'Format',
      options: [
        { value: '12-hour', label: '12-hour' },
        { value: '24-hour', label: '24-hour' },
      ] },
    { key: 'timezone', type: 'string', label: 'Timezone', default: 'Asia/Kolkata', group: 'Format' },
  ],
};
