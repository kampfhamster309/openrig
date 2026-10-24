// The hub-side fleet USAGE read — the fan-out and the arithmetic.
//
// What only this layer can prove: which numbers are allowed to add, that a host
// which did not answer contributes NOTHING rather than a zero, that a lane a
// runtime does not observe stays absent, that one slow host spends only its own
// deadline, and that the fleet top list is capped after the merge rather than on
// the legs.
//
// The route file pins the HTTP wiring; this file pins the meaning of the numbers.

import { describe, it, expect } from "vitest";
import {
  composeFleetUsage,
  createFleetUsageCache,
  parseUsageTopBody,
  rankFleetSeats,
  sumUsageTotals,
  type FleetUsageDeps,
  type UsageLeg,
} from "../src/domain/fleet/fleet-usage.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { FleetUsagePayload, UsageSeatBurn, UsageTopBody } from "../src/domain/fleet/fleet-usage-types.js";

function seat(over: Partial<UsageSeatBurn> & { seatSession: string }): UsageSeatBurn {
  return {
    tokensPerHour: 0, tokensDelta: 0, resets: 0, spanHours: 1, samples: 2, windows: [],
    ...over,
  };
}

function topBody(ranked: UsageSeatBurn[], unknown: UsageTopBody["unknown"] = []): UsageTopBody {
  return {
    windowHours: 1,
    sinceIso: "2026-10-23T11:00:00.000Z",
    ranked,
    unknown,
    totalRankedSeats: ranked.length,
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

const httpRegistry = (ids: string[]): HostRegistry =>
  ({ hosts: ids.map((id) => ({ id, transport: "http", url: `http://${id}.test:7433` })) }) as unknown as HostRegistry;

/** A registry whose every host answers `/healthz` and its usage leg from `replies`. */
function replyFetch(replies: Record<string, { health?: Response; usage?: Response }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hostId = new URL(url).hostname.replace(".test", "");
    const reply = replies[hostId] ?? {};
    if (url.includes("/healthz")) return reply.health ?? json({ ok: true });
    return reply.usage ?? json(topBody([]));
  }) as typeof fetch;
}

function compose(over: Partial<FleetUsageDeps> = {}): Promise<FleetUsagePayload> {
  return composeFleetUsage({
    readLocalUsage: () => ({ ok: true, body: topBody([]) }),
    loadRegistry: () => ({ ok: true, registry: httpRegistry([]) }),
    registryExists: () => true,
    windowHours: 1,
    ...over,
  }) as Promise<FleetUsagePayload>;
}

describe("sumUsageTotals — only numbers that honestly add", () => {
  it("sums token deltas and restarts, and counts seats", () => {
    const totals = sumUsageTotals([
      seat({ seatSession: "a", tokensDelta: 100, resets: 1 }),
      seat({ seatSession: "b", tokensDelta: 50, resets: 0 }),
    ], 2);
    expect(totals).toEqual({ tokensDelta: 150, resets: 1, seatsRanked: 2, seatsUnknown: 2 });
  });

  it("carries no rate and no percentage, because neither is combinable", () => {
    const totals = sumUsageTotals([
      seat({ seatSession: "a", tokensPerHour: 900, spanHours: 0.1, tokensDelta: 90 }),
      seat({ seatSession: "b", tokensPerHour: 1, spanHours: 10, tokensDelta: 10 }),
    ], 0);
    // A rate is measured over each seat's OWN sample span. Summing 900 and 1, or
    // averaging them, would describe a span the fleet never had — so the shape
    // refuses to carry one at all rather than carrying a plausible wrong number.
    expect(Object.keys(totals).sort()).toEqual(["resets", "seatsRanked", "seatsUnknown", "tokensDelta"]);
    expect(totals.tokensDelta).toBe(100);
  });
});

describe("rankFleetSeats", () => {
  it("ranks by the per-seat rate the origin computed, and breaks ties deterministically", () => {
    const ranked = rankFleetSeats([
      { ...seat({ seatSession: "low", tokensPerHour: 5 }), hostId: "zulu" },
      { ...seat({ seatSession: "hi", tokensPerHour: 90 }), hostId: "alpha" },
      { ...seat({ seatSession: "tie-b", tokensPerHour: 50 }), hostId: "alpha" },
      { ...seat({ seatSession: "tie-a", tokensPerHour: 50 }), hostId: "alpha" },
    ]);
    expect(ranked.map((s) => s.seatSession)).toEqual(["hi", "tie-a", "tie-b", "low"]);
  });
});

