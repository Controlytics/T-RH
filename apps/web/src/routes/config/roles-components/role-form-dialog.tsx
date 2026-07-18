import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RoleColorPicker } from './role-color-picker';

export interface RoleFormData {
  name: string;
  displayName: string;
  description: string;
  hierarchyLevel: number;
  color: string;
  permissions: string[];
}

interface RoleFormDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  formData: RoleFormData;
  setFormData: React.Dispatch<React.SetStateAction<RoleFormData>>;
  error: string;
  saving: boolean;
  onSubmit: () => void;
  isEdit: boolean;
  isSystem?: boolean;
}

export function RoleFormDialog({
  open,
  onClose,
  title,
  formData,
  setFormData,
  error,
  saving,
  onSubmit,
  isEdit,
  isSystem,
}: RoleFormDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-100 text-purple-600">
            {isEdit ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>
          {title}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-5">
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
            <div className="p-2 rounded-lg bg-red-100">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {isEdit && isSystem && (
          <div className="flex items-center gap-3 rounded-xl bg-amber-50 border border-amber-200 p-4">
            <div className="p-2 rounded-lg bg-amber-100">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p className="text-sm text-amber-700">
              This is a system role. You can modify its display name, description, and color, but the role name cannot be changed.
            </p>
          </div>
        )}

        {/* Basic Info */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">
              Role Name {!isEdit && '*'}
            </label>
            {isEdit ? (
              <Input
                value={formData.name}
                disabled
                className="h-12 font-mono bg-slate-50"
              />
            ) : (
              <>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                  placeholder="e.g., QUALITY_ASSURANCE"
                  className="h-12 font-mono"
                />
                <p className="text-xs text-slate-500">Uppercase letters and underscores only</p>
              </>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Display Name *</label>
            <Input
              value={formData.displayName}
              onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              placeholder={isEdit ? undefined : 'e.g., Quality Assurance'}
              className="h-12"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-slate-700">Description</label>
          <Input
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Brief description of this role's purpose"
            className="h-12"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Hierarchy Level</label>
            <Input
              type="number"
              min={1}
              max={10}
              value={formData.hierarchyLevel}
              onChange={(e) => setFormData({ ...formData, hierarchyLevel: parseInt(e.target.value) || 1 })}
              className="h-12"
              disabled={isEdit && isSystem}
            />
            {!isEdit && (
              <p className="text-xs text-slate-500">Higher level = more privileges (1-10)</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Badge Color</label>
            <RoleColorPicker
              selectedColor={formData.color}
              onSelect={(color) => setFormData({ ...formData, color })}
            />
          </div>
        </div>

        {/* Info note about permissions */}
        <div className="flex items-center gap-3 rounded-xl bg-blue-50 border border-blue-200 p-4">
          <div className="p-2 rounded-lg bg-blue-100">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-blue-700">
            To configure permissions for this role, switch to the <strong>Permissions</strong> tab above.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={saving}
            className="bg-gradient-to-r from-purple-500 to-indigo-600"
          >
            {saving
              ? (isEdit ? 'Saving...' : 'Creating...')
              : (isEdit ? 'Save Changes' : 'Create Role')
            }
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
