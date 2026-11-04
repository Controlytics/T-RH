import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { RuleNodeConfigField } from '@digilog/shared';
import { ConfigForm, visibleFieldsFor, type ConfigFormContext } from '../config-form';

/**
 * The node settings form (rule chains, 2026-11-04): ONE generic form rendered
 * from a node type's field descriptors (`visibleRuleNodeFields`), one control
 * per field type. These tests drive a fixture spec with one field of every
 * type, the way the settings dialog hands them over.
 */

const FIELDS: RuleNodeConfigField[] = [
  { key: 'outputValueKey', label: 'Output key', type: 'text', required: true },
  { key: 'round', label: 'Decimals', type: 'number', min: 0, max: 15 },
  { key: 'useCache', label: 'Keep in memory', type: 'boolean' },
  { key: 'fetchTo', label: 'Add to', type: 'select', options: [{ value: 'METADATA', label: 'Message metadata' }, { value: 'DATA', label: 'Message data' }] },
  { key: 'statuses', label: 'Statuses', type: 'multiselect', options: [{ value: 'ACTIVE_ACK', label: 'Active ack' }, { value: 'CLEARED_ACK', label: 'Cleared ack' }] },
  { key: 'messageNames', label: 'Data keys', type: 'keys' },
  { key: 'renameKeysMapping', label: 'Key → new key', type: 'map' },
  { key: 'subjectTemplate', label: 'Subject', type: 'template', help: '${metadataKey} reads message metadata.' },
  { key: 'jsScript', label: 'Filter function', type: 'script', scriptKind: 'filter', required: true },
  { key: 'arguments', label: 'Arguments', type: 'json' },
  { key: 'entityId', label: 'Instrument', type: 'instrument' },
  { key: 'templateId', label: 'Template', type: 'notification-template' },
  { key: 'targets', label: 'Recipients', type: 'targets' },
  { key: 'messageTypes', label: 'Message types', type: 'message-types' },
  { key: 'ruleChainId', label: 'Rule chain', type: 'chain' },
  { key: 'labels', label: 'Labels', type: 'relations' },
];

const VALUE: Record<string, unknown> = {
  outputValueKey: 'delta', round: 2, useCache: true, fetchTo: 'METADATA', statuses: ['ACTIVE_ACK'],
  messageNames: ['temperature'], renameKeysMapping: { temp: 'temperature' }, subjectTemplate: 'Alarm on ${instrumentCode}',
  jsScript: 'return msg.temperature > 20;', arguments: [{ name: 'x', type: 'MESSAGE_BODY', key: 'temperature' }],
  entityId: 'i-2', templateId: 't-1', targets: { roles: ['QA'], userIds: [] }, messageTypes: ['POST_TELEMETRY_REQUEST', 'CUSTOM_PING'],
  ruleChainId: 'c-2', labels: ['hot'],
};

function context(over: Partial<ConfigFormContext> = {}): ConfigFormContext {
  return {
    chains: [{ id: 'c-1', name: 'Root Rule Chain' }, { id: 'c-2', name: 'Alarms' }],
    currentChainId: 'c-1',
    instruments: [{ id: 'i-1', code: 'CWH/001', name: 'Fridge' }, { id: 'i-2', code: 'CWH/002', name: 'Store room' }],
    templates: [{ id: 't-1', name: 'High temperature' }, { id: 't-2', name: 'Door open' }],
    roles: [{ name: 'QA', displayName: 'QA Reviewer' }, { name: 'OPERATOR', displayName: 'Operator' }],
    users: [{ id: 'u-1', username: 'rsharma', fullName: 'R. Sharma' }],
    testScript: vi.fn(async () => true),
    ...over,
  };
}

