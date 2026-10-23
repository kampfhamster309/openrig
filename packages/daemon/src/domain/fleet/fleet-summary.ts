// THE one fleet read.
//
// A hub daemon (no rigs of its own; every team is a remote host) is the
// operator's single point of truth. Before this, every reader fanned out on its
// own, and nothing could tell the operator that a team had STOPPED making
// progress — seat activity alone cannot, because a seat whose runtime signal went
// stale reports `unknown`, and a seat stuck in a self-matching shell loop reports
// `working` forever.
//
// Composition only from routes an OLD team-pod daemon already serves. Every
// remote leg below is a path the oldest supported image answers; this module adds
// no route the REMOTE side has to serve. Each leg is served unchanged by daemons
// that predate this read.
//
// Fan-out discipline (the three things this exists to fix):
//   * ONE deadline PER HOST, started when that host's leg starts. A shared fleet
//     deadline makes a slow team look unreachable for no reason of its own; a
//     per-host budget makes a slow host burn only its own.
//   * bounded, configurable concurrency (the shipped aggregator's posture).
//   * a short cache with single-flight, so one fan-out serves every TUI and CLI
//     reader instead of one fan-out per reader per poll.
//
// The LOCAL host joins in-process (zero self-transport), the same ruling
// `domain/review/fleet-compose.ts` follows.

import { getSelfHostId, LOCAL_HOST_ID, type PerHostStatus } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult, HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest, type RemoteJsonFailureKind } from "../hosts/remote-daemon-http.js";
import { FLEET_FANOUT_CONCURRENCY_DEFAULT, FLEET_HOST_TIMEOUT_MS_DEFAULT, FLEET_STALL_THRESHOLD_MINUTES_DEFAULT } from "./fleet-settings.js";
import type {
  FleetHostSummary,
  FleetProgress,
  FleetProgressSource,
  FleetProgressSourceName,
  FleetProgressSources,
  FleetQueueItem,
  FleetRigSummary,
  FleetSeatActivityCounts,
  FleetSeatSummary,
  FleetStuckSweepHeartbeat,
  FleetSummaryPayload,
} from "./fleet-summary-types.js";

/** Each host's OWN read budget. Same read class as the shipped aggregator (a
 *  poll, not a bootstrap) — but applied per host, not shared across the fleet.
 *  Operator-configurable (`fleet.host_timeout_ms`); the default lives in
 *  `fleet-settings.ts` so the route, the store and this module read one number. */
export const FLEET_HOST_TIMEOUT_MS = FLEET_HOST_TIMEOUT_MS_DEFAULT;

/** Fixed fan-out cap; configurable because a hub with many teams is the case
 *  this read is for (`fleet.fanout_concurrency`). */
export const FLEET_FANOUT_CONCURRENCY = FLEET_FANOUT_CONCURRENCY_DEFAULT;

/** Short enough that the operator sees a real change within a poll, long enough
 *  that a TUI and a CLI polling at once cost ONE fan-out. */
export const FLEET_SUMMARY_CACHE_MS = 3_000;

/** How old a payload may get before stale-while-revalidate stops serving it. One
 *  failed read should be smoothed over; a fan-out that stays broken should not keep
 *  dressing up minutes-old state as a live fleet. Past this bound readers wait for the
 *  real run and meet its failure, which is the honest outcome. */
export const FLEET_SUMMARY_STALE_BOUND_MS = 60_000;

/** Default stall threshold. The value and the settings key live together in
 *  `fleet-settings.ts` so the store and this module cannot drift. */
export { FLEET_STALL_THRESHOLD_MINUTES_DEFAULT } from "./fleet-settings.js";

/** Open states the read covers. Every open state, not the attention class —
 *  that difference is the reason this route exists next to the aggregate. */
export const FLEET_OPEN_STATES = ["pending", "in-progress", "blocked"] as const;

/** Per-list bound. A team with more open items than this is disclosed as
 *  truncated rather than silently counted short. */
export const FLEET_QUEUE_PAGE_LIMIT = 200;

/** The origin clamps its own recent-transition window to this. */
export const FLEET_TRANSITION_WINDOW = 20;

/** How many OPEN items get a per-item transition read. Note-only updates are not
 *  in `recent-transitions`, and the decided rule counts them, so the newest note
 *  has to be read per item. Bounded because a host with a thousand open items is
 *  not worth a thousand requests for one timestamp; when the bound bites, the
 *  payload says so instead of quietly under-reporting. */
export const FLEET_TRANSITION_ITEM_LIMIT = 25;
/** How many per-item transition reads run at once INSIDE one host's budget. These
 *  legs come after health, ps, nodes and queue, so serially they are the tail most
 *  likely to be cut off by the host deadline on a slow-but-healthy host. */
export const FLEET_TRANSITION_ITEM_CONCURRENCY = 4;

/** A transition whose actor ends in this is the watcher talking to itself (e.g.
 *  `watchdog@system`), not the team's work moving. Excluded from progress. */
export const SYSTEM_ACTOR_SUFFIX = "@system";
/** The bare machine actor the queue writes when a seat handover releases a claim. */
export const SYSTEM_ACTOR_BARE = "system";
/** Prefix for machine actors with a named subsystem, e.g. `system:queue-fallback`. */
export const SYSTEM_ACTOR_PREFIX = "system:";
/** The kernel daemon acting on a team's behalf (Slack notifications, delivery
 *  deferral, reply-to-choice). A daemon note is not a seat working. */
export const KERNEL_DAEMON_ACTOR = "daemon@kernel";

/** Does this actor's transition count as progress? A seat or a human does; a
 *  `@system` actor does not. A missing actor counts as nothing — absence is not
 *  evidence. */
