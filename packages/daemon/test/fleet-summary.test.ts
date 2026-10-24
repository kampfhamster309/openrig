// The ONE fleet read — domain rules and fan-out discipline.
//
// What this file owns:
//   * the stall rule: progress is a queue
//     transition written by a seat or a human (note-only updates count, `@system`
//     actors do not); pane output is reported and never counted;
//   * omission-proof per-host status (every targeted host appears, ok or not);
//   * open queue items in EVERY open state with `blockedOn` (the payload the
//     attention aggregate never carried);
//   * the per-host deadline — a slow host burns its OWN budget, not the fleet's;
//   * the short cache and its single-flight.
//
// Zero network: every remote leg runs against a scripted fetch double.

import { describe, it, expect } from "vitest";
import {
  ACTIVE_PROGRESS_SOURCES,
  collectProgressEvents,
  composeFleetSummary,
  createFleetSummaryCache,
  deriveFleetProgress,
  isBlockedOnHuman,
  isProgressActor,
  newestIso,
  projectFleetQueueItem,
  rigNameFromSession,
  summarizeSeatActivity,
  FLEET_HOST_TIMEOUT_MS,
  FLEET_STALL_THRESHOLD_MINUTES_DEFAULT,
  FLEET_TRANSITION_ITEM_LIMIT,
  type FleetFanOutResult,
  type FleetProgressSourceName,
  type FleetSummaryDeps,
  type LocalHostFacts,
} from "../src/domain/fleet/fleet-summary.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { FleetSummaryPayload } from "../src/domain/fleet/fleet-summary-types.js";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

// ---------------------------------------------------------------------------
// The stall rule, as settled
// ---------------------------------------------------------------------------

describe("deriveFleetProgress — the stall rule", () => {
  const base = { thresholdMinutes: FLEET_STALL_THRESHOLD_MINUTES_DEFAULT, nowMs: NOW };
  const RULE = ACTIVE_PROGRESS_SOURCES;

  it("the default threshold is 30 minutes and the rule counts queue transitions only", () => {
    expect(FLEET_STALL_THRESHOLD_MINUTES_DEFAULT).toBe(30);
    expect(RULE).toEqual(["queue-transition"]);
  });

  it("open work + newest transition older than the threshold → stalled", () => {
    const p = deriveFleetProgress({
      ...base,
      openWorkCount: 2,
      sources: { lastQueueTransitionAt: iso(40), lastSeatOutputAt: iso(30) },
      enabledSources: RULE,
    });
    expect(p.stalled).toBe(true);
    expect(p.minutesSinceProgress).toBe(40);
    expect(p.lastProgressSource).toBe("queue-transition");
  });

  it("open work + a transition inside the threshold → not stalled", () => {
    const p = deriveFleetProgress({
      ...base,
      openWorkCount: 1,
      sources: { lastQueueTransitionAt: iso(10), lastSeatOutputAt: iso(30) },
      enabledSources: RULE,
    });
    expect(p.stalled).toBe(false);
  });

  it("PANE OUTPUT IS NOT PROGRESS: a live pane does not rescue a team with no transitions", () => {
    // The dispatcher-test shape, exactly: the pane redraws every second, so
    // `lastSeatOutputAt` is now, and nothing has moved on the queue for an hour.
    const p = deriveFleetProgress({
      ...base,
      openWorkCount: 1,
      sources: { lastQueueTransitionAt: iso(60), lastSeatOutputAt: iso(0) },
      enabledSources: RULE,
    });
    expect(p.stalled).toBe(true);
    // …and the pane fact is still REPORTED, so "loud and going nowhere" is visible.
    expect(p.lastSeatOutputAt).toBe(iso(0));
    expect(p.lastProgressAt).toBe(iso(60));
  });

  it("NO open work → never stalled, even with no progress at all", () => {
    const p = deriveFleetProgress({ ...base, openWorkCount: 0, sources: { lastQueueTransitionAt: null, lastSeatOutputAt: null }, enabledSources: RULE });
    expect(p.stalled).toBe(false);
    expect(p.lastProgressAt).toBeNull();
    expect(p.lastProgressSource).toBe("none");
  });

  it("open work + NO progress evidence at all → null (unknown), not stalled and not fine", () => {
    const p = deriveFleetProgress({ ...base, openWorkCount: 3, sources: { lastQueueTransitionAt: null, lastSeatOutputAt: null }, enabledSources: RULE });
    expect(p.stalled).toBeNull();
    expect(p.minutesSinceProgress).toBeNull();
    expect(p.lastProgressSource).toBe("none");
  });

  it("a threshold below 1 minute is floored, so an idle-but-open team is not stalled on the next poll", () => {
    const p = deriveFleetProgress({ ...base, thresholdMinutes: 0, openWorkCount: 1, sources: { lastQueueTransitionAt: iso(0.01), lastSeatOutputAt: null }, enabledSources: RULE });
    expect(p.stalled).toBe(false);
  });

  it("truncated progress reads are disclosed on the progress block", () => {
    const p = deriveFleetProgress({ ...base, openWorkCount: 99, sources: { lastQueueTransitionAt: iso(1), lastSeatOutputAt: null }, enabledSources: RULE, progressReadsTruncated: true });
    expect(p.progressReadsTruncated).toBe(true);
  });

  it("an unparseable timestamp loses to a real one instead of poisoning the comparison", () => {
    expect(newestIso(["not-a-date", iso(5), null, undefined])).toBe(iso(5));
    expect(newestIso([null, "", "nope"])).toBeNull();
  });
});

