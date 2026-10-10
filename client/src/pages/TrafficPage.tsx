import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, TrendingUp, AlertTriangle, Globe, RefreshCw, Server as ServerIcon, Link as LinkIcon, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { LineChart, formatBytes, formatShortNumber } from '@/components/LineChart';
import { WorldMap } from '@/components/WorldMap';
import { StatusDonut } from '@/components/StatusDonut';
import { FilterBar } from '@/components/traffic/FilterBar';
import { StatCardDelta } from '@/components/traffic/StatCardDelta';
import { ErrorsChart } from '@/components/traffic/ErrorsChart';
import { trafficApi, type TopIp, type TopUri, type HostSummary, type GeoCountry, type TrafficSeries, type PercentileSummary } from '@/api/traffic.api';
import { proxyApi } from '@/api/proxy.api';
import type { ProxyHost } from '@oblihub/shared';
import { useTrafficFilters, type TrafficRange } from '@/store/trafficFilterStore';

const RANGES: { key: TrafficRange; label: string }[] = [
  { key: '1h', label: '1h' },
  { key: '6h', label: '6h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];

/**
 * Traffic dashboard.
 *
 * All widgets read/write a shared filter store (Zustand). Any list widget is clickable and
 * toggles a chip in the FilterBar; alt+click removes a chip (widgets pass ev.altKey through).
 * The whole state is URL-encoded so any view is deep-linkable — the "Copy link" button in the
 * header captures the current URL to the clipboard.
 *
 * Keyboard shortcuts: r = refresh, 1..6 = range, / = focus search-not-implemented, esc = clear
 * chips, ? = help toast.
 */
export function TrafficPage() {
  const navigate = useNavigate();
  const filters = useTrafficFilters();
  const [series, setSeries] = useState<TrafficSeries | null>(null);
  const [hosts, setHosts] = useState<ProxyHost[]>([]);
  const [summary, setSummary] = useState<HostSummary[]>([]);
  const [geo, setGeo] = useState<GeoCountry[]>([]);
  const [topIps, setTopIps] = useState<TopIp[]>([]);
  const [topUris, setTopUris] = useState<TopUri[]>([]);
  const [percentiles, setPercentiles] = useState<PercentileSummary | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Hydrate filters from URL on first mount so /traffic?hosts=...&errorsOnly=1 reproduces state
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    filters.hydrateFromQuery(window.location.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push store → URL so any change round-trips into a shareable link (replace, no history spam)
  useEffect(() => {
    const qs = filters.toQueryString();
    const next = qs ? `?${qs}` : '';
    if (window.location.search !== next) window.history.replaceState(null, '', `${window.location.pathname}${next}`);
  }, [filters]);

  const load = async () => {
    try {
      const [s, sm, g, ips, uris, h, pct] = await Promise.all([
        trafficApi.teamCumul(filters),
        trafficApi.summary(filters),
        trafficApi.geo(filters),
        trafficApi.topIpsGlobal(filters),
        trafficApi.topUrisGlobal(filters),
        proxyApi.listHosts().catch(() => []),
        trafficApi.percentiles(filters),
      ]);
      setSeries(s); setSummary(sm); setGeo(g); setTopIps(ips); setTopUris(uris); setHosts(h); setPercentiles(pct);
      setLastFetchedAt(new Date());
    } catch { /* silent — page shows empty state */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filters.range, filters.errorsOnly, filters.statusClasses.join(','), filters.hostIds.join(','), filters.countries.join(','), filters.ips.join(','), filters.uriPrefixes.join(',')]);

  // "Updated Xs ago" ticker
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'r') { e.preventDefault(); load(); }
      else if (e.key === 'Escape') { e.preventDefault(); filters.clear(); }
      else if (e.key === '?') { e.preventDefault(); toast('r=refresh · 1..6=range · esc=clear filters', { duration: 4000 }); }
      else if (/^[1-6]$/.test(e.key)) { e.preventDefault(); filters.setRange(RANGES[parseInt(e.key, 10) - 1].key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const hostDomainById = useMemo(() => {
    const m = new Map<number, string>();
    for (const h of hosts) m.set(h.id, h.domainNames[0] || `#${h.id}`);
    return m;
  }, [hosts]);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const secondsAgo = lastFetchedAt ? Math.floor((nowTick - lastFetchedAt.getTime()) / 1000) : null;

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied to clipboard');
  };

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <Activity size={20} /> Traffic
        </h1>
        <div className="flex items-center gap-2">
          {lastFetchedAt && (
            <span className="text-[10px] text-text-muted font-mono">
              Updated {secondsAgo == null ? '' : secondsAgo < 60 ? `${secondsAgo}s` : `${Math.floor(secondsAgo / 60)}m`} ago
            </span>
          )}
          <RangeSwitcher />
          <button onClick={load} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Refresh (r)">
            <RefreshCw size={14} />
          </button>
          <button onClick={copyLink} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover" title="Copy link to this view">
            <Copy size={14} />
          </button>
        </div>
      </div>

      {/* Timezone / range subtitle — clarifies rolling-window semantics */}
      <div className="-mt-3 text-[10px] text-text-muted">
        Last {filters.range} ending now · {timeZone}
      </div>

      <FilterBar hostDomainById={hostDomainById} />

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      ) : (
        <>
          <StatCards series={series} percentiles={percentiles} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h2 className="text-sm font-medium text-text-primary mb-2">Requests over time</h2>
              <RotChart series={series} />
            </div>
            <div>
              <h2 className="text-sm font-medium text-text-primary mb-2">Bandwidth &amp; latency (p95)</h2>
              <BandwidthLatencyChart series={series} />
            </div>
          </div>

          {/* Dedicated Errors chart — only when there ARE errors, so we don't waste vertical space */}
          {series && series.points.some(p => p.status4xx + p.status5xx > 0) && (
            <div>
              <h2 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
                <AlertTriangle size={14} className="text-status-down" /> Errors over time
              </h2>
              <ErrorsChart points={series.points} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-bg-secondary p-4">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Status distribution</h3>
              <StatusDonutFromSeries series={series} />
            </div>
            <HostsTable summary={summary} selectedId={selectedHostId} onSelect={setSelectedHostId} />
            <SelectedHostChart
              host={hosts.find(h => h.id === selectedHostId) || null}
              range={filters.range}
              onDetails={() => selectedHostId != null && navigate(`/traffic/host/${selectedHostId}?${filters.toQueryString()}`)}
              onClear={() => setSelectedHostId(null)}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <h2 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
                <Globe size={14} /> Requests by geography
              </h2>
              <WorldMap countries={geo} height={360} />
            </div>
            <GeoWidget geo={geo} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopIpsWidget ips={topIps} />
            <TopUrisWidget uris={topUris} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Header helpers ──

function RangeSwitcher() {
  const range = useTrafficFilters(s => s.range);
  const setRange = useTrafficFilters(s => s.setRange);
  return (
    <div className="flex gap-0.5 rounded-lg border border-border bg-bg-tertiary p-0.5">
      {RANGES.map(r => (
        <button key={r.key} onClick={() => setRange(r.key)}
          className={`px-2.5 py-1 text-xs rounded ${range === r.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ── Stat cards with delta vs previous ──

function StatCards({ series, percentiles }: { series: TrafficSeries | null; percentiles: PercentileSummary | null }) {
  const stats = useMemo(() => {
    const points = series?.points || [];
    const total = points.reduce((acc, p) => ({
      req: acc.req + p.reqCount,
      out: acc.out + p.bytesOut,
      errs: acc.errs + p.status4xx + p.status5xx,
    }), { req: 0, out: 0, errs: 0 });
    return {
      reqCount: total.req,
      bytesOut: total.out,
      errRate: total.req ? total.errs / total.req : 0,
      reqSpark: points.map(p => p.reqCount),
      bwSpark: points.map(p => p.bytesOut),
      errSpark: points.map(p => p.reqCount ? (p.status4xx + p.status5xx) / p.reqCount * 100 : 0),
      p95Spark: points.map(p => p.p95EdgeMs),
    };
  }, [series]);

  const deltaPct = (curr: number, prev: number): string | null => {
    if (prev === 0 && curr === 0) return null;
    if (prev === 0) return '+∞';
    const d = ((curr - prev) / prev) * 100;
    if (Math.abs(d) < 0.5) return null;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
  };
  const reqDelta = percentiles ? deltaPct(percentiles.current.reqCount, percentiles.previous.reqCount) : null;
  const errDelta = percentiles ? deltaPct(percentiles.current.errorRate * 100, percentiles.previous.errorRate * 100) : null;
  const p95Delta = percentiles ? deltaPct(percentiles.current.edge.p95, percentiles.previous.edge.p95) : null;

  const p95 = percentiles?.current.edge.p95 ?? 0;
  const p95Upstream = percentiles?.current.upstream.p95 ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCardDelta label="Requests" value={formatShortNumber(stats.reqCount)} icon={TrendingUp}
        spark={stats.reqSpark} sparkColor="#4a9eff"
        deltaText={reqDelta} deltaKind={reqDelta ? (reqDelta.startsWith('+') ? 'neutral' : 'neutral') : null} />
      <StatCardDelta label="Bandwidth" value={formatBytes(stats.bytesOut)} icon={Activity}
        spark={stats.bwSpark} sparkColor="#22c55e" deltaText={null} deltaKind={null} />
      <StatCardDelta label="Error rate" value={`${(stats.errRate * 100).toFixed(2)}%`} icon={AlertTriangle}
        spark={stats.errSpark} sparkColor="#ef4444"
        deltaText={errDelta} deltaKind={errDelta ? (errDelta.startsWith('+') ? 'bad' : 'good') : null} />
      <StatCardDelta
        label={`p95 latency${p95Upstream > 0 ? ` (up: ${p95Upstream}ms)` : ''}`}
        value={`${p95}ms`}
        icon={Activity}
        spark={stats.p95Spark}
        sparkColor="#f59e0b"
        deltaText={p95Delta}
        deltaKind={p95Delta ? (p95Delta.startsWith('+') ? 'bad' : 'good') : null}
      />
    </div>
  );
}

// ── Charts ──

function RotChart({ series }: { series: TrafficSeries | null }) {
  const points = series?.points || [];
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <LineChart labels={labels} yLabel="req / bucket" height={200}
      series={[
        { name: '2xx', color: '#22c55e', values: points.map(p => p.status2xx) },
        { name: '3xx', color: '#4a9eff', values: points.map(p => p.status3xx) },
        { name: '4xx', color: '#f59e0b', values: points.map(p => p.status4xx) },
        { name: '5xx', color: '#ef4444', values: points.map(p => p.status5xx) },
      ]}
    />
  );
}

function BandwidthLatencyChart({ series }: { series: TrafficSeries | null }) {
  const points = series?.points || [];
  const labels = points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return (
    <LineChart labels={labels} yLabel="bytes / ms" height={200}
      series={[
        { name: 'Bytes out', color: '#22c55e', values: points.map(p => p.bytesOut), format: formatBytes },
        { name: 'p95 edge (ms)', color: '#f59e0b', values: points.map(p => p.p95EdgeMs) },
        { name: 'p95 upstream (ms)', color: '#a855f7', values: points.map(p => p.p95UpstreamMs) },
      ]}
    />
  );
}

function StatusDonutFromSeries({ series }: { series: TrafficSeries | null }) {
  const totals = useMemo(() => {
    const p = series?.points || [];
    return p.reduce((a, x) => ({
      s2xx: a.s2xx + x.status2xx, s3xx: a.s3xx + x.status3xx,
      s4xx: a.s4xx + x.status4xx, s5xx: a.s5xx + x.status5xx,
    }), { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 });
  }, [series]);
  return <StatusDonut {...totals} />;
}

// ── Row 3 ──

function HostsTable({ summary, selectedId, onSelect }: {
  summary: HostSummary[]; selectedId: number | null; onSelect: (id: number) => void;
}) {
  const maxReq = Math.max(1, ...summary.map(s => s.reqCount));
  const filters = useTrafficFilters();
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1 flex items-center gap-2">
        <ServerIcon size={12} /> Top proxy hosts <span className="text-text-muted normal-case font-normal">— {filters.range}</span>
      </h3>
      <p className="text-[10px] text-text-muted mb-3">Click a row to focus the chart on the right · click an error chip to filter the whole page</p>
      {summary.length === 0 ? (
        <EmptyState title="No hosts with traffic in this range" hint="Traffic will appear here once your proxy hosts receive requests." />
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-auto">
          {summary.map(s => {
            const active = s.proxyHostId === selectedId;
            return (
              <div key={s.proxyHostId}
                onClick={() => onSelect(s.proxyHostId)}
                className={`w-full flex items-center gap-3 p-2 rounded text-xs cursor-pointer transition-colors ${
                  active ? 'bg-accent/10 ring-1 ring-accent/40' : 'hover:bg-bg-tertiary'
                }`}>
                <div className="flex-1 min-w-0">
                  <div className={`font-mono truncate ${active ? 'text-accent' : 'text-text-primary'}`}>{s.domain}</div>
                  <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(s.reqCount / maxReq) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 min-w-[70px]">
                  <div className="font-mono text-text-primary">{formatShortNumber(s.reqCount)}</div>
                  <div className="text-[10px] text-text-muted">{formatBytes(s.bytesOut)}</div>
                </div>
                <div className="flex flex-col gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
                  {s.errorCount4xx > 0 && (
                    <button
                      onClick={() => { onSelect(s.proxyHostId); filters.toggleStatusClass('4xx'); }}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-status-pending/10 text-status-pending hover:bg-status-pending/20"
                      title="Filter page to 4xx errors on this host"
                    >
                      4xx: {formatShortNumber(s.errorCount4xx)}
                    </button>
                  )}
                  {s.errorCount5xx > 0 && (
                    <button
                      onClick={() => { onSelect(s.proxyHostId); filters.toggleStatusClass('5xx'); }}
                      className="text-[9px] px-1.5 py-0.5 rounded bg-status-down/10 text-status-down hover:bg-status-down/20"
                      title="Filter page to 5xx errors on this host"
                    >
                      5xx: {formatShortNumber(s.errorCount5xx)}
                    </button>
                  )}
                </div>
                <ChevronRight size={12} className="text-text-muted shrink-0" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectedHostChart({ host, range, onDetails, onClear }: {
  host: ProxyHost | null; range: TrafficRange; onDetails: () => void; onClear: () => void;
}) {
  const [series, setSeries] = useState<TrafficSeries | null>(null);
  useEffect(() => {
    if (!host) { setSeries(null); return; }
    trafficApi.hostTimeSeries(host.id, range).then(setSeries).catch(() => setSeries(null));
  }, [host, range]);
  return (
    <div className={`rounded-xl border bg-bg-secondary p-4 flex flex-col ${host ? 'border-accent/40' : 'border-border'}`}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider truncate">
          {host ? <>Showing: <span className="text-accent">{host.domainNames[0]}</span></> : 'Selected host'}
        </h3>
        {host && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onDetails}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20"
              title="Open full drilldown">
              <ExternalLink size={10} /> Details
            </button>
            <button onClick={onClear} className="text-[10px] text-text-muted hover:text-text-primary px-1.5">✕</button>
          </div>
        )}
      </div>
      {!host ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-muted text-center px-4">
          Click a proxy host on the left to see its request timeline here.
        </div>
      ) : !series || series.points.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-muted">No data in this range</div>
      ) : (
        <LineChart
          labels={series.points.map(p => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
          series={[
            { name: 'Requests', color: '#4a9eff', values: series.points.map(p => p.reqCount) },
            { name: 'p95 latency (ms)', color: '#f59e0b', values: series.points.map(p => p.p95EdgeMs) },
          ]}
          height={200}
        />
      )}
    </div>
  );
}

// ── Row 4/5 ──

function GeoWidget({ geo }: { geo: GeoCountry[] }) {
  const filters = useTrafficFilters();
  const total = geo.reduce((a, g) => a + g.reqCount, 0) || 1;
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
        <Globe size={12} /> Requests by country
      </h3>
      {geo.length === 0 ? (
        <EmptyState title="No geo data yet" hint="Either no traffic in this range or all IPs are private/local." />
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-auto">
          {geo.map(g => {
            const active = filters.countries.includes(g.code);
            return (
              <button key={g.code} onClick={() => filters.toggleCountry(g.code)}
                className={`w-full flex items-center gap-3 p-2 rounded text-xs cursor-pointer transition-colors ${
                  active ? 'bg-accent/10 ring-1 ring-accent/40' : 'hover:bg-bg-tertiary'
                }`}>
                <span className="text-lg">{countryFlag(g.code)}</span>
                <div className="flex-1 min-w-0">
                  <div className={active ? 'text-accent' : 'text-text-primary'}>{g.name}</div>
                  <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(g.reqCount / total) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 min-w-[60px]">
                  <div className="font-mono text-text-primary">{formatShortNumber(g.reqCount)}</div>
                  <div className="text-[10px] text-text-muted">{((g.reqCount / total) * 100).toFixed(1)}%</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TopIpsWidget({ ips }: { ips: TopIp[] }) {
  const filters = useTrafficFilters();
  const maxReq = Math.max(1, ...ips.map(i => i.reqCount));
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
        <Globe size={12} /> Top source IPs {filters.errorsOnly && <span className="text-status-down">(errors only)</span>}
      </h3>
      {ips.length === 0 ? (
        <EmptyState title="No IPs recorded yet" hint="Public IP hits from your proxy hosts will appear here." />
      ) : (
        <div className="space-y-1.5 max-h-96 overflow-auto">
          {ips.map(ip => {
            const active = filters.ips.includes(ip.ip);
            return (
              <button key={ip.ip} onClick={() => filters.toggleIp(ip.ip)}
                className={`w-full flex items-center gap-3 p-2 rounded text-xs cursor-pointer transition-colors ${
                  active ? 'bg-accent/10 ring-1 ring-accent/40' : 'hover:bg-bg-tertiary'
                }`}>
                {ip.geo && <span className="text-base flex-shrink-0">{countryFlag(ip.geo.countryCode || '')}</span>}
                <div className="flex-1 min-w-0">
                  <div className={`font-mono truncate ${active ? 'text-accent' : 'text-text-primary'}`}>{ip.ip}</div>
                  {ip.geo && (
                    <div className="text-[10px] text-text-muted truncate">{[ip.geo.city, ip.geo.countryName, ip.geo.org].filter(Boolean).join(' · ')}</div>
                  )}
                  <div className="mt-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(ip.reqCount / maxReq) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 min-w-[70px]">
                  <div className="font-mono text-text-primary">{formatShortNumber(ip.reqCount)}</div>
                  <div className="text-[10px] text-text-muted">{formatBytes(ip.bytesOut)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TopUrisWidget({ uris }: { uris: TopUri[] }) {
  const filters = useTrafficFilters();
  const maxReq = Math.max(1, ...uris.map(u => u.reqCount));
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
        <LinkIcon size={12} /> Top URIs {filters.errorsOnly && <span className="text-status-down">(errors only)</span>}
      </h3>
      {uris.length === 0 ? (
        <EmptyState title="No URIs recorded yet" hint="Once your hosts serve requests, the busiest paths show up here." />
      ) : (
        <div className="space-y-1.5 max-h-96 overflow-auto">
          {uris.map(u => {
            const active = filters.uriPrefixes.includes(u.uri);
            return (
              <button key={u.uri} onClick={() => filters.toggleUri(u.uri)}
                className={`w-full flex items-center gap-3 p-2 rounded text-xs cursor-pointer transition-colors ${
                  active ? 'bg-accent/10 ring-1 ring-accent/40' : 'hover:bg-bg-tertiary'
                }`}>
                <div className="flex-1 min-w-0">
                  <div className={`font-mono truncate ${active ? 'text-accent' : 'text-text-primary'}`}>{u.uri}</div>
                  <div className="mt-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(u.reqCount / maxReq) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 min-w-[80px]">
                  <div className="font-mono text-text-primary">{formatShortNumber(u.reqCount)}</div>
                  <div className="text-[10px] text-text-muted">{u.avgLatencyMs}ms</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="text-xs text-text-muted text-center py-8 px-3">
      <div className="text-text-secondary font-medium mb-1">{title}</div>
      <div className="text-[11px]">{hint}</div>
    </div>
  );
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}
