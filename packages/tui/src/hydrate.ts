import { composeHumanUpdates, type DeliveredHumanUpdates } from "./attention/attention-model.js";
import { attentionAggregateReaderTimeoutMs, fleetSummaryReaderTimeoutMs } from "@openrig/daemon/fleet";
import { readTerminals } from "./terminals/terminal-model.js";
import { fileTargetForPath } from "./reading.js";
// Snapshot hydrator: maps the §4.A daemon reads (via DaemonClient, the one
// HTTP module) into FleetSnapshot for the renderer. Mapping discipline
// (PIN 2/PIN 3, planner Phase-2 reminders):
//   - STATUS and Needs-You content are carried VERBATIM from the served
//     projections — no synthesis, no staleness "improvement", no client-side
//     thresholds. The idle-with-work threshold reaches us already serialized
//     inside the served evidence/threshold strings, so this module needs no
//     threshold constant at all (nothing is recomputed — the honest form of
//     "don't re-hardcode IDLE_WITH_WORK_THRESHOLD_MIN").
//   - The two `stuck` legs (idle-with-work vs too-long-in-state) stay distinct
//     by construction: identity/summary/evidence/threshold render verbatim.
//   - host/rig-down composes BESIDE the items (hostsDown), never into them.
//   - A failed read leaves its portion honest-empty and records a NAMED error.
import { emptySnapshot } from "./state.js";
import type { ConfigRead } from "./config/config-model.js";
import type { ConnectionsRead, ControlPlaneRead, SlackManifestRead } from "./connections/connections-model.js";
import type { UsageRead } from "./usage/usage-model.js";
import { DaemonClient } from "./daemon-client.js";
import { parse as parseYaml } from "yaml";
import type { AgentRow, FleetSnapshot, FleetSummaryRead, FleetUsageRead, HealthCoverage, HealthRecord, HostNode, NeedsItem, PodNode, QueueRead, RecentTransitionSnap, RigNode, SeatActivitySummary, SeatEffortRead, SliceDetailSnap, SpecEntry, ViewState } from "./types.js";
import { LOCAL_HOST_ID_SENTINEL, RIG_DOWN_ID_PREFIX, remoteSeatAddress, FLEET_USAGE_TOP_ROWS } from "./types.js";
import { isHumanSeatSession } from "./pulse/pulse-model.js";

// Narrow read-shapes: just the served fields this module consumes (names match
// the daemon's serialized output — see the Phase-2 endpoint-shape survey).
interface RigSummaryRead {
  id: string;
  name: string;
  lifecycleState?: string;
  hasLiveAgents?: boolean | null;
}
interface RigStatusRead {
  status?: string;
  seatsTotal?: number;
  seatsRunning?: number;
}
interface InstanceHealthRead extends ControlPlaneRead {
  selfHostId?: string | null;
}
interface HealthProjectionRead {
  schema: "openrig.health-list/v0alpha1";
  evaluatedAt: string | null;
  total: number;
  limit: number;
  truncated: boolean;
  records: HealthRecord[];
  coverage?: HealthCoverage[];
}
interface NodeInventoryRead {
  needsAttention?: boolean;
  arbitratedNeedsInput?: boolean | null;
  needsInputEvidence?: { rung: string; observedAt: string } | null;

  nodeId?: string;
  logicalId: string;
  podNamespace?: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  model?: string | null;
  /** Configured launch effort and its provenance, served by the node inventory. */
  effort?: string | null;
  effortSource?: "seat_choice" | "authored" | "runtime_default" | null;
  lifecycleState: string;
  sessionStatus?: string | null;
  startupStatus?: string | null;
  terminalActive?: boolean | null;
  /** arch 3a947fb1: raw window_activity ISO (owner idle-age is derived at the
   * renderer). Absent/null when the seat has no observation. */
  lastActivityAt?: string | null;
  agentActivity?: {
    state?: string;
    reason?: string | null;
    evidenceSource?: string | null;
    eventAt?: string | null;
  } | null;
  /** S19 — the served taxonomy state; display comes from the daemon's one bridge. */
  activityState?: {
    activity?: string | null;
    display?: string;
    needsInput?: { count?: number; reason?: string | null } | null;
    decidedBy?: string | null;
  } | null;
  identityVerdict?: { verdict?: string; reason?: string | null } | null;
  /** Present only on a community harness's seat. */
  communityHarness?: { harness: string } | null;
  canonicalSessionName: string | null;
  tmuxAttachCommand?: string | null;
  cwd?: string | null;
  resolvedSpecName: string | null;
  profile?: string | null;
  resolvedSpecVersion?: string | null;
  resolvedSpecHash?: string | null;
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    contextWindowSize: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  };
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
}
interface SpecLibraryRead {
  id: string;
  kind: "rig" | "agent" | "workflow";
  name: string;
  version?: string;
  sourcePath?: string;
  resolvedSourcePath?: string | null;
  sourceType?: "builtin" | "user_file";
  relativePath?: string;
  updatedAt?: string;
  /** workflow entries only (served on the list read) */
  rolesCount?: number;
  stepsCount?: number;
  status?: string;
}
interface AgentSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "agent";
  description?: string;
  profiles?: Array<{ name: string }>;
  resources?: { skills?: string[]; guidance?: string[]; plugins?: string[]; subagents?: string[] };
  startup?: { files?: Array<{ path: string; required: boolean }> };
  raw?: string;
}
interface RigSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "rig";
  format?: "pod_aware" | "legacy";
  pods?: Array<{
    id: string;
    namespace?: string;
    label?: string;
    members: Array<{ id: string; agentRef: string; runtime: string; profile?: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  }>;
  nodes?: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  edges?: Array<{ from: string; to: string; kind: string }>;
  graph?: {
    nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
    edges: Array<{ source: string; target: string; kind: string }>;
  };
  raw?: string;
}
type SpecLibraryReviewRead = AgentSpecReviewRead | RigSpecReviewRead;
interface RigSpecJsonRead {
  name?: string;
  pods?: Array<{ members?: Array<{ agentRef?: string }> }>;
}
interface NeedsYouItemRead {
  hostId?: string;
  source: "agent" | "derived";
  identity: string;
  summary: string;
  leg: string;
  where: string;
  ageIso?: string | null;
  destinationSession: string | null;
  derived: { kind: string; evidence: string; threshold: string } | null;
  qitemId: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
}
interface ReviewFleetRead {
  needsYou?: { items?: NeedsYouItemRead[] };
  hosts?: Array<{ hostId: string; status: { status: string } }>;
  registryError?: string | null;
}
interface AttentionAggregateRead {
  hosts?: Array<{ hostId: string; status: string; error?: string }>;
  /** The fan-out's queue rows, each stamped with its `hostId`. The TUI consumed
   * `hosts` long before these; `toFleetQueueRead` is the items leg. */
  items?: unknown[];
}
interface StreamItemRead {
  tsEmitted: string;
  sourceSession: string;
  body: string;
  streamSortKey: string;
}
// The served queue-item fields the PULSE joins consume (camelCase QueueItem,
// queue-repository.ts). Both reads return this shape; the TUI maps + presents.
interface QueueItemRead {
  sourceSession?: string | null;
  qitemId: string;
  state: string;
  destinationSession: string;
  blockedOn: string | null;
  handedOffTo: string | null;
  tier: string | null;
  tags: string[] | null;
  summary: string | null;
  body?: string;
  claimedAt: string | null;
  tsUpdated: string;
}

function toQueueRead(item: QueueItemRead): QueueRead {
  return {
    qitemId: item.qitemId,
    sourceSession: item.sourceSession,
    state: item.state,
    destinationSession: item.destinationSession,
    blockedOn: item.blockedOn,
    handedOffTo: item.handedOffTo,
    tier: item.tier,
    tags: item.tags,
    summary: item.summary,
    body: item.body ?? "",
    claimedAt: item.claimedAt,
    tsUpdated: item.tsUpdated,
  };
}

