import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChecklistDialog } from '../checklist-dialog';

/**
 * Regression tests for the empty-checklist submit guard (2026-07-09).
 *
 * A pending checklist that resolves to ZERO questions means its questions
 * failed to load (stale/degraded cache — the pipeline never gates on a
 * genuinely question-less checklist). The dialog must NOT post an empty answer
 * set: the server rejects a real required checklist, dead-ending the operator.
 * Instead it blocks with a recovery message and surfaces a "couldn't load"
 * notice so the operator understands why the form is empty.
 */

const q = (over: Partial<any> = {}) => ({
  id: 'q1', question: 'Temperature OK?', questionType: 'YES_NO', required: true,
  section: '', description: '', options: [], sortOrder: 0, ...over,
});

const mkDialog = (questions: any) => ({
  filterId: 'f1', filterName: 'MF-1',
  checklists: [{ pipelineNodeId: 'n1', checklistProfileId: 'p1', checklistProfileName: 'Dry-in', questions }],
});

describe('ChecklistDialog — empty-questions guard', () => {
  it('blocks submit and shows a recovery message when questions is an empty array', () => {
    const onSubmit = vi.fn();
    render(<ChecklistDialog dialog={mkDialog([])} onClose={() => {}} onSubmit={onSubmit} loading={false} error="" />);
    // The "couldn't load" notice is visible instead of a blank body.
    expect(screen.getByText(/couldn't load this checklist's questions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit checklist/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/could not load its questions/i)).toBeInTheDocument();
  });

  it('blocks submit when questions is undefined (missing key)', () => {
    const onSubmit = vi.fn();
    render(<ChecklistDialog dialog={mkDialog(undefined)} onClose={() => {}} onSubmit={onSubmit} loading={false} error="" />);
    fireEvent.click(screen.getByRole('button', { name: /submit checklist/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still enforces required answers when questions ARE loaded', () => {
    const onSubmit = vi.fn();
    render(<ChecklistDialog dialog={mkDialog([q()])} onClose={() => {}} onSubmit={onSubmit} loading={false} error="" />);
    // Submit without answering the required question → blocked, but NOT the empty-load path.
    fireEvent.click(screen.getByRole('button', { name: /submit checklist/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/please answer/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load its questions/i)).not.toBeInTheDocument();
  });

  it('submits when a loaded required question is answered', () => {
    const onSubmit = vi.fn();
    render(<ChecklistDialog dialog={mkDialog([q()])} onClose={() => {}} onSubmit={onSubmit} loading={false} error="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /submit checklist/i }));
    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Yes' });
  });
});

describe('ChecklistDialog — accessibility + escape guard', () => {
  it('marks the selected answer with aria-pressed AND a non-color indicator (WCAG 1.4.1)', () => {
    render(<ChecklistDialog dialog={mkDialog([q()])} onClose={() => {}} onSubmit={() => {}} loading={false} error="" />);
    const yes = screen.getByRole('button', { name: 'Yes' });
    const no = screen.getByRole('button', { name: 'No' });
    expect(yes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(yes);
    expect(yes).toHaveAttribute('aria-pressed', 'true');
    expect(no).toHaveAttribute('aria-pressed', 'false');
    // Non-color cue: the selected button carries a checkmark the unselected one lacks.
    expect(yes.querySelector('svg')).not.toBeNull();
    expect(no.querySelector('svg')).toBeNull();
  });

  it('Escape closes an untouched checklist', () => {
    const onClose = vi.fn();
    render(<ChecklistDialog dialog={mkDialog([q()])} onClose={onClose} onSubmit={() => {}} loading={false} error="" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape does NOT discard a half-filled checklist', () => {
    const onClose = vi.fn();
    render(<ChecklistDialog dialog={mkDialog([q()])} onClose={onClose} onSubmit={() => {}} loading={false} error="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' })); // enter an answer
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
