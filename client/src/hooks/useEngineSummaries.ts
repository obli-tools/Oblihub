import { useEffect, useMemo, useState } from 'react';
import type { DockerEngine, EngineSummary } from '@oblihub/shared';
import { enginesApi } from '../api/engines.api';
import { apiErrorMessage } from '../utils/apiError';

/**
 * Engine identities (no host, no secrets) for every authenticated user. The full engine list is
 * admin-only, so pages that only need names for a filter bar, an "Engine" column or a "(hub)"
 * label read this instead.
 *
 * Engines change rarely while dozens of components may want the list, so one module-level copy is
 * kept for a minute and concurrent mounts share a single request.
 */
const TTL_MS = 60_000;

let cache: { at: number; data: EngineSummary[] } | null = null;
let inFlight: Promise<EngineSummary[]> | null = null;
// Bumped by invalidateEngineSummaries(): a request that started before an invalidation must not
// repopulate the cache with the pre-change list.
let generation = 0;
const listeners = new Set<() => void>();

function fresh(): EngineSummary[] | null {
  return cache && Date.now() - cache.at < TTL_MS ? cache.data : null;
}

function toSummary(e: DockerEngine): EngineSummary {
  return { id: e.id, name: e.name, type: e.type, isDefault: e.isDefault, enabled: e.enabled, isLocal: e.type === 'local' };
}

/**
 * The client container can be recreated before the server self-updates, and a server that
 * predates /engines/summary answers it with an error. Admins can still read the full list there,
 * which is where these pages got their engines before; for anyone else it fails too and the
 * summary error is the one reported.
 */
function loadSummaries(): Promise<EngineSummary[]> {
  return enginesApi.summary().catch((summaryErr: unknown) =>
    enginesApi.list().then(
      (engines) => engines.map(toSummary),
      () => { throw summaryErr; },
    ));
}

function fetchEngineSummaries(): Promise<EngineSummary[]> {
  const hit = fresh();
  if (hit) return Promise.resolve(hit);
  if (inFlight) return inFlight;
  const gen = generation;
  // Only a success is cached, so after a double failure the next mount retries once the server
  // has been updated.
  const p = loadSummaries()
    .then((data) => {
      if (gen === generation) cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      if (inFlight === p) inFlight = null;
    });
  inFlight = p;
  return p;
}

/** Call after creating, editing, enabling or deleting an engine; mounted hooks refetch. */
export function invalidateEngineSummaries(): void {
  cache = null;
  inFlight = null;
  generation++;
  for (const l of listeners) l();
}

export interface EngineSummariesState {
  engines: EngineSummary[];
  byId: Map<number, EngineSummary>;
  /** The engine behind Oblihub's own socket: the default one if several are local, else the first local one. */
  localEngineId: number | null;
  loading: boolean;
  error: string | null;
}

export function useEngineSummaries(): EngineSummariesState {
  const [state, setState] = useState<{ engines: EngineSummary[]; loading: boolean; error: string | null }>(() => {
    const hit = fresh();
    return hit ? { engines: hit, loading: false, error: null } : { engines: [], loading: true, error: null };
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onInvalidate = () => setReloadKey((k) => k + 1);
    listeners.add(onInvalidate);
    return () => { listeners.delete(onInvalidate); };
  }, []);

  useEffect(() => {
    let alive = true;
    fetchEngineSummaries()
      .then((engines) => { if (alive) setState({ engines, loading: false, error: null }); })
      // A page must render without engine names (older server, network blip): empty list, no throw.
      .catch((err) => { if (alive) setState({ engines: [], loading: false, error: apiErrorMessage(err, 'Failed to load engines') }); });
    return () => { alive = false; };
  }, [reloadKey]);

  const byId = useMemo(() => new Map(state.engines.map((e) => [e.id, e] as const)), [state.engines]);
  const localEngineId = useMemo(() => {
    const locals = state.engines.filter((e) => e.isLocal);
    return (locals.find((e) => e.isDefault) ?? locals[0])?.id ?? null;
  }, [state.engines]);

  return { engines: state.engines, byId, localEngineId, loading: state.loading, error: state.error };
}
