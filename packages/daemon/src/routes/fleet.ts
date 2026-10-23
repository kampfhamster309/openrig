// The fleet read surface: GET /api/fleet/summary and GET /api/fleet/usage.
//
// One daemon-side fan-out MACHINERY (domain/fleet/fleet-fanout.ts) behind both,
// answering, for every host the operator registered:
//   /summary — is it reachable, what rigs and seats does it have, what is open on
//     its queue (in EVERY open state, with what it is blocked on), and — the signal
//     nothing else gave — has it stopped making progress.
//   /usage — what every team is using, composed from the usage read every pod
//     already serves, summed only where the numbers honestly add.
//
// The local host is composed in-process from the same services the shipped
// routes use; remote hosts are read over the shared bearer transport using only
// routes an OLD team-pod daemon already serves. Bearers never leave the daemon.
//
// A short cache with single-flight means one fan-out serves every TUI and CLI
// reader at once; `?fresh=1` bypasses it.

import { existsSync } from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { defaultHostRegistryPath, loadHostRegistry, type HostRegistryLoadResult } from "../domain/hosts/hosts-registry-reader.js";
import { attachTerminalActivityAndWork, getNodeInventoryForAllRigs } from "../domain/node-inventory.js";
import type { PsProjectionService } from "../domain/ps-projection.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import type { StuckSweepStatus } from "../domain/queue-stuck-sweep.js";
import type { SeatActivityService } from "../domain/seat-activity-service.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import type { NodeInventoryEntry } from "../domain/types.js";
import {
  byNewestUpdated,
  composeFleetSummary,
  createFleetSummaryCache,
  FLEET_QUEUE_PAGE_LIMIT,
  FLEET_STALL_THRESHOLD_MINUTES_DEFAULT,
  FLEET_SUMMARY_CACHE_MS,
  FLEET_TRANSITION_ITEM_LIMIT,
  FLEET_TRANSITION_WINDOW,
  type FleetFanOutResult,
  type FleetSummaryCache,
  type LocalHostFacts,
} from "../domain/fleet/fleet-summary.js";
import {
  FLEET_FANOUT_CONCURRENCY_DEFAULT,
  FLEET_HOST_TIMEOUT_MS_DEFAULT,
  FLEET_FANOUT_CONCURRENCY_KEY,
  FLEET_HOST_TIMEOUT_MS_KEY,
  FLEET_STALL_THRESHOLD_MINUTES_KEY,
} from "../domain/fleet/fleet-settings.js";
import { computeTopBurn } from "../domain/usage-series.js";
import {
  composeFleetUsage,
  createFleetUsageCache,
  type FleetUsageCache,
  type UsageLeg,
} from "../domain/fleet/fleet-usage.js";
import type { FleetUsageWindow } from "../domain/fleet/fleet-usage.js";

/** The usage cache, per route module / daemon process, for the same reason the
 *  summary's is: one fan-out serves every reader, and a test that builds a fresh
 *  app gets a fresh cache. */
const usageCaches = new WeakMap<Hono, FleetUsageCache>();

/** The cache lives per route module, which is per daemon process. A test that
 *  builds a fresh app gets a fresh cache; a production daemon has exactly one,
 *  which is the point (one fan-out, every reader). */
const caches = new WeakMap<Hono, FleetSummaryCache>();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    psService: c.get("psProjectionService" as never) as PsProjectionService | undefined,
    rigRepo: c.get("rigRepo" as never) as { db: Database.Database } | undefined,
    queueRepo: c.get("queueRepo" as never) as QueueRepository | undefined,
    seatActivityService: c.get("seatActivityService" as never) as SeatActivityService | undefined,
    stuckSweepStatus: c.get("stuckSweepStatus" as never) as StuckSweepStatus | undefined,
    settingsStore: c.get("settingsStore" as never) as SettingsStore | undefined,
    registryLoader: (c.get("hostRegistryLoader" as never) as (() => HostRegistryLoadResult) | undefined) ?? loadHostRegistry,
    registryProbe: (c.get("hostRegistryExists" as never) as (() => boolean) | undefined) ?? (() => existsSync(defaultHostRegistryPath())),
    fetchImpl: c.get("remoteFetchImpl" as never) as typeof fetch | undefined,
  };
}

