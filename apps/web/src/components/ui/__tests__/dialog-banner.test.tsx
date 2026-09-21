import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DialogBanner } from '../dialog-banner';

describe('DialogBanner', () => {
  it('names the dialog in an h2 and is themed by default', () => {
    render(<DialogBanner title="Acknowledge alarm" subtitle="CWH/RDU/001-00" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Acknowledge alarm' })).toBeInTheDocument();
    expect(screen.getByTestId('dialog-banner')).toHaveAttribute('data-tone', 'theme');
  });

  it('a destructive dialog says so in its tone', () => {
    render(<DialogBanner title="Delete floor plan" tone="danger" />);
    expect(screen.getByTestId('dialog-banner')).toHaveAttribute('data-tone', 'danger');
  });
});
