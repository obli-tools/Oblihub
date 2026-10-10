import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Bell, MoreHorizontal, ChevronDown } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import { Logo } from '@/components/common/Logo';
import { HostStatsIndicator } from '@/components/HostStatsIndicator';

/** app_type this instance is registered under in Obligate. */
const CURRENT_APP = 'oblihub';

// Fallback colour for an app Obligate has no `color` set for (never set in
// AppsPage, and the app itself hasn't self-reported one yet via the
// self-info endpoint).
const FALLBACK_APP_COLOR = '#8b949e';

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string | null;
  color: string | null;
  /** Marks the entry that is this app itself (resolved by Obligate from the Bearer key). */
  self?: boolean;
  /** Not an Obli* app (filed under "More…" in Obligate): listed in the "More…" dropdown. */
  thirdParty?: boolean;
}

/** Used only until the dynamic list loads / if Obligate ever omits self — never for other apps. */
const CURRENT_APP_FALLBACK: ConnectedApp = { appType: CURRENT_APP, name: 'Oblihub', baseUrl: '', icon: null, color: '#1678cd', self: true };

// Apps are refreshed periodically so a newly-registered app in Obligate
// appears here without requiring a reload of this tab.
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function Header() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const switcherWrapRef = useRef<HTMLDivElement>(null); // flexible-width slot: its clientWidth is the space actually granted
  const measureRef = useRef<HTMLDivElement>(null); // hidden, always full-label, used only to measure the width the switcher would need
  const moreRef = useRef<HTMLDivElement>(null);

  const loadApps = () => {
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: ConnectedApp[] }) => {
        if (d.success && d.data) setConnectedApps(d.data);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadApps();
    const interval = setInterval(loadApps, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // The current app is whichever entry Obligate marked `self` (falls back to
  // matching appType for older Obligate versions that don't send `self`
  // yet), synthesised from CURRENT_APP_FALLBACK if Obligate ever omits it
  // entirely — Oblihub's own pill must never disappear from its own switcher.
  const selfEntry = connectedApps.find(a => a.self) ?? connectedApps.find(a => a.appType === CURRENT_APP);
  const visibleApps: ConnectedApp[] = selfEntry
    ? connectedApps
    : [CURRENT_APP_FALLBACK, ...connectedApps];
  const isCurrentApp = (a: ConnectedApp) => a.self === true || a.appType === CURRENT_APP;
  // Obli* apps in the main row, third-party apps (Passly…) in "More…". The
  // current app always stays in the main row, even when it is third-party.
  const mainApps = visibleApps.filter(a => !a.thirdParty || isCurrentApp(a));
  const moreApps = visibleApps.filter(a => a.thirdParty && !isCurrentApp(a));

  const goApp = (app: ConnectedApp) => {
    if (isCurrentApp(app)) return;
    window.location.href = `${app.baseUrl}/auth/sso-redirect`;
  };

  // "More…" dropdown: outside click and Escape close it.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  // Collapse to icon-only pills the moment the fully-labelled row would not
  // fit the space flexbox actually grants the switcher — re-measured on
  // every resize and every time the app list changes (new app registered).
  useEffect(() => {
    const el = switcherWrapRef.current;
    const measure = measureRef.current;
    if (!el || !measure) return;
    const update = () => setCollapsed(measure.scrollWidth > el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainApps.length, moreApps.length]);

  const displayName = user?.displayName || user?.username || 'User';
  const cleanName = displayName.startsWith('og_') ? displayName.slice(3) : displayName;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const moreButton = (labelled: boolean, interactive: boolean) => (
    <button
      type="button"
      onClick={interactive ? () => setMoreOpen(v => !v) : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-haspopup={interactive ? 'true' : undefined}
      aria-expanded={interactive ? moreOpen : undefined}
      className={cn(
        'flex items-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary shrink-0',
        labelled ? 'px-3' : 'px-1.5',
      )}
      title="More…"
      aria-label="More apps"
    >
      <MoreHorizontal size={14} className="shrink-0" />
      {labelled && <span>More…</span>}
      {labelled && <ChevronDown size={12} className={cn('shrink-0 text-text-muted transition-transform', moreOpen && 'rotate-180')} />}
    </button>
  );

  const pill = (app: ConnectedApp, labelled: boolean) => {
    const isCurrent = isCurrentApp(app);
    return (
      <button
        key={app.appType}
        type="button"
        onClick={() => goApp(app)}
        className={cn(
          'flex items-center gap-2 rounded-md px-3 py-1.5 text-[12.5px] transition-colors shrink-0',
          isCurrent
            ? 'bg-bg-secondary font-semibold text-text-primary shadow-[0_1px_3px_rgb(46_52_64_/_0.1)]'
            : 'font-medium text-text-secondary hover:bg-bg-active hover:text-text-primary',
          !labelled && 'px-1.5',
        )}
        title={app.name}
        aria-label={app.name}
      >
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: app.color || FALLBACK_APP_COLOR }} />
        {labelled && app.name}
      </button>
    );
  };

  return (
    <header
      className="relative flex shrink-0 items-center gap-3 bg-bg-secondary px-4"
      style={{ height: 52 }}
    >
      {/* Logo — theme-aware wordmark, no text label (Obliance-style: the wordmark is the label). */}
      <Link to="/" className="flex items-center shrink-0">
        <Logo className="h-8 w-auto max-w-[160px] object-contain" />
      </Link>

      {/* App switcher — flexible-width slot so it can actually be squeezed by
          its siblings (logo, right cluster): that's what makes the
          available-space measurement below meaningful. */}
      {/* No overflow-hidden here: it would clip the "More…" dropdown. */}
      <div ref={switcherWrapRef} className="ml-2 flex-1 min-w-0 flex items-center">
        <nav className="flex items-center gap-1 rounded-lg bg-bg-hover p-1">
          {mainApps.map(app => pill(app, !collapsed))}
          {moreApps.length > 0 && (
            <div ref={moreRef} className="relative">
              {moreButton(!collapsed, true)}
              {moreOpen && (
                <div className="absolute left-0 top-9 z-50 w-56 max-w-[calc(100vw-1.5rem)] rounded-xl bg-bg-secondary shadow-2xl overflow-hidden">
                  <div className="px-3 py-2">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">Other apps</p>
                  </div>
                  <div className="py-1 max-h-64 overflow-y-auto overscroll-contain">
                    {moreApps.map(app => (
                      <button
                        key={app.appType + app.baseUrl}
                        type="button"
                        onClick={() => { setMoreOpen(false); goApp(app); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors hover:bg-bg-hover"
                      >
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: app.color || FALLBACK_APP_COLOR }} />
                        <span className="truncate">{app.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </nav>
      </div>

      {/* Hidden measurer: always the full-label version, off-screen, used only
          to know whether the labelled switcher would fit — never visible,
          never interactive. */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute -z-10 opacity-0 pointer-events-none flex items-center gap-1 p-1"
        style={{ top: -9999, left: -9999 }}
      >
        {mainApps.map(app => pill(app, true))}
        {moreApps.length > 0 && moreButton(true, false)}
      </div>

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-3 shrink-0">
        {/* Host resource indicator — visible on every page so a runaway build doesn't sneak
            past the operator. Hidden on <md to keep mobile topbar readable. */}
        <HostStatsIndicator />
        <button
          type="button"
          title="Notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <Bell size={15} />
        </button>

        {user && (
          <>
            {/* User pill — same bg-hover surface as the switcher container so both frames
                stay coherent across every theme. Avatar disc keeps rounded-full inside. */}
            <Link
              to="/profile"
              className="flex items-center gap-2 rounded-lg bg-bg-hover py-1 pl-1.5 pr-3 transition-colors hover:bg-bg-active"
              title="Profile"
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={cleanName}
                  className="w-7 h-7 rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, rgb(22 120 205 / 0.8), rgb(72 143 236 / 0.5))' }}
                >
                  {(cleanName[0] ?? '?').toUpperCase()}
                </div>
              )}
              <span className="text-[13px] font-medium text-text-primary">{cleanName}</span>
              {user.role && (
                <span className="text-[10px] font-mono uppercase tracking-wider text-accent pl-2 border-l border-border-light">
                  {user.role}
                </span>
              )}
            </Link>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