describe("isProgressActor — the watcher is not the team", () => {
  it("a seat or a human counts; a @system actor does not", () => {
    expect(isProgressActor("dev-build@team-a")).toBe(true);
    expect(isProgressActor("orch-lead@team-a")).toBe(true);
    expect(isProgressActor("human@host")).toBe(true);
    expect(isProgressActor("watchdog@system")).toBe(false);
    expect(isProgressActor("queue-worker@system")).toBe(false);
  });

  it("a missing actor is not evidence", () => {
    expect(isProgressActor(null)).toBe(false);
    expect(isProgressActor("")).toBe(false);
  });

  // Each of these is a REAL writer of queue transitions in the image the fan-out
  // reads, and none of them is a seat or a human. They are excluded by shape, not by
  // name-matching a known set of seats — an allowlist would drop humans and
  // hub-relayed cross-host actors, which are exactly who must keep a team alive.
  it("the bare `system` actor does not count (claim release on seat handover)", () => {
    expect(isProgressActor("system")).toBe(false);
  });

  it("a `system:`-prefixed subsystem actor does not count (fallback reroutes)", () => {
    expect(isProgressActor("system:queue-fallback")).toBe(false);
  });

  it("`daemon@kernel` does not count (Slack notes, delivery deferral, reply-to-choice)", () => {
    // The one that matters most: the deferral and Slack notes fire on precisely the
    // team waiting on a human, so counting them resets the stall clock on a dead team.
    expect(isProgressActor("daemon@kernel")).toBe(false);
  });

  it("a human seat and a hub-relayed cross-host actor still count", () => {
    // The counterweight: widening the exclusions must not quietly drop the actors
    // whose work is real. A human, and a session relayed from another host's hub.
    expect(isProgressActor("human-yeah@kernel")).toBe(true);
    expect(isProgressActor("dev-build@claude-pi-duo@host-9f2ab876")).toBe(true);
  });
});

describe("collectProgressEvents — both places a transition is readable", () => {
  const item = (qitemId: string, rigName: string) => ({
    hostId: "h", rigName, qitemId, state: "in-progress" as const, destinationSession: `dev-build@${rigName}`,
    sourceSession: null, blockedOn: null, priority: null, summary: null, tags: [], tsCreated: null, tsUpdated: null,
  });

  it("merges instance transitions with per-item notes and drops @system actors", () => {
    const events = collectProgressEvents({
      recentTransitions: [
        { ts: iso(55), rig: "team-a", actorSession: "orch-lead@team-a" },
        { ts: iso(2), rig: "team-a", actorSession: "watchdog@system" },
        { ts: null, rig: "team-a", actorSession: "orch-lead@team-a" },
      ],
      openQueue: [item("q1", "team-a")],
      openItemTransitions: [
        { qitemId: "q1", transitions: [
          { ts: iso(48), actorSession: "dev-build@team-a" },
          { ts: iso(1), actorSession: "watchdog@system" },
        ] },
      ],
    });
    expect(events.map((e) => e.ts).sort()).toEqual([iso(48), iso(55)].sort());
    expect(events.every((e) => e.rig === "team-a")).toBe(true);
  });

  it("attributes a note to the rig of the item it was written on", () => {
    const events = collectProgressEvents({
      recentTransitions: [],
      openQueue: [item("q1", "team-b")],
      openItemTransitions: [{ qitemId: "q1", transitions: [{ ts: iso(3), actorSession: "dev-build@team-b" }] }],
    });
    expect(events).toEqual([{ ts: iso(3), rig: "team-b" }]);
  });

  it("a note on an item that is no longer open attributes to no rig rather than guessing", () => {
    const events = collectProgressEvents({
      recentTransitions: [],
      openQueue: [],
      openItemTransitions: [{ qitemId: "gone", transitions: [{ ts: iso(3), actorSession: "dev-build@team-b" }] }],
    });
    expect(events).toEqual([{ ts: iso(3), rig: null }]);
  });
});

// ---------------------------------------------------------------------------
// Seat counting and queue projection
// ---------------------------------------------------------------------------

describe("summarizeSeatActivity", () => {
  it("buckets the four display values and counts total", () => {
    expect(summarizeSeatActivity(["working", "idle", "needs-input", "unknown"])).toEqual({
      working: 1, idle: 1, needsInput: 1, unknown: 1, total: 4,
    });
  });

  it("an absent or null display is `unknown`, never `idle`", () => {
    // A seat whose runtime hook went stale reports unknown; a seat on a daemon
    // too old to publish the taxonomy has no answer. Neither may read as idle.
    expect(summarizeSeatActivity([null, undefined, "idle"])).toMatchObject({ idle: 1, unknown: 2, total: 3 });
  });
});

