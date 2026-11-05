import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { installXyflowStubs } from '@/test-support/xyflow-stubs';
import { newRuleNodeConfig } from '@digilog/shared';
import { INPUT_NODE_ID } from '../types';

/**
 * The rule chain editor (rule chains, 2026-11-04), on the REAL React Flow:
 * jsdom lays nothing out, so `test-support/xyflow-stubs.ts` answers React
 * Flow's measurements. What is pinned: a palette drop and a click add a node
 * to the draft; a link drawn from the Message type switch opens the relation
 * picker with the switch's labels and two picked labels are two connections;
 * a double-click opens the node's settings; an Unsupported node is grey with
 * its ThingsBoard class; Save sends the WHOLE draft with `expectedUpdatedAt`
 * and a reason, signed UPDATE_RULE_CHAIN; a 409 keeps the draft; a dirty
 * leave asks first; a viewer gets no editing.
 * NOT VERIFIED HERE: how it looks — built-editor.png.
 */

const restoreStubs = installXyflowStubs();
afterAll(() => restoreStubs());

const S = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const L = '44444444-4444-4444-8444-444444444444';
const U = '33333333-3333-4333-8333-333333333333';
const CHAIN = {
  id: 'c-1',
  name: 'Root Rule Chain',
  root: true,
  debugMode: false,
  reEnterOnRuleNodeWrites: false,
  updatedAt: '2026-11-04T10:00:00.000Z',
  updatedBy: null,
  document: {
    version: 1,
    firstNodeId: S,
    nodes: [
      { id: S, type: 'tb:filter:message-type-switch', name: 'Message Type Switch', debugMode: 'off', config: { version: 0 }, x: 300, y: 200 },
      { id: T, type: 'tb:action:save-timeseries', name: 'Save Timeseries', debugMode: 'off', config: { defaultTTL: 0 }, x: 700, y: 150 },
      { id: L, type: 'tb:action:log', name: 'Log Other', debugMode: 'off', config: { scriptLang: 'JS', jsScript: 'return "x";' }, x: 700, y: 350 },
      { id: U, type: 'tb:unsupported', name: 'Send to SQS', debugMode: 'off', config: { tbClass: 'org.thingsboard.rule.engine.aws.sqs.TbSqsNode', configuration: { queueUrl: 'q' } }, x: 700, y: 550 },
    ],
    connections: [{ from: S, to: T, relation: 'Post telemetry' }],
  },
};

const state: { role: string; permissions: string[]; chain: typeof CHAIN } = { role: 'SUPER_ADMIN', permissions: [], chain: CHAIN };
const chainMutate = vi.fn(async (data?: unknown) => data ?? state.chain);
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/rule-chains/c-1') return { data: state.chain, error: undefined, isLoading: false, mutate: chainMutate };
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: state.role, permissions: state.permissions } }) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (d: string) => d, formatTime: (d: string) => d, formatDateTime: (d: string) => d }),
}));
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...a),
    post: vi.fn(), delete: vi.fn(), getRaw: vi.fn(),
    putWithReauth: vi.fn(), postWithReauth: vi.fn(), deleteWithReauth: vi.fn(),
  },
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

const { RuleChainEditorPage } = await import('../editor-page');
const { DRAG_MIME } = await import('../palette');
const { UNSUPPORTED_TOOLTIP } = await import('../node-card');
const { DEBUG_CAP_CAPTION } = await import('../settings-dialog');

function tree() {
  return (
    <MemoryRouter initialEntries={['/rule-chains/c-1']}>
      <Routes>
        <Route path="/rule-chains/:id" element={<><Link to="/somewhere-else">elsewhere</Link><RuleChainEditorPage /></>} />
        <Route path="/somewhere-else" element={<span data-testid="left">left the editor</span>} />
      </Routes>
    </MemoryRouter>
  );
}

function mount() {
  return render(tree());
}

