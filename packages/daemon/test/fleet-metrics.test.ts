// The Prometheus EXPOSITION for the fleet — pure text, pure rules.
//
// The fan-out is owned elsewhere; this file proves what only the exposition can:
// that an unanswered host is `up 0` and NOTHING else, that a null is an absent
// series rather than a zero, that the label set stays bounded, that the text is
// valid Prometheus text format (including what a hostile host or rig name does to
// a quoted label value), and that the per-rig series sum to the host totals rather
// than double-counting them.
//
// Every fixture here is a payload the fleet reads really produce, typed as the
// payload — a key list would not catch a renamed field.

import { describe, it, expect } from "vitest";
import { HELP, PROMETHEUS_TEXT_FORMAT, renderFleetMetrics } from "../src/domain/fleet/fleet-metrics.js";
import type {
  FleetHostSummary,
  FleetProgress,
  FleetQueueItem,
  FleetRigSummary,
  FleetSeatActivityCounts,
  FleetSummaryPayload,
} from "../src/domain/fleet/fleet-summary-types.js";
import type { FleetHostUsage, FleetUsagePayload } from "../src/domain/fleet/fleet-usage-types.js";
import type { PerHostStatus, PerHostStatusKind } from "../src/domain/hosts/fanout-contract.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVITIES = (over: Partial<FleetSeatActivityCounts> = {}): FleetSeatActivityCounts => ({
  working: 0, idle: 0, needsInput: 0, unknown: 0, total: 0, ...over,
});

const PROGRESS = (over: Partial<FleetProgress> = {}): FleetProgress => ({
  lastQueueTransitionAt: "2026-10-24T09:00:00.000Z",
  lastSeatOutputAt: "2026-10-24T09:30:00.000Z",
  lastProgressAt: "2026-10-24T09:00:00.000Z",
  lastProgressSource: "queue-transition",
  enabledProgressSources: ["queue-transition"],
  minutesSinceProgress: 30,
  stalled: false,
  openWorkCount: 1,
  progressReadsTruncated: false,
  ...over,
});

function rig(over: Partial<FleetRigSummary> & { rigName: string }): FleetRigSummary {
  return {
    rigId: `rig-${over.rigName}`,
    rigName: over.rigName,
    hostId: over.hostId ?? "hub-0",
    seatCount: 0,
    seatsByActivity: ACTIVITIES(),
    attentionCount: 0,
    seatsWithAssignedWork: 0,
    lifecycleState: "running",
    runningCount: 0,
    psStatus: "stopped",
    progress: PROGRESS(),
    seats: [],
    ...over,
  } as FleetRigSummary;
}

function host(over: Partial<FleetHostSummary> & { hostId: string }): FleetHostSummary {
  return {
    kind: "remote",
    selfHostId: null,
    status: { hostId: over.hostId, status: "ok" },
    reachable: true,
    rigCount: 0,
    seatCount: 0,
    seatsByActivity: ACTIVITIES(),
    attentionCount: 0,
    openQueueCount: 0,
    openQueueByState: { pending: 0, inProgress: 0, blocked: 0 },
    overdueCount: 0,
    undeliveredCount: 0,
    stuckSweep: null,
    progress: PROGRESS(),
    rigs: [],
    partialFailures: [],
    ...over,
  } as FleetHostSummary;
}

function queueItem(over: Partial<FleetQueueItem> & { qitemId: string }): FleetQueueItem {
  return {
    hostId: "hub-0",
    rigName: "alpha",
    state: "pending",
    destinationSession: "dev-build@alpha",
    sourceSession: "orch-lead@hub-0",
    blockedOn: null,
    handedOffTo: null,
    claimedAt: null,
    priority: null,
    summary: "a summary nobody may put in a label",
    tags: [],
    tsCreated: "2026-10-24T08:00:00.000Z",
    tsUpdated: "2026-10-24T09:00:00.000Z",
    ...over,
  } as FleetQueueItem;
}

