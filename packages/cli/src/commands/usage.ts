// 51-08 A4 — `rig usage`: the CLI face of the ONE telemetry projection
// (PM decision 4; the daemon's /api/telemetry/usage/* routes). Facts only:
// tokens/hour, window velocities, honest-unknown rail — thresholds and
// judgments belong to the consumer (the oversight detector). --json is
// verbatim route payload for the scripted detector.
//
// WHAT THESE NUMBERS ARE, stated here because a reader will otherwise assume more
// precision than exists: they are SAMPLED readings of each seat's context window
// (and, where a runtime observes one, its provider window). They are good for
// "which team is burning fastest right now". They are NOT exact token or cost
// accounting — nothing here is metered against a bill, and a seat idle between
// samples shows less than it used. A lane a runtime does not observe is shown as
// absent, never as zero.
import { Command } from "commander";
import { DaemonClient, remoteDaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, resolveOriginSelfHostId, resolveLocalDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { loadHostRegistry, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { isAggregatedFleetPayload, tryHubFleetRead } from "../lib/fleet-hub-read.js";
import { addUsageTotals, parseUsageTopBody, rankFleetSeats, sumUsageTotals, ZERO_USAGE_TOTALS } from "@openrig/daemon/fleet";
import type { StatusDeps } from "./status.js";

/** Parse a human duration (`90m`, `1h`, `2d`, bare hours `1.5`) into hours.
 *  Returns null on anything unparseable — the caller renders the teaching error. */
export function parseWindowToHours(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhd])?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "h";
  if (unit === "m") return n / 60;
  if (unit === "d") return n * 24;
  return n;
}

interface TopPayload {
  ranked: Array<{
    seatSession: string;
    tokensPerHour: number;
    tokensDelta: number;
    resets: number;
    spanHours: number;
    samples: number;
    windows: Array<{ window: string; usedPercentFirst: number | null; usedPercentLast: number | null; percentPerHour: number | null }>;
  }>;
  unknown: Array<{ seatSession: string; reason: string }>;
  totalRankedSeats: number;
  windowHours: number;
}

// ---------------------------------------------------------------------------
// The fleet read (`--all-hosts`).
//
// The shapes are declared HERE rather than imported from the daemon on purpose:
// an OLDER daemon is the authority on what it answers, and a CLI that imports the
// current types would silently mis-read a pod that predates them. Same ruling the
// fleet `ps` reader follows.
// ---------------------------------------------------------------------------

interface FleetUsageSeat {
  hostId: string;
  seatSession: string;
  tokensPerHour: number;
  tokensDelta: number;
  resets: number;
  spanHours: number;
  samples: number;
}

interface FleetUsageUnknown { hostId: string; seatSession: string; reason: string }

interface FleetUsageTotals { tokensDelta: number; resets: number; seatsRanked: number; seatsUnknown: number }

interface FleetUsageHost {
  hostId: string;
  status: string;
  reachable: boolean;
  statusError?: string;
  usage: {
    state: "ok" | "unavailable";
    reason?: string;
    ranked: FleetUsageSeat[];
    unknown: FleetUsageUnknown[];
    totals?: FleetUsageTotals;
  };
  partialFailures?: string[];
}

interface FleetUsagePayload {
  items: FleetUsageHost[];
  hosts: Array<{ hostId: string; status: string; error?: string }>;
  windowHours: number;
  top: FleetUsageSeat[];
  topCap: number | null;
  totalSeatsRanked: number;
  unknown: FleetUsageUnknown[];
  totals: (FleetUsageTotals & { hostsAnswered: number; hostsTargeted: number }) | null;
  targetedHostIds: string[];
  registryError?: string;
}

function remoteBearerHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The local daemon's client, or null when it is not running. A null here is not an
 *  error the caller has to re-derive: `daemonStatusGuard` already printed why. */
async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return null;
  return deps.clientFactory(getDaemonUrl(status));
}

