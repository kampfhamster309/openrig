import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot, fleetHasRemoteHost, type HydrateViewContext } from "../src/hydrate.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { FLEET_USAGE_TOP_ROWS } from "../src/types.js";
import type { FleetSnapshot, FleetUsageRead } from "../src/types.js";

// The TUI's half of the hub-side fleet USAGE read.
//
// The promises, in order of how much they cost to get wrong:
//
//  1. An operator with NO remote hosts is untouched by this feature — not one new line
//     on the page, and not one extra fan-out per poll. A hub with one machine has no
//     second host to add up, and a usage block there would be a section about nothing.
//  2. A seat is shown WITH ITS HOST. On a hub the same seat name can exist on two
//     machines; an unlabelled row is a row about the wrong team.
//  3. A host the hub could not read is UNKNOWN, never zero. A zero is a measurement, and
//     rendering "this team used nothing" for a team that was unreachable is how a fleet
//     read quietly lies to the person making decisions from it.
//  4. The subscription provider windows are NOT rendered, sorted or totalled. They are
//     absent on an API-key runtime, and a percentage of one seat's window is not
//     comparable to another's.
//  5. The block's height is bounded, because it sits above the instance table.

const pulse = (over: Partial<HydrateViewContext> = {}): HydrateViewContext => ({
  project: null, section: "topology", viewTab: "pulse", drill: [], file: null,
  externalUrl: null, terminalView: null, attentionOpen: null, pendingDrill: null, expanded: [],
  ...over,
});

// The state the operator actually reaches by navigating: Topology, drilled into the hub's
// own host, on the table tab. `pulse()` above is NOT this — PULSE renders a different
// screen, so a read proven only there is a read the instance page never gets.
const instancePage = (over: Partial<HydrateViewContext> = {}): HydrateViewContext => ({
  project: null, section: "topology", viewTab: "table", drill: [{ kind: "host", name: "local" }],
  file: null, externalUrl: null, terminalView: null, attentionOpen: null, pendingDrill: null, expanded: [],
  ...over,
});

const LOCAL = "local";
const REMOTE = "t-team-a";
const OTHER = "t-team-b";

/** One seat, exactly as the origin computed it — including `windows[]`, which the TUI
 *  must never touch. It rides the fixture on purpose: the only way to prove nothing
 *  renders a field is to serve one that HAS it. */
const seat = (hostId: string, session: string, tokensDelta: number) => ({
  hostId,
  seatSession: session,
  tokensPerHour: tokensDelta * 2,
  tokensDelta,
  resets: 0,
  spanHours: 0.5,
  samples: 12,
  windows: [{ window: "five_hour", usedPercentFirst: 10, usedPercentLast: 40, percentPerHour: 60, resetsAt: null }],
});

const hostUsage = (
  hostId: string,
  opts: { state?: "ok" | "unavailable"; reason?: string; ranked?: ReturnType<typeof seat>[] } = {},
) => ({
  hostId,
  kind: hostId === LOCAL ? "local" : "remote",
  status: "ok",
  reachable: true,
  usage: opts.state === "unavailable"
    // `totals` ABSENT is what means "no measurement". An empty ranked list would not.
    ? { state: "unavailable", reason: opts.reason, ranked: [], unknown: [] }
    : {
        state: "ok",
        windowHours: 1,
        sinceIso: "2026-10-24T07:00:00.000Z",
        ranked: opts.ranked ?? [],
        unknown: [],
        totalRankedSeats: (opts.ranked ?? []).length,
        totals: {
          tokensDelta: (opts.ranked ?? []).reduce((n, s) => n + s.tokensDelta, 0),
          resets: 0,
          seatsRanked: (opts.ranked ?? []).length,
          seatsUnknown: 0,
        },
      },
  partialFailures: [],
});

const usagePayload = (items: ReturnType<typeof hostUsage>[]): FleetUsageRead & { items: unknown[] } => {
  const ranked = items.flatMap((i) => (i.usage as { ranked: ReturnType<typeof seat>[] }).ranked);
  const answering = items.filter((i) => i.usage.state === "ok");
  return {
    windowHours: 1,
    sinceIso: "2026-10-24T07:00:00.000Z",
    top: ranked.map((s) => ({ hostId: s.hostId, seatSession: s.seatSession, tokensPerHour: s.tokensPerHour, tokensDelta: s.tokensDelta, resets: s.resets, spanHours: s.spanHours, samples: s.samples })),
    topCap: FLEET_USAGE_TOP_ROWS,
    totalSeatsRanked: ranked.length,
    unknown: [],
    totals: answering.length === 0 ? null : {
      tokensDelta: ranked.reduce((n, s) => n + s.tokensDelta, 0),
      resets: 0,
      seatsRanked: ranked.length,
      seatsUnknown: 0,
      hostsAnswered: answering.length,
      hostsTargeted: items.length,
    },
    items: items as unknown[],
    hostTimeoutMs: 5_000,
    concurrency: 4,
    targetedHostIds: items.map((i) => i.hostId),
  } as unknown as FleetUsageRead & { items: unknown[] };
};

