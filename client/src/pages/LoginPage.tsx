import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { Logo } from '@/components/common/Logo';
import toast from 'react-hot-toast';

/**
 * Login page with Obligate SSO redirect — same pattern as the other Obli* apps.
 *
 * On mount we:
 *   1. Check `/api/auth/me` — if a session already exists, navigate to `/` and skip everything.
 *   2. Else call `/api/auth/sso-config`:
 *      - If Obligate is enabled and reachable → `window.location.href = '/auth/sso-redirect'`
 *      - If enabled but unreachable → show the local login with an inline warning
 *      - If not configured → show the local login normally
 *
 * Anti-loop: a 15s session-scoped timestamp prevents a redirect loop when Obligate accepts the
 * login but bounces back here for some reason.
 *
 * Recovery polling: when Obligate is unreachable, poll every 60s and auto-redirect as soon as
 * it comes back — operator doesn't have to refresh.
 *
 * `?error=sso_failed` / `?error=account_disabled` suppresses the auto-redirect (and the recovery
 * polling) for this load so the user can fall back to local auth without being thrown back at SSO.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading } = useAuthStore();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Any SSO error suppresses the auto-redirect for this load (no bounce back to Obligate)
  const ssoError = searchParams.get('error');
  const accountDisabled = ssoError === 'account_disabled';
  const ssoFailed = ssoError === 'sso_failed' || accountDisabled;
  const [ssoState, setSsoState] = useState<'checking' | 'redirecting' | 'unavailable' | 'local'>(ssoFailed ? 'unavailable' : 'checking');

  const checkSso = () => {
    return fetch('/api/auth/sso-config')
      .then(r => r.json())
      .then((data: { success: boolean; data?: { obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean } }) => {
        if (data.success && data.data?.obligateEnabled && data.data.obligateUrl) {
          if (data.data.obligateReachable) {
            const lastRedirect = sessionStorage.getItem('_sso_redirect_ts');
            if (lastRedirect && Date.now() - parseInt(lastRedirect) < 15000) {
              setSsoState('unavailable');
              return;
            }
            sessionStorage.setItem('_sso_redirect_ts', String(Date.now()));
            setSsoState('redirecting');
            window.location.href = '/auth/sso-redirect';
            return;
          }
          setSsoState('unavailable');
          return;
        }
        setSsoState('local');
      })
      .catch(() => setSsoState('unavailable'));
  };

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success?: boolean }) => {
        if (d.success) { navigate('/', { replace: true }); return; }
        if (!ssoFailed) checkSso();
        else setSsoState('unavailable');
      })
      .catch(() => { if (!ssoFailed) checkSso(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-probe Obligate every 60s while it's marked unavailable — auto-redirect when it recovers.
  useEffect(() => {
    // Only while Obligate is unreachable: after an SSO error, another attempt would fail the same way
    if (ssoState !== 'unavailable' || ssoFailed) return;
    const interval = setInterval(() => { checkSso(); }, 60_000);
    return () => clearInterval(interval);
  }, [ssoState]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      navigate('/');
    } catch {
      toast.error('Invalid credentials');
    }
  };

  // While we're figuring out SSO, never flash the local form — it would be confusing UX for
  // anyone whose only login path is Obligate.
  if (ssoState === 'checking' || ssoState === 'redirecting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
        <div className="text-center space-y-3">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm text-text-muted">
            {ssoState === 'redirecting' ? 'Redirecting to login…' : 'Checking authentication…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <Logo className="mx-auto h-16 w-auto mb-3" />
          <p className="mt-2 text-sm text-text-secondary">Sign in to continue</p>
        </div>
        {ssoState === 'unavailable' && (
          <div className="rounded-lg border border-status-pending/30 bg-status-pending/10 px-3 py-2 text-xs text-status-pending text-center">
            {accountDisabled
              ? 'Your Oblihub account is disabled. Ask an Oblihub administrator to re-enable it.'
              : ssoFailed
              ? 'SSO authentication failed. Sign in with a local account.'
              : 'Centralized login (Obligate) is unreachable. Using local authentication — will auto-redirect when SSO is back.'}
          </div>
        )}
        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-bg-secondary p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button type="submit" disabled={isLoading}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
            {isLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
