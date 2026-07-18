import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { MessageDialog } from '../message-dialog';
import { useToastState } from '@/hooks/use-toast';

describe('MessageDialog', () => {
  it('renders a success message and OK calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<MessageDialog item={{ id: 'd1', variant: 'success', title: 'Saved', message: 'All good' }} onDismiss={onDismiss} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('All good')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onDismiss).toHaveBeenCalledWith('d1');
  });

  it('renders an error message with the error default text', () => {
    render(<MessageDialog item={{ id: 'd2', variant: 'error', title: 'Save Failed' }} onDismiss={() => {}} />);
    expect(screen.getByText('Save Failed')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('shows the success default message when none is provided', () => {
    render(<MessageDialog item={{ id: 'd3', variant: 'success', title: 'Done' }} onDismiss={() => {}} />);
    expect(screen.getByText('Your changes have been saved successfully.')).toBeInTheDocument();
  });

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn();
    render(<MessageDialog item={{ id: 'd4', variant: 'error', title: 'X' }} onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('d4');
  });
});

describe('useToastState dialog routing', () => {
  it('toast.success and toast.error enqueue MODAL dialogs (not toasts)', () => {
    const { result } = renderHook(() => useToastState());
    act(() => { result.current.toast.success('Saved'); result.current.toast.error('Save Failed', 'oops'); });
    expect(result.current.dialogs).toHaveLength(2);
    expect(result.current.dialogs[0]).toMatchObject({ variant: 'success', title: 'Saved' });
    expect(result.current.dialogs[1]).toMatchObject({ variant: 'error', title: 'Save Failed', message: 'oops' });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('successToast / errorToast / warning add non-blocking toasts', () => {
    const { result } = renderHook(() => useToastState());
    act(() => {
      result.current.toast.successToast('Synced');
      result.current.toast.errorToast('Load Error');
      result.current.toast.warning('Heads up');
    });
    expect(result.current.toasts).toHaveLength(3);
    expect(result.current.dialogs).toHaveLength(0);
  });

  it('dismissDialog removes the acknowledged dialog (FIFO)', () => {
    const { result } = renderHook(() => useToastState());
    act(() => { result.current.toast.success('One'); result.current.toast.error('Two'); });
    const firstId = result.current.dialogs[0].id;
    act(() => result.current.dismissDialog(firstId));
    expect(result.current.dialogs).toHaveLength(1);
    expect(result.current.dialogs[0].title).toBe('Two');
  });
});