describe("projectFleetQueueItem", () => {
  it("keeps blockedOn and attributes the item to a rig through the session grammar", () => {
    const item = projectFleetQueueItem(
      { qitemId: "q1", state: "blocked", destinationSession: "dev-build@team-a", blockedOn: "review.r1@team-a", summary: "s", tags: ["t"], tsCreated: "a", tsUpdated: "b" },
      "team-a",
    );
    expect(item).toMatchObject({ hostId: "team-a", rigName: "team-a", state: "blocked", blockedOn: "review.r1@team-a" });
  });

  it("drops a row in a closed state instead of coercing it", () => {
    expect(projectFleetQueueItem({ qitemId: "q1", state: "done" }, "h")).toBeNull();
  });

  it("falls back to the source session for rig attribution", () => {
    expect(projectFleetQueueItem({ qitemId: "q", state: "pending", sourceSession: "orch-lead@team-b" }, "h")?.rigName).toBe("team-b");
  });

  it("rigNameFromSession refuses a non-session token", () => {
    expect(rigNameFromSession("no-at-sign")).toBeNull();
    expect(rigNameFromSession("trail@")).toBeNull();
    expect(rigNameFromSession("a@b@c")).toBe("c");
  });

  it("tells a human blocker from an agent blocker", () => {
    expect(isBlockedOnHuman("human@host")).toBe(true);
    expect(isBlockedOnHuman("dev-qa@team-a")).toBe(false);
    expect(isBlockedOnHuman(null)).toBe(false);
    expect(isBlockedOnHuman("qitem-20260101000000-abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

/** A scripted remote: `routes` maps a path substring to a payload, `statuses` a
 *  URL substring to an HTTP status, `delays` a URL substring to a hang. Anything
 *  unmatched answers 404 so a leg the code should not make is visible. */
interface RemoteScript {
  routes?: Record<string, unknown>;
  statuses?: Record<string, number>;
  delays?: Record<string, number>;
}

function makeFetch(script: RemoteScript): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    for (const [needle, ms] of Object.entries(script.delays ?? {})) {
      // delays match the FULL url so a test can hang one host by its origin.
      if (!url.includes(needle)) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    for (const [needle, status] of Object.entries(script.statuses ?? {})) {
      if (url.includes(needle)) return new Response(JSON.stringify({ error: `nope ${status}` }), { status });
    }
    for (const [needle, payload] of Object.entries(script.routes ?? {})) {
      if (path.includes(needle)) return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "unscripted path " + path }), { status: 404 });
  }) as unknown as typeof fetch;
}

/** A team whose newest HUMAN/SEAT transition is 48 minutes old while its pane has
 *  been redrawing the whole time — the dispatcher-test failure, as data. */
const HEALTHY_TEAM = {
  "/healthz": {
    status: "ok", pid: 1, selfHostId: "host-team-a",
    stuckSweep: { lastSweepAt: iso(1), lastOutcome: "clean", lastError: null, consecutiveFailures: 0, findingsRouted: 0 },
  },
  "/api/ps": [
    { rigId: "rig-1", rigName: "team-a", name: "team-a", nodeCount: 2, runningCount: 2, attentionCount: 1, hasWorkCount: 1, lifecycleState: "running" },
  ],
  "/api/rigs/rig-1/nodes": [
    { logicalId: "orch.lead", canonicalSessionName: "orch-lead@team-a", role: "lead", runtime: "claude-code", activityState: { display: "idle", needsInput: { count: 0, reason: null } }, lastActivityAt: iso(50), lifecycleState: "running", startupStatus: "ready" },
    { logicalId: "dev.build", canonicalSessionName: "dev-build@team-a", role: "builder", runtime: "pi", activityState: { display: "working", needsInput: { count: 0, reason: null } }, lastActivityAt: iso(0), lifecycleState: "running", startupStatus: "ready" },
  ],
  "/api/queue/list": [
    { qitemId: "q-open", state: "in-progress", destinationSession: "dev-build@team-a", summary: "building", tags: [], tsCreated: iso(60), tsUpdated: iso(48) },
    { qitemId: "q-agent", state: "blocked", destinationSession: "dev-build@team-a", blockedOn: "review.r1@team-a", summary: "waiting on reviewer", tags: [], tsCreated: iso(60), tsUpdated: iso(48) },
    { qitemId: "q-human", state: "blocked", destinationSession: "orch-lead@team-a", blockedOn: "human@host", summary: "needs a decision", tags: [], tsCreated: iso(60), tsUpdated: iso(48) },
    { qitemId: "q-closed", state: "done", destinationSession: "dev-build@team-a", tags: [] },
  ],
  "/api/queue/overdue": [{ qitemId: "q-open" }],
  "/api/queue/undelivered": [],
  "/api/queue/recent-transitions": [
    { transitionId: 1, qitemId: "q-open", ts: iso(55), actorSession: "orch-lead@team-a", change: "claimed", summary: null, rig: "team-a", targetKind: "seat", target: "dev-build@team-a" },
    // The watcher poking a parked row is NOT the team's work moving.
    { transitionId: 2, qitemId: "q-human", ts: iso(1), actorSession: "watchdog@system", change: "park wake", summary: null, rig: "team-a", targetKind: "seat", target: "orch-lead@team-a" },
  ],
  // Note-only updates live ONLY here, which is why the read is per open item.
  "/api/queue/q-open/transitions": [
    { transitionId: 1, qitemId: "q-open", ts: iso(55), state: "in-progress", transitionNote: "claimed", actorSession: "orch-lead@team-a", closureReason: null, closureTarget: null, identityProvenance: null, ownerNotificationKind: null, ownerNotificationLevel: null },
    { transitionId: 2, qitemId: "q-open", ts: iso(48), state: "in-progress", transitionNote: "milestone: fan-out composed", actorSession: "dev-build@team-a", closureReason: null, closureTarget: null, identityProvenance: null, ownerNotificationKind: null, ownerNotificationLevel: null },
  ],
  "/api/queue/q-agent/transitions": [
    { transitionId: 3, qitemId: "q-agent", ts: iso(60), state: "blocked", transitionNote: "parked", actorSession: "orch-lead@team-a", closureReason: null, closureTarget: null, identityProvenance: null, ownerNotificationKind: null, ownerNotificationLevel: null },
  ],
  "/api/queue/q-human/transitions": [
    { transitionId: 4, qitemId: "q-human", ts: iso(1), state: "blocked", transitionNote: "park wake retained", actorSession: "watchdog@system", closureReason: null, closureTarget: null, identityProvenance: null, ownerNotificationKind: null, ownerNotificationLevel: null },
  ],
};

function localFacts(overrides: Partial<LocalHostFacts> = {}): LocalHostFacts {
  return {
    selfHostId: "host-hub",
    stuckSweep: null,
    rigs: [],
    openQueue: [],
    overdueCount: 0,
    undeliveredCount: 0,
    recentTransitions: [],
    openItemTransitions: [],
    openItemTransitionsTruncated: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<FleetSummaryDeps> & { local?: LocalHostFacts } = {}): FleetSummaryDeps {
  const { local, ...rest } = overrides;
  return {
    readLocalHost: () => local ?? localFacts(),
    loadRegistry: () => ({ ok: true, registry: { hosts: [] } }),
    registryExists: () => false,
    nowMs: () => NOW,
    ...rest,
  };
}

const registry = (hosts: HostRegistry["hosts"]): Partial<FleetSummaryDeps> => ({
  loadRegistry: () => ({ ok: true, registry: { hosts } }),
  registryExists: () => true,
});

const teamOnly = (extra: Partial<typeof HEALTHY_TEAM> = {}) =>
  makeDeps({
    ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
    fetchImpl: makeFetch({ routes: { ...HEALTHY_TEAM, ...extra } }),
  });

describe("composeFleetSummary — per-host status is omission-proof", () => {
  it("no registry at all → the local host alone, no error, nothing new to render", async () => {
    const payload = await composeFleetSummary(makeDeps());
    expect(payload.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.kind).toBe("local");
    expect("registryError" in payload).toBe(false);
    expect(payload.targetedHostIds).toEqual([LOCAL_HOST_ID]);
  });

  it("an unreadable registry is surfaced at the payload level, not quietly local-only", async () => {
    const payload = await composeFleetSummary(makeDeps({
      registryExists: () => true,
      loadRegistry: () => ({ ok: false, error: "hosts.yaml: could not parse", path: "/x" } as never),
    }));
    expect(payload.registryError).toContain("could not parse");
    expect(payload.items).toHaveLength(1);
  });

  it("every targeted host appears in hosts[]: ok, unreachable, auth-failed, unsupported-transport", async () => {
    const payload = await composeFleetSummary(makeDeps({
      ...registry([
        { id: "good", transport: "http", url: "http://good:7433" },
        { id: "dead", transport: "http", url: "http://dead:7433" },
        { id: "nobearer", transport: "http", url: "http://nobearer:7433", bearer_env: "FLEET_TEST_UNSET_BEARER" },
        { id: "sshbox", transport: "ssh", target: "sshbox.local" },
      ]),
      fetchImpl: makeFetch({ routes: HEALTHY_TEAM, statuses: { "dead": 500 } }),
    }));
    expect(payload.hosts.map((h) => [h.hostId, h.status])).toEqual([
      [LOCAL_HOST_ID, "ok"],
      ["good", "ok"],
      ["dead", "unreachable"],
      ["nobearer", "auth-failed"],
      ["sshbox", "unsupported-transport"],
    ]);
    // A failed host is present in `hosts` with NO fabricated counts (absent, not
    // zero) — it has no entry in `items` at all.
    expect(payload.items.find((i) => i.hostId === "dead")).toBeUndefined();
    expect(payload.targetedHostIds).toEqual([LOCAL_HOST_ID, "good", "dead", "nobearer", "sshbox"]);
  });

  it("a host whose health probe answers but whose API refuses the bearer is auth-failed, not unreachable", async () => {
    const payload = await composeFleetSummary(makeDeps({
      ...registry([{ id: "wrongtoken", transport: "http", url: "http://wrongtoken:7433" }]),
      fetchImpl: makeFetch({ routes: { "/healthz": { status: "ok" } }, statuses: { "/api/ps": 401 } }),
    }));
    expect(payload.hosts[1]).toMatchObject({ hostId: "wrongtoken", status: "auth-failed" });
  });
});

describe("composeFleetSummary — open queue and the signals the attention aggregate could not carry", () => {
  it("carries open items in EVERY open state with blockedOn, stamped with the host", async () => {
    const payload = await composeFleetSummary(teamOnly());
    const remote = payload.items.find((i) => i.hostId === "team-a")!;
    expect(remote.openQueueCount).toBe(3);
    expect(remote.openQueueByState).toEqual({ pending: 0, inProgress: 1, blocked: 2 });
    const ids = payload.openQueue.filter((i) => i.hostId === "team-a").map((i) => i.qitemId);
    expect(ids).toEqual(["q-open", "q-agent", "q-human"]);
    expect(payload.openQueue.find((i) => i.qitemId === "q-agent")!.blockedOn).toBe("review.r1@team-a");
    expect(payload.openQueue.every((i) => i.qitemId !== "q-closed")).toBe(true);
  });

  it("reports seats by activity, attention, overdue/undelivered and the stuck-sweep heartbeat", async () => {
    const team = (await composeFleetSummary(teamOnly())).items.find((i) => i.hostId === "team-a")!;
    expect(team.seatsByActivity).toMatchObject({ working: 1, idle: 1, total: 2 });
    expect(team.attentionCount).toBe(1);
    expect(team.overdueCount).toBe(1);
    expect(team.undeliveredCount).toBe(0);
    expect(team.stuckSweep).toMatchObject({ lastOutcome: "clean" });
    expect(team.selfHostId).toBe("host-team-a");
    expect(team.rigs[0]).toMatchObject({ rigName: "team-a", seatCount: 2, seatsWithAssignedWork: 1 });
  });

  it("carries the seat ROWS behind the counts, so a node-level reader needs no second fan-out", async () => {
    const team = (await composeFleetSummary(teamOnly())).items.find((i) => i.hostId === "team-a")!;
    const seats = team.rigs[0]!.seats;
    expect(seats).toHaveLength(2);
    expect(seats[1]).toMatchObject({
      hostId: "team-a",
      rigName: "team-a",
      logicalId: "dev.build",
      canonicalSessionName: "dev-build@team-a",
      activity: "working",
    });
    // The rows and the counts must agree — one read, two projections.
    expect(summarizeSeatActivity(seats.map((s) => s.activity))).toEqual(team.rigs[0]!.seatsByActivity);
  });

  it("a rig whose nodes leg fails keeps its ps counts and reports its seats as unknown, disclosed", async () => {
    const payload = await composeFleetSummary(teamOnly({ }));
    const broken = await composeFleetSummary(makeDeps({
      ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
      fetchImpl: makeFetch({ routes: HEALTHY_TEAM, statuses: { "/api/rigs/rig-1/nodes": 500 } }),
    }));
    const team = broken.items.find((i) => i.hostId === "team-a")!;
    expect(team.rigs[0]!.seatsByActivity).toMatchObject({ unknown: 2, total: 2 });
    expect(team.rigs[0]!.seats).toEqual([]);
    expect(team.partialFailures.join(" ")).toContain("nodes for rig team-a");
    expect(payload).toBeDefined();
  });
});

describe("composeFleetSummary — the stall verdict end to end", () => {
  it("a team whose newest seat-or-human transition is 48 min old is stalled even though its pane is live", async () => {
    // The whole point, as data: newest human/seat transition 48 min ago (a note),
    // newest pane output NOW, threshold 30. Pane activity must NOT rescue it.
    const payload = await composeFleetSummary(teamOnly());
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.lastQueueTransitionAt).toBe(iso(48));
    expect(team.progress.lastSeatOutputAt).toBe(iso(0));
    expect(team.progress.stalled).toBe(true);
    expect(team.progress.minutesSinceProgress).toBe(48);
    expect(team.rigs[0]!.progress.stalled).toBe(true);
  });

  it("a `@system` park wake 1 minute ago does not count as progress", async () => {
    // Without the actor filter the watchdog's own wake note would make this team
    // look freshly active.
    const team = (await composeFleetSummary(teamOnly())).items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.lastQueueTransitionAt).not.toBe(iso(1));
  });

  it("a milestone note inside the threshold clears the stall", async () => {
    const fresh = JSON.parse(JSON.stringify(HEALTHY_TEAM["/api/queue/q-open/transitions"]));
    fresh[1].ts = iso(5);
    const payload = await composeFleetSummary(teamOnly({ "/api/queue/q-open/transitions": fresh }));
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.lastQueueTransitionAt).toBe(iso(5));
    expect(team.progress.stalled).toBe(false);
  });

  it("a team with NO open work is never stalled, however quiet", async () => {
    const payload = await composeFleetSummary(teamOnly({ "/api/queue/list": [], "/api/queue/recent-transitions": [] }));
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.stalled).toBe(false);
    expect(team.progress.openWorkCount).toBe(0);
  });

  it("reads per-item transitions only for OPEN items, and says so when it had to stop", async () => {
    const many = Array.from({ length: FLEET_TRANSITION_ITEM_LIMIT + 5 }, (_unused, i) => ({
      qitemId: `q-${i}`, state: "pending", destinationSession: "dev-build@team-a", tags: [],
    }));
    const seen: string[] = [];
    const payload = await composeFleetSummary(makeDeps({
      ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
      fetchImpl: makeFetch({
        routes: { ...HEALTHY_TEAM, "/api/queue/list": many, "/api/queue/q-": [] },
      }),
    }));
    void seen;
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.progressReadsTruncated).toBe(true);
    expect(team.progress.openWorkCount).toBe(FLEET_TRANSITION_ITEM_LIMIT + 5);
  });

  it("the bounded transition reads take the NEWEST open items, not the list's first 25", async () => {
    // The bound is honest only if it keeps the items that decide the verdict. Queue
    // list order is not recency order, so a team whose freshest row sorted last could
    // be called stalled on evidence from 25 stale rows while its real progress sat
    // unread at position 26.
    const items = Array.from({ length: FLEET_TRANSITION_ITEM_LIMIT + 3 }, (_unused, i) => ({
      qitemId: `q-${i}`, state: "pending", destinationSession: "dev-build@team-a", tags: [],
      // The LAST item is the only recently-touched one, so it is the one that must
      // survive the cap.
      tsUpdated: i === FLEET_TRANSITION_ITEM_LIMIT + 2 ? iso(1) : iso(200),
    }));
    const read: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      const url = String(input);
      const m = url.match(/\/api\/queue\/(q-\d+)\/transitions/);
      if (m) {
        read.push(m[1]!);
        return Promise.resolve(Response.json([{ ts: iso(1), actorSession: "dev-build@team-a", toState: "in-progress" }]));
      }
      return makeFetch({ routes: { ...HEALTHY_TEAM, "/api/queue/list": items, "/api/queue/recent-transitions": { items: [], hasMore: false } } })(input);
    }) as unknown as typeof fetch;
    const payload = await composeFleetSummary(makeDeps({
      ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
      fetchImpl,
    }));
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.progressReadsTruncated).toBe(true);
    expect(read).toContain(`q-${FLEET_TRANSITION_ITEM_LIMIT + 2}`);
    // The freshest transition is what the verdict is judged on, so the team is NOT
    // stalled — which is only true because the right 25 items were read.
    expect(team.progress.stalled).toBe(false);
  });

  it("a failed per-item transition read is disclosed, not silently missing evidence", async () => {
    // The flag used to mean only "more open items than the cap". A 500 on the
    // transitions read produced the same null newest-timestamp and was reported as a
    // settled verdict — the one case where the reader most needs to know the evidence
    // was incomplete.
    const payload = await composeFleetSummary(makeDeps({
      ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
      fetchImpl: makeFetch({
        routes: { ...HEALTHY_TEAM, "/api/queue/recent-transitions": { items: [], hasMore: false } },
        statuses: { "/transitions": 500 },
      }),
    }));
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.progressReadsTruncated).toBe(true);
    // And the verdict is not presented as settled.
    expect(team.progress.stalled).not.toBe(false);
  });

  it("a clean small fleet is NOT flagged truncated", async () => {
    // The counterweight: the flag must not become always-true now that a failed read
    // sets it. A healthy small team reads completely and says so, and its verdict is
    // still the real one.
    const payload = await composeFleetSummary(teamOnly());
    const team = payload.items.find((i) => i.hostId === "team-a")!;
    expect(team.progress.progressReadsTruncated).toBe(false);
    expect(team.progress.stalled).toBe(true);
  });

  it("per-item transition reads run in parallel, not serially inside the deadline", async () => {
    // Serial reads put the whole tail of the bound inside the per-host deadline, so a
    // team with many open items was reported unreachable — the exact failure mode the
    // brief says a per-host deadline exists to prevent.
    const items = Array.from({ length: 8 }, (_unused, i) => ({
      qitemId: `slow-${i}`, state: "pending", destinationSession: "dev-build@team-a", tags: [], tsUpdated: iso(200),
    }));
    const payload = await composeFleetSummary(makeDeps({
      ...registry([{ id: "team-a", transport: "http", url: "http://team-a:7433" }]),
      fetchImpl: makeFetch({
        routes: { ...HEALTHY_TEAM, "/api/queue/list": items, "/api/queue/recent-transitions": { items: [], hasMore: false }, "/api/queue/slow-": [] },
        delays: { "/transitions": 60 },
      }),
      hostTimeoutMs: 5_000,
      concurrency: 4,
    }));
    // The host survived its own deadline. Serial would have cost ~480 ms of the tail
    // on top of everything else the leg does.
    expect(payload.items.find((i) => i.hostId === "team-a")!.reachable).toBe(true);
  });

  it("the threshold and the source set in force are stated on the payload", async () => {
    const payload = await composeFleetSummary(makeDeps({ stallThresholdMinutes: 3 }));
    expect(payload.stallThresholdMinutes).toBe(3);
    expect(payload.hostTimeoutMs).toBe(FLEET_HOST_TIMEOUT_MS);
    expect(payload.enabledProgressSources).toEqual(["queue-transition"]);
  });
});

