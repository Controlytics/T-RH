import type { ModuleConfigDefinition, SettingDefinition } from '../../../lib/config-registry.js';
import { REPORT_KINDS, reportKindSettingKeys, REPORT_DOWNLOADS_CONFIG_KEY } from '@digilog/shared';

/**
 * How each REPORT TYPE downloads (2026-10-01): Direct or Request, whether the
 * dialog asks for remarks, and whether the act is signed with the password.
 * See `@digilog/shared/report-downloads` for the rules and the operator's words.
 *
 * The settings are BUILT from `REPORT_KINDS`, three per kind and one group per
 * kind, so a report type cannot exist in the shared catalogue and be missing
 * here. Renders through the dynamic config page — no `routes/config/*.tsx`.
 *
 * Defaults are TODAY'S behaviour (Request, remarks on, password on), so
 * deploying this changes nothing until a super admin changes it. Served to
 * every authenticated user, already coerced, by
 * `GET /api/config/report-downloads/current`; enforced on the server by
 * `POST /api/report-reviews` and `POST /api/audit/report-export-log`.
 *
 * **Password = Yes ALWAYS asks**, for every role, and No never asks — for
 * these PDFs this setting replaces the per-role `DOWNLOAD_REPORT` policy under
 * Action Re-authentication, which still governs the Audit Trail's Excel export.
 */
const settings: SettingDefinition[] = REPORT_KINDS.flatMap((kind, i) => {
  const k = reportKindSettingKeys(kind.key);
  return [
    {
      key: k.mode,
      type: 'select',
      label: 'Download mode',
      description: `${kind.hint} Direct: the PDF downloads at once. Request: it goes to an approver first and is downloaded, signed, from Reports.`,
      default: 'REQUEST',
      options: [
        { value: 'DIRECT', label: 'Direct download' },
        { value: 'REQUEST', label: 'Request approval' },
      ],
      group: kind.label,
      sortOrder: i * 10 + 1,
    },
    {
      key: k.remarks,
      type: 'boolean',
      label: 'Remarks required',
      description: 'Ask for, and require, a reason when this report is downloaded or requested.',
      default: true,
      group: kind.label,
      sortOrder: i * 10 + 2,
    },
    {
      key: k.password,
      type: 'boolean',
      label: 'Password required',
      description: 'Sign the download or the request with the user\'s password (re-authentication).',
      default: true,
      group: kind.label,
      sortOrder: i * 10 + 3,
    },
  ] satisfies SettingDefinition[];
});

export const reportDownloadsDef: ModuleConfigDefinition = {
  moduleKey: REPORT_DOWNLOADS_CONFIG_KEY,
  moduleName: 'Report Downloads',
  description: 'For each report type: download directly or request approval first, and whether remarks and the password are required.',
  icon: 'arrow-down-tray',
  category: 'system',
  sortOrder: 25,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  // Re-auth on save is governed by the UPDATE_CONFIG_PAGE entry under Action
  // Re-authentication (audit 2026-10-12 #7): this SUPER_ADMIN def had no
  // action at all, so no policy could ever ask for the password here.
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  // Edited on the combined Report Settings page (2026-10-01); FALSE above keeps
  // the generic dynamic GET/PUT (validation, SUPER_ADMIN, audit) in service.
  customPagePath: '/config/report-settings',
  settings,
};
