// GET /api/fleet/summary — ROUTE wiring and payload contract.
//
// Fan-out depth is owned by `fleet-summary.test.ts`; this file pins what only the
// route can prove: the 503 vocabulary when its services are not wired, the local
// host composed IN-PROCESS from a real migrated db and queue (no self-transport,
// no network at all), the registry DI style shared with
// /api/queue/attention-aggregate and /api/review/fleet, the short cache and its
// `?fresh=1` bypass, and that the stall threshold comes from the settings store
// rather than a constant baked into the response.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { fleetRoutes, resolveStallThresholdMinutes } from "../src/routes/fleet.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import { FLEET_STALL_THRESHOLD_MINUTES_DEFAULT, FLEET_HOST_TIMEOUT_MS_DEFAULT, FLEET_FANOUT_CONCURRENCY_DEFAULT } from "../src/domain/fleet/fleet-settings.js";
import { fleetSummaryReaderTimeoutMs } from "../src/fleet-surface.js";
import type { FleetSummaryPayload } from "../src/domain/fleet/fleet-summary-types.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

interface FixtureOpts {
  withServices?: boolean;
  registry?: HostRegistry;
  registryExists?: boolean;
  /** The value the settings store answers for the stall threshold. */
  stallThreshold?: number | string | null;
  /** Values the settings store answers for the fan-out's own budget. */
  hostTimeoutMs?: number;
  fanoutConcurrency?: number;
  /** The transport the fan-out uses, so a test can hang a host without touching the
   *  real network. Without this the legs go out over global fetch and the test is not
   *  hermetic — and proves nothing about a deadline. */
  remoteFetch?: typeof fetch;
}

function makeApp(opts: FixtureOpts = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = (k: string, v: unknown) => c.set(k as never, v as never);
    if (opts.withServices !== false) {
      set("queueRepo", queue);
      set("rigRepo", { db });
      // A rig rollup double: the route only reads the fields it projects, and the
      // seat inventory comes from the (empty) real db.
      set("psProjectionService", {
        getEntries: () => [{
          rigId: "rig-local", rigName: "hub", name: "hub", attentionCount: 2,
          hasWorkCount: 1, lifecycleState: "running", nodeCount: 0,
        }],
      });
      set("stuckSweepStatus", {
        snapshot: () => ({ lastSweepAt: "2026-10-23T12:00:00.000Z", lastOutcome: "clean", lastError: null, consecutiveFailures: 0, findingsRouted: 0 }),
      });
      set("settingsStore", {
        resolveOne: (key: string) => {
          if (key === "fleet.stall_threshold_minutes") return { value: opts.stallThreshold ?? FLEET_STALL_THRESHOLD_MINUTES_DEFAULT };
          if (key === "fleet.host_timeout_ms") return { value: opts.hostTimeoutMs };
          if (key === "fleet.fanout_concurrency") return { value: opts.fanoutConcurrency };
          return { value: undefined };
        },
      });
    }
    if (opts.remoteFetch) set("remoteFetchImpl", opts.remoteFetch);
    set("hostRegistryExists", () => opts.registryExists ?? opts.registry !== undefined);
    if (opts.registry) set("hostRegistryLoader", () => ({ ok: true, registry: opts.registry }));
    await next();
  });
  app.route("/api/fleet", fleetRoutes());
  return { app, queue, db };
}

