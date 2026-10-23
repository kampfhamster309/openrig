// `rig usage top --all-hosts` — the fleet usage read at the CLI.
//
// The rule this file pins, identical to `rig ps --all-hosts`: when the LOCAL daemon
// serves GET /api/fleet/usage, the command is a projection of that ONE fan-out.
// When it does not — an older daemon, no daemon, a malformed answer — the CLI dials
// every host itself. The fallback is the contract for an old local daemon, never an
// error, and what the operator reads must not depend on which path ran.
//
// The honesty that matters here is narrower than the daemon's and just as binding:
// a host that did not answer is shown as UNKNOWN with its reason, and a total is
// shown only where the payload actually has one.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Command } from "commander";
import { usageCommand, type UsageDeps } from "../src/commands/usage.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { DaemonClient, DaemonResponse } from "../client.js";

const LOCAL = "http://127.0.0.1:7433";
const HOSTS = [
  { id: "alpha", transport: "http", url: "http://alpha.test:7433" },
  { id: "zulu", transport: "http", url: "http://zulu.test:7433" },
];

function makeFactory(handler: (fullUrl: string) => { status: number; data: unknown } | undefined) {
  const calls: string[] = [];
  const factory = ((url: string): DaemonClient => ({
    baseUrl: url,
    get: async <T>(path: string, opts?: { timeoutMs?: number }) => {
      const full = path.startsWith("http") ? path : `${url.replace(/\/$/, "")}${path}`;
      calls.push(full);
      if (opts?.timeoutMs !== undefined) timeouts.push({ full, timeoutMs: opts.timeoutMs });
      const r = handler(full);
      return { status: r?.status ?? 404, data: (r?.data ?? { error: "not found" }) as T } as DaemonResponse<T>;
    },
    post: async () => ({ status: 200, data: {} }) as DaemonResponse<unknown>,
  }) as unknown as DaemonClient) as ((url: string) => DaemonClient) & { _calls: string[]; _timeouts: typeof timeouts };
  const timeouts: Array<{ full: string; timeoutMs: number }> = [];
  return Object.assign(factory, { _calls: calls, _timeouts: timeouts });
}

function makeDeps(factory: (url: string) => DaemonClient, hosts = HOSTS): UsageDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: factory,
    hostRegistryLoader: () => ({ ok: true, registry: { hosts } }) as never,
  } as unknown as UsageDeps;
}

async function run(deps: UsageDeps, args: string[]): Promise<void> {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(usageCommand(deps));
  await prog.parseAsync(["node", "rig", "usage", ...args]);
}

function capture(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
  return fn().then(() => out, (err) => { out.push(String(err)); return out; });
}

/** A `usage/top` body in the shape a pod answers. */
function topBody(seats: Array<{ seatSession: string; tokensPerHour: number; tokensDelta: number }>) {
  return {
    windowHours: 1,
    sinceIso: "2026-10-23T11:00:00.000Z",
    ranked: seats.map((s) => ({ ...s, resets: 0, spanHours: 1, samples: 2, windows: [] })),
    unknown: [],
    totalRankedSeats: seats.length,
  };
}

