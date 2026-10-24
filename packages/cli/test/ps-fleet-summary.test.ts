// `rig ps --all-hosts` and the daemon-side fleet summary.
//
// The rule this file pins: when the LOCAL daemon serves GET /api/fleet/summary,
// the command is a projection of that ONE fan-out. When it does not — an older
// daemon, no daemon at all, a malformed answer — today's CLI-side per-host
// fan-out runs UNCHANGED. The fallback is the contract for an old local daemon,
// never an error, and the rendered payload must not depend on which path ran.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { join } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { psCommand, type PsDeps } from "../src/commands/ps.js";
import type { DaemonClient, DaemonResponse } from "../src/client.js";

/** A client factory whose clients record the FULL url they were asked for, so a
 *  test can tell the local daemon's read from a remote host's leg. */
function makeFactory(handler: (fullUrl: string) => { status: number; data: unknown } | undefined): (url: string) => DaemonClient {
  const calls: string[] = [];
  const factory = (url: string): DaemonClient => ({
    baseUrl: url,
    get: async <T>(path: string) => {
      const full = path.startsWith("http") ? path : `${url.replace(/\/$/, "")}${path}`;
      calls.push(full);
      const r = handler(full);
      return { status: r?.status ?? 404, data: (r?.data ?? { error: "not found" }) as T } as DaemonResponse<T>;
    },
    post: async () => ({ status: 200, data: {} }) as DaemonResponse<unknown>,
  }) as unknown as DaemonClient;
  return Object.assign(factory, { _calls: calls });
}

/** A factory that records the per-request options the command passed, so a test can
 *  assert the WAIT and not just the URL. Every suite here would still pass if the
 *  reader silently fell back to the client's 5 s default — the timeout is invisible to
 *  a URL-only double — and that regression is exactly what re-introduces the bug. */
function makeTimeoutCapturingFactory(
  handler: (fullUrl: string) => { status: number; data: unknown } | undefined,
): ((url: string) => DaemonClient) & { _timeouts: Array<{ path: string; timeoutMs?: number }> } {
  const seen: Array<{ path: string; timeoutMs?: number }> = [];
  const factory = (url: string): DaemonClient => ({
    baseUrl: url,
    get: async <T>(path: string, opts?: { timeoutMs?: number }) => {
      const full = path.startsWith("http") ? path : `${url.replace(/\/$/, "")}${path}`;
      if (full.endsWith("/api/fleet/summary")) seen.push({ path: full, timeoutMs: opts?.timeoutMs });
      const r = handler(full);
      return { status: r?.status ?? 404, data: (r?.data ?? { error: "not found" }) as T } as DaemonResponse<T>;
    },
    post: async () => ({ status: 200, data: {} }) as DaemonResponse<unknown>,
  }) as unknown as DaemonClient;
  return Object.assign(factory, { _timeouts: seen });
}

function makeCmd(deps: PsDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(psCommand(deps));
  return prog;
}