function summary(over: Partial<FleetSummaryPayload> = {}): FleetSummaryPayload {
  return {
    items: [],
    hosts: [],
    openQueue: [],
    generatedAt: "2026-10-24T10:00:00.000Z",
    stallThresholdMinutes: 30,
    enabledProgressSources: ["queue-transition"],
    hostTimeoutMs: 5000,
    concurrency: 4,
    fromCache: true,
    cacheAgeMs: 1200,
    cacheStaleWhileRevalidate: false,
    cacheTtlMs: 3000,
    targetedHostIds: [],
    ...over,
  } as FleetSummaryPayload;
}

function hostUsage(over: Partial<FleetHostUsage> & { hostId: string }): FleetHostUsage {
  return {
    kind: "remote",
    status: "ok",
    reachable: true,
    usage: { state: "ok", windowHours: 1, sinceIso: "2026-10-24T09:00:00.000Z", ranked: [], unknown: [], totals: { tokensDelta: 0, resets: 0, seatsRanked: 0, seatsUnknown: 0 } },
    partialFailures: [],
    ...over,
  } as FleetHostUsage;
}

function usage(over: Partial<FleetUsagePayload> = {}): FleetUsagePayload {
  return {
    items: [],
    hosts: [],
    generatedAt: "2026-10-24T10:00:00.000Z",
    windowHours: 1,
    sinceIso: "2026-10-24T09:00:00.000Z",
    top: [],
    topCap: null,
    totalSeatsRanked: 0,
    unknown: [],
    totals: { tokensDelta: 0, resets: 0, seatsRanked: 0, seatsUnknown: 0, hostsAnswered: 1, hostsTargeted: 1 },
    hostTimeoutMs: 5000,
    concurrency: 4,
    targetedHostIds: [],
    fromCache: true,
    cacheAgeMs: 0,
    cacheStaleWhileRevalidate: false,
    cacheTtlMs: 3000,
    ...over,
  } as FleetUsagePayload;
}

// ---------------------------------------------------------------------------
// Parsing the rendered text, so a claim is about the FORMAT and not a substring
// ---------------------------------------------------------------------------

interface ParsedLine {
  kind: "help" | "type" | "sample";
  metric: string;
  labels?: Record<string, string>;
  value?: number;
  type?: string;
  raw: string;
}

/** A deliberately strict reader: anything it cannot parse is a broken scrape. */
function parse(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe(""); // the body ends with exactly one trailing newline
  for (const raw of lines.slice(0, -1)) {
    if (raw.startsWith("# HELP ")) {
      const rest = raw.slice("# HELP ".length);
      const metric = rest.split(" ")[0]!;
      out.push({ kind: "help", metric, raw });
      continue;
    }
    if (raw.startsWith("# TYPE ")) {
      const [, , metric, type] = raw.split(" ");
      out.push({ kind: "type", metric: metric!, type, raw });
      continue;
    }
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^{}]*)\})? (-?(?:\d+(?:\.\d+)?|NaN|\+Inf|-Inf))$/.exec(raw);
    if (!m) throw new Error(`unparseable exposition line: ${JSON.stringify(raw)}`);
    const labels: Record<string, string> = {};
    if (m[3]) {
      const pairs = m[3].match(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g) ?? [];
      const rebuilt = pairs.join(",");
      // Every byte of the selector must have been consumed by a valid pair.
      expect(rebuilt).toBe(m[3]);
      for (const pair of pairs) {
        const kv = /^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(pair)!;
        labels[kv[1]!] = kv[2]!;
      }
    }
    out.push({ kind: "sample", metric: m[1]!, labels, value: Number.parseFloat(m[4]!), raw });
  }
  return out;
}

const samples = (text: string, metric: string) => parse(text).filter((l) => l.kind === "sample" && l.metric === metric);
const sample = (text: string, metric: string) => {
  const found = samples(text, metric);
  expect(found, `expected exactly one ${metric}`).toHaveLength(1);
  return found[0]!;
};
const has = (text: string, needle: string) => text.includes(needle);

// ---------------------------------------------------------------------------

