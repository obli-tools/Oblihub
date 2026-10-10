import type { ContainerPort, RawPortBinding, PortChipModel, ComposePortSpec } from './types';

// Port helpers shared by discovery (server) and every port display / picker (client).
//
// A ContainerPort may cover a run of consecutive ports through `count`. It exists because Docker
// lists every port of a published range individually: a 10000-port UDP range (media servers,
// TURN relays) used to be stored as 10000 jsonb entries and rendered as 10000 chips. Discovery now
// compacts runs into one entry, and every consumer goes through portCount()/containerPortRange()
// instead of assuming one port per entry.

const WILDCARD_IPS = new Set(['', '0.0.0.0', '::']);

/** '' / 0.0.0.0 / :: mean "all interfaces" and are returned as null; brackets around IPv6 are dropped. */
export function normalizeHostIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  let v = ip.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).trim();
  return WILDCARD_IPS.has(v) ? null : v;
}

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (typeof ip !== 'string') return false;
  const v = ip.trim().toLowerCase();
  return v.startsWith('127.') || v === '::1' || v === '[::1]' || v === 'localhost';
}

export function portCount(p: ContainerPort): number {
  const c = p.count ?? 1;
  // Rows come from jsonb: a malformed count must not turn every range computation into NaN.
  return Number.isFinite(c) ? Math.max(1, Math.floor(c)) : 1;
}

export function containerPortRange(p: ContainerPort): [number, number] {
  return [p.containerPort, p.containerPort + portCount(p) - 1];
}

export function hostPortRange(p: ContainerPort): [number, number] | null {
  if (p.hostPort == null) return null;
  return [p.hostPort, p.hostPort + portCount(p) - 1];
}

function protocolOf(p: { protocol?: string | null }): string {
  return (p.protocol || 'tcp').toLowerCase();
}

export function portSegmentContains(p: ContainerPort, containerPort: number, protocol?: string): boolean {
  if (protocol !== undefined && protocolOf(p) !== protocol.toLowerCase()) return false;
  const [start, end] = containerPortRange(p);
  return containerPort >= start && containerPort <= end;
}

/** The entry covering `containerPort`; a published entry wins over an internal one. */
export function findContainerPort(ports: ContainerPort[], containerPort: number, protocol = 'tcp'): ContainerPort | null {
  let internal: ContainerPort | null = null;
  for (const p of ports ?? []) {
    if (!p || !portSegmentContains(p, containerPort, protocol)) continue;
    if (p.hostPort != null) return p;
    if (!internal) internal = p;
  }
  return internal;
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

// ── Compaction ──

interface Segment {
  protocol: string;
  hostIp: string | null;
  /** null = internal (not published). */
  hostStart: number | null;
  start: number;
  end: number;
}

function isPortNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

function toSegments(ports: readonly ContainerPort[]): Segment[] {
  const out: Segment[] = [];
  for (const p of ports ?? []) {
    if (!p || !isPortNumber(p.containerPort)) continue;
    const count = portCount(p);
    out.push({
      protocol: protocolOf(p),
      // Rows written before normalisation stored Docker's raw '0.0.0.0' / '::' for wildcard bindings.
      hostIp: normalizeHostIp(p.hostIp),
      hostStart: isPortNumber(p.hostPort) ? p.hostPort : null,
      start: p.containerPort,
      end: p.containerPort + count - 1,
    });
  }
  return out;
}

/** Merges overlapping or adjacent segments of ONE group (same kind, protocol, host ip and offset). */
function mergeGroup(group: Segment[]): Segment[] {
  const sorted = [...group].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Segment[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 1) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    merged.push({ ...s });
  }
  return merged;
}