export interface UsageDeps extends StatusDeps {
  /** Test seam, the same one `rig ps --all-hosts` uses: the registry is a file, and a
   *  suite must not depend on whatever the machine running it happens to declare. */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

/** `--top`, validated once with the route's own rule, before either path runs.
 *  The single-host path would learn the rule from the daemon's 400, but the fleet
 *  fallback never asks a route: an unvalidated `--top abc` became NaN, `slice(0, NaN)`
 *  returned nothing, and the command printed "no usage samples" over a fleet that had
 *  plenty — then said "--top NaN" and exited 0. */
function parseTopCount(raw: string | undefined): { value: number | null } | { error: string } {
  if (raw === undefined) return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return { error: `invalid top "${raw}" — must be a positive count` };
  return { value: Math.floor(n) };
}

/** The keys this command documents, and the only ones it prints as JSON.
 *
 *  The hub's payload carries more than the fan-out can know — cache fields, the origin's
 *  own window echo, per-host `kind` — and a scripted reader must not care which path ran.
 *  Projecting here is what makes "the same keys on both paths" true rather than intended:
 *  without it, one script breaks depending on whether a local daemon happened to be up.
 *  `source` says which path answered, because the two are not equally fresh. */
function projectFleetUsage(payload: FleetUsagePayload, source: "hub" | "cli-fanout") {
  return {
    source,
    windowHours: payload.windowHours,
    top: payload.top,
    topCap: payload.topCap,
    totalSeatsRanked: payload.totalSeatsRanked,
    unknown: payload.unknown,
    totals: payload.totals,
    targetedHostIds: payload.targetedHostIds,
    items: payload.items.map((i) => ({
      hostId: i.hostId,
      status: i.status,
      reachable: i.reachable,
      ...(i.statusError !== undefined ? { statusError: i.statusError } : {}),
      usage: {
        state: i.usage.state,
        ...(i.usage.reason !== undefined ? { reason: i.usage.reason } : {}),
        ranked: i.usage.ranked,
        unknown: i.usage.unknown,
        ...(i.usage.totals !== undefined ? { totals: i.usage.totals } : {}),
      },
      // Always present: an empty list is the statement "nothing was partially read",
      // and the hub sends one even when empty. Making it optional here would mean the
      // two paths disagree on a key again, which is the thing this projection exists to stop.
      partialFailures: i.partialFailures ?? [],
    })),
    hosts: payload.hosts.map((h) => ({
      hostId: h.hostId,
      status: h.status,
      ...(h.error !== undefined ? { error: h.error } : {}),
    })),
    ...(payload.registryError !== undefined ? { registryError: payload.registryError } : {}),
  };
}

/** One host's answer, read from the CLI side when the hub read is not available. */
async function readHostUsageLeg(
  deps: StatusDeps,
  host: HttpHostEntry | null,
  localClient: DaemonClient | null,
  path: string,
  originSelfHostId: string | undefined,
): Promise<FleetUsageHost> {
  const isLocal = host === null;
  const hostId = isLocal ? "local" : host!.id;
  const unavailable = (
    status: string,
    reason: string,
    error?: string,
    note?: string,
  ): FleetUsageHost => ({
    hostId,
    status,
    reachable: status === "ok",
    ...(error !== undefined ? { statusError: error } : {}),
    usage: { state: "unavailable", reason, ranked: [], unknown: [] },
    ...(note !== undefined ? { partialFailures: [note] } : {}),
  });

  let get: (path: string) => Promise<{ status: number; data: unknown }>;
  if (isLocal) {
    if (!localClient) return unavailable("unreachable", "this daemon is not reachable");
    get = (p) => localClient.get<unknown>(p);
  } else if (host!.transport !== "http") {
    return unavailable("unsupported-transport", `host ${hostId} uses transport ${host!.transport}; the usage read requires transport: http`);
  } else {
    const bearer = resolveRemoteBearer(host as HttpHostEntry);
    if (!bearer.ok) return unavailable("auth-failed", bearer.error, bearer.error);
    const client = remoteDaemonClient(deps.clientFactory, (host as HttpHostEntry).url, originSelfHostId);
    const headers = remoteBearerHeaders(bearer.token);
    get = (p) => client.get<unknown>(p, { headers });
  }

  try {
    const res = await get(path);
    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      if (res.status === 401 || res.status === 403) {
        return unavailable("auth-failed", `this host's usage read refused the CLI's credential (HTTP ${res.status})`, `HTTP ${res.status}`);
      }
      // The host ANSWERED; it could not serve this read. That is not an unreachable
      // host, and calling it one sends the operator to fix a connection that works.
      // The hub reaches the same verdict through its /healthz leg; this path has no
      // such leg, so the HTTP answer itself is the evidence: a response received
      // means the host is up. Only a transport failure below is `unreachable`.
      return unavailable(
        "ok",
        `this host's usage read did not answer (HTTP ${res.status})`,
        `HTTP ${res.status}`,
        `this host answered HTTP ${res.status} to its usage read; it is reachable, and its usage is unknown rather than zero`,
      );
    }
    const parsed = parseUsageTopBody(res.data);
    if (!parsed.leg.ok) {
      return unavailable(
        "ok",
        `this host's usage read was unreadable: ${parsed.leg.reason}`,
        undefined,
        "this host answered its usage read with a body this command could not parse; its usage is unknown rather than zero",
      );
    }
    const body = parsed.leg.body;
    const ranked = body.ranked.map((s) => ({ ...s, hostId }));
    const unknown = body.unknown.map((s) => ({ ...s, hostId }));
    return {
      hostId,
      status: "ok",
      reachable: true,
      usage: { state: "ok", ranked, unknown, totals: sumUsageTotals(ranked, unknown.length) },
      ...(parsed.droppedRows > 0
        ? { partialFailures: [`${parsed.droppedRows} seat row(s) from this host did not carry finite burn numbers and are excluded from its totals`] }
        : {}),
    };
  } catch (err) {
    return unavailable(classifyHttpError(err) === "permission-gate" ? "auth-failed" : "unreachable", (err as Error).message);
  }
}