/** The fan-out contract's local sentinel lives in types.ts as ONE constant; this is
 * the only place the TUI needs it, and it is what makes "no local row appears twice"
 * structural rather than a filter each call-site has to remember. */

/** One attention-aggregate item → a PULSE `QueueRead`, REMOTE rows only.
 *
 * The item is another daemon's own attention-list row carried verbatim through the
 * fan-out with `hostId` stamped on, so it crosses a wire and a version boundary: the fields the joins actually read are CHECKED, and a row that fails is
 * DROPPED rather than rendered as a blank line. Rows stamped `local` are dropped
 * here, which is what makes "no local row appears twice" structural rather than a
 * filter each call-site has to remember. */
function toFleetQueueRead(raw: unknown): QueueRead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Partial<QueueItemRead> & { hostId?: unknown };
  if (typeof item.qitemId !== "string" || item.qitemId === "") return null;
  if (typeof item.state !== "string" || typeof item.destinationSession !== "string") return null;
  const hostId = typeof item.hostId === "string" ? item.hostId : "";
  if (hostId === "" || hostId === LOCAL_HOST_ID_SENTINEL) return null;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    qitemId: item.qitemId,
    sourceSession: text(item.sourceSession),
    state: item.state,
    destinationSession: item.destinationSession,
    blockedOn: text(item.blockedOn),
    handedOffTo: text(item.handedOffTo),
    tier: text(item.tier),
    tags: Array.isArray(item.tags) ? (item.tags.filter((t): t is string => typeof t === "string")) : null,
    summary: text(item.summary),
    body: typeof item.body === "string" ? item.body : "",
    claimedAt: text(item.claimedAt),
    tsUpdated: typeof item.tsUpdated === "string" ? item.tsUpdated : "",
    hostId,
  };
}

function fmtTokens(input: number | null, output: number | null): string | null {
  if (input == null && output == null) return null;
  const total = (input ?? 0) + (output ?? 0);
  return total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);
}

function toAgentRow(node: NodeInventoryRead): AgentRow {
  const ctx = node.contextUsage;
  const known = ctx?.availability === "known";
  const identityDownranked = node.identityVerdict?.verdict === "mismatch"
    || (node.identityVerdict?.verdict === "pane_missing" && node.identityVerdict?.reason !== "session_missing");
  return {
    needsAttention: node.needsAttention ?? null,
    arbitratedNeedsInput: node.arbitratedNeedsInput ?? null,
    needsInputEvidence: node.needsInputEvidence ?? null,
    nodeId: node.nodeId,
    name: node.logicalId,
    runtime: node.runtime ?? "unknown",
    model: node.model ?? null,
    effort: node.effort ?? null,
    effortSource: node.effortSource ?? null,
    spec: node.resolvedSpecName ?? "",
    profile: node.profile ?? null,
    specVersion: node.resolvedSpecVersion ?? null,
    specHash: node.resolvedSpecHash ?? null,
    // honest-unknown: no value in the projection → null → renders "—"
    context: known && ctx.usedPercentage != null ? Math.round(ctx.usedPercentage) : null,
    tokens: known ? fmtTokens(ctx.totalInputTokens, ctx.totalOutputTokens) : null,
    contextWindowSize: known ? ctx.contextWindowSize : null,
    totalInputTokens: known ? ctx.totalInputTokens : null,
    totalOutputTokens: known ? ctx.totalOutputTokens : null,
    hasAssignedWork: node.hasAssignedWork,
    assignedWorkCount: node.assignedWorkCount,
    pendingWorkCount: node.pendingWorkCount,
    inProgressWorkCount: node.inProgressWorkCount,
    blockedWorkCount: node.blockedWorkCount,
    activity: {
      activity: node.activityState?.activity ?? node.activityState?.display ?? node.agentActivity?.state ?? null,
      needsInput: node.activityState?.needsInput
        ? { count: node.activityState.needsInput.count ?? 0, reason: node.activityState.needsInput.reason ?? null }
        : null,
      decidedBy: node.activityState?.decidedBy ?? null,
      signalReason: node.agentActivity?.reason ?? null,
      signalState: node.agentActivity?.state ?? null,
      signalSource: node.agentActivity?.evidenceSource ?? null,
      eventAt: node.agentActivity?.eventAt ?? null,
    },
    // Mirror the maintained web projection: lifecycle truth drives actions,
    // while session/terminal activity drives the visible status label.
    status: node.identityVerdict?.reason === "session_missing" && node.sessionStatus === "detached" && node.lifecycleState !== "attention_required"
      ? "detached"
      : node.startupStatus === "failed"
        ? "failed"
      : identityDownranked || (node.needsAttention == null
        && (node.lifecycleState === "attention_required" || node.startupStatus === "attention_required"))
        ? "attention_required"
      : node.needsAttention === true
        ? ((node.arbitratedNeedsInput ?? node.agentActivity?.state === "needs_input") ? "needs_input" : "attention_required")
      : node.needsAttention == null && (node.activityState?.display === "needs-input" || node.agentActivity?.state === "needs_input")
        ? "needs_input"
        : node.sessionStatus === "running" || node.sessionStatus === "ready"
          ? (node.activityState?.display === "working"
            ? "active"
            : node.activityState?.display === "idle"
              ? "idle"
              : (node.terminalActive === true || (node.terminalActive == null && node.agentActivity?.state === "running") ? "active"
                // A community harness gives no idle signal: a quiet screen is unknown, not idle.
                : node.communityHarness ? "unknown" : "idle"))
          : (node.sessionStatus ?? "unknown"),
    live: node.lifecycleState === "running",
    canRun: node.lifecycleState !== "running"
      && node.sessionStatus !== "running"
      && node.sessionStatus !== "ready"
      && node.terminalActive !== true,
    session: node.canonicalSessionName,
    attach: node.tmuxAttachCommand ?? null,
    cwd: node.cwd ?? null,
    // S19 round-5: served terminalActive VERBATIM — the pane-output substrate
    // (tmux window_activity within the silence window); null = no signal
    paneActive: node.terminalActive ?? null,
  };
}

function groupPods(nodes: NodeInventoryRead[]): PodNode[] {
  const pods = new Map<string, AgentRow[]>();
  for (const node of nodes) {
    if (node.nodeKind !== "agent") continue;
    const pod = node.podNamespace ?? "(no pod)";
    const list = pods.get(pod) ?? [];
    list.push(toAgentRow(node));
    pods.set(pod, list);
  }
  return [...pods.entries()].map(([name, agents]) => ({ name, agents }));
}

function toNeedsItem(item: NeedsYouItemRead): NeedsItem {
  // verbatim carry: served kind + summary/evidence; the target is the
  // session/where the daemon already names (identity prefix for derived rows)
  const target = item.source === "derived" ? (item.identity.split("|")[0] ?? item.where) : (item.destinationSession ?? item.where);
  const detail = item.derived ? `${item.summary} — ${item.derived.evidence}` : item.summary;
  return {
    source: item.source,
    kind: item.derived?.kind ?? item.leg,
    target,
    detail,
    qitemId: item.qitemId,
    evidenceRef: item.evidenceRef,
    unblocks: item.unblocks,
    ageIso: item.ageIso ?? null,
    ...(item.hostId ? { hostId: item.hostId } : {}),
  };
}

function resolveAgentRef(ref: string, agentSpecNames: Set<string>): string {
  if (agentSpecNames.has(ref)) return ref;
  const basename = ref.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.(?:ya?ml|json)$/, "");
  return basename && agentSpecNames.has(basename) ? basename : ref;
}

function agentNamespace(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  const agentsAt = dirs.lastIndexOf("agents");
  const candidates = agentsAt >= 0 ? dirs.slice(agentsAt + 1) : dirs;
  if (parts.at(-1) === "agent.yaml" || parts.at(-1) === "agent.yml") candidates.pop();
  return candidates.length > 0 ? candidates.join("/") : undefined;
}