/** Is this actor a SEAT or a HUMAN, i.e. allowed to count as progress?
 *
 *  The rule is an EXCLUSION list, not a known-seat allowlist. An allowlist would
 *  quietly drop humans and hub-relayed cross-host actors — the sessions written as
 *  `someone@host` when another host's hub posts on their behalf — and those are
 *  exactly the actors whose work must keep a team alive. So everything counts unless
 *  it is a recognised machine actor.
 *
 *  Each shape below is a real writer of queue transitions in the image this fan-out
 *  reads (base f06e626b4), with where it comes from:
 *
 *  - `@system` suffix — the queue's own bookkeeping actors, written by the watcher
 *    and the daemon rather than by a seat: `watchdog@system`, `queue@system`,
 *    `daemon@system`, `wake-ladder@system`, `model-monitor@system`.
 *  - exactly `system` — claim releases on seat handover
 *    (`queue-repository.ts:3904`).
 *  - `system:` prefix — fallback reroutes, e.g. `system:queue-fallback`
 *    (`queue-repository.ts:3820`).
 *  - `daemon@kernel` — the kernel daemon acting, not a seat: Slack owner-notification
 *    notes (`gateway/slack/slack-subsystem.ts:313…619`), the away-escalation deferral's
 *    armed/dispatching/attempt-failed notes (`policies/delivery-deferral.ts:66–165`),
 *    and reply-to-choice (`reply-to-choice.ts:9`).
 *
 *  The last one matters most: the deferral and Slack notes fire on precisely the team
 *  that is waiting on a human, so counting them resets the stall clock on a dead team
 *  — the exact failure the rule exists to prevent. */
export function isProgressActor(actorSession: string | null | undefined): boolean {
  if (typeof actorSession !== "string" || actorSession === "") return false;
  const actor = actorSession.trim();
  if (actor === "") return false;
  if (actor.endsWith(SYSTEM_ACTOR_SUFFIX)) return false;
  if (actor === SYSTEM_ACTOR_BARE) return false;
  if (actor.startsWith(SYSTEM_ACTOR_PREFIX)) return false;
  if (actor === KERNEL_DAEMON_ACTOR) return false;
  return true;
}

/** The progress-source policy, in one constant, with its reasons:
 *
 *  - `queue-transition` IS progress: a queue transition written by a seat or a
 *    human, INCLUDING a note-only update. `@system` actors are excluded.
 *  - `seat-output` is NOT. It is tmux `#{window_activity}`, advanced by any bytes
 *    written to the pane; measured on a Claude Code seat it ticks every second
 *    while a silent command redraws a spinner, so a seat stuck in a self-matching
 *    `while pgrep …; sleep` loop would never stall under it. It is still reported per
 *    host and per rig as "last output", because "loud and going nowhere" is itself
 *    worth showing.
 *
 *  The predicate takes its enabled sources as an INPUT so the rule is one constant
 *  and the mechanism stays testable. The sources themselves are settled, not open. */
export const ACTIVE_PROGRESS_SOURCES: readonly FleetProgressSourceName[] = [
  "queue-transition",
];

export interface LocalSeatFacts {
  /** The origin's pre-derived display value; null = no answer, never "idle". */
  display: string | null;
  lastActivityAt: string | null;
  logicalId?: string | null;
  canonicalSessionName?: string | null;
  /** Same fields the remote leg carries verbatim, so a reader cannot tell which leg
   *  a seat row came from by which fields are missing. */
  nodeKind?: string | null;
  sessionStatus?: string | null;
  role?: string | null;
  runtime?: string | null;
  needsInputReason?: string | null;
  lifecycleState?: string | null;
  startupStatus?: string | null;
}

/** The per-rig shape BOTH legs hand to the one composer: the remote leg fills it
 *  from `/api/ps` + `/api/rigs/:id/nodes`, the local leg from the same services
 *  in-process. `runningCount`/`psStatus` are VERBATIM from the origin's ps row — a
 *  rig whose seats are all stopped must read as stopped, and a seat count cannot
 *  tell a running seat from a declared one. */
export interface RigRead {
  rigId: string;
  rigName: string;
  attentionCount: number;
  seatsWithAssignedWork: number;
  lifecycleState: string | null;
  runningCount: number | null;
  psStatus: string | null;
  displays: Array<string | null>;
  seatOutputAt: string | null;
  seats: FleetSeatSummary[];
}

export interface LocalRigFacts {
  rigId: string;
  rigName: string;
  attentionCount: number;
  seatsWithAssignedWork: number;
  lifecycleState: string | null;
  /** Same origin-reported pair the remote leg carries, so the local host and a
   *  remote one are projected by identical CLI code. */
  runningCount?: number | null;
  psStatus?: string | null;
  seats: LocalSeatFacts[];
}

/** What the local host contributes. Mirrors the remote legs so ONE composer
 *  handles both, and so the route — not this module — owns every db touch. */
export interface LocalHostFacts {
  selfHostId: string | null;
  stuckSweep: FleetStuckSweepHeartbeat | null;
  rigs: LocalRigFacts[];
  openQueue: Array<Record<string, unknown>>;
  overdueCount: number;
  undeliveredCount: number;
  /** Instance-wide recent transitions: only QUALIFYING state changes, capped by
   *  the origin at `FLEET_TRANSITION_WINDOW`. Note-only updates are NOT here,
   *  which is why `openItemTransitions` exists. */
  recentTransitions: Array<{ ts: string | null; rig: string | null; actorSession: string | null }>;
  /** The full transition log of each OPEN item, which is where a note-only
   *  update lives. Keyed by the item so a note is attributed to that item's rig. */
  openItemTransitions: Array<{ qitemId: string; transitions: Array<{ ts: string | null; actorSession: string | null }> }>;
  /** True when there were more open items than the per-item read bound covers. */
  openItemTransitionsTruncated?: boolean;
}