describe("parseUsageTopBody — an older image is the authority on the shape", () => {
  it("reads a well-formed body", () => {
    const parsed = parseUsageTopBody(topBody([seat({ seatSession: "dev-build@rig", tokensDelta: 7 })]));
    expect(parsed.leg.ok).toBe(true);
    expect(parsed.droppedRows).toBe(0);
  });

  it("drops a row whose burn numbers are not finite rather than coercing it to zero", () => {
    // `tokensDelta ?? 0` is the tempting one-liner, and it puts a fabricated zero
    // into the total an operator compares teams on.
    const parsed = parseUsageTopBody({
      windowHours: 1, sinceIso: "2026-10-23T11:00:00.000Z", totalRankedSeats: 2,
      ranked: [
        { seatSession: "good", tokensPerHour: 10, tokensDelta: 10, resets: 0, spanHours: 1, samples: 2, windows: [] },
        { seatSession: "broken", tokensPerHour: null, tokensDelta: null, resets: 0, spanHours: 1, samples: 2, windows: [] },
      ],
    });
    expect(parsed.droppedRows).toBe(1);
    if (!parsed.leg.ok) throw new Error("expected the readable rows to survive");
    expect(parsed.leg.body.ranked.map((s) => s.seatSession)).toEqual(["good"]);
  });

  it("reports a body with no ranked array as unreadable, not as an empty fleet", () => {
    const parsed = parseUsageTopBody({ windowHours: 1, sinceIso: "2026-10-23T11:00:00.000Z" });
    expect(parsed.leg.ok).toBe(false);
  });

  it("keeps a null percentage null instead of reading it as zero percent used", () => {
    const parsed = parseUsageTopBody({
      windowHours: 1, sinceIso: "2026-10-23T11:00:00.000Z", totalRankedSeats: 1,
      ranked: [{
        seatSession: "s", tokensPerHour: 1, tokensDelta: 1, resets: 0, spanHours: 1, samples: 2,
        windows: [{ window: "five_hour", usedPercentFirst: null, usedPercentLast: null, percentPerHour: null, resetsAt: null }],
      }],
    });
    if (!parsed.leg.ok) throw new Error("expected a readable body");
    expect(parsed.leg.body.ranked[0]!.windows[0]).toMatchObject({ usedPercentFirst: null, percentPerHour: null });
  });
});

