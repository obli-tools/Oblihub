import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stack } from '@oblihub/shared';
import { stacksApi } from '../api/stacks.api';
import { useAuthStore } from '../store/authStore';
import { apiErrorMessage } from '../utils/apiError';

/**
 * Short-lived shared copy of GET /stacks. Every ContainerPicker (one per proxy route / sub-route
 * row) used to refetch the whole stacks list on mount, so an editor with ten routes fired ten
 * identical requests. The TTL stays short because container state changes quickly and pages that
 * need live state keep calling stacksApi.list() directly.
 */
const TTL_MS = 15_000;

let cache: { at: number; data: Stack[] } | null = null;
let inFlight: Promise<Stack[]> | null = null;
// A request started before invalidateStacksCache() must not write its (older) answer back.
let generation = 0;

function fresh(): Stack[] | null {
  return cache && Date.now() - cache.at < TTL_MS ? cache.data : null;
}

/**
 * `force` skips the TTL but still joins a request already in flight: that one started at most a
 * moment ago. After a mutation, call invalidateStacksCache() first so the in-flight one is dropped.
 */
export function fetchStacksCached(force = false): Promise<Stack[]> {
  const hit = force ? null : fresh();
  if (hit) return Promise.resolve(hit);
  if (inFlight) return inFlight;
  const gen = generation;
  const p = stacksApi.list()
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

export function invalidateStacksCache(): void {
  cache = null;
  inFlight = null;
  generation++;
}

// GET /stacks is filtered by the caller's teams, and logout does not reload the page: without this
// the next account signing in on the same tab would be served the previous account's list until
// the TTL ran out. Subscribing here catches every way the user changes (form login, logout, the
// session check after an SSO round trip) without each call site having to remember the cache.
useAuthStore.subscribe((state, prev) => {
  if (state.user?.id !== prev.user?.id) invalidateStacksCache();
});

export function useStacksList(): { stacks: Stack[]; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  const [stacks, setStacks] = useState<Stack[]>(() => fresh() ?? []);
  const [loading, setLoading] = useState(() => fresh() == null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (force: boolean) => {
    try {
      const data = await fetchStacksCached(force);
      if (!mounted.current) return;
      setStacks(data);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(apiErrorMessage(err, 'Failed to load stacks'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => { mounted.current = false; };
  }, [load]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await load(true);
  }, [load]);

  return { stacks, loading, error, refresh };
}