export interface FleetSummaryDeps {
  /** The LOCAL host's facts, read in-process. Injected by the route. */
  readLocalHost: () => LocalHostFacts;
  /** S11's shared registry reader (hosts.yaml is never re-parsed here). */
  loadRegistry: () => HostRegistryLoadResult;
  /** A missing registry = a single-host operator: a clean local-only fleet. */
  registryExists: () => boolean;
  stallThresholdMinutes?: number;
  /** The progress sources the stall predicate may read. Defaults to
   *  `ACTIVE_PROGRESS_SOURCES`; passed explicitly by anything testing the
   *  mechanism without taking a position on the policy. */
  progressSources?: readonly FleetProgressSourceName[];
  hostTimeoutMs?: number;
  concurrency?: number;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

// ---------------------------------------------------------------------------
// Pure helpers — these carry the rules the tests pin.
// ---------------------------------------------------------------------------

/** The session grammar is `<pod>-<member>@<rig>`; the rig is what follows
 *  the LAST `@` — the same reading `review/fleet-compose.ts` uses. Returns null
 *  for anything not that shape; never a guessed rig. */
export function rigNameFromSession(session: string | null | undefined): string | null {
  if (!session) return null;
  const at = session.lastIndexOf("@");
  if (at <= 0 || at === session.length - 1) return null;
  return session.slice(at + 1);
}

/** Order open queue rows by `tsUpdated` DESC, newest first, with unparseable or
 *  missing stamps last. Used to choose WHICH open items get a per-item transition
 *  read when the bound forces a choice: `/list` returns `ts_created DESC`, and the
 *  items whose logs matter are the long-running ones a seat keeps updating with
 *  milestone notes — a note bumps `tsUpdated`, creation time does not. */
export function byNewestUpdated(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const stamp = (row: Record<string, unknown>): number => {
    const raw = row["tsUpdated"];
    if (typeof raw !== "string") return -1;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? -1 : t;
  };
  return [...rows].sort((a, b) => stamp(b) - stamp(a));
}

/** Newest ISO timestamp in a list, ignoring nulls and unparseable values.
 *  Lexicographic on purpose: every producer here emits ISO-8601 UTC, for which
 *  string order IS time order, so a malformed value simply loses. */
export function newestIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (typeof v !== "string" || v === "") continue;
    if (Number.isNaN(Date.parse(v))) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

/** THE stall predicate — one small pure function, and its progress sources are an
 *  explicit INPUT rather than something it reaches for.
 *
 *  A scope is stalled iff it has open work AND no ENABLED progress source has
 *  produced a timestamp inside the threshold.
 *
 *  Deliberately never progress: the stuck-sweep heartbeat (the watcher's
 *  liveness, not the team's) and a queue row's `tsUpdated` (a nudge attempt
 *  writes it, so an unanswered row would look alive forever). Raw seat output is
 *  excluded by the settled rule, not left open: pane bytes tick while a seat is
 *  stuck in a silent loop, so they cannot mean progress — see
 *  `ACTIVE_PROGRESS_SOURCES`. It is still reported alongside, as "last output".
 *
 *  A scope with NO open work is never stalled: nothing was owed. A scope with
 *  open work and no enabled-source evidence at all is `null`, neither `false`
 *  nor `true`: absence of a signal is not evidence of a stall. */
export function deriveFleetProgress(input: {
  openWorkCount: number;
  /** The raw facts, kept separate by the caller and reported verbatim. */
  sources: FleetProgressSources;
  /** Which of those facts may back a verdict. */
  enabledSources: readonly FleetProgressSourceName[];
  thresholdMinutes: number;
  nowMs: number;
  /** True when the per-item transition reads hit the bound, so the newest note
   *  may be older than the real one. Disclosed rather than silently under-reported. */
  progressReadsTruncated?: boolean;
}): FleetProgress {
  const queueAt = input.enabledSources.includes("queue-transition") ? input.sources.lastQueueTransitionAt : null;
  const seatAt = input.enabledSources.includes("seat-output") ? input.sources.lastSeatOutputAt : null;
  const lastProgressAt = newestIso([queueAt, seatAt]);

  let lastProgressSource: FleetProgressSource = "none";
  if (lastProgressAt !== null) {
    const seatWins = seatAt !== null && (queueAt === null || seatAt > queueAt);
    lastProgressSource = seatWins ? "seat-output" : "queue-transition";
  }

  const minutesSinceProgress = lastProgressAt === null
    ? null
    : Math.max(0, Math.round((input.nowMs - Date.parse(lastProgressAt)) / 60_000));

  let stalled: boolean | null;
  if (input.openWorkCount === 0) stalled = false;
  else if (lastProgressAt === null) stalled = null;
  else stalled = minutesSinceProgress! > Math.max(1, input.thresholdMinutes);

  return {
    lastQueueTransitionAt: input.sources.lastQueueTransitionAt,
    lastSeatOutputAt: input.sources.lastSeatOutputAt,
    lastProgressAt,
    lastProgressSource,
    enabledProgressSources: [...input.enabledSources],
    minutesSinceProgress,
    stalled,
    openWorkCount: input.openWorkCount,
    progressReadsTruncated: input.progressReadsTruncated ?? false,
  };
}

/** One progress-eligible queue event: a timestamp plus the rig it belongs to. */
export interface FleetProgressEvent {
  ts: string;
  rig: string | null;
}

/** The progress-eligible queue events for one host, from BOTH places a
 *  transition can be read on an old image:
 *
 *  - the instance-wide recent transitions, which carry only QUALIFYING state
 *    changes (and are capped by the origin), and
 *  - each open item's own transition log, which is where a NOTE-ONLY update
 *    lives — the mechanism the guidance asks a team to use during long work.
 *
 *  `@system` actors are dropped here, once, so no caller has to remember. A note
 *  on an open item is attributed to that item's rig. */
export function collectProgressEvents(input: {
  recentTransitions: Array<{ ts: string | null; rig: string | null; actorSession: string | null }>;
  openQueue: FleetQueueItem[];
  openItemTransitions: Array<{ qitemId: string; transitions: Array<{ ts: string | null; actorSession: string | null }> }>;
}): FleetProgressEvent[] {
  const rigByItem = new Map(input.openQueue.map((i) => [i.qitemId, i.rigName]));
  const events: FleetProgressEvent[] = [];
  for (const t of input.recentTransitions) {
    if (t.ts !== null && isProgressActor(t.actorSession)) events.push({ ts: t.ts, rig: t.rig });
  }
  for (const perItem of input.openItemTransitions) {
    const rig = rigByItem.get(perItem.qitemId) ?? null;
    for (const t of perItem.transitions) {
      if (t.ts !== null && isProgressActor(t.actorSession)) events.push({ ts: t.ts, rig });
    }
  }
  return events;
}

/** Count seats into the four display buckets. An absent `activityState` (an
 *  origin too old to publish the taxonomy) and an explicit null (the oracle has
 *  no answer) both land in `unknown` — "not known", never "idle". */
export function summarizeSeatActivity(displays: Array<string | null | undefined>): FleetSeatActivityCounts {
  const counts: FleetSeatActivityCounts = { working: 0, idle: 0, needsInput: 0, unknown: 0, total: 0 };
  for (const display of displays) {
    counts.total += 1;
    if (display === "working") counts.working += 1;
    else if (display === "idle") counts.idle += 1;
    else if (display === "needs-input") counts.needsInput += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/** Project one origin queue row (a local repo object or remote JSON) onto the
 *  fleet shape. A row in a closed state is dropped by the caller, not coerced. */
export function projectFleetQueueItem(raw: Record<string, unknown>, hostId: string): FleetQueueItem | null {
  const state = raw["state"];
  if (state !== "pending" && state !== "in-progress" && state !== "blocked") return null;
  const destination = typeof raw["destinationSession"] === "string" ? (raw["destinationSession"] as string) : null;
  const source = typeof raw["sourceSession"] === "string" ? (raw["sourceSession"] as string) : null;
  const tags = Array.isArray(raw["tags"])
    ? (raw["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return {
    hostId,
    rigName: rigNameFromSession(destination) ?? rigNameFromSession(source),
    qitemId: typeof raw["qitemId"] === "string" ? (raw["qitemId"] as string) : "",
    state,
    destinationSession: destination,
    sourceSession: source,
    blockedOn: typeof raw["blockedOn"] === "string" ? (raw["blockedOn"] as string) : null,
    handedOffTo: typeof raw["handedOffTo"] === "string" ? (raw["handedOffTo"] as string) : null,
    claimedAt: typeof raw["claimedAt"] === "string" ? (raw["claimedAt"] as string) : null,
    priority: typeof raw["priority"] === "string" ? (raw["priority"] as string) : null,
    summary: typeof raw["summary"] === "string" ? (raw["summary"] as string) : null,
    tags,
    tsCreated: typeof raw["tsCreated"] === "string" ? (raw["tsCreated"] as string) : null,
    tsUpdated: typeof raw["tsUpdated"] === "string" ? (raw["tsUpdated"] as string) : null,
  };
}

/** Is an open item parked on a HUMAN (the park-on-human row the TUI already
 *  shows) or on an agent/seat (the row the attention aggregate could not carry)?
 *  A qitem id or an empty blocker is not a person. Lives here so the CLI and the
 *  TUI cannot disagree. */
export function isBlockedOnHuman(blockedOn: string | null | undefined): boolean {
  return typeof blockedOn === "string" && /^human[-\w]*@/.test(blockedOn);
}

// ---------------------------------------------------------------------------
// Remote legs — every path below is answered by the OLDEST supported image.
// ---------------------------------------------------------------------------

function asArray(payload: unknown): Array<Record<string, unknown>> {
  return Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
}

type RemoteLeg =
  | { ok: true; payload: unknown }
  | { ok: false; note: string; kind: RemoteJsonFailureKind; httpStatus?: number };

/** One bounded remote GET under THIS HOST's own remaining budget. A failure is
 *  a value — never a throw, never a hang — and it keeps its transport KIND, so
 *  the closed per-host enum can tell an operator to rotate a bearer from one
 *  telling them to check the host. Its note is what `partialFailures` discloses. */
async function hostGet(
  host: HttpHostEntry,
  path: string,
  deadlineAt: number,
  deps: FleetSummaryDeps,
  label: string,
): Promise<RemoteLeg> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return { ok: false, kind: "timeout", note: `${label}: this host's own read budget was already spent` };
  const res = await remoteJsonRequest(host, path, {
    method: "GET",
    timeoutMs: remaining,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) return { ok: true, payload: res.payload };
  if (res.kind === "bearer") return { ok: false, kind: res.kind, note: `${label}: ${res.detail}` };
  if (res.kind === "http") return { ok: false, kind: res.kind, httpStatus: res.status, note: `${label}: HTTP ${res.status}${res.detail ? ` ${res.detail}` : ""}` };
  if (res.kind === "timeout") return { ok: false, kind: res.kind, note: `${label}: timed out with ${remaining}ms left of its own budget` };
  return { ok: false, kind: res.kind, note: `${label}: ${res.detail}` };
}

interface RemoteHostOutcome {
  status: PerHostStatus;
  summary: FleetHostSummary | null;
  openQueue: FleetQueueItem[];
}

interface StallPolicy {
  nowMs: number;
  thresholdMinutes: number;
  enabledSources: readonly FleetProgressSourceName[];
}

async function readRemoteHost(
  hostId: string,
  reg: HostRegistryLoadResult,
  deps: FleetSummaryDeps,
  policy: StallPolicy,
): Promise<RemoteHostOutcome> {
  const down = (status: PerHostStatus): RemoteHostOutcome => ({ status, summary: null, openQueue: [] });

  if (!reg.ok) return down({ hostId, status: "unreachable", error: reg.error });
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return down({ hostId, status: "unreachable", error: resolved.error });
  if (resolved.host.transport !== "http") {
    return down({
      hostId,
      status: "unsupported-transport",
      error: `host '${hostId}' is SSH-declared; the fleet summary read requires an http-transport registry entry (url; bearer optional)`,
    });
  }

  // THE per-host deadline: started here, spent by this host alone.
  const deadlineAt = Date.now() + (deps.hostTimeoutMs ?? FLEET_HOST_TIMEOUT_MS);
  const partial: string[] = [];

  // 1. /healthz — reachability + the stuck sweep's heartbeat. Not under /api/,
  //    so every image answers it and it needs no bearer.
  const health = await hostGet(resolved.host, "/healthz", deadlineAt, deps, "health probe");
  if (!health.ok) {
    // A bearer that cannot be resolved fails before any request is sent, so it
    // surfaces here rather than at /api/ps. The operator's fix is different
    // (rotate/set the bearer vs check the host), so the enum keeps them apart.
    if (health.kind === "bearer") {
      return down({ hostId, status: "auth-failed", error: health.note, failedStep: "permission-gate" });
    }
    return down({ hostId, status: "unreachable", error: `host did not answer its health probe: ${health.note}`, failedStep: "remote-daemon-unreachable" });
  }
  const healthBody = (health.payload ?? {}) as Record<string, unknown>;
  const selfHostId = typeof healthBody["selfHostId"] === "string" ? (healthBody["selfHostId"] as string) : null;
  const stuckSweep = healthBody["stuckSweep"] && typeof healthBody["stuckSweep"] === "object"
    ? (healthBody["stuckSweep"] as FleetStuckSweepHeartbeat)
    : null;

  // 2. /api/ps — the rig rollup: attentionCount, seat counts, lifecycle.
  const ps = await hostGet(resolved.host, "/api/ps", deadlineAt, deps, "ps");
  if (!ps.ok) {
    // The health probe answered but the authenticated API did not. That is a
    // different operator fix than a dead host, so the enum keeps them apart.
    const authFailed = ps.kind === "bearer" || ps.httpStatus === 401 || ps.httpStatus === 403;
    return down({
      hostId,
      status: authFailed ? "auth-failed" : "unreachable",
      error: authFailed ? ps.note : `health probe answered but the API did not: ${ps.note}`,
      failedStep: authFailed ? "permission-gate" : "remote-command-failed",
    });
  }
  const psRows = asArray(ps.payload).filter((r) => typeof r["rigId"] === "string");

  // 3. /api/rigs/:id/nodes — seat activity + the raw last-output fact. One call
  //    per rig: the old image has no cross-rig activity read.
  const rigReads: RigRead[] = [];
  for (const row of psRows) {
    const rigId = row["rigId"] as string;
    const rigName = typeof row["rigName"] === "string"
      ? (row["rigName"] as string)
      : (typeof row["name"] === "string" ? (row["name"] as string) : rigId);
    const declaredSeats = typeof row["nodeCount"] === "number" ? (row["nodeCount"] as number) : 0;
    const nodes = await hostGet(resolved.host, `/api/rigs/${encodeURIComponent(rigId)}/nodes`, deadlineAt, deps, `nodes for rig ${rigName}`);
    let displays: Array<string | null> = [];
    let seatOutputAt: string | null = null;
    const seats: FleetSeatSummary[] = [];
    if (nodes.ok) {
      for (const node of asArray(nodes.payload)) {
        const activityState = node["activityState"];
        const state = activityState && typeof activityState === "object"
          ? (activityState as Record<string, unknown>)
          : null;
        const display = state ? (String(state["display"] ?? "") || null) : null;
        const needsInput = state?.["needsInput"];
        const reason = needsInput && typeof needsInput === "object"
          ? (typeof (needsInput as Record<string, unknown>)["reason"] === "string" ? ((needsInput as Record<string, unknown>)["reason"] as string) : null)
          : null;
        const last = typeof node["lastActivityAt"] === "string" ? (node["lastActivityAt"] as string) : null;
        displays.push(display);
        if (last !== null && (seatOutputAt === null || last > seatOutputAt)) seatOutputAt = last;
        seats.push({
          hostId,
          rigId,
          rigName,
          logicalId: typeof node["logicalId"] === "string" ? (node["logicalId"] as string) : null,
          canonicalSessionName: typeof node["canonicalSessionName"] === "string" ? (node["canonicalSessionName"] as string) : null,
          // Carried verbatim, not inferred. `nodeKind` separates agent from
          // infrastructure seats; hard-coding "agent" mislabels the rest. And
          // `sessionStatus` is a different vocabulary from `lifecycleState` — the
          // CLI's --filter status= reads the first, so substituting the second
          // silently filters on the wrong field.
          nodeKind: typeof node["nodeKind"] === "string" ? (node["nodeKind"] as string) : null,
          sessionStatus: typeof node["sessionStatus"] === "string" ? (node["sessionStatus"] as string) : null,
          role: typeof node["role"] === "string" ? (node["role"] as string) : null,
          runtime: typeof node["runtime"] === "string" ? (node["runtime"] as string) : null,
          activity: display,
          needsInputReason: reason,
          lastActivityAt: last,
          lifecycleState: typeof node["lifecycleState"] === "string" ? (node["lifecycleState"] as string) : null,
          startupStatus: typeof node["startupStatus"] === "string" ? (node["startupStatus"] as string) : null,
        });
      }
    } else {
      // A rig whose nodes leg failed keeps its ps counts and reports its seats
      // as unknown: an absent read, disclosed, never a silent zero.
      partial.push(nodes.note);
      displays = new Array(declaredSeats).fill(null);
    }
    rigReads.push({
      rigId,
      rigName,
      attentionCount: typeof row["attentionCount"] === "number" ? (row["attentionCount"] as number) : 0,
      seatsWithAssignedWork: typeof row["hasWorkCount"] === "number" ? (row["hasWorkCount"] as number) : 0,
      runningCount: typeof row["runningCount"] === "number" ? (row["runningCount"] as number) : null,
      psStatus: typeof row["status"] === "string" ? (row["status"] as string) : null,
      lifecycleState: typeof row["lifecycleState"] === "string" ? (row["lifecycleState"] as string) : null,
      displays,
      seatOutputAt,
      seats,
    });
  }

  // 4. The queue legs — every open state, with `blockedOn`. This is the payload
  //    the attention aggregate never carried.
  const openRes = await hostGet(
    resolved.host,
    `/api/queue/list?state=${FLEET_OPEN_STATES.join(",")}&limit=${FLEET_QUEUE_PAGE_LIMIT}&compact=1`,
    deadlineAt, deps, "queue",
  );
  const openQueue: FleetQueueItem[] = [];
  if (openRes.ok) {
    for (const raw of asArray(openRes.payload)) {
      const item = projectFleetQueueItem(raw, hostId);
      if (item) openQueue.push(item);
    }
  } else {
    partial.push(openRes.note);
  }

  const overdueRes = await hostGet(resolved.host, `/api/queue/overdue?limit=${FLEET_QUEUE_PAGE_LIMIT}&compact=1`, deadlineAt, deps, "overdue");
  if (!overdueRes.ok) partial.push(overdueRes.note);
  const undeliveredRes = await hostGet(resolved.host, `/api/queue/undelivered?limit=${FLEET_QUEUE_PAGE_LIMIT}&compact=1`, deadlineAt, deps, "undelivered");
  if (!undeliveredRes.ok) partial.push(undeliveredRes.note);

  // 5. The queue transitions. TWO reads of two different places, because the
  //    decided rule counts note-only updates and only one of these carries them:
  //    - `scope=instance` spans every rig in ONE read but keeps only QUALIFYING
  //      state changes, capped by the origin; and
  //    - each open item's own log, which is where a note lives. Bounded.
  const transitionsRes = await hostGet(resolved.host, `/api/queue/recent-transitions?scope=instance&limit=${FLEET_TRANSITION_WINDOW}`, deadlineAt, deps, "transitions");
  const transitions: LocalHostFacts["recentTransitions"] = [];
  if (transitionsRes.ok) {
    for (const t of asArray(transitionsRes.payload)) {
      transitions.push({
        ts: typeof t["ts"] === "string" ? (t["ts"] as string) : null,
        rig: typeof t["rig"] === "string" ? (t["rig"] as string) : null,
        actorSession: typeof t["actorSession"] === "string" ? (t["actorSession"] as string) : null,
      });
    }
  } else {
    partial.push(transitionsRes.note);
  }

  // Chosen by `tsUpdated DESC`, not by list order: `/list` is `ts_created DESC`, so
  // the head of the list is the youngest work, and the items whose notes matter are
  // the long-running ones. Slicing the head would let a team with more open items
  // than the bound be called stalled while its seats were posting notes on schedule.
  const openItemsForTransitions = byNewestUpdated(
    openQueue.map((item) => ({ ...item, tsUpdated: item.tsUpdated } as unknown as Record<string, unknown>)),
  ).map((row) => openQueue.find((i) => i.qitemId === (row as { qitemId: string }).qitemId)!).filter(Boolean);
  const progressReadsTruncated = openQueue.length > FLEET_TRANSITION_ITEM_LIMIT;
  const openItemTransitions: LocalHostFacts["openItemTransitions"] = [];
  // A failed per-item log read is NOT the same as a complete one. If any read in this
  // bounded set failed, the newest note this host can show may be older than the real
  // one, so the verdict must be disclosed as incomplete rather than look settled.
  let progressReadsIncomplete = false;
  // A small cap inside the host's own budget: these reads run after the health, ps,
  // nodes and queue legs, and serially they are the tail most likely to be cut off by
  // the deadline on a slow-but-healthy host.
  // Hoisted so the narrowing that `transport !== "http"` already established above
  // survives into the batch callbacks below.
  const host = resolved.host;
  for (let i = 0; i < openItemsForTransitions.length; i += FLEET_TRANSITION_ITEM_CONCURRENCY) {
    const batch = openItemsForTransitions.slice(i, i + FLEET_TRANSITION_ITEM_CONCURRENCY);
    const results = await Promise.all(batch.map((item) =>
      hostGet(host, `/api/queue/${encodeURIComponent(item.qitemId)}/transitions`, deadlineAt, deps, `transitions for ${item.qitemId}`),
    ));
    results.forEach((perItem, j) => {
      const item = batch[j];
      if (!item) return;
      if (!perItem.ok) {
        partial.push(perItem.note);
        progressReadsIncomplete = true;
        return;
      }
      openItemTransitions.push({
        qitemId: item.qitemId,
        transitions: asArray(perItem.payload).map((t) => ({
          ts: typeof t["ts"] === "string" ? (t["ts"] as string) : null,
          actorSession: typeof t["actorSession"] === "string" ? (t["actorSession"] as string) : null,
        })),
      });
    });
  }

  return {
    status: { hostId, status: "ok" },
    summary: composeHost({
      hostId,
      kind: "remote",
      selfHostId,
      stuckSweep,
      rigReads,
      openQueue,
      overdueCount: overdueRes.ok ? asArray(overdueRes.payload).length : null,
      undeliveredCount: undeliveredRes.ok ? asArray(undeliveredRes.payload).length : null,
      recentTransitions: transitions,
      openItemTransitions,
      progressReadsTruncated,
      progressReadsIncomplete,
      partial,
    }, policy),
    openQueue,
  };
}

/** The shared per-host composition: one code path for the local host and for a
 *  remote one, so a hub and a daemon-with-rigs cannot drift. */
interface HostCompositionInput {
  hostId: string;
  kind: "local" | "remote";
  selfHostId: string | null;
  stuckSweep: FleetStuckSweepHeartbeat | null;
  rigReads: RigRead[];
  openQueue: FleetQueueItem[];
  overdueCount: number | null;
  undeliveredCount: number | null;
  recentTransitions: LocalHostFacts["recentTransitions"];
  openItemTransitions: LocalHostFacts["openItemTransitions"];
  progressReadsTruncated: boolean;
  /** True when a per-item transition read FAILED. Truncation says "the bound was
   *  reached"; this says "part of what we tried to read is missing". Either way the
   *  newest note may be older than the real one, so a verdict must not look settled. */
  progressReadsIncomplete?: boolean;
  partial: string[];
}

function composeHost(input: HostCompositionInput, policy: StallPolicy): FleetHostSummary {
  const allDisplays = input.rigReads.flatMap((r) => r.displays);
  const hostSeatOutput = newestIso(input.rigReads.map((r) => r.seatOutputAt));
  // Progress-eligible queue events, `@system` actors already dropped, from BOTH
  // places a transition is readable on an old image.
  const events = collectProgressEvents({
    recentTransitions: input.recentTransitions,
    openQueue: input.openQueue,
    openItemTransitions: input.openItemTransitions,
  });
  const hostTransition = newestIso(events.map((e) => e.ts));

  const rigs: FleetRigSummary[] = input.rigReads.map((r) => {
    const rigOpen = input.openQueue.filter((i) => i.rigName === r.rigName).length;
    const rigTransition = newestIso(events.filter((e) => e.rig === r.rigName).map((e) => e.ts));
    return {
      rigId: r.rigId,
      rigName: r.rigName,
      hostId: input.hostId,
      seatCount: r.displays.length,
      seatsByActivity: summarizeSeatActivity(r.displays),
      attentionCount: r.attentionCount,
      seatsWithAssignedWork: r.seatsWithAssignedWork,
      lifecycleState: r.lifecycleState,
      runningCount: r.runningCount,
      psStatus: r.psStatus,
      seats: r.seats,
      progress: deriveFleetProgress({
        openWorkCount: rigOpen,
        sources: { lastQueueTransitionAt: rigTransition, lastSeatOutputAt: r.seatOutputAt },
        enabledSources: policy.enabledSources,
        thresholdMinutes: policy.thresholdMinutes,
        nowMs: policy.nowMs,
        progressReadsTruncated: input.progressReadsTruncated || input.progressReadsIncomplete === true,
      }),
    };
  });

  return {
    hostId: input.hostId,
    kind: input.kind,
    selfHostId: input.selfHostId,
    status: { hostId: input.hostId, status: "ok" },
    reachable: true,
    rigCount: rigs.length,
    seatCount: allDisplays.length,
    seatsByActivity: summarizeSeatActivity(allDisplays),
    attentionCount: input.rigReads.reduce((n, r) => n + r.attentionCount, 0),
    openQueueCount: input.openQueue.length,
    openQueueByState: {
      pending: input.openQueue.filter((i) => i.state === "pending").length,
      inProgress: input.openQueue.filter((i) => i.state === "in-progress").length,
      blocked: input.openQueue.filter((i) => i.state === "blocked").length,
    },
    overdueCount: input.overdueCount,
    undeliveredCount: input.undeliveredCount,
    stuckSweep: input.stuckSweep,
    progress: deriveFleetProgress({
      openWorkCount: input.openQueue.length,
      sources: { lastQueueTransitionAt: hostTransition, lastSeatOutputAt: hostSeatOutput },
      enabledSources: policy.enabledSources,
      thresholdMinutes: policy.thresholdMinutes,
      nowMs: policy.nowMs,
      progressReadsTruncated: input.progressReadsTruncated || input.progressReadsIncomplete === true,
    }),
    rigs,
    partialFailures: input.partial,
  };
}

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

/** What ONE fan-out produces: the payload minus the cache fields, which the
 *  cache layer adds. Extending the payload (rather than restating it) is what
 *  keeps the two from drifting. */
export interface FleetFanOutResult extends Omit<FleetSummaryPayload,
  "fromCache" | "cacheAgeMs" | "cacheStaleWhileRevalidate" | "cacheTtlMs"> {}

/** ONE fan-out: local in-process first, then every registered host under its own
 *  deadline. EVERY targeted host appears in `hosts` — ok, unreachable,
 *  auth-failed or unsupported-transport — never all-or-nothing and never a
 *  silently thinner fleet. */
export async function composeFleetSummary(deps: FleetSummaryDeps): Promise<FleetFanOutResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  const threshold = Math.max(1, deps.stallThresholdMinutes ?? FLEET_STALL_THRESHOLD_MINUTES_DEFAULT);
  const hostTimeoutMs = deps.hostTimeoutMs ?? FLEET_HOST_TIMEOUT_MS;
  const concurrency = Math.max(1, deps.concurrency ?? FLEET_FANOUT_CONCURRENCY);
  const enabledSources = deps.progressSources ?? ACTIVE_PROGRESS_SOURCES;
  const policy: StallPolicy = { nowMs, thresholdMinutes: threshold, enabledSources };

  // ---- local leg, in-process (zero self-transport) --------------------------
  const local = deps.readLocalHost();
  const localOpenQueue: FleetQueueItem[] = [];
  for (const raw of local.openQueue) {
    const item = projectFleetQueueItem(raw, LOCAL_HOST_ID);
    if (item) localOpenQueue.push(item);
  }
  const localSummary = composeHost({
    hostId: LOCAL_HOST_ID,
    kind: "local",
    selfHostId: local.selfHostId ?? getSelfHostId(),
    stuckSweep: local.stuckSweep,
    rigReads: local.rigs.map((r) => ({
      rigId: r.rigId,
      rigName: r.rigName,
      attentionCount: r.attentionCount,
      seatsWithAssignedWork: r.seatsWithAssignedWork,
      lifecycleState: r.lifecycleState,
      runningCount: r.runningCount ?? null,
      psStatus: r.psStatus ?? null,
      displays: r.seats.map((s) => s.display),
      seatOutputAt: newestIso(r.seats.map((s) => s.lastActivityAt)),
      seats: r.seats.map((s) => ({
        hostId: LOCAL_HOST_ID,
        rigId: r.rigId,
        rigName: r.rigName,
        logicalId: s.logicalId ?? null,
        canonicalSessionName: s.canonicalSessionName ?? null,
        nodeKind: s.nodeKind ?? null,
        sessionStatus: s.sessionStatus ?? null,
        role: s.role ?? null,
        runtime: s.runtime ?? null,
        activity: s.display,
        needsInputReason: s.needsInputReason ?? null,
        lastActivityAt: s.lastActivityAt,
        lifecycleState: s.lifecycleState ?? null,
        startupStatus: s.startupStatus ?? null,
      })),
    })),
    openQueue: localOpenQueue,
    overdueCount: local.overdueCount,
    undeliveredCount: local.undeliveredCount,
    recentTransitions: local.recentTransitions,
    openItemTransitions: local.openItemTransitions,
    progressReadsTruncated: local.openItemTransitionsTruncated ?? false,
    partial: [],
  }, policy);

  const hosts: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const items: FleetHostSummary[] = [localSummary];
  const openQueue: FleetQueueItem[] = [...localOpenQueue];

  if (!deps.registryExists()) {
    // No registry file = a single-host operator. Nothing changes for them: the
    // payload is the local host alone, with no error and no extra reads.
    return {
      items, hosts, openQueue,
      generatedAt: new Date(nowMs).toISOString(),
      stallThresholdMinutes: threshold,
      enabledProgressSources: [...enabledSources],
      hostTimeoutMs, concurrency,
      targetedHostIds: [LOCAL_HOST_ID],
    };
  }

  const reg = deps.loadRegistry();
  if (!reg.ok) {
    // The registry EXISTS but cannot be read: there is no host list to attribute
    // statuses to, so surface it at the payload level rather than quietly
    // returning a local-only fleet.
    return {
      items, hosts, openQueue,
      generatedAt: new Date(nowMs).toISOString(),
      stallThresholdMinutes: threshold,
      enabledProgressSources: [...enabledSources],
      hostTimeoutMs, concurrency,
      targetedHostIds: [LOCAL_HOST_ID],
      registryError: reg.error,
    };
  }

  const hostIds = reg.registry.hosts.map((h) => h.id);
  const outcomes = new Array<RemoteHostOutcome>(hostIds.length);
  let next = 0;
  const cap = Math.max(1, Math.min(concurrency, Math.max(hostIds.length, 1)));
  const workers = Array.from({ length: cap }, async () => {
    for (;;) {
      const i = next;
      if (i >= hostIds.length) return;
      next += 1;
      outcomes[i] = await readRemoteHost(hostIds[i]!, reg, deps, policy);
    }
  });
  await Promise.all(workers);

  // Registry order preserved (a deterministic payload).
  for (const outcome of outcomes) {
    hosts.push(outcome.status);
    if (outcome.summary) items.push(outcome.summary);
    openQueue.push(...outcome.openQueue);
  }

  return {
    items, hosts, openQueue,
    generatedAt: new Date(nowMs).toISOString(),
    stallThresholdMinutes: threshold,
    enabledProgressSources: [...enabledSources],
    hostTimeoutMs, concurrency,
    targetedHostIds: [LOCAL_HOST_ID, ...hostIds],
  };
}

// ---------------------------------------------------------------------------
// The short cache: one fan-out serves every reader.
// ---------------------------------------------------------------------------

export interface CachedFleetSummary extends FleetSummaryPayload {}

export interface FleetSummaryCache {
  /** Returns a cached payload when one is fresh, otherwise runs (or joins) one
   *  fan-out. Concurrent callers share ONE fan-out.
   *
   *  `thresholdMinutes` is passed IN rather than closed over by the builder, and a
   *  cached payload is served only while the threshold is unchanged: a verdict judged
   *  under the old rule must not be handed out as if the new one had been applied.
   *  A payload that states one threshold while its verdicts used another is worse
   *  than one that states none. */
  read(fresh: boolean, thresholdMinutes: number): Promise<FleetSummaryPayload>;
  /** Test/teardown hook. */
  clear(): void;
}

/** A payload is served from cache while younger than `ttlMs`. A reader that
 *  arrives mid-refresh gets the in-flight promise rather than starting a second
 *  fan-out — that is the whole cost argument for the read. */
export function createFleetSummaryCache(
  build: (thresholdMinutes: number) => Promise<FleetFanOutResult>,
  opts: { ttlMs?: number; nowMs?: () => number } = {},
  deps: { onBackgroundRefreshError?: (err: unknown) => void } = {},
): FleetSummaryCache {
  const ttlMs = opts.ttlMs ?? FLEET_SUMMARY_CACHE_MS;
  const now = opts.nowMs ?? Date.now;
  // How old a payload may get before we stop serving it as stale. Twice the ttl is too
  // tight to be useful across a slow poll; a minute is long enough that one bad read is
  // smoothed over and short enough that a persistently broken fan-out is not dressed up
  // as a healthy fleet indefinitely.
  const staleBoundMs = FLEET_SUMMARY_STALE_BOUND_MS;
  let cached: { payload: FleetSummaryPayload; at: number; thresholdMinutes: number } | null = null;
  // The in-flight fan-out carries the rule it is being judged under, so a reader
  // cannot join a run that is answering a different question than it asked.
  let inflight: { promise: Promise<FleetSummaryPayload>; thresholdMinutes: number } | null = null;

  const run = async (thresholdMinutes: number): Promise<FleetSummaryPayload> => {
    const fanOut = await build(thresholdMinutes);
    const at = now();
    const payload: FleetSummaryPayload = {
      ...fanOut,
      fromCache: false,
      cacheAgeMs: 0,
      cacheStaleWhileRevalidate: false,
      cacheTtlMs: ttlMs,
    };
    // Only a SUCCESS reaches here, so a failed fan-out cannot overwrite a good payload
    // with nothing: the previous answer stays available to serve as stale.
    cached = { payload, at, thresholdMinutes };
    return payload;
  };

  return {
    async read(fresh: boolean, thresholdMinutes: number): Promise<FleetSummaryPayload> {
      const at = now();
      const ruleChanged = cached !== null && cached.thresholdMinutes !== thresholdMinutes;
      const freshEnough = cached !== null && !ruleChanged && at - cached.at < ttlMs;
      if (!fresh && freshEnough) {
        return { ...cached!.payload, fromCache: true, cacheAgeMs: at - cached!.at, cacheStaleWhileRevalidate: false };
      }

      // Stale-while-revalidate. Once ANY payload exists, a reader that did not ask
      // for `fresh` gets it immediately — with its true age and the flag set — while
      // one refresh runs behind it. Without this, every poll that outlasts the cache
      // waits for the whole fan-out, and a reader with a fixed timeout gives up and
      // loses its remote sections for that poll: the flicker this exists to remove.
      // Cold start still waits, because there is nothing honest to serve.
      //
      // A CHANGED RULE is not eligible. Serving verdicts judged under a different
      // threshold while claiming the new one is the exact misreport this whole
      // threshold-keying exists to prevent, so that reader waits for the real run.
      //
      // Neither is a payload past the staleness bound. Serving an arbitrarily old
      // answer forever would turn a persistently broken fan-out (a local leg throwing
      // on a DB error, say) into a page that looks healthy while quietly showing
      // minutes-old truth. Past the bound, readers wait for the real run and meet its
      // failure, which is the honest outcome.
      const tooStale = cached !== null && at - cached.at > staleBoundMs;
      if (!fresh && cached !== null && !ruleChanged && !tooStale) {
        const stale = { ...cached.payload, fromCache: true, cacheAgeMs: at - cached.at, cacheStaleWhileRevalidate: true };
        if (!inflight || inflight.thresholdMinutes !== thresholdMinutes) {
          const mine = run(thresholdMinutes).finally(() => {
            // Only release the slot if it still holds THIS run; a parallel run that
            // finished first must not null a slot a later reader is still waiting on.
            if (inflight && inflight.promise === mine) inflight = null;
          });
          // Nobody awaits a background refresh — that is the point of serving the stale
          // payload instead — so a failing fan-out would surface as an unhandled
          // rejection in the daemon. Swallow it HERE, on the detached handle only: a
          // reader that joins this run below still gets the rejection through
          // `inflight.promise`, and the next read retries.
          //
          // Swallowed is not the same as silent. A refresh that keeps failing means the
          // page is being served an increasingly stale answer, and a daemon that says
          // nothing about that is hiding the one fact an operator would act on.
          mine.catch((err: unknown) => {
            deps.onBackgroundRefreshError?.(err);
          });
          inflight = { promise: mine, thresholdMinutes };
        }
        return stale;
      }

      if (inflight && inflight.thresholdMinutes === thresholdMinutes) {
        // Another reader is already fanning out under the same rule. Join it.
        return inflight.promise;
      }
      const mine = run(thresholdMinutes).finally(() => {
        if (inflight && inflight.promise === mine) inflight = null;
      });
      inflight = { promise: mine, thresholdMinutes };
      return mine;
    },
    clear() {
      cached = null;
      inflight = null;
    },
  };
}
