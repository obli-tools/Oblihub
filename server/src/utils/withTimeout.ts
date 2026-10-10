/**
 * Per-call time bounds for Docker (and other) promises.
 *
 * dockerode has no per-call timeout, and a global client `timeout` would also kill hijacked console
 * exec sessions and `logs --follow` streams. So individual calls are bounded here instead. The
 * underlying request keeps running after a timeout (there is nothing to cancel it with), which is why
 * callers also bound concurrency with in-flight guards or single-flight caches: a slow engine must not
 * pile up one abandoned request per poll.
 */
export class TimeoutError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const workers = Math.min(items.length, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
