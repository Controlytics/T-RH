import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '../header';

vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: { appName: 'T&RH-Monitoring', primaryColor: '#123456', secondaryColor: '#654321' } }),
}));

const user = { id: 'u1', username: 'superadmin', role: 'SUPER_ADMIN', fullName: 'Super Admin', email: 'sa@example.com', department: 'IT', photoUrl: null } as any;

function mount(props: Partial<React.ComponentProps<typeof Header>> = {}) {
  return render(
    <MemoryRouter>
      <Header user={user} onLogout={() => {}} onMenuToggle={() => {}} onCollapseToggle={() => {}} {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('Header', () => {
  // Operator (2026-09-18): "Add aws text word on nav bar".
  it('shows the AWS word in the left cluster whatever the sidebar state', () => {
    mount({ collapsed: false });
    expect(screen.getByTestId('header-aws-label')).toHaveTextContent('AWS testing');
    cleanup();
    mount({ collapsed: true });
    expect(screen.getByTestId('header-aws-label')).toHaveTextContent('AWS testing');
  });

  it('shows the app name only once the sidebar has collapsed to a rail', () => {
    mount({ collapsed: false });
    expect(screen.queryByText('T&RH-Monitoring')).toBeNull();
    cleanup();
    mount({ collapsed: true });
    expect(screen.getByText('T&RH-Monitoring')).toBeInTheDocument();
  });
});