/** The summary payload is only here to name the fleet's hosts — that is the gate the
 *  usage read hangs on. `targetedHostIds` is the field the gate reads. */
const summaryWith = (hostIds: string[]) => ({
  items: hostIds.map((hostId) => ({
    hostId, kind: hostId === LOCAL ? "local" : "remote", reachable: true,
    progress: { lastQueueTransitionAt: null, minutesSinceProgress: null, stalled: false, openWorkCount: 0 },
    rigs: [],
  })),
  hosts: hostIds.map((hostId) => ({ hostId, status: "ok" })),
  targetedHostIds: hostIds,
  openQueue: [],
  generatedAt: "2026-10-24T08:00:00.000Z",
  stallThresholdMinutes: 30,
  hostTimeoutMs: 5_000,
  concurrency: 4,
});

const USAGE_ROUTE = `/api/fleet/usage?window_hours=1&top=${FLEET_USAGE_TOP_ROWS}`;

function hubClient(fleet: () => unknown, usage: () => unknown) {
  const routes: string[] = [];
  const fixtures: Record<string, unknown> = {
    "/healthz": { ok: true, selfHostId: LOCAL },
    "/api/health?limit=200": { evaluatedAt: null, total: 0, truncated: false, records: [] },
    "/api/rigs/summary": [],
    "/api/queue/attention-aggregate": { items: [], hosts: [{ hostId: LOCAL, status: "ok" }] },
    "/api/review/fleet": { scope: "fleet", needsYou: { items: [] }, agents: { scope: "fleet", rows: [], provenance: "", coordinationHealth: null }, settled: [], settledProvenance: "", composedAt: "2026-10-24T08:00:00.000Z" },
    "/api/stream/list?limit=5&direction=latest": [],
    "/api/queue/list?attention=1": [],
    "/api/queue/list?state=blocked": [],
    "/api/queue/list?state=in-progress": [],
    "/api/queue/list?state=pending&limit=50": [],
    "/api/queue/list?state=done,handed-off&limit=20": [],
    "/api/queue/recent-transitions?scope=instance&limit=20": [],
    "/api/scopes?detail=1": { missions: [] },
    "/api/views/execution": { rows: [] },
  };
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    routes.push(route);
    if (route === "/api/fleet/summary") {
      const body = fleet();
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body } as Response;
    }
    if (route === USAGE_ROUTE) {
      const body = usage();
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body } as Response;
    }
    if (!(route in fixtures)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => fixtures[route] } as Response;
  }) as typeof fetch;
  return { client: new DaemonClient({ baseUrl: "http://x", fetchImpl }), routes };
}

const retention = () => ({ last: null, lastUsage: null });

describe("the usage read is asked only of a fleet that has a remote host", () => {
  it("no remote hosts: the route is never requested and the snapshot carries nothing", async () => {
    const { client, routes } = hubClient(() => summaryWith([LOCAL]), () => {
      throw new Error("the usage route must not be dialed for a local-only fleet");
    });
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention());
    expect(routes.filter((r) => r.startsWith("/api/fleet/usage"))).toEqual([]);
    expect(snap.fleetUsage).toBeNull();
    expect(snap.readErrors).toEqual([]);
  });

  it("one remote host: the read is asked for a one-hour window", async () => {
    const { client, routes } = hubClient(
      () => summaryWith([LOCAL, REMOTE]),
      () => usagePayload([hostUsage(LOCAL), hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 4000)] })]),
    );
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention());
    expect(routes).toContain(USAGE_ROUTE);
    expect(snap.fleetUsage?.top.map((s) => `${s.hostId}/${s.seatSession}`)).toEqual([`${REMOTE}/dev-build@team-a`]);
  });

  it("every remote host down still asks: the gate counts hosts PROBED, not hosts that answered", () => {
    // `items` only holds hosts that answered. Sized from it, a fleet whose one remote
    // host is timing out would look local — the fleet on fire would render the same page
    // as the single-machine operator.
    expect(fleetHasRemoteHost({ targetedHostIds: [LOCAL, REMOTE], items: [] } as never)).toBe(true);
    expect(fleetHasRemoteHost({ targetedHostIds: [LOCAL], items: [] } as never)).toBe(false);
    expect(fleetHasRemoteHost(null)).toBe(false);
  });
});

