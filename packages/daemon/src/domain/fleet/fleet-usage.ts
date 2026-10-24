// The hub-side fleet USAGE read: what every team is using, from the hub.
//
// A hub has no seats of its own, so the single-host usage reads answer nothing
// there. This composes the fleet's answer out of the read EVERY team pod already
// serves — `GET /api/telemetry/usage/top` — and labels each seat with its host.
// It adds no route the remote side has to serve: an old pod answers these legs
// unchanged.
//
// It is a READ over the shared fleet fan-out (`fleet-fanout.ts`), not a second
// fan-out: one deadline per host, the same bounded concurrency, the same
// single-flight cache posture, the same reachability enum as the fleet summary.
//
// The honesty rules, because this payload is NUMBERS and a wrong number is worse
// than no number:
//   * Unknown is never zero. A host that did not answer contributes nothing to a
//     total, and the payload says how many hosts answered out of how many were
//     targeted. When none answered, the fleet total is absent, not `0`.
//   * Only numbers that honestly add are summed (see `FleetUsageTotals`). Rates
//     and percentages ride per-seat and are never combined.
//   * A lane a runtime does not observe is absent, not zero.

import { LOCAL_HOST_ID, type PerHostStatus } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { FLEET_CACHE_MS, FLEET_FANOUT_CONCURRENCY_DEFAULT, FLEET_HOST_TIMEOUT_MS_DEFAULT, FLEET_STALE_BOUND_MS } from "./fleet-settings.js";
import { createSingleFlightCache, hostGet, mapWithConcurrency } from "./fleet-fanout.js";
// The arithmetic is a separate module so the CLI's fallback can use the SAME sums
// and ranking without importing a fan-out. One implementation of "what do these
// seats add up to", read by both.
import { addUsageTotals, parseUsageTopBody, rankFleetSeats, sumUsageTotals, ZERO_USAGE_TOTALS, type UsageLeg } from "./fleet-usage-math.js";
import type {
  FleetHostUsage,
  FleetSeatBurn,
  FleetUnknownSeat,
  FleetUsageFanOutResult,
  FleetUsagePayload,
  FleetUsageTotals,
  UsageSeatBurn,
  UsageTopBody,
  UsageUnknownSeat,
} from "./fleet-usage-types.js";

/** The window every host is asked for. No `top` is sent on the legs — see
 *  `composeFleetUsage` for why the cap is applied hub-side. */
export interface FleetUsageWindow {
  windowHours: number;
}

export { addUsageTotals, parseUsageTopBody, rankFleetSeats, sumUsageTotals, ZERO_USAGE_TOTALS } from "./fleet-usage-math.js";
export type { UsageLeg } from "./fleet-usage-math.js";

