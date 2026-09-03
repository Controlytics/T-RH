import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const brandingDef: ModuleConfigDefinition = {
  moduleKey: 'branding',
  moduleName: 'Branding',
  description: 'Customize logo, browser tab title & icon, background image, colors, company name & version',
  icon: 'palette',
  category: 'display',
  sortOrder: 11,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/branding',
  settings: [
    { key: 'appName', type: 'string', label: 'Application Name', group: 'App' },
    { key: 'appTagline', type: 'string', label: 'Tagline', group: 'App' },
    // The browser TAB. Distinct from `appName` above, which is what the sidebar,
    // header and login card print — see the comment on the zod schema for why the
    // two are not folded together. The favicon is UPLOADED, not typed, so its real
    // control lives on the custom page; this entry exists so the registry and the
    // access matrix know the key belongs to this module, the same as the two
    // background keys below.
    { key: 'tabTitle', type: 'string', label: 'Browser Tab Title', group: 'Browser Tab' },
    { key: 'faviconUrl', type: 'string', label: 'Browser Tab Icon', group: 'Browser Tab' },
    { key: 'companyName', type: 'string', label: 'Company Name', group: 'Company' },
    { key: 'version', type: 'string', label: 'Version', group: 'Company' },
    { key: 'primaryColor', type: 'color', label: 'Primary Color', group: 'Colors' },
    { key: 'secondaryColor', type: 'color', label: 'Secondary Color', group: 'Colors' },
    // The background image is uploaded, not typed, so the real control lives on the
    // custom page (`customPagePath` below). These entries exist so the registry and
    // the access matrix know the keys are part of this module.
    { key: 'backgroundUrl', type: 'string', label: 'Background Image', group: 'Background' },
    { key: 'backgroundOpacity', type: 'number', label: 'Background Strength (%)', group: 'Background' },
  ],
};
