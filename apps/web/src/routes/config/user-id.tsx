import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

interface UserIdConfig {
  format: string;
  length: number;
  prefix: string;
  prefixSeparator: string;
  letterCase: string;
  autoGenerate: boolean;
  startNumber: number;
  customPattern: string;
  customPatternExample: string;
  customPatternDescription: string;
}

const FORMAT_OPTIONS = [
  { value: 'NUMBERS_ONLY', label: 'Numbers Only', example: '123456', description: 'Only numeric characters' },
  { value: 'LETTERS_ONLY', label: 'Letters Only', example: 'ABCDEF', description: 'Only alphabetic characters' },
  { value: 'LETTERS_NUMBERS', label: 'Letters + Numbers', example: 'ABC123', description: 'Alphanumeric characters' },
  { value: 'PREFIX_NUMBERS', label: 'Prefix + Numbers', example: 'EMP-001', description: 'Fixed prefix followed by numbers' },
  { value: 'PREFIX_LETTERS', label: 'Prefix + Letters', example: 'USR-ABC', description: 'Fixed prefix followed by letters' },
  { value: 'PREFIX_LETTERS_NUMBERS', label: 'Prefix + Letters + Numbers', example: 'EMP-AB12', description: 'Fixed prefix followed by alphanumeric' },
  { value: 'CUSTOM_PATTERN', label: 'Custom Pattern', example: 'Custom', description: 'Define your own regex pattern' },
];

const SEPARATOR_OPTIONS = [
  { value: '-', label: 'Hyphen (-)' },
  { value: '_', label: 'Underscore (_)' },
  { value: '/', label: 'Slash (/)' },
  { value: '', label: 'No Separator' },
];

const CASE_OPTIONS = [
  { value: 'UPPERCASE', label: 'UPPERCASE' },
  { value: 'LOWERCASE', label: 'lowercase' },
  { value: 'MIXED', label: 'Mixed Case' },
];

