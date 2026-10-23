import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot, fleetReadOutcome, fleetReaderTimeoutFor, type HydrateViewContext } from "../src/hydrate.js";

// The hydrate layer's contract for the hub-side fleet summary.
//
// Two promises are pinned here, and both are about what the page does when the read
// does not go the way the happy path did:
//
//  1. An operator with NO remote hosts sees no new section. The daemon always computes
//     a stall verdict for its own host, so without a gate a single-machine operator
//     whose own in-progress row went quiet would suddenly get a ⚑ STALLED section
//     labelled with their own laptop. The brief is explicit: no remote hosts, no change.
//
//  2. A FAILED fleet read keeps the last good payload and says so. The TUI polls; one
//     timeout would otherwise blank STALLED and every remote row for that poll and
//     bring them back on the next — flicker that reads as the fleet changing when only
//     a read failed. Serving the previous answer is honest only if the failure is named.

const pulse = (over: Partial<HydrateViewContext> = {}): HydrateViewContext => ({
  project: null, section: "topology", viewTab: "pulse", drill: [], file: null,
  externalUrl: null, terminalView: null, attentionOpen: null, pendingDrill: null, expanded: [],
  ...over,
});

// The sentinel the fan-out contract uses for the daemon's own host — not its
// selfHostId, which is a different string. The gate compares this.
const LOCAL = "local";
const REMOTE = "t-team-a";

const hostEntry = (hostId: string) => ({ hostId, status: "ok" });

const stalledHost = (hostId: string) => ({
  hostId, kind: "remote", reachable: true, rigCount: 1, seatCount: 1, attentionCount: 0,
  openQueueCount: 2,
  progress: { lastQueueTransitionAt: "2026-10-23T11:00:00.000Z", lastSeatOutputAt: "2026-10-23T11:59:00.000Z", minutesSinceProgress: 61, stalled: true, openWorkCount: 2 },
  rigs: [{
    rigId: "rig-a", rigName: "team-a", hostId, seatCount: 1, attentionCount: 0, seatsWithAssignedWork: 1,
    lifecycleState: "running", runningCount: 1, psStatus: "running",
    progress: { lastQueueTransitionAt: "2026-10-23T11:00:00.000Z", lastSeatOutputAt: "2026-10-23T11:59:00.000Z", minutesSinceProgress: 61, stalled: true, openWorkCount: 2 },
    seats: [],
  }],
});

const summary = (hostIds: string[]) => ({
  items: hostIds.map(stalledHost),
  hosts: [hostEntry(LOCAL), ...hostIds.filter((h) => h !== LOCAL).map(hostEntry)],
  openQueue: [],
  generatedAt: "2026-10-23T12:00:00.000Z",
  stallThresholdMinutes: 30,
  enabledProgressSources: ["queue-transition"],
});

/** A hub whose route table is driven per-test, so one case can serve a payload and the
 *  next can make the same read throw. */
function hubClient(fleet: () => unknown) {
  const routes: string[] = [];
  const fixtures: Record<string, unknown> = {
    "/healthz": { ok: true, selfHostId: LOCAL },
    "/api/health?limit=200": { evaluatedAt: null, total: 0, truncated: false, records: [] },
    "/api/rigs/summary": [],
    "/api/queue/attention-aggregate": { items: [], hosts: [hostEntry(LOCAL)] },
    "/api/review/fleet": { scope: "fleet", needsYou: { items: [] }, agents: { scope: "fleet", rows: [], provenance: "", coordinationHealth: null }, settled: [], settledProvenance: "", composedAt: "2026-10-23T12:00:00.000Z" },
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
    if (!(route in fixtures)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => fixtures[route] } as Response;
  }) as typeof fetch;
  return { client: new DaemonClient({ baseUrl: "http://x", fetchImpl }), routes };
}

describe("⚑ STALLED is a FLEET claim, not a local one", () => {
  it("a local-only fleet renders no STALLED section", async () => {
    // The daemon answers a local verdict even with no registry, and it says `stalled`.
    // Rendering it would be a new section on a single-machine operator's page, saying
    // their own machine has gone quiet — which is not what this read is for.
    const { client } = hubClient(() => summary([LOCAL]));
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse());
    expect(snap.stalled).toEqual([]);
    expect(snap.fleetProbed).toBe(true);
  });

  it("the moment a remote host is present, its stalled rigs are rendered", async () => {
    // The counterweight: the gate must not swallow the feature. With one remote host,
    // the hub's verdict is the whole point of the read.
    const { client } = hubClient(() => summary([LOCAL, REMOTE]));
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse());
    const rows = snap.stalled.map((r) => `${r.level}:${r.rigName ?? r.hostId}`);
    expect(rows).toContain("rig:team-a");
    expect(snap.stalled.some((r) => r.minutesSinceProgress === 61)).toBe(true);
  });
});

