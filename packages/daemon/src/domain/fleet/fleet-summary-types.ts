// The payload shapes for the ONE fleet read: a single daemon-side fan-out that
// answers "what is every team doing, and has any of them stopped moving".
//
// The payload is a close sibling of the shared P4 fan-out contract
// (`../hosts/fanout-contract.ts` `AggregatedPayload`): `items` (one entry per
// host) plus `hosts` (a `PerHostStatus` for EVERY host on EVERY read,
// omission-proof). It adds `openQueue` because the attention aggregate carries
// only the attention CLASS, so a remote item blocked on an AGENT and a remote
// in-progress PARKED row could never reach a renderer. Open items in every open
// state, with `blockedOn`, ride here instead.

import type { AggregatedPayload, PerHostStatus } from "../hosts/fanout-contract.js";

/** The four-value seat display vocabulary, pre-derived server-side by the
 *  origin daemon (`activity-taxonomy.deriveDisplayActivity`). A fleet reader
 *  COUNTS these; it never re-arbitrates a seat's state. */
export type FleetSeatDisplayActivity = "working" | "idle" | "needs-input" | "unknown";

/** Seat counts by display activity. `total` is the seat count the buckets were
 *  derived from, so a reader can tell "all unknown" from "no seats". */
export interface FleetSeatActivityCounts {
  working: number;
  idle: number;
  needsInput: number;
  unknown: number;
  total: number;
}

/** The stuck sweep's heartbeat, passed through VERBATIM from the origin's
 *  `/healthz`. Absent on a daemon old enough not to publish it — that is a
 *  fact about the origin, never a zero. */
export interface FleetStuckSweepHeartbeat {
  lastSweepAt: string | null;
  lastOutcome: "clean" | "findings" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  findingsRouted: number;
}

/** An open queue item as the fleet sees it. A projection of the origin's
 *  `/api/queue/list` row — only the fields a fleet reader renders, plus the
 *  host and rig it belongs to. `blockedOn` is the field that makes BLOCKED ON
 *  AGENTS possible for a remote row. */
export interface FleetQueueItem {
  hostId: string;
  rigName: string | null;
  qitemId: string;
  state: "pending" | "in-progress" | "blocked";
  destinationSession: string | null;
  sourceSession: string | null;
  blockedOn: string | null;
  /** Carried so a reader can tell a stranded in-progress baton from a handed-off
   * one. Absent would be read as "not handed off", so it is served rather than omitted. */
  handedOffTo: string | null;
  /** When the owner claimed it — the age a reader shows on an in-progress row. */
  claimedAt: string | null;
  priority: string | null;
  summary: string | null;
  tags: string[];
  tsCreated: string | null;
  tsUpdated: string | null;
}

/** The named progress sources:
 *
 *  - `queue-transition` IS progress: a queue transition written by a seat or a
 *    human. Transitions whose actor ends in `@system` (e.g. `watchdog@system`)
 *    are the watcher talking to itself and are excluded. Note-only updates count
 *    — that is the mechanism a team uses to say "still working, here is the
 *    milestone".
 *  - `seat-output` is NOT progress. It is tmux `#{window_activity}`, advanced by
 *    ANY bytes written to the pane; measured on a Claude Code seat it ticks
 *    every second while a silent shell command redraws a spinner. A seat stuck in
 *    a silent `while pgrep …; do sleep …; done` loop would never stall under it. It
 *    is still
 *    reported, as "last output", because "the seats are loud and nothing moved"
 *    is itself worth showing — it is just never counted.
 *
 *  The predicate takes its enabled sources as an INPUT so the rule is one
 *  constant and the mechanism stays testable, not because the question is open. */
export type FleetProgressSourceName = "queue-transition" | "seat-output";

/** Which source produced `lastProgressAt`. `none` means open work exists and NO
 *  enabled source produced a timestamp — never reported as stalled. */
export type FleetProgressSource = FleetProgressSourceName | "none";

/** The raw per-scope facts, kept SEPARATE on the payload. A reader can render
 *  either one and can tell which rule produced the verdict, so changing the rule
 *  never requires changing a renderer. */
export interface FleetProgressSources {
  /** Newest progress-eligible queue transition on the scope: a state change OR a
   *  note-only update, by a seat or a human, never by a `@system` actor. */
  lastQueueTransitionAt: string | null;
  /** Newest raw tmux seat output on the scope. REPORTED, NEVER COUNTED — see
   *  `FleetProgressSourceName`. Rendered as "last output". */
  lastSeatOutputAt: string | null;
}

/** The progress/stall block, identical in shape on a host and on a rig so a
 *  renderer handles one shape. */
export interface FleetProgress extends FleetProgressSources {
  /** Newest timestamp among the ENABLED sources, or null when none produced one. */
  lastProgressAt: string | null;
  lastProgressSource: FleetProgressSource;
  /** The sources this verdict was allowed to read — stated so a reader can tell
   *  which rule was in force instead of guessing from the answer. */
  enabledProgressSources: FleetProgressSourceName[];
  /** Null whenever `lastProgressAt` is null. */
  minutesSinceProgress: number | null;
  /** true  = open work AND no progress for longer than the threshold.
   *  false = open work and progress inside the threshold, OR no open work.
   *  null  = open work and NO enabled-source progress evidence at all. */
  stalled: boolean | null;
  /** Open items in any open state on this scope; the precondition for stalling.
   *  A scope with nothing owed cannot be stalled. */
  openWorkCount: number;
  /** True when the per-item transition reads were truncated to the bound, so
   *  `lastQueueTransitionAt` may be older than the real newest note. Disclosed,
   *  never silently under-reported. */
  progressReadsTruncated: boolean;
}