describe("composeFleetSummary — the per-host deadline", () => {
  it("a slow host burns only its OWN budget; a fast host is not delayed past its own", async () => {
    const started = Date.now();
    const payload = await composeFleetSummary(makeDeps({
      hostTimeoutMs: 120,
      ...registry([
        { id: "slow", transport: "http", url: "http://slow:7433" },
        { id: "fast", transport: "http", url: "http://fast:7433" },
      ]),
      fetchImpl: makeFetch({ delays: { "slow": 5_000 }, routes: HEALTHY_TEAM }),
    }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(payload.hosts.find((h) => h.hostId === "slow")).toMatchObject({ status: "unreachable" });
    expect(payload.hosts.find((h) => h.hostId === "fast")).toMatchObject({ status: "ok" });
    expect(payload.items.find((i) => i.hostId === "fast")).toBeDefined();
  });

  it("concurrency is bounded and stated on the payload", async () => {
    let live = 0;
    let peak = 0;
    const hosts = Array.from({ length: 6 }, (_unused, i) => ({ id: `h${i}`, transport: "http" as const, url: `http://h${i}:7433` }));
    const payload = await composeFleetSummary(makeDeps({
      concurrency: 2,
      ...registry(hosts),
      fetchImpl: (async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    }));
    expect(peak).toBeLessThanOrEqual(2);
    expect(payload.concurrency).toBe(2);
    expect(payload.hosts).toHaveLength(7); // local + 6
  });
});

// ---------------------------------------------------------------------------
// The short cache
// ---------------------------------------------------------------------------

describe("createFleetSummaryCache", () => {
  const build = async (): Promise<FleetFanOutResult> => ({
    items: [], hosts: [{ hostId: LOCAL_HOST_ID, status: "ok" }], openQueue: [],
    generatedAt: new Date(NOW).toISOString(), stallThresholdMinutes: 30,
    enabledProgressSources: ["queue-transition"],
    hostTimeoutMs: FLEET_HOST_TIMEOUT_MS, concurrency: 4, targetedHostIds: [LOCAL_HOST_ID],
  });

  it("serves a second read inside the ttl from the cache and says so", async () => {
    let clock = NOW;
    let calls = 0;
    const cache = createFleetSummaryCache(async () => { calls += 1; return build(); }, { ttlMs: 3_000, nowMs: () => clock });
    const first = await cache.read(false, 30);
    clock += 1_000;
    const second = await cache.read(false, 30);
    expect(calls).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.cacheAgeMs).toBe(1_000);
    expect(second.cacheTtlMs).toBe(3_000);
  });

  it("fans out again once the ttl has passed, and `fresh` bypasses it", async () => {
    let clock = NOW;
    let calls = 0;
    const cache = createFleetSummaryCache(async () => { calls += 1; return build(); }, { ttlMs: 3_000, nowMs: () => clock });
    await cache.read(false, 30);
    await cache.read(true, 30);
    expect(calls).toBe(2);
    clock += 4_000;
    await cache.read(false, 30);
    expect(calls).toBe(3);
  });

  it("concurrent readers share ONE fan-out (the whole cost argument)", async () => {
    let calls = 0;
    const cache = createFleetSummaryCache(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return build();
    }, { ttlMs: 3_000 });
    const results = await Promise.all([cache.read(false, 30), cache.read(false, 30), cache.read(false, 30)]);
    expect(calls).toBe(1);
    expect(results).toHaveLength(3);
  });

  it("a threshold change invalidates the cached verdict instead of echoing a rule that was not applied", async () => {
    // The live proof caught the shape of this bug: the payload stated the CURRENT
    // threshold while the verdicts had been computed under the one the cache was
    // built with. A reader that trusts the stated rule is worse off than one that
    // has to ask. So a changed threshold forces a new fan-out, and the stated rule
    // is always the one the verdicts used.
    let calls = 0;
    let clock = NOW;
    const cache = createFleetSummaryCache(
      async (thresholdMinutes) => {
        calls += 1;
        return { ...build(), stallThresholdMinutes: thresholdMinutes };
      },
      { ttlMs: 60_000, nowMs: () => clock },
    );
    const before = await cache.read(false, 30);
    expect(before.stallThresholdMinutes).toBe(30);
    // Same rule, still fresh: served from cache, no second fan-out.
    expect((await cache.read(false, 30)).fromCache).toBe(true);
    expect(calls).toBe(1);
    // The operator lowered the threshold. The cached verdicts were judged under 30,
    // so they cannot be handed out as if 5 had been applied.
    const after = await cache.read(false, 5);
    expect(calls).toBe(2);
    expect(after.stallThresholdMinutes).toBe(5);
    expect(after.fromCache).toBe(false);
  });

  it("a cold-start reader joins only an in-flight run judged under the SAME rule", async () => {
    // The bug this pins: on a cold start a reader asking for threshold 3 joined a
    // threshold-30 fan-out already in flight and got 30. Nothing was misreported — the
    // payload honestly said 30 — but the rule the reader asked for was not the one
    // applied, and the reader had no way to notice.
    let resolveSlow: ((v: unknown) => void) | null = null;
    const calls: number[] = [];
    const cache = createFleetSummaryCache(
      (thresholdMinutes) => {
        calls.push(thresholdMinutes);
        if (thresholdMinutes === 30) {
          return new Promise((resolve) => { resolveSlow = resolve; }) as never;
        }
        return Promise.resolve({ ...build(), stallThresholdMinutes: thresholdMinutes });
      },
      { ttlMs: 60_000 },
    );
    const slow = cache.read(false, 30);
    const fast = await cache.read(false, 3);
    expect(fast.stallThresholdMinutes).toBe(3);
    expect(calls).toContain(3);
    resolveSlow?.({ ...build(), stallThresholdMinutes: 30 });
    expect((await slow).stallThresholdMinutes).toBe(30);
  });

  it("serves the last good payload immediately while a refresh runs, and says it is stale", async () => {
    // Stale-while-revalidate, which is what keeps a reader with a fixed timeout from
    // losing its remote sections on a slow poll. Once ANY payload exists, a reader that
    // did not ask for `fresh` gets it at once with its true age and the flag set, while
    // one refresh happens behind it.
    let clock = NOW;
    let calls = 0;
    const cache = createFleetSummaryCache(
      async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return build(); },
      { ttlMs: 1_000, nowMs: () => clock },
    );
    await cache.read(false, 30);
    expect(calls).toBe(1);
    clock += 5_000; // the payload is now past its ttl
    const stale = await cache.read(false, 30);
    expect(stale.fromCache).toBe(true);
    expect(stale.cacheStaleWhileRevalidate).toBe(true);
    expect(stale.cacheAgeMs).toBe(5_000);
    // The refresh ran behind the read rather than in front of it.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
    // A cold cache has nothing honest to serve, so it waits instead of inventing.
    cache.clear();
    const cold = await cache.read(false, 30);
    expect(cold.fromCache).toBe(false);
    expect(cold.cacheStaleWhileRevalidate).toBe(false);
  });

  it("a failed refresh does not erase the last good payload", async () => {
    let clock = NOW;
    let calls = 0;
    const cache = createFleetSummaryCache(
      async () => {
        calls += 1;
        if (calls === 1) return build();
        throw new Error("host went dark");
      },
      { ttlMs: 1_000, nowMs: () => clock },
    );
    await cache.read(false, 30);
    clock += 5_000;
    // An explicit fresh read fails. The rejection reaches the caller — a reader that
    // asked for the truth and got none must not be quietly handed the old answer.
    await expect(cache.read(true, 30)).rejects.toThrow(/host went dark/);
    // And the failed run did not overwrite the good payload with nothing: the next
    // ordinary read still has a real answer to serve, flagged as stale.
    const after = await cache.read(false, 30);
    expect(after.fromCache).toBe(true);
    expect(after.cacheStaleWhileRevalidate).toBe(true);
  });

  it("stops serving a stale payload once it is past the bound", async () => {
    // One failed read should be smoothed over. A fan-out that STAYS broken must not
    // keep dressing up minutes-old state as a live fleet — past the bound the reader
    // waits for the real run and meets its failure, which is the honest outcome.
    let clock = NOW;
    let calls = 0;
    const cache = createFleetSummaryCache(
      async () => {
        calls += 1;
        if (calls === 1) return build();
        throw new Error("still broken");
      },
      { ttlMs: 1_000, nowMs: () => clock },
    );
    await cache.read(false, 30);
    // Inside the bound: served as stale, refresh attempted behind the reader.
    clock += 5_000;
    const stale = await cache.read(false, 30);
    expect(stale.cacheStaleWhileRevalidate).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    // Past it: nothing is served, and the failure reaches the reader.
    clock += 120_000;
    await expect(cache.read(false, 30)).rejects.toThrow(/still broken/);
  });

  it("reports a failing background refresh instead of swallowing it silently", async () => {
    // The rejection must be swallowed (an unhandled one would take the daemon down),
    // but silent is a different thing. A page served an increasingly stale fleet needs
    // the daemon to say so.
    const seen: unknown[] = [];
    let calls = 0;
    const cache = createFleetSummaryCache(
      async () => {
        calls += 1;
        if (calls === 1) return build();
        throw new Error("refresh exploded");
      },
      { ttlMs: 1, nowMs: (() => { let t = NOW; return () => (t += 1); })() },
      { onBackgroundRefreshError: (err) => seen.push(err) },
    );
    await cache.read(false, 30);
    await cache.read(false, 30);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toMatch(/refresh exploded/);
  });

  it("a cold read that fails reports to its reader, not as a background refresh", async () => {
    // The catch belongs to the detached refresh only. A cold read has no stale payload
    // to serve, so the reader awaits this promise and meets the failure itself — and a
    // log line claiming "background refresh failed; serving stale until the bound" on
    // that path is false on both counts.
    const seen: unknown[] = [];
    const cache = createFleetSummaryCache(
      async () => { throw new Error("cold failure"); },
      { ttlMs: 1_000, nowMs: () => NOW },
      { onBackgroundRefreshError: (err) => seen.push(err) },
    );
    await expect(cache.read(false, 30)).rejects.toThrow(/cold failure/);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([]);
  });

  it("keeps one entry per rule, so readers asking different rules share nothing and evict nothing", async () => {
    // The usage rule is the window, which is a per-reader flag: the TUI polls 1h while a
    // person reads 24h. With a single slot every switch was a rule change, so neither
    // reader got a cache hit or stale service and both waited for a full fan-out.
    let calls = 0;
    const cache = createFleetSummaryCache(async () => { calls += 1; return build(); }, { ttlMs: 60_000 });
    await cache.read(false, 30);
    await cache.read(false, 1_440);
    expect(calls).toBe(2);
    const a = await cache.read(false, 30);
    const b = await cache.read(false, 1_440);
    expect(calls).toBe(2);
    expect(a.fromCache).toBe(true);
    expect(b.fromCache).toBe(true);
  });

  it("bounds the per-rule entries instead of growing with every rule ever asked", async () => {
    let calls = 0;
    const cache = createFleetSummaryCache(async () => { calls += 1; return build(); }, { ttlMs: 60_000, maxRuleEntries: 2 });
    await cache.read(false, 1);
    await cache.read(false, 2);
    expect(calls).toBe(2);
    await cache.read(false, 3); // evicts rule 1 (least recently used)
    expect(calls).toBe(3);
    await cache.read(false, 2); // still cached
    expect(calls).toBe(3);
    await cache.read(false, 1); // evicted, so it fans out again
    expect(calls).toBe(4);
  });

  it("clear() forgets the payload (test/teardown hook)", async () => {
    let calls = 0;
    const cache = createFleetSummaryCache(async () => { calls += 1; return build(); }, { ttlMs: 60_000 });
    await cache.read(false, 30);
    cache.clear();
    await cache.read(false, 30);
    expect(calls).toBe(2);
  });
});

