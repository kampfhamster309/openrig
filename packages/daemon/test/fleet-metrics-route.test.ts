// GET /metrics — the ROUTE: auth, content type, what a scrape costs, and what it
// refuses to publish.
//
// The exposition's own rules are owned by `fleet-metrics.test.ts`. This file pins
// what only the route can prove: that a scraper authenticates with the daemon's
// existing bearer and nothing else, that the answer is Prometheus text rather than
// JSON, that an unwired daemon fails the scrape instead of publishing an empty
// fleet, that a bad window is a 400 naming the parameter, and — the claim the whole
// design rests on — that a scrape reuses the fan-out the fleet reads already paid
// for instead of starting one of its own.
//
// The remote legs go through an injected fetch with a call counter, so "no fan-out
// of its own" is a measured number rather than an expectation about caching.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createFleetReads, fleetRoutes } from "../src/routes/fleet.js";
import { metricsRoutes } from "../src/routes/metrics.js";
import { PROMETHEUS_TEXT_FORMAT } from "../src/domain/fleet/fleet-metrics.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import { FLEET_STALL_THRESHOLD_MINUTES_DEFAULT } from "../src/domain/fleet/fleet-settings.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

interface FixtureOpts {
  withServices?: boolean;
  registry?: HostRegistry;
  registryExists?: boolean;
  remoteFetch?: typeof fetch;
  /** The bearer the route gates on. Null/undefined = the loopback posture. */
  bearerToken?: string | null;
  /** Replace the reads entirely — how a test forces a usage leg to fail while the
   *  fleet read answers. */
  reads?: ReturnType<typeof createFleetReads>;
  onUsageReadError?: (err: unknown) => void;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** One team pod, answered the way a shipped image answers it. Every leg the two
 *  fleet reads dial, plus the call counter the cache assertions read. */
function teamPod(counts: { calls: string[] }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const host = new URL(url).hostname.replace(".test", "");
    counts.calls.push(host);
    if (url.includes("/healthz")) {
      return json({
        status: "ok",
        pid: 1,
        selfHostId: host,
        stuckSweep: { lastSweepAt: "2026-10-24T09:59:00.000Z", lastOutcome: "clean", lastError: null, consecutiveFailures: 0, findingsRouted: 2 },
      });
    }
    if (url.includes("/api/ps")) {
      return json([{ rigId: `rig-${host}`, rigName: host, nodeCount: 2, attentionCount: 1, hasWorkCount: 1, runningCount: 2, status: "running", lifecycleState: "running" }]);
    }
    if (url.includes("/nodes")) {
      return json([
        { logicalId: "dev.build", canonicalSessionName: `${host}-build@${host}`, nodeKind: "agent", sessionStatus: "running", activityState: { display: "working" }, lastActivityAt: "2026-10-24T09:58:00.000Z" },
        { logicalId: "orch.lead", canonicalSessionName: `${host}-lead@${host}`, nodeKind: "agent", sessionStatus: "running", activityState: { display: "needs-input", needsInput: { reason: "waiting on a human" } }, lastActivityAt: "2026-10-24T09:50:00.000Z" },
      ]);
    }
    if (url.includes("/api/queue/list")) {
      return json([
        { qitemId: "qitem-20261024100000-aaaa", state: "in-progress", destinationSession: `dev.build@${host}`, sourceSession: `orch.lead@${host}`, blockedOn: null, handedOffTo: null, claimedAt: "2026-10-24T09:00:00.000Z", priority: null, summary: "the work", tags: [], tsCreated: "2026-10-24T08:00:00.000Z", tsUpdated: "2026-10-24T09:00:00.000Z" },
      ]);
    }
    if (url.includes("/api/queue/overdue") || url.includes("/api/queue/undelivered")) return json([]);
    if (url.includes("/api/queue/recent-transitions")) {
      return json([{ ts: "2026-10-24T09:00:00.000Z", rig: host, actorSession: `dev.build@${host}` }]);
    }
    if (url.includes("/api/telemetry/usage/top")) {
      return json({
        windowHours: 1,
        sinceIso: "2026-10-24T09:00:00.000Z",
        ranked: [{ seatSession: `dev.build@${host}`, tokensPerHour: 40_000, tokensDelta: 40_000, resets: 0, spanHours: 1, samples: 3, windows: [] }],
        unknown: [],
        totalRankedSeats: 1,
      });
    }
    return json({});
  }) as typeof fetch;
}