function fleetPayload(over: Record<string, unknown> = {}) {
  return {
    items: [
      {
        hostId: "alpha", kind: "remote", status: "ok", reachable: true,
        usage: {
          state: "ok",
          ranked: [{ hostId: "alpha", seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900, resets: 0, spanHours: 1, samples: 2, windows: [] }],
          unknown: [],
          totals: { tokensDelta: 900, resets: 0, seatsRanked: 1, seatsUnknown: 0 },
        },
        partialFailures: [],
      },
      {
        hostId: "zulu", kind: "remote", status: "unreachable", reachable: false,
        statusError: "host did not answer its health probe",
        usage: { state: "unavailable", reason: "the host did not answer its health probe", ranked: [], unknown: [] },
        partialFailures: [],
      },
    ],
    hosts: [{ hostId: "local", status: "ok" }, { hostId: "alpha", status: "ok" }, { hostId: "zulu", status: "unreachable" }],
    windowHours: 1,
    sinceIso: "2026-10-23T11:00:00.000Z",
    top: [{ hostId: "alpha", seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900, resets: 0, spanHours: 1, samples: 2, windows: [] }],
    topCap: null,
    totalSeatsRanked: 1,
    unknown: [],
    totals: { tokensDelta: 900, resets: 0, seatsRanked: 1, seatsUnknown: 0, hostsAnswered: 2, hostsTargeted: 3 },
    targetedHostIds: ["local", "alpha", "zulu"],
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("rig usage top --all-hosts — the hub read", () => {
  it("is a projection of the hub's ONE fan-out: no host is dialed from here", async () => {
    const factory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: fleetPayload() } : undefined);
    const lines = await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]));

    expect(factory._calls.filter((u) => u.includes("/api/fleet/usage"))).toHaveLength(1);
    expect(factory._calls.filter((u) => u.includes("/api/telemetry/usage/top"))).toHaveLength(0);
    const text = lines.join("\n");
    // Every seat carries its host: the same seat name can exist on two teams, and an
    // unlabelled seat on a hub is not actionable.
    expect(text).toContain("[alpha] dev-build@alpha");
    expect(text).toContain("900 tok/h");
    expect(text).toContain("FLEET TOKEN BURN");
  });

  it("shows an unknown host as unknown with its reason, never as a zero row", async () => {
    const factory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: fleetPayload() } : undefined);
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");

    expect(text).toContain("[zulu]  unknown — the host did not answer its health probe");
    // And the total says it is a partial sum rather than the whole fleet's number.
    expect(text).toContain("2 of 3 hosts answered");
    expect(text).toContain("sums the 2 host(s) that answered; 1 did not, and add nothing");
  });

  it("says what the numbers are, because a reader assumes more precision than exists", async () => {
    const factory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: fleetPayload() } : undefined);
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");
    expect(text).toContain("sampled context-window readings");
    expect(text).toContain("not exact token or cost accounting");
  });

  it("waits on the shared reader rule, not the client default", async () => {
    const factory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: fleetPayload() } : undefined);
    await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]));
    const seen = factory._timeouts.filter((c) => c.full.includes("/api/fleet/usage"));
    expect(seen).toHaveLength(1);
    // Two registered hosts plus the hub's own local leg is three legs; a reader on
    // the 5 s default would abandon a healthy fan-out and pay for a second one.
    expect(seen[0]!.timeoutMs).toBeGreaterThan(5_000);
  });

  it("--json passes the payload through rather than re-inventing it", async () => {
    const payload = fleetPayload();
    const factory = makeFactory((url) => (url.includes("/api/fleet/usage") ? { status: 200, data: payload } : undefined));
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await run(makeDeps(factory), ["top", "--all-hosts", "--json"]);
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(parsed.items).toHaveLength(2);
    expect(parsed.totals).toMatchObject({ tokensDelta: 900, hostsAnswered: 2 });
  });

  it("a host the hub did not answer for sends the command to the fan-out", async () => {
    // The hub's registry and this CLI's are different files. Projecting the hub's
    // answer alone would drop zulu from BOTH items and hosts.
    const partial = fleetPayload({
      items: [fleetPayload().items[0]],
      hosts: [{ hostId: "local", status: "ok" }, { hostId: "alpha", status: "ok" }],
    });
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return { status: 200, data: partial };
      if (url.includes("/api/telemetry/usage/top")) {
        return { status: 200, data: topBody([{ seatSession: "orch-lead@zulu", tokensPerHour: 50, tokensDelta: 50 }]) };
      }
      return undefined;
    });
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");
    expect(factory._calls.filter((u) => u.includes("/api/telemetry/usage/top")).length).toBeGreaterThan(0);
    expect(text).toContain("[zulu]");
  });
});

