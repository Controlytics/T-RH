import { useState, useRef } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useBranding } from '@/hooks/use-branding';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { getPhotoUrl } from '../../lib/url-utils';
import { getApiBase } from '@/lib/api-base';

const roleColors: Record<string, string> = {
  SUPER_ADMIN: 'bg-gradient-to-r from-red-500 to-pink-500 text-white border-0',
  ADMIN: 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white border-0',
  SUPERVISOR: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0',
  MAINTENANCE: 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0',
  OPERATOR: 'bg-gradient-to-r from-slate-500 to-gray-500 text-white border-0',
  VIEWER: 'bg-gradient-to-r from-gray-400 to-slate-400 text-white border-0',
};

const roleLabels: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  MAINTENANCE: 'Maintenance',
  OPERATOR: 'Operator',
  VIEWER: 'Viewer',
};

export function ProfilePage() {
  const { user, mutate } = useAuth();
  const { branding } = useBranding();
  const { formatDateTime, formatDate } = useDatetimeFormat();
  const reauth = useReauth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState({
    fullName: user?.fullName ?? '',
    email: user?.email ?? '',
    department: user?.department ?? '',
    photoUrl: user?.photoUrl ?? '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    // H1 fix: PUT /api/auth/profile is now reauth-gated server-side. Wrap the
    // call in reauth.execute() so the password challenge dialog appears when
    // UPDATE_PROFILE is configured for the current role.
    reauth.execute(
      'UPDATE_PROFILE',
      async (password?: string) => {
        if (password) {
          await apiClient.putWithReauth('/api/auth/profile', formData, password);
        } else {
          await apiClient.put('/api/auth/profile', formData);
        }
      },
      {
        onSuccess: async () => {
          await mutate();
          setShowSuccess(true);
          setIsSubmitting(false);
        },
        onError: (err: any) => {
          setError(err?.message || 'Failed to update profile');
          setIsSubmitting(false);
        },
      },
    );
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setError('Only JPEG, PNG, GIF, and WebP images are allowed');
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError('File size must be less than 5MB');
      return;
    }

    setError('');
    setIsUploading(true);

    try {
      const formDataUpload = new FormData();
      formDataUpload.append('file', file);

      const token = localStorage.getItem('access_token');
      const response = await fetch(`${getApiBase()}/api/uploads/photo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formDataUpload,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Upload failed');
      }

      const data = await response.json();
      setFormData(prev => ({ ...prev, photoUrl: data.photoUrl }));
    } catch (err: any) {
      setError(err.message || 'Failed to upload photo');
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemovePhoto = () => {
    setFormData(prev => ({ ...prev, photoUrl: '' }));
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  if (!user) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Profile Header Card */}
      <Card className="overflow-hidden">
        <div
          className="h-32 relative"
          style={{ background: `linear-gradient(135deg, ${branding.primaryColor}, ${branding.secondaryColor})` }}
        >
          <div className="absolute -bottom-12 left-8">
            <div className="relative group">
              {formData.photoUrl ? (
                <img
                  src={getPhotoUrl(formData.photoUrl)}
                  alt={formData.fullName}
                  className="w-24 h-24 rounded-2xl object-cover border-4 border-white shadow-xl"
                />
              ) : (
                <div
                  className="w-24 h-24 rounded-2xl flex items-center justify-center text-white text-2xl font-bold border-4 border-white shadow-xl"
                  style={{ background: `linear-gradient(135deg, ${branding.secondaryColor}, ${branding.accentColor})` }}
                >
                  {formData.fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                </div>
              )}
              <button
                type="button"
                onClick={triggerFileSelect}
                disabled={isUploading}
                className="absolute inset-0 rounded-2xl bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center disabled:cursor-not-allowed"
              >
                {isUploading ? (
                  <svg className="animate-spin w-6 h-6 text-white" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                )}
              </button>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          </div>
        </div>
        <CardContent className="pt-16 pb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-800">{user.fullName}</h1>
              <div className="flex items-center gap-3 mt-2">
                <Badge className={`${roleColors[user.role] ?? ''}`}>
                  {roleLabels[user.role] ?? user.role}
                </Badge>
                <span className="text-sm text-slate-500">@{user.username}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit Form */}
      <Card>
        <CardHeader>
          <CardTitle>Edit Profile</CardTitle>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-5">
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center gap-3">
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-600">User ID</label>
              <Input value={user.username} disabled className="bg-slate-50" />
              <p className="text-xs text-slate-500">User ID cannot be changed</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Full Name *</label>
                <Input
                  name="fullName"
                  value={formData.fullName}
                  onChange={(e) => {
                    const clean = e.target.value.replace(/<[^>]*>/g, '');
                    setFormData(prev => ({ ...prev, fullName: clean }));
                  }}
                  required
                  minLength={2}
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Email *</label>
                <Input
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Department</label>
              <Input
                name="department"
                value={formData.department}
                onChange={(e) => {
                  // Strip HTML tags on input
                  const clean = e.target.value.replace(/<[^>]*>/g, '');
                  setFormData(prev => ({ ...prev, department: clean }));
                }}
                placeholder="e.g., Engineering, Quality Assurance"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Profile Photo</label>
              <div className="flex items-center gap-4">
                {formData.photoUrl ? (
                  <img
                    src={getPhotoUrl(formData.photoUrl)}
                    alt="Profile"
                    className="w-16 h-16 rounded-xl object-cover border border-slate-200"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={triggerFileSelect} disabled={isUploading}>
                    {isUploading ? (
                      <span className="flex items-center gap-2">
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Uploading...
                      </span>
                    ) : formData.photoUrl ? 'Change Photo' : 'Upload Photo'}
                  </Button>
                  {formData.photoUrl && (
                    <Button type="button" variant="outline" size="sm" onClick={handleRemovePhoto} className="text-red-600 hover:bg-red-50">
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500">Supported formats: JPEG, PNG, GIF, WebP (max 5MB)</p>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Account Information</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500">Role:</span>
                  <span className="ml-2 font-medium">{roleLabels[user.role] ?? user.role}</span>
                </div>
                <div>
                  <span className="text-slate-500">Status:</span>
                  <span className="ml-2 font-medium text-emerald-600">{user.status}</span>
                </div>
                <div>
                  <span className="text-slate-500">Last Login:</span>
                  <span className="ml-2 font-medium">
                    {user.lastLogin ? formatDateTime(user.lastLogin) : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Member Since:</span>
                  <span className="ml-2 font-medium">
                    {user.createdAt ? formatDate(user.createdAt) : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-3 border-t border-slate-100 pt-4 mt-2">
            <Button variant="outline" onClick={() => window.history.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Re-auth dialog for UPDATE_PROFILE — challenges for password when configured */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setIsSubmitting(false); }}
        actionLabel="Update Profile"
      />

      {/* Success Dialog */}
      <Dialog open={showSuccess} onClose={() => setShowSuccess(false)}>
        <DialogHeader>
          <DialogTitle>Profile Updated</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm text-slate-600">Your profile has been updated successfully.</p>
        </div>
        <DialogFooter>
          <Button onClick={() => setShowSuccess(false)}>Close</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