describe("a failed fleet read does not blank the page", () => {
  it("the last good payload survives a failed poll, and the failure is named", async () => {
    // ONE client and ONE retention, polled twice — which is now exactly how the TUI runs,
    // since the retention is caller-owned rather than module state. The sections must
    // not blank for a frame and come back; the reader must be told they are stale.
    let fail = false;
    const { client } = hubClient(() => (fail ? new Error("fleet-summary → 504 gateway timeout") : summary([LOCAL, REMOTE])));
    const retention = { last: null };
    const good = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention);
    expect(good.stalled.length).toBeGreaterThan(0);
    expect(good.readErrors).toEqual([]);

    fail = true;
    const after = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention);
    expect(after.stalled.length).toBeGreaterThan(0);
    expect(after.readErrors.some((e) => /fleet-summary/.test(e) && /last successful read/.test(e))).toBe(true);

    // A later good poll clears the complaint rather than merging with the leftover.
    fail = false;
    const recovered = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), retention);
    expect(recovered.readErrors.filter((e) => /fleet-summary/.test(e))).toEqual([]);
  });

  it("retention is per-caller, so one client's leftover cannot leak into another's", async () => {
    // The reason this is caller-owned and not module state: two hydrations in one process
    // (tests, or a caller with two hubs) must not inherit each other's fleet.
    let fail = false;
    const { client } = hubClient(() => (fail ? new Error("fleet-summary → 504 gateway timeout") : summary([LOCAL, REMOTE])));
    const mine = { last: null };
    await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), mine);
    fail = true;
    const stranger = { last: null };
    const other = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), stranger);
    expect(other.stalled).toEqual([]);
    expect(other.readErrors.some((e) => /last successful read/.test(e))).toBe(false);
  });

  it("a failed read with a previous good payload keeps it and says it is stale", () => {
    // Tested as the pure judgement it is, not through two hydrate calls: this harness
    // re-instantiates the module between reads, so cross-call module state is not
    // observable here even though it is correct in the long-lived TUI process.
    const lastGood = summary([LOCAL, REMOTE]) as unknown as Parameters<typeof fleetReadOutcome>[1];
    const out = fleetReadOutcome("fleet-summary → 504 gateway timeout", lastGood);
    expect(out.payload).toBe(lastGood);
    expect(out.failed).toMatch(/fleet-summary/);
    expect(out.failed).toMatch(/last successful read/);
  });

  it("a failed read with nothing previous reports the failure and serves nothing", () => {
    // No invented history. The sections are absent because they were never confirmed.
    const out = fleetReadOutcome("fleet-summary → 504 gateway timeout", null);
    expect(out.payload).toBeNull();
    expect(out.failed).toMatch(/fleet-summary/);
    expect(out.failed).not.toMatch(/last successful read/);
  });

  it("the reader's wait comes from the last payload's own budget, not the defaults", () => {
    // R1's regression: the reader computes its wait from compiled defaults while the
    // ROUTE applies the operator's configured ones. Five hosts at a 15 s budget is two
    // waves, ~30 s of fan-out; a reader that assumed 5 s gives up at 20 s and the page
    // loses its remote sections for that poll. The payload echoes the numbers it used,
    // so the next poll can be sized from the truth.
    expect(fleetReaderTimeoutFor(null)).toBeGreaterThan(5_000);
    const withBudget = { ...summary([LOCAL, REMOTE]), hostTimeoutMs: 15_000, concurrency: 2, targetedHostIds: ["local", "a", "b", "c", "d", "e"] };
    expect(fleetReaderTimeoutFor(withBudget as never)).toBeGreaterThanOrEqual(2 * 15_000);
    // And the count must come from targetedHostIds, which includes hosts that FAILED.
    // Sizing from `items` would shrink the wait exactly when hosts are timing out — the
    // moment the reader most needs a longer wait.
    const allDown = { ...summary([]), hostTimeoutMs: 15_000, concurrency: 2, targetedHostIds: ["local", "a", "b", "c", "d", "e"], items: [] };
    expect(fleetReaderTimeoutFor(allDown as never)).toBe(fleetReaderTimeoutFor(withBudget as never));
  });

  it("every remote host down still shows the hub's own stalled rigs", async () => {
    // The F4 nit, and it matters: `items` only holds hosts that ANSWERED. Sized from it,
    // the gate would decide "no remote hosts" the moment every remote went down — so a
    // fleet on fire would render the same page as a single-machine operator. The gate
    // reads the hosts the fan-out PROBED instead.
    const { client } = hubClient(() => ({
      items: [stalledHost(LOCAL)],
      hosts: [
        hostEntry(LOCAL),
        { hostId: REMOTE, status: "unreachable", error: "connect ECONNREFUSED" },
      ],
      targetedHostIds: ["local", REMOTE],
      openQueue: [],
      generatedAt: "2026-10-23T12:00:00.000Z",
      stallThresholdMinutes: 30,
    }));
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse(), { last: null });
    expect(snap.stalled.length).toBeGreaterThan(0);
  });

  it("a daemon with no such route is an absent feature, not a failed read", async () => {
    // An older daemon 404s. Nothing is invented, nothing is kept, and — the part that
    // matters — readErrors stays clean, because there was no expectation to fail.
    const out = fleetReadOutcome("fleet-summary → 404 not found", summary([LOCAL, REMOTE]) as unknown as Parameters<typeof fleetReadOutcome>[1]);
    expect(out.payload).toBeNull();
    expect(out.failed).toBeNull();

    const { client } = hubClient(() => { throw new Error("fleet-summary → 404 not found"); });
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse());
    expect(snap.stalled).toEqual([]);
    expect(snap.readErrors.filter((e) => /fleet-summary/.test(e))).toEqual([]);
  });
});