export interface FleetUsageDeps {
  /** The LOCAL host's usage, read in-process from this daemon's own samples.
   *  Injected by the route so this module stays transport-only. */
  readLocalUsage: (window: FleetUsageWindow) => UsageLeg;
  loadRegistry: () => HostRegistryLoadResult;
  /** A missing registry = a single-host operator: a clean local-only fleet. */
  registryExists: () => boolean;
  windowHours: number;
  hostTimeoutMs?: number;
  concurrency?: number;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

// ---------------------------------------------------------------------------
// Remote legs — every path below is answered by the OLDEST supported image.
// ---------------------------------------------------------------------------

async function readRemoteHostUsage(
  hostId: string,
  reg: HostRegistryLoadResult,
  deps: FleetUsageDeps,
  window: FleetUsageWindow,
): Promise<{ status: PerHostStatus; host: FleetHostUsage }> {
  const base = (status: PerHostStatus, reason: string, partial: string[] = []): { status: PerHostStatus; host: FleetHostUsage } => ({
    status,
    host: {
      hostId,
      kind: "remote",
      status: status.status,
      reachable: status.status === "ok",
      statusError: status.error,
      usage: { state: "unavailable", reason, ranked: [], unknown: [] },
      partialFailures: partial,
    },
  });

  if (!reg.ok) return base({ hostId, status: "unreachable", error: reg.error }, "the host registry could not be read");
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return base({ hostId, status: "unreachable", error: resolved.error }, "this host is not in the registry");
  if (resolved.host.transport !== "http") {
    return base({
      hostId,
      status: "unsupported-transport",
      error: `host '${hostId}' is SSH-declared; the fleet usage read requires an http-transport registry entry (url; bearer optional)`,
    }, "this host is declared over SSH, which the fleet usage read cannot dial");
  }

  // THE per-host deadline: started here, spent by this host alone.
  const deadlineAt = Date.now() + (deps.hostTimeoutMs ?? FLEET_HOST_TIMEOUT_MS_DEFAULT);

  // 1. /healthz — reachability, in the same words the fleet summary uses. Not
  //    under /api/, so every image answers it and it needs no bearer. Without it
  //    a dead host and a host that merely has no usage route would both come back
  //    "unreachable", and those are different operator fixes.
  const health = await hostGet(resolved.host, "/healthz", deadlineAt, deps, "health probe");
  if (!health.ok) {
    if (health.kind === "bearer") {
      return base({ hostId, status: "auth-failed", error: health.note, failedStep: "permission-gate" }, "the bearer for this host could not be resolved");
    }
    return base({ hostId, status: "unreachable", error: `host did not answer its health probe: ${health.note}`, failedStep: "remote-daemon-unreachable" }, "the host did not answer its health probe");
  }

  // 2. The usage read itself. Uncapped on purpose (see composeFleetUsage).
  const usageRes = await hostGet(
    resolved.host,
    `/api/telemetry/usage/top?window_hours=${encodeURIComponent(String(window.windowHours))}`,
    deadlineAt,
    deps,
    "usage top",
  );
  if (!usageRes.ok) {
    const authFailed = usageRes.kind === "bearer" || usageRes.httpStatus === 401 || usageRes.httpStatus === 403;
    if (authFailed) {
      return base({ hostId, status: "auth-failed", error: usageRes.note, failedStep: "permission-gate" }, "the host answered its health probe but refused the usage read");
    }
    // The host is REACHABLE — it answered its probe. Only its usage read failed,
    // and that is a partial read on a live host, not a dead host.
    return base({ hostId, status: "ok" }, `this host's usage read did not answer: ${usageRes.note}`, [usageRes.note]);
  }

  const parsed = parseUsageTopBody(usageRes.payload);
  if (!parsed.leg.ok) {
    return base({ hostId, status: "ok" }, `this host's usage read was unreadable: ${parsed.leg.reason}`, [parsed.leg.reason]);
  }
  const body = parsed.leg.body;
  const ranked: FleetSeatBurn[] = body.ranked.map((seat) => ({ ...seat, hostId }));
  const unknown: FleetUnknownSeat[] = body.unknown.map((seat) => ({ ...seat, hostId }));
  const notes: string[] = [];
  if (parsed.droppedRows > 0) {
    notes.push(`${parsed.droppedRows} seat row(s) from this host did not carry finite burn numbers and are excluded from its totals`);
  }
  return {
    status: { hostId, status: "ok" },
    host: {
      hostId,
      kind: "remote",
      status: "ok",
      reachable: true,
      usage: {
        state: "ok",
        windowHours: body.windowHours,
        sinceIso: body.sinceIso,
        ranked,
        unknown,
        totalRankedSeats: body.totalRankedSeats,
        totals: sumUsageTotals(ranked, unknown.length),
      },
      partialFailures: notes,
    },
  };
}

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

/** ONE fan-out: the local host in-process first, then every registered host under
 *  its own deadline. EVERY targeted host appears in `hosts` — ok, unreachable,
 *  auth-failed or unsupported-transport — never all-or-nothing and never a silently
 *  thinner fleet. */
export async function composeFleetUsage(deps: FleetUsageDeps): Promise<FleetUsageFanOutResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  const windowHours = deps.windowHours;
  const window: FleetUsageWindow = { windowHours };
  const hostTimeoutMs = deps.hostTimeoutMs ?? FLEET_HOST_TIMEOUT_MS_DEFAULT;
  const concurrency = Math.max(1, deps.concurrency ?? FLEET_FANOUT_CONCURRENCY_DEFAULT);
  const sinceIso = new Date(nowMs - windowHours * 3_600_000).toISOString();

  // ---- local leg, in-process (zero self-transport) --------------------------
  const localLeg = deps.readLocalUsage(window);
  const localHost: FleetHostUsage = {
    hostId: LOCAL_HOST_ID,
    kind: "local",
    status: "ok",
    reachable: true,
    usage: localLeg.ok
      ? {
        state: "ok",
        windowHours: localLeg.body.windowHours,
        sinceIso: localLeg.body.sinceIso,
        ranked: localLeg.body.ranked.map((seat) => ({ ...seat, hostId: LOCAL_HOST_ID })),
        unknown: localLeg.body.unknown.map((seat) => ({ ...seat, hostId: LOCAL_HOST_ID })),
        totalRankedSeats: localLeg.body.totalRankedSeats,
        totals: sumUsageTotals(localLeg.body.ranked, localLeg.body.unknown.length),
      }
      : { state: "unavailable", reason: localLeg.reason, ranked: [], unknown: [] },
    partialFailures: [],
  };