/** One positive-integer setting, or the default. A bad value never silences the
 *  read and never becomes a zero timeout or a zero-wide fan-out. */
function resolvePositiveMinutes(store: SettingsStore | undefined, key: string, fallback: number): number {
  if (!store) return fallback;
  try {
    const raw = store.resolveOne(key as never).value;
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** The stall threshold, re-read per fan-out so a settings flip applies to the
 *  next read (the stuck-sweep cadence precedent). A bad value never silences the
 *  read: it falls back to the default. */
export function resolveStallThresholdMinutes(store: SettingsStore | undefined): number {
  return resolvePositiveMinutes(store, FLEET_STALL_THRESHOLD_MINUTES_KEY, FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
}

/** How long one host leg may take, and how many run at once. Both operator-set, for
 *  the same reason the threshold is: a hub with a slow team and a hub with thirty
 *  teams want different numbers, and neither should need a code change. */
export function resolveHostTimeoutMs(store: SettingsStore | undefined): number {
  return resolvePositiveMinutes(store, FLEET_HOST_TIMEOUT_MS_KEY, FLEET_HOST_TIMEOUT_MS_DEFAULT);
}

export function resolveFanoutConcurrency(store: SettingsStore | undefined): number {
  return resolvePositiveMinutes(store, FLEET_FANOUT_CONCURRENCY_KEY, FLEET_FANOUT_CONCURRENCY_DEFAULT);
}

/** The usage window, validated exactly as the single-host route validates it — the
 *  hub must not accept a window its own remote legs would reject with a 400. A bad
 *  value is a 400 naming the parameter, never a silent default that leaves the
 *  reader holding numbers for a window nobody asked for. */
function resolveUsageWindow(raw: string | undefined): { windowHours: number } | { error: string } {
  const value = raw === undefined || raw === "" ? 1 : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `invalid window_hours "${raw}" — must be a positive number of hours` };
  }
  if (!Number.isFinite(new Date(Date.now() - value * 3_600_000).getTime())) {
    return { error: `invalid window_hours "${raw}" — exceeds the supported date range` };
  }
  return { windowHours: value };
}

function resolveUsageTop(raw: string | undefined): { top: number | undefined } | { error: string } {
  if (raw === undefined || raw === "") return { top: undefined };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return { error: `invalid top "${raw}" — must be a positive count` };
  }
  return { top: value };
}

/** The LOCAL host's facts, read from the same services `/api/ps` and
 *  `/api/rigs/:id/nodes` serve. No self-transport, and no second copy of the
 *  seat-activity enrichment — `attachTerminalActivityAndWork` is capture-free
 *  (it reads the cached observations), so this stays cheap enough to poll. */