/** The fleet usage read, from whichever side can serve it.
 *
 *  The hub first: it has the per-host deadline, the bounded concurrency and the
 *  short cache, so N readers cost one fan-out. ANY failure falls back to this
 *  command dialing every host itself — that fallback is the contract for an older
 *  local daemon, not an error. Same rule and same triggers as `rig ps --all-hosts`,
 *  and the same shared reader budget, so the two commands cannot disagree about how
 *  long the CLI waits. */
async function readFleetUsage(
  deps: UsageDeps,
  hours: number,
  top: number | null,
): Promise<{ payload: FleetUsagePayload; source: "hub" | "cli-fanout" } | { error: string }> {
  const registry = (deps.hostRegistryLoader ?? loadHostRegistry)();
  if (!registry.ok) return { error: registry.error };
  const targets = registry.registry.hosts;
  const params: Record<string, string> = { window_hours: String(hours) };
  // The cap goes to the hub too. Omitting it meant `--top` silently did nothing on the
  // hub path while working on the fallback, so one command answered differently
  // depending on which path ran. The route validates it and applies it after the cache.
  if (top !== null) params.top = String(top);
  const query = new URLSearchParams(params).toString();

  const hub = await tryHubFleetRead<FleetUsagePayload>(
    deps, `/api/fleet/usage?${query}`, targets.length + 1, isAggregatedFleetPayload,
  );
  if (hub) {
    // A host the hub did not answer for sends us to the fan-out rather than dropping
    // it from both items and hosts: the hub's registry and this CLI's are different
    // files, and a silently thinner fleet is the failure this read exists to remove.
    const answered = new Set(hub.hosts.map((h) => h.hostId));
    if (targets.every((h) => answered.has(h.id))) {
      // Nothing is filtered to this CLI's registry. The hub's fleet IS the answer, and
      // trimming `items` while `top`, `unknown`, `totals` and `targetedHostIds` stayed
      // whole printed a fleet total over a per-host list that could not add up to it.
      return { source: "hub", payload: hub };
    }
  }

  // The CLI-side fan-out. The LOCAL daemon is included: it is the very daemon that
  // could not serve the hub route, and it has served its own usage read for longer.
  // Addressed the same way the hub read was, so a daemon that is simply not running
  // produces one honest unknown row rather than a second guidance banner.
  const localClient = deps.clientFactory(resolveLocalDaemonUrl());
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const legPath = `/api/telemetry/usage/top?${query}`;
  const legs = await Promise.all([
    readHostUsageLeg(deps, null, localClient, legPath, originSelfHostId),
    ...targets.map((h) => readHostUsageLeg(deps, h as HttpHostEntry, null, legPath, originSelfHostId)),
  ]);

  const answering = legs.filter((l) => l.usage.state === "ok");
  const ranked = rankFleetSeats(answering.flatMap((l) => l.usage.ranked));
  const cap = top;
  const totals = answering.length === 0
    ? null
    : {
      ...answering.reduce<FleetUsageTotals>((acc, l) => addUsageTotals(acc, l.usage.totals!), ZERO_USAGE_TOTALS),
      hostsAnswered: answering.length,
      hostsTargeted: legs.length,
    };

  return {
    source: "cli-fanout",
    payload: {
      items: legs,
      hosts: legs.map((l) => ({ hostId: l.hostId, status: l.status, ...(l.statusError ? { error: l.statusError } : {}) })),
      windowHours: hours,
      top: cap === null ? ranked : ranked.slice(0, cap),
      topCap: cap,
      totalSeatsRanked: ranked.length,
      unknown: answering.flatMap((l) => l.usage.unknown),
      totals,
      targetedHostIds: legs.map((l) => l.hostId),
    },
  };
}

