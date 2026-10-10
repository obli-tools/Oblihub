import { X, AlertTriangle, Server, Globe, Activity } from 'lucide-react';
import { useTrafficFilters, hasActiveFilters } from '@/store/trafficFilterStore';

/**
 * Active-filter bar shown under the header. Renders one chip per active filter with a click-to-
 * remove target. The whole bar collapses when there is nothing active — no vertical space
 * wasted on healthy pages.
 *
 * Each chip carries a small icon so the operator can tell at a glance which dimension is
 * scoping the view. `errorsOnly` is prominent (amber + AlertTriangle) because it changes the
 * meaning of every widget below.
 */
export function FilterBar({ hostDomainById }: { hostDomainById: Map<number, string> }) {
  const filters = useTrafficFilters();
  const { hostIds, countries, statusClasses, statusCodes, ips, uriPrefixes, errorsOnly } = filters;
  if (!hasActiveFilters(filters)) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 -mt-2 pb-2">
      <span className="text-[10px] text-text-muted uppercase tracking-wider mr-1">Filters:</span>

      {errorsOnly && (
        <Chip color="amber" icon={AlertTriangle} label="Errors only" onRemove={() => filters.setErrorsOnly(false)} />
      )}
      {hostIds.map(id => (
        <Chip key={`host-${id}`} color="accent" icon={Server}
          label={hostDomainById.get(id) || `Host #${id}`}
          onRemove={() => filters.toggleHost(id)} />
      ))}
      {countries.map(c => (
        <Chip key={`country-${c}`} color="accent" icon={Globe} label={c} onRemove={() => filters.toggleCountry(c)} />
      ))}
      {statusClasses.map(cls => (
        <Chip key={`class-${cls}`} color={cls === '5xx' ? 'red' : cls === '4xx' ? 'amber' : 'accent'}
          label={cls} onRemove={() => filters.toggleStatusClass(cls)} />
      ))}
      {statusCodes.map(code => (
        <Chip key={`code-${code}`} color={code >= 500 ? 'red' : code >= 400 ? 'amber' : 'accent'}
          label={String(code)} onRemove={() => filters.toggleStatusCode(code)} />
      ))}
      {ips.map(ip => (
        <Chip key={`ip-${ip}`} color="accent" icon={Globe} label={ip} onRemove={() => filters.toggleIp(ip)} />
      ))}
      {uriPrefixes.map(u => (
        <Chip key={`uri-${u}`} color="accent" icon={Activity} label={u} onRemove={() => filters.toggleUri(u)} />
      ))}

      <button
        onClick={() => filters.clear()}
        className="text-[10px] text-text-muted hover:text-text-primary underline ml-1"
      >
        Clear all
      </button>
    </div>
  );
}

function Chip({ color, icon: Icon, label, onRemove }: {
  color: 'accent' | 'amber' | 'red';
  icon?: typeof Server;
  label: string;
  onRemove: () => void;
}) {
  const colorCls = {
    accent: 'bg-accent/10 text-accent border-accent/30',
    amber: 'bg-status-pending/10 text-status-pending border-status-pending/30',
    red: 'bg-status-down/10 text-status-down border-status-down/30',
  }[color];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${colorCls}`}>
      {Icon && <Icon size={9} />}
      {label}
      <button onClick={onRemove} className="hover:text-text-primary" aria-label={`Remove ${label} filter`}>
        <X size={9} />
      </button>
    </span>
  );
}
