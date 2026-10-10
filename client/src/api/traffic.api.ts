import apiClient from './client';
import type { ApiResponse } from '@oblihub/shared';
import type { TrafficFilters } from '@/store/trafficFilterStore';

export type TrafficRange = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';

export interface TrafficPoint {
  ts: string;
  reqCount: number;
  bytesOut: number;
  bytesIn: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  status401: number; status403: number; status404: number; status429: number; status499: number;
  status500: number; status502: number; status503: number; status504: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  uniqueIps: number;
  p50EdgeMs: number; p95EdgeMs: number; p99EdgeMs: number;
  p50UpstreamMs: number; p95UpstreamMs: number; p99UpstreamMs: number;
  avgUpstreamMs: number;
}

export interface TrafficSeries { bucket: 'minute' | 'hour'; points: TrafficPoint[]; }

export interface TopIp {
  ip: string;
  reqCount: number;
  bytesOut: number;
  geo: {
    ip: string; countryCode: string | null; countryName: string | null;
    city: string | null; latitude: number | null; longitude: number | null; org: string | null;
  } | null;
}

export interface TopUri { uri: string; reqCount: number; avgLatencyMs: number; }

export interface HostSummary {
  proxyHostId: number; domain: string;
  reqCount: number; bytesOut: number;
  errorCount: number; errorCount4xx: number; errorCount5xx: number;
}

export interface GeoCountry {
  code: string; name: string;
  reqCount: number; lat: number; lon: number; sampleIps: number;
}

export interface ErrorSummary {
  totalRequests: number;
  total4xx: number;
  total5xx: number;
  perCode: Record<string, number>;
  topErrorUris: { '4xx': { uri: string; reqCount: number }[]; '5xx': { uri: string; reqCount: number }[] };
  topErrorIps: { '4xx': TopIp[]; '5xx': TopIp[] };
}

export interface SampleRow {
  id: number;
  ts: string;
  status: number;
  method: string | null;
  uri: string;
  ip: string;
  countryCode: string | null;
  latencyMs: number;
  upstreamMs: number | null;
  userAgent: string | null;
  referer: string | null;
}

export interface PercentileSummary {
  current: {
    reqCount: number;
    errorRate: number;
    edge: { p50: number; p95: number; p99: number };
    upstream: { p50: number; p95: number; p99: number };
  };
  previous: {
    reqCount: number;
    errorRate: number;
    edge: { p50: number; p95: number; p99: number };
    upstream: { p50: number; p95: number; p99: number };
  };
}

/**
 * Build a URL query string reflecting the current filter state. Backend endpoints all accept
 * the same shape (?hosts=&countries=&status=&codes=&ip=&uri=&errorsOnly=&range=).
 */
function q(filters: Partial<TrafficFilters>): string {
  const p = new URLSearchParams();
  if (filters.hostIds?.length) p.set('hosts', filters.hostIds.join(','));
  if (filters.countries?.length) p.set('countries', filters.countries.join(','));
  if (filters.statusClasses?.length) p.set('status', filters.statusClasses.join(','));
  if (filters.statusCodes?.length) p.set('codes', filters.statusCodes.join(','));
  if (filters.ips?.length) p.set('ip', filters.ips.join(','));
  if (filters.uriPrefixes?.length) p.set('uri', filters.uriPrefixes.join(','));
  if (filters.errorsOnly) p.set('errorsOnly', '1');
  if (filters.range) p.set('range', filters.range);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const trafficApi = {
  async hostTimeSeries(id: number, range: TrafficRange = '24h'): Promise<TrafficSeries> {
    const res = await apiClient.get<ApiResponse<TrafficSeries>>(`/traffic/proxy-host/${id}/timeseries?range=${range}`);
    return res.data.data!;
  },
  async hostTopIps(id: number, range: TrafficRange = '24h', cls: string = 'all'): Promise<TopIp[]> {
    const res = await apiClient.get<ApiResponse<TopIp[]>>(`/traffic/proxy-host/${id}/top-ips?range=${range}&class=${cls}`);
    return res.data.data!;
  },
  async hostTopUris(id: number, range: TrafficRange = '24h', cls: string = 'all'): Promise<TopUri[]> {
    const res = await apiClient.get<ApiResponse<TopUri[]>>(`/traffic/proxy-host/${id}/top-uris?range=${range}&class=${cls}`);
    return res.data.data!;
  },
  async hostErrorSummary(id: number, range: TrafficRange = '24h'): Promise<ErrorSummary> {
    const res = await apiClient.get<ApiResponse<ErrorSummary>>(`/traffic/proxy-host/${id}/error-summary?range=${range}`);
    return res.data.data!;
  },
  async hostErrorSamples(id: number, limit = 100): Promise<SampleRow[]> {
    const res = await apiClient.get<ApiResponse<SampleRow[]>>(`/traffic/proxy-host/${id}/error-samples?limit=${limit}`);
    return res.data.data!;
  },
  async hostSlowSamples(id: number, limit = 100): Promise<SampleRow[]> {
    const res = await apiClient.get<ApiResponse<SampleRow[]>>(`/traffic/proxy-host/${id}/slow-samples?limit=${limit}`);
    return res.data.data!;
  },
  async summary(filters: Partial<TrafficFilters> = {}): Promise<HostSummary[]> {
    const res = await apiClient.get<ApiResponse<HostSummary[]>>(`/traffic/summary${q(filters)}`);
    return res.data.data!;
  },
  async teamCumul(filters: Partial<TrafficFilters> = {}): Promise<TrafficSeries> {
    const res = await apiClient.get<ApiResponse<TrafficSeries>>(`/traffic/team-cumul${q(filters)}`);
    return res.data.data!;
  },
  async geo(filters: Partial<TrafficFilters> = {}): Promise<GeoCountry[]> {
    const res = await apiClient.get<ApiResponse<GeoCountry[]>>(`/traffic/geo${q(filters)}`);
    return res.data.data!;
  },
  async topIpsGlobal(filters: Partial<TrafficFilters> = {}): Promise<TopIp[]> {
    const res = await apiClient.get<ApiResponse<TopIp[]>>(`/traffic/top-ips${q(filters)}`);
    return res.data.data!;
  },
  async topUrisGlobal(filters: Partial<TrafficFilters> = {}): Promise<TopUri[]> {
    const res = await apiClient.get<ApiResponse<TopUri[]>>(`/traffic/top-uris${q(filters)}`);
    return res.data.data!;
  },
  async percentiles(filters: Partial<TrafficFilters> = {}): Promise<PercentileSummary> {
    const res = await apiClient.get<ApiResponse<PercentileSummary>>(`/traffic/percentiles${q(filters)}`);
    return res.data.data!;
  },
};
