import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MESSAGE_TYPE_SWITCH_LABELS } from '@digilog/shared';
import { RelationPicker, relationChoicesFor } from '../relation-picker';

/**
 * The relation picker (rule chains, 2026-11-04): what a connection drawn from a
 * node may be labelled. It offers the SOURCE node type's relations only — the
 * Message type switch its ThingsBoard labels, a fixed node its list, a node
 * whose relations are named at run time (Switch, Device profile switch, Rule
 * chain) free text with suggestions — several at once, as ThingsBoard's link
 * dialog does.
 */

function open(props: Partial<Parameters<typeof RelationPicker>[0]> & { sourceType: string }) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <RelationPicker
      open
      sourceName="Source"
      targetName="Target"
      existing={[]}
      onPick={onPick}
      onClose={onClose}
      {...props}
    />,
  );
  return { onPick, onClose };
}

const check = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('relationChoicesFor', () => {
  it('the Message type switch: every ThingsBoard label, Other and Failure — no free text', () => {
    const c = relationChoicesFor('tb:filter:message-type-switch');
    expect(c.free).toBe(false);
    for (const label of Object.values(MESSAGE_TYPE_SWITCH_LABELS)) expect(c.fixed).toContain(label);
    expect(c.fixed).toContain('Other');
    expect(c.fixed).toContain('Failure');
    expect(new Set(c.fixed).size).toBe(c.fixed.length);
  });

  it('a fixed node: its own list only', () => {
    expect(relationChoicesFor('tb:action:save-timeseries')).toEqual({ fixed: ['Success', 'Failure'], free: false });
    expect(relationChoicesFor('tb:filter:script')).toEqual({ fixed: ['True', 'False', 'Failure'], free: false });
  });

  it('a node whose relations are named at run time: Failure plus free text', () => {
    for (const t of ['tb:filter:switch', 'tb:filter:device-profile-switch', 'tb:flow:rule-chain']) {
      expect(relationChoicesFor(t)).toEqual({ fixed: ['Failure'], free: true });
    }
  });

  it('a node with no counterpart here, or an Unsupported one: Failure only', () => {
    expect(relationChoicesFor('tb:unsupported')).toEqual({ fixed: ['Failure'], free: false });
    expect(relationChoicesFor('tb:action:rpc-call-request')).toEqual({ fixed: ['Failure'], free: false });
  });

  it('Output: nothing (it returns to the calling chain)', () => {
    expect(relationChoicesFor('tb:flow:output')).toEqual({ fixed: [], free: false });
  });
});

describe('RelationPicker', () => {
  it('offers the Message type switch\'s labels, and picking TWO sends both', () => {
    const { onPick } = open({ sourceType: 'tb:filter:message-type-switch' });
    expect(screen.queryByLabelText('Custom label')).toBeNull();
    check('Post telemetry');
    check('Post attributes');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith(['Post attributes', 'Post telemetry']);
  });

  it('a second click on a label takes it back out', () => {
    const { onPick } = open({ sourceType: 'tb:filter:message-type-switch' });
    check('Post telemetry');
    check('Alarm');
    check('Post telemetry');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith(['Alarm']);
  });

  it('narrows a long list by the filter box', () => {
    open({ sourceType: 'tb:filter:message-type-switch' });
    fireEvent.change(screen.getByLabelText('Filter labels'), { target: { value: 'alarm' } });
    const boxes = screen.getAllByRole('checkbox').map((b) => b.getAttribute('aria-label') ?? (b as HTMLInputElement).labels?.[0]?.textContent);
    expect(boxes.length).toBeGreaterThan(3);
    expect(boxes.every((l) => /alarm/i.test(String(l)))).toBe(true);
  });

  it('a fixed node offers its list and no custom label; nothing picked = no Add', () => {
    open({ sourceType: 'tb:action:save-timeseries' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByLabelText('Custom label')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('editing a link starts from its labels; clearing them all removes the link', () => {
    const { onPick } = open({ sourceType: 'tb:action:save-timeseries', existing: ['Success', 'Failure'], editing: true });
    expect(screen.getByRole('checkbox', { name: 'Success' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Failure' })).toBeChecked();
    check('Success');
    check('Failure');
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onPick).toHaveBeenCalledWith([]);
  });

  it('Switch: a custom label and a suggestion, beside Failure', () => {
    const { onPick } = open({ sourceType: 'tb:filter:switch', suggestions: ['two', 'nine'] });
    fireEvent.change(screen.getByLabelText('Custom label'), { target: { value: '  hot  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    check('Failure');
    const chosen = screen.getByTestId('relation-chosen');
    expect(within(chosen).getByText('hot')).toBeInTheDocument();
    expect(within(chosen).getByText('two')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith(['Failure', 'hot', 'two']);
  });

  it('a custom label already chosen is not added twice, and can be removed', () => {
    const { onPick } = open({ sourceType: 'tb:filter:switch' });
    for (let i = 0; i < 2; i++) {
      fireEvent.change(screen.getByLabelText('Custom label'), { target: { value: 'hot' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    }
    fireEvent.change(screen.getByLabelText('Custom label'), { target: { value: 'cold' } });
    fireEvent.keyDown(screen.getByLabelText('Custom label'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove hot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onPick).toHaveBeenCalledWith(['cold']);
  });

  it('an existing custom label of a dynamic node is shown chosen', () => {
    open({ sourceType: 'tb:filter:switch', existing: ['hot', 'Failure'], editing: true });
    expect(screen.getByRole('checkbox', { name: 'Failure' })).toBeChecked();
    expect(within(screen.getByTestId('relation-chosen')).getByText('hot')).toBeInTheDocument();
  });

  it('Cancel picks nothing', () => {
    const { onPick, onClose } = open({ sourceType: 'tb:filter:script' });
    check('True');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