describe("fleet metrics — the text format", () => {
  it("every family that emits samples carries HELP and TYPE, and the body parses", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({ hostId: "hub-0", rigCount: 1, rigs: [rig({ rigName: "alpha", seatsByActivity: ACTIVITIES({ working: 2, total: 2 }), seatCount: 2 })] })],
        openQueue: [queueItem({ qitemId: "q1" })],
      }),
      usage: usage({ items: [hostUsage({ hostId: "hub-0" })] }),
    });
    const parsed = parse(text);
    const families = new Set(parsed.filter((l) => l.kind === "sample").map((l) => l.metric));
    expect(families.size).toBeGreaterThan(8);
    for (const family of families) {
      expect(parsed.some((l) => l.kind === "help" && l.metric === family), `HELP for ${family}`).toBe(true);
      const type = parsed.find((l) => l.kind === "type" && l.metric === family);
      expect(type, `TYPE for ${family}`).toBeTruthy();
      expect(["gauge", "counter", "untyped", "histogram", "summary"]).toContain(type!.type);
    }
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\n\n");
  });

  it("reports the rule and the cache posture even for a fleet with no hosts at all", () => {
    const text = renderFleetMetrics({ summary: summary(), usage: null });
    // The rule and the cache posture are still true of the scrape; no host is.
    expect(text).not.toContain("openrig_fleet_host_up");
    expect(sample(text, "openrig_fleet_usage_read_ok").value).toBe(0);
  });

  it("is deterministic: the same payloads render byte-identically", () => {
    const input = {
      summary: summary({
        hosts: [{ hostId: "b", status: "ok" }, { hostId: "a", status: "unreachable" }] as PerHostStatus[],
        items: [host({ hostId: "a" }), host({ hostId: "b", rigs: [rig({ rigName: "z" }), rig({ rigName: "y" })] })],
      }),
      usage: usage({ items: [hostUsage({ hostId: "b" })] }),
    };
    expect(renderFleetMetrics(input)).toBe(renderFleetMetrics(input));
    // Families and samples are sorted, so a scrape is diffable.
    const names = parse(renderFleetMetrics(input)).filter((l) => l.kind === "type").map((l) => l.metric);
    expect(names).toEqual([...names].sort());
  });

  it("escapes what a quoted label value cannot hold", () => {
    const nasty = 'team"1\\x';
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: nasty, status: "ok" } as PerHostStatus],
        items: [host({ hostId: nasty, rigs: [rig({ rigName: "line\nbreak" })] })],
      }),
      usage: null,
    });
    const up = sample(text, "openrig_fleet_host_up");
    expect(up.labels!.host).toBe(`team\\"1\\\\x`);
    // A newline inside a value must not become a second line.
    expect(text.split("\n").filter((l) => l.startsWith("openrig_fleet_rig_stalled")).length).toBeLessThan(2);
    expect(parse(text).length).toBeGreaterThan(0);
    expect(up.raw).not.toContain("\n\n");
  });

  it("keeps the label set bounded: host, rig, and closed enums only", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({
          hostId: "hub-0",
          rigs: [rig({ rigName: "alpha", seatsByActivity: ACTIVITIES({ working: 1, total: 1 }) })],
          stuckSweep: { lastSweepAt: "2026-10-24T09:59:00.000Z", lastOutcome: "findings", lastError: "boom", consecutiveFailures: 2, findingsRouted: 3 },
        })],
        openQueue: [queueItem({ qitemId: "qitem-20261024100000-abcdef", summary: "free text that must never reach a label" })],
      }),
      usage: usage({ items: [hostUsage({ hostId: "hub-0" })] }),
    });
    const allowed = new Set(["host", "rig", "activity", "state", "status"]);
    for (const line of parse(text).filter((l) => l.kind === "sample")) {
      for (const key of Object.keys(line.labels!)) {
        expect(allowed.has(key), `label ${key} on ${line.metric}`).toBe(true);
      }
    }
    // The things that would be unbounded are nowhere in the body.
    expect(text).not.toContain("qitem-");
    expect(text).not.toContain("free text");
    expect(text).not.toContain("dev-build@alpha");
    expect(text).not.toContain("boom");
  });

  it("names the usage figures so nobody reads them as accounting, and says so in HELP", () => {
    const text = renderFleetMetrics({ summary: summary({ hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus] }), usage: usage({ items: [hostUsage({ hostId: "hub-0" })] }) });
    expect(has(text, "openrig_fleet_usage_sampled_tokens_delta")).toBe(true);
    expect(HELP.usageSampledTokensDelta).toMatch(/SAMPLED/);
    expect(HELP.usageSampledTokensDelta).toMatch(/NOT exact token or cost accounting/);
    expect(HELP.usageResets).toMatch(/[Ss]ampled/);
  });

  // promtool check metrics lints names as well as parsing them, and it failed this
  // exposition until every one of these held. A dashboard's CI runs the same check,
  // so a name that only the daemon likes is a name that does not work.
  it("names every metric the way promtool's linter wants", () => {
    const text = renderFleetMetrics({
      summary: summary({ hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus], items: [host({ hostId: "hub-0", rigCount: 1, rigs: [rig({ rigName: "alpha" })] })] }),
      usage: usage({ items: [hostUsage({ hostId: "hub-0" })] }),
    });
    const families = [...new Set(parse(text).filter((l) => l.kind === "sample").map((l) => l.metric))];
    expect(families.length).toBeGreaterThan(8);
    for (const name of families) {
      // Prometheus base units, not minutes / hours / milliseconds.
      expect(name, `${name} uses a non-base time unit`).not.toMatch(/_(ms|minutes|hours)$/);
      // A gauge must not call itself a counter.
      const type = parse(text).find((l) => l.kind === "type" && l.metric === name)!.type;
      if (type !== "counter") expect(name, `${name} carries a type word`).not.toMatch(/_total$|counter/);
    }
  });
});

