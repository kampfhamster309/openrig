// The Prometheus TEXT EXPOSITION for the fleet, composed from the two fleet reads.
//
// This module is PURE: it takes the payloads the hub already produces and returns
// the scrape body. No transport, no fan-out, no clock. That is what makes the
// honesty rules testable without a daemon, and it is why a scrape cannot quietly
// become a third fleet read — it sees exactly what `/api/fleet/summary` and
// `/api/fleet/usage` answer, through the same cache.
//
// The rules, in the order they matter:
//
//   * EVERY targeted host gets `openrig_fleet_host_up`, always. A host that did not
//     answer gets `up 0` and NOTHING else — no zeroed seats, no zeroed queue, no
//     zeroed usage. A zero is a measurement and an unanswered host was not
//     measured; rendering absence as zero is how a fleet dashboard lies.
//   * A null in a payload is ABSENT here, never a zero. A verdict the origin could
//     not reach, a heartbeat an old image never published, a usage total with no
//     read behind it: the series is simply not there.
//   * Only ONE label set per metric name. A host-level and a rig-level series under
//     the same name would make `sum()` double-count, so anything that exists at two
//     scopes gets two names (`..._host_stalled` vs `..._rig_stalled`), and anything
//     that exists at one scope keeps the finer labels so a sum over them is the
//     coarser number.
//   * No unbounded labels: `host`, `rig`, and closed enums. No qitem ids, summaries,
//     session names, reasons or free text — a label cardinality the operator cannot
//     bound is a memory leak in whoever scrapes it.
//   * The usage figures are SAMPLED and are not token or cost accounting. The HELP
//     says so because a dashboard renders whatever you publish and someone will
//     eventually put a dollar sign next to it.

import type { FleetSummaryPayload } from "./fleet-summary-types.js";
import type { FleetUsagePayload } from "./fleet-usage-types.js";

/** The media type Prometheus scrapes. `version=0.0.4` is the text format every
 *  Prometheus release reads; a scraper that cannot parse the content type falls
 * * back to the text format, so a wrong type is a silent scrape failure. */
export const PROMETHEUS_TEXT_FORMAT = "text/plain; version=0.0.4; charset=utf-8";

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Label values are a quoted string in the text format: backslash, quote and
 *  newline must be escaped, and any other control character would break a line
 *  that the format says is one sample per line. Host and rig names are operator
 *  input, so this is data-driven sanitising, not a formality. */
function escapeLabelValue(raw: string): string {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  // eslint-disable-next-line no-control-regex
  return escaped.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** HELP is rendered on one line; a newline in it would be parsed as a sample. */
function helpText(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ");
}

/** An ISO timestamp as unix seconds. Unparseable or absent is `null`, which every
 *  caller treats as "no series" rather than "epoch". */
function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms / 1000;
}

type FamilyType = "gauge" | "counter";

interface Sample {
  /** The rendered `{a="1",b="2"}` selector, labels sorted by name so the same
   *  series always renders the same bytes. */
  selector: string;
  value: number;
}

interface Family {
  name: string;
  type: FamilyType;
  help: string;
  samples: Map<string, Sample>;
}

/** A collecting text exposition. `add` drops a sample rather than emitting a
 *  non-finite number: `NaN` is not a value a scraper can store, and a silently
 *  missing series is the honest shape of "this was not measured". */
class Exposition {
  private readonly families = new Map<string, Family>();

  add(name: string, type: FamilyType, help: string, labels: Record<string, string>, value: number | null | undefined): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    if (!METRIC_NAME_RE.test(name)) throw new Error(`invalid metric name "${name}"`);
    const rendered: string[] = [];
    for (const [key, raw] of Object.entries(labels)) {
      if (!LABEL_NAME_RE.test(key)) throw new Error(`invalid label name "${key}" on ${name}`);
      rendered.push(`${key}="${escapeLabelValue(String(raw))}"`);
    }
    rendered.sort();
    const selector = rendered.length ? `{${rendered.join(",")}}` : "";
    let family = this.families.get(name);
    if (!family) {
      family = { name, type, help: helpText(help), samples: new Map() };
      this.families.set(name, family);
    }
    const existing = family.samples.get(selector);
    if (existing) {
      // Two callers producing one series is a bug in the mapping, not something to
      // hide: the last writer would silently decide the number.
      throw new Error(`duplicate sample for ${name}${selector}`);
    }
    family.samples.set(selector, { selector, value });
  }

  render(): string {
    const lines: string[] = [];
    for (const name of [...this.families.keys()].sort()) {
      const family = this.families.get(name)!;
      if (family.samples.size === 0) continue;
      lines.push(`# HELP ${name} ${family.help}`);
      lines.push(`# TYPE ${name} ${family.type}`);
      for (const sample of [...family.samples.values()].sort((a, b) => (a.selector < b.selector ? -1 : 1))) {
        lines.push(`${name}${sample.selector} ${formatValue(sample.value)}`);
      }
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
  }
}