describe("the page that DRAWS the block is the page that ASKS for it", () => {
  // Regression: the block renders on the drilled instance page while the read was gated
  // on the broad view, so the two never coincided and the block was unreachable. Every
  // other test in this file either dialed from the PULSE context or injected the payload
  // into the snapshot, and neither path crosses the seam where the bug lived. The render
  // half is covered by the describe block below; this half is the gate.
  it("the hub's instance page asks for the usage read", async () => {
    const { client, routes } = hubClient(
      () => summaryWith([LOCAL, REMOTE]),
      () => usagePayload([hostUsage(LOCAL), hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 4000)] })]),
    );
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, instancePage(), retention());
    expect(routes).toContain(USAGE_ROUTE);
    expect(snap.fleetUsage).not.toBeNull();
  });

  it("a local-only fleet still asks nothing on that page: no USAGE fan-out", async () => {
    // Scoped to the usage route on purpose. Since the read/render seam was fixed, the
    // drilled host page also asks `/api/fleet/summary`; what must stay absent for a
    // single-machine operator is the usage fan-out, which has nothing to add up.
    const { client, routes } = hubClient(() => summaryWith([LOCAL]), () => {
      throw new Error("the usage route must not be dialed for a local-only fleet");
    });
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, instancePage(), retention());
    expect(routes.filter((r) => r.startsWith("/api/fleet/usage"))).toEqual([]);
    expect(snap.fleetUsage).toBeNull();
  });
});

describe("a failed usage read does not blank the block or lie about it", () => {
  it("a 404 is an absent feature: nothing rendered, nothing named", async () => {
    // An operator on an older daemon has no expectation to fail. A status-line complaint
    // every poll would report a problem that does not exist.
    const { client } = hubClient(() => summaryWith([LOCAL, REMOTE]), () => new Error("fleet-usage → 404 not found"));
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention());
    expect(snap.fleetUsage).toBeNull();
    expect(snap.readErrors).toEqual([]);
  });

  it("a timeout keeps the last good payload and says it is stale", async () => {
    let fail = false;
    const { client } = hubClient(
      () => summaryWith([LOCAL, REMOTE]),
      () => (fail ? new Error("fleet-usage → 504 gateway timeout") : usagePayload([hostUsage(LOCAL), hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 4000)] })])),
    );
    const keep = retention();
    const good = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), keep);
    expect(good.fleetUsage?.top.length).toBe(1);
    expect(good.readErrors).toEqual([]);

    fail = true;
    const after = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), keep);
    expect(after.fleetUsage?.top.length).toBe(1);
    expect(after.readErrors.some((e) => /fleet-usage/.test(e) && /last successful read/.test(e))).toBe(true);

    fail = false;
    const recovered = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), keep);
    expect(recovered.readErrors.filter((e) => /fleet-usage/.test(e))).toEqual([]);
  });

  it("a usage failure does not blank the fleet summary, or vice versa", async () => {
    // Two routes, two caches, two failure modes. One going down must not be reported as
    // a fleet change by blanking the other's sections for a frame.
    let failUsage = true;
    const { client } = hubClient(
      () => ({ ...summaryWith([LOCAL, REMOTE]), items: [{ hostId: REMOTE, kind: "remote", reachable: true, rigs: [], progress: { lastQueueTransitionAt: "2026-10-24T07:00:00.000Z", minutesSinceProgress: 61, stalled: true, openWorkCount: 2 } }] }),
      () => (failUsage ? new Error("fleet-usage → 500 boom") : usagePayload([hostUsage(REMOTE)])),
    );
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention());
    expect(snap.stalled.length).toBeGreaterThan(0);
    expect(snap.fleetUsage).toBeNull();
    expect(snap.readErrors.some((e) => /fleet-usage/.test(e))).toBe(true);
  });
});

// ── the render ────────────────────────────────────────────────────────────────

function instanceScreen(snap: FleetSnapshot, hostName = snap.hosts[0]!.name): string {
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "topology" });
  view.dispatch({ type: "drill", resource: "host", name: hostName });
  const screen = renderScreen(view.get(), snap, { cols: 160, rows: 60, colorMode: "none", nowMs: 0 }, "");
  return screen.lines.join("\n");
}