const cards = () => screen.getAllByTestId('rule-node');
const card = (id: string) => cards().find((c) => c.getAttribute('data-node-id') === id)!;
const handle = (container: HTMLElement, nodeId: string, kind: 'source' | 'target') =>
  container.querySelector(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle.${kind}`) as HTMLElement;

function drop(type: string) {
  fireEvent.drop(screen.getByTestId('rule-chain-canvas'), {
    dataTransfer: { getData: (m: string) => (m === DRAG_MIME ? type : ''), types: [DRAG_MIME] },
    clientX: 400, clientY: 300,
  });
}

async function saveWith(reason: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
  // The write resolves after the click: let it settle inside act.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save chain' })); });
}

beforeEach(() => {
  state.role = 'SUPER_ADMIN';
  state.permissions = [];
  state.chain = CHAIN;
  put.mockReset();
  chainMutate.mockClear();
  reauthActions.length = 0;
});

describe('the canvas', () => {
  it('draws every node, and an Unsupported one grey with its ThingsBoard class', () => {
    mount();
    expect(cards()).toHaveLength(4);
    const u = card(U);
    expect(u).toHaveAttribute('data-unsupported', 'true');
    expect(u).toHaveAttribute('title', UNSUPPORTED_TOOLTIP);
    expect(within(u).getByTestId('node-tb-class')).toHaveTextContent('org.thingsboard.rule.engine.aws.sqs.TbSqsNode');
    expect(card(S)).not.toHaveAttribute('data-unsupported');
    expect(screen.getByTestId('input-node')).toBeInTheDocument();
  });

  it('the palette offers built nodes only; the rest sit, disabled, under "Not available here"', () => {
    mount();
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    expect(within(palette).getAllByTestId('palette-item').every((i) => !/aws|kafka|customer/i.test(i.textContent ?? ''))).toBe(true);
    expect(within(palette).queryByText('AWS SQS')).toBeNull();
    fireEvent.click(within(palette).getByRole('button', { name: /Not available here/ }));
    const sqs = within(palette).getAllByTestId('palette-unavailable').find((i) => i.getAttribute('data-type') === 'tb:external:aws-sqs')!;
    expect(sqs).toHaveAttribute('aria-disabled', 'true');
    expect(sqs).not.toHaveAttribute('draggable');
  });

  it('dropping a palette item adds that node to the draft (and Undo takes it back)', () => {
    mount();
    expect(screen.queryByTestId('unsaved')).toBeNull();
    drop('tb:transformation:script');
    expect(cards()).toHaveLength(5);
    expect(cards().filter((c) => c.getAttribute('data-node-type') === 'tb:transformation:script')).toHaveLength(1);
    expect(screen.getByTestId('unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(cards()).toHaveLength(4);
    expect(screen.queryByTestId('unsaved')).toBeNull();
  });

  it('a later / none type dropped on the canvas is not added', () => {
    mount();
    drop('tb:external:aws-sqs');
    expect(cards()).toHaveLength(4);
  });

  it('clicking a palette item adds it too', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add Log' }));
    expect(cards()).toHaveLength(5);
  });

  it('a link from the Message type switch opens the picker with its labels; two labels are two connections in the save', async () => {
    put.mockResolvedValue({ ...CHAIN, updatedAt: '2026-11-04T10:05:00.000Z' });
    const { container } = mount();
    fireEvent.click(handle(container, S, 'source'));
    fireEvent.click(handle(container, L, 'target'));
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getByText('Link labels')).toBeInTheDocument();
    expect(within(picker).getByRole('checkbox', { name: 'Post attributes' })).toBeInTheDocument();
    expect(within(picker).getByRole('checkbox', { name: 'Other' })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Other' }));
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Alarm' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Add' }));
    await saveWith('route the rest to the log');
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [, body] = put.mock.calls[0] as [string, { document: { connections: unknown[] } }];
    expect(body.document.connections).toEqual([
      { from: S, to: T, relation: 'Post telemetry' },
      { from: S, to: L, relation: 'Alarm' },
      { from: S, to: L, relation: 'Other' },
    ]);
  });

  it('a link from the Input makes that node the chain\'s first node (no labels)', async () => {
    put.mockResolvedValue(CHAIN);
    const { container } = mount();
    fireEvent.click(container.querySelector('.react-flow__node[data-id="__rule-chain-input"] .react-flow__handle.source') as HTMLElement);
    fireEvent.click(handle(container, L, 'target'));
    expect(screen.queryByText('Link labels')).toBeNull();
    await saveWith('log first');
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][1] as { document: { firstNodeId: string } }).document.firstNodeId).toBe(L);
  });

  it('a double-click opens the node\'s settings: name, debug mode (with the cap caption) and its configuration', () => {
    mount();
    fireEvent.doubleClick(card(T));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Save Timeseries');
    expect(within(dialog).getByText(DEBUG_CAP_CAPTION)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Debug mode'), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: /server time/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(card(T)).getByTestId('node-debug')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved')).toBeInTheDocument();
  });

  it('an Unsupported node\'s settings show its class and configuration, read only', () => {
    mount();
    fireEvent.doubleClick(card(U));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('unsupported-note')).toHaveTextContent('TbSqsNode');
    expect(within(dialog).getByText(/"queueUrl": "q"/)).toBeInTheDocument();
  });
});

// Two REST nodes: the stored headers include a credential the server MASKED.
const R1 = '55555555-5555-4555-8555-555555555555';
const R2 = '66666666-6666-4666-8666-666666666666';
const REST = 'tb:external:rest-api-call';
const REST_CHAIN = {
  ...CHAIN,
  document: {
    version: 1,
    firstNodeId: R1,
    nodes: [
      { id: R1, type: REST, name: 'Call MES', debugMode: 'off', x: 300, y: 200,
        config: { ...newRuleNodeConfig(REST), restEndpointUrlPattern: 'https://mes.local/api', headers: { Authorization: '***', 'X-Env': 'prod' }, readTimeoutMs: 5000 } },
      { id: R2, type: REST, name: 'Call LIMS', debugMode: 'off', x: 700, y: 200,
        config: { ...newRuleNodeConfig(REST), restEndpointUrlPattern: 'https://lims.local/api', headers: { 'X-Other': 'b' }, readTimeoutMs: 9000 } },
    ],
    connections: [{ from: R1, to: R2, relation: 'Success' }],
  },
} as unknown as typeof CHAIN;

describe('node settings start from the node, every time (fix round 1, Critical)', () => {
  const timeout = (dialog: HTMLElement) => within(dialog).getByLabelText(/^Timeout/);
  const headers = (dialog: HTMLElement) => within(dialog).getByTestId('field-headers:map');

  it('a second node never shows the first one\'s values', () => {
    state.chain = REST_CHAIN;
    mount();
    fireEvent.doubleClick(card(R1));
    let dialog = screen.getByRole('dialog');
    expect(within(headers(dialog)).getByLabelText('Key 1')).toHaveValue('Authorization');
    expect(within(headers(dialog)).getByLabelText('Value 1')).toHaveValue('•••• (stored)');
    expect(within(headers(dialog)).getByLabelText('Key 2')).toHaveValue('X-Env');
    expect(timeout(dialog)).toHaveValue(5000);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.doubleClick(card(R2));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Call LIMS');
    expect(within(headers(dialog)).getByLabelText('Key 1')).toHaveValue('X-Other');
    expect(within(headers(dialog)).queryByLabelText('Key 2')).toBeNull();
    expect(timeout(dialog)).toHaveValue(9000);
  });

  it('a cancelled edit is gone when the dialog opens again', () => {
    state.chain = REST_CHAIN;
    mount();
    fireEvent.doubleClick(card(R1));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(timeout(dialog), { target: { value: '1234' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(within(headers(dialog)).getByLabelText('Value 2'), { target: { value: 'test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.doubleClick(card(R1));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Call MES');
    expect(timeout(dialog)).toHaveValue(5000);
    expect(within(headers(dialog)).getByLabelText('Value 2')).toHaveValue('prod');
    expect(screen.queryByTestId('unsaved')).toBeNull();
  });

  it('adding a header keeps the stored ones; the masked one goes back as *** (the server keeps its value)', async () => {
    state.chain = REST_CHAIN;
    put.mockResolvedValue(REST_CHAIN);
    mount();
    fireEvent.doubleClick(card(R1));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(headers(dialog)).getByRole('button', { name: 'Add row' }));
    fireEvent.change(within(headers(dialog)).getByLabelText('Key 3'), { target: { value: 'X-New' } });
    fireEvent.change(within(headers(dialog)).getByLabelText('Value 3'), { target: { value: 'v' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await saveWith('add a header');
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const nodes = (put.mock.calls[0][1] as { document: { nodes: { id: string; config: Record<string, unknown> }[] } }).document.nodes;
    expect(nodes.find((n) => n.id === R1)!.config.headers).toEqual({ Authorization: '***', 'X-Env': 'prod', 'X-New': 'v' });
    expect(nodes.find((n) => n.id === R2)!.config.headers).toEqual({ 'X-Other': 'b' });
  });

  it('Apply on an untouched dialog changes nothing: no unsaved mark, Save stays off', () => {
    state.chain = REST_CHAIN;
    mount();
    fireEvent.doubleClick(card(R1));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('unsaved')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // ... and records no undo step (dirty compares documents; Undo reads the history).
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('Enter on a focused node opens its settings (the keyboard\'s double-click); the Input has none', () => {
    const { container } = mount();
    fireEvent.keyDown(container.querySelector(`.react-flow__node[data-id="${INPUT_NODE_ID}"]`) as HTMLElement, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // A held key's repeats open nothing.
    fireEvent.keyDown(container.querySelector(`.react-flow__node[data-id="${T}"]`) as HTMLElement, { key: 'Enter', repeat: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(container.querySelector(`.react-flow__node[data-id="${T}"]`) as HTMLElement, { key: 'Enter' });
    expect(within(screen.getByRole('dialog')).getByLabelText('Name')).toHaveValue('Save Timeseries');
  });
});

describe('a newer version saved by someone else while settings are open (review I2)', () => {
  it('closes the settings with the adoption and says why; reopening shows the newer node', () => {
    toast.info.mockClear();
    state.chain = REST_CHAIN;
    const view = mount();
    fireEvent.doubleClick(card(R1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const doc = REST_CHAIN.document as unknown as { nodes: { id: string; config: Record<string, unknown> }[] };
    state.chain = {
      ...REST_CHAIN,
      updatedAt: '2026-11-04T11:00:00.000Z',
      document: { ...REST_CHAIN.document, nodes: doc.nodes.map((n) => (n.id === R1 ? { ...n, config: { ...n.config, headers: { 'X-Env': 'staging' } } } : n)) },
    } as unknown as typeof CHAIN;
    view.rerender(tree());

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.info).toHaveBeenCalledWith('This rule chain was saved by someone else', expect.stringContaining('Open them again'));
    fireEvent.doubleClick(card(R1));
    const headers = within(screen.getByRole('dialog')).getByTestId('field-headers:map');
    expect(within(headers).getByLabelText('Key 1')).toHaveValue('X-Env');
    expect(within(headers).getByLabelText('Value 1')).toHaveValue('staging');
  });

  it('with nothing open, the adoption is silent', () => {
    toast.info.mockClear();
    state.chain = REST_CHAIN;
    const view = mount();
    state.chain = { ...REST_CHAIN, updatedAt: '2026-11-04T11:00:00.000Z' } as typeof CHAIN;
    view.rerender(tree());
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  it('sends the whole draft with expectedUpdatedAt and a reason, signed UPDATE_RULE_CHAIN, then adopts the answer', async () => {
    put.mockResolvedValue({ ...CHAIN, updatedAt: '2026-11-04T10:05:00.000Z' });
    mount();
    drop('tb:action:log');
    await saveWith('add a second log');
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as [string, Record<string, unknown> & { document: { nodes: unknown[] } }];
    expect(url).toBe('/api/rule-chains/c-1');
    expect(body).toMatchObject({
      name: 'Root Rule Chain',
      reEnterOnRuleNodeWrites: false,
      expectedUpdatedAt: '2026-11-04T10:00:00.000Z',
      reason: 'add a second log',
    });
    expect(body.document.nodes).toHaveLength(5);
    // jsdom's drop carries no pointer position: the node lands mid-view, never at NaN.
    expect((body.document.nodes as { x: number; y: number }[]).every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(reauthActions).toEqual(['UPDATE_RULE_CHAIN']);
    await waitFor(() => expect(chainMutate).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: '2026-11-04T10:05:00.000Z' }), { revalidate: false }));
  });

  it('Save is offered only with unsaved changes', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a 409 (changed by someone else) keeps the draft until Reload', async () => {
    put.mockRejectedValue(Object.assign(new Error('This rule chain was changed by someone else.'), { code: 'STALE', status: 409 }));
    mount();
    drop('tb:action:log');
    await saveWith('mine');
    expect(await screen.findByText('This rule chain was changed by someone else.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(cards()).toHaveLength(5);
    expect(screen.getByTestId('unsaved')).toBeInTheDocument();
  });

  it('a 400 naming the node is shown and the draft kept', async () => {
    put.mockRejectedValue(Object.assign(new Error('Node "Log": jsScript — Required'), { code: 'VALIDATION_ERROR', status: 400 }));
    mount();
    drop('tb:action:log');
    await saveWith('x');
    expect(await screen.findByRole('alert')).toHaveTextContent('Node "Log": jsScript');
    expect(cards()).toHaveLength(5);
  });
});

describe('leaving', () => {
  it('with unsaved changes, a link asks first; Stay stays, Leave leaves', async () => {
    mount();
    drop('tb:action:log');
    fireEvent.click(screen.getByRole('link', { name: 'elsewhere' }));
    expect(screen.getByText('Leave without saving?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.queryByTestId('left')).toBeNull();
    expect(cards()).toHaveLength(5);
    fireEvent.click(screen.getByRole('link', { name: 'elsewhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByTestId('left')).toBeInTheDocument();
  });

  it('a reload / close with unsaved changes gets the browser\'s prompt', () => {
    mount();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    drop('tb:action:log');
    const dirty = new Event('beforeunload', { cancelable: true });
    act(() => { window.dispatchEvent(dirty); });
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('with nothing unsaved, a link just goes', async () => {
    mount();
    fireEvent.click(screen.getByRole('link', { name: 'elsewhere' }));
    expect(await screen.findByTestId('left')).toBeInTheDocument();
  });
});

describe('a RULE_CHAIN_READ holder', () => {
  it('sees the chain with no palette, no Save and no Delete; the settings are read only', () => {
    state.role = 'QA_VIEWER';
    state.permissions = ['RULE_CHAIN_READ'];
    mount();
    expect(cards()).toHaveLength(4);
    expect(screen.queryByRole('complementary', { name: 'Node palette' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByText('Read only')).toBeInTheDocument();
    fireEvent.doubleClick(card(T));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull();
  });
});