/** Integers print bare; a real fraction keeps enough precision to round-trip. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export interface FleetMetricsInput {
  /** The fleet summary payload, from the shared cache. */
  summary: FleetSummaryPayload;
  /** The fleet usage payload, or null when the usage read could not be completed.
   *  Null is DISCLOSED as `openrig_fleet_usage_read_ok 0` rather than going quiet:
   *  "no usage series" and "usage could not be read" are different facts and only
   *  one of them means the fleet is idle. */
  usage: FleetUsagePayload | null;
}

/** The rig label every series uses for a queue row the origin did not attribute to
 *  a rig. A literal, never an empty label: an empty value reads as "no rig" and
 *  cannot be told apart from a broken scrape. */
const NO_RIG = "none";

export const HELP = {
  hostUp:
    "Whether the hub's fleet fan-out reached this host when it answered the scrape (1) or not (0). Every host the hub targets appears in this series on every scrape. A host at 0 reports no other host-labelled series: the hub measured nothing about it, so nothing is reported as zero.",
  hostReadStatus:
    "The hub's own verdict on the read of this host, one series at 1 for whichever of the four closed outcomes the read had: ok, unreachable, auth-failed, unsupported-transport. This describes the hub's read, not anything the host reported — it is the only series a host that did not answer carries, because which of these it was changes the operator's fix (rotate a bearer vs find the pod).",
  rigs: "Rigs this host reported to the hub. Only present for a host that answered.",
  seats:
    "Seats by activity state (working, idle, needs-input, unknown), counted from the activity state the seat's own daemon derived — this read never re-arbitrates one. `activity=\"needs-input\"` is the fleet's signal that a human is needed somewhere. Sum over `rig` for a host total.",
  seatsWithAssignedWork: "Seats this host reports as having assigned work. Sum over `rig` for a host total.",
  seatsRunning:
    "Seats this host reports as actually running on the rig, verbatim from its own running/status pair — a declared-but-stopped seat is not counted. Absent when the host had no answer, which is not the same as 0.",
  attentionItems:
    "The attention count this host reported for the rig, verbatim from its own projection; this read never recomputes it. Sum over `rig` for a host total.",
  queueItems:
    "Open queue items by state (pending, in-progress, blocked). `rig` is the rig the row belongs to, or \"none\" when the origin did not attribute it — a rig actually named none would share that label, so treat rig=\"none\" as unattributed rather than as a rig. Sum over `rig` for the host total. A fleet read reports at most 200 open items per host, so a count sitting on that cap is a floor, not a total.",
  queueOverdueItems:
    "Open queue items past their closure deadline on this host. Absent when the host had no answer; 0 means it answered and nothing is overdue.",
  queueUndeliveredItems:
    "Queue items whose creation-time delivery never reached the destination on this host. Absent when the host had no answer; 0 means it answered and nothing went undelivered.",
  hostStalled:
    "Whether this host has open work and no progress for longer than openrig_fleet_stall_threshold_seconds (1) or not (0). Absent when there is open work and no progress evidence at all — no evidence is not the same finding as no progress.",
  rigStalled:
    "Whether this rig has open work and no progress for longer than openrig_fleet_stall_threshold_seconds (1) or not (0). Absent when there is open work and no progress evidence at all.",
  hostLastProgress:
    "Unix seconds of the newest progress-eligible queue transition on this host — a state change or a milestone note written by a seat or a human, never by a system actor, and never mere pane output. The age of that evidence is `time() - openrig_fleet_host_last_progress_timestamp_seconds`.",
  rigLastProgress:
    "Unix seconds of the newest progress-eligible queue transition on this rig. The age of that evidence is `time() - openrig_fleet_rig_last_progress_timestamp_seconds`.",
  stallThreshold:
    "The stall threshold in force for this scrape, in seconds. The stall verdicts were judged under exactly this number; it is a daemon setting, re-read per fan-out.",
  stuckSweepLastRun:
    "Unix seconds of the last stuck-sweep run this host reported. Absent on a daemon old enough not to publish a heartbeat, which is a fact about the origin and never a sweep that ran at the epoch.",
  stuckSweepConsecutiveFailures:
    "Consecutive stuck-sweep runs that failed on this host. Nonzero means the hub's own watchdog has stopped checking, so an absence of findings is no longer evidence of anything.",
  stuckSweepFindingsRouted:
    "Stuck-sweep findings this host has routed since it booted. A counter that restarts with the daemon, so use rate() rather than its absolute value.",
  usageReadOk:
    "Whether the fleet usage read answered this scrape (1) or failed (0). At 0 the usage series are absent because nothing was measured — not because the fleet used nothing.",
  usageWindowSeconds:
    "The usage window this scrape asked for, in seconds. Every usage figure is a sum over exactly this window.",
  usageSampledTokensDelta:
    "Sum of the POSITIVE per-seat token deltas observed in the window on this host. SAMPLED: each seat is read at whatever rate its own sampler runs, so a seat idle between samples shows less than it used, and nothing here is metered against a bill. This is NOT exact token or cost accounting and must not be used as one. A host that did not answer contributes nothing and appears in no usage series.",
  usageResets:
    "Provider token counters that went down on this host in the window — a session restart, counted rather than subtracted from the delta. Sampled, like every other usage figure here.",
  usageSeatsRanked:
    "Seats on this host the usage read could rank in the window. A host that answered with no ranked seats reports 0; a host that did not answer is absent.",
  usageSeatsUnknown:
    "Seats on this host the usage read could not rank in the window, each with the origin's reason on the fleet usage read itself. Sampled, like every other usage figure here.",
  fanoutCacheAgeSeconds:
    "How old the fleet SUMMARY this scrape served was, in seconds. A scrape reuses the fan-out the TUI and CLI already paid for; this says how much younger the answer is than the scrape. It describes the summary only — the usage section is a separate cache with its own age and is not covered by this figure.",
  fanoutCacheStale:
    "Whether the SUMMARY served was older than the fleet cache ttl because a refresh was still in flight (1). At 1 the fleet is being served stale while one fan-out runs behind it. The usage section is a separate cache and is not covered by this flag.",
} as const;

