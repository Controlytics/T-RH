import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SampledNote } from '../sampled-note';

describe('SampledNote', () => {
  it('says nothing when every reading is shown', () => {
    const { container } = render(<SampledNote shown={400} total={400} />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * A chart showing a subset must SAY SO where the reader is already looking —
   * not in a tooltip, not behind an icon. Otherwise the page quietly implies a
   * resolution it does not have.
   */
  it('states both numbers when it is showing a subset', () => {
    render(<SampledNote shown={2000} total={28431} />);
    expect(screen.getByText(/2,000/)).toBeInTheDocument();
    expect(screen.getByText(/28,431/)).toBeInTheDocument();
  });

  it('groups thousands so the numbers are readable at a glance', () => {
    render(<SampledNote shown={1000} total={86400} />);
    expect(screen.getByText(/86,400/)).toBeInTheDocument();
  });

  it('says nothing when there is no data at all', () => {
    const { container } = render(<SampledNote shown={0} total={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
