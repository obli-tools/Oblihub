import { useEffect, useState, type FormEvent } from 'react';
import { profileApi } from '@/api/profile.api';
import { settingsApi } from '@/api/settings.api';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@oblihub/shared';
import toast from 'react-hot-toast';
import { Save, Lock, ExternalLink, Palette } from 'lucide-react';
import { ThemePicker } from '@/components/ThemePicker';
import { applyTheme, loadSavedTheme, type AppTheme } from '@/utils/theme';

export function ProfilePage() {
  const { user: sessionUser, checkSession } = useAuthStore();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);

  // Profile fields
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Password fields
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Theme
  const [preferredTheme, setPreferredTheme] = useState<AppTheme>(loadSavedTheme);

  useEffect(() => {
    profileApi.getProfile().then((u) => {
      setUser(u);
      setDisplayName(u.displayName || '');
      setEmail(u.email || '');
      // If the server has a stored preference (e.g. synced from Obligate), prefer it over localStorage.
      if (u.preferences?.preferredTheme) {
        setPreferredTheme(u.preferences.preferredTheme);
        applyTheme(u.preferences.preferredTheme);
      }
    }).catch(() => toast.error('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const handleThemeChange = async (theme: AppTheme) => {
    setPreferredTheme(theme);
    applyTheme(theme); // live preview
    try {
      await profileApi.updateProfile({ preferences: { preferredTheme: theme } });
      toast.success('Theme saved');
    } catch {
      toast.error('Failed to save theme');
    }
  };

  // Fetch Obligate URL for SSO users
  useEffect(() => {
    if (sessionUser?.foreignSource === 'obligate') {
      settingsApi.getAll().then(cfg => {
        setObligateUrl(cfg.obligate_url ?? null);
      }).catch(() => {});
    }
  }, [sessionUser]);

  const handleProfileSave = async (e: FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const updated = await profileApi.updateProfile({ displayName, email });
      setUser(updated);
      checkSession();
      toast.success('Profile updated');
    } catch {
      toast.error('Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setSavingPassword(true);
    try {
      await profileApi.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to change password';
      toast.error(msg);
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  const isSSO = sessionUser?.foreignSource === 'obligate';

  // SSO users: profile is managed by Obligate, but appearance is a local UI preference.
  if (isSSO && obligateUrl) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold text-text-primary">Profile</h1>

        <div className="rounded-xl border border-border bg-bg-secondary p-6 text-center">
          <Lock size={32} className="mx-auto mb-3 text-accent" />
          <h2 className="text-lg font-medium text-text-primary mb-2">Managed by Obligate</h2>
          <p className="text-sm text-text-secondary mb-4">
            Your profile is managed through Obligate SSO. Use the Obligate account page to update your name, email, password and avatar.
          </p>
          <a
            href={`${obligateUrl}/account`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium text-sm transition-colors"
          >
            <ExternalLink size={14} /> Open Obligate Profile
          </a>
        </div>

      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Profile</h1>

      {/* Account info */}
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Account Information</h2>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Username</label>
          <input type="text" value={user?.username || ''} disabled
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-muted cursor-not-allowed" />
        </div>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Role</label>
          <input type="text" value={user?.role || ''} disabled
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-muted cursor-not-allowed capitalize" />
        </div>
      </div>

      {/* Edit profile */}
      <form onSubmit={handleProfileSave} className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Edit Profile</h2>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Enter display name"
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email address"
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <button type="submit" disabled={savingProfile}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          <Save size={14} /> {savingProfile ? 'Saving...' : 'Save Profile'}
        </button>
      </form>

      {/* Appearance */}
      <div className="rounded-xl border border-border bg-bg-secondary p-5 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2">
          <Palette size={14} /> Appearance
        </h2>
        <p className="text-xs text-text-muted mb-4">Pick a theme — applies immediately and is saved to your profile.</p>
        <ThemePicker value={preferredTheme} onChange={handleThemeChange} />
      </div>

      {/* Change password — local users only */}
      <form onSubmit={handlePasswordChange} className="rounded-xl border border-border bg-bg-secondary p-5">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Change Password</h2>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Current Password</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">New Password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div className="mb-4">
          <label className="block text-sm text-text-secondary mb-1">Confirm New Password</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <button type="submit" disabled={savingPassword}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          <Lock size={14} /> {savingPassword ? 'Changing...' : 'Change Password'}
        </button>
      </form>
    </div>
  );
}
