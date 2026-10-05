import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { DashboardPage } from './index';
import { landingRoute } from './landing';

/**
 * `/` — the dashboard for a role that may see it, otherwise the first page
 * the role's sidebar offers (see `landing.ts`). A redirect, not an Access
 * Denied screen: `/` is where every login lands, and a denial there is the
 * first thing a new user would see.
 */
export function LandingPage() {
  const { user } = useAuth();
  const to = landingRoute(user?.permissions ?? [], user?.role);
  if (to === '/') return <DashboardPage />;
  return <Navigate to={to} replace />;
}