export function buildLocalHostFacts(deps: ReturnType<typeof getDeps>): LocalHostFacts {
  const empty: LocalHostFacts = {
    selfHostId: null,
    stuckSweep: null,
    rigs: [],
    openQueue: [],
    overdueCount: 0,
    undeliveredCount: 0,
    recentTransitions: [],
    openItemTransitions: [],
    openItemTransitionsTruncated: false,
  };
  const { psService, rigRepo, queueRepo, seatActivityService, stuckSweepStatus } = deps;
  if (!psService || !rigRepo || !queueRepo) return empty;

  const db = rigRepo.db;
  const inventoryByRig = getNodeInventoryForAllRigs(db);
  const enriched = new Map<string, NodeInventoryEntry[]>();
  for (const [rigId, entries] of inventoryByRig) {
    enriched.set(rigId, attachTerminalActivityAndWork(entries, { db, seatActivity: seatActivityService }));
  }

  const rigs = psService.getEntries({ includeArchived: false, archivedOnly: false }).map((entry) => {
    const seats = enriched.get(entry.rigId) ?? [];
    return {
      rigId: entry.rigId,
      rigName: entry.rigName ?? entry.name,
      attentionCount: entry.attentionCount ?? 0,
      seatsWithAssignedWork: entry.hasWorkCount ?? 0,
      lifecycleState: entry.lifecycleState ?? null,
      // The origin's own running/status pair, not a seat count. A rig with declared
      // but stopped seats must read stopped here exactly as it does remotely.
      runningCount: entry.runningCount ?? null,
      psStatus: entry.status ?? null,
      seats: seats.map((seat) => ({
        // The origin's own pre-derived display value. Absent/null = no answer,
        // which counts as `unknown`, never as `idle`.
        display: seat.activityState?.display ?? null,
        lastActivityAt: seat.lastActivityAt ?? null,
        logicalId: seat.logicalId ?? null,
        canonicalSessionName: seat.canonicalSessionName ?? null,
        nodeKind: seat.nodeKind ?? null,
        sessionStatus: seat.sessionStatus ?? null,
        role: seat.role ?? null,
        runtime: seat.runtime ?? null,
        needsInputReason: seat.activityState?.needsInput?.reason ?? null,
        lifecycleState: seat.lifecycleState ?? null,
        startupStatus: seat.startupStatus ?? null,
      })),
    };
  });

  // Note-only updates are not in recent-transitions, and the stall rule counts
  // them, so each open item's own log is read. In-process this is a cheap indexed
  // read; the bound keeps a pathological queue from costing unbounded rows.
  //
  // The bound is applied to the items with the NEWEST `tsUpdated`, NOT to the order
  // the list came back in. `/list` is `ts_created DESC`, so slicing the head would
  // spend the whole budget on the youngest items — and the items carrying milestone
  // notes are the long-running old ones. A note bumps `tsUpdated`, so this ordering
  // reads the logs most likely to contain the evidence the rule needs.
  const openQueueRows = queueRepo.list({
    state: ["pending", "in-progress", "blocked"],
    limit: FLEET_QUEUE_PAGE_LIMIT,
  }) as unknown as Array<Record<string, unknown>>;

  const itemsWithTransitions = byNewestUpdated(openQueueRows).slice(0, FLEET_TRANSITION_ITEM_LIMIT);
  const openItemTransitions = itemsWithTransitions
    .filter((row): row is Record<string, unknown> & { qitemId: string } => typeof row["qitemId"] === "string")
    .map((row) => ({
      qitemId: row.qitemId,
      transitions: queueRepo.listTransitions(row.qitemId).map((t) => ({
        ts: t.ts ?? null,
        actorSession: t.actorSession ?? null,
      })),
    }));

  return {
    selfHostId: null,
    stuckSweep: stuckSweepStatus ? stuckSweepStatus.snapshot() : null,
    rigs,
    openQueue: openQueueRows,
    overdueCount: queueRepo.findOverdue({ limit: FLEET_QUEUE_PAGE_LIMIT, compact: true }).length,
    undeliveredCount: queueRepo.findUndelivered({ limit: FLEET_QUEUE_PAGE_LIMIT, compact: true }).length,
    recentTransitions: queueRepo
      .listRecentTransitions({ kind: "instance" }, FLEET_TRANSITION_WINDOW)
      .map((t) => ({ ts: t.ts ?? null, rig: t.rig ?? null, actorSession: t.actorSession ?? null })),
    openItemTransitions,
    openItemTransitionsTruncated: openQueueRows.length > itemsWithTransitions.length,
  };
}