/** The form as the settings dialog holds it: the latest value comes back in. */
function Harness({ fields = FIELDS, initial = VALUE, ctx = context(), readOnly = false, onValue }: {
  fields?: RuleNodeConfigField[]; initial?: Record<string, unknown>; ctx?: ConfigFormContext; readOnly?: boolean;
  onValue?: (v: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ConfigForm
      nodeType="tb:test:fixture"
      fields={fields}
      value={value}
      context={ctx}
      readOnly={readOnly}
      onChange={(v) => { setValue(v); onValue?.(v); }}
    />
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const values: Record<string, unknown>[] = [];
  render(<Harness {...props} onValue={(v) => values.push(v)} />);
  return { last: () => values[values.length - 1] };
}

const row = (key: string, type: string) => screen.getByTestId(`field-${key}:${type}`);

describe('ConfigForm — one control per field type', () => {
  it('renders every field, each row keyed by key and TYPE', () => {
    setup();
    for (const f of FIELDS) {
      const r = row(f.key, f.type);
      expect(within(r).getAllByText(f.label).length).toBeGreaterThan(0);
    }
  });

  it('text', () => {
    const { last } = setup();
    fireEvent.change(within(row('outputValueKey', 'text')).getByRole('textbox'), { target: { value: 'diff' } });
    expect(last()).toMatchObject({ outputValueKey: 'diff' });
  });

  it('number: a number, and blank REMOVES the key (ThingsBoard\'s default applies) — never NaN or 0', () => {
    const { last } = setup();
    const input = within(row('round', 'number')).getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '4' } });
    expect(last()?.round).toBe(4);
    fireEvent.change(input, { target: { value: '' } });
    expect('round' in (last() ?? {})).toBe(false);
  });

  it('boolean is an on/off switch', () => {
    const { last } = setup();
    fireEvent.click(within(row('useCache', 'boolean')).getByRole('switch'));
    expect(last()?.useCache).toBe(false);
  });

  it('select, and an imported value that is not an option is kept and shown', () => {
    const { last } = setup({ initial: { ...VALUE, fetchTo: 'SOMEWHERE' } });
    const select = within(row('fetchTo', 'select')).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('SOMEWHERE');
    expect(within(select).getByText(/SOMEWHERE/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'DATA' } });
    expect(last()?.fetchTo).toBe('DATA');
  });

  it('multiselect adds and removes values', () => {
    const { last } = setup();
    const r = row('statuses', 'multiselect');
    fireEvent.click(within(r).getByRole('checkbox', { name: 'Cleared ack' }));
    expect(last()?.statuses).toEqual(['ACTIVE_ACK', 'CLEARED_ACK']);
    fireEvent.click(within(r).getByRole('checkbox', { name: 'Active ack' }));
    expect(last()?.statuses).toEqual(['CLEARED_ACK']);
  });

  it('keys: add (button or Enter) and remove', () => {
    const { last } = setup();
    const r = row('messageNames', 'keys');
    fireEvent.change(within(r).getByLabelText('New key for Data keys'), { target: { value: 'humidity' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Add key' }));
    expect(last()?.messageNames).toEqual(['temperature', 'humidity']);
    fireEvent.change(within(r).getByLabelText('New key for Data keys'), { target: { value: 'pressure' } });
    fireEvent.keyDown(within(r).getByLabelText('New key for Data keys'), { key: 'Enter' });
    fireEvent.click(within(r).getByRole('button', { name: 'Remove temperature' }));
    expect(last()?.messageNames).toEqual(['humidity', 'pressure']);
  });

  it('map: edit a key and a value, add a row, remove a row', () => {
    const { last } = setup();
    const r = row('renameKeysMapping', 'map');
    fireEvent.change(within(r).getByLabelText('Key 1'), { target: { value: 'tmp' } });
    fireEvent.change(within(r).getByLabelText('Value 1'), { target: { value: 'temp_c' } });
    expect(last()?.renameKeysMapping).toEqual({ tmp: 'temp_c' });
    fireEvent.click(within(r).getByRole('button', { name: 'Add row' }));
    fireEvent.change(within(r).getByLabelText('Key 2'), { target: { value: 'hum' } });
    fireEvent.change(within(r).getByLabelText('Value 2'), { target: { value: 'humidity' } });
    expect(last()?.renameKeysMapping).toEqual({ tmp: 'temp_c', hum: 'humidity' });
    fireEvent.click(within(r).getByRole('button', { name: 'Remove row 1' }));
    expect(last()?.renameKeysMapping).toEqual({ hum: 'humidity' });
  });

  it('template is a multi-line text with its help', () => {
    const { last } = setup();
    const r = row('subjectTemplate', 'template');
    expect(within(r).getByText('${metadataKey} reads message metadata.')).toBeInTheDocument();
    fireEvent.change(within(r).getByRole('textbox'), { target: { value: 'Hot: $[temperature]' } });
    expect(last()?.subjectTemplate).toBe('Hot: $[temperature]');
  });

  it('script: Test script calls /test-script with the script kind and shows the result', async () => {
    const ctx = context({ testScript: vi.fn(async () => true) });
    setup({ ctx });
    const r = row('jsScript', 'script');
    fireEvent.change(within(r).getByLabelText(/^Filter function/), { target: { value: 'return msg.temperature > 30;' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Test script' }));
    fireEvent.change(within(r).getByLabelText('Test message (msg)'), { target: { value: '{"temperature": 31}' } });
    fireEvent.change(within(r).getByLabelText('Test message type'), { target: { value: 'POST_TELEMETRY_REQUEST' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(within(r).getByTestId('script-result')).toHaveTextContent('true'));
    expect(ctx.testScript).toHaveBeenCalledWith({
      scriptType: 'filter', script: 'return msg.temperature > 30;', msg: { temperature: 31 },
      metadata: expect.any(Object), msgType: 'POST_TELEMETRY_REQUEST',
    });
  });

  it('script: a script error is shown with its code', async () => {
    const ctx = context({ testScript: vi.fn(async () => { throw Object.assign(new Error('Unexpected token'), { code: 'SCRIPT_SYNTAX' }); }) });
    setup({ ctx });
    const r = row('jsScript', 'script');
    fireEvent.click(within(r).getByRole('button', { name: 'Test script' }));
    fireEvent.click(within(r).getByRole('button', { name: 'Run' }));
    const err = await within(r).findByTestId('script-error');
    expect(err).toHaveTextContent('SCRIPT_SYNTAX');
    expect(err).toHaveTextContent('Unexpected token');
  });

  it('script: a test message that is not JSON is refused before any request', async () => {
    const ctx = context();
    setup({ ctx });
    const r = row('jsScript', 'script');
    fireEvent.click(within(r).getByRole('button', { name: 'Test script' }));
    fireEvent.change(within(r).getByLabelText('Test message (msg)'), { target: { value: '{temperature' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Run' }));
    expect(await within(r).findByTestId('script-error')).toHaveTextContent('msg is not valid JSON');
    expect(ctx.testScript).not.toHaveBeenCalled();
  });

  it('json: valid JSON is written; invalid JSON is NOT written and says so', () => {
    const { last } = setup();
    const r = row('arguments', 'json');
    const box = within(r).getByRole('textbox');
    fireEvent.change(box, { target: { value: '[{"name":"y","type":"CONSTANT","key":"k"}]' } });
    expect(last()?.arguments).toEqual([{ name: 'y', type: 'CONSTANT', key: 'k' }]);
    fireEvent.change(box, { target: { value: '[{"name":' } });
    expect(within(r).getByRole('alert')).toHaveTextContent(/not valid JSON/i);
    expect(last()?.arguments).toEqual([{ name: 'y', type: 'CONSTANT', key: 'k' }]);
  });

  it('instrument: picks by id, shows code and name', () => {
    const { last } = setup();
    const select = within(row('entityId', 'instrument')).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('i-2');
    expect(within(select).getByText('CWH/001 — Fridge')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'i-1' } });
    expect(last()?.entityId).toBe('i-1');
  });

  it('notification template: picks by id; an unreadable list keeps the stored id and says so', () => {
    const { last } = setup();
    fireEvent.change(within(row('templateId', 'notification-template')).getByRole('combobox'), { target: { value: 't-2' } });
    expect(last()?.templateId).toBe('t-2');
  });

  it('notification template list that could not be read', () => {
    setup({ ctx: context({ templates: null }) });
    const r = row('templateId', 'notification-template');
    expect(within(r).getByText(/could not be read/i)).toBeInTheDocument();
    expect(within(r).getByText(/t-1/)).toBeInTheDocument();
  });

  it('targets: roles and users', () => {
    const { last } = setup();
    const r = row('targets', 'targets');
    fireEvent.click(within(r).getByRole('checkbox', { name: 'Operator' }));
    fireEvent.click(within(r).getByRole('checkbox', { name: 'R. Sharma' }));
    expect(last()?.targets).toEqual({ roles: ['QA', 'OPERATOR'], userIds: ['u-1'] });
  });

  it('message types: the system\'s types, and a custom one kept', () => {
    const { last } = setup();
    const r = row('messageTypes', 'message-types');
    expect(within(r).getByText('CUSTOM_PING')).toBeInTheDocument();
    fireEvent.click(within(r).getByRole('checkbox', { name: /^Alarm \(ALARM\)$/ }));
    expect(last()?.messageTypes).toEqual(['POST_TELEMETRY_REQUEST', 'CUSTOM_PING', 'ALARM']);
    fireEvent.change(within(r).getByLabelText('New key for Message types'), { target: { value: 'MY_TYPE' } });
    fireEvent.click(within(r).getByRole('button', { name: 'Add key' }));
    expect(last()?.messageTypes).toEqual(['POST_TELEMETRY_REQUEST', 'CUSTOM_PING', 'ALARM', 'MY_TYPE']);
  });

  it('chain: another chain of this system, never itself', () => {
    const { last } = setup();
    const select = within(row('ruleChainId', 'chain')).getByRole('combobox');
    expect(within(select).queryByText('Root Rule Chain')).toBeNull();
    fireEvent.change(select, { target: { value: '' } });
    expect(last()?.ruleChainId).toBeNull();
  });
});

describe('ConfigForm — a credential the server masked', () => {
  const field: RuleNodeConfigField = { key: 'botToken', label: 'Bot token', type: 'text', required: true };

  it('shows "(stored)", never the mask, and keeps it unless changed', () => {
    const { last } = setup({ fields: [field], initial: { botToken: '***' } });
    const r = row('botToken', 'text');
    expect(within(r).getByText('•••• (stored)')).toBeInTheDocument();
    expect(within(r).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(r).getByRole('button', { name: 'Change' }));
    const box = within(r).getByRole('textbox') as HTMLInputElement;
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'xoxb-new' } });
    expect(last()?.botToken).toBe('xoxb-new');
    fireEvent.click(within(r).getByRole('button', { name: 'Keep stored' }));
    expect(last()?.botToken).toBe('***');
    expect(within(r).getByText('•••• (stored)')).toBeInTheDocument();
  });

  it('a JSON or map field holding a masked leaf says what *** means', () => {
    setup({
      fields: [{ key: 'credentials', label: 'Credentials', type: 'json' }],
      initial: { credentials: { type: 'basic', username: 'u', password: '***' } },
    });
    expect(screen.getByText(/\*\*\* is a stored secret/)).toBeInTheDocument();
  });
});

describe('ConfigForm — read only', () => {
  it('disables every control and offers no Test script', () => {
    setup({ readOnly: true });
    for (const el of screen.queryAllByRole('textbox')) expect(el).toBeDisabled();
    for (const el of screen.queryAllByRole('checkbox')) expect(el).toBeDisabled();
    for (const el of screen.queryAllByRole('combobox')) expect(el).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Test script' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
  });
});

describe('visibleFieldsFor', () => {
  it('a NULL flag reads as its default: Create alarm with dynamicSeverity null shows the severity SELECT', () => {
    const fields = visibleFieldsFor('tb:action:create-alarm', { dynamicSeverity: null, severity: 'MAJOR' });
    const sev = fields.filter((f) => f.key === 'severity');
    expect(sev.map((f) => f.type)).toEqual(['select']);
  });

  it('dynamicSeverity true shows the pattern instead', () => {
    const fields = visibleFieldsFor('tb:action:create-alarm', { dynamicSeverity: true, severity: '${severity}' });
    expect(fields.filter((f) => f.key === 'severity').map((f) => f.type)).toEqual(['template']);
  });

  it('an unknown type has no fields', () => {
    expect(visibleFieldsFor('tb:unsupported', {})).toEqual([]);
  });
});