/** Render the fleet read. Every seat is labelled with its host — an unlabelled seat
 *  on a hub is useless, because the same seat name can exist on two teams. An
 *  unknown host is shown as unknown with its reason, never as a zero row, and a
 *  total is shown only where the payload actually has one. */
function renderFleetUsage(payload: FleetUsagePayload, windowLabel: string): void {
  const t = payload.totals;
  const coverage = t ? `${t.hostsAnswered} of ${t.hostsTargeted} hosts answered` : "no host answered its usage read";
  console.log(`FLEET TOKEN BURN — last ${windowLabel} · ${coverage}`);
  if (payload.top.length === 0 && payload.unknown.length === 0) {
    console.log("  no usage samples in the window" + (t ? " on the hosts that answered" : ""));
  }
  for (const [i, s] of payload.top.entries()) {
    const resets = s.resets > 0 ? ` · resets ${s.resets}` : "";
    console.log(
      `  ${i + 1}. [${s.hostId}] ${s.seatSession}  ${Math.round(s.tokensPerHour).toLocaleString()} tok/h`
      + `  (${s.tokensDelta.toLocaleString()} tokens over ${s.spanHours.toFixed(1)}h · ${s.samples} samples${resets})`,
    );
  }
  if (payload.topCap !== null && payload.totalSeatsRanked > payload.top.length) {
    console.log(`  … ${payload.totalSeatsRanked - payload.top.length} more seat(s) ranked but not shown (--top ${payload.topCap})`);
  }

  console.log("\n  per host");
  for (const host of payload.items) {
    if (host.usage.state !== "ok" || !host.usage.totals) {
      console.log(`    [${host.hostId}]  unknown — ${host.usage.reason ?? host.statusError ?? host.status}`);
      continue;
    }
    const ht = host.usage.totals;
    console.log(`    [${host.hostId}]  ${ht.tokensDelta.toLocaleString()} tokens · ${ht.seatsRanked} seat(s) ranked · ${ht.seatsUnknown} unknown`);
    for (const note of host.partialFailures ?? []) console.log(`              note: ${note}`);
  }

  if (t) {
    console.log(`\n  fleet total  ${t.tokensDelta.toLocaleString()} tokens · ${t.seatsRanked} seat(s) ranked · ${t.resets} reset(s)`);
    if (t.hostsAnswered < t.hostsTargeted) {
      console.log(`               (sums the ${t.hostsAnswered} host(s) that answered; ${t.hostsTargeted - t.hostsAnswered} did not, and add nothing)`);
    }
  }
  console.log("\nsampled context-window readings — which team is burning fastest right now, not exact token or cost accounting");
}

