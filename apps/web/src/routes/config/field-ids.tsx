import { useState, useMemo } from 'react';
import useSWR, { mutate } from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';

interface FieldConfig {
  id: string;
  fieldId: string;
  defaultName: string;
  displayName: string;
  module: string;
  description?: string;
  updatedAt: string;
  updatedBy?: string;
}

const MODULE_COLORS: Record<string, { from: string; to: string; text: string; bg: string }> = {
  'User Management': { from: 'from-blue-500', to: 'to-indigo-600', text: 'text-blue-700', bg: 'bg-blue-50' },
  'Audit Trail': { from: 'from-indigo-500', to: 'to-purple-600', text: 'text-indigo-700', bg: 'bg-indigo-50' },
  // 'Alarms' module removed 2026-05-17 (alarm subsystem retired; FLD_ALARM_001..011 seed rows dropped).
  'Asset Management': { from: 'from-emerald-500', to: 'to-teal-600', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  'Notifications': { from: 'from-amber-500', to: 'to-orange-600', text: 'text-amber-700', bg: 'bg-amber-50' },
  'Telemetry': { from: 'from-cyan-500', to: 'to-blue-600', text: 'text-cyan-700', bg: 'bg-cyan-50' },
  'Attributes': { from: 'from-violet-500', to: 'to-purple-600', text: 'text-violet-700', bg: 'bg-violet-50' },
};

const MODULE_ICONS: Record<string, string> = {
  'User Management': 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
  'Audit Trail': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  // 'Alarms' module icon removed 2026-05-17 (alarm subsystem retired).
  'Asset Management': 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
  'Notifications': 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  'Telemetry': 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  'Attributes': 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
};

export function FieldIdsPage() {
  const { formatDateTime } = useDatetimeFormat();
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeModule, setActiveModule] = useState<string | null>(null);

  const { data: fields, isLoading } = useSWR<FieldConfig[]>('/api/config/field-ids', { revalidateOnMount: true, dedupingInterval: 0 });

  const modules = useMemo(() => {
    if (!fields) return [];
    const mods = [...new Set(fields.map(f => f.module))];
    return mods.sort();
  }, [fields]);

  const filteredFields = useMemo(() => {
    let result = fields || [];
    if (activeModule) result = result.filter(f => f.module === activeModule);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f =>
        f.fieldId.toLowerCase().includes(q) ||
        f.displayName.toLowerCase().includes(q) ||
        f.module.toLowerCase().includes(q) ||
        (f.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [fields, activeModule, searchQuery]);

  const groupedFields = useMemo(() => {
    const groups: Record<string, FieldConfig[]> = {};
    for (const f of filteredFields) {
      if (!groups[f.module]) groups[f.module] = [];
      groups[f.module].push(f);
    }
    return groups;
  }, [filteredFields]);

  const handleEdit = (field: FieldConfig) => {
    setEditingField(field.fieldId);
    setEditValue(field.displayName);
  };

  const handleSave = async (fieldId: string) => {
    if (!editValue.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.put(`/api/config/field-ids/${fieldId}`, { displayName: editValue.trim() });
      mutate('/api/config/field-ids');
      setEditingField(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to save field name');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditingField(null);
    setEditValue('');
  };

  const handleReset = async (field: FieldConfig) => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/api/config/field-ids/${field.fieldId}`, { displayName: field.defaultName });
      mutate('/api/config/field-ids');
    } catch (err: any) {
      setError(err?.message || 'Failed to reset field name');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500 max-w-2xl">Configure display names for system field identifiers across all modules ({modules.length} modules · {fields?.length || 0} fields). Edit a field and Save it inline.</p>

      {/* Error Display */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
          <div className="p-2 rounded-lg bg-red-100">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError('')} className="ml-auto p-1 rounded-lg hover:bg-red-100 transition-colors">
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Module Filter Tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setActiveModule(null)}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
            !activeModule
              ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/25'
              : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
          }`}
        >
          All Modules ({fields?.length || 0})
        </button>
        {modules.map(mod => {
          const colors = MODULE_COLORS[mod] || { from: 'from-slate-500', to: 'to-slate-600', text: 'text-slate-700', bg: 'bg-slate-50' };
          const count = fields?.filter(f => f.module === mod).length || 0;
          return (
            <button
              key={mod}
              onClick={() => setActiveModule(activeModule === mod ? null : mod)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                activeModule === mod
                  ? `bg-gradient-to-r ${colors.from} ${colors.to} text-white shadow-lg`
                  : `${colors.bg} ${colors.text} hover:opacity-80 border border-transparent`
              }`}
            >
              {mod} ({count})
            </button>
          );
        })}
      </div>

      {/* Search Section */}
      <Card className="border-0 shadow-xl bg-gradient-to-br from-white via-white to-slate-50/50 overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500" />
        <CardContent className="p-5">
          <div className="flex items-center gap-4">
            <div className="flex-1 relative group">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-hover:text-cyan-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Input
                placeholder="Search by field ID, display name, or module..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-12 h-12 rounded-xl border-slate-200 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all text-base"
              />
            </div>
            {searchQuery && (
              <Button variant="outline" onClick={() => setSearchQuery('')} className="h-12 px-4 rounded-xl hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all">
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Clear
              </Button>
            )}
          </div>
          {searchQuery && (
            <p className="mt-3 text-sm text-slate-500">
              Found <span className="font-semibold text-cyan-600">{filteredFields.length}</span> matching fields
            </p>
          )}
        </CardContent>
      </Card>

      {/* Fields grouped by module */}
      {isLoading ? (
        <Card className="border-0 shadow-xl overflow-hidden">
          <CardContent className="p-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 mb-4 animate-pulse">
              <svg className="w-8 h-8 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
            </div>
            <p className="text-slate-600 font-medium">Loading field configurations...</p>
          </CardContent>
        </Card>
      ) : Object.keys(groupedFields).length === 0 ? (
        <Card className="border-0 shadow-xl overflow-hidden">
          <CardContent className="p-16 text-center">
            <p className="text-slate-700 font-semibold text-lg">No fields found</p>
            <p className="text-sm text-slate-400 mt-1">
              {searchQuery ? 'Try adjusting your search query' : 'No field IDs have been configured yet'}
            </p>
          </CardContent>
        </Card>
      ) : (
        Object.entries(groupedFields).sort(([a], [b]) => a.localeCompare(b)).map(([module, moduleFields]) => {
          const colors = MODULE_COLORS[module] || { from: 'from-slate-500', to: 'to-slate-600', text: 'text-slate-700', bg: 'bg-slate-50' };
          const iconPath = MODULE_ICONS[module] || 'M4 6h16M4 10h16M4 14h16M4 18h16';
          return (
            <Card key={module} className="border-0 shadow-xl overflow-hidden">
              <div className={`h-1 bg-gradient-to-r ${colors.from} ${colors.to}`} />
              <div className="px-6 py-4 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100 flex items-center gap-3">
                <div className={`p-2.5 rounded-xl bg-gradient-to-br ${colors.from} ${colors.to} text-white shadow-md`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={iconPath} />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">{module}</h2>
                  <p className="text-xs text-slate-500">{moduleFields.length} field{moduleFields.length > 1 ? 's' : ''}</p>
                </div>
              </div>
              <CardContent className="p-0">
                <div className="divide-y divide-slate-100">
                  {moduleFields.map((field) => (
                    <div key={field.fieldId} className="group flex items-center justify-between p-5 hover:bg-gradient-to-r hover:from-cyan-50/50 hover:to-blue-50/30 transition-all duration-200">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-4">
                          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/10 to-blue-500/10 flex items-center justify-center group-hover:from-cyan-500/20 group-hover:to-blue-500/20 transition-all">
                            <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                            </svg>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 flex-wrap">
                              <code className="inline-flex items-center px-3 py-1.5 text-xs font-mono bg-gradient-to-r from-slate-100 to-slate-50 rounded-lg text-slate-600 border border-slate-200/60">
                                <svg className="w-3 h-3 mr-1.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                                </svg>
                                {field.fieldId}
                              </code>
                              <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                              </svg>
                              {editingField === field.fieldId ? (
                                <Input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="max-w-xs h-10 rounded-lg border-cyan-300 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSave(field.fieldId);
                                    if (e.key === 'Escape') handleCancel();
                                  }}
                                />
                              ) : (
                                <span className="font-semibold text-slate-800 text-base">
                                  {field.displayName}
                                  {field.displayName !== field.defaultName && (
                                    <span className="ml-2 text-xs text-slate-400 font-normal">(default: {field.defaultName})</span>
                                  )}
                                </span>
                              )}
                            </div>
                            {field.description && (
                              <p className="text-sm text-slate-500 mt-1.5 ml-16">{field.description}</p>
                            )}
                            {field.updatedBy && (
                              <p className="text-xs text-slate-400 mt-1.5 ml-16 flex items-center gap-1.5">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Updated by <span className="font-medium text-slate-500">{field.updatedBy}</span> on {formatDateTime(field.updatedAt)}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        {editingField === field.fieldId ? (
                          <>
                            <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>Cancel</Button>
                            <Button size="sm" onClick={() => handleSave(field.fieldId)} disabled={saving || !editValue.trim()}>
                              {saving ? 'Saving...' : 'Save'}
                            </Button>
                          </>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            {field.displayName !== field.defaultName && (
                              <Button variant="ghost" size="sm" onClick={() => handleReset(field)} disabled={saving}
                                className="rounded-lg text-slate-400 hover:text-orange-600 hover:bg-orange-50">
                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Reset
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => handleEdit(field)}
                              className="rounded-lg text-slate-500 hover:text-cyan-600 hover:bg-cyan-50">
                              <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                              Edit
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      {/* Info Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-cyan-50 via-blue-50 to-indigo-50 border border-cyan-100/50 p-5">
        <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-cyan-500/10 to-blue-500/10 rounded-full blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex-shrink-0 p-3 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/25">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-cyan-900 mb-1">Field ID Configuration</h3>
            <p className="text-sm text-cyan-700">
              These display names are used throughout the application to show user-friendly labels for system fields.
              Changes will take effect immediately across all screens. Use the module tabs above to filter by area.
            </p>
            <div className="flex items-center gap-4 mt-3">
              <div className="flex items-center gap-1.5 text-xs text-cyan-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Real-time updates</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-cyan-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span>Audit tracked</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-cyan-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <span>{modules.length} modules configured</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