function snapWithUsage(items: ReturnType<typeof hostUsage>[]): FleetSnapshot {
  return { ...demoSnapshot(), fleetUsage: usagePayload(items) as FleetUsageRead };
}

describe("FLEET USAGE on the instance page", () => {
  it("every seat row carries its host", () => {
    const snap = snapWithUsage([
      hostUsage(LOCAL),
      hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] }),
      hostUsage(OTHER, { ranked: [seat(OTHER, "dev-build@team-b", 9_100)] }),
    ]);
    const text = instanceScreen(snap);
    expect(text).toContain("FLEET USAGE");
    expect(text).toContain(`[${REMOTE}] dev-build@team-a`);
    expect(text).toContain(`[${OTHER}] dev-build@team-b`);
  });

  it("no remote hosts, no block: the page grows no section about a fleet it has none of", () => {
    // The counterweight to the test above. `fleetUsage` is null whenever there was no
    // remote host to ask about, and the instance page must not grow a section about it.
    // Asserted against a payload-bearing sibling rather than against another null: two
    // nulls render identically by construction, which would make the old form of this
    // test true whether or not the gate existed at all.
    const localOnly = demoSnapshot();
    const withFleet = snapWithUsage([
      hostUsage(LOCAL),
      hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] }),
    ]);
    expect(instanceScreen(withFleet)).toContain("FLEET USAGE");
    const after = instanceScreen(localOnly);
    expect(after).not.toContain("FLEET USAGE");
    expect(after).not.toContain("sampled context-window readings");
  });

  it("it is the HUB's page: a remote host's own instance page renders no fleet block", () => {
    // The block ranks seats across EVERY host. Printing it under one host would put a
    // fleet-wide total on a page whose whole subject is a single machine, and the
    // operator would read the fleet's number as that host's.
    const snap = snapWithUsage([
      hostUsage(LOCAL),
      hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] }),
    ]);
    expect(instanceScreen(snap, "remote-host")).not.toContain("FLEET USAGE");
    // Same snapshot, hub page: the block is there. So the absence above is the gate
    // working, not a fixture that never renders.
    expect(instanceScreen(snap)).toContain("FLEET USAGE");
  });

  it("an unreadable host is unknown with its reason, never a zero", () => {
    const snap = snapWithUsage([
      hostUsage(LOCAL),
      hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] }),
      hostUsage(OTHER, { state: "unavailable", reason: "connect ECONNREFUSED" }),
    ]);
    const text = instanceScreen(snap);
    expect(text).toContain(`[${OTHER}] usage unknown — connect ECONNREFUSED`);
    // The header says which total is partial rather than printing a bare number that a
    // reader would take for the whole fleet.
    expect(text).toContain("2 of 3 hosts answered");
  });

  it("no host answering is stated as unknown, not as zero tokens", () => {
    const snap = snapWithUsage([hostUsage(LOCAL, { state: "unavailable", reason: "no_fresh_samples" })]);
    const text = instanceScreen(snap);
    expect(text).toContain("no host answered — usage unknown");
    expect(text).not.toMatch(/0 tokens/);
  });

  it("the block cannot grow past its cap, and the cut is said out loud", () => {
    const many = Array.from({ length: FLEET_USAGE_TOP_ROWS + 5 }, (_, i) => seat(REMOTE, `dev-build@team-a-${i}`, 1000 + i));
    const payload = usagePayload([hostUsage(LOCAL), hostUsage(REMOTE, { ranked: many })]);
    const text = instanceScreen({ ...demoSnapshot(), fleetUsage: payload });
    const rows = text.split("\n").filter((line) => line.includes(`[${REMOTE}] dev-build@team-a-`));
    expect(rows.length).toBe(FLEET_USAGE_TOP_ROWS);
    expect(text).toContain("+5 more ranked seats");
  });

  it("subscription windows are never rendered, even when the payload carries them", () => {
    // The standing rule: five_hour / weekly are subscription provider lanes, a runtime on
    // API keys does not observe them, and a percentage of one seat's window is not
    // comparable to another's. The fixture serves them so this test can prove it.
    const snap = snapWithUsage([hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] })]);
    const text = instanceScreen(snap);
    expect(text).not.toMatch(/five_hour|weekly|percentPerHour|usedPercent/i);
  });

  it("the numbers are described as what they are", () => {
    // State plainly that these are sampled readings, not token or cost accounting.
    const snap = snapWithUsage([hostUsage(REMOTE, { ranked: [seat(REMOTE, "dev-build@team-a", 12_400)] })]);
    expect(instanceScreen(snap)).toContain("not token or cost accounting");
  });
});