export function usageCommand(depsOverride?: UsageDeps): Command {
  const cmd = new Command("usage").description(
    "Per-seat token telemetry over time (series + top-N burn) — sampled context-window readings, not cost accounting",
  );
  const getDeps = (): UsageDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  function handleHttpError(res: { status: number; data: unknown }, label: string, json?: boolean): boolean {
    if (res.status < 400) return false;
    if (json) {
      console.log(JSON.stringify(res.data, null, 2));
    } else {
      // Prefer a body's own explanation over its error CODE: a refusal like
      // `read_through_path_not_allowed` names the boundary, while the `message`
      // field says what to do about it. Codes are for machines; this is for a person.
      const p = (res.data ?? {}) as { error?: unknown; message?: unknown };
      const detail = p.message ?? p.error ?? `${label} failed (HTTP ${res.status})`;
      console.error(detail);
    }
    process.exitCode = res.status >= 500 ? 2 : 1;
    return true;
  }

  cmd
    .command("top")
    .description("top-N seats by token burn over the window — sampled readings, not exact token or cost accounting")
    .option("--window <duration>", "look-back window (90m, 1h, 2d, or bare hours)", "1h")
    .option("--top <n>", "cap the ranking to N seats")
    .option("--all-hosts", "every registered host, each seat labelled [host] (the hub's read when it serves one, else this command dials them)")
    .option("--json", "machine-readable; the same keys on either path, with `source` saying which one ran")
    .action(async (opts: { window: string; top?: string; allHosts?: boolean; json?: boolean }) => {
      const hours = parseWindowToHours(opts.window);
      if (hours === null) {
        console.error(
          `invalid --window "${opts.window}" — accepted forms: 90m, 1h, 2d, or bare hours like 1.5`,
        );
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      // Validated before either path, so `--top` means one thing whichever runs.
      const top = parseTopCount(opts.top);
      if ("error" in top) {
        console.error(top.error);
        process.exitCode = 1;
        return;
      }

      if (opts.allHosts) {
        const fleet = await readFleetUsage(deps, hours, top.value);
        if ("error" in fleet) {
          console.error(`Error: ${fleet.error}`);
          process.exitCode = 1;
          return;
        }
        if (opts.json) console.log(JSON.stringify(projectFleetUsage(fleet.payload, fleet.source), null, 2));
        else renderFleetUsage(fleet.payload, opts.window);
        return;
      }

      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams({ window_hours: String(hours) });
      if (top.value !== null) params.set("top", String(top.value));
      const res = await client.get<TopPayload>(`/api/telemetry/usage/top?${params.toString()}`);
      if (handleHttpError(res, "usage top", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const body = res.data;
      if (body.ranked.length === 0 && body.unknown.length === 0) {
        console.log(`no usage samples in the last ${opts.window} — the series is empty`);
        return;
      }
      console.log(`TOP TOKEN BURN — last ${opts.window} (${body.totalRankedSeats} seats ranked)`);
      for (const [i, r] of body.ranked.entries()) {
        const winPart = r.windows
          .map((w) => `${w.window}: ${w.usedPercentLast ?? "?"}%${w.percentPerHour !== null ? ` (${w.percentPerHour >= 0 ? "+" : ""}${w.percentPerHour.toFixed(1)}%/h)` : ""}`)
          .join("  ");
        const resetPart = r.resets > 0 ? `  resets:${r.resets}` : "";
        console.log(
          `${i + 1}. ${r.seatSession}  ${Math.round(r.tokensPerHour).toLocaleString()} tok/h  (${r.tokensDelta.toLocaleString()} over ${r.spanHours.toFixed(1)}h, ${r.samples} samples)${resetPart}${winPart ? `  ${winPart}` : ""}`,
        );
      }
      for (const u of body.unknown) {
        console.log(`?  ${u.seatSession}  unknown (${u.reason})`); // honest rail — never a 0 row
      }
    });

  cmd
    .command("series")
    .description("raw per-seat usage samples, oldest first — sampled readings, not exact token or cost accounting")
    .option("--seat <session>", "filter to one seat session")
    .option("--lane <lane>", "context | provider_window")
    .option("--since <iso>", "absolute lower bound on captured_at (inclusive)")
    .option("--until <iso>", "absolute upper bound on captured_at (exclusive)")
    .option("--limit <n>", "max rows")
    .option("--host <id>", "read one REMOTE host's series through the hub's read-through (the hub is the only door; a team pod is not reachable directly)")
    .option("--json", "machine-readable (verbatim route payload)")
    .action(async (opts: { seat?: string; lane?: string; since?: string; until?: string; limit?: string; host?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.lane) params.set("lane", opts.lane);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      // The hub forwards this one allowlisted read to the registered host; the CLI
      // never dials the pod itself, because a team pod is cluster-internal and the
      // operator's terminal cannot reach it. The hub strips the envelope before the
      // origin ever sees it, so the pod needs no knowledge of this command.
      if (opts.host) params.set("host", opts.host);
      const qs = params.toString();
      const res = await client.get<{ rows: Array<Record<string, unknown>> }>(
        `/api/telemetry/usage/series${qs ? `?${qs}` : ""}`,
      );
      if (handleHttpError(res, "usage series", opts.json)) return;
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const rows = res.data.rows;
      // Say which host these came from: the same seat name can exist on two teams,
      // and a bare sample list read as local history would be a quiet misattribution.
      if (opts.host) console.log(`usage series from host [${opts.host}]`);
      if (rows.length === 0) {
        console.log("no samples match — the series is empty for this filter");
        return;
      }
      for (const r of rows) {
        const lane = r.lane === "provider_window"
          ? `${r.window} ${r.windowUsedPercent ?? "?"}%`
          : `tokens ${(r.totalInputTokens as number | null) ?? "?"}/${(r.totalOutputTokens as number | null) ?? "?"} used ${(r.usedPercentage as number | null) ?? "?"}%`;
        console.log(`${r.capturedAt}  ${r.seatSession}  [${r.lane}] ${lane}`);
      }
    });

  return cmd;
}
