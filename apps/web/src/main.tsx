import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { swrConfig } from './lib/swr-config';
import { ErrorBoundary } from './components/error-boundary';
import { PwaReloadPrompt } from './components/pwa-reload-prompt';
import { RouteErrorBoundary } from './components/route-error-boundary';
import { RequireRole } from './components/require-role';
import { AppLayout } from './components/layout/app-layout';
import { LoginPage } from './routes/auth/login';
import { ForgotPasswordPage } from './routes/auth/forgot-password';
import { ChangePasswordPage } from './routes/auth/change-password';
import { ContactAdminPage } from './routes/auth/contact-admin';
import { GuestRequestPage } from './routes/auth/guest-request';
import { DashboardPage } from './routes/dashboard';
import HomePage from './routes/home';
// May 16 H18 bundle-split (2026-05-20): FilterOperationsPage is ~80k LOC
// (2k LOC file + deep deps); AuditTrailPage pulls jspdf + jspdf-autotable
// (+ ~250 KB gz). Lazy-load both so the main chunk shrinks meaningfully
// for first paint on tablet WebView.
import { PERMISSIONS } from '@digilog/shared';
import { UserListPage } from './routes/users/list';
import { CreateUserPage } from './routes/users/create';
import { EditUserPage } from './routes/users/edit';
import { ResetRequestsPage } from './routes/users/reset-requests';
import { ConfigIndexPage } from './routes/config/index';
import { PasswordPolicyPage } from './routes/config/password-policy';
import { DatetimeConfigPage } from './routes/config/datetime';
const AppearanceConfigPage = lazy(() => import("./routes/config/appearance").then(m => ({ default: m.AppearanceConfigPage })));
import { RoleAccessPage } from './routes/config/role-access';
const DisplaySettingsPage = lazy(() => import("./routes/config/display-settings").then(m => ({ default: m.DisplaySettingsPage })));
import { UserIdConfigPage } from './routes/config/user-id';
import { AccessMatrixPage } from './routes/config/access-matrix';
import { ReplacementScheduleFiltersPage } from './routes/config/replacement-schedule-filters';
const ReportConfigPage = lazy(() => import("./routes/config/report-config").then(m => ({ default: m.ReportConfigPage })));
import { OfflineCacheConfigPage } from './routes/config/offline-cache';
import { BackupRestorePage } from './routes/config/backup';
import { DynamicConfigPage } from './routes/config/dynamic-config';
import { ActionReauthPage } from './routes/config/action-reauth';
import { NotificationsPage } from './routes/notifications/index';
import { ProfilePage } from './routes/profile/index';
import { ToastProvider } from './components/toast-provider';
import './app.css';
import { initApiBaseFromStorage, getApiBase } from './lib/api-base';

// Lazy-loaded heavy pages (code-split into separate chunks).
// FilterOperationsPage + AuditTrailPage added 2026-05-20 (May 16 H18 fix).
const FilterOperationsPage = lazy(() => import('./routes/filter-management/filter-operations').then(m => ({ default: m.FilterOperationsPage })));
const AuditTrailPage = lazy(() => import('./routes/audit/index').then(m => ({ default: m.AuditTrailPage })));
const ReportReviewsPage = lazy(() => import('./routes/report-reviews/index').then(m => ({ default: m.ReportReviewsPage })));
const StageApprovalsPage = lazy(() => import('./routes/stage-approvals/index').then(m => ({ default: m.StageApprovalsPage })));

const HelpArticlesPage = lazy(() => import('./routes/config/help').then(m => ({ default: m.HelpArticlesPage })));

