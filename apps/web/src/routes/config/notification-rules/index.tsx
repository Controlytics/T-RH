import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { useDatetimeFormat } from '../../../hooks/use-datetime-format';

// ─── Types ────────────────────────────────────────────────────────────
interface EventTypeMeta { value: string; label: string; module: string; variables: string[] }
interface Recipient { id?: string; recipientType: 'ROLE' | 'GROUP' | 'USER'; roleValue?: string; groupId?: string; userId?: string; displayName?: string }
interface NotificationRule {
  id: string; name: string; description?: string; eventType: string; eventTypes?: string[];
  conditions: Record<string, unknown>; emailEnabled: boolean; smsEnabled: boolean; inAppEnabled: boolean;
  emailTemplateId?: string; smsTemplateId?: string; cooldownMinutes: number;
  isActive: boolean; priority: number; createdAt: string;
  recipients: Recipient[]; eventTypeMeta?: EventTypeMeta; eventTypesMeta?: EventTypeMeta[];
}
interface UserGroup { id: string; name: string; description?: string; isActive: boolean; memberCount: number; createdAt: string }
interface GroupMember { id: string; userId: string; user?: { id: string; username: string; fullName: string; email: string; role: string } }
interface UserOption { id: string; username: string; fullName: string; email: string; role: string }
interface Template { id: string; name: string; channel: string; subject?: string; bodyTemplate: string; isActive: boolean }