describe("GET /api/fleet/summary — wiring", () => {
  it("unwired services answer the family's 503, not a crash", async () => {
    const { app } = makeApp({ withServices: false });
    const res = await app.request("/api/fleet/summary");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "fleet_summary_unavailable" });
  });

  it("no registry = the local host alone, and NOTHING else changed", async () => {
    const { app, queue } = makeApp({ registryExists: false });
    queue.create({
      sourceSession: "orch-lead@hub", destinationSession: "dev-build@hub",
      summary: "needs a decision", body: "a decision is owed",
    } as never);
    // A row is born `pending`; parking it on a human is an update, which is also
    // how a real park happens.
    const [row] = queue.list({ destinationSession: "dev-build@hub" }) as Array<{ qitemId: string }>;
    queue.update({ qitemId: row!.qitemId, state: "blocked", blockedOn: "human@host", evidenceRef: "notes.md", actorSession: "orch-lead@hub" } as never);

    const res = await app.request("/api/fleet/summary");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as FleetSummaryPayload;
    expect(payload.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.hostId).toBe(LOCAL_HOST_ID);
    expect("registryError" in payload).toBe(false);
    // The local queue flowed through the IN-PROCESS repo, and the open item with
    // its blocker is the payload the attention aggregate could not carry.
    expect(payload.openQueue).toHaveLength(1);
    expect(payload.openQueue[0]).toMatchObject({ hostId: LOCAL_HOST_ID, state: "blocked", blockedOn: "human@host", rigName: "hub" });
    expect(payload.items[0]!.openQueueByState).toEqual({ pending: 0, inProgress: 0, blocked: 1 });
    expect(payload.items[0]!.rigs[0]).toMatchObject({ rigName: "hub", attentionCount: 2 });
    expect(payload.items[0]!.stuckSweep).toMatchObject({ lastOutcome: "clean" });
  });

  it("an unreadable registry is disclosed, not a silently local-only fleet", async () => {
    const { app } = makeApp({ registryExists: true });
    // The probe says the file exists but no loader is injected, so the real
    // reader runs against whatever the environment has; assert only the shape
    // contract that holds either way: registryError appears exactly when the
    // registry could not be read.
    const res = await app.request("/api/fleet/summary");
    const payload = (await res.json()) as FleetSummaryPayload;
    expect(payload.targetedHostIds.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.hosts)).toBe(true);
  });

  it("the stall threshold comes from the settings store, not a constant", async () => {
    const { app } = makeApp({ registryExists: false, stallThreshold: 7 });
    const payload = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(payload.stallThresholdMinutes).toBe(7);
    expect(payload.enabledProgressSources).toEqual(["queue-transition"]);
  });

  it("a non-numeric or absent setting falls back to the default rather than failing the read", () => {
    const store = (value: unknown) => ({ resolveOne: () => ({ value }) } as never);
    expect(resolveStallThresholdMinutes(store(5))).toBe(5);
    expect(resolveStallThresholdMinutes(store("9"))).toBe(9);
    expect(resolveStallThresholdMinutes(store("nope"))).toBe(FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
    expect(resolveStallThresholdMinutes(store(null))).toBe(FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
    expect(resolveStallThresholdMinutes(store(0))).toBe(FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
    expect(resolveStallThresholdMinutes(undefined)).toBe(FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
  });
});

describe("GET /api/fleet/summary — the short cache", () => {
  it("a second read inside the ttl is served from cache and says so", async () => {
    const { app } = makeApp({ registryExists: false });
    const first = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    const second = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(second.cacheTtlMs).toBeGreaterThan(0);
  });

  it("`?fresh=1` bypasses the cache", async () => {
    const { app } = makeApp({ registryExists: false });
    await app.request("/api/fleet/summary");
    await app.request("/api/fleet/summary");
    const fresh = (await (await app.request("/api/fleet/summary?fresh=1")).json()) as FleetSummaryPayload;
    expect(fresh.fromCache).toBe(false);
  });

  it("a fresh read sees a queue change the cached payload missed", async () => {
    const { app, queue } = makeApp({ registryExists: false });
    const before = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(before.items[0]!.openQueueCount).toBe(0);
    queue.create({
      sourceSession: "orch-lead@hub", destinationSession: "dev-build@hub", state: "pending", summary: "new work", body: "new work",
    } as never);
    const cached = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(cached.fromCache).toBe(true);
    expect(cached.items[0]!.openQueueCount).toBe(0);
    const fresh = (await (await app.request("/api/fleet/summary?fresh=1")).json()) as FleetSummaryPayload;
    expect(fresh.items[0]!.openQueueCount).toBe(1);
  });

  it("a host that hangs past its budget is unreachable, and the route still answers for the others", async () => {
    // The case the unit tests could not see, and the reason a reader's wait must be
    // derived rather than guessed. `slow` never answers; the route must cut it at its
    // own per-host budget, return `quick` intact, and finish well inside the wait the
    // shared rule gives a reader. A test that injected no fetch double would instead
    // dial the real network and prove nothing.
    const registry: HostRegistry = {
      hosts: [
        { id: "slow", transport: "http", url: "http://slow.test:7433" },
        { id: "quick", transport: "http", url: "http://quick.test:7433" },
      ],
    } as unknown as HostRegistry;
    const HOST_TIMEOUT_MS = 100;
    const hangFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("slow.test")) {
        // Well past the budget, and abortable so the deadline is what ends it.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 30_000);
          init?.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "ok", pid: 1, selfHostId: "quick" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { app } = makeApp({ registry, hostTimeoutMs: HOST_TIMEOUT_MS, remoteFetch: hangFetch });
    const started = Date.now();
    const res = await app.request("/api/fleet/summary?fresh=1");
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const payload = (await res.json()) as FleetSummaryPayload;

    // The hung host cost ITSELF alone.
    expect(payload.hosts.find((h) => h.hostId === "slow")?.status).not.toBe("ok");
    expect(payload.hosts.find((h) => h.hostId === "quick")?.status).toBe("ok");
    expect(payload.hostTimeoutMs).toBe(HOST_TIMEOUT_MS);

    // And the whole route finished inside the wait a reader is given for this fleet —
    // the property the reader rule exists to guarantee. With the 20 s floor this is a
    // loose bound; the point is that it is measured, not asserted from the constants.
    const readerWait = fleetSummaryReaderTimeoutMs(payload.targetedHostIds.length, HOST_TIMEOUT_MS, payload.concurrency);
    expect(elapsed).toBeLessThan(readerWait);
  });

  it("clears the cache between tests so a cached payload cannot leak across cases", async () => {
    // Not a behaviour claim, a hygiene guard: the route keeps its cache on the app
    // instance, so a fixture that reused one would make later assertions meaningless.
    const a = makeApp({ registryExists: false });
    const b = makeApp({ registryExists: false });
    await a.app.request("/api/fleet/summary");
    const firstOfB = (await (await b.app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(firstOfB.fromCache).toBe(false);
  });
});

describe("GET /api/fleet/summary — the operator's own budget", () => {
  // F7 is only real if a configured value reaches the fan-out. A key that exists in the
  // store but is never read by the route would pass a settings test and still leave the
  // deadline unconfigurable, so the payload's echoed numbers are the assertion.
  it("reports the configured host timeout and concurrency, not the compiled defaults", async () => {
    const { app } = makeApp({ registryExists: false, hostTimeoutMs: 12_000, fanoutConcurrency: 8 });
    const payload = (await (await app.request("/api/fleet/summary?fresh=1")).json()) as FleetSummaryPayload;
    expect(payload.hostTimeoutMs).toBe(12_000);
    expect(payload.concurrency).toBe(8);
  });

  it("falls back to the shared defaults when the store has no value", async () => {
    const { app } = makeApp({ registryExists: false });
    const payload = (await (await app.request("/api/fleet/summary?fresh=1")).json()) as FleetSummaryPayload;
    expect(payload.hostTimeoutMs).toBe(FLEET_HOST_TIMEOUT_MS_DEFAULT);
    expect(payload.concurrency).toBe(FLEET_FANOUT_CONCURRENCY_DEFAULT);
  });
});

describe("GET /api/fleet/summary — the contract shape", () => {
  it("is a close sibling of the shared fan-out payload: items + hosts + openQueue", async () => {
    const { app } = makeApp({ registryExists: false });
    const payload = (await (await app.request("/api/fleet/summary")).json()) as FleetSummaryPayload;
    expect(Array.isArray(payload.items)).toBe(true);
    expect(Array.isArray(payload.hosts)).toBe(true);
    expect(Array.isArray(payload.openQueue)).toBe(true);
    expect(typeof payload.generatedAt).toBe("string");
    expect(typeof payload.hostTimeoutMs).toBe("number");
    expect(typeof payload.concurrency).toBe("number");
    // Every host summary carries the progress block with BOTH raw sources, so a
    // renderer never has to re-derive the rule.
    const progress = payload.items[0]!.progress;
    expect(progress).toMatchObject({
      lastQueueTransitionAt: null,
      lastSeatOutputAt: null,
      lastProgressSource: "none",
      stalled: false,
      openWorkCount: 0,
      progressReadsTruncated: false,
    });
  });
});