describe("composeFleetUsage — the local host", () => {
  it("a single-host operator gets their own seats, with no remote legs at all", async () => {
    const payload = await compose({
      registryExists: () => false,
      readLocalUsage: () => ({ ok: true, body: topBody([seat({ seatSession: "dev-build@home", tokensDelta: 40, tokensPerHour: 40 })]) }),
    });
    expect(payload.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
    expect(payload.targetedHostIds).toEqual([LOCAL_HOST_ID]);
    expect(payload.totals).toMatchObject({ tokensDelta: 40, hostsAnswered: 1, hostsTargeted: 1 });
    expect(payload.top[0]).toMatchObject({ hostId: LOCAL_HOST_ID, seatSession: "dev-build@home" });
    expect("registryError" in payload).toBe(false);
  });

  it("a local read that failed is unknown, and the fleet total is ABSENT rather than zero", async () => {
    const payload = await compose({
      registryExists: () => false,
      readLocalUsage: (): UsageLeg => ({ ok: false, reason: "no usage samples table" }),
    });
    const local = payload.items[0]!;
    expect(local.usage.state).toBe("unavailable");
    expect(local.usage.reason).toContain("no usage samples table");
    // The distinction the whole read exists to keep: "used nothing" and "nobody
    // answered" are different answers, and only one of them is 0.
    expect(local.usage.totals).toBeUndefined();
    expect(payload.totals).toBeNull();
    expect(payload.top).toEqual([]);
  });

  it("an unreadable registry is disclosed, not a silently one-host fleet", async () => {
    const payload = await compose({
      registryExists: () => true,
      loadRegistry: () => ({ ok: false, error: "hosts.yaml is not valid YAML" }),
    });
    expect(payload.registryError).toContain("not valid YAML");
    expect(payload.targetedHostIds).toEqual([LOCAL_HOST_ID]);
  });
});

describe("composeFleetUsage — remote hosts", () => {
  it("labels every seat with its host and sums across hosts", async () => {
    const payload = await compose({
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["alpha", "zulu"]) }),
      fetchImpl: replyFetch({
        alpha: { usage: json(topBody([seat({ seatSession: "a1", tokensDelta: 100, tokensPerHour: 100 })])) },
        zulu: { usage: json(topBody([seat({ seatSession: "z1", tokensDelta: 30, tokensPerHour: 30 })])) },
      }),
    });
    expect(payload.top.map((s) => `${s.hostId}/${s.seatSession}`)).toEqual(["alpha/a1", "zulu/z1"]);
    expect(payload.totals).toMatchObject({ tokensDelta: 130, seatsRanked: 2, hostsAnswered: 3, hostsTargeted: 3 });
  });

  it("an unreachable host appears, is unknown, and adds NOTHING to the total", async () => {
    const payload = await compose({
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["alpha", "dead"]) }),
      fetchImpl: replyFetch({
        alpha: { usage: json(topBody([seat({ seatSession: "a1", tokensDelta: 100, tokensPerHour: 100 })])) },
        dead: { health: new Response("nope", { status: 503 }) },
      }),
    });
    const dead = payload.items.find((i) => i.hostId === "dead")!;
    // Omission-proof: the host is IN the payload with a status, not missing.
    expect(payload.hosts).toContainEqual(expect.objectContaining({ hostId: "dead", status: "unreachable" }));
    expect(dead.reachable).toBe(false);
    expect(dead.usage.state).toBe("unavailable");
    expect(dead.usage.totals).toBeUndefined();
    expect(dead.usage.ranked).toEqual([]);
    // The total is 100, not 100+0 dressed up as a complete fleet: it says it is
    // a partial sum, and the reader can see which host is missing.
    expect(payload.totals).toMatchObject({ tokensDelta: 100, hostsAnswered: 2, hostsTargeted: 3 });
  });

  it("a reachable host whose usage route failed stays ok and reports the usage gap separately", async () => {
    const payload = await compose({
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["alpha"]) }),
      fetchImpl: replyFetch({ alpha: { usage: new Response("not found", { status: 404 }) } }),
    });
    const alpha = payload.items.find((i) => i.hostId === "alpha")!;
    // The host ANSWERED its health probe. Saying "unreachable" would send the
    // operator to check a machine that is fine.
    expect(alpha.status).toBe("ok");
    expect(alpha.usage.state).toBe("unavailable");
    expect(alpha.partialFailures.join(" ")).toContain("404");
    expect(payload.totals).toMatchObject({ hostsAnswered: 1, hostsTargeted: 2 });
  });

  it("a bearer that cannot be resolved is an auth failure, not a dead host", async () => {
    // The operator's fix for a rotated bearer is nothing like the fix for a machine
    // that is down, so the two must not arrive under one word.
    let dialed = 0;
    const payload = await compose({
      loadRegistry: () => ({
        ok: true,
        registry: {
          hosts: [{ id: "alpha", transport: "http", url: "http://alpha.test:7433", bearer_env: "OPENRIG_TEST_ABSENT_BEARER" }],
        } as unknown as HostRegistry,
      }),
      env: {},
      fetchImpl: (async () => { dialed += 1; return json(topBody([])); }) as typeof fetch,
    });
    const alpha = payload.items.find((i) => i.hostId === "alpha")!;
    expect(alpha.status).toBe("auth-failed");
    expect(alpha.usage.state).toBe("unavailable");
    // The bearer never leaves the daemon, and nothing was dialed to find this out.
    expect(dialed).toBe(0);
  });

  it("an SSH-declared host is unsupported-transport and costs no network", async () => {
    let dialed = 0;
    const payload = await compose({
      loadRegistry: () => ({
        ok: true,
        registry: { hosts: [{ id: "box", transport: "ssh", target: "box.example" }] } as unknown as HostRegistry,
      }),
      fetchImpl: (async () => { dialed += 1; return json({}); }) as typeof fetch,
    });
    const box = payload.items.find((i) => i.hostId === "box")!;
    expect(box.status).toBe("unsupported-transport");
    expect(box.usage.state).toBe("unavailable");
    expect(dialed).toBe(0);
  });

  it("a lane a runtime does not observe stays absent, never a zeroed window", async () => {
    const payload = await compose({
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["alpha"]) }),
      fetchImpl: replyFetch({
        alpha: { usage: json(topBody([seat({ seatSession: "apikey-seat", windows: [] })])) },
      }),
    });
    // The factory runs on API keys: there is no subscription window to report, and
    // synthesizing `five_hour: 0%` would describe a window that does not exist.
    expect(payload.top[0]!.windows).toEqual([]);
  });
});

