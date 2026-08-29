import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDatetimeFormat } from '../../../hooks/use-datetime-format';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs } from '@/components/ui/tabs';

// ─── Email Types & Constants ──────────────────────────────────────────
interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  enabled: boolean;
  smtpProvider: string;
  authType: string;
  oauth2Provider: string;
  clientId: string;
  clientSecret: string;
  providerTenantId: string;
  refreshToken: string;
  tokenUrl: string;
  scope: string;
  connectionTimeout: number;
  socketTimeout: number;
}

interface OAuth2Status {
  configured: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
}

const SMTP_PRESETS: Record<string, Partial<EmailConfig>> = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, smtpProvider: 'gmail' },
  office365: { host: 'smtp.office365.com', port: 587, secure: false, smtpProvider: 'office365' },
  'aws-ses': { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, smtpProvider: 'aws-ses' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, secure: false, smtpProvider: 'sendgrid' },
  custom: { smtpProvider: 'custom' },
};

// ─── SMS Types & Constants ────────────────────────────────────────────
// P3 (2026-05-02): AWS SNS dropped — see CHANGELOG. Operators wanting AWS or
// any other provider use the HTTP Gateway with that provider's REST endpoint.
interface SmsConfig {
  provider: string;
  enabled: boolean;
  defaultCountryCode: string;
  senderId: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
  vonageApiKey: string;
  vonageApiSecret: string;
  vonageFromNumber: string;
  httpGatewayUrl: string;
  httpGatewayMethod: string;
  httpGatewayHeaders: Record<string, string>;
  httpGatewayBodyTemplate: string;
  httpGatewaySuccessRegex: string;
}

const SMS_PROVIDERS = [
  { value: 'http-gateway', label: 'HTTP Gateway', description: 'Generic POST adapter — covers MSG91, Plivo, AfricasTalking, Kaleyra, custom backends' },
  { value: 'twilio', label: 'Twilio', description: 'Popular cloud communication platform' },
  { value: 'vonage', label: 'Vonage (Nexmo)', description: 'Communication APIs' },
];

// ─── Main Page ────────────────────────────────────────────────────────
export function EmailSettingsPage() {
  return <ChannelSettingsPage />;
}

export function SmsSettingsPage() {
  return <ChannelSettingsPage defaultTab="sms" />;
}

function ChannelSettingsPage({ defaultTab = 'email' }: { defaultTab?: 'email' | 'sms' }) {
  const [tab, setTab] = useState<'email' | 'sms'>(defaultTab);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <PageHeader
        title='Notification Channels'
        description='Configure email SMTP and SMS provider settings'
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Notification Channels' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        }
      />

      {/* <Tabs> since 2026-08-29 (audit M4). This was `role="group"` +
          aria-pressed, which announced correctly but offered no arrow-key
          movement; the primitive supplies it. */}
      <Tabs
        tabs={[
          {
            id: 'email' as const,
            label: 'Email (SMTP)',
            icon: (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            ),
          },
          {
            id: 'sms' as const,
            label: 'SMS',
            icon: (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            ),
          },
        ]}
        active={tab}
        onChange={setTab}
        idPrefix="notification-channel"
        variant="segmented"
        aria-label="Channel"
      />

      {tab === 'email' && <EmailTab />}
      {tab === 'sms' && <SmsTab />}
    </div>
  );
}

