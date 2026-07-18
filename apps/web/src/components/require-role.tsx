import { useAuth } from '@/hooks/use-auth';

interface RequireRoleProps {
  roles?: string[];
  permissions?: string[];
  children: React.ReactNode;
}

export function RequireRole({ roles, permissions, children }: RequireRoleProps) {
  const { user } = useAuth();

  if (!user) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center space-y-3 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto">
            <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
          <p className="text-sm text-slate-500">You don't have permission to access this page.</p>
        </div>
      </div>
    );
  }

  // SUPER_ADMIN bypasses all checks
  if (user.role === 'SUPER_ADMIN') {
    return <>{children}</>;
  }

  // Check role-based access
  if (roles && roles.includes(user.role)) {
    return <>{children}</>;
  }

  // Check permission-based access
  if (permissions && user.permissions) {
    const hasPermission = permissions.some(p => user.permissions!.includes(p));
    if (hasPermission) {
      return <>{children}</>;
    }
  }

  // If only roles were specified and no permissions, deny
  // If only permissions were specified and none matched, deny
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center space-y-3 max-w-sm">
        <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-slate-800">Access Denied</h2>
        <p className="text-sm text-slate-500">You don't have permission to access this page.</p>
      </div>
    </div>
  );
}
