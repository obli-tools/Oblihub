import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Activity, ChevronLeft, Copy, AlertTriangle, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { LineChart, formatBytes, formatShortNumber } from '@/components/LineChart';
import { ErrorsChart } from '@/components/traffic/ErrorsChart';
import { trafficApi, type TopIp, type TopUri, type TrafficSeries, type ErrorSummary, type SampleRow } from '@/api/traffic.api';
import { proxyApi } from '@/api/proxy.api';
import type { ProxyHost } from '@oblihub/shared';
import { useTrafficFilters } from '@/store/trafficFilterStore';

/**
 * Per-host drilldown page (replaces the old modal).
 *
 * Route: /traffic/host/:id. Shares the same URL-driven filter store as /traffic — deep-linkable,
 * back button restores the previous overview state, browser tabs can hold multiple hosts open
 * side-by-side during an incident.
 *
 * Layout:
 *   - Header: breadcrumb back to /traffic + copy-link + host status chips
 *   - Overview tab: request timeline, bandwidth+latency, top IPs, top URIs (host-scoped)
 *   - Errors tab: per-code breakdown, top erroring URIs/IPs, recent error samples
 *   - Slow tab: slow-request samples table
 */
export function TrafficHostPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const hostId = idParam ? parseInt(idParam, 10) : 0;
  const navigate = useNavigate();
  const filters = useTrafficFilters();
  const [host, setHost] = useState<ProxyHost | null>(null);
  const [tab, setTab] = useState<'overview' | 'errors' | 'slow'>('overview');
  const [series, setSeries] = useState<TrafficSeries | null>(null);
  const [topIps, setTopIps] = useState<TopIp[]>([]);
  const [topUris, setTopUris] = useState<TopUri[]>([]);
  const [errSummary, setErrSummary] = useState<ErrorSummary | null>(null);
  const [errSamples, setErrSamples] = useState<SampleRow[]>([]);
  const [slowSamples, setSlowSamples] = useState<SampleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { filters.hydrateFromQuery(window.location.search); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    proxyApi.listHosts().then(hosts => setHost(hosts.find(h => h.id === hostId) || null)).catch(() => {});
  }, [hostId]);

  useEffect(() => {
    if (!hostId) return;
    setLoading(true);
    Promise.all([
      trafficApi.hostTimeSeries(hostId, filters.range),
      trafficApi.hostTopIps(hostId, filters.range),
      trafficApi.hostTopUris(hostId, filters.range),
      trafficApi.hostErrorSummary(hostId, filters.range),
      trafficApi.hostErrorSamples(hostId, 100),
      trafficApi.hostSlowSamples(hostId, 100),
    ]).then(([s, ips, uris, err, errS, slow]) => {
      setSeries(s); setTopIps(ips); setTopUris(uris);
      setErrSummary(err); setErrSamples(errS); setSlowSamples(slow);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [hostId, filters.range]);

  const totalErrors = (errSummary?.total4xx || 0) + (errSummary?.total5xx || 0);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied');
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Back">
            <ChevronLeft size={16} />
          </button>
          <Link to="/traffic" className="text-[11px] text-text-muted hover:text-text-primary">← All hosts</Link>
          <h1 className="text-lg font-semibold text-text-primary truncate flex items-center gap-2">
            <Activity size={18} /> {host?.domainNames[0] || `Host #${hostId}`}
          </h1>
          {totalErrors > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down font-mono">
              {formatShortNumber(totalErrors)} errors
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <RangeSwitcher />
          <button onClick={copyLink} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Copy link">
            <Copy size={14} />
          </button>
        </div>
      </div>

      <div className="flex border-b border-border">
        <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={Activity} label="Overview" />
        <TabBtn active={tab === 'errors'} onClick={() => setTab('errors')} icon={AlertTriangle}
          label={`Errors${totalErrors > 0 ? ` (${formatShortNumber(totalErrors)})` : ''}`} />
        <TabBtn active={tab === 'slow'} onClick={() => setTab('slow')} icon={Zap} label="Slow requests" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : tab === 'overview' ? (
        <OverviewTab series={series} topIps={topIps} topUris={topUris} />
      ) : tab === 'errors' ? (
        <ErrorsTab series={series} summary={errSummary} samples={errSamples} />
      ) : (
        <SlowTab samples={slowSamples} />
      )}
    </div>
  );
}

function RangeSwitcher() {
  const range = useTrafficFilters(s => s.range);
  const setRange = useTrafficFilters(s => s.setRange);
  const RANGES = ['1h', '6h', '24h', '7d', '30d', '90d'] as const;
  return (
    <div className="flex gap-0.5 rounded-lg border border-border bg-bg-tertiary p-0.5">
      {RANGES.map(r => (
        <button key={r} onClick={() => setRange(r)}
          className={`px-2.5 py-1 text-xs rounded ${range === r ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}>
          {r}
        </button>
      ))}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Activity; label: string }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${
        active ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
      }`}>
      <Icon size={12} /> {label}
    </button>
  );
}

// ── Overview tab ──

function OverviewTab({ series, topIps, topUris }: { series: TrafficSeries | null; topIps: TopIp[]; topUris: TopUri[] }) {
  const points = series?.points || [];
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h2 className="text-sm font-medium text-text-primary mb-2">Requests over time</h2>
          <LineChart labels={labels} yLabel="req / bucket"
            series={[
              { name: '2xx', color: '#22c55e', values: points.map(p => p.status2xx) },
              { name: '3xx', color: '#4a9eff', values: points.map(p => p.status3xx) },
              { name: '4xx', color: '#f59e0b', values: points.map(p => p.status4xx) },
              { name: '5xx', color: '#ef4444', values: points.map(p => p.status5xx) },
            ]} />
        </div>
        <div>
          <h2 className="text-sm font-medium text-text-primary mb-2">Bandwidth &amp; latency</h2>
          <LineChart labels={labels} yLabel="bytes / ms"
            series={[
              { name: 'Bytes out', color: '#22c55e', values: points.map(p => p.bytesOut), format: formatBytes },
              { name: 'p95 edge (ms)', color: '#f59e0b', values: points.map(p => p.p95EdgeMs) },
              { name: 'p95 upstream (ms)', color: '#a855f7', values: points.map(p => p.p95UpstreamMs) },
            ]} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopIpsCard title="Top source IPs" ips={topIps} />
        <TopUrisCard title="Top URIs" uris={topUris} />
      </div>
    </>
  );
}

// ── Errors tab ──

function ErrorsTab({ series, summary, samples }: { series: TrafficSeries | null; summary: ErrorSummary | null; samples: SampleRow[] }) {
  const points = series?.points || [];
  const codesOrdered = ['401', '403', '404', '429', '499', '500', '502', '503', '504'];
  return (
    <div className="space-y-4">
      {points.length > 0 && (points.some(p => p.status4xx + p.status5xx > 0) ? (
        <div>
          <h2 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
            <AlertTriangle size={14} className="text-status-down" /> Errors over time
          </h2>
          <ErrorsChart points={points} />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-tertiary/40 p-8 text-center text-text-muted text-xs">
          No errors in the current range. 🎉
        </div>
      ))}

      {summary && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Per status code</h3>
            <div className="space-y-1.5">
              {codesOrdered.map(code => {
                const n = summary.perCode[code] || 0;
                if (n === 0) return null;
                const cls = parseInt(code, 10) >= 500 ? 'text-status-down' : 'text-status-pending';
                const pct = summary.totalRequests ? (n / summary.totalRequests) * 100 : 0;
                return (
                  <div key={code} className="flex items-center gap-3 text-xs">
                    <span className={`font-mono w-10 ${cls}`}>{code}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                      <div className="h-full bg-status-down" style={{ width: `${(n / (summary.total4xx + summary.total5xx || 1)) * 100}%` }} />
                    </div>
                    <span className="font-mono text-text-primary w-16 text-right">{formatShortNumber(n)}</span>
                    <span className="text-[10px] text-text-muted w-12 text-right">{pct.toFixed(2)}%</span>
                  </div>
                );
              })}
              {Object.values(summary.perCode).every(v => v === 0) && (
                <div className="text-[11px] text-text-muted italic">No known error codes in the current range.</div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Top erroring URIs</h3>
            <div className="text-[10px] uppercase tracking-wider text-status-pending mb-1">4xx</div>
            <div className="space-y-1 mb-3">
              {summary.topErrorUris['4xx'].map(u => (
                <div key={`4-${u.uri}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-text-primary truncate flex-1">{u.uri}</span>
                  <span className="font-mono text-text-muted">{formatShortNumber(u.reqCount)}</span>
                </div>
              ))}
              {summary.topErrorUris['4xx'].length === 0 && <div className="text-[11px] text-text-muted italic">None</div>}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-status-down mb-1">5xx</div>
            <div className="space-y-1">
              {summary.topErrorUris['5xx'].map(u => (
                <div key={`5-${u.uri}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-text-primary truncate flex-1">{u.uri}</span>
                  <span className="font-mono text-text-muted">{formatShortNumber(u.reqCount)}</span>
                </div>
              ))}
              {summary.topErrorUris['5xx'].length === 0 && <div className="text-[11px] text-text-muted italic">None</div>}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-bg-secondary p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Recent error samples (last {samples.length})</h3>
        {samples.length === 0 ? (
          <div className="text-[11px] text-text-muted italic text-center py-4">No error samples captured yet.</div>
        ) : (
          <SampleTable rows={samples} />
        )}
      </div>
    </div>
  );
}

// ── Slow tab ──

function SlowTab({ samples }: { samples: SampleRow[] }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
        <Zap size={12} /> Slowest requests
      </h3>
      {samples.length === 0 ? (
        <div className="text-[11px] text-text-muted italic text-center py-4">No slow-request samples captured yet.</div>
      ) : (
        <SampleTable rows={samples} highlight="latency" />
      )}
    </div>
  );
}

// ── Sample table ──

function SampleTable({ rows, highlight }: { rows: SampleRow[]; highlight?: 'latency' | 'status' }) {
  const filters = useTrafficFilters();
  return (
    <div className="overflow-auto max-h-[600px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-bg-secondary z-10">
          <tr className="text-[10px] text-text-muted uppercase tracking-wider text-left">
            <th className="py-1.5 pr-2 font-normal">Time</th>
            <th className="py-1.5 pr-2 font-normal">Status</th>
            <th className="py-1.5 pr-2 font-normal">Method</th>
            <th className="py-1.5 pr-2 font-normal">URI</th>
            <th className="py-1.5 pr-2 font-normal">IP</th>
            <th className="py-1.5 pr-2 font-normal text-right">Latency</th>
            <th className="py-1.5 pr-2 font-normal text-right">Upstream</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-border/40 hover:bg-bg-tertiary/50">
              <td className="py-1 pr-2 font-mono text-text-muted whitespace-nowrap">{new Date(r.ts).toLocaleTimeString()}</td>
              <td className="py-1 pr-2">
                <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded ${
                  r.status >= 500 ? 'bg-status-down/10 text-status-down' :
                  r.status >= 400 ? 'bg-status-pending/10 text-status-pending' :
                  'bg-text-muted/10 text-text-muted'
                }`}>{r.status}</span>
              </td>
              <td className="py-1 pr-2 font-mono text-text-secondary">{r.method || '-'}</td>
              <td className="py-1 pr-2 max-w-[300px]">
                <button onClick={() => filters.toggleUri(r.uri)} className="font-mono text-text-primary truncate hover:text-accent text-left w-full">
                  {r.uri}
                </button>
              </td>
              <td className="py-1 pr-2">
                <button onClick={() => filters.toggleIp(r.ip)} className="font-mono text-text-primary hover:text-accent">
                  {r.countryCode && <span className="mr-1">{countryFlag(r.countryCode)}</span>}
                  {r.ip}
                </button>
              </td>
              <td className={`py-1 pr-2 font-mono text-right ${highlight === 'latency' ? 'text-status-pending' : 'text-text-primary'}`}>{r.latencyMs}ms</td>
              <td className="py-1 pr-2 font-mono text-right text-text-muted">{r.upstreamMs != null ? `${r.upstreamMs}ms` : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopIpsCard({ title, ips }: { title: string; ips: TopIp[] }) {
  const filters = useTrafficFilters();
  const maxReq = Math.max(1, ...ips.map(i => i.reqCount));
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-1 max-h-72 overflow-auto">
        {ips.map(ip => (
          <button key={ip.ip} onClick={() => filters.toggleIp(ip.ip)}
            className="w-full flex items-center gap-3 text-xs p-2 rounded hover:bg-bg-tertiary text-left">
            {ip.geo && <span>{countryFlag(ip.geo.countryCode || '')}</span>}
            <div className="flex-1 min-w-0">
              <div className="font-mono text-text-primary truncate">{ip.ip}</div>
              {ip.geo && (<div className="text-[10px] text-text-muted truncate">{[ip.geo.city, ip.geo.countryName, ip.geo.org].filter(Boolean).join(' · ')}</div>)}
              <div className="mt-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${(ip.reqCount / maxReq) * 100}%` }} />
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono text-text-primary">{formatShortNumber(ip.reqCount)}</div>
              <div className="text-[10px] text-text-muted">{formatBytes(ip.bytesOut)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TopUrisCard({ title, uris }: { title: string; uris: TopUri[] }) {
  const filters = useTrafficFilters();
  const maxReq = useMemo(() => Math.max(1, ...uris.map(u => u.reqCount)), [uris]);
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">{title}</h3>
      <div className="space-y-1 max-h-72 overflow-auto">
        {uris.map(u => (
          <button key={u.uri} onClick={() => filters.toggleUri(u.uri)}
            className="w-full flex items-center gap-3 text-xs p-2 rounded hover:bg-bg-tertiary text-left">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-text-primary truncate">{u.uri}</div>
              <div className="mt-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${(u.reqCount / maxReq) * 100}%` }} />
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono text-text-primary">{formatShortNumber(u.reqCount)}</div>
              <div className="text-[10px] text-text-muted">{u.avgLatencyMs}ms</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}
