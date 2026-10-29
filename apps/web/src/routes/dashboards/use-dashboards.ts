import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import type { DashboardSummary, DashboardDetail } from '@digilog/shared';

/**
 * The dashboards the server says THIS caller may see (assignment-only for
 * anyone but a SUPER_ADMIN, every active one for a SUPER_ADMIN). Nothing is
 * filtered or decided here: `assignments` is simply absent for a non-SA.
 */
export function useDashboards() {
  const { data, error, isLoading, mutate } = useSWR<{ data: DashboardSummary[] }>('/api/dashboards');
  return { rows: data?.data ?? [], loading: isLoading, error: error as Error | undefined, mutate };
}

/** One dashboard; a 404 (also the answer for one that is not visible to the caller) is `notFound`. */
export function useDashboard(id: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<DashboardDetail>(id ? `/api/dashboards/${id}` : null);
  const notFound = (error as { status?: number } | undefined)?.status === 404;
  return { dashboard: data, notFound, loading: isLoading, mutate };
}

/**
 * Every write is audited and re-authenticated (`UPDATE_DASHBOARD`). `password`
 * is what the re-auth dialog collected; absent when the role needs none.
 */
export function createDashboard(body: { title: string; description?: string | null }, password?: string) {
  return password
    ? apiClient.postWithReauth<DashboardDetail>('/api/dashboards', body, password)
    : apiClient.post<DashboardDetail>('/api/dashboards', body);
}

export function duplicateDashboard(id: string, password?: string) {
  const url = `/api/dashboards/${id}/duplicate`;
  return password
    ? apiClient.postWithReauth<DashboardDetail>(url, {}, password)
    : apiClient.post<DashboardDetail>(url, {});
}

export function deleteDashboard(id: string, password?: string) {
  const url = `/api/dashboards/${id}`;
  return password ? apiClient.deleteWithReauth<{ success: boolean }>(url, password) : apiClient.delete<{ success: boolean }>(url);
}

export interface SaveDashboardBody {
  title?: string;
  description?: string | null;
  document?: unknown;
  /** The `updatedAt` the caller loaded; a row that has moved on is a 409 that writes nothing. */
  expectedUpdatedAt: string;
}

export function saveDashboard(id: string, body: SaveDashboardBody, password?: string) {
  const url = `/api/dashboards/${id}`;
  return password
    ? apiClient.putWithReauth<DashboardDetail>(url, body, password)
    : apiClient.put<DashboardDetail>(url, body);
}

export function saveAssignments(id: string, body: { roles: string[]; userIds: string[] }, password?: string) {
  const url = `/api/dashboards/${id}/assignments`;
  return password
    ? apiClient.putWithReauth<DashboardSummary['assignments']>(url, body, password)
    : apiClient.put<DashboardSummary['assignments']>(url, body);
}
