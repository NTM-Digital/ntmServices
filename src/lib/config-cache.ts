// Shared TTL cache for config resolved out of the Auth DB — credentials
// (env.ts) and AI models (ai-models.ts) both go through it, so a value changed
// in ntmbase reaches a running app without a restart or a redeploy.
//
// The TTL is what makes that possible: entries are re-read once they age out,
// rather than being pinned for the life of the process. Anything built *from*
// a resolved value is therefore constructed per call rather than cached
// alongside it — an SDK client costs microseconds to build against the ~180ms
// the lookup itself takes, so caching those would buy nothing and would pin
// the old value past its TTL.
//
// This matters more here than in a request-driven app: the services in this
// repo are long-running loops that can stay up for weeks, so a value pinned at
// process start would never be refreshed at all.

/** How long a resolved value is trusted before it is read again. */
export const CONFIG_TTL_MS = 5 * 60 * 1000;

type Entry = { value: string | undefined; fetchedAt: number };

const cache = new Map<string, Entry>();

/**
 * Returns the cached value for `key`, or runs `resolve` and caches whatever it
 * produces — including `undefined`, so a genuinely missing row doesn't re-query
 * on every call.
 */
export async function cachedResolve(
  key: string,
  resolve: () => Promise<string | undefined>
): Promise<string | undefined> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CONFIG_TTL_MS) {
    return hit.value;
  }

  const value = await resolve();
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
}

/** Drops every entry, so the next read goes back to the database. */
export function clearConfigCache(): void {
  cache.clear();
}