describe("rig usage top --all-hosts — the fallback (an older local daemon)", () => {
  it("404 on the hub route is the contract, not an error: every host is dialed", async () => {
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return { status: 404, data: { error: "not found" } };
      if (url.includes("alpha.test")) return { status: 200, data: topBody([{ seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900 }]) };
      if (url.includes("zulu.test")) return { status: 200, data: topBody([{ seatSession: "orch-lead@zulu", tokensPerHour: 100, tokensDelta: 100 }]) };
      return { status: 200, data: topBody([]) };
    });
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");
    expect(factory._calls.some((u) => u.includes("alpha.test") && u.includes("/api/telemetry/usage/top"))).toBe(true);
    expect(factory._calls.some((u) => u.includes("zulu.test") && u.includes("/api/telemetry/usage/top"))).toBe(true);
    // Ranked across hosts by the per-seat rate the origin computed, each labelled.
    expect(text).toContain("1. [alpha] dev-build@alpha");
    expect(text).toContain("2. [zulu] orch-lead@zulu");
    // Asserted without the thousands separator: the number is rendered with
    // toLocaleString, so its grouping mark belongs to the reader's locale.
    expect(text).toMatch(/fleet total\s+1[.,]000 tokens/);
  });

  it("a host that refuses is unknown with its reason, and adds nothing to the total", async () => {
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return { status: 404, data: {} };
      if (url.includes("alpha.test")) return { status: 200, data: topBody([{ seatSession: "a1", tokensPerHour: 100, tokensDelta: 100 }]) };
      if (url.includes("zulu.test")) return { status: 401, data: { error: "unauthorized" } };
      return { status: 200, data: topBody([]) };
    });
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");
    expect(text).toContain("[zulu]  unknown");
    expect(text).toMatch(/fleet total\s+100 tokens/);
    expect(text).toContain("add nothing");
  });

  it("the local host is included, because it is the daemon that could not serve the hub route", async () => {
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return { status: 404, data: {} };
      if (url.includes(LOCAL)) return { status: 200, data: topBody([{ seatSession: "dev-build@hub", tokensPerHour: 7, tokensDelta: 7 }]) };
      return { status: 200, data: topBody([]) };
    });
    const text = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts"]))).join("\n");
    expect(text).toContain("[local]");
    expect(text).toContain("dev-build@hub");
  });

  it("--json yields the same shape on the fallback as on the hub read", async () => {
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return { status: 404, data: {} };
      if (url.includes("alpha.test")) return { status: 200, data: topBody([{ seatSession: "a1", tokensPerHour: 5, tokensDelta: 5 }]) };
      return { status: 200, data: topBody([]) };
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    await run(makeDeps(factory), ["top", "--all-hosts", "--json"]);
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    // The same keys a scripted reader gets from the hub, so one script serves both.
    // `source` names the path that answered, because the two are not equally fresh.
    // Full parity against a real route payload is pinned in the describe below.
    expect(Object.keys(parsed).sort()).toEqual(
      ["hosts", "items", "source", "targetedHostIds", "top", "topCap", "totalSeatsRanked", "totals", "unknown", "windowHours"].sort(),
    );
    expect(parsed.totals).toMatchObject({ hostsAnswered: 3, hostsTargeted: 3 });
  });
});

describe("rig usage top — the single-host read is unchanged", () => {
  it("without --all-hosts it reads only the local daemon", async () => {
    const state = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
    const lifecycleDeps = {
      spawn: () => ({ pid: 1, unref: () => {} }),
      fetch: async () => ({ ok: true }),
      kill: () => true,
      readFile: (p: string) => (p === STATE_FILE ? JSON.stringify(state) : null),
      writeFile: () => {},
      removeFile: () => {},
      exists: (p: string) => p === STATE_FILE,
      mkdirp: () => {},
      openForAppend: () => 3,
      isProcessAlive: () => true,
    } as unknown as LifecycleDeps;
    const factory = makeFactory((url) =>
      url.includes("/api/telemetry/usage/top") ? { status: 200, data: { ...topBody([{ seatSession: "a1", tokensPerHour: 1, tokensDelta: 1 }]), unknown: [] } } : undefined);
    const deps = { lifecycleDeps, clientFactory: factory, hostRegistryLoader: () => ({ ok: true, registry: { hosts: HOSTS } }) } as unknown as UsageDeps;
    const text = (await capture(() => run(deps, ["top"]))).join("\n");
    expect(text).toContain("TOP TOKEN BURN");
    expect(factory._calls.some((u) => u.includes("/api/fleet/usage"))).toBe(false);
    expect(factory._calls.some((u) => u.includes("alpha.test"))).toBe(false);
  });
});

// ── what the two paths must not disagree about ────────────────────────────────

/** The hub's payload as the ROUTE actually answers it, extras included. The fixture
 *  above is the trimmed shape this command documents; a parity test built from it
 *  proves nothing, because it omits every field the fallback cannot know. This one
 *  carries them so the projection is proven to remove them. */
function routeShapedPayload() {
  const seat = { hostId: "alpha", seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900, resets: 0, spanHours: 1, samples: 2 };
  return {
    ...fleetPayload(),
    generatedAt: "2026-10-24T09:00:00.000Z",
    sinceIso: "2026-10-24T08:00:00.000Z",
    hostTimeoutMs: 5_000,
    concurrency: 4,
    fromCache: false,
    cacheAgeMs: 0,
    cacheTtlMs: 3_000,
    cacheStaleWhileRevalidate: false,
    items: [
      {
        hostId: "alpha", kind: "remote", status: "ok", reachable: true,
        usage: {
          state: "ok", windowHours: 1, sinceIso: "2026-10-24T08:00:00.000Z", totalRankedSeats: 1,
          ranked: [seat], unknown: [], totals: { tokensDelta: 900, resets: 0, seatsRanked: 1, seatsUnknown: 0 },
        },
        partialFailures: [],
      },
    ],
    hosts: [{ hostId: "alpha", status: "ok" }],
    targetedHostIds: ["alpha"],
  };
}

