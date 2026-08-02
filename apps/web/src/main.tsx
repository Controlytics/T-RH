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
import { DashboardPage } from './routes/dashboard';
import HomePage from './routes/home';
// AuditTrailPage pulls jspdf + jspdf-autotable (+ ~250 KB gz). Lazy-load it so
// the main chunk shrinks meaningfully for first paint.
import { PERMISSIONS } from '@digilog/shared';
import { UserListPage } from './routes/users/list';
import { CreateUserPage } from './routes/users/create';
import { EditUserPage } from './routes/users/edit';
import { ResetRequestsPage } from './routes/users/reset-requests';
import { ConfigIndexPage } from './routes/config/index';
import { PasswordPolicyPage } from './routes/config/password-policy';
import { DatetimeConfigPage } from './routes/config/datetime';
const ReportPageTitlesPage = lazy(() => import('./routes/config/report-page-titles').then(m => ({ default: m.ReportPageTitlesPage })));
const AppearanceConfigPage = lazy(() => import("./routes/config/appearance").then(m => ({ default: m.AppearanceConfigPage })));
import { RoleAccessPage } from './routes/config/role-access';
const DisplaySettingsPage = lazy(() => import("./routes/config/display-settings").then(m => ({ default: m.DisplaySettingsPage })));
import { UserIdConfigPage } from './routes/config/user-id';
import { AccessMatrixPage } from './routes/config/access-matrix';
import { BackupRestorePage } from './routes/config/backup';
import { DynamicConfigPage } from './routes/config/dynamic-config';
import { ActionReauthPage } from './routes/config/action-reauth';
import { NotificationsPage } from './routes/notifications/index';
import { ProfilePage } from './routes/profile/index';
import { ToastProvider } from './components/toast-provider';
import './app.css';
import { initApiBaseFromStorage } from './lib/api-base';

// Lazy-loaded heavy pages (code-split into separate chunks).
const AuditTrailPage = lazy(() => import('./routes/audit/index').then(m => ({ default: m.AuditTrailPage })));

const HelpArticlesPage = lazy(() => import('./routes/config/help').then(m => ({ default: m.HelpArticlesPage })));

const LdapConfigPage = lazy(() => import("./routes/config/ldap"));
const RoleAssignmentsPage = lazy(() => import("./routes/config/role-assignments").then(m => ({ default: m.RoleAssignmentsPage })));
const SystemHealthPage = lazy(() => import('./routes/system-health/index').then(m => ({ default: m.SystemHealthPage })));
const DebugTracesPage = lazy(() => import('./routes/debug/index').then(m => ({ default: m.DebugTracesPage })));
const EmailSettingsPage = lazy(() => import('./routes/config/notification-settings/email-settings').then(m => ({ default: m.EmailSettingsPage })));
const SmsSettingsPage = lazy(() => import('./routes/config/notification-settings/sms-settings').then(m => ({ default: m.SmsSettingsPage })));
const NotificationRulesPage = lazy(() => import('./routes/config/notification-rules/index').then(m => ({ default: m.NotificationRulesPage })));
const NotificationLogsPage = lazy(() => import('./routes/config/notification-settings/notification-logs').then(m => ({ default: m.NotificationLogsPage })));

const AdminRequestsPage = lazy(() => import("./routes/admin-requests/index").then(m => ({ default: m.AdminRequestsPage })));

