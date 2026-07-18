import { themeButton } from '@/lib/theme-styles';
import type { CreateDialogState, TemplateField } from '../types';

type Props = {
  dialog: CreateDialogState;
  name: string;
  attrs: Record<string, string>;
  schema: TemplateField[];
  creating: boolean;
  onNameChange: (v: string) => void;
  onAttrChange: (next: (prev: Record<string, string>) => Record<string, string>) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function CreateHierarchyDialog({
  dialog, name, attrs, schema, creating,
  onNameChange, onAttrChange, onCancel, onSubmit,
}: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className={`h-1.5 ${dialog.type === 'block' ? '' : dialog.type === 'area' ? 'bg-gradient-to-r from-purple-500 to-violet-500' : 'bg-gradient-to-r from-teal-500 to-emerald-500'}`} style={dialog.type === 'block' ? { background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' } : undefined} />
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${dialog.type === 'area' ? 'bg-purple-50' : dialog.type === 'ahu' ? 'bg-teal-50' : ''}`} style={dialog.type === 'block' ? { backgroundColor: 'var(--theme-primary-light)' } : undefined}>
              <svg className={`w-5 h-5 ${dialog.type === 'area' ? 'text-purple-600' : dialog.type === 'ahu' ? 'text-teal-600' : ''}`} style={dialog.type === 'block' ? { color: 'var(--theme-primary)' } : undefined} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">Create {dialog.type === 'block' ? 'Block' : dialog.type === 'area' ? 'Area' : 'AHU'}</h3>
              {dialog.parentName && <p className="text-[12px] text-slate-400">Under {dialog.parentName}</p>}
            </div>
          </div>
          <div className="space-y-3 mb-5 max-h-[50vh] overflow-y-auto">
            <div>
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">Name <span className="text-red-500">*</span></label>
              <input value={name} onChange={e => onNameChange(e.target.value)} autoFocus
                placeholder={`Enter ${dialog.type} name...`}
                className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-800 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none" />
            </div>
            {/* Dynamic attribute fields from template schema */}
            {schema.map((field: any) => (
              <div key={field.fieldName}>
                <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 block">
                  {field.fieldName.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}
                  {field.unit && <span className="text-slate-400 normal-case font-normal"> ({field.unit})</span>}
                  {field.required && <span className="text-red-500"> *</span>}
                </label>
                {field.dataType === 'DROPDOWN' ? (
                  <select
                    value={attrs[field.fieldName] ?? ''}
                    onChange={e => onAttrChange(p => ({ ...p, [field.fieldName]: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-800 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none"
                  >
                    <option value="">Select...</option>
                    {(field.dropdownOptions ?? []).map((opt: string) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : field.dataType === 'BOOLEAN' ? (
                  <select
                    value={attrs[field.fieldName] ?? ''}
                    onChange={e => onAttrChange(p => ({ ...p, [field.fieldName]: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-800 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none"
                  >
                    <option value="">Select...</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : field.dataType === 'DATE' ? (
                  <input
                    type="date"
                    value={attrs[field.fieldName] ?? ''}
                    onChange={e => onAttrChange(p => ({ ...p, [field.fieldName]: e.target.value }))}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-800 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none"
                  />
                ) : (
                  <input
                    type={field.dataType === 'FLOAT' || field.dataType === 'NUMBER' || field.dataType === 'INTEGER' ? 'number' : 'text'}
                    step={field.dataType === 'FLOAT' ? 'any' : undefined}
                    value={attrs[field.fieldName] ?? ''}
                    onChange={e => onAttrChange(p => ({ ...p, [field.fieldName]: e.target.value }))}
                    placeholder={field.fieldName.replace(/_/g, ' ')}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-[13px] text-slate-800 focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={onCancel}
              className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium">Cancel</button>
            <button onClick={onSubmit} disabled={creating || !name.trim()}
              className={`flex-1 py-2.5 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg ${
                dialog.type === 'block' ? ''
                : dialog.type === 'area' ? 'bg-gradient-to-r from-purple-600 to-violet-600 shadow-purple-500/25'
                : 'bg-gradient-to-r from-teal-600 to-emerald-600 shadow-teal-500/25'
              }`}
              style={dialog.type === 'block' ? themeButton : undefined}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