describe("fleet metrics — an unanswered host", () => {
  const mixed = () => renderFleetMetrics({
    summary: summary({
      hosts: [
        { hostId: "hub-0", status: "ok" },
        { hostId: "team-b", status: "unreachable", error: "connect ECONNREFUSED" },
      ] as PerHostStatus[],
      items: [
        host({ hostId: "hub-0", rigCount: 1, rigs: [rig({ rigName: "alpha" })] }),
        host({ hostId: "team-b", reachable: false, status: { hostId: "team-b", status: "unreachable" }, rigCount: 0, overdueCount: null, undeliveredCount: null, progress: PROGRESS({ lastProgressAt: null, stalled: null }) }),
      ],
    }),
    usage: usage({ items: [hostUsage({ hostId: "hub-0" }), hostUsage({ hostId: "team-b", status: "unreachable", reachable: false, usage: { state: "unavailable", reason: "dial tcp: no route to host", ranked: [] } })] }),
  });

  it("reports up 0 for it, and NOTHING else about it", () => {
    const text = mixed();
    const ups = samples(text, "openrig_fleet_host_up");
    expect(ups).toHaveLength(2);
    expect(ups.find((l) => l.labels!.host === "team-b")!.value).toBe(0);
    expect(ups.find((l) => l.labels!.host === "hub-0")!.value).toBe(1);

    // The only series carrying the dead host are the two that describe the HUB's
    // read of it. No zeros dressed up as measurements of a host nobody heard from.
    const offenders = parse(text)
      .filter((l) => l.kind === "sample" && l.labels && "host" in l.labels && l.labels!.host === "team-b")
      .map((l) => l.metric);
    expect([...new Set(offenders)].sort()).toEqual(["openrig_fleet_host_read_status", "openrig_fleet_host_up"]);
    // Which includes: no zeroed queue, no zeroed seats, no zeroed usage.
    expect(text).not.toContain(`openrig_fleet_queue_items{host="team-b"`);
    expect(text).not.toContain(`openrig_fleet_usage_sampled_tokens_delta{host="team-b"`);
    // And the failure detail — free text — is not published.
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("holds the up-0 rule when the two caches disagree about a host", () => {
    // The summary and the usage read are separate caches with separate fan-outs that run
    // at different moments, so one can have answered for a host the other did not. The
    // summary is this scrape's reach of record: a host it could not get an answer from
    // carries `up 0` and nothing else, even when the usage cache is warm and has real
    // numbers for it. Publishing those numbers would put a measurement on a host the same
    // scrape just said it could not measure.
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [
          { hostId: "hub-0", status: "ok" },
          { hostId: "t-b", status: "unreachable", error: "connect ECONNREFUSED" },
        ] as PerHostStatus[],
        items: [],
      }),
      usage: usage({
        items: [hostUsage({
          hostId: "t-b",
          usage: {
            state: "ok", windowHours: 1, sinceIso: "2026-10-24T09:00:00.000Z", ranked: [], unknown: [],
            totals: { tokensDelta: 5, resets: 0, seatsRanked: 1, seatsUnknown: 0 },
          },
        })],
      }),
    });
    const offenders = parse(text)
      .filter((l) => l.kind === "sample" && l.labels && "host" in l.labels && l.labels!.host === "t-b")
      .map((l) => l.metric);
    expect([...new Set(offenders)].sort()).toEqual(["openrig_fleet_host_read_status", "openrig_fleet_host_up"]);
    for (const name of [
      "openrig_fleet_usage_sampled_tokens_delta",
      "openrig_fleet_usage_resets",
      "openrig_fleet_usage_seats_ranked",
      "openrig_fleet_usage_seats_unknown",
    ]) {
      expect(text, name).not.toContain(`${name}{host="t-b"`);
    }
  });

  it("publishes no usage series for a host the summary never listed", () => {
    // The registry can change between the two fan-outs. A host with no `host_up` line must
    // not appear in the usage section either, or a sum over `host` quietly includes a
    // host this scrape never claimed to target.
    const text = renderFleetMetrics({
      summary: summary({ hosts: [{ hostId: "hub-0", status: "ok" }] as PerHostStatus[], items: [] }),
      usage: usage({ items: [hostUsage({ hostId: "ghost" })] }),
    });
    expect(text).not.toContain(`host="ghost"`);
    expect(text).toContain(`openrig_fleet_host_up{host="hub-0"} 1`);
  });

  it("publishes the closed read-status enum so auth-failed is distinguishable from unreachable", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [
          { hostId: "a", status: "auth-failed" },
          { hostId: "b", status: "unsupported-transport" },
        ] as PerHostStatus[],
        items: [],
      }),
      usage: null,
    });
    const statuses = samples(text, "openrig_fleet_host_read_status");
    expect(statuses.map((l) => `${l.labels!.host}:${l.labels!.status}`)).toEqual(["a:auth-failed", "b:unsupported-transport"]);
    for (const s of statuses) expect(s.value).toBe(1);
    const kinds: PerHostStatusKind[] = ["ok", "unreachable", "auth-failed", "unsupported-transport"];
    for (const line of statuses) expect(kinds).toContain(line.labels!.status as PerHostStatusKind);
  });
});