// ─── Email Tab ────────────────────────────────────────────────────────
function EmailTab() {
  const { formatDateTime } = useDatetimeFormat();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, mutate } = useSWR('/api/notification-settings/email', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: redirectData } = useSWR('/api/notification-settings/email/oauth2/redirect-uri', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: oauth2Status, mutate: mutateOAuth2Status } = useSWR<OAuth2Status>('/api/notification-settings/email/oauth2/status', { revalidateOnMount: true, dedupingInterval: 0 });

  const defaults: EmailConfig = {
    host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: 'DigiLog',
    enabled: false, smtpProvider: 'custom', authType: 'basic',
    oauth2Provider: 'microsoft', clientId: '', clientSecret: '', providerTenantId: '', refreshToken: '',
    tokenUrl: '', scope: '', connectionTimeout: 10000, socketTimeout: 15000,
  };

  const { register, handleSubmit, watch, reset, setValue, formState: { isSubmitting, isDirty } } = useForm<EmailConfig>({
    values: data ? { ...defaults, ...data } : defaults,
  });

  const enabled = watch('enabled');
  const smtpProvider = watch('smtpProvider');
  const authType = watch('authType');
  const oauth2Provider = watch('oauth2Provider');

  const handleOAuth2Message = useCallback((event: MessageEvent) => {
    if (event.data?.type === 'oauth2-success') {
      mutateOAuth2Status();
      mutate();
      setSuccess('OAuth2 authorization successful! Tokens have been saved.');
    }
  }, [mutateOAuth2Status, mutate]);

  useEffect(() => {
    window.addEventListener('message', handleOAuth2Message);
    return () => window.removeEventListener('message', handleOAuth2Message);
  }, [handleOAuth2Message]);

  const applyPreset = (key: string) => {
    const p = SMTP_PRESETS[key];
    if (p.host) setValue('host', p.host, { shouldDirty: true });
    if (p.port) setValue('port', p.port, { shouldDirty: true });
    if (p.secure !== undefined) setValue('secure', p.secure, { shouldDirty: true });
    setValue('smtpProvider', key, { shouldDirty: true });
    if (key === 'office365') {
      setValue('oauth2Provider', 'microsoft', { shouldDirty: true });
    } else if (key === 'gmail') {
      setValue('oauth2Provider', 'google', { shouldDirty: true });
    }
  };

  // Audit 2026-05-04 fix #5 (web-routes review H5): outbound-comms credential
  // edits go through reauth. UPDATE_EMAIL_CONFIG action declared this branch
  // (commit 7e5839a) + backend already enforces — FE wrap completes the gate.
  const reauth = useReauth();
  const onSubmit = (formData: EmailConfig) => {
    setError('');
    setSuccess('');
    reauth.execute(
      'UPDATE_EMAIL_CONFIG',
      async (password?: string) => {
        if (password) await apiClient.putWithReauth('/api/notification-settings/email', formData, password);
        else await apiClient.put('/api/notification-settings/email', formData);
      },
      {
        onSuccess: () => {
          setSuccess('Email settings saved successfully');
          mutate();
          reset(formData);
        },
        onError: (err: any) => setError(err.message || 'Failed to save'),
      },
    );
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiClient.post<{ success: boolean; message?: string; error?: string }>(
        '/api/notification-settings/email/test',
        testEmail ? { recipient: testEmail } : {},
      );
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message || 'Test failed' });
    }
    setTesting(false);
  };

  const copyRedirectUri = () => {
    if (redirectData?.redirectUri) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(redirectData.redirectUri);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = redirectData.redirectUri;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
    }
  };

  const startOAuth2Flow = async () => {
    try {
      const result = await apiClient.get<{ authUrl: string }>('/api/notification-settings/email/oauth2/authorize');
      if (result.authUrl) {
        window.open(result.authUrl, 'oauth2-auth', 'width=600,height=700,scrollbars=yes');
      } else {
        setError('Could not generate authorization URL. Make sure Client ID is configured and saved.');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start OAuth2 flow');
    }
  };

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">{success}</div>}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Enable toggle */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)]">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800">Email Notifications</h3>
              <p className="text-sm text-slate-500 mt-1">Enable or disable outgoing email notifications</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" {...register('enabled')} className="sr-only peer" />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--theme-primary,#2a78d6)]/25 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--theme-primary,#2a78d6)]"></div>
            </label>
          </div>
        </div>

        {/* Mail From */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
          <h3 className="font-semibold text-slate-800">Mail From</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">From Email</label>
              <Input {...register('fromEmail')} placeholder="noreply@yourcompany.com" />
              <p className="text-xs text-slate-400 mt-1">This will appear as the sender address</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">From Name</label>
              <Input {...register('fromName')} placeholder="DigiLog" />
            </div>
          </div>
        </div>

        {/* SMTP Provider */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
          <h3 className="font-semibold text-slate-800">SMTP Provider</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(SMTP_PRESETS).map(([key]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all border-2 ${
                  smtpProvider === key
                    ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-[var(--elev-1)]'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                {key === 'aws-ses' ? 'AWS SES' : key === 'office365' ? 'Office 365' : key.charAt(0).toUpperCase() + key.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* SMTP Server Settings */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
          <h3 className="font-semibold text-slate-800">SMTP Server Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">SMTP Host</label>
              <Input {...register('host')} placeholder="smtp.example.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">SMTP Port</label>
              <Input {...register('port', { valueAsNumber: true })} type="number" placeholder="587" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Connection Timeout (ms)</label>
              <Input {...register('connectionTimeout', { valueAsNumber: true })} type="number" placeholder="10000" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Socket Timeout (ms)</label>
              <Input {...register('socketTimeout', { valueAsNumber: true })} type="number" placeholder="15000" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" {...register('secure')} className="ctl-check" />
            Enable TLS (use for port 465, leave unchecked for STARTTLS on port 587)
          </label>
        </div>

        {/* Authentication */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-5">
          <h3 className="font-semibold text-slate-800">Authentication</h3>

          {/* Auth Type Toggle */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setValue('authType', 'basic', { shouldDirty: true })}
              className={`flex-1 p-4 rounded-xl border-2 text-left transition-all ${
                authType === 'basic'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${authType === 'basic' ? 'bg-blue-500' : 'bg-slate-200'}`}>
                  <svg className={`w-5 h-5 ${authType === 'basic' ? 'text-white' : 'text-slate-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-slate-800">Basic</div>
                  <div className="text-xs text-slate-500">Username and password</div>
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setValue('authType', 'oauth2', { shouldDirty: true })}
              className={`flex-1 p-4 rounded-xl border-2 text-left transition-all ${
                authType === 'oauth2'
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${authType === 'oauth2' ? 'bg-blue-500' : 'bg-slate-200'}`}>
                  <svg className={`w-5 h-5 ${authType === 'oauth2' ? 'text-white' : 'text-slate-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-slate-800">OAuth2</div>
                  <div className="text-xs text-slate-500">Microsoft Azure AD / Google</div>
                </div>
              </div>
            </button>
          </div>

          {/* Basic Auth Fields */}
          {authType === 'basic' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                <Input {...register('username')} placeholder="your-email@domain.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                <Input {...register('password')} type="password" placeholder="Password or App Password" />
              </div>
            </div>
          )}

          {/* OAuth2 Fields */}
          {authType === 'oauth2' && (
            <div className="space-y-4 pt-2">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">OAuth2 Provider</label>
                <div className="flex gap-2">
                  {[
                    { value: 'microsoft', label: 'Microsoft Azure AD' },
                    { value: 'google', label: 'Google' },
                    { value: 'custom', label: 'Custom' },
                  ].map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setValue('oauth2Provider', p.value, { shouldDirty: true })}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        oauth2Provider === p.value
                          ? 'bg-indigo-600 text-white shadow-[var(--elev-1)]'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username (Email)</label>
                <Input {...register('username')} placeholder="your-email@domain.com" />
                <p className="text-xs text-slate-400 mt-1">The email account to send from</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Client ID</label>
                  <Input {...register('clientId')} placeholder="Application (client) ID" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Client Secret</label>
                  <Input {...register('clientSecret')} type="password" placeholder="Client secret value" />
                </div>
              </div>

              {(oauth2Provider === 'microsoft' || oauth2Provider === 'office365') && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Directory (Tenant) ID</label>
                  <Input {...register('providerTenantId')} placeholder="Azure AD Tenant ID" />
                  <p className="text-xs text-slate-400 mt-1">Found in Azure Portal &gt; App Registrations &gt; Overview</p>
                </div>
              )}

              {oauth2Provider === 'google' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Refresh Token</label>
                  <Input {...register('refreshToken')} type="password" placeholder="OAuth2 refresh token" />
                  <p className="text-xs text-slate-400 mt-1">Will be obtained automatically via OAuth2 flow below</p>
                </div>
              )}

              {oauth2Provider === 'custom' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Token URL</label>
                    <Input {...register('tokenUrl')} placeholder="https://auth.provider.com/oauth2/token" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-slate-700 mb-1">Scope</label>
                    <Input {...register('scope')} placeholder="e.g. https://outlook.office365.com/.default" />
                  </div>
                </div>
              )}

              {(oauth2Provider === 'microsoft' || oauth2Provider === 'office365' || oauth2Provider === 'google') && (
                <div className="mt-4 p-5 bg-gradient-to-r from-indigo-50 to-blue-50 rounded-xl border border-indigo-200 space-y-4">
                  <h4 className="font-semibold text-indigo-800 text-sm">OAuth2 Authorization Code Flow</h4>

                  <div>
                    <label className="block text-xs font-medium text-indigo-700 mb-1">
                      Redirect URI <span className="text-indigo-400">(copy this to your {oauth2Provider === 'google' ? 'Google Cloud Console' : 'Azure AD App Registration'})</span>
                    </label>
                    <div className="flex gap-2">
                      {/* "Loading…" belongs in the placeholder, not the VALUE.
                          The Copy button is safe either way — it guards on
                          `redirectData?.redirectUri` — but a read-only field
                          whose value is the word "Loading..." is still text an
                          operator can select and paste into their OAuth
                          provider's redirect-URI box, and it reads as a value
                          rather than as an absence. */}
                      <input
                        type="text"
                        readOnly
                        value={redirectData?.redirectUri ?? ''}
                        placeholder="Loading…"
                        className="ctl flex-1 font-mono"
                      />
                      <Button 
                        type="button"
                        onClick={copyRedirectUri}
                      >
                        {copied ? (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            Copied!
                          </>
                        ) : (
                          <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                            Copy
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {oauth2Status && (
                    <div className={`flex items-center gap-3 p-3 rounded-lg ${oauth2Status.configured ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
                      <div className={`w-3 h-3 rounded-full ${oauth2Status.configured ? 'bg-green-500' : 'bg-amber-500'}`} />
                      <div className="text-sm">
                        {oauth2Status.configured ? (
                          <span className="text-green-700">
                            OAuth2 tokens configured
                            {oauth2Status.hasRefreshToken && ' (with refresh token)'}
                            {oauth2Status.tokenExpiresAt && (
                              <span className="text-green-500 ml-1">
                                {' \u2014 expires ' + formatDateTime(oauth2Status.tokenExpiresAt)}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-amber-700">
                            OAuth2 not configured yet. Save your settings first, then click &quot;Get OAuth2 Token&quot; below.
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <Button 
                      type="button"
                      onClick={startOAuth2Flow}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      {oauth2Status?.configured ? 'Re-authorize OAuth2' : 'Get OAuth2 Token'}
                    </Button>
                    <p className="text-xs text-indigo-500">
                      Opens a popup to authorize with {oauth2Provider === 'google' ? 'Google' : 'Microsoft'}. Save your configuration first!
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="flex justify-end gap-3">
          <Button type="submit" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </form>

      {/* Test Section */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
        <h3 className="font-semibold text-slate-800">Send Test Email</h3>
        <p className="text-sm text-slate-500">Enter a recipient email and send a test message to verify your configuration works.</p>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Recipient Email</label>
            <Input
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="test@example.com"
            />
          </div>
          <Button type="button" onClick={onTest} disabled={testing || !enabled} variant="outline">
            {testing ? 'Testing...' : testEmail ? 'Send Test Email' : 'Test Connection'}
          </Button>
        </div>
        {testResult && (
          <div className={`px-4 py-3 rounded-xl text-sm ${testResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            {testResult.success ? testResult.message : testResult.error}
          </div>
        )}
      </div>

      {/* Setup Guides */}
      {authType === 'oauth2' && (oauth2Provider === 'microsoft' || oauth2Provider === 'office365') && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-[var(--radius-card)] border border-blue-200 p-6">
          <h3 className="font-semibold text-blue-800 mb-3">Microsoft Azure AD OAuth2 Setup Guide</h3>
          <ol className="space-y-2 text-sm text-blue-700 list-decimal list-inside">
            <li>Go to <strong>Azure Portal</strong> &gt; Azure Active Directory &gt; App Registrations</li>
            <li>Click <strong>New Registration</strong>, name it (e.g. &quot;DigiLog Mail&quot;), select &quot;Accounts in this organizational directory only&quot;</li>
            <li>Under <strong>Redirect URIs</strong>, add the redirect URI shown above as a <strong>Web</strong> platform URI</li>
            <li>Copy the <strong>Application (client) ID</strong> and <strong>Directory (tenant) ID</strong> from the Overview page</li>
            <li>Go to <strong>Certificates &amp; Secrets</strong> &gt; New client secret &gt; copy the secret value</li>
            <li>Go to <strong>API Permissions</strong> &gt; Add permission &gt; APIs my organization uses &gt; search &quot;Office 365 Exchange Online&quot;</li>
            <li>Add <strong>Delegated</strong> permission: <strong>SMTP.Send</strong></li>
            <li>Also add Microsoft Graph &gt; Delegated &gt; <strong>offline_access</strong></li>
            <li>Click &quot;Grant admin consent&quot; for your organization</li>
            <li>Fill in the Client ID, Client Secret, and Tenant ID above, <strong>save</strong>, then click <strong>&quot;Get OAuth2 Token&quot;</strong></li>
          </ol>
        </div>
      )}

      {authType === 'oauth2' && oauth2Provider === 'google' && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-[var(--radius-card)] border border-blue-200 p-6">
          <h3 className="font-semibold text-blue-800 mb-3">Google OAuth2 Setup Guide</h3>
          <ol className="space-y-2 text-sm text-blue-700 list-decimal list-inside">
            <li>Go to <strong>Google Cloud Console</strong> &gt; APIs &amp; Services &gt; Credentials</li>
            <li>Create an <strong>OAuth 2.0 Client ID</strong> (Web application type)</li>
            <li>Under <strong>Authorized redirect URIs</strong>, add the redirect URI shown above</li>
            <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
            <li>Enable the <strong>Gmail API</strong> in APIs &amp; Services &gt; Library</li>
            <li>Fill in the Client ID and Client Secret above, <strong>save</strong>, then click <strong>&quot;Get OAuth2 Token&quot;</strong></li>
          </ol>
        </div>
      )}

      {authType === 'basic' && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-[var(--radius-card)] border border-blue-200 p-6">
          <h3 className="font-semibold text-blue-800 mb-3">Provider Setup Guide</h3>
          <div className="grid gap-3 text-sm text-blue-700">
            <div><strong>Gmail:</strong> Use App Passwords (Settings &gt; Security &gt; App passwords). Host: smtp.gmail.com, Port: 587</div>
            <div><strong>Office 365:</strong> Enable &quot;Authenticated SMTP&quot; in Admin Center &gt; Users &gt; Mail &gt; Manage email apps. Host: smtp.office365.com, Port: 587</div>
            <div><strong>AWS SES:</strong> Create SMTP credentials in AWS console. Host: email-smtp.&#123;region&#125;.amazonaws.com, Port: 587</div>
            <div><strong>SendGrid:</strong> Use API key as password, username: apikey. Host: smtp.sendgrid.net, Port: 587</div>
          </div>
          <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-700">
              <strong>Note:</strong> If your Microsoft account has security defaults or MFA enabled and basic SMTP auth is blocked, switch to <strong>OAuth2</strong> authentication above.
            </p>
          </div>
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update Email Settings"
      />
    </div>
  );
}

// ─── SMS Tab ──────────────────────────────────────────────────────────
function SmsTab() {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [testing, setTesting] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);

  const { data, mutate } = useSWR('/api/notification-settings/sms', { revalidateOnMount: true, dedupingInterval: 0 });

  const defaultValues: SmsConfig = {
    provider: 'http-gateway', enabled: false, defaultCountryCode: '+91', senderId: 'DigiLog',
    twilioAccountSid: '', twilioAuthToken: '', twilioFromNumber: '',
    vonageApiKey: '', vonageApiSecret: '', vonageFromNumber: '',
    httpGatewayUrl: '', httpGatewayMethod: 'POST', httpGatewayHeaders: {}, httpGatewayBodyTemplate: '',
    httpGatewaySuccessRegex: '',
  };

  const { register, handleSubmit, watch, reset, formState: { isSubmitting, isDirty } } = useForm<SmsConfig>({
    values: data ? { ...defaultValues, ...data } : defaultValues,
  });

  const provider = watch('provider');
  const enabled = watch('enabled');

  const reauth = useReauth();
  const onSubmit = (formData: SmsConfig) => {
    setError('');
    setSuccess('');
    reauth.execute(
      'UPDATE_SMS_CONFIG',
      async (password?: string) => {
        if (password) await apiClient.putWithReauth('/api/notification-settings/sms', formData, password);
        else await apiClient.put('/api/notification-settings/sms', formData);
      },
      {
        onSuccess: () => {
          setSuccess('SMS settings saved successfully');
          mutate();
          reset(formData);
        },
        onError: (err: any) => setError(err.message || 'Failed to save'),
      },
    );
  };

  const onTest = async () => {
    if (!testPhone) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiClient.post<{ success: boolean; message?: string; error?: string }>(
        '/api/notification-settings/sms/test',
        { recipient: testPhone },
      );
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message || 'Test failed' });
    }
    setTesting(false);
  };

  return (
    <div className="space-y-6">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">{success}</div>}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Enable toggle */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)]">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800">SMS Notifications</h3>
              <p className="text-sm text-slate-500 mt-1">Enable or disable SMS notification delivery</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" {...register('enabled')} className="sr-only peer" />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--theme-primary,#2a78d6)]/25 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--theme-primary,#2a78d6)]"></div>
            </label>
          </div>
        </div>

        {/* Provider Selection */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
          <h3 className="font-semibold text-slate-800">SMS Provider</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {SMS_PROVIDERS.map((p) => (
              <label
                key={p.value}
                className={`flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${provider === p.value ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}
              >
                <input type="radio" value={p.value} {...register('provider')} className="ctl-radio mt-1" />
                <div>
                  <div className="font-medium text-slate-800">{p.label}</div>
                  <div className="text-xs text-slate-500">{p.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Common Settings */}
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
          <h3 className="font-semibold text-slate-800">Common Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Default Country Code</label>
              <Input {...register('defaultCountryCode')} placeholder="+91" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Sender ID</label>
              <Input {...register('senderId')} placeholder="DigiLog" />
            </div>
          </div>
        </div>

        {/* Provider-specific settings */}
        {provider === 'twilio' && (
          <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
            <h3 className="font-semibold text-slate-800">Twilio Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Account SID</label>
                <Input {...register('twilioAccountSid')} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Auth Token</label>
                <Input {...register('twilioAuthToken')} type="password" placeholder="Auth token" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">From Number</label>
                <Input {...register('twilioFromNumber')} placeholder="+1234567890" />
              </div>
            </div>
          </div>
        )}

        {/* P3 (2026-05-02): AWS SNS provider block removed. Operators wanting
            AWS SNS use the HTTP Gateway pointed at the SNS REST endpoint. */}

        {provider === 'vonage' && (
          <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
            <h3 className="font-semibold text-slate-800">Vonage (Nexmo) Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
                <Input {...register('vonageApiKey')} placeholder="API key" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">API Secret</label>
                <Input {...register('vonageApiSecret')} type="password" placeholder="API secret" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">From Number</label>
                <Input {...register('vonageFromNumber')} placeholder="+1234567890 or sender name" />
              </div>
            </div>
          </div>
        )}

        {provider === 'http-gateway' && (
          <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
            <h3 className="font-semibold text-slate-800">HTTP Gateway Settings</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gateway URL</label>
                <Input {...register('httpGatewayUrl')} placeholder="https://apiClient.sms-provider.com/send?to={phone}&msg={message}" />
                <p className="text-xs text-slate-500 mt-1">Use {'{phone}'} and {'{message}'} as placeholders</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">HTTP Method</label>
                <select {...register('httpGatewayMethod')} className="ctl w-full">
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Body Template (for POST)</label>
                <textarea
                  {...register('httpGatewayBodyTemplate')}
                  className="ctl w-full font-mono"
                  placeholder={'{"to": "{phone}", "message": "{message}"}'}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Success Response Pattern (optional)</label>
                <Input {...register('httpGatewaySuccessRegex')} placeholder={'"status"\\s*:\\s*"success"'} />
                <p className="text-xs text-slate-500 mt-1">
                  Regex the response body must match to count as delivered. Many gateways return HTTP 200 even on
                  failure — set this so a failed send is recorded as failed (and retried). Leave blank to accept any
                  2xx that isn't an obvious JSON error.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Button type="submit" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </form>

      {/* Test Section */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-6 shadow-[var(--elev-1)] space-y-4">
        <h3 className="font-semibold text-slate-800">Test SMS Configuration</h3>
        <p className="text-sm text-slate-500">Send a test SMS to verify your settings.</p>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">Phone Number</label>
            <Input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+919876543210"
            />
          </div>
          <Button type="button" onClick={onTest} disabled={testing || !enabled || !testPhone} variant="outline">
            {testing ? 'Sending...' : 'Send Test SMS'}
          </Button>
        </div>
        {testResult && (
          <div className={`px-4 py-3 rounded-xl text-sm ${testResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            {testResult.success ? testResult.message : testResult.error}
          </div>
        )}
      </div>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update SMS Settings"
      />
    </div>
  );
}