const LdapConfigPage = lazy(() => import("./routes/config/ldap"));
const RoleAssignmentsPage = lazy(() => import("./routes/config/role-assignments").then(m => ({ default: m.RoleAssignmentsPage })));
const SystemHealthPage = lazy(() => import('./routes/system-health/index').then(m => ({ default: m.SystemHealthPage })));
const DebugTracesPage = lazy(() => import('./routes/debug/index').then(m => ({ default: m.DebugTracesPage })));
const EmailSettingsPage = lazy(() => import('./routes/config/notification-settings/email-settings').then(m => ({ default: m.EmailSettingsPage })));
const SmsSettingsPage = lazy(() => import('./routes/config/notification-settings/sms-settings').then(m => ({ default: m.SmsSettingsPage })));
const NotificationRulesPage = lazy(() => import('./routes/config/notification-rules/index').then(m => ({ default: m.NotificationRulesPage })));
const NotificationLogsPage = lazy(() => import('./routes/config/notification-settings/notification-logs').then(m => ({ default: m.NotificationLogsPage })));

// Phase 2: Digital Filter Management System
const ChecklistProfileListPage = lazy(() => import("./routes/checklist-admin/list").then(m => ({ default: m.ChecklistProfileListPage })));
const ChecklistProfileDetailPage = lazy(() => import("./routes/checklist-admin/detail").then(m => ({ default: m.ChecklistProfileDetailPage })));
const CleaningProfileListPage = lazy(() => import("./routes/filter-management/cleaning-profile-list").then(m => ({ default: m.CleaningProfileListPage })));
// FilterProfileListPage removed — replaced by Config > Cleaning Profile Assignment

const CleaningCycleHistoryPage = lazy(() => import("./routes/cleaning-cycles/history").then(m => ({ default: m.CleaningCycleHistoryPage })));
const CleaningCycleTimelinePage = lazy(() => import("./routes/cleaning-cycles/timeline").then(m => ({ default: m.CleaningCycleTimelinePage })));
const FilterLifecycleReportPage = lazy(() => import("./routes/cleaning-cycles/filter-lifecycle").then(m => ({ default: m.FilterLifecycleReportPage })));
const EquipmentGroupsConfigPage = lazy(() => import("./routes/config/equipment-groups").then(m => ({ default: m.EquipmentGroupsConfigPage })));
const FilterSetupPage = lazy(() => import('./routes/config/filter-setup').then(m => ({ default: m.FilterSetupPage })));
const AhuFilterSetConfigPage = lazy(() => import('./routes/config/ahu-filter-set-config').then(m => ({ default: m.AhuFilterSetConfigPage })));
const PmScheduleListPage = lazy(() => import("./routes/pm-schedules/index").then(m => ({ default: m.PmScheduleListPage })));
const PmScheduleDetailPage = lazy(() => import("./routes/pm-schedules/detail").then(m => ({ default: m.PmScheduleDetailPage })));
const MyTasksPage = lazy(() => import("./routes/my-tasks/index").then(m => ({ default: m.MyTasksPage })));
const DeviationsPage = lazy(() => import("./routes/deviations/index").then(m => ({ default: m.DeviationsPage })));
const AhuDashboardPage = lazy(() => import("./routes/filter-management/ahu-dashboard").then(m => ({ default: m.AhuDashboardPage })));
const FilterTraceabilityPage = lazy(() => import("./routes/filter-management/filter-traceability").then(m => ({ default: m.FilterTraceabilityPage })));
const CleaningProfileEditorPage2 = lazy(() => import("./routes/filter-management/cleaning-profile-editor").then(m => ({ default: m.CleaningProfileEditorPage })));
const FilterListPage = lazy(() => import("./routes/filter-management/filter-list").then(m => ({ default: m.FilterListPage })));
const ApprovalsPage = lazy(() => import("./routes/approvals/index").then(m => ({ default: m.ApprovalsPage })));
const ReplacementSchedulePage = lazy(() => import("./routes/filter-management/replacement-schedule").then(m => ({ default: m.ReplacementSchedulePage })));
const RfidTrackRecordPage = lazy(() => import("./routes/filter-management/rfid-track-record").then(m => ({ default: m.RfidTrackRecordPage })));
const QualityNotificationsPage = lazy(() => import("./routes/filter-management/quality-notifications").then(m => ({ default: m.QualityNotificationsPage })));
const RetirementListPage = lazy(() => import("./routes/filter-management/retirement-list").then(m => ({ default: m.RetirementListPage })));
const AdminRequestsPage = lazy(() => import("./routes/admin-requests/index").then(m => ({ default: m.AdminRequestsPage })));
const ReplacementListPage = lazy(() => import("./routes/filter-management/replacement-list").then(m => ({ default: m.ReplacementListPage })));