export function UserIdConfigPage() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN' || (user?.permissions?.includes('CONFIG_UPDATE') ?? false);

  const { data: config, mutate } = useSWR<UserIdConfig>('/api/config/user-id');
  const { data: nextIdData } = useSWR<{ autoGenerate: boolean; nextId: string | null }>(
    config?.autoGenerate ? '/api/config/user-id/next' : null
  );

  const [form, setForm] = useState<UserIdConfig>({
    format: 'LETTERS_NUMBERS',
    length: 6,
    prefix: '',
    prefixSeparator: '-',
    letterCase: 'UPPERCASE',
    autoGenerate: false,
    startNumber: 1,
    customPattern: '',
    customPatternExample: '',
    customPatternDescription: '',
  });

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testUserId, setTestUserId] = useState('');
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors?: string[] } | null>(null);

  useEffect(() => {
    if (config) {
      setForm(config);
    }
  }, [config]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const saveData = { ...form };
      if (!saveData.format.startsWith('PREFIX_')) { saveData.prefix = ''; }
      await apiClient.put('/api/config/user-id', saveData);
      mutate();
      setSaveMessage({ type: 'success', text: 'Configuration saved successfully!' });
      setTimeout(() => setSaveMessage(null), 4000);
    } catch (err: any) {
      console.error('Failed to save:', err);
      setSaveMessage({ type: 'error', text: err?.message || 'Failed to save configuration' });
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    if (!testUserId.trim()) return;
    try {
      const result = await apiClient.post('/api/config/user-id/validate', { userId: testUserId });
      setValidationResult(result as { valid: boolean; errors?: string[] });
    } catch {
      setValidationResult({ valid: false, errors: ['Validation failed'] });
    }
  };

  const generateExample = () => {
    const { format, length, prefix, prefixSeparator, letterCase } = form;
    const sep = prefix ? prefixSeparator : '';
    const prefixPart = prefix ? `${prefix}${sep}` : '';
    const remainingLength = Math.max(1, length - prefixPart.length);

    let example = '';
    switch (format) {
      case 'NUMBERS_ONLY':
        example = '1'.repeat(length);
        break;
      case 'LETTERS_ONLY':
        example = 'A'.repeat(length);
        break;
      case 'LETTERS_NUMBERS':
        example = 'A'.repeat(Math.ceil(remainingLength / 2)) + '1'.repeat(Math.floor(remainingLength / 2));
        example = example.slice(0, length);
        break;
      case 'PREFIX_NUMBERS':
        example = prefixPart + '0'.repeat(remainingLength);
        break;
      case 'PREFIX_LETTERS':
        example = prefixPart + 'A'.repeat(remainingLength);
        break;
      case 'PREFIX_LETTERS_NUMBERS':
        example = prefixPart + 'A'.repeat(Math.ceil(remainingLength / 2)) + '1'.repeat(Math.floor(remainingLength / 2));
        break;
      case 'CUSTOM_PATTERN':
        example = form.customPatternExample || 'Custom';
        break;
    }

    if (letterCase === 'LOWERCASE') {
      example = example.toLowerCase();
    } else if (letterCase === 'UPPERCASE') {
      example = example.toUpperCase();
    }

    return example.slice(0, length);
  };

  const showPrefixOptions = form.format.startsWith('PREFIX_');
  const showCustomPattern = form.format === 'CUSTOM_PATTERN';

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25">
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">
            User ID Configuration
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Configure the format and rules for User IDs</p>
        </div>
      </div>

      {!isSuperAdmin && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-amber-700 text-sm font-medium">Only Super Admin can modify User ID configuration</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Configuration */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-6 flex items-center gap-2">
              <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
              Format Settings
            </h2>

            <div className="space-y-5">
              {/* Format Type */}
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-2 block">Format Type</label>
                <Select
                  value={form.format}
                  onChange={(e) => { const fmt = e.target.value; setForm({ ...form, format: fmt, ...(fmt.startsWith('PREFIX_') ? {} : { prefix: '', prefixSeparator: '-' }) }); }}
                  disabled={!isSuperAdmin}
                  className="w-full"
                >
                  {FORMAT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.example}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  {FORMAT_OPTIONS.find((o) => o.value === form.format)?.description}
                </p>
              </div>

              {/* Length */}
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-2 block">
                  Fixed Length
                </label>
                <Input
                  type="number"
                  min={3}
                  max={20}
                  value={form.length}
                  onChange={(e) => setForm({ ...form, length: parseInt(e.target.value) || 6 })}
                  disabled={!isSuperAdmin}
                  className="w-32"
                />
                <p className="text-xs text-slate-500 mt-1">
                  User ID must be exactly {form.length} characters (including prefix if any)
                </p>
              </div>

              {/* Prefix Options */}
              {showPrefixOptions && (
                <div className="grid grid-cols-2 gap-4 p-4 bg-slate-50 rounded-xl">
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Prefix</label>
                    <Input
                      type="text"
                      maxLength={10}
                      value={form.prefix}
                      onChange={(e) => setForm({ ...form, prefix: e.target.value.toUpperCase() })}
                      disabled={!isSuperAdmin}
                      placeholder="e.g., EMP, USR"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Separator</label>
                    <Select
                      value={form.prefixSeparator}
                      onChange={(e) => setForm({ ...form, prefixSeparator: e.target.value })}
                      disabled={!isSuperAdmin}
                    >
                      {SEPARATOR_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}

              {/* Custom Pattern */}
              {showCustomPattern && (
                <div className="p-4 bg-slate-50 rounded-xl space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">
                      Regex Pattern
                    </label>
                    <Input
                      type="text"
                      value={form.customPattern}
                      onChange={(e) => setForm({ ...form, customPattern: e.target.value })}
                      disabled={!isSuperAdmin}
                      placeholder="e.g., [A-Z]{2}\\d{4}"
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">
                      Example (for display)
                    </label>
                    <Input
                      type="text"
                      value={form.customPatternExample}
                      onChange={(e) => setForm({ ...form, customPatternExample: e.target.value })}
                      disabled={!isSuperAdmin}
                      placeholder="e.g., AB1234"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">
                      Description (for error messages)
                    </label>
                    <Input
                      type="text"
                      value={form.customPatternDescription}
                      onChange={(e) => setForm({ ...form, customPatternDescription: e.target.value })}
                      disabled={!isSuperAdmin}
                      placeholder="e.g., 2 letters followed by 4 digits"
                    />
                  </div>
                </div>
              )}

              {/* Letter Case */}
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-2 block">Letter Case</label>
                <Select
                  value={form.letterCase}
                  onChange={(e) => setForm({ ...form, letterCase: e.target.value })}
                  disabled={!isSuperAdmin}
                  className="w-48"
                >
                  {CASE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </Card>

          {/* Auto-Generation Settings */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-6 flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Auto-Generation
            </h2>

            <div className="space-y-5">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoGenerate}
                  onChange={(e) => setForm({ ...form, autoGenerate: e.target.checked })}
                  disabled={!isSuperAdmin}
                  className="w-5 h-5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                />
                <span className="text-sm font-medium text-slate-700">
                  Enable auto-generation of User IDs
                </span>
              </label>

              {form.autoGenerate && (
                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">
                    Start Number
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={form.startNumber}
                    onChange={(e) => setForm({ ...form, startNumber: parseInt(e.target.value) || 1 })}
                    disabled={!isSuperAdmin}
                    className="w-32"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Numbering will start from this value
                  </p>
                </div>
              )}

              {nextIdData?.autoGenerate && nextIdData.nextId && (
                <div className="p-4 bg-emerald-50 rounded-xl">
                  <span className="text-sm text-emerald-700">
                    Next auto-generated ID: <strong className="font-mono">{nextIdData.nextId}</strong>
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Save Message */}
          {saveMessage && (
            <div className={"flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium " + (saveMessage.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200')}>
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {saveMessage.type === 'success'
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                }
              </svg>
              {saveMessage.text}
            </div>
          )}

          {/* Save Button */}
          {isSuperAdmin && (
            <div className="flex justify-end gap-3 pt-4 mt-6 border-t border-slate-100">
              <Button variant="outline" onClick={() => window.history.back()}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Configuration'}
              </Button>
            </div>
          )}
        </div>

        {/* Preview & Test Panel */}
        <div className="space-y-6">
          {/* Preview */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Preview
            </h2>

            <div className="text-center py-6">
              <div className="text-3xl font-mono font-bold text-slate-800 bg-slate-100 rounded-xl py-4 px-6 inline-block">
                {generateExample()}
              </div>
              <p className="text-xs text-slate-500 mt-3">Example User ID based on current settings</p>
            </div>

            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Format:</span>
                <span className="font-medium text-slate-700">{FORMAT_OPTIONS.find((o) => o.value === form.format)?.label}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Length:</span>
                <span className="font-medium text-slate-700">{form.length} characters</span>
              </div>
              {showPrefixOptions && form.prefix && (
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">Prefix:</span>
                  <span className="font-medium text-slate-700">{form.prefix}{form.prefixSeparator}</span>
                </div>
              )}
              <div className="flex justify-between py-2">
                <span className="text-slate-500">Case:</span>
                <span className="font-medium text-slate-700">{form.letterCase}</span>
              </div>
            </div>
          </Card>

          {/* Test Validation */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Test Validation
            </h2>

            <div className="space-y-4">
              <Input
                type="text"
                value={testUserId}
                onChange={(e) => {
                  setTestUserId(e.target.value);
                  setValidationResult(null);
                }}
                placeholder="Enter User ID to test"
                className="font-mono"
              />
              <Button
                onClick={handleValidate}
                variant="outline"
                className="w-full gap-2"
                disabled={!testUserId.trim()}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Validate
              </Button>

              {validationResult && (
                <div className={`p-4 rounded-xl ${validationResult.valid ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  {validationResult.valid ? (
                    <div className="flex items-center gap-2 text-emerald-700">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="font-medium">Valid User ID</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-red-700">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="font-medium">Invalid User ID</span>
                      </div>
                      {validationResult.errors && (
                        <ul className="text-sm text-red-600 list-disc list-inside">
                          {validationResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