/** One seat, as the fleet sees it. The fleet read already had to fetch every
 *  seat to count activity, so carrying the rows costs nothing extra and lets
 *  `rig ps --all-hosts --nodes` be served by the SAME fan-out instead of a
 *  second one. Identity fields only — no transcript, no body. */
export interface FleetSeatSummary {
  hostId: string;
  rigId: string;
  rigName: string;
  logicalId: string | null;
  canonicalSessionName: string | null;
  /** `agent` or an infrastructure kind, VERBATIM from the nodes read. Hard-coding
   *  "agent" here would mislabel every non-agent seat a reader projected. */
  nodeKind: string | null;
  /** The nodes read's own session status — a different vocabulary from
   *  `lifecycleState`, and the one `ps --filter status=` reads. */
  sessionStatus: string | null;
  role: string | null;
  runtime: string | null;
  /** `working | idle | needs-input | unknown`; null = the origin had no answer,
   *  which is NOT the same as `idle`. */
  activity: string | null;
  /** The short phrase naming why nothing is moving, when something is. */
  needsInputReason: string | null;
  /** Raw tmux last-output fact. Reported, never counted as progress. */
  lastActivityAt: string | null;
  lifecycleState: string | null;
  startupStatus: string | null;
}

/** One rig on one host. */
export interface FleetRigSummary {
  rigId: string;
  rigName: string;
  hostId: string;
  seatCount: number;
  seatsByActivity: FleetSeatActivityCounts;
  /** The origin's own per-rig attention count; never recomputed here. */
  attentionCount: number;
  seatsWithAssignedWork: number;
  lifecycleState: string | null;
  /** `runningCount` and `status` VERBATIM from the origin's /api/ps row. A rig whose
   *  seats are all stopped must read as stopped; a seat count cannot tell a running
   *  seat from a declared one, and `partial` would be unreachable. */
  runningCount: number | null;
  psStatus: string | null;
  progress: FleetProgress;
  /** The seats behind `seatsByActivity`, so a node-level reader does not need
   *  a second fan-out. Empty when the origin's nodes leg failed — which is
   *  disclosed in the host's `partialFailures`, never silently empty on a
   *  successful read. */
  seats: FleetSeatSummary[];
}

/** One host — the local daemon or one entry from `hosts.yaml`. Absent from
 *  `items` only never; an unreachable host still appears, with its status and
 *  nothing else (never a silently thinner fleet). */
export interface FleetHostSummary {
  hostId: string;
  kind: "local" | "remote";
  /** The origin's boot-reconciled self id, when it publishes one. */
  selfHostId: string | null;
  status: PerHostStatus;
  /** Convenience for renderers: `status.status === "ok"`. */
  reachable: boolean;
  rigCount: number;
  seatCount: number;
  seatsByActivity: FleetSeatActivityCounts;
  attentionCount: number;
  openQueueCount: number;
  openQueueByState: { pending: number; inProgress: number; blocked: number };
  overdueCount: number | null;
  undeliveredCount: number | null;
  stuckSweep: FleetStuckSweepHeartbeat | null;
  progress: FleetProgress;
  rigs: FleetRigSummary[];
  /** Honest per-signal failure notes for a host that answered SOME legs and
   *  failed others (e.g. `/api/ps` ok, one rig's `/nodes` 500). A partial read
   *  is disclosed, never folded into a clean `ok`. */
  partialFailures: string[];
}

/** The `/api/fleet/summary` payload. */
export interface FleetSummaryPayload extends AggregatedPayload<FleetHostSummary> {
  /** Every open queue item across every host that answered, each stamped with
   *  its `hostId`. Flat so a renderer does not have to walk the host tree. */
  openQueue: FleetQueueItem[];
  generatedAt: string;
  /** The threshold in force for THIS payload (a setting, re-read per fan-out). */
  stallThresholdMinutes: number;
  /** The progress sources the stall verdict was allowed to read. A reader
   *  renders the verdict, never re-derives it. */
  enabledProgressSources: FleetProgressSourceName[];
  /** Per-host deadline in force — each host's own budget, not a shared one. */
  hostTimeoutMs: number;
  concurrency: number;
  /** True when this payload came from the short cache instead of a fresh fan-out. */
  fromCache: boolean;
  /** Age of the cached payload in ms (0 on a fresh one). */
  cacheAgeMs: number;
  /** True when the cache held a payload that is older than `cacheTtlMs` because
   *  the refresh was still in flight (single-flight keeps one reader waiting
   *  rather than starting a fan-out per reader). */
  cacheStaleWhileRevalidate: boolean;
  cacheTtlMs: number;
  /** The host ids the fan-out targeted, in order. Lets a reader tell a missing
   *  host from an unregistered one. */
  targetedHostIds: string[];
  /** Set only when `hosts.yaml` EXISTS but could not be read: there was no host
   *  list to attribute per-host statuses to, so the fleet is local-only for a
   *  stated reason rather than a silently thin one. */
  registryError?: string;
}