/** Merged container-side ranges, used to test whether an internal segment is fully published. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compactSegments(segments: Segment[]): { published: Segment[]; internal: Segment[] } {
  const groups = new Map<string, { offset: number | null; items: Segment[] }>();
  for (const s of segments) {
    // Published entries only merge when the host side stays contiguous too, hence the offset in the key.
    const offset = s.hostStart != null ? s.hostStart - s.start : null;
    const key = offset != null ? `p|${s.protocol}|${s.hostIp ?? '*'}|${offset}` : `i|${s.protocol}`;
    const g = groups.get(key);
    if (g) g.items.push(s); else groups.set(key, { offset, items: [s] });
  }

  const published: Segment[] = [];
  const internalMerged: Segment[] = [];
  for (const { offset, items } of groups.values()) {
    const merged = mergeGroup(items);
    if (offset != null) {
      for (const m of merged) m.hostStart = m.start + offset;
      published.push(...merged);
    } else {
      internalMerged.push(...merged);
    }
  }

  const publishedByProtocol = new Map<string, Array<[number, number]>>();
  for (const p of published) {
    const list = publishedByProtocol.get(p.protocol) ?? [];
    list.push([p.start, p.end]);
    publishedByProtocol.set(p.protocol, list);
  }
  const coverage = new Map<string, Array<[number, number]>>();
  for (const [proto, list] of publishedByProtocol) coverage.set(proto, mergeRanges(list));

  // An internal entry that is published anyway is noise: the published chip already says it.
  const internal = internalMerged.filter((s) => {
    const ranges = coverage.get(s.protocol);
    return !ranges || !ranges.some(([a, b]) => a <= s.start && s.end <= b);
  });

  published.sort((a, b) =>
    (a.hostStart! - b.hostStart!)
    || cmpText(a.protocol, b.protocol)
    || cmpText(a.hostIp ?? '', b.hostIp ?? '')
    || a.start - b.start);
  internal.sort((a, b) => a.start - b.start || cmpText(a.protocol, b.protocol));
  return { published, internal };
}

function segmentToPort(s: Segment): ContainerPort {
  const count = s.end - s.start + 1;
  const port: ContainerPort = {
    hostPort: s.hostStart,
    containerPort: s.start,
    protocol: s.protocol,
    hostIp: s.hostIp,
  };
  if (count > 1) port.count = count;
  return port;
}

function compactToSegments(ports: readonly ContainerPort[]): Segment[] {
  const { published, internal } = compactSegments(toSegments(ports));
  return [...published, ...internal];
}

/**
 * Turns Docker's port list (/containers/json `Ports`, or bindings rebuilt from inspect) into
 * compacted ContainerPort entries: one entry per run of consecutive ports.
 */
export function normalizeDockerPorts(raw: RawPortBinding[]): ContainerPort[] {
  interface Entry { containerPort: number; hostPort: number | null; protocol: string; hostIp: string | null; fromV6: boolean }
  const byKey = new Map<string, Entry>();
  for (const r of raw ?? []) {
    if (!r || !isPortNumber(r.privatePort)) continue;
    const hostPort = isPortNumber(r.publicPort) ? r.publicPort : null;
    const protocol = (r.type || 'tcp').toLowerCase();
    const hostIp = normalizeHostIp(r.ip);
    const fromV6 = (r.ip || '').includes(':');
    const key = `${hostIp ?? '*'}|${hostPort ?? '-'}|${r.privatePort}/${protocol}`;
    const existing = byKey.get(key);
    if (existing) {
      // Only "v6" when every binding behind this entry came from an IPv6 address.
      existing.fromV6 = existing.fromV6 && fromV6;
      continue;
    }
    byKey.set(key, { containerPort: r.privatePort, hostPort, protocol, hostIp, fromV6 });
  }
  let entries = [...byKey.values()];

  // Docker can give the IPv4 and IPv6 wildcard bindings of one container port DIFFERENT ephemeral
  // host ports (0.0.0.0:32768 and [::]:32769). Showing both is noise, so the IPv6 ones are dropped
  // whenever an IPv4 wildcard binding exists for the same container port.
  const wildcardByPort = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.hostPort == null || e.hostIp != null) continue;
    const k = `${e.containerPort}/${e.protocol}`;
    const list = wildcardByPort.get(k);
    if (list) list.push(e); else wildcardByPort.set(k, [e]);
  }
  const dropped = new Set<Entry>();
  for (const list of wildcardByPort.values()) {
    const hostPorts = new Set(list.map((e) => e.hostPort));
    if (hostPorts.size < 2 || !list.some((e) => !e.fromV6)) continue;
    for (const e of list) if (e.fromV6) dropped.add(e);
  }
  entries = entries.filter((e) => !dropped.has(e));

  // Docker also lists the bare container port next to its published binding.
  const publishedKeys = new Set(entries.filter((e) => e.hostPort != null).map((e) => `${e.containerPort}/${e.protocol}`));
  entries = entries.filter((e) => e.hostPort != null || !publishedKeys.has(`${e.containerPort}/${e.protocol}`));

  return compactToSegments(entries.map((e) => ({
    hostPort: e.hostPort,
    containerPort: e.containerPort,
    protocol: e.protocol,
    hostIp: e.hostIp,
  }))).map(segmentToPort);
}

// ── Display ──

function formatRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function formatIp(ip: string): string {
  return ip.includes(':') ? `[${ip}]` : ip;
}

