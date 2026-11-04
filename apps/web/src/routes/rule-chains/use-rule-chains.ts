import useSWR from 'swr';
import type { RuleChainDocument } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { widgetPolling } from '@/lib/polling';
import type { TestScriptBody } from './script-field';
import type {
  RuleChainDetail, RuleChainImportResult, RuleChainSummary, RuleDebugEvent, RuleEngineStats,
} from './types';

/**
 * Every request the Rule Chains pages make (rule chains, 2026-11-04). Reads
 * need RULE_CHAIN_READ; every write needs RULE_CHAIN_MANAGE, a REASON (the
 * server refuses a blank one) and, when the role's policy asks for it, the
 * re-auth password collected by `reauth.execute('UPDATE_RULE_CHAIN', …)` —
 * absent when it does not.
 */

export const RULE_CHAINS_KEY = '/api/rule-chains';
export const RULE_STATS_KEY = '/api/rule-chains/stats';
/** The debug panel refreshes this often while it is open (ThingsBoard's Debug tab auto-refreshes). */
export const DEBUG_POLL_MS = 2_000;
/** The stats banner's cadence: the queue and the dropped count move with the plant. */
export const STATS_POLL_MS = 10_000;
/** Events the panel shows per node (the route allows 1..1000). */
export const DEBUG_LIST_LIMIT = 100;

export function useRuleChains() {
  const { data, error, isLoading, mutate } = useSWR<{ data: RuleChainSummary[] }>(RULE_CHAINS_KEY);
  return { rows: data?.data ?? [], loading: isLoading, error: error as Error | undefined, mutate };
}

/** One chain. A 404 is `notFound`; any other failure is `error` (a 500 is not "it does not exist"). */
export function useRuleChain(id: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<RuleChainDetail>(id ? `${RULE_CHAINS_KEY}/${id}` : null);
  const notFound = (error as { status?: number } | undefined)?.status === 404;
  return { chain: data, notFound, error: notFound ? undefined : (error as Error | undefined), loading: isLoading, mutate };
}

/**
 * Both polling readers go through the app's ONE polling policy
 * (`lib/polling.ts`), spread FIRST: SWR 2.4 stops polling a key whose cache
 * holds an error and the app's `errorRetryCount: 2` then gives up, so one
 * failed request (an API restart) would freeze the panel on its error until it
 * was reopened. The policy retries a failure at the poll's own cadence and
 * never retries a refusal (a 4xx).
 */
export function useRuleEngineStats() {
  const { data, error } = useSWR<RuleEngineStats>(RULE_STATS_KEY, { ...widgetPolling(STATS_POLL_MS) });
  return { stats: data, error: error as Error | undefined };
}

/** The debug key for a chain and (optionally) one node — `null` while the panel is closed. */
export function debugKey(chainId: string, nodeId: string | null, open: boolean): string | null {
  if (!open) return null;
  const qs = new URLSearchParams({ limit: String(DEBUG_LIST_LIMIT) });
  if (nodeId) qs.set('nodeId', nodeId);
  return `${RULE_CHAINS_KEY}/${chainId}/debug?${qs.toString()}`;
}

export function useRuleDebug(chainId: string, nodeId: string | null, open: boolean) {
  const { data, error, isLoading, mutate } = useSWR<{ data: RuleDebugEvent[] }>(
    debugKey(chainId, nodeId, open),
    { ...widgetPolling(DEBUG_POLL_MS), revalidateOnFocus: false },
  );
  return { events: data?.data ?? [], error: error as Error | undefined, loading: isLoading, mutate };
}

const post = <T,>(url: string, body: unknown, password?: string) =>
  (password ? apiClient.postWithReauth<T>(url, body, password) : apiClient.post<T>(url, body));
const put = <T,>(url: string, body: unknown, password?: string) =>
  (password ? apiClient.putWithReauth<T>(url, body, password) : apiClient.put<T>(url, body));
const del = <T,>(url: string, body: unknown, password?: string) =>
  (password ? apiClient.deleteWithReauth<T>(url, password, body) : apiClient.delete<T>(url, body));

export function createRuleChain(body: { name: string; document?: RuleChainDocument }, reason: string, password?: string) {
  return post<RuleChainDetail>(RULE_CHAINS_KEY, { ...body, reason }, password);
}

export interface SaveRuleChainBody {
  name: string;
  document: RuleChainDocument;
  reEnterOnRuleNodeWrites: boolean;
  /** The `updatedAt` the draft is based on; a chain changed since is a 409 STALE that writes nothing. */
  expectedUpdatedAt: string;
}

export function saveRuleChain(id: string, body: SaveRuleChainBody, reason: string, password?: string) {
  return put<RuleChainDetail>(`${RULE_CHAINS_KEY}/${id}`, { ...body, reason }, password);
}

export function deleteRuleChain(id: string, reason: string, password?: string) {
  return del<void>(`${RULE_CHAINS_KEY}/${id}`, { reason }, password);
}

export function makeRootRuleChain(id: string, reason: string, password?: string) {
  return post<RuleChainDetail>(`${RULE_CHAINS_KEY}/${id}/root`, { reason }, password);
}

/** A ThingsBoard JSON export; `name` overrides the file's (a taken name is a 409 NAME_IN_USE). */
export function importRuleChain(body: { json: unknown; name?: string }, reason: string, password?: string) {
  return post<RuleChainImportResult>(`${RULE_CHAINS_KEY}/import`, { ...body, reason }, password);
}

/** Clears a chain's debug events — one node's, or all of them. */
export function clearRuleDebug(chainId: string, nodeId: string | null, reason: string, password?: string) {
  return del<void>(`${RULE_CHAINS_KEY}/${chainId}/debug`, nodeId ? { nodeId, reason } : { reason }, password);
}

/** Runs a script in the server's VM against a sample message. MANAGE, no re-auth (it writes nothing). */
export async function testRuleScript(body: TestScriptBody): Promise<unknown> {
  const res = await apiClient.post<{ result: unknown }>(`${RULE_CHAINS_KEY}/test-script`, body);
  return res?.result;
}
