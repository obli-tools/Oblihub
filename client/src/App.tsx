import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { systemApi } from '@/api/stacks.api';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StackDetailPage } from '@/pages/StackDetailPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ManagedStacksPage } from '@/pages/ManagedStacksPage';
import { StackEditorPage } from '@/pages/StackEditorPage';
import { ImagesPage } from '@/pages/ImagesPage';
import { NetworksPage } from '@/pages/NetworksPage';
import { VolumesPage } from '@/pages/VolumesPage';
import { ProxyHostsPage } from '@/pages/ProxyHostsPage';
import { AzureAuthPage } from '@/pages/AzureAuthPage';
import { AutomationPage } from '@/pages/AutomationPage';
import { TrafficPage } from '@/pages/TrafficPage';
import { TrafficHostPage } from '@/pages/TrafficHostPage';
import { BansPage } from '@/pages/BansPage';
import { CertificatesPage } from '@/pages/CertificatesPage';
import { RedirectionsPage } from '@/pages/RedirectionsPage';
import { StreamsPage } from '@/pages/StreamsPage';
import { DeadHostsPage } from '@/pages/DeadHostsPage';
import { AccessListsPage } from '@/pages/AccessListsPage';
import { CustomPagesPage } from '@/pages/CustomPagesPage';
import { UptimeMonitorsPage } from '@/pages/UptimeMonitorsPage';
import { AppStorePage } from '@/pages/AppStorePage';
import { UsersPage } from '@/pages/UsersPage';
import { EnginesPage } from '@/pages/EnginesPage';
import { RolesPage } from '@/pages/RolesPage';
import { TeamsPage } from '@/pages/TeamsPage';
import { ResourcesDashboardPage } from '@/pages/ResourcesDashboardPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isInitialized } = useAuthStore();
  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [allowStack, setAllowStack] = useState(false);
  const [allowNginx, setAllowNginx] = useState(false);

  useEffect(() => {
    systemApi.getFeatures()
      .then(f => { setAllowStack(f.allowStack); setAllowNginx(f.allowNginx); })
      .catch(() => {
        systemApi.getInfo()
          .then(info => { setAllowStack(info.allowStack); setAllowNginx(info.allowNginx); })
          .catch(() => {});
      });
  }, []);

  // Layout — topbar full-width, sidebar below it.
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar allowStack={allowStack} allowNginx={allowNginx} />
        <main className="flex-1 overflow-y-auto">
          {/* Keyed by path: routes reuse this layout instance, so without the key a caught error
              would stay on screen after navigating to another page. */}
          <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const { checkSession } = useAuthStore();
  useEffect(() => { checkSession(); }, []);

  return (
    <BrowserRouter>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'rgb(19 23 40)',
            color: 'rgb(240 244 252)',
            border: '1px solid rgb(42 48 72)',
          },
        }}
      />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<ProtectedRoute><AppLayout><DashboardPage /></AppLayout></ProtectedRoute>} />
        <Route path="/stack/:id" element={<ProtectedRoute><AppLayout><StackDetailPage /></AppLayout></ProtectedRoute>} />
        <Route path="/managed-stacks" element={<ProtectedRoute><AppLayout><ManagedStacksPage /></AppLayout></ProtectedRoute>} />
        <Route path="/stack-editor/:id" element={<ProtectedRoute><AppLayout><StackEditorPage /></AppLayout></ProtectedRoute>} />
        <Route path="/images" element={<ProtectedRoute><AppLayout><ImagesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/networks" element={<ProtectedRoute><AppLayout><NetworksPage /></AppLayout></ProtectedRoute>} />
        <Route path="/volumes" element={<ProtectedRoute><AppLayout><VolumesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/proxy-hosts" element={<ProtectedRoute><AppLayout><ProxyHostsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/azure-auth" element={<ProtectedRoute><AppLayout><AzureAuthPage /></AppLayout></ProtectedRoute>} />
        <Route path="/automation" element={<ProtectedRoute><AppLayout><AutomationPage /></AppLayout></ProtectedRoute>} />
        <Route path="/traffic" element={<ProtectedRoute><AppLayout><TrafficPage /></AppLayout></ProtectedRoute>} />
        <Route path="/traffic/host/:id" element={<ProtectedRoute><AppLayout><TrafficHostPage /></AppLayout></ProtectedRoute>} />
        <Route path="/bans" element={<ProtectedRoute><AppLayout><BansPage /></AppLayout></ProtectedRoute>} />
        <Route path="/redirections" element={<ProtectedRoute><AppLayout><RedirectionsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/streams" element={<ProtectedRoute><AppLayout><StreamsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/dead-hosts" element={<ProtectedRoute><AppLayout><DeadHostsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/certificates" element={<ProtectedRoute><AppLayout><CertificatesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/access-lists" element={<ProtectedRoute><AppLayout><AccessListsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/custom-pages" element={<ProtectedRoute><AppLayout><CustomPagesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/uptime" element={<ProtectedRoute><AppLayout><UptimeMonitorsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/app-store" element={<ProtectedRoute><AppLayout><AppStorePage /></AppLayout></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute><AppLayout><UsersPage /></AppLayout></ProtectedRoute>} />
        <Route path="/roles" element={<ProtectedRoute><AppLayout><RolesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/teams" element={<ProtectedRoute><AppLayout><TeamsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/engines" element={<ProtectedRoute><AppLayout><EnginesPage /></AppLayout></ProtectedRoute>} />
        <Route path="/resources" element={<ProtectedRoute><AppLayout><ResourcesDashboardPage /></AppLayout></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><AppLayout><SettingsPage /></AppLayout></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><AppLayout><ProfilePage /></AppLayout></ProtectedRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