// Report Templates + Generated Reports removed from the application (2026-06-08).
const VersionHistoryPage = lazy(() => import("./routes/version-history/index").then(m => ({ default: m.VersionHistoryPage })));
const FilterDataManagementPage = lazy(() => import("./routes/config/filter-data-management").then(m => ({ default: m.FilterDataManagementPage })));
const TabletAccessConfigPage = lazy(() => import("./routes/config/tablet-access").then(m => ({ default: m.TabletAccessConfigPage })));

// Wave 3 (asset-removal) — read-only preview of the new typed-table hierarchy
// endpoints (Wave 2: /api/hierarchy/tree). Dev-only; reach it by URL.
const HierarchyPreviewPage = lazy(() => import('./routes/hierarchy-preview/index').then(m => ({ default: m.HierarchyPreviewPage })));

// Mobile
const MobileWrapperPage = lazy(() => import("./routes/mobile/mobile-wrapper").then(m => ({ default: m.MobileWrapperPage })));
const MobileLoginPage = lazy(() => import("./routes/mobile/mobile-login").then(m => ({ default: m.MobileLoginPage })));
const MobileForgotPasswordPage = lazy(() => import("./routes/mobile/mobile-forgot-password").then(m => ({ default: m.MobileForgotPasswordPage })));
const ServerConfigPage = lazy(() => import('./routes/mobile/server-config'));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <svg className="w-6 h-6 animate-spin text-cyan-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  );
}

// Mirror any persisted server URL into window.__API_BASE__ BEFORE any API call
// or the Capacitor redirect runs, so every module resolves the same base.
initApiBaseFromStorage();

// Auto-redirect to mobile UI when running inside Capacitor APK.
// 2026-05-21: also allow /change-password through — tablet temp-password
// flow legitimately lands there from mobile-login. Without this, any hard
// reload on /change-password (e.g. from a background API call) bounced the
// operator to /m/login mid-typing.
// M8 Task 4: on first launch (no server configured yet), go to /m/server-config
// before anything else so the operator can set the API URL.
{
  const path = window.location.pathname;
  const isNative = (window as any).Capacitor?.isNativePlatform?.();
  const allowedOnTablet = path.startsWith('/m') || path.startsWith('/change-password');
  if (isNative) {
    // No server configured yet -> force the Server Address screen first.
    if (!getApiBase() && path !== '/m/server-config') {
      window.location.href = '/m/server-config';
    } else if (!allowedOnTablet) {
      window.location.href = '/m/login';
    }
  }
}