function makeApp(opts: FixtureOpts = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const calls: string[] = [];
  const remoteFetch = opts.remoteFetch ?? teamPod({ calls });
  const reads = opts.reads ?? createFleetReads();
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = (k: string, v: unknown) => c.set(k as never, v as never);
    if (opts.withServices !== false) {
      set("queueRepo", queue);
      set("rigRepo", { db });
      set("psProjectionService", { getEntries: () => [] });
      set("stuckSweepStatus", {
        snapshot: () => ({ lastSweepAt: "2026-10-24T09:59:00.000Z", lastOutcome: "clean", lastError: null, consecutiveFailures: 0, findingsRouted: 0 }),
      });
      set("settingsStore", {
        resolveOne: (key: string) => (key === "fleet.stall_threshold_minutes" ? { value: FLEET_STALL_THRESHOLD_MINUTES_DEFAULT } : { value: undefined }),
      });
    }
    set("remoteFetchImpl", remoteFetch);
    set("hostRegistryExists", () => opts.registryExists ?? opts.registry !== undefined);
    if (opts.registry) set("hostRegistryLoader", () => ({ ok: true, registry: opts.registry }));
    await next();
  });
  // The same holder for both surfaces, exactly as the daemon wires it.
  app.route("/api/fleet", fleetRoutes(reads));
  app.route("/metrics", metricsRoutes({ reads, bearerToken: opts.bearerToken ?? null, onUsageReadError: opts.onUsageReadError }));
  return { app, queue, db, calls, reads };
}

const registry = (ids: string[]): HostRegistry =>
  ({ hosts: ids.map((id) => ({ id, transport: "http", url: `http://${id}.test:7433` })) }) as unknown as HostRegistry;

const scrape = (app: Hono, path = "/metrics") => app.request(path);
const lines = (text: string) => text.split("\n").filter((l) => l && !l.startsWith("#"));
const metricLines = (text: string, metric: string) => lines(text).filter((l) => l.startsWith(`${metric}{`) || l.startsWith(`${metric} `));

describe("GET /metrics — auth", () => {
  it("with no bearer configured it is open, which is where every other read here is open too", async () => {
    const { app } = makeApp({ registryExists: false });
    const res = await scrape(app);
    expect(res.status).toBe(200);
  });

  it("with a bearer configured a scrape without one is a 401, and the daemon's own bearer is enough", async () => {
    const { app } = makeApp({ registryExists: false, bearerToken: "scrape-me" });
    const anonymous = await scrape(app);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error).toBe("unauthorized");

    const wrong = await app.request("/metrics", { headers: { authorization: "Bearer other" } });
    expect(wrong.status).toBe(401);

    const right = await app.request("/metrics", { headers: { authorization: "Bearer scrape-me" } });
    expect(right.status).toBe(200);
  });
});