describe("fleet metrics — nulls are absent, never zero", () => {
  it("omits a stall verdict the origin could not reach and a heartbeat it never published", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({
          hostId: "hub-0",
          overdueCount: null,
          undeliveredCount: null,
          stuckSweep: null,
          progress: PROGRESS({ lastProgressAt: null, lastProgressSource: "none", minutesSinceProgress: null, stalled: null }),
          rigs: [rig({ rigName: "alpha", runningCount: null, progress: PROGRESS({ lastProgressAt: null, stalled: null }) })],
        })],
      }),
      usage: null,
    });
    expect(text).not.toContain("openrig_fleet_host_stalled");
    expect(text).not.toContain("openrig_fleet_rig_stalled");
    expect(text).not.toContain("openrig_fleet_host_last_progress_timestamp_seconds");
    expect(text).not.toContain("openrig_fleet_rig_last_progress_timestamp_seconds");
    expect(text).not.toContain("openrig_fleet_queue_overdue_items");
    expect(text).not.toContain("openrig_fleet_queue_undelivered_items");
    expect(text).not.toContain("openrig_fleet_seats_running");
    expect(text).not.toContain("openrig_fleet_stuck_sweep");
  });

  it("keeps a real zero, because a measurement of nothing is a measurement", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({
          hostId: "hub-0",
          overdueCount: 0,
          undeliveredCount: 0,
          progress: PROGRESS({ stalled: true, minutesSinceProgress: 90 }),
          rigs: [rig({ rigName: "alpha", runningCount: 0, seatsByActivity: ACTIVITIES({ idle: 3, total: 3 }), progress: PROGRESS({ stalled: false }) })],
        })],
      }),
      usage: usage({ items: [hostUsage({ hostId: "hub-0" })] }),
    });
    expect(sample(text, "openrig_fleet_host_stalled").value).toBe(1);
    expect(sample(text, "openrig_fleet_rig_stalled").value).toBe(0);
    expect(sample(text, "openrig_fleet_queue_overdue_items").value).toBe(0);
    expect(sample(text, "openrig_fleet_seats_running").value).toBe(0);
    expect(samples(text, "openrig_fleet_seats").map((l) => `${l.labels!.activity}=${l.value}`))
      .toEqual(["idle=3", "needs-input=0", "unknown=0", "working=0"]);
  });

  it("drops a non-finite number rather than printing NaN", () => {
    const text = renderFleetMetrics({
      summary: summary({ hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus], items: [host({ hostId: "hub-0", rigCount: Number.NaN })] }),
      usage: usage({ items: [hostUsage({ hostId: "hub-0", usage: { state: "ok", ranked: [], unknown: [], totals: { tokensDelta: Number.NaN, resets: 0, seatsRanked: 1, seatsUnknown: 0 } } })] }),
    });
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("openrig_fleet_rigs");
    expect(text).not.toContain("openrig_fleet_usage_sampled_tokens_delta");
    expect(sample(text, "openrig_fleet_usage_seats_ranked").value).toBe(1);
  });
});