describe("composeFleetUsage — the fan-out discipline", () => {
  it("a slow host spends only its OWN deadline; the others still answer", async () => {
    const HOST_TIMEOUT_MS = 60;
    const started = Date.now();
    const payload = await compose({
      hostTimeoutMs: HOST_TIMEOUT_MS,
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["slow", "quick"]) }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("slow.test")) {
          // Far past the budget, and abortable, so it is the deadline that ends it.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 30_000);
            init?.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
          });
          return json(topBody([]));
        }
        if (url.includes("/healthz")) return json({ ok: true });
        return json(topBody([seat({ seatSession: "q1", tokensDelta: 5, tokensPerHour: 5 })]));
      }) as typeof fetch,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(payload.items.find((i) => i.hostId === "slow")!.status).toBe("unreachable");
    expect(payload.items.find((i) => i.hostId === "quick")!.usage.state).toBe("ok");
    expect(payload.hosts.length).toBe(3);
  });

  it("never runs more legs at once than the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const payload = await compose({
      concurrency: 2,
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["a", "b", "c", "d", "e"]) }),
      fetchImpl: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return json({ ok: true });
      }) as typeof fetch,
    });
    expect(peak).toBeLessThanOrEqual(2);
    // Registry order is preserved, so the payload is deterministic.
    expect(payload.items.map((i) => i.hostId)).toEqual([LOCAL_HOST_ID, "a", "b", "c", "d", "e"]);
  });

  it("the top cap is applied to the MERGED ranking, not to each host's list", async () => {
    // Each host's 2nd seat is also a fleet leader. A per-host cap of 1 would have
    // dropped `b2` before the hub ever saw it.
    const payload = await compose({
      loadRegistry: () => ({ ok: true, registry: httpRegistry(["alpha", "beta"]) }),
      fetchImpl: replyFetch({
        alpha: { usage: json(topBody([seat({ seatSession: "a1", tokensPerHour: 100 }), seat({ seatSession: "a2", tokensPerHour: 40 })])) },
        beta: { usage: json(topBody([seat({ seatSession: "b1", tokensPerHour: 90 }), seat({ seatSession: "b2", tokensPerHour: 80 })])) },
      }),
    });
    expect(payload.top.map((s) => s.seatSession)).toEqual(["a1", "b1", "b2", "a2"]);
    expect(payload.totalSeatsRanked).toBe(4);
  });
});

describe("createFleetUsageCache", () => {
  it("one fan-out serves two readers, and ?fresh bypasses it", async () => {
    let builds = 0;
    let now = 1_000;
    const cache = createFleetUsageCache(
      async (windowHours) => { builds += 1; return { ...(await compose({ windowHours })), build: builds } as never; },
      { ttlMs: 3_000, nowMs: () => now },
    );
    const first = await cache.read(false, "1");
    expect(first.fromCache).toBe(false);
    const second = await cache.read(false, "1");
    expect(second.fromCache).toBe(true);
    expect(second.cacheAgeMs).toBe(0);
    expect(builds).toBe(1);

    const forced = await cache.read(true, "1");
    expect(forced.fromCache).toBe(false);
    expect(builds).toBe(2);

    // A different window is a different question; the first answer is not it.
    await cache.read(false, "24");
    expect(builds).toBe(3);
    cache.clear();
  });

  it("concurrent readers join ONE fan-out", async () => {
    let builds = 0;
    const cache = createFleetUsageCache(async () => {
      builds += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await compose({}) as never;
    });
    const [a, b] = await Promise.all([cache.read(false, "1"), cache.read(false, "1")]);
    expect(builds).toBe(1);
    expect(a.totalSeatsRanked).toBe(b.totalSeatsRanked);
  });
});