function mockRegistry(hosts: Array<Record<string, unknown>>) {
  return () => ({ ok: true as const, registry: { hosts } });
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  process.stdout.write = ((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
  return out;
}

const HOSTS = [
  { id: "team-a", transport: "http", url: "http://team-a:7433" },
  { id: "team-b", transport: "http", url: "http://team-b:7433" },
];

/** A fleet summary shaped exactly as the daemon serves it. `team-b` is down, so
 *  every test here also proves a failed host stays in `hosts[]`. */
const SUMMARY = {
  items: [
    {
      hostId: "team-a", kind: "remote", reachable: true, rigCount: 1, seatCount: 2,
      attentionCount: 1, openQueueCount: 2,
      progress: { lastQueueTransitionAt: "2026-10-23T11:00:00.000Z", lastSeatOutputAt: "2026-10-23T11:59:00.000Z", minutesSinceProgress: 60, stalled: true, openWorkCount: 2 },
      rigs: [{
        rigId: "rig-a", rigName: "team-a", hostId: "team-a", seatCount: 2, attentionCount: 1,
        seatsWithAssignedWork: 1, lifecycleState: "running",
        // The origin's own running/status pair, carried verbatim. A rig with declared
        // but stopped seats must not read as fully running on one path and honestly on
        // the other, and `partial` must stay reachable.
        runningCount: 1, psStatus: "partial",
        progress: { lastQueueTransitionAt: "2026-10-23T11:00:00.000Z", lastSeatOutputAt: "2026-10-23T11:59:00.000Z", minutesSinceProgress: 60, stalled: true, openWorkCount: 2 },
        seats: [
          { hostId: "team-a", rigId: "rig-a", rigName: "team-a", logicalId: "orch.lead", canonicalSessionName: "orch-lead@team-a", nodeKind: "agent", sessionStatus: "running", role: "lead", runtime: "claude-code", activity: "idle", needsInputReason: null, lastActivityAt: "2026-10-23T11:50:00.000Z", lifecycleState: "running", startupStatus: "ready" },
          { hostId: "team-a", rigId: "rig-a", rigName: "team-a", logicalId: "dev.build", canonicalSessionName: "dev-build@team-a", nodeKind: "agent", sessionStatus: "waiting", role: "builder", runtime: "pi", activity: "working", needsInputReason: null, lastActivityAt: "2026-10-23T11:59:00.000Z", lifecycleState: "running", startupStatus: "ready" },
        ],
      }],
    },
  ],
  hosts: [
    { hostId: "local", status: "ok" },
    { hostId: "team-a", status: "ok" },
    { hostId: "team-b", status: "unreachable", error: "host did not answer its health probe" },
  ],
  openQueue: [],
  stallThresholdMinutes: 30,
  enabledProgressSources: ["queue-transition"],
};

/** What the CLI-side fan-out would have to fetch, if it runs. */
const PER_HOST_PS: Record<string, { status: number; data: unknown }> = {
  "http://team-a:7433/api/ps": { status: 200, data: [{ rigId: "rig-a", rigName: "team-a", name: "team-a", nodeCount: 2, runningCount: 1, attentionCount: 1, hasWorkCount: 1, status: "partial" }] },
  "http://team-b:7433/api/ps": { status: 500, data: { error: "boom" } },
};

function depsWith(factory: (url: string) => DaemonClient): PsDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: factory,
    hostRegistryLoader: mockRegistry(HOSTS),
  } as unknown as PsDeps;
}

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("rig ps --all-hosts — uses the daemon-side fleet summary when served", () => {
  it("projects the summary instead of dialing every host itself", async () => {
    const factory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : PER_HOST_PS[url]));
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    // The rig row came from the summary: it carries the stall verdict, which the
    // old per-host /api/ps row never had.
    const row = payload.items.find((r: { rigName: string }) => r.rigName === "team-a");
    expect(row).toMatchObject({ hostId: "team-a", attentionCount: 1, stalled: true, minutesSinceProgress: 60 });
    // Every host the summary reported that this command targets is in hosts[],
    // including the unreachable one. The summary's own `local` row is NOT added:
    // `--all-hosts` targets the registered hosts, exactly as it did before.
    expect(payload.hosts.map((h: { hostId: string }) => h.hostId)).toEqual(["team-a", "team-b"]);
    expect(payload.hosts.find((h: { hostId: string }) => h.hostId === "team-b")).toMatchObject({ status: "unreachable" });
    // And it did NOT fan out per host.
    expect(factory._calls.filter((p) => p.endsWith("/api/ps"))).toEqual([]);
    expect(factory._calls.some((p) => p.endsWith("/api/fleet/summary"))).toBe(true);
  });

  it("--nodes projects the summary's seat rows, so no second fan-out is needed", async () => {
    const factory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    const sessions = payload.items.map((n: { canonicalSessionName: string }) => n.canonicalSessionName);
    expect(sessions).toContain("orch-lead@team-a");
    expect(sessions).toContain("dev-build@team-a");
    expect(factory._calls.filter((p) => p.includes("/api/rigs/"))).toEqual([]);
  });

  it("a failed host still lands in hosts[] as a structured status, not a silent absence", async () => {
    const factory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    const down = payload.hosts.find((h: { hostId: string }) => h.hostId === "team-b");
    expect(down.status).toBe("unreachable");
    expect(down.error).toContain("health probe");
    // A failed host has no items, and that is disclosed rather than counted as zero.
    expect(payload.items.find((r: { hostId: string }) => r.hostId === "team-b")).toBeUndefined();
    expect(process.exitCode).toBe(3);
  });

  it("--hosts narrows the summary to the requested ids", async () => {
    const factory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--hosts", "team-a", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    expect(payload.hosts.map((h: { hostId: string }) => h.hostId)).toEqual(["team-a"]);
  });
});