function agentSpecTruth(raw?: string): { runtime?: string; skills: string[] } {
  if (!raw) return { skills: [] };
  try {
    const spec = parseYaml(raw) as Record<string, unknown> | null;
    if (!spec || typeof spec !== "object") return { skills: [] };
    const defaults = spec["defaults"] as Record<string, unknown> | undefined;
    const profiles = spec["profiles"] as Record<string, unknown> | undefined;
    const profile = (profiles?.["default"] ?? Object.values(profiles ?? {})[0]) as Record<string, unknown> | undefined;
    const uses = profile?.["uses"] as Record<string, unknown> | undefined;
    const skills = Array.isArray(uses?.["skills"])
      ? uses["skills"].filter((skill): skill is string => typeof skill === "string")
      : [];
    return {
      ...(typeof defaults?.["runtime"] === "string" ? { runtime: defaults["runtime"] } : {}),
      skills,
    };
  } catch {
    return { skills: [] };
  }
}

/** Cross-cycle memo for spec-detail reviews, keyed by `${id}@${updatedAt}` —
 * avoids re-reading every spec every refresh; the key rolls when the library
 * entry's updatedAt changes. Owned by the caller (instance-scoped, no module state). */
export type SpecReviewCache = Map<string, SpecLibraryReviewRead>;
export type HydrateViewContext = Pick<ViewState, "project" | "section" | "viewTab" | "drill" | "file" | "externalUrl" | "terminalView" | "attentionOpen" | "pendingDrill" | "expanded">;

/** What the fleet read remembers between polls, OWNED BY THE CALLER like
 *  `reviewCache` — this file's convention is no module state, and module state here
 *  would also leak across test cases and across clients in one process.
 *
 *  Two jobs, both about a TUI that polls:
 *  - the last good payload, so one failed read does not blank STALLED and every remote
 *    row for a frame and restore them on the next. Serving the previous answer is
 *    honest only because the failure is NAMED in readErrors.
 *  - the shape of the last answer, so the reader's next wait is derived from the
 *    operator's REAL budget rather than the compiled defaults. `targetedHostIds`
 *    counts unreachable hosts too; `items` does not, so the wait would shrink exactly
 *    when hosts are timing out. */
export interface FleetReadRetention {
  last: FleetSummaryRead | null;
  /** The usage read's own last good payload. Kept BESIDE `last` rather than inside it:
   *  the two routes fail independently, and blanking one with the other's failure would
   *  invent a fleet change that is only a read failure. */
  lastUsage: FleetUsageRead | null;
}

/** The reader's wait for the next poll, from the last answer's own numbers. Cold start
 *  has nothing to go on and uses the shared defaults, which is what the route would have
 *  used had the operator configured nothing.
 *
 *  Typed on the three fields BOTH hub fan-outs echo rather than on one payload type, so
 *  the summary and the usage read size their wait by the same rule and cannot drift into
 *  waiting two different amounts for one fleet. */
export function fleetReaderTimeoutFor(last: { targetedHostIds?: string[]; hostTimeoutMs?: number; concurrency?: number } | null): number {
  if (!last) return fleetSummaryReaderTimeoutMs(1);
  const hosts = last.targetedHostIds?.length || 1;
  return fleetSummaryReaderTimeoutMs(hosts, last.hostTimeoutMs, last.concurrency);
}

/** Does this fleet have a REMOTE host at all? The usage read is asked only when it
 *  does: an operator with one machine has nothing to add up, and nothing changes for a
 *  single-machine operator — not even a fan-out's cost behind the change.
 *
 *  Sized from `targetedHostIds` rather than `items`, for the reason the summary's own
 *  comment gives: `items` only carries hosts that ANSWERED, so a fleet whose one remote
 *  host is timing out would look local exactly when the operator most needs the read.
 *  A payload with no `targetedHostIds` is an older daemon's, and an older daemon has no
 *  usage route to ask either, so "no remote hosts" is the honest answer, not a guess. */
export function fleetHasRemoteHost(summary: FleetSummaryRead | null): boolean {
  if (!summary) return false;
  return (summary.targetedHostIds ?? []).some((id) => id !== LOCAL_HOST_ID_SENTINEL);
}