const DataInjectionDashboard = lazy(() => import('./routes/data-injection/index'));
const HierarchyPage = lazy(() => import('./routes/data-injection/hierarchy'));
const GatewaysPage = lazy(() => import('./routes/data-injection/gateways'));
const InstrumentsPage = lazy(() => import('./routes/data-injection/instruments'));
const InstrumentWizard = lazy(() => import('./routes/data-injection/instrument-wizard'));
const InstrumentDetail = lazy(() => import('./routes/data-injection/instrument-detail'));
const ProfilesPage = lazy(() => import('./routes/data-injection/profiles'));


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
// runs, so every module resolves the same base.
initApiBaseFromStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
    <ToastProvider>
    <SWRConfig value={swrConfig}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/contact-admin" element={<ContactAdminPage />} />

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
            <Route path="/config/report-page-titles" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><ReportPageTitlesPage /></Suspense></RequireRole>} />
            <Route path="/config/ldap" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><Suspense fallback={<LazyFallback />}><LdapConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/datetime" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><DatetimeConfigPage /></RequireRole>} />
            <Route path="/config/backup" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><BackupRestorePage /></RequireRole>} />

            {/* Super Admin Settings — SUPER_ADMIN role only */}
            <Route path="/config/appearance" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><AppearanceConfigPage /></Suspense></RequireRole>} />
            <Route path="/config/roles" element={<RequireRole permissions={[PERMISSIONS.ROLE_MANAGE]}><RoleAccessPage /></RequireRole>} />
            <Route path="/config/display-settings" element={<RequireRole roles={['SUPER_ADMIN']}><Suspense fallback={<LazyFallback />}><DisplaySettingsPage /></Suspense></RequireRole>} />
            <Route path="/config/user-id" element={<RequireRole permissions={[PERMISSIONS.CONFIG_READ]}><UserIdConfigPage /></RequireRole>} />
            <Route path="/config/access-matrix" element={<RequireRole roles={['SUPER_ADMIN']}><AccessMatrixPage /></RequireRole>} />
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
            <Route path="/audit" element={<RequireRole permissions={[PERMISSIONS.AUDIT_READ]}><Suspense fallback={<LazyFallback />}><AuditTrailPage /></Suspense></RequireRole>} />
            <Route path="/admin-requests" element={<RequireRole permissions={[PERMISSIONS.ADMIN_REQUEST_APPROVE, PERMISSIONS.ADMIN_REQUEST_REJECT]}><Suspense fallback={<LazyFallback />}><AdminRequestsPage /></Suspense></RequireRole>} />

            {/* Data Injection — Instruments, Gateways, Hierarchy, Communication Profiles */}
            <Route path="/data-injection" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_VIEW]}><Suspense fallback={<LazyFallback />}><DataInjectionDashboard /></Suspense></RequireRole>} />
            <Route path="/data-injection/hierarchy" element={<RequireRole permissions={[PERMISSIONS.HIERARCHY_VIEW]}><Suspense fallback={<LazyFallback />}><HierarchyPage /></Suspense></RequireRole>} />
            <Route path="/data-injection/gateways" element={<RequireRole permissions={[PERMISSIONS.GATEWAY_VIEW]}><Suspense fallback={<LazyFallback />}><GatewaysPage /></Suspense></RequireRole>} />
            <Route path="/data-injection/instruments" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_VIEW]}><Suspense fallback={<LazyFallback />}><InstrumentsPage /></Suspense></RequireRole>} />
            <Route path="/data-injection/instruments/create" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_CREATE]}><Suspense fallback={<LazyFallback />}><InstrumentWizard /></Suspense></RequireRole>} />
            <Route path="/data-injection/instruments/:id" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_VIEW]}><Suspense fallback={<LazyFallback />}><InstrumentDetail /></Suspense></RequireRole>} />
            <Route path="/data-injection/profiles" element={<RequireRole permissions={[PERMISSIONS.COMM_PROFILE_VIEW]}><Suspense fallback={<LazyFallback />}><ProfilesPage /></Suspense></RequireRole>} />

            {/* Audit / Versions — SUPER_ADMIN only by default; assignable via Role Privileges → Audit / Versions. */}

          </Route>

          {/* Catch-all: any unknown route falls through to here. Redirect to dashboard. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      {/* PWA reload prompt mounted at the app root so SW updates surface to
          operators before they keep submitting against stale contracts. */}
      <PwaReloadPrompt />
    </SWRConfig>
    </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