export function buildPortChips(ports: ContainerPort[], opts?: { includeInternal?: boolean }): PortChipModel[] {
  const includeInternal = opts?.includeInternal ?? true;
  const chips: PortChipModel[] = [];
  for (const s of compactToSegments(ports)) {
    const containerRange = formatRange(s.start, s.end);
    const protoSuffix = s.protocol === 'tcp' ? '' : `/${s.protocol}`;
    if (s.hostStart != null) {
      const hostEnd = s.hostStart + (s.end - s.start);
      const hostRange = formatRange(s.hostStart, hostEnd);
      const mapping = s.hostStart === s.start ? hostRange : `${hostRange}→${containerRange}`;
      const loopback = isLoopbackIp(s.hostIp);
      const detail = `host ${hostRange} → container ${containerRange}/${s.protocol}`;
      let title: string;
      if (s.hostIp == null) title = `Published: ${detail}`;
      else if (loopback) title = `Published on ${s.hostIp} only (not reachable from other machines): ${detail}`;
      else title = `Published on ${s.hostIp} only: ${detail}`;
      chips.push({
        key: `published|${s.protocol}|${s.hostIp ?? '*'}|${s.hostStart}|${s.start}`,
        kind: 'published',
        protocol: s.protocol,
        hostIp: s.hostIp,
        loopback,
        hostStart: s.hostStart,
        hostEnd,
        containerStart: s.start,
        containerEnd: s.end,
        label: `${s.hostIp != null ? `${formatIp(s.hostIp)}:` : ''}${mapping}${protoSuffix}`,
        title,
      });
    } else if (includeInternal) {
      chips.push({
        key: `internal|${s.protocol}|*|-|${s.start}`,
        kind: 'internal',
        protocol: s.protocol,
        hostIp: null,
        loopback: false,
        hostStart: null,
        hostEnd: null,
        containerStart: s.start,
        containerEnd: s.end,
        label: `${containerRange}${protoSuffix}`,
        title: `Internal only: container port ${containerRange}/${s.protocol} (not published on the host)`,
      });
    }
  }
  return chips;
}