/** The exposition body for one scrape. */
export function renderFleetMetrics(input: FleetMetricsInput): string {
  const e = new Exposition();
  const summary = input.summary;

  // ---- reachability: every targeted host, on every scrape ---------------------
  // Driven off `hosts` (the omission-proof per-host list) rather than `items`, so a
  // host that vanished from one still reports `up 0` instead of vanishing.
  for (const host of summary.hosts) {
    e.add("openrig_fleet_host_up", "gauge", HELP.hostUp, { host: host.hostId }, host.status === "ok" ? 1 : 0);
    e.add("openrig_fleet_host_read_status", "gauge", HELP.hostReadStatus, { host: host.hostId, status: host.status }, 1);
  }

  e.add("openrig_fleet_stall_threshold_seconds", "gauge", HELP.stallThreshold, {}, summary.stallThresholdMinutes * 60);
  e.add("openrig_fleet_fanout_cache_age_seconds", "gauge", HELP.fanoutCacheAgeSeconds, {}, summary.cacheAgeMs / 1000);
  e.add("openrig_fleet_fanout_cache_stale", "gauge", HELP.fanoutCacheStale, {}, summary.cacheStaleWhileRevalidate ? 1 : 0);

  // ---- everything else: only from a host that ANSWERED ------------------------
  for (const item of summary.items) {
    if (!item.reachable) continue;
    const host = item.hostId;

    e.add("openrig_fleet_rigs", "gauge", HELP.rigs, { host }, item.rigCount);
    e.add("openrig_fleet_queue_overdue_items", "gauge", HELP.queueOverdueItems, { host }, item.overdueCount);
    e.add("openrig_fleet_queue_undelivered_items", "gauge", HELP.queueUndeliveredItems, { host }, item.undeliveredCount);

    const hostProgress = toUnixSeconds(item.progress.lastProgressAt);
    e.add("openrig_fleet_host_last_progress_timestamp_seconds", "gauge", HELP.hostLastProgress, { host }, hostProgress);
    e.add("openrig_fleet_host_stalled", "gauge", HELP.hostStalled, { host }, item.progress.stalled === null ? null : item.progress.stalled ? 1 : 0);

    if (item.stuckSweep) {
      e.add("openrig_fleet_stuck_sweep_last_run_timestamp_seconds", "gauge", HELP.stuckSweepLastRun, { host }, toUnixSeconds(item.stuckSweep.lastSweepAt));
      e.add("openrig_fleet_stuck_sweep_consecutive_failures", "gauge", HELP.stuckSweepConsecutiveFailures, { host }, item.stuckSweep.consecutiveFailures);
      e.add("openrig_fleet_stuck_sweep_findings_routed_total", "counter", HELP.stuckSweepFindingsRouted, { host }, item.stuckSweep.findingsRouted);
    }

    for (const rig of item.rigs) {
      const labels = { host, rig: rig.rigName };
      e.add("openrig_fleet_seats", "gauge", HELP.seats, { ...labels, activity: "working" }, rig.seatsByActivity.working);
      e.add("openrig_fleet_seats", "gauge", HELP.seats, { ...labels, activity: "idle" }, rig.seatsByActivity.idle);
      e.add("openrig_fleet_seats", "gauge", HELP.seats, { ...labels, activity: "needs-input" }, rig.seatsByActivity.needsInput);
      e.add("openrig_fleet_seats", "gauge", HELP.seats, { ...labels, activity: "unknown" }, rig.seatsByActivity.unknown);
      e.add("openrig_fleet_seats_with_assigned_work", "gauge", HELP.seatsWithAssignedWork, labels, rig.seatsWithAssignedWork);
      e.add("openrig_fleet_seats_running", "gauge", HELP.seatsRunning, labels, rig.runningCount);
      e.add("openrig_fleet_attention_items", "gauge", HELP.attentionItems, labels, rig.attentionCount);
      e.add(
        "openrig_fleet_rig_last_progress_timestamp_seconds",
        "gauge",
        HELP.rigLastProgress,
        labels,
        toUnixSeconds(rig.progress.lastProgressAt),
      );
      e.add(
        "openrig_fleet_rig_stalled",
        "gauge",
        HELP.rigStalled,
        labels,
        rig.progress.stalled === null ? null : rig.progress.stalled ? 1 : 0,
      );
    }

    // Per-rig queue counts, from the same flat list the host totals come from, so a
    // sum over `rig` IS the host total. A row with no rig gets the `none` literal
    // rather than an empty label so it is still counted and still visible.
    const queue = new Map<string, number>();
    for (const row of summary.openQueue) {
      if (row.hostId !== host) continue;
      const rig = row.rigName || NO_RIG;
      const key = `${rig}\u0000${row.state}`;
      queue.set(key, (queue.get(key) ?? 0) + 1);
    }
    for (const [key, count] of queue) {
      const [rig, state] = key.split("\u0000");
      e.add("openrig_fleet_queue_items", "gauge", HELP.queueItems, { host, rig: rig!, state: state! }, count);
    }
  }

  // ---- usage -----------------------------------------------------------------
  if (input.usage) {
    // Only a host the SUMMARY reached contributes usage. The summary and the usage
    // read are two caches with two fan-outs that run at different moments, so one can
    // have answered for a host the other did not. Publishing usage for a host the same
    // scrape just called `up 0` would put a measurement on a host the scrape says it
    // cannot measure, and a host that appears only in the usage payload (the registry
    // changed between the two fan-outs) would publish series with no `host_up` at all.
    const answered = new Set(summary.hosts.filter((h) => h.status === "ok").map((h) => h.hostId));
    const usage = input.usage;
    e.add("openrig_fleet_usage_read_ok", "gauge", HELP.usageReadOk, {}, 1);
    e.add("openrig_fleet_usage_window_seconds", "gauge", HELP.usageWindowSeconds, {}, usage.windowHours * 3600);
    for (const hostUsage of usage.items) {
      // Not answered in this scrape, so no usage series — the host already carries
      // `up 0` and its read verdict, and that is the whole honest statement about it.
      if (!answered.has(hostUsage.hostId)) continue;
      // No read, no series. `totals` is absent exactly when there is no measurement,
      // and a zero here would be a host that used nothing.
      if (hostUsage.usage.state !== "ok" || !hostUsage.usage.totals) continue;
      const totals = hostUsage.usage.totals;
      const labels = { host: hostUsage.hostId };
      e.add("openrig_fleet_usage_sampled_tokens_delta", "gauge", HELP.usageSampledTokensDelta, labels, totals.tokensDelta);
      e.add("openrig_fleet_usage_resets", "gauge", HELP.usageResets, labels, totals.resets);
      e.add("openrig_fleet_usage_seats_ranked", "gauge", HELP.usageSeatsRanked, labels, totals.seatsRanked);
      e.add("openrig_fleet_usage_seats_unknown", "gauge", HELP.usageSeatsUnknown, labels, totals.seatsUnknown);
    }
  } else {
    e.add("openrig_fleet_usage_read_ok", "gauge", HELP.usageReadOk, {}, 0);
  }

  return e.render();
}