async function readFleetUsage(
  client: DaemonClient,
  summary: FleetSummaryRead | null,
  retention: FleetReadRetention | undefined,
): Promise<{ payload: FleetUsageRead | null; failed: string | null }> {
  if (!fleetHasRemoteHost(summary)) {
    // Drop the retained payload, do not merely stop reading. A fleet whose remotes were
    // removed from the registry would otherwise hold its last answer indefinitely, and if
    // a host were added back later and its first read failed, retention would serve that
    // arbitrarily old payload as "the last successful read" — a stale fleet presented as
    // a live one, which is the one thing this block must never do.
    if (retention) retention.lastUsage = null;
    return { payload: null, failed: null };
  }
  const last = retention?.lastUsage ?? null;
  try {
    // window_hours=1: the question this block answers is "which team is burning fastest
    // RIGHT NOW". A wider window averages a finished burst into everything after it.
    const payload = (await client.fleetUsage({
      windowHours: 1,
      top: FLEET_USAGE_TOP_ROWS,
      optional: true,
      timeoutMs: fleetReaderTimeoutFor(last),
    })) as FleetUsageRead;
    if (retention) retention.lastUsage = payload;
    return { payload, failed: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fleetReadOutcome(message, last, "fleet-usage");
  }
}

async function readFleetSummary(
  client: DaemonClient,
  retention: FleetReadRetention | undefined,
): Promise<{ payload: FleetSummaryRead | null; failed: string | null }> {
  const last = retention?.last ?? null;
  try {
    const payload = (await client.fleetSummary({
      optional: true,
      timeoutMs: fleetReaderTimeoutFor(last),
    })) as FleetSummaryRead;
    if (retention) retention.last = payload;
    return { payload, failed: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fleetReadOutcome(message, last);
  }
}

/** What a failed fleet read means. Three outcomes, and the difference between them is
 *  the difference between an honest page and a confusing one:
 *
 *  - a 404 is an ABSENT FEATURE. Nothing is served and nothing is named: an operator on
 *    an older daemon has no expectation to fail, and a status-line error every poll
 *    would report a problem that does not exist.
 *  - a real failure WITH a previous good read keeps that payload and says it is stale.
 *    A poll that times out must not blank STALLED and the remote rows for one frame.
 *  - a real failure with NOTHING previous reports the failure and serves nothing,
 *    because there is no last known state to show.
 */
export function fleetReadOutcome(
  message: string,
  lastGood: FleetSummaryRead | null,
  label?: string,
): { payload: FleetSummaryRead | null; failed: string | null };
export function fleetReadOutcome(
  message: string,
  lastGood: FleetUsageRead | null,
  label: string,
): { payload: FleetUsageRead | null; failed: string | null };
export function fleetReadOutcome<T extends FleetSummaryRead | FleetUsageRead>(
  message: string,
  lastGood: T | null,
  label = "fleet-summary",
): { payload: T | null; failed: string | null } {
  if (/→ 404/.test(message)) return { payload: null, failed: null };
  return {
    payload: lastGood,
    failed: lastGood
      ? `${label}: ${message}; showing the last successful read`
      : `${label}: ${message}`,
  };
}

export async function hydrateSnapshot(
  client: DaemonClient,
  reviewCache?: SpecReviewCache,
  executionMission?: string | null,
  sliceDetailName?: string | null,
  currentRigName?: string | null,
  viewContext?: HydrateViewContext,
  // Appended rather than slotted in beside `reviewCache`: 94 call sites pass these
  // positionally, and a mid-list insertion would silently re-point every one of them.
  // Still caller-owned, which is the part that matters — no module state.
  fleetRetention?: FleetReadRetention,
): Promise<FleetSnapshot> {
  const readErrors: string[] = [];
  async function safe<T>(label: string, fn: () => Promise<unknown>): Promise<T | null> {
    try {
      return (await fn()) as T;
    } catch (err) {
      readErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

/** Like safe(), for an ADDITIVE read whose absence is an expected state rather
   * than a hydration failure — an older daemon that has no such route, a read the
   * page uses only to enrich what already rendered. A miss leaves the page exactly
   * as it was, so naming it in the status line would report a problem that is not
   * one. A load-bearing read must use safe(), never this. */
  async function optional<T>(fn: () => Promise<unknown>): Promise<T | null> {
    try {
      return (await fn()) as T;
    } catch {
      return null;
    }
  }

  if (viewContext?.file) {
    const target = viewContext.file;
    const [result, roots] = await Promise.all([client.readFile(target), safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("file-roots", () => client.fileRoots())]);
    if (!("error" in result) && !result.resolvedPath) {
      const canonical = fileTargetForPath(result.absolutePath, roots?.roots ?? []);
      if (canonical?.root === target.root) result.resolvedPath = canonical.path;
    }
    return { ...emptySnapshot(), fileRead: { target, result, readAt: new Date().toISOString() }, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }
  if (viewContext?.externalUrl) return { ...emptySnapshot(), hydratedAt: new Date().toISOString() };

  if (viewContext?.section === "needs") {
    const [attention, updates, roots] = await Promise.all([
      safe<NonNullable<FleetSnapshot["attentionRead"]>>("Feed", () => client.humanAttention(viewContext.attentionOpen)),
      safe<DeliveredHumanUpdates>("delivered updates", () => client.humanUpdates()),
      safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("file-roots", () => client.fileRoots()),
    ]);
    const attentionRead = composeHumanUpdates(attention, updates, viewContext.attentionOpen);
    return { ...emptySnapshot(), attentionRead, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }

  if (viewContext?.section === "system") {
    const health = await safe<HealthProjectionRead>("health-findings", () => client.healthFindings());
    return { ...emptySnapshot(), ...(health ? { health: { ...health, availability: "loaded" as const } } : {}), readErrors, hydratedAt: new Date().toISOString() };
  }

  // Project reads never fall back to the daemon's default workspace or fleet queue.
  if (viewContext?.section === "scopes") {
    const projects = await safe<NonNullable<FleetSnapshot["projects"]>>("projects", () => client.projects());
    const selected = viewContext.project;
    const project = selected && projects?.projects.find(p => p.id === selected.id && p.root === selected.root);
    if (selected && (!project || project.error)) readErrors.push(`project ${selected.id}: ${project?.error ?? "selection changed or unavailable; choose the project again"}`);
    const readable = !!project && !project.error;
    const scopes = readable ? await safe<{ missions: FleetSnapshot["scopes"]; sources?: Record<string, string>; readErrors?: string[] }>("scopes", () => client.scopesDetailed(selected)) : null;
    const mission = scopes?.missions?.find(m => m.mission === executionMission);
    const slice = mission?.slices.find(s => s.dirName === sliceDetailName);
    const [execution, detail, roots] = await Promise.all([
      readable && executionMission && !mission?.error ? safe<{ rows: NonNullable<FleetSnapshot["execution"]>[] }>("execution", () => client.execution(executionMission, selected)) : null,
      readable && executionMission && sliceDetailName && !mission?.error && !slice?.error ? safe<SliceDetailSnap>("slice-detail", () => client.sliceDetail(sliceDetailName, executionMission, selected)) : null,
      safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("file-roots", () => client.fileRoots()),
    ]);
    readErrors.push(...(scopes?.readErrors ?? []));
    return { ...emptySnapshot(), projects, projectRead: selected, projectSources: scopes?.sources, scopes: scopes?.missions ?? [], execution: execution?.rows[0] ?? null, executionMission, sliceDetail: detail, sliceDetailName, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }

  if (viewContext?.section === "terminals") {
    const terminals = await readTerminals(client, viewContext.terminalView);
    return { ...emptySnapshot(), terminals, hydratedAt: new Date().toISOString(), readErrors: terminals.error ? [terminals.error] : [] };
  }

  // USAGE ACROSS HOSTS: one GET of the daemon's view across registered hosts, answered from memory there and on every
  // host. Never the refresh route.
  if (viewContext?.section === "usage-hosts") {
    const status = await client.usageAcrossHosts();
    if (!("view" in status)) readErrors.push(`usage across hosts: ${status.error}`);
    return { ...emptySnapshot(), usageHosts: { status }, readErrors, hydratedAt: new Date().toISOString() };
  }

  // COST: one GET of the daemon's cost view, computed from what it already stores. Starts no lookup of any kind.
  if (viewContext?.section === "cost") {
    const status = await client.usageCost();
    if (!("body" in status)) readErrors.push(`cost: ${status.error}`);
    return { ...emptySnapshot(), cost: { status }, readErrors, hydratedAt: new Date().toISOString() };
  }

  // USAGE: one GET of the provider read model, answered from the daemon's memory. Never the refresh route. Only
  // when the model has no usage rows does it read the config browser, to tell "off" from "not served".
  if (viewContext?.section === "usage") {
    const status = await client.providerStatus();
    if (!("model" in status)) readErrors.push(`provider status: ${status.error}`);
    let switchSetting: UsageRead["switchSetting"];
    if ("model" in status && !Array.isArray(status.model["usage"])) {
      const config = await safe<ConfigRead>("CONFIG", () => client.configBrowser());
      const entry = config?.entries.find((e) => e.key === "provider.usage_windows");
      switchSetting = config ? (entry ? { value: entry.value, source: entry.source } : "absent") : null;
    }
    return { ...emptySnapshot(), usage: { status, ...(switchSetting !== undefined ? { switchSetting } : {}) }, readErrors, hydratedAt: new Date().toISOString() };
  }

  // CONFIG never invokes fleet aggregation, host probes, queue enrichment or provider checks.
  // Failures replace earlier values with an explicit unavailable state.
  if (viewContext?.section === "config") {
    let configError: string | undefined;
    const passive = async <T>(label: string, read: () => Promise<unknown>): Promise<T | null> => {
      try { return await read() as T; } catch { readErrors.push(`${label}: unavailable`); return null; }
    };
    const [config, controlPlane, connections] = await Promise.all([
      passive<ConfigRead>("CONFIG", () => client.configBrowser().catch(error => {
        configError = error instanceof Error ? error.message : "Read failed; cause not identified.";
        throw error;
      })),
      passive<ControlPlaneRead>("control plane", () => client.health()),
      passive<ConnectionsRead>("Slack observation", () => client.connections()),
    ]);
    let daemonTarget = "unreported";
    try { daemonTarget = new URL(client.baseUrl).origin; } catch { /* no raw invalid target */ }
    return { ...emptySnapshot(), config, configError, controlPlane, connections, daemonTarget, hydratedAt: new Date().toISOString(), readErrors };
  }

  const readingOnly = viewContext?.section === "specs";
  const fileRoots = readingOnly ? await safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("file-roots", () => client.fileRoots()) : null;
  const topologyLeaf = viewContext?.section === "topology" ? viewContext.drill.at(-1) : undefined;
  const wantsConnections = viewContext?.section === "connections";
  const wantsSpecs = !viewContext || viewContext.section === "specs" || topologyLeaf?.kind === "agent";
  const wantsTopologyScope = !viewContext || viewContext.section === "topology";
  const wantsRecent = wantsTopologyScope && (!topologyLeaf || topologyLeaf.kind === "host" || topologyLeaf.kind === "rig");
  const focusedTopology = !!viewContext && wantsTopologyScope && viewContext.viewTab !== "pulse";
  const broadReads = !readingOnly && !focusedTopology && !wantsConnections;
  // The fleet usage block is drawn on the hub's OWN instance page, which is a drilled
  // topology leaf — and a drilled leaf is exactly what `focusedTopology` switches off.
  // Gated on `broadReads` alone, the read fired only while PULSE was showing, a page that
  // renders none of it, so the block could never appear. Gate the fan-outs on the page
  // that draws them as well as on the broad view. A remote host's own page is included:
  // the fan-out is the hub's, cached, and the render still refuses the block there.
  const hostInstancePage = wantsTopologyScope && topologyLeaf?.kind === "host"
    && viewContext?.viewTab !== "pulse";
  const wantsFleetReads = broadReads || hostInstancePage;
  // Seat rows (Q / WORK / NOW) join these four lists: only a seat's page and the drilled table tab show them.
  const seatQueueReads = broadReads || (focusedTopology && (topologyLeaf?.kind === "agent" || (!!topologyLeaf && viewContext?.viewTab === "table")));
  // render.ts draws healthSummaryLine on the instance Table and on the rig/pod Table and Overview; those focused pages must load health too.
  const rendersHealthSummary = (topologyLeaf?.kind === "host" && viewContext?.viewTab === "table")
    || ((topologyLeaf?.kind === "rig" || topologyLeaf?.kind === "pod") && (viewContext?.viewTab === "table" || viewContext?.viewTab === "overview"));
  const healthRequested = broadReads || viewContext?.viewTab === "health" || rendersHealthSummary;
  const wantsGraph = wantsTopologyScope && (!viewContext || viewContext.viewTab === "graph");
  // A pending pod/agent address needs every rig's seats to resolve.
  const pendingInventory = viewContext?.pendingDrill?.resource === "pod" || viewContext?.pendingDrill?.resource === "agent";
  // Agent detail: read the existing seat-effort report once per refresh. It reads
  // the running process and native transcript, never launches or restarts anything.
  const drillRig = [...(viewContext?.drill ?? [])].reverse().find((segment) => segment.kind === "rig")?.name
    ?? currentRigName
    ?? null;
  // A seat on another host has no effort report here: this daemon would answer for a seat it does
  // not run. The drilled host is remote when the last fleet read targeted it.
  const drillHostName = viewContext?.drill.find((segment) => segment.kind === "host")?.name;
  const drillsRemoteHost = !!drillHostName && drillHostName !== LOCAL_HOST_ID_SENTINEL
    && (fleetRetention?.last?.targetedHostIds ?? []).includes(drillHostName);
  const seatEffortRef = topologyLeaf?.kind === "agent" && drillRig && !drillsRemoteHost ? `${topologyLeaf.name}@${drillRig}` : null;

  // The two hub-side fan-outs, CHAINED rather than parallel. The summary is what names
  // the fleet's hosts, and the usage read must not be asked of a fleet that has no remote
  // host to add up. Chaining costs one fan-out's latency on the slow path and buys that
  // gate with no extra registry read; both legs hit the daemon's own short cache, so a
  // steady-state poll pays it twice only when the fleet is actually being fanned out.
  const fleetReads: Promise<{ summary: { payload: FleetSummaryRead | null; failed: string | null } | null; usage: { payload: FleetUsageRead | null; failed: string | null } | null }> =
    !wantsFleetReads
      ? Promise.resolve({ summary: null, usage: null })
      : readFleetSummary(client, fleetRetention).then(async (summary) => ({
          summary,
          usage: await readFleetUsage(client, summary.payload, fleetRetention),
        }));

  // The aggregate is a fan-out too: its wait follows the hosts the last fleet read named, so a
  // team that takes its whole budget comes back marked unreachable instead of taking every
  // other host down with it. Cold start has no count yet and gets the rule's floor.
  const aggregateWaitMs = attentionAggregateReaderTimeoutMs((fleetRetention?.last?.targetedHostIds ?? []).length);

  const [instanceHealth, healthProjection, agg, summaries, library, review, streamItems, attention, blocked, inProgress, pending, fleetReadsResult, recentlyFinished, scopesRead, executionRead, sliceDetailRead, connectionsRead, seatEffortRead] = await Promise.all([
    safe<InstanceHealthRead>("health", () => client.health()),
    !healthRequested ? Promise.resolve(null) : safe<HealthProjectionRead>("health-findings", () => client.healthFindings()),
    !broadReads ? Promise.resolve(null) : safe<AttentionAggregateRead>("attention-aggregate", () => client.attentionAggregate(aggregateWaitMs)),
    readingOnly ? Promise.resolve(null) : safe<RigSummaryRead[]>("rigs-summary", () => client.rigsSummary()),
    (wantsSpecs || wantsConnections) ? safe<SpecLibraryRead[]>("specs-library", () => client.specsLibrary()) : Promise.resolve(null),
    !broadReads ? Promise.resolve(null) : safe<ReviewFleetRead>("review-fleet", () => client.reviewFleet()),
    !broadReads ? Promise.resolve(null) : safe<StreamItemRead[]>("stream-tail", () => client.streamLatest()),
    // PULSE ▲ NEEDS YOU + ⧗ BLOCKED + ◌ PARKED — the shipped queue reads (increments 2/2b)
    !seatQueueReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-attention", () => client.queueAttention()),
    !seatQueueReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-blocked", () => client.queueBlocked()),
    !seatQueueReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-in-progress", () => client.queueInProgress()),
    // PULSE UP NEXT + JUST FINISHED lane reads (increment 3) — same shipped /list route
    !seatQueueReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-pending", () => client.queuePending()),
    // The hub-side fleet summary: ONE fan-out answering reachability, per-seat
    // activity on OTHER hosts, and the stall verdict. OPTIONAL — an older daemon
    // 404s and every field below stays empty, which is what the page rendered
    // before this read existed. The fleet USAGE read rides behind it, gated on the
    // hosts this one names.
    fleetReads,
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-recently-finished", () => client.queueRecentlyFinished()),
    !broadReads ? Promise.resolve(null) : safe<{ missions: unknown[]; sourceObservation?: { state: string } }>("scopes", () => client.scopesDetailed() as Promise<{ missions: unknown[] }>),
    !broadReads ? Promise.resolve(null) : safe<{ rows: unknown[] }>("execution", () => client.execution(executionMission ?? undefined) as Promise<{ rows: unknown[] }>),
    broadReads && sliceDetailName
      ? safe<SliceDetailSnap>(`slice-detail(${sliceDetailName})`, () => client.sliceDetail(sliceDetailName))
      : Promise.resolve(null),
    wantsConnections ? safe<ConnectionsRead>("connections", () => client.connections()) : Promise.resolve(null),
    seatEffortRef ? safe<SeatEffortRead>("seat-effort", () => client.seatEffort(seatEffortRef)) : Promise.resolve(null),
  ]);

  // Optional: an older daemon has no manifest route; the page then points at the CLI instead.
  const slackManifest = wantsConnections
    ? await (client.slackManifest() as Promise<SlackManifestRead>).then((m) => (typeof m?.url === "string" && typeof m?.yaml === "string" ? m : null), () => null)
    : null;

  const agentSpecNames = new Set((library ?? []).filter((entry) => entry.kind === "agent").map((entry) => entry.name));
  // The fleet summary's own registry leg can fail while the local host still answers;
  // that is a named partial hydration, not a silent narrowing of the fleet.
  // A failed fleet read is NAMED, not swallowed: STALLED and the remote rows may be
  // showing the last good read rather than the current state, and a reader is entitled
  // to know that the sections they can see are not freshly confirmed.
  const fleetSummary = fleetReadsResult?.summary?.payload ?? null;
  if (fleetReadsResult?.summary?.failed) readErrors.push(fleetReadsResult.summary.failed);
  if (fleetSummary?.registryError) readErrors.push(`fleet-summary registry: ${fleetSummary.registryError}`);
  // The usage read failed the same way and gets the same treatment: the last good
  // payload stands, and the failure is NAMED rather than left as a block that quietly
  // stopped growing.
  const fleetUsage = fleetReadsResult?.usage?.payload ?? null;
  if (fleetReadsResult?.usage?.failed) readErrors.push(fleetReadsResult.usage.failed);
  if (fleetUsage?.registryError) readErrors.push(`fleet-usage registry: ${fleetUsage.registryError}`);
  if (scopesRead?.sourceObservation?.state === "unavailable") readErrors.push("scopes: proof source updates unavailable; current HTTP basis only");
  if (review?.registryError) readErrors.push(`review-fleet registry: ${review.registryError}`);
  const recentTransitionsRig = currentRigName ?? (!viewContext ? summaries?.[0]?.name : null) ?? null;
  const recentTransitionsScope = topologyLeaf?.kind === "host"
    ? { kind: "instance" } as const
    : recentTransitionsRig ? { kind: "rig", rig: recentTransitionsRig } as const : null;
  const recentTransitions = wantsRecent && recentTransitionsScope
    ? await safe<RecentTransitionSnap[]>(
        `queue-recent(${recentTransitionsScope.kind === "instance" ? "instance" : recentTransitionsScope.rig})`,
        () => client.queueRecentTransitions(recentTransitionsScope),
      )
    : null;

  // BLOCKED ON AGENTS label==referent (r1 finding): blockedOn is a qitem POINTER
  // for agent-blocks, so the blocking AGENT is that qitem's OWNER. Resolve each
  // via the shipped single-qitem daemon read (client.queueItem) — a BOUNDED
  // per-row lookup. Canonical human references take precedence even when their
  // local part starts with qitem-; typed and legacy gates are not local IDs.
  // A miss (gate name / closed blocker) degrades QUIETLY to the raw blockedOn at
  // render (honest) — this is enrichment, NOT a load-bearing read, so it must not
  // pollute readErrors / the "reads failed" status line (the blocked LIST read,
  // which IS load-bearing, already goes through safe()).
  const blockedResolved: QueueRead[] = await Promise.all(
    (blocked ?? []).map(async (item) => {
      const read = toQueueRead(item);
      if (read.blockedOn && !isHumanSeatSession(read.blockedOn) && read.blockedOn.startsWith("qitem-")) {
        const blocker = (await client.queueItem(read.blockedOn, { optional: true }).catch(() => null)) as QueueItemRead | null;
        read.blockerSession = blocker?.destinationSession ?? null;
      }
      return read;
    }),
  );

  // Topology: the local host expands to the daemon's rigs; remote hosts come
  // from the aggregate with reachability only (per-rig start; the all-rigs
  // level is deliberately under-designed — founder capture).
  const rigs = [];
  const rigsDown: FleetSnapshot["hostsDown"] = [];
  const rigSpecRefs = new Map<string, string[]>(); // rig-spec name → agentRefs
  const rigConsumers = new Map<string, NonNullable<SpecEntry["consumers"]>>();
  // PULSE ◌ PARKED WITH BATON — the ps/activity side of the join, accumulated
  // across rigs from the SAME nodes read that feeds topology (no extra fetch):
  // one entry per agent seat WITH a canonical session (infra seats have none).
  const seatActivity: SeatActivitySummary[] = [];
  for (const rig of summaries ?? []) {
    const readInventory = wantsConnections ? connectionsRead?.configuration?.inboundDestination?.split("@")[1] === rig.name
      : !focusedTopology || topologyLeaf?.kind === "host" || currentRigName === rig.name || pendingInventory;
    const nodes = readInventory ? await safe<NodeInventoryRead[]>(`nodes(${rig.name})`, () => client.rigNodes(rig.id)) : null;
    for (const node of nodes ?? []) {
      if (node.nodeKind !== "agent" || !node.canonicalSessionName) continue;
      seatActivity.push({
        session: node.canonicalSessionName,
        // COMPACT lane form (r1 ruling): node.logicalId served verbatim — the
        // same value TABLE renders as the agent name — NOT reconstructed from
        // the session string (a hyphen split would be lossy).
        logicalId: node.logicalId,
        terminalActive: node.terminalActive ?? null,
        lastActivityAt: node.lastActivityAt ?? null,
      });
    }
    // slice-17: the topology graph view consumes the DECLARED §4.A graph read
    // (nodes + edges + overlay in one fetch); a failed read leaves the view
    // honest-empty with a NAMED error, never fabricated boxes.
    const graph = wantsGraph && (topologyLeaf?.kind === "host" || recentTransitionsRig === rig.name)
      ? await safe<import("./topology/graph-types.js").RigGraph>(`graph(${rig.name})`, () => client.rigGraph(rig.id))
      : null;
    const rigRow = {
      id: rig.id,
      name: rig.name,
      pods: nodes ? groupPods(nodes) : [],
      ...(!readInventory ? { inventoryNotLoaded: true } : nodes === null ? { inventoryUnavailable: true } : {}),
      ...(graph ? { graph } : {}),
      ...(rig.lifecycleState ? { lifecycleState: rig.lifecycleState } : {}),
      hasLiveAgents: rig.hasLiveAgents ?? null,
      authoredSpecName: undefined as string | undefined,
    };
    rigs.push(rigRow);
    if (broadReads && rig.lifecycleState && rig.lifecycleState !== "running") {
      // rig-down leg (§4.A): summary lifecycleState verbatim, enriched by the
      // rig-status projection where it answers — composed BESIDE the items.
      const st = await safe<RigStatusRead>(`rig-status(${rig.name})`, () => client.rigStatus(rig.id));
      const seatDetail = st && st.seatsTotal != null ? `${st.seatsRunning ?? 0}/${st.seatsTotal} seats running` : undefined;
      rigsDown.push({
        hostId: `${RIG_DOWN_ID_PREFIX}${rig.name}`,
        status: st?.status ? `${rig.lifecycleState} (${st.status})` : rig.lifecycleState,
        ...(seatDetail ? { error: seatDetail } : {}),
      });
    }
    const spec = (wantsSpecs || wantsConnections)
      ? await safe<RigSpecJsonRead>(`rig-spec(${rig.name})`, () => client.rigSpec(rig.id))
      : null;
    rigRow.authoredSpecName = spec?.name;
    if (spec?.name) rigConsumers.set(spec.name, [...(rigConsumers.get(spec.name) ?? []), { rig: rig.name, host: instanceHealth?.selfHostId?.trim() || "local", status: rig.lifecycleState ?? "unknown" }]);
    if (spec?.pods) {
      const refs = spec.pods.flatMap((p) =>
        (p.members ?? [])
          .map((m) => m.agentRef)
          .filter((r): r is string => !!r)
          .map((ref) => resolveAgentRef(ref, agentSpecNames)),
      );
      if (spec.name) rigSpecRefs.set(spec.name, refs);
    }
  }
  // The aggregate's `hosts` leg is the ONLY thing that names the remote
  // hosts, and it rode `broadReads` alone, so a remote host existed only in PULSE and
  // vanished the moment it was drilled (drilling switches to the table tab, which reads
  // narrowly). A daemon that runs NO rigs of its own is a hub, and the fleet view IS
  // its product, so the topology scope reads the aggregate for it. A failure is NAMED: on a
  // hub this read is the only source of every remote host, and a quiet failure emptied the
  // whole fleet from the view with nothing on screen to say why. A machine that runs its own
  // rigs pays nothing extra — that is where the 24-rig landing cost guard
  // (navigation-continuity) lives, and it stays exact.
  let fleetAgg = agg;
  if (fleetAgg === null && wantsTopologyScope && (summaries?.length ?? 0) === 0) {
    fleetAgg = await safe<AttentionAggregateRead>("attention-aggregate", () => client.attentionAggregate(aggregateWaitMs));
  }
  const aggHosts = fleetAgg?.hosts ?? [];
  const localHost: HostNode = {
    id: "local",
    name: instanceHealth?.selfHostId?.trim() || "local",
    reachable: true,
    rigs,
  };
  // A REACHABLE remote host expands to its rigs through the shipped
  // read-through (the rigs-summary read with a host envelope), and a remote rig drills
  // into its seats the same way (the nodes read with the same envelope). The origin
  // answers VERBATIM, so the same local projection code (groupPods) maps both levels.
  //
  // Both reads are LAZY by construction: a remote host's rigs are read only
  // while the operator has that host expanded or drilled, and a remote rig's seats
  // only while that rig is expanded or focused. The cost per refresh therefore follows
  // what the operator looks at, not the number of entries in hosts.yaml. An
  // UNREACHABLE host is never dialled — the aggregate already said so — so a dead team
  // costs one skipped read rather than a named read error every refresh.
  const expandedKeys = new Set(viewContext?.expanded ?? []);
  const drillHost = wantsTopologyScope ? viewContext?.drill.find((seg) => seg.kind === "host")?.name : undefined;
  const drillRemoteRig = wantsTopologyScope ? viewContext?.drill.find((seg) => seg.kind === "rig")?.name : undefined;
  // One task per host, and one per rig inside a host, so a single slow team cannot
  // stall the whole hydrate behind a serial chain of 5s client timeouts (review N3).
  // Promise.all keeps the emitted order identical to the aggregate's.
  const remoteHosts: HostNode[] = await Promise.all(aggHosts
    .filter((h) => h.hostId !== LOCAL_HOST_ID_SENTINEL)
    .map(async (aggHost): Promise<HostNode> => {
      const host: HostNode = { id: aggHost.hostId, name: aggHost.hostId, reachable: aggHost.status === "ok", rigs: [], remote: true };
      if (!host.reachable || !wantsTopologyScope) return host;
      if (!expandedKeys.has(`host:${host.name}`) && drillHost !== host.name) return host;
      const remoteRigs = await safe<RigSummaryRead[]>(`rigs-summary(${host.id})`, () => client.rigsSummary(host.id));
      if (remoteRigs === null) {
        host.rigsUnavailable = true;
        return host;
      }
      host.rigs = await Promise.all(remoteRigs.map(async (rig): Promise<RigNode> => {
        const focused = expandedKeys.has(`rig:${host.name}/${rig.name}`) || (drillHost === host.name && drillRemoteRig === rig.name);
        const nodes = focused
          ? await safe<NodeInventoryRead[]>(`nodes(${host.id}/${rig.name})`, () => client.rigNodes(rig.id, host.id))
          : null;
        return {
          id: rig.id,
          name: rig.name,
          remote: true,
          hostId: host.id,
          // A remote seat is READ-ONLY from here: stamp the address that reaches
          // it so the renderer can print it where it would otherwise offer an action.
          pods: nodes
            ? groupPods(nodes).map((pod) => ({
                ...pod,
                agents: pod.agents.map((agent) => ({ ...agent, remoteAddress: remoteSeatAddress(host.id, agent.session) })),
              }))
            : [],
          ...(!focused ? { inventoryNotLoaded: true } : nodes === null ? { inventoryUnavailable: true } : {}),
          ...(rig.lifecycleState ? { lifecycleState: rig.lifecycleState } : {}),
          hasLiveAgents: rig.hasLiveAgents ?? null,
          authoredSpecName: undefined as string | undefined,
        };
      }));
      return host;
    }));

  // Specs: RIG + AGENT land well by consuming the existing structured review
  // for BOTH kinds. WORKFLOW remains basics. Reviews are memoized by updatedAt.
  async function specReview(entry: SpecLibraryRead): Promise<SpecLibraryReviewRead | null> {
    const key = `${entry.id}@${entry.updatedAt ?? ""}`;
    const cached = reviewCache?.get(key);
    // Re-read the selected source: an on-disk edit need not update the library row.
    if (cached && viewContext?.drill.at(-1)?.name !== entry.name) return cached;
    const review = await safe<SpecLibraryReviewRead>(`spec-review(${entry.name})`, () => client.specLibraryReview(entry.id));
    if (review && reviewCache) reviewCache.set(key, review);
    return review;
  }

  const reviewed = new Map<string, SpecLibraryReviewRead>();
  await Promise.all(
    (wantsSpecs ? library ?? [] : []).filter((entry) => entry.kind !== "workflow").map(async (entry) => {
      const detail = await specReview(entry);
      if (detail) reviewed.set(entry.id, detail);
    }),
  );

  const reviewedRigRefs = new Map<string, string[]>();
  for (const entry of library ?? []) {
    const detail = reviewed.get(entry.id);
    if (entry.kind !== "rig" || detail?.kind !== "rig" || detail.format !== "pod_aware") continue;
    const refs: string[] = [];
    for (const pod of detail.pods ?? []) {
      for (const member of pod.members) {
        const ref = resolveAgentRef(member.agentRef, agentSpecNames);
        refs.push(ref);
      }
    }
    reviewedRigRefs.set(entry.name, refs);
  }
  const allRigRefs = new Map([...rigSpecRefs, ...reviewedRigRefs]);

  const specs: SpecEntry[] = await Promise.all(
    (library ?? []).map(async (entry): Promise<SpecEntry> => {
      const base = {
        name: entry.name,
        version: entry.version,
        sourcePath: entry.sourcePath,
        resolvedSourcePath: entry.resolvedSourcePath,
        sourceType: entry.sourceType,
        relativePath: entry.relativePath,
        consumers: readingOnly ? undefined : entry.kind === "rig" ? rigConsumers.get(entry.name) ?? [] : entry.kind === "agent" ? localHost.rigs.flatMap((rig) => rig.pods.flatMap((pod) => pod.agents.filter((agent) => agent.spec === entry.name).map((agent) => ({ rig: rig.name, host: localHost.name, agent: agent.name, runtime: agent.runtime, model: agent.model, status: agent.status })))) : undefined,
      };
      const detail = reviewed.get(entry.id);
      const sourceUnavailable = readErrors.find((error) => error.startsWith(`spec-review(${entry.name}):`)) ?? "source review unavailable";
      if (entry.kind === "rig") {
        if (detail?.kind !== "rig") return { ...base, kind: "rig", sourceUnavailable, agentRefs: allRigRefs.get(entry.name) ?? [] };
        const pods = detail.format === "pod_aware"
          ? (detail.pods ?? []).map((pod) => ({
              ...pod,
              members: pod.members.map((member) => ({
                ...member,
                agentRef: resolveAgentRef(member.agentRef, agentSpecNames),
              })),
            }))
          : undefined;
        return {
          ...base,
          kind: "rig",
          description: authoredDescription(detail.raw),
          sourceState: detail.sourceState,
          format: detail.format,
          agentRefs: allRigRefs.get(entry.name) ?? [],
          ...(pods ? { pods } : {}),
          ...(detail.edges ? { edges: detail.edges } : {}),
          ...(detail.graph ? { graph: detail.graph } : {}),
          ...(detail.raw ? { raw: detail.raw } : {}),
          ...(detail.kind === "rig" && detail.format === "legacy" && detail.nodes ? { legacyNodes: detail.nodes } : {}),
        };
      }
      if (entry.kind === "agent") {
        const usedByRigs = [...allRigRefs.entries()].filter(([, refs]) => refs.includes(entry.name)).map(([rig]) => rig);
        const review = detail?.kind === "agent" ? detail : null;
        const truth = agentSpecTruth(review?.raw);
        const resources = {
          skills: review?.resources?.skills ?? [],
          guidance: review?.resources?.guidance ?? [],
          plugins: review?.resources?.plugins ?? [],
          subagents: review?.resources?.subagents ?? [],
        };
        return {
          ...base,
          kind: "agent",
          ...(!review ? { sourceUnavailable } : {}),
          usedByRigs,
          namespace: agentNamespace(entry.relativePath),
          sourceState: review?.sourceState,
          runtime: truth.runtime,
          ...(review?.description ? { description: review.description } : {}),
          skills: truth.skills.length > 0 ? truth.skills : resources.skills,
          hasGuidance: resources.guidance.length > 0,
          profiles: review?.profiles?.map((profile) => profile.name) ?? [],
          resources,
          ...(review?.startup?.files ? { startupFiles: review.startup.files } : {}),
          ...(review?.raw ? { raw: review.raw } : {}),
        };
      }
      return {
        ...base,
        kind: "workflow",
        ...(entry.rolesCount != null ? { rolesCount: entry.rolesCount } : {}),
        ...(entry.stepsCount != null ? { stepsCount: entry.stepsCount } : {}),
        ...(entry.status ? { workflowStatus: entry.status } : {}),
      };
    }),
  );

  // Needs-You: composeNeedsYou verbatim; host-down BESIDE.
  const items = review?.needsYou?.items ?? [];
  const needs = items.map(toNeedsItem);
  const hostsDown = [
    ...aggHosts
      .filter((h) => h.status !== "ok")
      .map((h) => ({ hostId: h.hostId, status: h.status, ...(h.error ? { error: h.error } : {}) })),
    ...rigsDown,
  ];
  const execution = (executionRead?.rows?.[0] ?? null) as FleetSnapshot["execution"];

  // The remote half of the PARKED join's right side. The local host's own seats are
  // skipped — the local nodes read already carries them, and counting a seat twice
  // would double the join. `activity` is the daemon's own classifier
  // (working | idle | needs-input | unknown): only a definite "idle" becomes
  // terminalActive:false, because an unknown signal is honest-unknown and is
  // EXCLUDED from PARKED rather than assumed idle. This is what the cross-host join
  // was missing when it refused to run at all.
  const remoteSeatActivity: SeatActivitySummary[] = (fleetSummary?.items ?? [])
    .filter((host) => host.hostId !== LOCAL_HOST_ID_SENTINEL && host.reachable)
    .flatMap((host) => host.rigs.flatMap((rig) => rig.seats))
    .filter((seat) => seat.canonicalSessionName != null)
    .map((seat) => ({
      session: seat.canonicalSessionName as string,
      logicalId: seat.logicalId ?? (seat.canonicalSessionName as string),
      terminalActive: seat.activity === "idle" ? false : seat.activity === "unknown" || seat.activity === null ? null : true,
      lastActivityAt: seat.lastActivityAt,
      hostId: seat.hostId,
    }));

  // The stall verdict, taken VERBATIM from the hub — the TUI does not recompute a
  // threshold it was handed. A host and each of its rigs carry their own verdict.
  //
  // LOCAL rigs are excluded unless the operator actually has remote hosts. The brief
  // is explicit that an operator with no remote hosts sees no change, and the daemon
  // always computes a local verdict — so without this gate a single-machine operator
  // whose own in-progress item went quiet would get a brand-new ⚑ STALLED section
  // labelled with their own machine. Once remote hosts ARE present, the hub's own rigs
  // are part of the fleet it is reporting on and may be marked too.
  //
  // The test is against the hosts the fan-out TRIED, not the ones that answered. `items`
  // only holds hosts that answered, so with every remote host down the operator's own
  // stalled rigs would vanish from a page that is supposed to be getting worse, not
  // quieter — a fleet on fire and a fleet with no remote hosts would render the same.
  const probedHostIds = fleetSummary?.targetedHostIds?.length
    ? fleetSummary.targetedHostIds
    : (fleetSummary?.hosts ?? []).map((h) => h.hostId);
  const hasRemoteHosts = probedHostIds.some((id) => id !== LOCAL_HOST_ID_SENTINEL);
  const stalledRows: FleetSnapshot["stalled"] = (fleetSummary?.items ?? []).flatMap((host) => {
    if (!hasRemoteHosts) return [];
    const threshold = fleetSummary?.stallThresholdMinutes ?? 0;
    return [
      ...(host.progress.stalled === true
        ? [{ level: "host" as const, hostId: host.hostId, rigName: null, openWorkCount: host.progress.openWorkCount, minutesSinceProgress: host.progress.minutesSinceProgress, lastProgressAt: host.progress.lastQueueTransitionAt, thresholdMinutes: threshold }]
        : []),
      ...host.rigs
        .filter((rig) => rig.progress.stalled === true)
        .map((rig) => ({ level: "rig" as const, hostId: rig.hostId, rigName: rig.rigName, openWorkCount: rig.progress.openWorkCount, minutesSinceProgress: rig.progress.minutesSinceProgress, lastProgressAt: rig.progress.lastQueueTransitionAt, thresholdMinutes: threshold })),
    ];
  });

  return {
    connections: connectionsRead,
    // Keep the address even when the read failed: the detail page then says the
    // report was not read instead of silently omitting the effort section.
    ...(seatEffortRef ? { seatEffort: { seatRef: seatEffortRef, report: seatEffortRead } } : {}),
    controlPlane: instanceHealth,
    slackManifest,
    daemonTarget: (() => { try { const u = new URL(client.baseUrl); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return "unreported"; } })(),
    health: healthProjection
      ? {
          availability: "loaded",
          evaluatedAt: healthProjection.evaluatedAt,
          total: healthProjection.total,
          truncated: healthProjection.truncated,
          records: healthProjection.records,
          ...(healthProjection.coverage?.length ? { coverage: healthProjection.coverage } : {}),
        }
      : healthRequested ? { availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] } : undefined,
    hosts: [localHost, ...remoteHosts],
    specs,
    specsLoaded: wantsSpecs && library != null,
    fileRoots: fileRoots?.roots,
    needs,
    humanQueueProbed: review != null && !review.registryError && Array.isArray(review.hosts) && review.hosts.length > 0
      && review.hosts.every((host) => host.status.status === "ok"),
    scopes: (scopesRead?.missions ?? []) as FleetSnapshot["scopes"],
    execution,
    executionMission: executionMission ?? execution?.mission ?? null,
    sliceDetail: sliceDetailRead,
    sliceDetailName: sliceDetailName ?? null,
    ...(recentTransitions && recentTransitionsScope
      ? {
          recentTransitions,
          recentTransitionsScope,
          ...(recentTransitionsScope.kind === "rig" ? { recentTransitionsRig: recentTransitionsScope.rig } : {}),
        }
      : {}),
    attention: (attention ?? []).map(toQueueRead),
    // Cross-host queue rows from BOTH cross-host reads, deduped by qitem id. The
    // attention aggregate only carries rows whose attention class made them interesting
    // to a human, so a remote row blocked on an AGENT or simply in progress is not in
    // it — the fleet summary's openQueue is what makes those visible, which is the
    // whole reason BLOCKED ON AGENTS and PARKED could not cover remote rows before.
    fleetQueue: (() => {
      const rows = (fleetAgg?.items ?? []).map(toFleetQueueRead).filter((row): row is QueueRead => row !== null);
      const seen = new Set(rows.map((row) => row.qitemId));
      for (const item of fleetSummary?.openQueue ?? []) {
        if (seen.has(item.qitemId) || item.hostId === LOCAL_HOST_ID_SENTINEL) continue;
        seen.add(item.qitemId);
        rows.push({
          qitemId: item.qitemId,
          state: item.state,
          destinationSession: item.destinationSession ?? "",
          blockedOn: item.blockedOn,
          handedOffTo: item.handedOffTo,
          claimedAt: item.claimedAt,
          tier: item.priority,
          tags: item.tags,
          summary: item.summary,
          body: "",
          tsUpdated: item.tsUpdated ?? "",
          hostId: item.hostId,
        });
      }
      return rows;
    })(),
    queueCoverage: !seatQueueReads ? undefined
      : [attention, blocked, inProgress, pending].some(rows => rows === null) ? "unavailable"
      // Existing /list defaults cap the first three reads at 100; pending requests 50.
      : [attention, blocked, inProgress].some(rows => rows!.length >= 100) || pending!.length >= 50 ? "partial"
      : "complete",
    blocked: blockedResolved,
    inProgress: (inProgress ?? []).map(toQueueRead),
    seatActivity,
    remoteSeatActivity,
    stalled: stalledRows,
    stallThresholdMinutes: fleetSummary?.stallThresholdMinutes,
    fleetProbed: fleetSummary != null,
    fleetUsage,
    pending: (pending ?? []).map(toQueueRead),
    recentlyFinished: (recentlyFinished ?? []).map(toQueueRead),
    hydratedAt: new Date().toISOString(),
    hostsDown,
    stream: (streamItems ?? []).map((s) => ({ tsEmitted: s.tsEmitted, sourceSession: s.sourceSession, body: s.body })),
    readErrors,
  };
}

function authoredDescription(raw?: string): string | undefined {
  try {
    const doc = parseYaml(raw ?? "") as { summary?: unknown; description?: unknown; metadata?: { description?: unknown } } | null;
    // RigSpec summary takes precedence over legacy authored descriptions.
    return [doc?.summary, doc?.description, doc?.metadata?.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch { return undefined; }
}