/** Distinct container-side ranges of the compacted list: tcp first, then other protocols, each by start. */
function containerSideSegments(segments: Segment[]): Array<{ protocol: string; start: number; end: number }> {
  const seen = new Set<string>();
  const out: Array<{ protocol: string; start: number; end: number }> = [];
  for (const s of segments) {
    const key = `${s.protocol}|${s.start}|${s.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ protocol: s.protocol, start: s.start, end: s.end });
  }
  return out.sort((a, b) => {
    const aTcp = a.protocol === 'tcp' ? 0 : 1;
    const bTcp = b.protocol === 'tcp' ? 0 : 1;
    return aTcp - bTcp || a.start - b.start || a.end - b.end || cmpText(a.protocol, b.protocol);
  });
}

/** Container-side summary for pickers, e.g. '80, 443, 5432, 9000-9002 +2 · 4 published'. */
export function formatPortSummary(ports: ContainerPort[], maxItems = 4): string {
  const segments = compactToSegments(ports);
  if (segments.length === 0) return '';
  const sides = containerSideSegments(segments);
  const limit = Math.max(1, Math.floor(Number.isFinite(maxItems) ? maxItems : 4));
  const shown = sides.slice(0, limit).map((s) =>
    `${formatRange(s.start, s.end)}${s.protocol === 'tcp' ? '' : `/${s.protocol}`}`);
  let text = shown.join(', ');
  if (sides.length > limit) text += ` +${sides.length - limit}`;
  const publishedCount = segments.filter((s) => s.hostStart != null).length;
  if (publishedCount > 0) text += ` · ${publishedCount} published`;
  return text;
}

const PREFERRED_PROXY_PORTS = [80, 8080, 3000, 8000, 5000, 443, 8443, 9000];

function pickProxyPort(segments: Segment[]): number | null {
  const tcp = containerSideSegments(segments).filter((s) => s.protocol === 'tcp');
  if (tcp.length === 0) return null;
  if (tcp.length === 1 && tcp[0].start === tcp[0].end) return tcp[0].start;
  for (const port of PREFERRED_PROXY_PORTS) {
    if (tcp.some((s) => port >= s.start && port <= s.end)) return port;
  }
  return tcp[0].start;
}

/**
 * Container port a reverse proxy most likely wants; null when the container has no tcp port.
 *
 * `preferPublished` is for targets on a REMOTE engine: without a Tailscale subnet route the hub
 * only reaches them through a published, non-loopback port, so an internal-only port that ranks
 * higher in the preferred list is a dead end there (EXPOSE 8000 9000 9443 with only 9443
 * published must give 9443, not 8000). When nothing qualifies it falls back to the
 * publication-agnostic order, which is also what local targets use since they go through
 * Docker DNS and only the container port matters.
 */
export function suggestProxyPort(ports: ContainerPort[], opts?: { preferPublished?: boolean }): number | null {
  const segments = compactToSegments(ports);
  if (opts?.preferPublished) {
    const reachable = pickProxyPort(segments.filter((s) => s.hostStart != null && !isLoopbackIp(s.hostIp)));
    if (reachable != null) return reachable;
  }
  return pickProxyPort(segments);
}

// ── Compose `ports:` parsing ──

/** '80' or '8000-8010' → [start, end]; null when not purely numeric (e.g. '${VAR}') or out of 1-65535. */
function parseRange(text: string): [number, number] | null {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (!isPortNumber(start) || !isPortNumber(end) || end < start) return null;
  return [start, end];
}

function parseProtocol(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'tcp';
  if (typeof value !== 'string') return null;
  const p = value.trim().toLowerCase();
  return /^[a-z]+$/.test(p) ? p : null;
}

function buildSpec(
  hostIp: string | null,
  host: [number, number] | null,
  container: [number, number],
  protocol: string,
): ComposePortSpec | null {
  let hostStart: number | null = null;
  let hostEnd: number | null = null;
  if (host) {
    const containerLen = container[1] - container[0];
    const hostLen = host[1] - host[0];
    if (hostLen === 0 && containerLen > 0) {
      // A single host port for a container range: the host side is the run starting there.
      hostStart = host[0];
      hostEnd = host[0] + containerLen;
      if (!isPortNumber(hostEnd)) return null;
    } else if (hostLen !== containerLen) {
      return null;
    } else {
      hostStart = host[0];
      hostEnd = host[1];
    }
  }
  return { hostIp, hostStart, hostEnd, containerStart: container[0], containerEnd: container[1], protocol };
}

/** Parses one compose `ports:` entry (short or long syntax). null when it cannot be read statically. */
export function parseComposePortSpec(spec: unknown): ComposePortSpec | null {
  if (typeof spec === 'number') {
    if (!isPortNumber(spec)) return null;
    return { hostIp: null, hostStart: null, hostEnd: null, containerStart: spec, containerEnd: spec, protocol: 'tcp' };
  }

  if (typeof spec === 'string') {
    let text = spec.trim();
    let protocol = 'tcp';
    const slash = text.lastIndexOf('/');
    if (slash >= 0) {
      const protoText = text.slice(slash + 1);
      const proto = protoText.trim() === '' ? null : parseProtocol(protoText);
      if (!proto) return null;
      protocol = proto;
      text = text.slice(0, slash);
    }
    // Same split as Docker's own parser: the last part is the container side, the one before it
    // the host side, everything before that the host IP (IPv6 in brackets contains colons).
    const parts = text.split(':');
    const containerPart = parts[parts.length - 1];
    const hostPart = parts.length >= 2 ? parts[parts.length - 2] : null;
    const ipPart = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(':') : null;
    const container = parseRange(containerPart);
    if (!container) return null;
    let host: [number, number] | null = null;
    if (hostPart !== null && hostPart.trim() !== '') {
      host = parseRange(hostPart);
      if (!host) return null;
    }
    let hostIp: string | null = null;
    if (ipPart !== null) {
      const raw = ipPart.trim();
      // Unbalanced brackets or a leftover variable mean the entry is not a literal address.
      if (raw.includes('$') || (raw.startsWith('[') !== raw.endsWith(']'))) return null;
      hostIp = normalizeHostIp(raw);
    }
    return buildSpec(hostIp, host, container, protocol);
  }

  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const o = spec as { target?: unknown; published?: unknown; protocol?: unknown; host_ip?: unknown };
    let container: [number, number] | null = null;
    if (typeof o.target === 'number') container = isPortNumber(o.target) ? [o.target, o.target] : null;
    else if (typeof o.target === 'string') container = parseRange(o.target);
    if (!container) return null;

    let host: [number, number] | null = null;
    if (typeof o.published === 'number') {
      if (!isPortNumber(o.published)) return null;
      host = [o.published, o.published];
    } else if (typeof o.published === 'string' && o.published.trim() !== '') {
      host = parseRange(o.published);
      if (!host) return null;
    } else if (o.published !== undefined && o.published !== null && o.published !== '') {
      return null;
    }

    const protocol = parseProtocol(o.protocol);
    if (!protocol) return null;

    let hostIp: string | null = null;
    if (typeof o.host_ip === 'string') {
      if (o.host_ip.includes('$')) return null;
      hostIp = normalizeHostIp(o.host_ip);
    } else if (o.host_ip !== undefined && o.host_ip !== null) {
      return null;
    }
    return buildSpec(hostIp, host, container, protocol);
  }

  return null;
}