describe("--top means the same thing on either path", () => {
  it("the cap is sent to the hub's route, not only applied in the fallback", async () => {
    const factory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: fleetPayload() } : undefined);
    await capture(() => run(makeDeps(factory), ["top", "--all-hosts", "--top", "1"]));
    expect(factory._calls.some((u) => u.includes("/api/fleet/usage") && u.includes("top=1"))).toBe(true);
  });

  it("a --top that is not a positive count is refused before either path dials anything", async () => {
    // `--top abc` used to become NaN, `slice(0, NaN)` returned nothing, and the command
    // reported "no usage samples" over a fleet that had plenty, then exited 0.
    const factory = makeFactory(() => undefined);
    const out = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts", "--top", "abc"]))).join("\n");
    expect(out).toContain('invalid top "abc" — must be a positive count');
    expect(process.exitCode).toBe(1);
    expect(factory._calls).toEqual([]);
    expect(out).not.toContain("no usage samples");
  });
});

describe("a host that answers is never called unreachable", () => {
  it("HTTP 500 on the fallback is reachable with unknown usage, as the hub reports it", async () => {
    const factory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return undefined; // no hub read: take the fan-out
      if (url.includes("alpha.test")) return { status: 500, data: { error: "boom" } };
      return { status: 200, data: topBody([{ seatSession: "dev-build@zulu", tokensPerHour: 10, tokensDelta: 10 }]) };
    });
    const out = (await capture(() => run(makeDeps(factory), ["top", "--all-hosts", "--json"]))).join("\n");
    const body = JSON.parse(out) as { items: Array<Record<string, never>> };
    const alpha = body.items.find((i) => (i as { hostId: string }).hostId === "alpha") as {
      status: string; reachable: boolean; usage: { state: string }; partialFailures?: string[];
    };
    expect(alpha.status).toBe("ok");
    expect(alpha.reachable).toBe(true);
    expect(alpha.usage.state).toBe("unavailable");
    expect((alpha.partialFailures ?? []).join(" ")).toContain("reachable, and its usage is unknown rather than zero");
  });
});

describe("--json yields the same keys whichever path ran", () => {
  it("the hub's extra route fields are projected away, so one script reads either path", async () => {
    const hubFactory = makeFactory((url) =>
      url.includes("/api/fleet/usage") ? { status: 200, data: routeShapedPayload() } : undefined);
    const hubOut = JSON.parse((await capture(() => run(makeDeps(hubFactory, [{ id: "alpha", transport: "http", url: "http://alpha.test:7433" }]), ["top", "--all-hosts", "--json"]))).join("\n"));

    const fbFactory = makeFactory((url) => {
      if (url.includes("/api/fleet/usage")) return undefined;
      if (url.includes("alpha.test")) return { status: 200, data: topBody([{ seatSession: "dev-build@alpha", tokensPerHour: 900, tokensDelta: 900 }]) };
      return undefined;
    });
    const fbOut = JSON.parse((await capture(() => run(makeDeps(fbFactory, [{ id: "alpha", transport: "http", url: "http://alpha.test:7433" }]), ["top", "--all-hosts", "--json"]))).join("\n"));

    // The fields only the hub knows must not reach a scripted reader, or the same command
    // answers differently depending on whether a local daemon happened to be up.
    for (const extra of ["generatedAt", "sinceIso", "hostTimeoutMs", "concurrency", "fromCache", "cacheAgeMs", "cacheTtlMs", "cacheStaleWhileRevalidate"]) {
      expect(Object.keys(hubOut)).not.toContain(extra);
    }
    expect(Object.keys(hubOut).sort()).toEqual(Object.keys(fbOut).sort());
    expect(hubOut.source).toBe("hub");
    expect(fbOut.source).toBe("cli-fanout");
    // Same keys per host too, on the host both paths actually saw.
    const hubAlpha = hubOut.items.find((i: { hostId: string }) => i.hostId === "alpha");
    const fbAlpha = fbOut.items.find((i: { hostId: string }) => i.hostId === "alpha");
    expect(Object.keys(hubAlpha).sort()).toEqual(Object.keys(fbAlpha).sort());
    expect(Object.keys(hubAlpha.usage).sort()).toEqual(Object.keys(fbAlpha.usage).sort());
  });
});