// B.2 — Background sync trigger: when SW (registered by vite-plugin-pwa) sends
// a `sync-queue` message, drain the IndexedDB queue. On Capacitor the existing
// visibilitychange handler in connectivity.ts covers the "tablet wakes up" case.
// (Full Background Sync API integration via Workbox backgroundSync plugin is
//  a follow-up — would let queued ops fire even with no client open. Today we
//  rely on app-resume + network-event triggers, which catch >95% of cases.)
if ('serviceWorker' in navigator && !(window as any).Capacitor?.isNativePlatform?.()) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sync-queue') {
      import('./lib/sync-engine').then(m => m.syncPendingOperations()).catch(() => {});
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
    <ToastProvider>
    <SWRConfig value={swrConfig}>
      <BrowserRouter>
        <Routes>
          {/* Mobile routes — standalone, no sidebar */}
          <Route path="/m/login" element={<Suspense fallback={<LazyFallback />}><MobileLoginPage /></Suspense>} />
          <Route path="/m/forgot-password" element={<Suspense fallback={<LazyFallback />}><MobileForgotPasswordPage /></Suspense>} />
          <Route path="/m/server-config" element={<Suspense fallback={<LazyFallback />}><ServerConfigPage /></Suspense>} />
          <Route path="/m" element={<Suspense fallback={<LazyFallback />}><MobileWrapperPage /></Suspense>} />

          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/contact-admin" element={<ContactAdminPage />} />
          <Route path="/guest-request" element={<GuestRequestPage />} />

          {/* Protected routes */}
          <Route element={<RouteErrorBoundary><AppLayout /></RouteErrorBoundary>}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/profile" element={<ProfilePage />} />

            {/* User management — permission-based */}
            <Route path="/users" element={<RequireRole permissions={[PERMISSIONS.USER_READ, PERMISSIONS.USER_CREATE, PERMISSIONS.USER_UPDATE, PERMISSIONS.USER_DELETE, PERMISSIONS.USER_RESET_PASSWORD, PERMISSIONS.USER_UNLOCK, PERMISSIONS.USER_ENABLE_DISABLE]}><UserListPage /></RequireRole>} />
            <Route path="/users/create" element={<RequireRole permissions={[PERMISSIONS.USER_CREATE]}><CreateUserPage /></RequireRole>} />
            <Route path="/users/reset-requests" element={<RequireRole permissions={[PERMISSIONS.USER_RESET_PASSWORD]}><ResetRequestsPage /></RequireRole>} />
            <Route path="/users/:id" element={<RequireRole permissions={[PERMISSIONS.USER_READ]}><EditUserPage /></RequireRole>} />

            {/* Configuration — permission-based */}
            <Route path="/config" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><ConfigIndexPage /></RequireRole>} />
            <Route path="/config/role-assignments" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><RoleAssignmentsPage /></Suspense></RequireRole>} />
            <Route path="/config/password-policy" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><PasswordPolicyPage /></RequireRole>} />
            <Route path="/config/ldap" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><LdapConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/datetime" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><DatetimeConfigPage /></RequireRole>} />
            <Route path="/config/backup" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><BackupRestorePage /></RequireRole>} />

            {/* Super Admin Settings — SUPER_ADMIN role only */}
            <Route path="/config/appearance" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><AppearanceConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/report-config" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><ReportConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/roles" element={<RequireRole permissions={[PERMISSIONS.ROLE_MANAGE]}><RoleAccessPage /></RequireRole>} />
            <Route path="/config/display-settings" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><DisplaySettingsPage /></Suspense></RequireRole>} />
            <Route path="/config/user-id" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><UserIdConfigPage /></RequireRole>} />
            <Route path="/config/access-matrix" element={<RequireRole roles={['SUPER_ADMIN']}><AccessMatrixPage /></RequireRole>} />
            <Route path="/config/replacement-schedule-filters" element={<RequireRole roles={['SUPER_ADMIN']}><ReplacementScheduleFiltersPage /></RequireRole>} />
            <Route path="/config/offline-cache" element={<RequireRole roles={['SUPER_ADMIN']}><OfflineCacheConfigPage /></RequireRole>} />
            <Route path="/config/action-reauth" element={<RequireRole roles={['SUPER_ADMIN']}><ActionReauthPage /></RequireRole>} />
            <Route path="/config/email-settings" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><EmailSettingsPage /></Suspense></RequireRole>} />
            <Route path="/config/sms-settings" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><SmsSettingsPage /></Suspense></RequireRole>} />
            <Route path="/config/notification-rules" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><NotificationRulesPage /></Suspense></RequireRole>} />
                <Route path="/config/notification-logs" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><NotificationLogsPage /></Suspense></RequireRole>} />
            <Route path="/config/dynamic/:moduleKey" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><DynamicConfigPage /></RequireRole>} />

            {/* System Health — Admin only (lazy-loaded) */}
            <Route path="/system-health" element={<RequireRole roles={['SUPER_ADMIN', 'ADMIN']}><Suspense fallback={<LazyFallback />}><SystemHealthPage /></Suspense></RequireRole>} />

            {/* Pipeline Debug Traces — Admin only (lazy-loaded) */}
            <Route path="/debug/traces" element={<RequireRole permissions={[PERMISSIONS.READ_DEBUG_TRACE]}><Suspense fallback={<LazyFallback />}><DebugTracesPage /></Suspense></RequireRole>} />

            
            {/* Help Article Manager (lazy-loaded) */}
            <Route path="/config/help" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><HelpArticlesPage /></Suspense></RequireRole>} />

            


            {/* Notifications */}
            <Route path="/notifications" element={<RequireRole permissions={[PERMISSIONS.NOTIFICATION_VIEW, PERMISSIONS.NOTIFICATION_MANAGE]}><NotificationsPage /></RequireRole>} />

            {/* Audit trail */}

            {/* Phase 2: Digital Filter Management System */}
            <Route path="/filter-list" element={<RequireRole permissions={[PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_VIEW, PERMISSIONS.FILTER_HIERARCHY_CREATE, PERMISSIONS.FILTER_HIERARCHY_EDIT, PERMISSIONS.FILTER_HIERARCHY_DELETE, PERMISSIONS.FILTER_CREATE, PERMISSIONS.FILTER_EDIT, PERMISSIONS.FILTER_DELETE, PERMISSIONS.FILTER_RETIRE, PERMISSIONS.FILTER_REPLACE, PERMISSIONS.FILTER_BULK_UPLOAD, PERMISSIONS.FILTER_RFID_MANAGE, PERMISSIONS.FILTER_STATUS_UPDATE]}><Suspense fallback={<LazyFallback />}><FilterListPage /></Suspense></RequireRole>} />
            <Route path="/approvals" element={<RequireRole permissions={[PERMISSIONS.BLOCK_CHANGE_APPROVE, PERMISSIONS.BLOCK_CHANGE_REQUEST]}><Suspense fallback={<LazyFallback />}><ApprovalsPage /></Suspense></RequireRole>} />
            <Route path="/replacement-schedule" element={<RequireRole permissions={[PERMISSIONS.REPLACEMENT_SCHEDULE_VIEW, PERMISSIONS.REPLACEMENT_SCHEDULE_UPLOAD, PERMISSIONS.REPLACEMENT_SCHEDULE_REVIEW, PERMISSIONS.REPLACEMENT_SCHEDULE_APPROVE]}><Suspense fallback={<LazyFallback />}><ReplacementSchedulePage /></Suspense></RequireRole>} />
            <Route path="/filter-retirements" element={<RequireRole permissions={[PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_VIEW, PERMISSIONS.FILTER_RETIRE]}><Suspense fallback={<LazyFallback />}><RetirementListPage /></Suspense></RequireRole>} />
            <Route path="/rfid-track-record" element={<RequireRole permissions={[PERMISSIONS.ASSET_VIEW, PERMISSIONS.ASSET_READ, PERMISSIONS.FILTER_RFID_MANAGE]}><Suspense fallback={<LazyFallback />}><RfidTrackRecordPage /></Suspense></RequireRole>} />
            <Route path="/quality-notifications" element={<Suspense fallback={<LazyFallback />}><QualityNotificationsPage /></Suspense>} />
            <Route path="/filter-replacements" element={<RequireRole permissions={[PERMISSIONS.ASSET_READ, PERMISSIONS.ASSET_VIEW, PERMISSIONS.FILTER_REPLACE, PERMISSIONS.REPLACEMENT_SCHEDULE_VIEW, PERMISSIONS.REPLACEMENT_SCHEDULE_UPLOAD, PERMISSIONS.REPLACEMENT_SCHEDULE_REVIEW, PERMISSIONS.REPLACEMENT_SCHEDULE_APPROVE]}><Suspense fallback={<LazyFallback />}><ReplacementListPage /></Suspense></RequireRole>} />
            <Route path="/config/filter-data-management" element={<RequireRole permissions={[PERMISSIONS.CONFIG_UPDATE, PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><FilterDataManagementPage /></Suspense></RequireRole>} />
            <Route path="/config/tablet-access" element={<RequireRole permissions={[PERMISSIONS.CONFIG_UPDATE, PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><TabletAccessConfigPage /></Suspense></RequireRole>} />
            <Route path="/filters" element={<RequireRole permissions={[PERMISSIONS.FILTER_OPERATE, PERMISSIONS.ASSET_READ]}><FilterOperationsPage /></RequireRole>} />
            <Route path="/filters/stage/:stageKey" element={<RequireRole permissions={[PERMISSIONS.FILTER_OPERATE, PERMISSIONS.ASSET_READ]}><FilterOperationsPage /></RequireRole>} />
            <Route path="/checklists" element={<RequireRole permissions={[PERMISSIONS.FCP_READ, PERMISSIONS.CHECKLIST_TOGGLE, PERMISSIONS.CHECKLIST_CREATE, PERMISSIONS.CHECKLIST_EDIT, PERMISSIONS.CHECKLIST_DELETE, PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><ChecklistProfileListPage /></Suspense></RequireRole>} />
            <Route path="/checklists/:id" element={<RequireRole permissions={[PERMISSIONS.FCP_READ, PERMISSIONS.CHECKLIST_TOGGLE, PERMISSIONS.CHECKLIST_CREATE, PERMISSIONS.CHECKLIST_EDIT, PERMISSIONS.CHECKLIST_DELETE, PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><ChecklistProfileDetailPage /></Suspense></RequireRole>} />
            <Route path="/filter-cleaning-profiles" element={<RequireRole permissions={[PERMISSIONS.FCP_READ, PERMISSIONS.CP_TOGGLE, PERMISSIONS.CP_PAGE_CREATE, PERMISSIONS.CP_PAGE_EDIT, PERMISSIONS.CP_PAGE_DELETE, PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><CleaningProfileListPage /></Suspense></RequireRole>} />
            <Route path="/filter-cleaning-profiles/:id/edit" element={<RequireRole permissions={[PERMISSIONS.FCP_UPDATE, PERMISSIONS.CP_PAGE_EDIT]}><Suspense fallback={<LazyFallback />}><CleaningProfileEditorPage2 /></Suspense></RequireRole>} />
            {/* Filter Profiles removed — replaced by Config > Cleaning Profile Assignment */}
            <Route path="/filters/:id/operate" element={<RequireRole permissions={[PERMISSIONS.FILTER_OPERATE, PERMISSIONS.ASSET_READ]}><FilterOperationsPage /></RequireRole>} />
            <Route path="/filters/:id/trace" element={<RequireRole permissions={[PERMISSIONS.EVENT_READ, PERMISSIONS.ASSET_READ, PERMISSIONS.CYCLE_READ]}><Suspense fallback={<LazyFallback />}><FilterTraceabilityPage /></Suspense></RequireRole>} />
            <Route path="/cleaning-cycles" element={<RequireRole permissions={[PERMISSIONS.CYCLE_READ, PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><CleaningCycleHistoryPage /></Suspense></RequireRole>} />
            <Route path="/cleaning-cycles/:id" element={<RequireRole permissions={[PERMISSIONS.CYCLE_READ, PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><CleaningCycleTimelinePage /></Suspense></RequireRole>} />
            {/* Separate top-level path (NOT /cleaning-cycles/lifecycle) so it isn't
                captured by the /cleaning-cycles/:id timeline route. Dropdowns also
                need ASSET_VIEW for the /hierarchy/* endpoints. */}
            <Route path="/filter-lifecycle-report" element={<RequireRole permissions={[PERMISSIONS.CYCLE_READ]}><Suspense fallback={<LazyFallback />}><FilterLifecycleReportPage /></Suspense></RequireRole>} />
            <Route path="/config/filter-setup" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><FilterSetupPage /></Suspense></RequireRole>} />
            <Route path="/config/equipment-groups" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ, PERMISSIONS.EG_VIEW, PERMISSIONS.ASSET_READ]}><Suspense fallback={<LazyFallback />}><EquipmentGroupsConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/ahu-filter-set-config" element={<RequireRole permissions={[PERMISSIONS.PM_READ, PERMISSIONS.ASSET_VIEW]}><Suspense fallback={<LazyFallback />}><AhuFilterSetConfigPage /></Suspense></RequireRole>} />
            <Route path="/pm-schedules" element={<RequireRole permissions={[PERMISSIONS.PM_READ, PERMISSIONS.PM_CREATE, PERMISSIONS.PM_UPDATE, PERMISSIONS.PM_DELETE, PERMISSIONS.PM_EXECUTE, PERMISSIONS.PM_APPROVE]}><Suspense fallback={<LazyFallback />}><PmScheduleListPage /></Suspense></RequireRole>} />
            <Route path="/pm-schedules/:entityId" element={<RequireRole permissions={[PERMISSIONS.PM_READ, PERMISSIONS.PM_CREATE, PERMISSIONS.PM_UPDATE, PERMISSIONS.PM_DELETE, PERMISSIONS.PM_EXECUTE, PERMISSIONS.PM_APPROVE]}><Suspense fallback={<LazyFallback />}><PmScheduleDetailPage /></Suspense></RequireRole>} />
            <Route path="/my-tasks" element={<RequireRole permissions={[PERMISSIONS.PM_READ, PERMISSIONS.PM_EXECUTE, PERMISSIONS.PM_APPROVE]}><Suspense fallback={<LazyFallback />}><MyTasksPage /></Suspense></RequireRole>} />
            <Route path="/deviations" element={<RequireRole permissions={[PERMISSIONS.PM_READ, PERMISSIONS.PM_APPROVE]}><Suspense fallback={<LazyFallback />}><DeviationsPage /></Suspense></RequireRole>} />
            <Route path="/ahus/:id" element={<RequireRole permissions={[PERMISSIONS.ASSET_VIEW]}><Suspense fallback={<LazyFallback />}><AhuDashboardPage /></Suspense></RequireRole>} />
            <Route path="/audit" element={<RequireRole permissions={[PERMISSIONS.AUDIT_READ]}><Suspense fallback={<LazyFallback />}><AuditTrailPage /></Suspense></RequireRole>} />
            <Route path="/report-reviews" element={<RequireRole permissions={[PERMISSIONS.REPORT_REVIEW_SUBMIT, PERMISSIONS.REPORT_REVIEW, PERMISSIONS.REPORT_APPROVE]}><Suspense fallback={<LazyFallback />}><ReportReviewsPage /></Suspense></RequireRole>} />
            <Route path="/stage-approvals" element={<RequireRole permissions={[PERMISSIONS.STAGE_APPROVAL_VIEW, PERMISSIONS.STAGE_APPROVAL_DECIDE]}><Suspense fallback={<LazyFallback />}><StageApprovalsPage /></Suspense></RequireRole>} />
            <Route path="/admin-requests" element={<RequireRole permissions={[PERMISSIONS.ADMIN_REQUEST_APPROVE, PERMISSIONS.ADMIN_REQUEST_REJECT]}><Suspense fallback={<LazyFallback />}><AdminRequestsPage /></Suspense></RequireRole>} />

            {/* Report Templates + Generated Reports removed from the application (2026-06-08). */}

            {/* Audit / Versions (2026-05-02) — SUPER_ADMIN only by default; assignable via Role Privileges → Audit / Versions. */}
            <Route path="/version-history" element={<RequireRole permissions={[PERMISSIONS.VERSION_HISTORY_VIEW]}><Suspense fallback={<LazyFallback />}><VersionHistoryPage /></Suspense></RequireRole>} />

            {/* Wave 3 (asset-removal) dev preview — typed-table hierarchy. Not in sidebar. */}
            <Route path="/hierarchy-preview" element={<RequireRole permissions={[PERMISSIONS.ASSET_READ]}><Suspense fallback={<LazyFallback />}><HierarchyPreviewPage /></Suspense></RequireRole>} />

          </Route>

          {/* Catch-all: any unknown route falls through to here. Redirect to dashboard. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      {/* Audit 2026-05-04 fix (web-plumbing review H): PWA reload prompt
          mounted at the app root so SW updates surface to operators before
          they keep submitting against stale contracts. */}
      <PwaReloadPrompt />
    </SWRConfig>
    </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
