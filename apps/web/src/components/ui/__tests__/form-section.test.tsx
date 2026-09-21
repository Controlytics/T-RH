import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormSection } from '../form-section';

describe('FormSection', () => {
  it('is a labelled region with an h2 title and a two-column grid by default', () => {
    render(<FormSection title="Password rules"><label>Minimum length<input /></label></FormSection>);
    const region = screen.getByRole('region', { name: 'Password rules' });
    expect(region.querySelector('h2')).toHaveTextContent('Password rules');
    expect(screen.getByTestId('form-section-grid')).toHaveAttribute('data-columns', '2');
  });

  it('can be one column and carries its actions in the plate', () => {
    render(<FormSection title="LDAP" columns={1} actions={<button type="button">Test connection</button>}><p>x</p></FormSection>);
    expect(screen.getByTestId('form-section-grid')).toHaveAttribute('data-columns', '1');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });
});