describe("rig ps --all-hosts — the two paths must not disagree", () => {
  // The whole reason the fleet read is allowed to substitute for the CLI's own fan-out
  // is that a reader cannot tell which one produced the row. `runningCount` and
  // `status` are the fields most likely to be silently invented by a projection — a
  // seat count looks exactly like a running count — so they are compared here rather
  // than eyeballed. `sessionStatus` matters for a different reason: `--filter status=`
  // reads that column, and `lifecycleState` is a different vocabulary.
  const NODE_FIXTURE = [{
    logicalId: "orch.lead", canonicalSessionName: "orch-lead@team-a", nodeKind: "agent",
    runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", role: "lead",
  }];

  const bothPaths = () => {
    const summaryFactory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : PER_HOST_PS[url]));
    const fanOutFactory = makeFactory((url) => {
      if (url.endsWith("/api/fleet/summary")) return undefined; // an older daemon
      if (url.includes("/api/rigs/")) return { status: 200, data: NODE_FIXTURE };
      return PER_HOST_PS[url];
    });
    return { summaryFactory, fanOutFactory };
  };

  it("rig rows carry the same running/status pair whichever path ran", async () => {
    const { summaryFactory, fanOutFactory } = bothPaths();
    const viaSummary = JSON.parse((await captureLogs(() => makeCmd(depsWith(summaryFactory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]))).join("\n"));
    const viaFanOut = JSON.parse((await captureLogs(() => makeCmd(depsWith(fanOutFactory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]))).join("\n"));
    const pick = (p: Record<string, unknown>[]) => (p as Array<Record<string, unknown>>)
      .filter((r) => r.rigName === "team-a")
      .map((r) => ({ nodeCount: r.nodeCount, runningCount: r.runningCount, attentionCount: r.attentionCount, hasWorkCount: r.hasWorkCount, status: r.status }));
    const a = pick(viaSummary.items);
    const b = pick(viaFanOut.items);
    expect(a).toEqual(b);
    // And the value is the origin's, not a seat count in disguise: the fixture says
    // 2 declared seats, 1 running, so `partial` is the only honest status.
    expect(a[0]).toMatchObject({ nodeCount: 2, runningCount: 1, status: "partial" });
  });

  it("node rows carry the real sessionStatus, not lifecycleState in disguise", async () => {
    // `--filter status=` reads sessionStatus, and lifecycleState is a DIFFERENT
    // vocabulary. The fixture gives the two seats different values in each column, so
    // a projection that copied the wrong one cannot pass.
    const factory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    const waiting = payload.items.find((n: { canonicalSessionName: string }) => n.canonicalSessionName === "dev-build@team-a");
    expect(waiting).toMatchObject({ sessionStatus: "waiting" });
    const running = payload.items.find((n: { canonicalSessionName: string }) => n.canonicalSessionName === "orch-lead@team-a");
    expect(running).toMatchObject({ sessionStatus: "running" });
  });

  it("--full carries nodeKind through, and the compact projection drops it on BOTH paths", async () => {
    // The compact projection is a pre-existing whitelist and it does not carry
    // nodeKind. That is fine only because it is the SAME whitelist on both paths — a
    // reader must not be able to tell which ran — so this pins the equality rather than
    // pretending the field is in the default output.
    const summaryFactory = makeFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    const out = await captureLogs(() => makeCmd(depsWith(summaryFactory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--full", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    expect(payload.items[0]).toMatchObject({ nodeKind: "agent", sessionStatus: "running" });

    const compact = JSON.parse((await captureLogs(() => makeCmd(depsWith(summaryFactory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--nodes", "-A", "--json"]))).join("\n"));
    expect(compact.items[0]).not.toHaveProperty("nodeKind");
  });
});

describe("rig ps --all-hosts — the reader waits as long as the fan-out can take", () => {
  // The regression this pins: `tryFleetSummary` silently falling back to the client's
  // 5 s default. Every other test in this file uses a URL-only double and would still
  // pass, because the timeout is invisible to them — and a 5 s reader abandons a healthy
  // multi-host fan-out, then pays for a second one in its fallback. That is the whole
  // cost this read exists to remove.
  it("passes a wait well above the 5 s client default", async () => {
    const factory = makeTimeoutCapturingFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
    await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    expect(factory._timeouts).toHaveLength(1);
    const wait = factory._timeouts[0]!.timeoutMs;
    expect(wait).toBeTypeOf("number");
    expect(wait!).toBeGreaterThan(5_000);
  });

  it("follows the operator's configured host timeout, not the compiled default", async () => {
    // F7 made the per-host budget an operator setting and the route applies it. A reader
    // still computing from the 5 s default is wrong under exactly that configuration:
    // five hosts at a 15 s budget is two waves, about 30 s of fan-out, and a 20 s reader
    // gives up on work that is proceeding normally.
    const configPath = join(process.env["OPENRIG_HOME"] ?? "/tmp", "config.json");
    writeFileSync(configPath, JSON.stringify({ fleet: { hostTimeoutMs: 15_000, fanoutConcurrency: 2 } }));
    try {
      const factory = makeTimeoutCapturingFactory((url) => (url.endsWith("/api/fleet/summary") ? { status: 200, data: SUMMARY } : undefined));
      await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
      const wait = factory._timeouts[0]!.timeoutMs!;
      // Two registered hosts plus the hub's own local leg, at a cap of 2, is 2 waves of
      // 15 s. A reader on the default would wait far less.
      expect(wait).toBeGreaterThanOrEqual(2 * 15_000);
    } finally {
      rmSync(configPath, { force: true });
    }
  });
});

describe("rig ps --all-hosts — falls back when the daemon does not serve the read", () => {
  it("an older daemon that 404s the route gets today's CLI-side fan-out, unchanged", async () => {
    const factory = makeFactory((url) => PER_HOST_PS[url]); // no /api/fleet/summary answer
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    // The per-host legs ran — that IS the fallback.
    expect(factory._calls).toContain("http://team-a:7433/api/ps");
    expect(payload.items.find((r: { rigName: string }) => r.rigName === "team-a")).toBeDefined();
    expect(payload.hosts.map((h: { hostId: string }) => h.hostId)).toEqual(["team-a", "team-b"]);
    // No stall fields: they belong to the new read, not to the old path.
    expect(payload.items.find((r: { rigName: string }) => r.rigName === "team-a").stalled).toBeUndefined();
  });

  it("a malformed 200 body is a miss, not a crash, and the fallback runs", async () => {
    const factory = makeFactory((url) => {
      if (url.endsWith("/api/fleet/summary")) return { status: 200, data: { items: "not an array" } };
      return PER_HOST_PS[url];
    });
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    expect(factory._calls).toContain("http://team-a:7433/api/ps");
    expect(Array.isArray(payload.hosts)).toBe(true);
  });

  it("no local daemon at all (the read throws) falls back rather than failing the command", async () => {
    const factory = makeFactory((url) => {
      if (!url.includes("team-")) throw new Error("ECONNREFUSED");
      return PER_HOST_PS[url];
    });
    const out = await captureLogs(() => makeCmd(depsWith(factory)).parseAsync(["node", "rig", "ps", "--all-hosts", "--json"]));
    const payload = JSON.parse(out.join("\n"));
    expect(payload.hosts.map((h: { hostId: string }) => h.hostId)).toEqual(["team-a", "team-b"]);
  });
});