  const hosts: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const items: FleetHostUsage[] = [localHost];

  let targetedHostIds: string[] = [LOCAL_HOST_ID];
  let registryError: string | undefined;
  const remoteHosts: FleetHostUsage[] = [];

  if (deps.registryExists()) {
    const reg = deps.loadRegistry();
    if (!reg.ok) {
      // The registry EXISTS but cannot be read: there was no host list to attribute
      // per-host statuses to, so say so rather than quietly returning a local-only
      // fleet that looks like a one-host fleet.
      registryError = reg.error;
    } else {
      const hostIds = reg.registry.hosts.map((h) => h.id);
      targetedHostIds = [LOCAL_HOST_ID, ...hostIds];
      const outcomes = await mapWithConcurrency(hostIds, concurrency, (hostId) => readRemoteHostUsage(hostId, reg, deps, window));
      for (const outcome of outcomes) {
        hosts.push(outcome.status);
        items.push(outcome.host);
        remoteHosts.push(outcome.host);
      }
    }
  }

  // ---- the fleet aggregate --------------------------------------------------
  // Only hosts that actually produced numbers feed a total. A host that did not
  // answer is absent from the sum, and `hostsAnswered` says the sum is partial.
  const answering = items.filter((item) => item.usage.state === "ok");
  const allSeats: FleetSeatBurn[] = [];
  const allUnknown: FleetUnknownSeat[] = [];
  for (const item of answering) {
    allSeats.push(...item.usage.ranked);
    allUnknown.push(...item.usage.unknown);
  }

  let totals: FleetUsagePayload["totals"] = null;
  if (answering.length > 0) {
    const summed = answering.reduce<FleetUsageTotals>(
      (acc, item) => addUsageTotals(acc, item.usage.totals!),
      ZERO_USAGE_TOTALS,
    );
    totals = { ...summed, hostsAnswered: answering.length, hostsTargeted: targetedHostIds.length };
  }

  // The cap is NOT applied here. The legs are uncapped on purpose (asking each host
  // for its top N and taking N of the union is wrong: a host's 6th seat can be the
  // fleet's 3rd, and a cap applied too early silently drops it), and the cap is a
  // VIEW over a ranking that is already complete — so it is applied after the cache,
  // where a reader asking for 5 seats and a reader asking for 10 share one fan-out
  // instead of invalidating each other's payload.
  const ranked = rankFleetSeats(allSeats);

  const result: FleetUsageFanOutResult = {
    items,
    hosts,
    generatedAt: new Date(nowMs).toISOString(),
    windowHours,
    sinceIso,
    top: ranked,
    topCap: null,
    totalSeatsRanked: ranked.length,
    unknown: allUnknown,
    totals,
    hostTimeoutMs,
    concurrency,
    targetedHostIds,
  };
  if (registryError) result.registryError = registryError;
  return result;
}

// ---------------------------------------------------------------------------
// The short cache: one fan-out serves every reader.
// ---------------------------------------------------------------------------

export interface FleetUsageCache {
  /** `ruleKey` is the window the caller asked for. A payload summed over one window
   *  must not be handed out as an answer about another, so the window is part of
   *  the key rather than a value the builder closed over. The top cap is NOT in the
   *  key: it is a view over a ranking the fan-out already completed. */
  read(fresh: boolean, ruleKey: string): Promise<FleetUsagePayload>;
  clear(): void;
}

export function createFleetUsageCache(
  build: (windowHours: number) => Promise<FleetUsageFanOutResult>,
  opts: { ttlMs?: number; nowMs?: () => number; maxRuleEntries?: number } = {},
  deps: { onBackgroundRefreshError?: (err: unknown) => void } = {},
): FleetUsageCache {
  // The cache is the shared single-flight cache — the same mechanism the summary
  // uses — typed to this read. `FleetUsageFanOutResult` is the payload minus the
  // cache fields, so the stamped output IS the payload; the intersection is
  // structural and the cast states that rather than re-deriving the type here.
  return createSingleFlightCache<FleetUsageFanOutResult, string>(
    (ruleKey) => build(Number(ruleKey)),
    { ttlMs: opts.ttlMs ?? FLEET_CACHE_MS, staleBoundMs: FLEET_STALE_BOUND_MS, nowMs: opts.nowMs, maxRuleEntries: opts.maxRuleEntries },
    deps,
  ) as unknown as FleetUsageCache;
}
