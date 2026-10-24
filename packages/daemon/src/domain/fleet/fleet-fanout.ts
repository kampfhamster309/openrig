// The fan-out MACHINERY every fleet read shares.
//
// There is exactly one fleet fan-out, and it lives here: one deadline per host,
// bounded concurrency, and a short single-flight cache. `fleet-summary.ts` and
// `fleet-usage.ts` are two READS over these primitives, not two fan-outs. A
// second copy of the deadline arithmetic or the cache is how a hub ends up with
// two reads that disagree about what "this host timed out" means.
//
// The rules themselves are documented at their source in this file; a read adds
// only which paths it dials and what it composes from the answers.

import type { HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest, type RemoteJsonFailureKind } from "../hosts/remote-daemon-http.js";

// ---------------------------------------------------------------------------
// One bounded remote GET, under ONE host's own budget
// ---------------------------------------------------------------------------

export type RemoteLeg =
  | { ok: true; payload: unknown }
  | { ok: false; note: string; kind: RemoteJsonFailureKind; httpStatus?: number };

/** A failure is a value — never a throw, never a hang — and it keeps its
 *  transport KIND, so the closed per-host status enum can tell an operator to
 *  rotate a bearer from one telling them to check the host. Its note is what a
 *  read discloses in its own partial-failure list.
 *
 *  `deadlineAt` is an ABSOLUTE instant owned by the caller: it is started when
 *  that host's leg starts and spent by that host alone. A shared fleet deadline
 *  makes a slow team look unreachable for no reason of its own. */
export async function hostGet(
  host: HttpHostEntry,
  path: string,
  deadlineAt: number,
  deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; readFile?: (path: string) => string },
  label: string,
): Promise<RemoteLeg> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { ok: false, kind: "timeout", note: `${label}: this host's own read budget was already spent` };
  const res = await remoteJsonRequest(host, path, {
    method: "GET",
    timeoutMs: remaining,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) return { ok: true, payload: res.payload };
  if (res.kind === "bearer") return { ok: false, kind: res.kind, note: `${label}: ${res.detail}` };
  if (res.kind === "http") return { ok: false, kind: res.kind, httpStatus: res.status, note: `${label}: HTTP ${res.status}${res.detail ? ` ${res.detail}` : ""}` };
  if (res.kind === "timeout") return { ok: false, kind: res.kind, note: `${label}: timed out with ${remaining}ms left of its own budget` };
  return { ok: false, kind: res.kind, note: `${label}: ${res.detail}` };
}

