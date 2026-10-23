// GET /api/fleet/usage — ROUTE wiring and payload contract.
//
// The fan-out's own behaviour is owned by `fleet-usage.test.ts`; this file pins
// what only the route can prove: the 503 vocabulary when its services are not
// wired, the request validation, the LOCAL host composed IN-PROCESS from a real
// migrated db (no self-transport, no network at all), the registry DI style shared
// with /api/fleet/summary, the short cache and its `?fresh=1` bypass, and that the
// top cap is a view over one shared fan-out rather than a second one.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import BetterSqlite3 from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { fleetRoutes } from "../src/routes/fleet.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import { FLEET_HOST_TIMEOUT_MS_DEFAULT, FLEET_FANOUT_CONCURRENCY_DEFAULT } from "../src/domain/fleet/fleet-settings.js";
import type { FleetUsagePayload } from "../src/domain/fleet/fleet-usage-types.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

interface FixtureOpts {
  withServices?: boolean;
  registry?: HostRegistry;
  registryExists?: boolean;
  hostTimeoutMs?: number;
  fanoutConcurrency?: number;
  /** The transport the fan-out uses, so a test can hang a host without touching the
   *  real network. Without this the legs go out over global fetch and the test is
   *  neither hermetic nor a proof about a deadline. */
  remoteFetch?: typeof fetch;
  /** Seed the local daemon's own usage samples (relative to now, because the
   *  local leg computes its window from the real clock). */
  seedLocal?: boolean;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** A `usage/top` body shaped exactly as the remote image answers it. */
function topBody(seats: Array<{ seatSession: string; tokensPerHour: number; tokensDelta: number }>, windowHours = 1) {
  return {
    windowHours,
    sinceIso: "2026-10-23T11:00:00.000Z",
    ranked: seats.map((s) => ({ ...s, resets: 0, spanHours: 1, samples: 2, windows: [] })),
    unknown: [],
    totalRankedSeats: seats.length,
  };
}

function makeApp(opts: FixtureOpts = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = (k: string, v: unknown) => c.set(k as never, v as never);
    if (opts.withServices !== false) {
      set("rigRepo", { db });
      set("settingsStore", {
        resolveOne: (key: string) => {
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

  if (opts.seedLocal) {
    const store = new UsageSamplesStore(db as never);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    // Two samples in the window: a burn is a DELTA, so one sample ranks nothing.
    store.appendContextSample({
      nodeId: "n-hub", seatSession: "dev-build@hub", source: "claude_statusline_json",
      sampledAt: at(20), totalInputTokens: 1_000, totalOutputTokens: 500, usedPercentage: 10,
    } as never, at(20));
    store.appendContextSample({
      nodeId: "n-hub", seatSession: "dev-build@hub", source: "claude_statusline_json",
      sampledAt: at(5), totalInputTokens: 3_000, totalOutputTokens: 900, usedPercentage: 22,
    } as never, at(5));
  }
  return { app, db };
}

const registry = (ids: string[]): HostRegistry =>
  ({ hosts: ids.map((id) => ({ id, transport: "http", url: `http://${id}.test:7433` })) }) as unknown as HostRegistry;

function replyFetch(replies: Record<string, { health?: Response; usage?: Response }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hostId = new URL(url).hostname.replace(".test", "");
    const reply = replies[hostId] ?? {};
    if (url.includes("/healthz")) return reply.health ?? json({ ok: true });
    return reply.usage ?? json(topBody([]));
  }) as typeof fetch;
}

const get = (app: Hono, path = "/api/fleet/usage") => app.request(path);
const body = async (app: Hono, path?: string) => (await get(app, path)).json() as Promise<FleetUsagePayload>;

describe("GET /api/fleet/usage — wiring", () => {
  it("an unwired daemon answers the family's 503, not a crash", async () => {
    const { app } = makeApp({ withServices: false });
    const res = await get(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "fleet_usage_unavailable" });
  });

  it("a bad window is a 400 naming the parameter, never a silent default", async () => {
    const { app } = makeApp({ registryExists: false });
    for (const bad of ["0", "-2", "nope"]) {
      const res = await get(app, `/api/fleet/usage?window_hours=${bad}`);
      expect(res.status).toBe(400);
      const payload = await res.json() as { code: string; error: string };
      expect(payload.code).toBe("fleet_usage_invalid_request");
      expect(payload.error).toContain("window_hours");
    }
  });

  it("a bad top is a 400 naming the parameter", async () => {
    const { app } = makeApp({ registryExists: false });
    const res = await get(app, "/api/fleet/usage?top=0");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("top");
  });

  it("no registry = the local host alone, read IN-PROCESS from the real db", async () => {
    const { app } = makeApp({ registryExists: false, seedLocal: true });
    const payload = await body(app);
    expect(payload.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
    expect(payload.targetedHostIds).toEqual([LOCAL_HOST_ID]);
    expect(payload.windowHours).toBe(1);
    expect(payload.items).toHaveLength(1);
    // The local leg went through the db, not the transport: this seat is only here
    // because the seeded samples produced a positive delta inside the window.
    expect(payload.items[0]!.usage.state).toBe("ok");
    expect(payload.top).toHaveLength(1);
    expect(payload.top[0]).toMatchObject({ hostId: LOCAL_HOST_ID, seatSession: "dev-build@hub", tokensDelta: 2_400 });
    expect(payload.totals).toMatchObject({ tokensDelta: 2_400, hostsAnswered: 1, hostsTargeted: 1 });
    expect(payload.topCap).toBeNull();
  });

  it("a daemon with no samples at all reports an empty ranking, not a broken read", async () => {
    const { app } = makeApp({ registryExists: false });
    const payload = await body(app);
    expect(payload.items[0]!.usage.state).toBe("ok");
    expect(payload.items[0]!.usage.ranked).toEqual([]);
    // Zero seats is a real measurement here (the table exists and is empty), so the
    // total IS zero — unlike a host that never answered, which has no total at all.
    expect(payload.totals).toMatchObject({ tokensDelta: 0, hostsAnswered: 1 });
  });

  it("remote seats arrive labelled with their host and add to the fleet total", async () => {
    const { app } = makeApp({
      registry: registry(["alpha", "zulu"]),
      remoteFetch: replyFetch({
        alpha: { usage: json(topBody([{ seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900 }])) },
        zulu: { usage: json(topBody([{ seatSession: "orch-lead@zulu", tokensPerHour: 100, tokensDelta: 100 }])) },
      }),
    });
    const payload = await body(app);
    expect(payload.top.map((s) => `${s.hostId}/${s.seatSession}`)).toEqual(["alpha/dev-build@alpha", "zulu/orch-lead@zulu"]);
    expect(payload.totals).toMatchObject({ tokensDelta: 1_000, hostsAnswered: 3, hostsTargeted: 3 });
    expect(payload.hosts).toHaveLength(3);
  });

  it("an unreachable host is unknown and contributes nothing to the total", async () => {
    const { app } = makeApp({
      registry: registry(["alpha", "dead"]),
      remoteFetch: replyFetch({
        alpha: { usage: json(topBody([{ seatSession: "a1", tokensPerHour: 100, tokensDelta: 100 }])) },
        dead: { health: new Response("gone", { status: 503 }) },
      }),
    });
    const payload = await body(app);
    const dead = payload.items.find((i) => i.hostId === "dead")!;
    expect(dead.status).toBe("unreachable");
    expect(dead.usage.state).toBe("unavailable");
    expect(dead.usage.totals).toBeUndefined();
    // The number an operator compares teams on is 100 and says it covers 2 of 3
    // hosts. A zero from the dead host would have made the fleet look cheap.
    expect(payload.totals).toMatchObject({ tokensDelta: 100, hostsAnswered: 2, hostsTargeted: 3 });
  });

  it("the fan-out reads the operator's timeout and concurrency settings", async () => {
    const { app } = makeApp({ registryExists: false, hostTimeoutMs: 1_234, fanoutConcurrency: 9 });
    const payload = await body(app);
    expect(payload).toMatchObject({ hostTimeoutMs: 1_234, concurrency: 9, cacheTtlMs: expect.any(Number) });
  });

  it("unset settings fall back to the shipped defaults rather than a zero budget", async () => {
    const { app } = makeApp({ registryExists: false });
    const payload = await body(app);
    expect(payload.hostTimeoutMs).toBe(FLEET_HOST_TIMEOUT_MS_DEFAULT);
    expect(payload.concurrency).toBe(FLEET_FANOUT_CONCURRENCY_DEFAULT);
  });
});

describe("GET /api/fleet/usage — the cache", () => {
  it("one fan-out serves two readers, and ?fresh=1 bypasses it", async () => {
    let legs = 0;
    const { app } = makeApp({
      registry: registry(["alpha"]),
      remoteFetch: (async (input: string | URL | Request) => {
        legs += 1;
        return replyFetch({ alpha: { usage: json(topBody([{ seatSession: "a1", tokensPerHour: 1, tokensDelta: 1 }])) } })(input);
      }) as typeof fetch,
    });
    const first = await body(app);
    expect(first.fromCache).toBe(false);
    const legsAfterFirst = legs;
    const second = await body(app);
    expect(second.fromCache).toBe(true);
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(legs).toBe(legsAfterFirst);

    const forced = await body(app, "/api/fleet/usage?fresh=1");
    expect(forced.fromCache).toBe(false);
    expect(legs).toBeGreaterThan(legsAfterFirst);
  });

  it("a different window is a different question and is not answered from cache", async () => {
    const { app } = makeApp({ registryExists: false });
    await body(app, "/api/fleet/usage?window_hours=1");
    // Same window, straight back out of the cache…
    expect((await body(app, "/api/fleet/usage?window_hours=1")).fromCache).toBe(true);
    // …but a payload summed over one hour is not an answer about a day, so the
    // window is part of the cache key rather than a value the builder closed over.
    const wider = await body(app, "/api/fleet/usage?window_hours=24");
    expect(wider.fromCache).toBe(false);
    expect(wider.windowHours).toBe(24);
  });

  it("two different top caps share ONE fan-out, because the cap is a view", async () => {
    let legs = 0;
    const { app } = makeApp({
      registry: registry(["alpha"]),
      remoteFetch: (async (input: string | URL | Request) => {
        legs += 1;
        return replyFetch({
          alpha: {
            usage: json(topBody([
              { seatSession: "a1", tokensPerHour: 30, tokensDelta: 30 },
              { seatSession: "a2", tokensPerHour: 20, tokensDelta: 20 },
              { seatSession: "a3", tokensPerHour: 10, tokensDelta: 10 },
            ])),
          },
        })(input);
      }) as typeof fetch,
    });
    const capped = await body(app, "/api/fleet/usage?top=2");
    expect(capped.top.map((s) => s.seatSession)).toEqual(["a1", "a2"]);
    expect(capped.topCap).toBe(2);
    // The cut is disclosed: a reader can see the list is shorter than the fleet.
    expect(capped.totalSeatsRanked).toBe(3);
    const legsAfterCap = legs;
    const wider = await body(app, "/api/fleet/usage?top=3");
    expect(wider.top).toHaveLength(3);
    expect(legs).toBe(legsAfterCap);
  });
});