describe("fleet metrics — queue, progress and usage series", () => {
  it("groups open items by rig and state so a sum over rig is the host total", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({ hostId: "hub-0", openQueueCount: 3, openQueueByState: { pending: 1, inProgress: 1, blocked: 1 } })],
        openQueue: [
          queueItem({ qitemId: "q1", rigName: "alpha", state: "pending" }),
          queueItem({ qitemId: "q2", rigName: "alpha", state: "in-progress" }),
          queueItem({ qitemId: "q3", rigName: null, state: "blocked" }),
        ],
      }),
      usage: null,
    });
    const lines = samples(text, "openrig_fleet_queue_items");
    const byState = new Map(lines.map((l) => [l.labels!.state, l.value]));
    expect(byState).toEqual(new Map([["pending", 1], ["in-progress", 1], ["blocked", 1]]));
    // The row the origin did not attribute to a rig is counted under a literal, so
    // nothing silently falls out of a sum.
    expect(lines.find((l) => l.labels!.state === "blocked")!.labels!.rig).toBe("none");
    expect(lines.reduce((n, l) => n + l.value!, 0)).toBe(3);
  });

  it("renders a progress timestamp as unix seconds, not an age", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({ hostId: "hub-0", rigs: [rig({ rigName: "alpha" })] })],
      }),
      usage: null,
    });
    expect(sample(text, "openrig_fleet_host_last_progress_timestamp_seconds").value).toBe(Date.parse("2026-10-24T09:00:00.000Z") / 1000);
    expect(sample(text, "openrig_fleet_rig_last_progress_timestamp_seconds").value).toBe(Date.parse("2026-10-24T09:00:00.000Z") / 1000);
    expect(sample(text, "openrig_fleet_stall_threshold_seconds").value).toBe(1800);
  });

  it("publishes the addable usage figures per host, and only for a host with a read", () => {
    const text = renderFleetMetrics({
      // Both hosts answered the summary; only `a` answered the usage read. That is the
      // distinction this test is about, and a host the summary never reached is covered by
      // the up-0 rule in its own test above.
      summary: summary({
        hosts: [{ hostId: "a", status: "ok" }, { hostId: "b", status: "ok" }] as PerHostStatus[],
      }),
      usage: usage({
        windowHours: 24,
        items: [
          hostUsage({ hostId: "a", usage: { state: "ok", ranked: [], unknown: [], totals: { tokensDelta: 1234, resets: 2, seatsRanked: 3, seatsUnknown: 1 } } }),
          hostUsage({ hostId: "b", usage: { state: "unavailable", reason: "no usage route on this image", ranked: [] } }),
        ],
      }),
    });
    expect(sample(text, "openrig_fleet_usage_read_ok").value).toBe(1);
    expect(sample(text, "openrig_fleet_usage_window_seconds").value).toBe(86_400);
    expect(sample(text, "openrig_fleet_usage_sampled_tokens_delta").labels!.host).toBe("a");
    expect(sample(text, "openrig_fleet_usage_sampled_tokens_delta").value).toBe(1234);
    expect(sample(text, "openrig_fleet_usage_resets").value).toBe(2);
    expect(samples(text, "openrig_fleet_usage_seats_ranked").map((l) => l.value)).toEqual([3]);
    // `b` answered the summary, so it is reported — it just contributes no usage, because
    // its usage read had no measurement. That is a different case from an unreachable host.
    expect(samples(text, "openrig_fleet_host_up").map((l) => `${l.labels!.host}:${l.value}`)).toEqual(["a:1", "b:1"]);
    for (const name of [
      "openrig_fleet_usage_sampled_tokens_delta",
      "openrig_fleet_usage_resets",
      "openrig_fleet_usage_seats_ranked",
      "openrig_fleet_usage_seats_unknown",
    ]) {
      expect(text, name).not.toContain(`${name}{host="b"`);
    }
  });

  it("says so when the usage read failed instead of going quiet", () => {
    const text = renderFleetMetrics({ summary: summary({ hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus] }), usage: null });
    expect(sample(text, "openrig_fleet_usage_read_ok").value).toBe(0);
    expect(text).not.toContain("openrig_fleet_usage_sampled_tokens_delta");
    expect(text).not.toContain("openrig_fleet_usage_window_seconds");
  });

  it("carries the fan-out's own staleness so a dashboard knows how old its fleet is", () => {
    const text = renderFleetMetrics({
      summary: summary({ cacheAgeMs: 45_000, cacheStaleWhileRevalidate: true }),
      usage: null,
    });
    expect(sample(text, "openrig_fleet_fanout_cache_age_seconds").value).toBe(45);
    expect(sample(text, "openrig_fleet_fanout_cache_stale").value).toBe(1);
  });

  it("marks the cumulative sweep finding count as a counter", () => {
    const text = renderFleetMetrics({
      summary: summary({
        hosts: [{ hostId: "hub-0", status: "ok" } as PerHostStatus],
        items: [host({ hostId: "hub-0", stuckSweep: { lastSweepAt: "2026-10-24T09:59:00.000Z", lastOutcome: "findings", lastError: null, consecutiveFailures: 0, findingsRouted: 7 } })],
      }),
      usage: null,
    });
    expect(text).toContain("# TYPE openrig_fleet_stuck_sweep_findings_routed_total counter");
    expect(sample(text, "openrig_fleet_stuck_sweep_findings_routed_total").value).toBe(7);
    expect(sample(text, "openrig_fleet_stuck_sweep_last_run_timestamp_seconds").value).toBe(Date.parse("2026-10-24T09:59:00.000Z") / 1000);
  });
});

describe("fleet metrics — the scrape contract", () => {
  it("declares the media type Prometheus scrapes", () => {
    expect(PROMETHEUS_TEXT_FORMAT).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