// ---------------------------------------------------------------------------
// Bounded concurrency, input order preserved
// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with at most `concurrency` in flight and returns
 *  the results IN INPUT ORDER, so a payload is deterministic regardless of which
 *  host answered first. A cap above the item count is clamped (no idle workers);
 *  a cap below one is raised (a zero-wide fan-out answers nothing). */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const cap = Math.max(1, Math.min(Math.max(1, concurrency), Math.max(items.length, 1)));
  const runners = Array.from({ length: cap }, async () => {
    for (;;) {
      const i = next;
      if (i >= items.length) return;
      next += 1;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// The short cache: one fan-out serves every reader
// ---------------------------------------------------------------------------

/** The fields the cache layer stamps on whatever a fan-out produced. */
export interface CacheFields {
  fromCache: boolean;
  cacheAgeMs: number;
  /** True when the cache held a payload older than the ttl because the refresh was
   *  still in flight (single-flight keeps one reader waiting rather than starting a
   *  fan-out per reader). */
  cacheStaleWhileRevalidate: boolean;
  cacheTtlMs: number;
}

export interface SingleFlightCache<T, K> {
  /** Returns a cached payload when one is fresh, otherwise runs (or joins) one
   *  fan-out. Concurrent callers share ONE fan-out.
   *
   *  `ruleKey` identifies the RULE the payload was produced under. A cached
   *  payload is served only while the rule is unchanged: an answer computed under
   *  one rule must not be handed out as if another had been applied, which is
   *  worse than not reporting the rule at all. */
  read(fresh: boolean, ruleKey: K): Promise<T>;
  /** Test/teardown hook. */
  clear(): void;
}

/** A payload is served from cache while younger than `ttlMs`. A reader that
 *  arrives mid-refresh gets the in-flight promise rather than starting a second
 *  fan-out — that is the whole cost argument for these reads.
 *
 *  Stale-while-revalidate: once ANY payload exists, a reader that did not ask for
 *  `fresh` gets it immediately — with its true age and the flag set — while one
 *  refresh runs behind it. Without this, every poll that outlasts the cache waits
 *  for the whole fan-out, and a reader on a fixed timeout gives up and loses its
 *  remote sections for that poll. Cold start still waits, because there is nothing
 *  honest to serve. A payload past `staleBoundMs` is NOT served: an arbitrarily
 *  old answer dressed up as a healthy fleet is the failure this exists to avoid,
 *  so past the bound readers wait and meet the real failure. */
export function createSingleFlightCache<T extends object, K>(
  build: (ruleKey: K) => Promise<T>,
  opts: { ttlMs?: number; staleBoundMs: number; nowMs?: () => number; maxRuleEntries?: number },
  deps: { onBackgroundRefreshError?: (err: unknown) => void } = {},
): SingleFlightCache<T & CacheFields, K> {
  const ttlMs = opts.ttlMs ?? 3_000;
  const now = opts.nowMs ?? Date.now;
  type Entry = { payload: T & CacheFields; at: number };
  // One entry per rule, bounded. For the summary the rule is the stall threshold, which
  // seldom differs between readers, so a single slot was fine. For usage the rule is the
  // window, which is a per-reader flag: the TUI's 1h poll and a CLI `--window 24h`
  // evicted each other on every switch, and because each switch was a rule change neither
  // reader got stale service -- both waited for a full fan-out. Bounded because a hub
  // runs for weeks and a cache that grows with every window ever asked is a leak.
  const maxRuleEntries = opts.maxRuleEntries ?? 4;
  const entries = new Map<K, Entry>();
  // The in-flight fan-out is keyed by rule too, so a reader only joins a run that is
  // answering the same question it asked.
  const inflight = new Map<K, { promise: Promise<T & CacheFields> }>();

  /** Stores an entry as most-recently-used and drops the oldest past the bound. */
  const remember = (ruleKey: K, entry: Entry): void => {
    entries.delete(ruleKey);
    entries.set(ruleKey, entry);
    while (entries.size > maxRuleEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const run = async (ruleKey: K): Promise<T & CacheFields> => {
    const fanOut = await build(ruleKey);
    const at = now();
    const payload: T & CacheFields = {
      ...fanOut,
      fromCache: false,
      cacheAgeMs: 0,
      cacheStaleWhileRevalidate: false,
      cacheTtlMs: ttlMs,
    };
    // Only a SUCCESS reaches here, so a failed fan-out cannot overwrite a good
    // payload with nothing: the previous answer stays available to serve as stale.
    remember(ruleKey, { payload, at });
    return payload;
  };

  /** Starts a refresh and returns it without awaiting.
   *
   *  `detached` is the SWR case: nobody awaits it, because serving the stale payload is
   *  the whole point, so a failing fan-out would otherwise surface as an unhandled
   *  rejection in the daemon. Swallowed is not the same as silent: a refresh that keeps
   *  failing means readers are being served an increasingly stale answer, and a daemon
   *  that says nothing about that is hiding the one fact an operator would act on.
   *
   *  A FOREGROUND run must not take that catch. The reader is awaiting this promise and
   *  receives the rejection itself, so nothing stale is served and the reader is the
   *  right place to report it. Attaching the catch there logged "background refresh
   *  failed; serving stale until the bound" on a cold read that served neither.
   */
  const startRefresh = (
    ruleKey: K,
    mode: { detached: boolean },
  ): { promise: Promise<T & CacheFields> } => {
    const mine = run(ruleKey).finally(() => {
      // Only release the slot if it still holds THIS run; a parallel run that
      // finished first must not clear a slot a later reader is still waiting on.
      if (inflight.get(ruleKey)?.promise === mine) inflight.delete(ruleKey);
    });
    if (mode.detached) mine.catch((err: unknown) => deps.onBackgroundRefreshError?.(err));
    const rec = { promise: mine };
    inflight.set(ruleKey, rec);
    return rec;
  };

  return {
    async read(fresh: boolean, ruleKey: K): Promise<T & CacheFields> {
      const at = now();
      const hit = entries.get(ruleKey);
      if (hit) {
        // Touch so the bound evicts what nobody is asking for, not the first window
        // a steady poller has been reading for hours.
        entries.delete(ruleKey);
        entries.set(ruleKey, hit);
      }
      if (!fresh && hit && at - hit.at < ttlMs) {
        return { ...hit.payload, fromCache: true, cacheAgeMs: at - hit.at, cacheStaleWhileRevalidate: false };
      }

      const tooStale = hit !== undefined && at - hit.at > opts.staleBoundMs;
      if (!fresh && hit !== undefined && !tooStale) {
        const stale = { ...hit.payload, fromCache: true, cacheAgeMs: at - hit.at, cacheStaleWhileRevalidate: true };
        if (!inflight.has(ruleKey)) startRefresh(ruleKey, { detached: true });
        return stale;
      }

      const pending = inflight.get(ruleKey);
      if (pending) {
        // Another reader is already fanning out under the same rule. Join it.
        return pending.promise;
      }
      return startRefresh(ruleKey, { detached: false }).promise;
    },
    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}
