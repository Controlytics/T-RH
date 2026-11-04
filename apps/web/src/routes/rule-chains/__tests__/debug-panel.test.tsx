import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { RuleChainNode } from '@digilog/shared';

/**
 * The Debug panel (rule chains, 2026-11-04): a node's debug events as
 * `GET /api/rule-chains/:id/debug` returns them, newest first, polled every
 * 2 s while the panel is open; Clear is a reasoned, re-authenticated DELETE.
 */

const CHAIN = 'c-1';
const NODES: RuleChainNode[] = [
  { id: 'n-switch', type: 'tb:filter:message-type-switch', name: 'Message Type Switch', debugMode: 'all', config: {}, x: 0, y: 0 },
  { id: 'n-save', type: 'tb:action:save-timeseries', name: 'Save Timeseries', debugMode: 'off', config: {}, x: 0, y: 0 },
];
const ev = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
  id, chainId: CHAIN, nodeId: 'n-switch', ts, direction: 'IN', relation: null, msgId: `m-${id}`,
  msgType: 'POST_TELEMETRY_REQUEST', originatorType: 'INSTRUMENT', originatorId: 'i-1',
  data: { ts: 1, values: { temp: 22.5 } }, metadata: { instrumentCode: 'CWH/001' }, error: null, ...over,
});
// Deliberately NOT newest first: the panel must order them.
const EVENTS = {
  data: [
    ev('7', '2026-11-04T10:00:01.000Z'),
    ev('9', '2026-11-04T10:00:03.000Z', { direction: 'OUT', relation: 'Failure (unhandled)', error: 'UNSUPPORTED_NODE: "Save" has no handler' }),
    ev('8', '2026-11-04T10:00:03.000Z', { direction: 'OUT', relation: 'Post telemetry' }),
  ],
};

const swrCalls: { key: string | null; options: Record<string, unknown> | undefined }[] = [];
const mutate = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  default: (key: string | null, options?: Record<string, unknown>) => {
    swrCalls.push({ key, options });
    if (key && key.startsWith(`/api/rule-chains/${CHAIN}/debug`)) return { data: EVENTS, error: undefined, isLoading: false, mutate };
    return { data: undefined, error: undefined, isLoading: false, mutate };
  },
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (d: string) => d.slice(0, 10), config: { timezone: 'UTC' } }),
}));
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { delete: (...a: unknown[]) => del(...a), deleteWithReauth: vi.fn(), post: vi.fn(), get: vi.fn() },
}));
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  reauthActionLabel: () => 'Update Rule Chain',
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void }) => {
      reauthActions.push(action);
      try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { DebugPanel, newestFirst, debugTime } = await import('../debug-panel');

function mount(over: Partial<Parameters<typeof DebugPanel>[0]> = {}) {
  const onNodeChange = vi.fn();
  render(<DebugPanel chainId={CHAIN} nodes={NODES} nodeId="n-switch" onNodeChange={onNodeChange} canClear onClose={vi.fn()} {...over} />);
  return { onNodeChange };
}

beforeEach(() => { swrCalls.length = 0; del.mockReset(); reauthActions.length = 0; mutate.mockClear(); });

describe('DebugPanel', () => {
  it('lists the node\'s events NEWEST FIRST (time, then the larger id)', () => {
    mount();
    const ids = screen.getAllByTestId('debug-event').map((r) => r.getAttribute('data-event-id'));
    expect(ids).toEqual(['9', '8', '7']);
  });

  it('each row says IN / OUT, the relation, the message type, the originator and the time', () => {
    mount();
    const [first] = screen.getAllByTestId('debug-event');
    expect(within(first).getByTestId('debug-direction')).toHaveTextContent('OUT');
    expect(within(first).getByTestId('debug-relation')).toHaveTextContent('Failure (unhandled)');
    expect(within(first).getByText('POST_TELEMETRY_REQUEST')).toBeInTheDocument();
    expect(within(first).getByText(/INSTRUMENT i-1/)).toBeInTheDocument();
    expect(within(first).getByTestId('debug-time')).toHaveTextContent('10:00:03.000');
  });

  it('a row opens to its data, metadata and error as JSON', () => {
    mount();
    const [first] = screen.getAllByTestId('debug-event');
    expect(within(first).queryByText('Metadata')).toBeNull();
    fireEvent.click(within(first).getByRole('button', { expanded: false }));
    expect(within(first).getByText('Data')).toBeInTheDocument();
    expect(within(first).getByText(/"temp": 22.5/)).toBeInTheDocument();
    expect(within(first).getByText(/"instrumentCode": "CWH\/001"/)).toBeInTheDocument();
    expect(within(first).getByText(/UNSUPPORTED_NODE/)).toBeInTheDocument();
  });

  it('asks for THIS node\'s events and polls every 2 s', () => {
    mount();
    const call = swrCalls.find((c) => c.key?.includes('/debug'));
    expect(call?.key).toBe(`/api/rule-chains/${CHAIN}/debug?limit=100&nodeId=n-switch`);
    expect(call?.options?.refreshInterval).toBe(2000);
  });

  it('"All nodes" asks for the whole chain and names each event\'s node', () => {
    mount({ nodeId: null });
    const call = swrCalls.find((c) => c.key?.includes('/debug'));
    expect(call?.key).toBe(`/api/rule-chains/${CHAIN}/debug?limit=100`);
    expect(screen.getAllByText(/Message Type Switch ·/).length).toBe(3);
  });

  it('picking another node reports it', () => {
    const { onNodeChange } = mount();
    fireEvent.change(screen.getByLabelText('Node'), { target: { value: 'n-save' } });
    expect(onNodeChange).toHaveBeenCalledWith('n-save');
  });

  it('says when the chosen node\'s debug is off', () => {
    mount({ nodeId: 'n-save' });
    expect(screen.getByText(/Debug is off for this node/)).toBeInTheDocument();
  });

  it('Clear sends the node and a reason in the DELETE body, signed UPDATE_RULE_CHAIN', async () => {
    del.mockResolvedValue(undefined);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'start a clean trace' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear events' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/api/rule-chains/${CHAIN}/debug`, { nodeId: 'n-switch', reason: 'start a clean trace' }));
    expect(reauthActions).toEqual(['UPDATE_RULE_CHAIN']);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('a viewer without MANAGE has no Clear', () => {
    mount({ canClear: false });
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('debugTime', () => {
  it('is to the millisecond, in the administered timezone (events within one minute must read apart)', () => {
    expect(debugTime('2026-11-04T10:00:03.250Z', 'Asia/Kolkata')).toBe('15:30:03.250');
    expect(debugTime('2026-11-04T10:00:03.250Z', 'UTC')).toBe('10:00:03.250');
  });

  it('an unknown zone falls back to the browser time zone, never to nothing', () => {
    expect(debugTime('2026-11-04T10:00:03.250Z', 'Not/AZone')).toMatch(/^\d{2}:\d{2}:\d{2}\.250$/);
  });
});

describe('newestFirst', () => {
  it('orders by time, then by the bigserial id as a number (10 after 9)', () => {
    const same = '2026-11-04T10:00:00.000Z';
    const out = newestFirst([ev('9', same), ev('10', same), ev('1', '2026-11-04T09:00:00.000Z')] as never);
    expect(out.map((e) => e.id)).toEqual(['10', '9', '1']);
  });
});
