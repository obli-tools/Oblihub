import { create } from 'zustand';

/**
 * Traffic dashboard filter state.
 *
 * Design goals:
 *   - Single source of truth for every filter/chip on the page: host, country, status class,
 *     status code, IP, URI prefix, "errors only" toggle, time range.
 *   - URL-encoded round-trip: any state can be pasted into a link and reproduces exactly.
 *     Every widget writes to the store; the page component syncs the store to the URL.
 *   - Same filter query shape the backend accepts (?hosts=&countries=&status=&codes=&ip=&uri=
 *     &errorsOnly=&range=).
 *   - Alt-click supported at the widget level — the store exposes toggle vs exclude helpers.
 *
 * The store is populated FROM the URL on first mount so a deep-linked view "just works".
 */

export type TrafficRange = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export interface TrafficFilters {
  hostIds: number[];
  countries: string[];
  statusClasses: StatusClass[];
  statusCodes: number[];
  ips: string[];
  uriPrefixes: string[];
  errorsOnly: boolean;
  range: TrafficRange;
}

interface TrafficFilterStore extends TrafficFilters {
  setRange: (range: TrafficRange) => void;
  toggleHost: (id: number) => void;
  toggleCountry: (code: string) => void;
  toggleStatusClass: (cls: StatusClass) => void;
  toggleStatusCode: (code: number) => void;
  toggleIp: (ip: string) => void;
  toggleUri: (prefix: string) => void;
  setErrorsOnly: (v: boolean) => void;
  clear: () => void;
  hydrateFromQuery: (search: string) => void;
  toQueryString: () => string;
}

const DEFAULTS: TrafficFilters = {
  hostIds: [],
  countries: [],
  statusClasses: [],
  statusCodes: [],
  ips: [],
  uriPrefixes: [],
  errorsOnly: false,
  range: '24h',
};

function toggleInArray<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
}

export const useTrafficFilters = create<TrafficFilterStore>((set, get) => ({
  ...DEFAULTS,
  setRange: (range) => set({ range }),
  toggleHost: (id) => set(s => ({ hostIds: toggleInArray(s.hostIds, id) })),
  toggleCountry: (code) => set(s => ({ countries: toggleInArray(s.countries, code) })),
  toggleStatusClass: (cls) => set(s => ({ statusClasses: toggleInArray(s.statusClasses, cls) })),
  toggleStatusCode: (code) => set(s => ({ statusCodes: toggleInArray(s.statusCodes, code) })),
  toggleIp: (ip) => set(s => ({ ips: toggleInArray(s.ips, ip) })),
  toggleUri: (prefix) => set(s => ({ uriPrefixes: toggleInArray(s.uriPrefixes, prefix) })),
  setErrorsOnly: (errorsOnly) => set({ errorsOnly }),
  clear: () => set({ ...DEFAULTS, range: get().range }),  // keep the range on Clear — resetting time is annoying
  hydrateFromQuery: (search) => {
    const p = new URLSearchParams(search);
    const csv = (k: string) => p.get(k)?.split(',').filter(Boolean) || [];
    const csvNum = (k: string) => csv(k).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const cls = csv('status').filter(c => ['2xx','3xx','4xx','5xx'].includes(c)) as StatusClass[];
    const range = (p.get('range') as TrafficRange) || '24h';
    set({
      hostIds: csvNum('hosts'),
      countries: csv('countries'),
      statusClasses: cls,
      statusCodes: csvNum('codes'),
      ips: csv('ip'),
      uriPrefixes: csv('uri'),
      errorsOnly: p.get('errorsOnly') === '1',
      range,
    });
  },
  toQueryString: () => {
    const s = get();
    const p = new URLSearchParams();
    if (s.hostIds.length) p.set('hosts', s.hostIds.join(','));
    if (s.countries.length) p.set('countries', s.countries.join(','));
    if (s.statusClasses.length) p.set('status', s.statusClasses.join(','));
    if (s.statusCodes.length) p.set('codes', s.statusCodes.join(','));
    if (s.ips.length) p.set('ip', s.ips.join(','));
    if (s.uriPrefixes.length) p.set('uri', s.uriPrefixes.join(','));
    if (s.errorsOnly) p.set('errorsOnly', '1');
    p.set('range', s.range);
    return p.toString();
  },
}));

/** Returns true when at least one chip-worthy filter is active. */
export function hasActiveFilters(f: TrafficFilters): boolean {
  return f.hostIds.length > 0
      || f.countries.length > 0
      || f.statusClasses.length > 0
      || f.statusCodes.length > 0
      || f.ips.length > 0
      || f.uriPrefixes.length > 0
      || f.errorsOnly;
}