export function fleetRoutes(): Hono {
  const app = new Hono();

  app.get("/summary", async (c) => {
    const deps = getDeps(c);
    if (!deps.psService || !deps.rigRepo || !deps.queueRepo) {
      return c.json({ error: "fleet_summary_unavailable" }, 503);
    }
    const fresh = c.req.query("fresh") === "1";

    // The threshold is resolved INSIDE the build, per fan-out. Resolving it here and
    // closing over it would freeze whatever the first request happened to see: the
    // payload would then state one threshold while the verdicts were computed under
    // another, which is worse than not reporting it at all. The cache is keyed on it
    // for the same reason — a cached verdict judged by the old rule must not be
    // served as if the new one had been applied.
    let cache = caches.get(app);
    if (!cache) {
      cache = createFleetSummaryCache(
        (thresholdMinutes) => composeFleetSummary({
          readLocalHost: () => buildLocalHostFacts(deps),
          loadRegistry: deps.registryLoader,
          registryExists: deps.registryProbe,
          stallThresholdMinutes: thresholdMinutes,
          hostTimeoutMs: resolveHostTimeoutMs(deps.settingsStore),
          concurrency: resolveFanoutConcurrency(deps.settingsStore),
          fetchImpl: deps.fetchImpl,
        }),
        { ttlMs: FLEET_SUMMARY_CACHE_MS },
        {
          // A background refresh nobody awaits. Swallowing the rejection is required
          // (an unhandled rejection would take the daemon down); saying nothing is not.
          // If this repeats, the page is being served an increasingly stale fleet.
          onBackgroundRefreshError: (err) => {
            console.warn(`[fleet/summary] background refresh failed; serving stale until the bound: ${(err as Error)?.message ?? String(err)}`);
          },
        },
      );
      caches.set(app, cache);
    }
    const payload = await cache.read(fresh, resolveStallThresholdMinutes(deps.settingsStore));
    // `payload.stallThresholdMinutes` is the rule the verdicts were actually judged
    // under, so it is what gets echoed. A reader never renders a rule that was not
    // applied, and never has to guess which one produced the verdicts.
    return c.json(payload);
  });

  // GET /api/fleet/usage — what every team is using, read from the hub.
  //
  // WHAT THESE NUMBERS ARE, and they are worth stating because a reader will
  // otherwise assume more precision than exists: they are SAMPLED readings of each
  // seat's context window and provider window, good for "which team is burning
  // fastest right now". They are NOT exact token or cost accounting — nothing here
  // is metered against a bill, and a seat that was idle between samples shows less
  // than it used. A host that did not answer is reported as unknown and adds
  // nothing to a total; it is never shown as zero.
  app.get("/usage", async (c) => {
    const deps = getDeps(c);
    if (!deps.rigRepo) return c.json({ error: "fleet_usage_unavailable" }, 503);
    const window = resolveUsageWindow(c.req.query("window_hours"));
    if ("error" in window) return c.json({ code: "fleet_usage_invalid_request", error: window.error }, 400);
    const top = resolveUsageTop(c.req.query("top"));
    if ("error" in top) return c.json({ code: "fleet_usage_invalid_request", error: top.error }, 400);
    const fresh = c.req.query("fresh") === "1";
    const db = deps.rigRepo.db;

    let cache = usageCaches.get(app);
    if (!cache) {
      cache = createFleetUsageCache(
        (windowHours) => composeFleetUsage({
          // The LOCAL host in-process, the same ruling the summary's local leg
          // follows. On a hub this is usually empty — a hub has no seats — and an
          // operator running this daemon as their only host gets their own teams.
          readLocalUsage: (w: FleetUsageWindow): UsageLeg => {
            try {
              return { ok: true, body: computeTopBurn(db, { windowHours: w.windowHours, nowIso: new Date().toISOString() }) };
            } catch (err) {
              // No samples table, an unreadable db — either way this host's usage is
              // UNKNOWN, which is a different fact from "this host used nothing".
              return { ok: false, reason: `this daemon's own usage samples could not be read: ${(err as Error)?.message ?? String(err)}` };
            }
          },
          loadRegistry: deps.registryLoader,
          registryExists: deps.registryProbe,
          windowHours,
          hostTimeoutMs: resolveHostTimeoutMs(deps.settingsStore),
          concurrency: resolveFanoutConcurrency(deps.settingsStore),
          fetchImpl: deps.fetchImpl,
        }),
        {},
        {
          onBackgroundRefreshError: (err) => {
            console.warn(`[fleet/usage] background refresh failed; serving stale until the bound: ${(err as Error)?.message ?? String(err)}`);
          },
        },
      );
      usageCaches.set(app, cache);
    }
    const payload = await cache.read(fresh, String(window.windowHours));
    // The cap is applied AFTER the cache, because it is a view over a ranking the
    // fan-out already completed, not a rule it was judged under. A reader asking for
    // 5 seats and a reader asking for 10 then share one fan-out instead of
    // invalidating each other's payload. `topCap` is echoed so a reader never
    // renders a cut list as the whole fleet, and `totalSeatsRanked` says how much
    // of the fleet the cut left out.
    if (top.top === undefined) return c.json(payload);
    const cap = Math.max(1, Math.floor(top.top));
    return c.json({ ...payload, top: payload.top.slice(0, cap), topCap: cap });
  });

  return app;
}
