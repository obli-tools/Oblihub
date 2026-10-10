import { useEffect, useState, useCallback } from 'react';
import { Bell, BellOff, Ban, Check } from 'lucide-react';
import { notificationsApi } from '@/api/notifications.api';
import type { NotificationChannel, NotificationBinding } from '@oblihub/shared';
import toast from 'react-hot-toast';

interface Props {
  scope: 'global' | 'stack';
  scopeId: number | null;
}

export function NotificationBindingsPanel({ scope, scopeId }: Props) {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [bindings, setBindings] = useState<NotificationBinding[]>([]);
  const [globalBindings, setGlobalBindings] = useState<NotificationBinding[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [chs, scopeBinds] = await Promise.all([
        notificationsApi.getChannels(),
        notificationsApi.getBindings(scope, scopeId),
      ]);
      setChannels(chs);
      setBindings(scopeBinds);
      // Load global bindings for inheritance display
      if (scope !== 'global') {
        const global = await notificationsApi.getBindings('global', null);
        setGlobalBindings(global);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [scope, scopeId]);

  useEffect(() => { load(); }, [load]);

  const bindChannel = async (channelId: number) => {
    try {
      await notificationsApi.createBinding(channelId, scope, scopeId, 'merge');
      toast.success('Channel bound');
      load();
    } catch { toast.error('Failed'); }
  };

  const excludeChannel = async (channelId: number) => {
    try {
      await notificationsApi.createBinding(channelId, scope, scopeId, 'exclude');
      toast.success('Channel excluded');
      load();
    } catch { toast.error('Failed'); }
  };

  const removeBinding = async (channelId: number) => {
    try {
      await notificationsApi.removeBinding(channelId, scope, scopeId);
      toast.success('Binding removed');
      load();
    } catch { toast.error('Failed'); }
  };

  if (loading) return <div className="text-xs text-text-muted">Loading channels...</div>;
  if (channels.length === 0) return <div className="text-xs text-text-muted">No notification channels configured</div>;

  return (
    <div className="space-y-1.5">
      {channels.map(ch => {
        const directBinding = bindings.find(b => b.channelId === ch.id);
        const isDirectBound = directBinding && directBinding.overrideMode !== 'exclude';
        const isDirectExclude = directBinding?.overrideMode === 'exclude';
        const isInherited = !directBinding && globalBindings.some(b => b.channelId === ch.id);

        let icon: React.ReactNode;
        let buttonLabel: string;
        let buttonAction: () => void;
        let buttonStyle: string;

        if (isDirectBound) {
          icon = <Bell size={12} className="text-accent" />;
          buttonLabel = 'Bound';
          buttonAction = () => removeBinding(ch.id);
          buttonStyle = 'border-accent bg-accent/10 text-accent';
        } else if (isDirectExclude) {
          icon = <Ban size={12} className="text-status-pending" />;
          buttonLabel = 'Excluded';
          buttonAction = () => removeBinding(ch.id);
          buttonStyle = 'border-status-pending bg-status-pending/10 text-status-pending';
        } else if (isInherited) {
          icon = <Check size={12} className="text-text-muted" />;
          buttonLabel = 'Unbind';
          buttonAction = () => excludeChannel(ch.id);
          buttonStyle = 'border-border text-text-muted hover:border-status-pending hover:text-status-pending';
        } else {
          icon = <BellOff size={12} className="text-text-muted" />;
          buttonLabel = 'Bind';
          buttonAction = () => bindChannel(ch.id);
          buttonStyle = 'border-border text-text-muted hover:border-accent hover:text-accent';
        }

        return (
          <div key={ch.id} className="flex items-center gap-2">
            {icon}
            <span className="text-xs text-text-primary flex-1">{ch.name}</span>
            <span className="text-[9px] text-text-muted">{ch.type}</span>
            {isInherited && <span className="text-[9px] px-1 py-0.5 rounded bg-bg-tertiary text-text-muted">Global</span>}
            <button onClick={buttonAction}
              className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${buttonStyle}`}>
              {buttonLabel}
            </button>
          </div>
        );
      })}
    </div>
  );
}
