import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LoadError } from '@/components/ui/load-error';
import { apiClient } from '@/lib/api-client';
import { AUDIT_TEMPLATE_DEFAULTS, AUDIT_TEMPLATE_CATEGORIES } from '@digilog/shared';
import type { AuditTemplateDefinition } from '@digilog/shared';

export function AuditTemplatesConfigPage() {
  // `error` is read (audit 2026-10-03, WEB-6): a failed fetch used to leave the
  // spinner below turning forever.
  const { data: saved, error, mutate } = useSWR<Record<string, string>>('/api/config/audit-templates');
  const [templates, setTemplates] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  // Initialize local state from fetched data
  const currentTemplates = useMemo(() => {
    if (templates) return templates;
    if (!saved) return null;
    return { ...saved };
  }, [saved, templates]);

  // Group actions by category
  const grouped = useMemo(() => {
    const groups: Record<string, { key: string; def: AuditTemplateDefinition }[]> = {};
    for (const cat of AUDIT_TEMPLATE_CATEGORIES) {
      groups[cat] = [];
    }
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      if (!groups[def.category]) groups[def.category] = [];
      groups[def.category].push({ key, def });
    }
    return groups;
  }, []);

  const handleChange = (key: string, value: string) => {
    setTemplates(prev => ({
      ...(prev ?? currentTemplates ?? {}),
      [key]: value,
    }));
    setSuccessMsg('');
  };

  const handleReset = (key: string) => {
    const defaultTemplate = AUDIT_TEMPLATE_DEFAULTS[key]?.template ?? '';
    handleChange(key, defaultTemplate);
  };

  const handleResetAll = () => {
    const defaults: Record<string, string> = {};
    for (const [key, def] of Object.entries(AUDIT_TEMPLATE_DEFAULTS)) {
      defaults[key] = def.template;
    }
    setTemplates(defaults);
    setSuccessMsg('');
  };

  const handleSave = async () => {
    if (!currentTemplates) return;
    setSaving(true);
    setSuccessMsg('');
    try {
      await apiClient.put('/api/config/audit-templates', currentTemplates);
      await mutate();
      setTemplates(null);
      setSuccessMsg('Audit text templates saved successfully.');
    } catch {
      // handled by api-client
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = useMemo(() => {
    if (!templates || !saved) return false;
    return JSON.stringify(templates) !== JSON.stringify(saved);
  }, [templates, saved]);

  if (!currentTemplates) {
    if (error) return <LoadError what="audit text templates" error={error} />;
    return (
      <div className="flex items-center justify-center p-12">
        <svg className="w-8 h-8 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  // Sample data for live preview
  const sampleValues: Record<string, string> = {
    actor: 'operator1',
    targetUser: 'user123',
    targetName: 'Daily Check',
    configKey: 'password-policy',
    targetType: 'Template',
  };

  const renderPreview = (templateStr: string) => {
    return templateStr
      .replace(/\{actor\}/g, sampleValues.actor)
      .replace(/\{targetUser\}/g, sampleValues.targetUser)
      .replace(/\{targetName\}/g, sampleValues.targetName)
      .replace(/\{configKey\}/g, sampleValues.configKey)
      .replace(/\{targetType\}/g, sampleValues.targetType);
  };

  const placeholderColors: Record<string, string> = {
    actor: 'bg-blue-100 text-blue-700 border-blue-200',
    targetUser: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    targetName: 'bg-purple-100 text-purple-700 border-purple-200',
    configKey: 'bg-amber-100 text-amber-700 border-amber-200',
    targetType: 'bg-rose-100 text-rose-700 border-rose-200',
  };

  const categoryGradients: Record<string, string> = {
    'User Management': 'from-blue-500 to-indigo-600',
    'Authentication': 'from-emerald-500 to-teal-600',
    'Configuration': 'from-purple-500 to-violet-600',
    'Hierarchy & Filters': 'from-orange-500 to-amber-600',
    'Role Management': 'from-violet-500 to-purple-600',
    'Backup': 'from-teal-500 to-emerald-600',
    'Data & Approvals': 'from-rose-500 to-pink-600',
  };

  return (
    <div className="space-y-5">
      {/* Panel toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-slate-500 max-w-2xl">Customize how audit trail actions are described.</p>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={handleResetAll}>Reset All</Button>
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {/* Success Message */}
      {successMsg && (
        <div className="p-4 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {successMsg}
        </div>
      )}

      {/* Placeholder Legend */}
      <Card className="border-slate-200/60 shadow-soft">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-slate-600">Available Placeholders:</span>
            <Badge className="bg-blue-100 text-blue-700 border border-blue-200">{'{actor}'} = Performing User</Badge>
            <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200">{'{targetUser}'} = Affected User</Badge>
            <Badge className="bg-purple-100 text-purple-700 border border-purple-200">{'{targetName}'} = Entity Name</Badge>
            <Badge className="bg-amber-100 text-amber-700 border border-amber-200">{'{configKey}'} = Config Key</Badge>
            <Badge className="bg-rose-100 text-rose-700 border border-rose-200">{'{targetType}'} = Target Type</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Template Groups */}
      {AUDIT_TEMPLATE_CATEGORIES.map(category => {
        const items = grouped[category];
        if (!items || items.length === 0) return null;

        return (
          <Card key={category} className="border-slate-200/60 shadow-[var(--elev-2)] overflow-hidden">
            <div className={`h-1 bg-gradient-to-r ${categoryGradients[category] || 'from-slate-400 to-slate-500'}`} />
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/80">
              <h2 className="text-[1.1875rem] font-semibold leading-tight text-slate-800">{category}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{items.length} action{items.length > 1 ? 's' : ''}</p>
            </div>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-100">
                {items.map(({ key, def }) => {
                  const currentValue = currentTemplates[key] ?? def.template;
                  const isDefault = currentValue === def.template;

                  return (
                    <div key={key} className="px-6 py-4 hover:bg-slate-50/50 transition-colors">
                      <div className="flex items-start gap-4">
                        <div className="flex-shrink-0 w-48">
                          <p className="text-sm font-semibold text-slate-800">{def.label}</p>
                          <p className="text-xs text-slate-400 font-mono mt-0.5">{key}</p>
                          <div className="flex flex-wrap gap-1 mt-2">
                            {def.placeholders.map(p => (
                              <span key={p} className={`inline-flex px-1.5 py-0.5 rounded text-[0.625rem] font-medium border ${placeholderColors[p] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                                {`{${p}}`}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex-1 space-y-2">
                          <Input
                            value={currentValue}
                            onChange={(e) => handleChange(key, e.target.value)}
                            className="text-sm"
                            placeholder={def.template}
                          />
                          {/* Live Preview */}
                          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50/70 border border-indigo-100">
                            <svg className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            <span className="text-xs text-indigo-700 italic">{renderPreview(currentValue)}</span>
                          </div>
                        </div>
                        <div className="flex-shrink-0">
                          {!isDefault ? (
                            <Button variant="ghost" size="sm" onClick={() => handleReset(key)} className="text-slate-500 hover:text-indigo-600 text-xs">
                              Reset
                            </Button>
                          ) : (
                            <span className="inline-flex px-2 py-1 rounded text-xs text-slate-400">Default</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Bottom Save Bar */}
      {hasChanges && (
        <div className="sticky bottom-4 z-10">
          <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 shadow-[var(--elev-2)] p-4 flex items-center justify-between border-t border-t-slate-100">
            <p className="text-sm text-slate-500">You have unsaved changes.</p>
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => { setTemplates(null); setSuccessMsg(''); }}>
                Discard
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
