import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BRANDING_TAB_TITLE_DEFAULT } from '@digilog/shared';

const postFormData = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { postFormData: (...a: unknown[]) => postFormData(...a) } }));

import { BrowserTabSection } from '../branding-components/browser-tab-section';

/**
 * The Browser Tab config card (2026-09-03).
 *
 * The property worth protecting is easy to get wrong and invisible in a diff: this
 * card's client-side file check must NOT be stricter than the server's. It exists
 * only to save a round trip, and the server's magic-byte check is the boundary.
 */
describe('BrowserTabSection', () => {
  const onFaviconChange = vi.fn();
  const register = ((name: string) => ({ name, onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn() })) as never;

  const setup = (props: Partial<{ tabTitle: string; faviconUrl: string }> = {}) =>
    render(
      <BrowserTabSection
        tabTitle={props.tabTitle ?? 'T&RH-Monitoring'}
        faviconUrl={props.faviconUrl ?? ''}
        register={register}
        errors={{}}
        onFaviconChange={onFaviconChange}
      />,
    );

  const fileInput = (c: HTMLElement) => c.querySelector('input[type="file"]') as HTMLInputElement;

  const drop = (c: HTMLElement, file: File) => {
    Object.defineProperty(fileInput(c), 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput(c));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    postFormData.mockResolvedValue({ url: '/uploads/branding/new.ico' });
  });

  it('shows the administered title in the tab preview', () => {
    setup({ tabTitle: 'Plant 2 Monitoring' });
    expect(screen.getByText('Plant 2 Monitoring')).toBeInTheDocument();
  });

  it('falls back to the SHIPPED default in the preview, never to a blank tab', () => {
    setup({ tabTitle: '' });
    expect(screen.getByText(BRANDING_TAB_TITLE_DEFAULT)).toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS. A `.ico` frequently arrives with an EMPTY `file.type`,
   * because the browser could not map the extension. A bare
   * `!file.type.startsWith('image/')` guard rejects it HERE, before the request is
   * made, under a message that lists ICO as accepted — i.e. it refuses the exact
   * format this card's upload route was built for, and it presents to the operator
   * as "I uploaded my icon and nothing happened".
   */
  it('uploads a .ico whose type the browser could not identify', async () => {
    const { container } = setup();
    drop(container, new File([new Uint8Array([0, 0, 1, 0])], 'favicon.ico', { type: '' }));
    await waitFor(() => expect(postFormData).toHaveBeenCalledTimes(1));
    expect(postFormData.mock.calls[0][0]).toBe('/api/uploads/branding-favicon');
    await waitFor(() => expect(onFaviconChange).toHaveBeenCalledWith('/uploads/branding/new.ico'));
  });

  it('uploads a .ico that DOES declare an icon mime type', async () => {
    const { container } = setup();
    drop(container, new File([new Uint8Array([0, 0, 1, 0])], 'favicon.ico', { type: 'image/x-icon' }));
    await waitFor(() => expect(postFormData).toHaveBeenCalledTimes(1));
  });

  // The relaxation above must not become "send anything".
  it('still refuses a file the browser identifies as a non-image', async () => {
    const { container } = setup();
    drop(container, new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(screen.getByText(/Select an image file/i)).toBeInTheDocument());
    expect(postFormData).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal rather than swallowing it", async () => {
    postFormData.mockRejectedValue({ message: 'File content does not match declared type' });
    const { container } = setup();
    drop(container, new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByText(/does not match declared type/i)).toBeInTheDocument());
    expect(onFaviconChange).not.toHaveBeenCalled();
  });

  it('clears the icon back to the shipped default on Remove', () => {
    setup({ faviconUrl: '/uploads/branding/old.png' });
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onFaviconChange).toHaveBeenCalledWith('');
  });

  it('offers Remove only once an icon has been administered', () => {
    const { unmount } = setup({ faviconUrl: '' });
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.getByRole('button', { name: /upload icon/i })).toBeInTheDocument();
    unmount();
    setup({ faviconUrl: '/uploads/branding/old.png' });
    expect(screen.getByRole('button', { name: /replace icon/i })).toBeInTheDocument();
  });
});