describe("GET /metrics — the scrape contract", () => {
  it("answers Prometheus text, not JSON", async () => {
    const { app } = makeApp({ registryExists: false });
    const res = await scrape(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PROMETHEUS_TEXT_FORMAT);
    const body = await res.text();
    expect(body).toContain("# TYPE openrig_fleet_host_up gauge");
    expect(body).toContain(`openrig_fleet_host_up{host="${LOCAL_HOST_ID}"} 1`);
  });

  it("an unwired daemon fails the scrape rather than publishing an empty fleet", async () => {
    const { app } = makeApp({ withServices: false });
    const res = await scrape(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "fleet_metrics_unavailable" });
  });

  it("a bad window is a 400 naming the parameter, never a silent default", async () => {
    const { app } = makeApp({ registryExists: false });
    for (const bad of ["0", "-2", "nope"]) {
      const res = await scrape(app, `/metrics?window_hours=${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("metrics_invalid_request");
      expect(body.error).toContain("window_hours");
    }
  });

  it("reports the local host alone when nothing is registered", async () => {
    const { app } = makeApp({ registryExists: false });
    const body = await (await scrape(app)).text();
    expect(metricLines(body, "openrig_fleet_host_up")).toEqual([`openrig_fleet_host_up{host="${LOCAL_HOST_ID}"} 1`]);
  });
});

describe("GET /metrics — what a scrape costs", () => {
  it("reuses the fan-out the fleet reads already paid for, and adds none of its own", async () => {
    const { app, calls } = makeApp({ registry: registry(["alpha"]) });

    await app.request("/api/fleet/summary");
    await app.request("/api/fleet/usage");
    const afterFleetReads = calls.length;
    expect(afterFleetReads).toBeGreaterThan(0);

    // The scrape that matters: a fresh cache for BOTH reads, so it must dial nothing.
    const first = await scrape(app);
    expect(first.status).toBe(200);
    expect(calls.length, "a scrape with a fresh cache caused a fan-out").toBe(afterFleetReads);

    // And so does the next one, and the one after that.
    await scrape(app);
    expect(calls.length).toBe(afterFleetReads);

    // `?fresh=1` is the same escape hatch the fleet reads offer, and it costs what it
    // says it costs: both reads again.
    const before = calls.length;
    await scrape(app, "/metrics?fresh=1");
    expect(calls.length).toBeGreaterThan(before);
  });

  it("a metrics route on its own reads pays for its own fan-out — which is why the daemon shares one", async () => {
    const shared = makeApp({ registry: registry(["alpha"]) });
    await shared.app.request("/api/fleet/summary");
    await shared.app.request("/api/fleet/usage");
    const sharedCalls = shared.calls.length;
    await shared.app.request("/metrics");
    expect(shared.calls.length).toBe(sharedCalls);

    // Same fleet, second holder: the scrape is on its own cold cache.
    const lonely = makeApp({ registry: registry(["alpha"]) });
    await lonely.app.request("/metrics");
    expect(lonely.calls.length).toBeGreaterThan(0);
  });

  it("carries a remote team through to the exposition: up, seats, queue, usage", async () => {
    const { app } = makeApp({ registry: registry(["alpha"]) });
    const body = await (await scrape(app)).text();
    expect(body).toContain('openrig_fleet_host_up{host="alpha"} 1');
    expect(body).toContain('openrig_fleet_seats{activity="needs-input",host="alpha",rig="alpha"} 1');
    expect(body).toContain('openrig_fleet_seats{activity="working",host="alpha",rig="alpha"} 1');
    expect(body).toContain('openrig_fleet_usage_sampled_tokens_delta{host="alpha"} 40000');
    expect(body).toContain('openrig_fleet_stuck_sweep_findings_routed_total{host="alpha"} 2');
    // The reason a scraper cannot confuse this with a per-seat feed: no session names.
    expect(body).not.toContain("dev.build@alpha");
    expect(body).not.toContain("waiting on a human");
  });

  it("a host nobody reaches is up 0 and nothing else, on the real fan-out", async () => {
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const live = teamPod({ calls: [] });
    const both = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("gone.test")) throw new Error("ECONNREFUSED");
      return live(input, init);
    }) as typeof fetch;
    const { app } = makeApp({ registry: registry(["alpha", "gone"]), remoteFetch: both });
    const body = await (await scrape(app)).text();
    expect(body).toContain('openrig_fleet_host_up{host="gone"} 0');
    expect(body).toContain('openrig_fleet_host_read_status{host="gone",status="unreachable"} 1');
    const aboutGone = lines(body).filter((l) => l.includes('host="gone"')).map((l) => l.split("{")[0]);
    expect([...new Set(aboutGone)].sort()).toEqual(["openrig_fleet_host_read_status", "openrig_fleet_host_up"]);
    expect(body).toContain('openrig_fleet_host_up{host="alpha"} 1');
  });
});

describe("GET /metrics — a partial scrape is disclosed", () => {
  it("publishes the fleet without the usage numbers, and says so", async () => {
    const failures: unknown[] = [];
    const base = createFleetReads();
    const { app } = makeApp({
      registryExists: false,
      onUsageReadError: (err) => failures.push(err),
      reads: {
        readSummary: (c, fresh) => base.readSummary(c, fresh),
        readUsage: () => Promise.reject(new Error("usage leg exploded")),
      },
    });
    const res = await scrape(app);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("openrig_fleet_usage_read_ok 0");
    expect(body).not.toContain("openrig_fleet_usage_sampled_tokens_delta");
    expect(body).toContain(`openrig_fleet_host_up{host="${LOCAL_HOST_ID}"} 1`);
    expect(failures).toHaveLength(1);
  });
});
