import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { RoleData } from '@digilog/shared';
import { SkeletonRows } from '@/components/ui/skeleton';

interface RoleTableProps {
  roles: RoleData[] | undefined;
  isLoading: boolean;
  isSuperAdmin: boolean;
  onEdit: (role: RoleData) => void;
  onDelete: (role: RoleData) => void;
}

export function RoleTable({ roles, isLoading, isSuperAdmin, onEdit, onDelete }: RoleTableProps) {
  return (
    <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={5} columns={4} />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/80">
                <TableHead className="font-semibold text-slate-600">Role</TableHead>
                <TableHead className="font-semibold text-slate-600">Description</TableHead>
                <TableHead className="font-semibold text-slate-600 text-center">Hierarchy</TableHead>
                <TableHead className="font-semibold text-slate-600 text-center">Permissions</TableHead>
                <TableHead className="font-semibold text-slate-600 text-center">Type</TableHead>
                <TableHead className="font-semibold text-slate-600 text-center">Status</TableHead>
                {isSuperAdmin && (
                  <TableHead className="font-semibold text-slate-600 text-center">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles?.map((role) => (
                <TableRow key={role.id} className="hover:bg-slate-50/50 transition-colors">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex px-3 py-1.5 rounded-full text-xs font-semibold text-white ${role.color}`}>
                        {role.displayName}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">{role.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <p className="text-sm text-slate-600 max-w-xs truncate">
                      {role.description || '-'}
                    </p>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className="font-mono">
                      Level {role.hierarchyLevel}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="text-sm font-medium text-slate-700">
                      {role.permissions.length}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {role.isSystem ? (
                      <Badge className="bg-amber-100 text-amber-700 border-amber-200">System</Badge>
                    ) : (
                      <Badge className="bg-blue-100 text-blue-700 border-blue-200">Custom</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {role.isActive ? (
                      <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">Active</Badge>
                    ) : (
                      <Badge className="bg-slate-100 text-slate-700 border-slate-200">Inactive</Badge>
                    )}
                  </TableCell>
                  {isSuperAdmin && (
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onEdit(role)}
                          className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDelete(role)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