describe("composeFleetSummary — the local host", () => {
  it("composes the local rig's seats, queue and stall verdict in-process", async () => {
    const payload = await composeFleetSummary(makeDeps({
      local: localFacts({
        rigs: [{
          rigId: "r1", rigName: "hub-rig", attentionCount: 2, seatsWithAssignedWork: 1, lifecycleState: "running",
          seats: [
            { display: "needs-input", lastActivityAt: iso(30) },
            { display: null, lastActivityAt: null },
          ],
        }],
        openQueue: [{ qitemId: "q1", state: "in-progress", destinationSession: "dev-build@hub-rig", tags: [] }],
        overdueCount: 1,
        undeliveredCount: 0,
        recentTransitions: [{ ts: iso(40), rig: "hub-rig", actorSession: "orch-lead@hub-rig" }],
        openItemTransitions: [{ qitemId: "q1", transitions: [{ ts: iso(40), actorSession: "dev-build@hub-rig" }] }],
      }),
    }));
    const local = payload.items[0]!;
    expect(local.kind).toBe("local");
    expect(local.seatsByActivity).toMatchObject({ needsInput: 1, unknown: 1, total: 2 });
    expect(local.attentionCount).toBe(2);
    expect(local.openQueueCount).toBe(1);
    expect(local.overdueCount).toBe(1);
    expect(local.progress.stalled).toBe(true);
    expect(local.rigs[0]!.progress.stalled).toBe(true);
    expect(payload.openQueue[0]).toMatchObject({ hostId: LOCAL_HOST_ID, rigName: "hub-rig" });
  });
});

/** Type-level pin: the payload stays a close sibling of the shared fan-out
 *  contract (items + hosts), so `hostsCovered` and every existing consumer's
 *  reading of `hosts` keep applying. */
const _payloadShape: FleetSummaryPayload | null = null;
const _sourceNames: FleetProgressSourceName[] = ["queue-transition", "seat-output"];
void _payloadShape;
void _sourceNames;
