// The ONE CLI-side hub read: ask the local daemon to fan out, and fall back only
// when it cannot.
//
// Two fleet reads (`/api/fleet/summary`, `/api/fleet/usage`) are read from the CLI
// the same way, and the way is a rule rather than a preference:
//
//   1. Ask the LOCAL daemon. It has the per-host deadline, the bounded concurrency
//      and the short cache, so N readers cost one fan-out instead of N.
//   2. If it cannot answer — no daemon, an OLDER daemon that 404s the route, a
//      malformed body, a timeout — the caller fans out from here instead. The
//      fallback is the contract for an old local daemon, not an error.
//
// The timeout is the shared rule, never the client default. The route answers only
// after EVERY host leg finishes, so a reader on the 5 s default would abandon a
// healthy fan-out whenever one host is slow or the concurrency cap queues legs up —
// and then pay for a SECOND fan-out in its fallback, which is the exact cost the
// hub read exists to remove. The reader must outlast the work it is waiting for.

import { fleetSummaryReaderTimeoutMs, FLEET_HOST_TIMEOUT_MS_DEFAULT, FLEET_FANOUT_CONCURRENCY_DEFAULT } from "@openrig/daemon/fleet";
import { ConfigStore } from "../config-store.js";
import { resolveLocalDaemonUrl } from "../daemon-lifecycle.js";
import { DaemonClient } from "../client.js";

export interface HubReadDeps {
  clientFactory: (url: string) => DaemonClient;
}

/** The operator's own fan-out budget, read from the SAME settings file the daemon
 *  reads. `fleet.host_timeout_ms` and `fleet.fanout_concurrency` are operator
 *  settings and the route applies them — so a reader that still assumes the
 *  compiled defaults is wrong under exactly the configuration those settings
 *  introduce. Five hosts at a 15 s budget is two waves, about 30 s of fan-out; a
 *  reader computing its wait from a 5 s default gives up at 20 s and pays for a
 *  second fan-out in its fallback.
 *
 *  A missing or unreadable store is not an error: the defaults are what the daemon
 *  would have used anyway. */
export function fleetReaderBudget(): { hostTimeoutMs: number; concurrency: number } {
  try {
    const store = new ConfigStore();
    const hostTimeoutMs = store.get("fleet.host_timeout_ms");
    const concurrency = store.get("fleet.fanout_concurrency");
    return {
      hostTimeoutMs: typeof hostTimeoutMs === "number" && hostTimeoutMs > 0 ? hostTimeoutMs : FLEET_HOST_TIMEOUT_MS_DEFAULT,
      concurrency: typeof concurrency === "number" && concurrency > 0 ? concurrency : FLEET_FANOUT_CONCURRENCY_DEFAULT,
    };
  } catch {
    return { hostTimeoutMs: FLEET_HOST_TIMEOUT_MS_DEFAULT, concurrency: FLEET_FANOUT_CONCURRENCY_DEFAULT };
  }
}

/** One opportunistic hub read. ANY failure returns null and the caller uses its
 *  own CLI-side fan-out.
 *
 *  `hostCount` must include the hub's OWN local leg: the hub's fan-out covers the
 *  registered hosts AND itself, so leaving the local host out under-waits by
 *  exactly one wave — the gap this read exists to close.
 *
 *  `accepts` is the payload's own shape check. A body that parses but is not the
 *  expected aggregate is treated as "this daemon does not serve this read" rather
 *  than rendered as an empty fleet: an empty fleet and an unreadable answer are
 *  different facts, and only one of them is `0 rows`. */
export async function tryHubFleetRead<T>(
  deps: HubReadDeps,
  path: string,
  hostCount: number,
  accepts: (payload: unknown) => boolean,
  budget = fleetReaderBudget(),
): Promise<T | null> {
  try {
    const client = deps.clientFactory(resolveLocalDaemonUrl());
    const res = await client.get<T>(path, {
      timeoutMs: fleetSummaryReaderTimeoutMs(hostCount, budget.hostTimeoutMs, budget.concurrency),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const payload = res.data as T | undefined;
    if (!payload || !accepts(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** The omission-proof shape every fleet payload shares: `items` plus a
 *  `PerHostStatus` for every targeted host. */
export function isAggregatedFleetPayload(payload: unknown): boolean {
  const p = payload as { items?: unknown; hosts?: unknown } | undefined;
  return Array.isArray(p?.items) && Array.isArray(p?.hosts);
}