interface LogEntry {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  message: string;
  status: string;
  retryCount: number;
  errorMessage: string | null;
  triggeredBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

// ─── Multi-Select Event Types ─────────────────────────────────────────
function MultiSelectEventTypes({ eventTypes, selected, onChange }: {
  eventTypes: EventTypeMeta[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  // Group by module
  const grouped = eventTypes.reduce<Record<string, EventTypeMeta[]>>((acc, et) => {
    (acc[et.module] = acc[et.module] || []).push(et);
    return acc;
  }, {});

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-left bg-white flex items-center justify-between"
      >
        <span className={selected.length ? 'text-slate-800' : 'text-slate-400'}>
          {selected.length ? `${selected.length} event type${selected.length > 1 ? 's' : ''} selected` : 'Select event types...'}
        </span>
        <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selected.map(val => {
            const et = eventTypes.find(e => e.value === val);
            return (
              <span key={val} className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs font-medium">
                {et?.label ?? val}
                <button type="button" onClick={() => toggle(val)} className="hover:text-amber-900">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {Object.entries(grouped).map(([module, types]) => (
              <div key={module}>
                <div className="px-3 py-1.5 bg-slate-50 text-xs font-semibold text-slate-500 uppercase sticky top-0">{module}</div>
                {types.map(et => (
                  <label key={et.value} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.includes(et.value)}
                      onChange={() => toggle(et.value)}
                      className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                    />
                    <span className="text-sm text-slate-700">{et.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Constants for Logs ───────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  SENT: 'bg-green-100 text-green-700',
  DELIVERED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  RETRYING: 'bg-orange-100 text-orange-700',
  FAILED: 'bg-red-100 text-red-700',
};

const CHANNEL_COLORS: Record<string, string> = {
  EMAIL: 'bg-blue-100 text-blue-700',
  SMS: 'bg-purple-100 text-purple-700',
};

// ─── Main Page ────────────────────────────────────────────────────────
export function NotificationRulesPage() {
  const [tab, setTab] = useState<'rules' | 'groups' | 'templates' | 'logs'>('rules');

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/config" className="p-2 rounded-xl hover:bg-slate-100 transition-colors">
          <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="p-3 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/25">
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Notification Rules</h1>
          <p className="text-sm text-slate-500">Configure event-based alerts, recipients, templates, and delivery logs</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
        {[
          { key: 'rules' as const, label: 'Rules', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
          { key: 'groups' as const, label: 'User Groups', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
          { key: 'templates' as const, label: 'Templates', icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z' },
          { key: 'logs' as const, label: 'Delivery Logs', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-medium transition-all ${
              tab === t.key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={t.icon} />
            </svg>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rules' && <RulesTab />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'logs' && <LogsTab />}
    </div>
  );
}

// ─── Rules Tab ────────────────────────────────────────────────────────
function RulesTab() {
  const { data: rules, mutate } = useSWR<NotificationRule[]>('/api/notification-rules', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: eventTypes } = useSWR<EventTypeMeta[]>('/api/notification-rules/event-types', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: groups } = useSWR<UserGroup[]>('/api/user-groups', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: templates } = useSWR<Template[]>('/api/notification-settings/templates', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: usersData } = useSWR<{ data: UserOption[] }>('/api/users?limit=500&status=ENABLED');
  const users = (usersData?.data ?? []).filter((u: UserOption) => u.username !== 'superadmin');
  const { data: rolesData } = useSWR<Array<{ name: string; displayName: string }>>('/api/roles', { revalidateOnMount: true, dedupingInterval: 0 });
  const roles = (rolesData ?? []).filter(r => r.name !== 'SUPER_ADMIN');

  const [editing, setEditing] = useState<Partial<NotificationRule> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const saveRule = async () => {
    if (!editing?.name || !(editing?.eventTypes?.length)) return;
    setSaving(true);
    setError('');
    try {
      if (editing.id) {
        await apiClient.put(`/api/notification-rules/${editing.id}`, editing);
      } else {
        await apiClient.post('/api/notification-rules', editing);
      }
      mutate();
      setEditing(null);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    }
    setSaving(false);
  };

  const deleteRule = async (id: string) => {
    if (!confirm('Delete this notification rule?')) return;
    await apiClient.delete(`/api/notification-rules/${id}`);
    mutate();
  };

  const toggleRule = async (id: string) => {
    await apiClient.put(`/api/notification-rules/${id}/toggle`, {});
    mutate();
  };

  const testRule = async (id: string) => {
    try {
      const result = await apiClient.post<{ success: boolean; message?: string; error?: string }>(`/api/notification-rules/${id}/test`, {});
      alert(result.success ? result.message : result.error);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const addRecipient = (type: 'ROLE' | 'GROUP' | 'USER') => {
    if (!editing) return;
    const recipients = [...(editing.recipients ?? []), { recipientType: type, roleValue: '', groupId: '', userId: '' }];
    setEditing({ ...editing, recipients });
  };

  const removeRecipient = (idx: number) => {
    if (!editing) return;
    const recipients = (editing.recipients ?? []).filter((_, i) => i !== idx);
    setEditing({ ...editing, recipients });
  };

  const updateRecipient = (idx: number, field: string, value: string) => {
    if (!editing) return;
    const recipients = [...(editing.recipients ?? [])];
    recipients[idx] = { ...recipients[idx], [field]: value };
    setEditing({ ...editing, recipients });
  };

  // Rule editor dialog
  if (editing) {
    return (
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-6 shadow-sm space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">{editing.id ? 'Edit Rule' : 'New Notification Rule'}</h3>
          <button onClick={() => setEditing(null)} className="p-2 rounded-lg hover:bg-slate-100">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">{error}</div>}

        {/* Basic Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Rule Name *</label>
            <Input value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Cycle Completion Alert" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Event Types *</label>
            <MultiSelectEventTypes
              eventTypes={eventTypes ?? []}
              selected={editing.eventTypes ?? (editing.eventType ? [editing.eventType] : [])}
              onChange={(vals) => setEditing({ ...editing, eventTypes: vals, eventType: vals[0] ?? '' })}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
          <Input value={editing.description ?? ''} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="Optional description" />
        </div>

        {/* Channels */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Notification Channels</label>
          <div className="flex gap-4">
            {[
              { key: 'emailEnabled', label: 'Email', color: 'blue' },
              { key: 'smsEnabled', label: 'SMS', color: 'green' },
              { key: 'inAppEnabled', label: 'In-App', color: 'purple' },
            ].map(ch => (
              <label key={ch.key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(editing as any)[ch.key] ?? (ch.key === 'inAppEnabled')}
                  onChange={e => setEditing({ ...editing, [ch.key]: e.target.checked })}
                  className={`rounded border-gray-300 text-${ch.color}-600 focus:ring-${ch.color}-500`}
                />
                <span className="text-sm text-slate-700">{ch.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Templates */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {editing.emailEnabled && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email Template</label>
              <select
                value={editing.emailTemplateId ?? ''}
                onChange={e => setEditing({ ...editing, emailTemplateId: e.target.value || undefined })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                <option value="">Use default template</option>
                {templates?.filter(t => t.channel === 'EMAIL' && t.isActive).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
          {editing.smsEnabled && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">SMS Template</label>
              <select
                value={editing.smsTemplateId ?? ''}
                onChange={e => setEditing({ ...editing, smsTemplateId: e.target.value || undefined })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              >
                <option value="">Use default template</option>
                {templates?.filter(t => t.channel === 'SMS' && t.isActive).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Recipients */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Recipients</label>
          <div className="space-y-2">
            {(editing.recipients ?? []).map((r, idx) => (
              <div key={idx} className="flex items-center gap-2 bg-slate-50 p-3 rounded-lg">
                <select
                  value={r.recipientType}
                  onChange={e => updateRecipient(idx, 'recipientType', e.target.value)}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm w-28"
                >
                  <option value="ROLE">Role</option>
                  <option value="GROUP">Group</option>
                  <option value="USER">User</option>
                </select>

                {r.recipientType === 'ROLE' && (
                  <select
                    value={r.roleValue ?? ''}
                    onChange={e => updateRecipient(idx, 'roleValue', e.target.value)}
                    className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                  >
                    <option value="">Select role...</option>
                    {roles.map(role => <option key={role.name} value={role.name}>{role.displayName}</option>)}
                  </select>
                )}

                {r.recipientType === 'GROUP' && (
                  <select
                    value={r.groupId ?? ''}
                    onChange={e => updateRecipient(idx, 'groupId', e.target.value)}
                    className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                  >
                    <option value="">Select group...</option>
                    {groups?.map(g => <option key={g.id} value={g.id}>{g.name} ({g.memberCount} members)</option>)}
                  </select>
                )}

                {r.recipientType === 'USER' && (
                  <select
                    value={r.userId ?? ''}
                    onChange={e => updateRecipient(idx, 'userId', e.target.value)}
                    className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                  >
                    <option value="">Select user...</option>
                    {users.map((u: UserOption) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}
                  </select>
                )}

                <button onClick={() => removeRecipient(idx)} className="p-1.5 rounded-lg hover:bg-red-100 text-red-500">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <button onClick={() => addRecipient('ROLE')} className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100">+ Add Role</button>
            <button onClick={() => addRecipient('GROUP')} className="px-3 py-1.5 text-xs font-medium bg-green-50 text-green-700 rounded-lg hover:bg-green-100">+ Add Group</button>
            <button onClick={() => addRecipient('USER')} className="px-3 py-1.5 text-xs font-medium bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100">+ Add User</button>
          </div>
        </div>

        {/* Cooldown & Priority */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Cooldown (minutes)</label>
            <Input type="number" min={0} value={editing.cooldownMinutes ?? 0} onChange={e => setEditing({ ...editing, cooldownMinutes: Number(e.target.value) })} />
            <p className="text-xs text-slate-400 mt-1">0 = no cooldown, send every time</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
            <Input type="number" value={editing.priority ?? 0} onChange={e => setEditing({ ...editing, priority: Number(e.target.value) })} />
            <p className="text-xs text-slate-400 mt-1">Higher = evaluated first</p>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={saveRule} disabled={saving || !editing.name || !(editing.eventTypes?.length)}>
            {saving ? 'Saving...' : editing.id ? 'Update Rule' : 'Create Rule'}
          </Button>
        </div>
      </div>
    );
  }

  // Rules list
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">{rules?.length ?? 0} notification rules configured</p>
        <Button onClick={() => setEditing({ name: '', eventType: '', eventTypes: [], emailEnabled: true, inAppEnabled: true, smsEnabled: false, cooldownMinutes: 0, priority: 0, isActive: true, recipients: [], conditions: {} })}>
          + New Rule
        </Button>
      </div>

      {!rules?.length ? (
        <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-12 text-center">
          <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
          <p className="text-slate-500 font-medium">No notification rules yet</p>
          <p className="text-sm text-slate-400 mt-1">Create rules to send alerts when events occur</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className={`bg-white rounded-xl border-2 p-4 transition-all ${rule.isActive ? 'border-slate-200' : 'border-slate-100 opacity-60'}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-slate-800">{rule.name}</h4>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${rule.isActive ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5">
                    {(rule.eventTypesMeta?.length ? rule.eventTypesMeta : [rule.eventTypeMeta].filter(Boolean)).map((meta, i) => (
                      <span key={i} className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs font-medium">
                        {meta?.label ?? rule.eventType}
                      </span>
                    ))}
                    <div className="flex gap-1">
                      {rule.emailEnabled && <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-xs">Email</span>}
                      {rule.smsEnabled && <span className="px-1.5 py-0.5 bg-green-50 text-green-600 rounded text-xs">SMS</span>}
                      {rule.inAppEnabled && <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded text-xs">In-App</span>}
                    </div>
                  </div>
                  {rule.recipients.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {rule.recipients.map((r, i) => (
                        <span key={i} className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          r.recipientType === 'ROLE' ? 'bg-blue-100 text-blue-700' :
                          r.recipientType === 'GROUP' ? 'bg-green-100 text-green-700' :
                          'bg-purple-100 text-purple-700'
                        }`}>
                          {r.recipientType === 'ROLE' ? 'Role: ' : r.recipientType === 'GROUP' ? 'Group: ' : 'User: '}
                          {r.displayName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => testRule(rule.id)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600" title="Test">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </button>
                  <button onClick={() => toggleRule(rule.id)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-amber-600" title="Toggle">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={rule.isActive ? "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" : "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"} /></svg>
                  </button>
                  <button onClick={() => setEditing(rule)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Edit">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                  </button>
                  <button onClick={() => deleteRule(rule.id)} className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600" title="Delete">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Groups Tab ───────────────────────────────────────────────────────
function GroupsTab() {
  const { data: groups, mutate } = useSWR<UserGroup[]>('/api/user-groups', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: usersData } = useSWR<{ data: UserOption[] }>('/api/users?limit=500&status=ENABLED');
  const users = (usersData?.data ?? []).filter((u: UserOption) => u.username !== 'superadmin');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [managingId, setManagingId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [addUserId, setAddUserId] = useState('');

  const createGroup = async () => {
    if (!newName) return;
    await apiClient.post('/api/user-groups', { name: newName, description: newDesc });
    mutate();
    setCreating(false);
    setNewName('');
    setNewDesc('');
  };

  const deleteGroup = async (id: string) => {
    if (!confirm('Delete this group?')) return;
    await apiClient.delete(`/api/user-groups/${id}`);
    mutate();
  };

  const loadMembers = async (groupId: string) => {
    setManagingId(groupId);
    const data = await apiClient.get<GroupMember[]>(`/api/user-groups/${groupId}/members`);
    setMembers(data);
  };

  const addMember = async () => {
    if (!managingId || !addUserId) return;
    await apiClient.post(`/api/user-groups/${managingId}/members`, { userIds: [addUserId] });
    setAddUserId('');
    loadMembers(managingId);
    mutate();
  };

  const removeMember = async (userId: string) => {
    if (!managingId) return;
    await apiClient.delete(`/api/user-groups/${managingId}/members/${userId}`);
    loadMembers(managingId);
    mutate();
  };

  if (managingId) {
    const group = groups?.find(g => g.id === managingId);
    return (
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">Members of &quot;{group?.name}&quot;</h3>
          <button onClick={() => setManagingId(null)} className="p-2 rounded-lg hover:bg-slate-100">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex gap-2">
          <select value={addUserId} onChange={e => setAddUserId(e.target.value)} className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm">
            <option value="">Select user to add...</option>
            {users.filter((u: UserOption) => !members.some(m => m.userId === u.id)).map((u: UserOption) => (
              <option key={u.id} value={u.id}>{u.fullName} ({u.username}) - {u.role}</option>
            ))}
          </select>
          <Button onClick={addMember} disabled={!addUserId}>Add</Button>
        </div>

        {members.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">No members in this group yet</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {members.map(m => (
              <div key={m.id} className="flex items-center justify-between py-3">
                <div>
                  <span className="font-medium text-slate-800">{m.user?.fullName ?? m.userId}</span>
                  <span className="text-sm text-slate-400 ml-2">{m.user?.username} - {m.user?.email}</span>
                  <span className="ml-2 px-2 py-0.5 bg-slate-100 rounded text-xs text-slate-500">{m.user?.role}</span>
                </div>
                <button onClick={() => removeMember(m.userId)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 hover:text-red-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">{groups?.length ?? 0} user groups</p>
        <Button onClick={() => setCreating(true)}>+ New Group</Button>
      </div>

      {creating && (
        <div className="bg-white rounded-xl border-2 border-blue-200 p-4 space-y-3">
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Group name" />
          <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)" />
          <div className="flex gap-2">
            <Button onClick={createGroup} disabled={!newName}>Create</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {!groups?.length && !creating ? (
        <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-12 text-center">
          <p className="text-slate-500 font-medium">No user groups yet</p>
          <p className="text-sm text-slate-400 mt-1">Create groups to organize notification recipients</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {groups?.map(group => (
            <div key={group.id} className="bg-white rounded-xl border-2 border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-slate-800">{group.name}</h4>
                  {group.description && <p className="text-sm text-slate-400 mt-0.5">{group.description}</p>}
                  <p className="text-sm text-slate-500 mt-1">{group.memberCount} member{group.memberCount !== 1 ? 's' : ''}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => loadMembers(group.id)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Manage Members">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                  </button>
                  <button onClick={() => deleteGroup(group.id)} className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600" title="Delete">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Templates Tab ────────────────────────────────────────────────────
function TemplatesTab() {
  const { data: templates, mutate } = useSWR<Template[]>('/api/notification-settings/templates', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: eventTypes } = useSWR<EventTypeMeta[]>('/api/notification-rules/event-types', { revalidateOnMount: true, dedupingInterval: 0 });
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [saving, setSaving] = useState(false);

  const saveTemplate = async () => {
    if (!editing?.name || !editing?.bodyTemplate) return;
    setSaving(true);
    try {
      if (editing.id) {
        await apiClient.put(`/api/notification-settings/templates/${editing.id}`, editing);
      } else {
        await apiClient.post('/api/notification-settings/templates', editing);
      }
      mutate();
      setEditing(null);
    } catch (err: any) {
      alert(err.message);
    }
    setSaving(false);
  };

  const deleteTemplate = async (id: string) => {
    if (!confirm('Delete this template?')) return;
    await apiClient.delete(`/api/notification-settings/templates/${id}`);
    mutate();
  };

  if (editing) {
    const selectedEvent = eventTypes?.find(e => e.value === (editing as any).eventType);
    return (
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">{editing.id ? 'Edit Template' : 'New Template'}</h3>
          <button onClick={() => setEditing(null)} className="p-2 rounded-lg hover:bg-slate-100">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Template Name *</label>
            <Input value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Cycle Completion Email" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Channel *</label>
            <select value={editing.channel ?? 'EMAIL'} onChange={e => setEditing({ ...editing, channel: e.target.value })} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
        </div>

        {editing.channel === 'EMAIL' && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
            <Input value={editing.subject ?? ''} onChange={e => setEditing({ ...editing, subject: e.target.value })} placeholder="[DigiLog] Cycle ${eventType} on ${entityName}" />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Body Template *</label>
          <textarea
            value={editing.bodyTemplate ?? ''}
            onChange={e => setEditing({ ...editing, bodyTemplate: e.target.value })}
            rows={8}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
            placeholder={editing.channel === 'EMAIL' ? '<h2>${eventType}</h2>\n<p>Filter: ${entityName}</p>' : 'DigiLog Alert: ${eventType} on ${entityName}'}
          />
        </div>

        {selectedEvent && (
          <div className="bg-blue-50 rounded-lg p-3">
            <p className="text-xs font-medium text-blue-700 mb-1">Available variables:</p>
            <div className="flex flex-wrap gap-1">
              {selectedEvent.variables.map(v => (
                <code key={v} className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">${'{'}${v}{'}'}</code>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={saveTemplate} disabled={saving || !editing.name || !editing.bodyTemplate}>
            {saving ? 'Saving...' : editing.id ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-500">{templates?.length ?? 0} templates</p>
        <Button onClick={() => setEditing({ name: '', channel: 'EMAIL', subject: '', bodyTemplate: '', isActive: true })}>+ New Template</Button>
      </div>

      {!templates?.length ? (
        <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-12 text-center">
          <p className="text-slate-500 font-medium">No templates yet</p>
          <p className="text-sm text-slate-400 mt-1">Create email and SMS templates for your notification rules</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-xl border-2 border-slate-200 p-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-slate-800">{t.name}</h4>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${t.channel === 'EMAIL' ? 'bg-blue-50 text-blue-700' : 'bg-green-50 text-green-700'}`}>{t.channel}</span>
                </div>
                {t.subject && <p className="text-sm text-slate-400 mt-0.5">Subject: {t.subject}</p>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => setEditing(t)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                </button>
                <button onClick={() => deleteTemplate(t.id)} className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Logs Tab ─────────────────────────────────────────────────────────
function LogsTab() {
  const { formatDateTime } = useDatetimeFormat();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const queryParams = new URLSearchParams({ page: String(page), limit: String(pageSize) });
  if (channel) queryParams.set('channel', channel);
  if (status) queryParams.set('status', status);
  if (search) queryParams.set('search', search);

  const { data, mutate } = useSWR(`/api/notification-settings/logs?${queryParams}`, { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: stats } = useSWR('/api/notification-settings/logs/stats', { revalidateOnMount: true, dedupingInterval: 0 });

  const logs: LogEntry[] = data?.data ?? [];
  const total = data?.total ?? 0;

  const handleDelete = async (id: string) => {
    try {
      await apiClient.delete(`/api/notification-settings/logs/${id}`);
      mutate();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
            <div className="text-2xl font-bold text-slate-800">{stats.total}</div>
            <div className="text-xs text-slate-500">Total</div>
          </div>
          <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.email?.sent ?? 0}</div>
            <div className="text-xs text-slate-500">Emails Sent</div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{stats.email?.failed ?? 0}</div>
            <div className="text-xs text-slate-500">Emails Failed</div>
          </div>
          <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.sms?.sent ?? 0}</div>
            <div className="text-xs text-slate-500">SMS Sent</div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{stats.sms?.failed ?? 0}</div>
            <div className="text-xs text-slate-500">SMS Failed</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-2xl border-2 border-slate-200 p-4 shadow-sm">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-600 mb-1">Search</label>
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by recipient or subject..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Channel</label>
            <select
              value={channel}
              onChange={(e) => { setChannel(e.target.value); setPage(1); }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">All</option>
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">All</option>
              <option value="SENT">Sent</option>
              <option value="FAILED">Failed</option>
              <option value="PENDING">Pending</option>
              <option value="RETRYING">Retrying</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border-2 border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Channel</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Recipient</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Subject</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Triggered By</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Time</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-slate-400">No notification logs found</td></tr>
              )}
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${CHANNEL_COLORS[log.channel] ?? 'bg-slate-100 text-slate-600'}`}>{log.channel}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-700 max-w-[200px] truncate">{log.recipient}</td>
                  <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate">{log.subject ?? '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[log.status] ?? 'bg-slate-100'}`}>{log.status}</span>
                    {log.retryCount > 0 && <span className="ml-1 text-xs text-slate-400">(retry {log.retryCount})</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{log.triggeredBy ?? '-'}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{formatDateTime(log.createdAt)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(log.id); }}
                      className="text-red-500 hover:text-red-700 text-xs"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {logs.map((log) => expandedId === log.id && (
                <tr key={`${log.id}-detail`} className="bg-slate-50">
                  <td colSpan={7} className="px-6 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <strong className="text-slate-600">Message:</strong>
                        <div className="mt-1 p-3 bg-white rounded-lg border text-slate-700 max-h-40 overflow-y-auto text-xs" style={{ whiteSpace: 'pre-wrap' }}>{log.message || ''}</div>
                      </div>
                      {log.errorMessage && (
                        <div>
                          <strong className="text-red-600">Error:</strong>
                          <div className="mt-1 p-3 bg-red-50 rounded-lg border border-red-200 text-red-700 text-xs">{log.errorMessage}</div>
                        </div>
                      )}
                      {log.sentAt && (
                        <div><strong className="text-slate-600">Sent At:</strong> <span className="text-slate-700">{formatDateTime(log.sentAt)}</span></div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <Pagination className="border-t border-slate-200" page={page} pageSize={pageSize} totalItems={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        )}
      </div>
    </div>
  );
}
