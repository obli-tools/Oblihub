import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Users,
  UserCircle,
  LogOut,
  Layers,
  HardDrive,
  Network,
  Database,
  Globe,
  Shield,
  ArrowRight,
  Radio,
  Ban,
  ShieldCheck,
  FileText,
  Activity,
  Package,
  Server,
  ChevronsLeft,
  ChevronsRight,
  KeyRound,
  Zap,
  Gauge,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

const COLLAPSED_KEY = 'oblihub:groupPanelCollapsed';

function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T | ((p: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, [key]);
  return [value, set];
}

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

interface SidebarProps {
  allowStack: boolean;
  allowNginx: boolean;
}

export function Sidebar({ allowStack, allowNginx }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const isAdmin = user?.role === 'admin';

  const [collapsed, setCollapsed] = usePersisted<boolean>(COLLAPSED_KEY, false);
  const [search, setSearch] = useState('');

  const displayName = user?.displayName || user?.username || 'User';
  const cleanName = displayName.startsWith('og_') ? displayName.slice(3) : displayName;

  const mainNav: NavItem[] = [
    { label: 'Dashboard', path: '/', icon: <LayoutDashboard size={18} /> },
    { label: 'App Store', path: '/app-store', icon: <Package size={18} /> },
    { label: 'Resources', path: '/resources', icon: <Gauge size={18} /> },
  ];

  const stackNav: NavItem[] = allowStack
    ? [
        { label: 'Stacks', path: '/managed-stacks', icon: <Layers size={18} /> },
        { label: 'Images', path: '/images', icon: <HardDrive size={18} /> },
        { label: 'Networks', path: '/networks', icon: <Network size={18} /> },
        { label: 'Volumes', path: '/volumes', icon: <Database size={18} /> },
      ]
    : [];

  const proxyNav: NavItem[] = allowNginx
    ? [
        { label: 'Proxy Hosts', path: '/proxy-hosts', icon: <Globe size={18} /> },
        { label: 'Redirections', path: '/redirections', icon: <ArrowRight size={18} /> },
        { label: 'Streams', path: '/streams', icon: <Radio size={18} /> },
        { label: '404 Hosts', path: '/dead-hosts', icon: <Ban size={18} /> },
        { label: 'SSL Certificates', path: '/certificates', icon: <Shield size={18} /> },
        { label: 'Access Lists', path: '/access-lists', icon: <ShieldCheck size={18} /> },
        { label: 'Azure Auth', path: '/azure-auth', icon: <KeyRound size={18} /> },
        { label: 'Error Pages', path: '/custom-pages', icon: <FileText size={18} /> },
        { label: 'Uptime', path: '/uptime', icon: <Activity size={18} /> },
        { label: 'Traffic', path: '/traffic', icon: <Activity size={18} /> },
        { label: 'Bans', path: '/bans', icon: <Ban size={18} strokeWidth={2.2} /> },
        { label: 'Automation', path: '/automation', icon: <Zap size={18} /> },
      ]
    : [];

  const adminNav: NavItem[] = isAdmin
    ? [
        { label: 'Users', path: '/users', icon: <Users size={18} /> },
        { label: 'Roles', path: '/roles', icon: <Shield size={18} /> },
        { label: 'Teams', path: '/teams', icon: <Users size={18} /> },
        { label: 'Docker Engines', path: '/engines', icon: <Server size={18} /> },
        { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
      ]
    : [];

  const isActive = (path: string) =>
    path === '/'
      ? location.pathname === '/' || location.pathname.startsWith('/stack/')
      : location.pathname === path || location.pathname.startsWith(path + '/');

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // ── Collapsed mode (64 px) — icons only, never hides. ──────────
  if (collapsed) {
    const allItems = [...mainNav, ...stackNav, ...proxyNav, ...adminNav];
    return (
      <aside className="flex h-full w-16 shrink-0 flex-col bg-bg-secondary">
        <div className="flex h-12 shrink-0 items-center justify-center">
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsRight size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pt-2 space-y-1">
          {allItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              title={item.label}
              className={cn(
                'flex h-10 w-full items-center justify-center rounded-md transition-colors',
                isActive(item.path)
                  ? 'bg-accent/[0.12] text-accent'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.icon}
            </Link>
          ))}
        </nav>

        <div className="p-2 space-y-1">
          <Link
            to="/profile"
            title={cleanName}
            className={cn(
              'flex h-10 w-full items-center justify-center rounded-md transition-colors',
              location.pathname === '/profile'
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {user?.avatar ? (
              <img src={user.avatar} alt="" className="w-6 h-6 rounded-full object-cover" />
            ) : (
              <UserCircle size={18} />
            )}
          </Link>
          <button
            onClick={handleLogout}
            title="Sign out"
            className="flex h-10 w-full items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
    );
  }

  // ── Expanded mode (260 px) ─────────────────────────────────────────────────
  const filterNav = (items: NavItem[]) =>
    search
      ? items.filter(i => i.label.toLowerCase().includes(search.toLowerCase()))
      : items;

  const renderSection = (title: string | null, items: NavItem[]) => {
    const filtered = filterNav(items);
    if (filtered.length === 0) return null;
    return (
      <div className="space-y-0.5">
        {title && (
          <div className="px-3 pt-3 pb-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
            {title}
          </div>
        )}
        {filtered.map(item => (
          <NavLink key={item.path} item={item} active={isActive(item.path)} />
        ))}
      </div>
    );
  };

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col bg-bg-secondary">
      {/* Sb-head — collapse toggle right-aligned, no logo (lives in topbar). */}
      <div className="flex h-9 shrink-0 items-center justify-end px-3 pt-2">
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <ChevronsLeft size={15} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-2 pb-3">
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Body — scrollable nav */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {renderSection(null, mainNav)}
        {renderSection('Docker', stackNav)}
        {renderSection('Proxy', proxyNav)}
        {isAdmin && renderSection('Administration', adminNav)}
      </div>

      {/* Footer — user + logout */}
      <div className="border-t border-border p-2.5">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
            location.pathname === '/profile'
              ? 'bg-accent/10'
              : 'hover:bg-bg-hover',
          )}
        >
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
          ) : (
            <UserCircle size={20} className="shrink-0 text-text-secondary" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {cleanName}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {(user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username) ?? ''} · {user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          onClick={handleLogout}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <LogOut size={14} />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.path}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors',
        active
          ? 'bg-accent/[0.12] text-accent font-medium'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      {item.icon}
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  );
}
