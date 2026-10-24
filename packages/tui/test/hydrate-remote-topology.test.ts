import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot, type HydrateViewContext } from "../src/hydrate.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState, emptySnapshot } from "../src/state.js";

// Remote rigs and seats in the TUI topology.
//
// The fixture is a HUB: a daemon that runs no rigs of its own and whose hosts.yaml
// lists team pods. Shapes mirror what the read-through serves: the hub's own
// /api/rigs/summary is empty, and `<route>?host=<id>` returns the ORIGIN's answer
// verbatim (packages/daemon/src/domain/hosts/read-through.ts passes status,
// content-type and body through untouched), so a remote rig and a remote node look
// exactly like local ones.

const REMOTE_HOST = "t-team-a";
const DEAD_HOST = "t-dead";
const REMOTE_RIG_ID = "01REMOTERIG";
const REMOTE_RIG = "team-a-rig";

const remoteNode = (logicalId: string, session: string) => ({
  rigId: REMOTE_RIG_ID,
  rigName: REMOTE_RIG,
  nodeId: `01N${logicalId.toUpperCase().replace(".", "")}`,
  logicalId,
  podNamespace: "dev",
  nodeKind: "agent",
  runtime: "pi",
  model: null,
  lifecycleState: "running",
  sessionStatus: "running",
  startupStatus: "ready",
  terminalActive: true,
  lastActivityAt: "2026-10-23T14:00:00.000Z",
  canonicalSessionName: session,
  resolvedSpecName: "implementer",
  tmuxAttachCommand: "tmux attach-session -t team-a",
  cwd: "/repo",
  contextUsage: { availability: "unknown", usedPercentage: null, contextWindowSize: null, totalInputTokens: null, totalOutputTokens: null },
  hasAssignedWork: false,
  pendingWorkCount: 0,
});

const FIXTURES: Record<string, unknown> = {
  "/healthz": { ok: true, selfHostId: "hub-0" },
  "/api/health?limit=200": { evaluatedAt: null, total: 0, truncated: false, records: [] },
  // The hub runs no rigs of its own.
  "/api/rigs/summary": [],
  "/api/queue/attention-aggregate": {
    items: [],
    hosts: [
      { hostId: "local", status: "ok" },
      { hostId: REMOTE_HOST, status: "ok" },
      { hostId: "t-team-b", status: "ok" },
      { hostId: DEAD_HOST, status: "unreachable", error: "connect ECONNREFUSED" },
    ],
  },
  "/api/review/fleet": { scope: "fleet", needsYou: { items: [] }, agents: { scope: "fleet", rows: [], provenance: "", coordinationHealth: null }, settled: [], settledProvenance: "", composedAt: "2026-10-23T14:00:00.000Z" },
  "/api/stream/list?limit=5&direction=latest": [],
  "/api/queue/list?attention=1": [],
  "/api/queue/list?state=blocked": [],
  "/api/queue/list?state=in-progress": [],
  "/api/queue/list?state=pending&limit=50": [],
  "/api/queue/list?state=done,handed-off&limit=20": [],
  "/api/queue/recent-transitions?scope=instance&limit=20": [],
  "/api/scopes?detail=1": { missions: [] },
  "/api/views/execution": { rows: [] },
  // The remote host's rigs, served by the read-through.
  [`/api/rigs/summary?host=${REMOTE_HOST}`]: [
    { id: REMOTE_RIG_ID, name: REMOTE_RIG, nodeCount: 3, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "running", hasLiveAgents: true },
  ],
  [`/api/rigs/${REMOTE_RIG_ID}/nodes?host=${REMOTE_HOST}`]: [
    remoteNode("dev.impl", "dev-impl@team-a-rig"),
    remoteNode("dev.qa", "dev-qa@team-a-rig"),
  ],
  // An unreachable host is never dialled; if a build tried, the route is absent and
  // the client throws "unexpected route", which the lazy-read tests assert against.
};

function hubClient(responses: Record<string, unknown> = {}): { client: DaemonClient; routes: string[] } {
  const routes: string[] = [];
  const merged = { ...FIXTURES, ...responses };
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    routes.push(route);
    if (!(route in merged)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => merged[route] } as Response;
  }) as typeof fetch;
  return { client: new DaemonClient({ baseUrl: "http://x", fetchImpl }), routes };
}

/** PULSE is the view that reads the attention aggregate, and it keeps the explorer
 * sidebar — that is the surface where a remote host appears at all. */
const pulse = (over: Partial<HydrateViewContext> = {}): HydrateViewContext => ({
  project: null, section: "topology", viewTab: "pulse", drill: [], file: null,
  externalUrl: null, terminalView: null, attentionOpen: null, pendingDrill: null, expanded: [],
  ...over,
});

const hostReads = (routes: string[]) => routes.filter((r) => r.includes("?host="));

describe("a remote host expands to its rigs, lazily", () => {
  it("reads nothing for a remote host the operator has not opened", async () => {
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse());

    const host = snap.hosts.find((h) => h.name === REMOTE_HOST);
    expect(host).toMatchObject({ id: REMOTE_HOST, reachable: true, remote: true, rigs: [] });
    expect(hostReads(routes)).toEqual([]);
  });

  it("reads the rigs of a reachable host ONLY once that host is expanded", async () => {
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({ expanded: [`host:${REMOTE_HOST}`] }));

    expect(routes).toContain(`/api/rigs/summary?host=${REMOTE_HOST}`);
    const host = snap.hosts.find((h) => h.name === REMOTE_HOST)!;
    expect(host.rigs.map((r) => r.name)).toEqual([REMOTE_RIG]);
    expect(host.rigs[0]).toMatchObject({ id: REMOTE_RIG_ID, remote: true, hostId: REMOTE_HOST, inventoryNotLoaded: true, pods: [] });
    // Expanding a host costs the rigs read and NOTHING else: no seat read.
    expect(hostReads(routes)).toEqual([`/api/rigs/summary?host=${REMOTE_HOST}`]);
  });

  it("reads a remote rig's seats only while that rig is focused", async () => {
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({
      expanded: [`host:${REMOTE_HOST}`, `rig:${REMOTE_HOST}/${REMOTE_RIG}`],
    }));

    expect(routes).toContain(`/api/rigs/${REMOTE_RIG_ID}/nodes?host=${REMOTE_HOST}`);
    const rig = snap.hosts.find((h) => h.name === REMOTE_HOST)!.rigs[0]!;
    expect(rig.pods.map((p) => p.name)).toEqual(["dev"]);
    expect(rig.pods[0]!.agents.map((a) => a.name)).toEqual(["dev.impl", "dev.qa"]);
    expect(rig.pods[0]!.agents[0]).toMatchObject({ status: "active", live: true });
  });

  it("reads through the drill path too, so opening a remote rig from a command works", async () => {
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({
      drill: [{ kind: "host", name: REMOTE_HOST }, { kind: "rig", name: REMOTE_RIG }],
    }));

    expect(routes).toContain(`/api/rigs/summary?host=${REMOTE_HOST}`);
    expect(routes).toContain(`/api/rigs/${REMOTE_RIG_ID}/nodes?host=${REMOTE_HOST}`);
  });

  it("reads several remote hosts concurrently, so one slow team cannot stall the hydrate", async () => {
    // Deterministic, not a timing race: count how many remote reads are in flight at
    // once. Serial awaits would pin this at 1.
    let inFlight = 0;
    let maxInFlight = 0;
    const second = (hostId: string) => new Promise<void>((resolve) => setTimeout(resolve, 20 * (hostId === "t-team-a" ? 1 : 2)));
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      const m = /^\/api\/rigs\/summary\?host=(.+)$/.exec(route);
      if (m) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await second(m[1]!);
        inFlight -= 1;
        return { ok: true, json: async () => [] } as Response;
      }
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      throw new Error(`unexpected route in test: ${route}`);
    }) as typeof fetch;

    const snap = await hydrateSnapshot(new DaemonClient({ baseUrl: "http://x", fetchImpl }), undefined, undefined, undefined, undefined, pulse({
      expanded: [`host:${REMOTE_HOST}`, "host:t-team-b"],
    }));
    expect(snap.hosts.filter((h) => h.remote && h.reachable).map((h) => h.name)).toEqual([REMOTE_HOST, "t-team-b"]);
    expect(maxInFlight).toBe(2);
  });

  it("never dials an unreachable host and leaves no read error behind", async () => {
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({
      expanded: [`host:${REMOTE_HOST}`, `host:${DEAD_HOST}`],
    }));

    const dead = snap.hosts.find((h) => h.name === DEAD_HOST)!;
    expect(dead).toMatchObject({ reachable: false, remote: true, rigs: [] });
    expect(hostReads(routes)).toEqual([`/api/rigs/summary?host=${REMOTE_HOST}`]);
    expect(snap.readErrors.filter((e) => e.includes(DEAD_HOST))).toEqual([]);
  });

  it("names a remote rigs read that fails instead of showing a proven-empty host", async () => {
    // The read-through answers 502 with a structured body; the client throws on non-ok.
    const failing = new DaemonClient({
      baseUrl: "http://x",
      fetchImpl: (async (url: unknown) => {
        const route = String(url).replace("http://x", "");
        if (route.includes(`?host=${REMOTE_HOST}`)) return { ok: false, status: 502, json: async () => ({ error: "remote_read_failed" }) } as Response;
        if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
        throw new Error(`unexpected route in test: ${route}`);
      }) as typeof fetch,
    });

    const snap = await hydrateSnapshot(failing, undefined, undefined, undefined, undefined, pulse({ expanded: [`host:${REMOTE_HOST}`] }));
    const host = snap.hosts.find((h) => h.name === REMOTE_HOST)!;
    expect(host.rigsUnavailable).toBe(true);
    expect(host.rigs).toEqual([]);
    expect(snap.readErrors.some((e) => e.startsWith(`rigs-summary(${REMOTE_HOST})`))).toBe(true);
  });

  it("changes nothing for an operator with no remote hosts", async () => {
    const routes: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      routes.push(route);
      if (route === "/api/queue/attention-aggregate") {
        return { ok: true, json: async () => ({ items: [], hosts: [{ hostId: "local", status: "ok" }] }) } as Response;
      }
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      throw new Error(`unexpected route in test: ${route}`);
    }) as typeof fetch;

    const snap = await hydrateSnapshot(new DaemonClient({ baseUrl: "http://x", fetchImpl }), undefined, undefined, undefined, undefined, pulse({ expanded: ["host:hub-0"] }));
    expect(snap.hosts.map((h) => h.name)).toEqual(["hub-0"]);
    expect(snap.hosts[0]).not.toMatchObject({ remote: true });
    expect(hostReads(routes)).toEqual([]);
    expect(snap.hostsDown).toEqual([]);
  });
});

describe("a remote seat is read-only and says how to reach it", () => {
  async function remoteSeat() {
    const { client } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({
      expanded: [`host:${REMOTE_HOST}`, `rig:${REMOTE_HOST}/${REMOTE_RIG}`],
    }));
    const rig = snap.hosts.find((h) => h.name === REMOTE_HOST)!.rigs[0]!;
    return { snap, rig, agent: rig.pods[0]!.agents[0]! };
  }

  it("stamps the member@rig@host address the operator uses instead", async () => {
    const { agent } = await remoteSeat();
    // canonicalSessionName is already member@rig, so @host completes the CLI's
    // cross-host sugar: `rig capture dev-impl@team-a-rig@t-team-a`.
    expect(agent.remoteAddress).toBe(`dev-impl@${REMOTE_RIG}@${REMOTE_HOST}`);
  });

  it("offers no terminal or run affordance on a remote rig's seats", async () => {
    const { snap } = await remoteSeat();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "host", name: REMOTE_HOST });
    view.dispatch({ type: "drill", resource: "rig", name: REMOTE_RIG, target: { host: REMOTE_HOST } });
    const screen = renderScreen(view.get(), snap, { cols: 150, rows: 40 }, "");
    const text = screen.lines.join("\n");

    expect(text).toContain("remote");
    expect(text).not.toContain("term ▸");
    expect(text).not.toContain("run ▸");
    // Rig-wide: the SHAPE, not one seat's address standing in for the whole rig.
    expect(text).toContain(`rig capture|send <seat>@${REMOTE_RIG}@${REMOTE_HOST}`);
    const acts = (screen.contentTargets ?? []).flatMap((t) => ("action" in t && t.action ? [t.action] : []));
    expect(acts.filter((a) => a.type === "act" && (a as { act?: string }).act === "open-terminal")).toEqual([]);
  });

  it("prints the address on the seat page in place of the local attach/terminal actions", async () => {
    const { snap } = await remoteSeat();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "host", name: REMOTE_HOST });
    view.dispatch({ type: "drill", resource: "rig", name: REMOTE_RIG, target: { host: REMOTE_HOST } });
    view.dispatch({ type: "drill", resource: "agent", name: "dev.impl", target: { host: REMOTE_HOST, rig: REMOTE_RIG, pod: "dev" } });
    const text = renderScreen(view.get(), snap, { cols: 150, rows: 60 }, "").lines.join("\n");

    expect(text).toContain(`rig capture|send dev-impl@${REMOTE_RIG}@${REMOTE_HOST}`);
    expect(text).not.toContain("Open terminals");
    // The remote daemon's tmux attach command cannot run here, so it is not shown.
    expect(text).not.toContain("tmux attach-session -t team-a");
  });
});

describe("who pays for the read that names the remote hosts", () => {
  it("a hub (no rigs of its own) shows its remote hosts on the TABLE tab, not only in PULSE", async () => {
    // Drilling a host switches the view to the table tab. If the host list came only
    // from the PULSE-scoped aggregate, the host would vanish the moment it was opened.
    const { client, routes } = hubClient();
    const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({ viewTab: "table", expanded: [`host:${REMOTE_HOST}`] }));

    expect(routes).toContain("/api/queue/attention-aggregate");
    const host = snap.hosts.find((h) => h.name === REMOTE_HOST);
    expect(host).toMatchObject({ remote: true, reachable: true });
    expect(host!.rigs.map((r) => r.name)).toEqual([REMOTE_RIG]);
  });

  it("a machine that runs its own rigs never pays for it", async () => {
    const routes: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      routes.push(route);
      if (route === "/api/queue/attention-aggregate") throw new Error("a rig-running host must not fan out here");
      if (route === "/api/rigs/summary") return { ok: true, json: async () => [{ id: "01JRIG", name: "myrig", lifecycleState: "running" }] } as Response;
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      throw new Error(`unexpected route in test: ${route}`);
    }) as typeof fetch;

    const snap = await hydrateSnapshot(new DaemonClient({ baseUrl: "http://x", fetchImpl }), undefined, undefined, undefined, undefined, pulse({ viewTab: "table" }));
    expect(routes).not.toContain("/api/queue/attention-aggregate");
    expect(snap.hosts.map((h) => h.name)).toEqual(["hub-0"]);
    expect(snap.hosts[0]!.rigs.map((r) => r.name)).toEqual(["myrig"]);
  });

  it("a hub whose aggregate read fails keeps its local host and names the failure", async () => {
    // On a hub this read is the only source of every remote host. A quiet failure emptied the
    // whole fleet from the view with nothing on screen to say why.
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      if (route === "/api/queue/attention-aggregate") return { ok: false, status: 503, json: async () => ({}) } as Response;
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      throw new Error(`unexpected route in test: ${route}`);
    }) as typeof fetch;

    const snap = await hydrateSnapshot(new DaemonClient({ baseUrl: "http://x", fetchImpl }), undefined, undefined, undefined, undefined, pulse({ viewTab: "table" }));
    expect(snap.hosts.map((h) => h.name)).toEqual(["hub-0"]);
    expect(snap.readErrors).toEqual([expect.stringContaining("attention-aggregate")]);
  });
});

describe("how long a hub's aggregate read waits", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The wait each route was given, read from the AbortSignal its request carried. */
  function timedHub(): { client: DaemonClient; waits: Map<string, number> } {
    const ms = new WeakMap<AbortSignal, number>();
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((t: number) => { const signal = real(t); ms.set(signal, t); return signal; });
    const waits = new Map<string, number>();
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("http://x", "");
      if (init?.signal) waits.set(route, ms.get(init.signal) ?? -1);
      if (!(route in FIXTURES)) throw new Error(`unexpected route in test: ${route}`);
      return { ok: true, json: async () => FIXTURES[route] } as Response;
    }) as typeof fetch;
    return { client: new DaemonClient({ baseUrl: "http://x", fetchImpl }), waits };
  }

  it("outlasts one team taking its whole 5 s budget, on the topology table and in PULSE", async () => {
    // The hub gives each team 5 s and answers a moment after that, with the slow team marked
    // unreachable. A reader on the client's 5 s default gave up first and lost every host.
    for (const view of [pulse({ viewTab: "table" }), pulse()]) {
      const { client, waits } = timedHub();
      const snap = await hydrateSnapshot(client, undefined, undefined, undefined, undefined, view);
      expect(waits.get("/api/queue/attention-aggregate")).toBeGreaterThanOrEqual(20_000);
      expect(snap.hosts.map((h) => h.name)).toContain(REMOTE_HOST);
      vi.restoreAllMocks();
    }
  });

  it("grows with the hosts the last fleet read named", async () => {
    const { client, waits } = timedHub();
    const targetedHostIds = ["local", ...Array.from({ length: 13 }, (_, i) => `t-${i}`)];
    await hydrateSnapshot(client, undefined, undefined, undefined, undefined, pulse({ viewTab: "table" }),
      { last: { targetedHostIds } as never, lastUsage: null });
    // Fourteen hosts at four at a time is four waves of 5 s, plus the reader's margin.
    expect(waits.get("/api/queue/attention-aggregate")).toBe(30_000);
  });
});

describe("the explorer tree discloses remote levels", () => {
  /** The real loop: the view's own expanded list drives hydrate, and the same view
   * renders the tree. PULSE is where a hub operator lives, and it keeps the sidebar. */
  function hubView() {
    const { client, routes } = hubClient();
    let snap = emptySnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "tab", tab: "pulse" });
    const refresh = () => hydrateSnapshot(client, undefined, undefined, undefined, undefined, view.get()).then((s) => { snap = s; return s; });
    const rows = () => computeExplorerRows(view.get(), snap).map((r) => r.label.trim());
    const open = (key: string) => view.dispatch({ type: "toggle-expand", key });
    return { routes, view, refresh, rows, open };
  }

  it("shows a reachable remote host collapsed and an unreachable one with no control", async () => {
    const t = hubView();
    await t.refresh();
    const rows = t.rows();

    expect(rows.find((l) => l.includes("hub-0"))).toBe("▾ hub-0");
    expect(rows.find((l) => l.includes(REMOTE_HOST))).toBe(`▸ ${REMOTE_HOST}`);
    // An unreachable host has nothing behind it: no disclosure, no children, no read.
    expect(rows.find((l) => l.includes(DEAD_HOST))).toBe(`• ${DEAD_HOST} (unreachable)`);
    expect(t.routes.filter((r) => r.includes(`?host=${DEAD_HOST}`))).toEqual([]);
    expect(rows.some((l) => l.includes(REMOTE_RIG))).toBe(false);
  });

  it("opening the host reveals its rigs and costs exactly the rigs read", async () => {
    const t = hubView();
    await t.refresh();
    t.open(`host:${REMOTE_HOST}`);
    await t.refresh();

    expect(t.rows().find((l) => l.includes(REMOTE_HOST))).toBe(`▾ ${REMOTE_HOST}`);
    expect(t.rows().find((l) => l.includes(REMOTE_RIG))).toBe(`▸ ${REMOTE_RIG}`);
    expect(t.routes.filter((r) => r.includes("?host="))).toEqual([`/api/rigs/summary?host=${REMOTE_HOST}`]);
  });

  it("opening the rig reveals its pods, and a pod still gates the seats", async () => {
    const t = hubView();
    await t.refresh();
    t.open(`host:${REMOTE_HOST}`);
    t.open(`rig:${REMOTE_HOST}/${REMOTE_RIG}`);
    await t.refresh();
    const rows = t.rows();

    expect(rows.find((l) => l.includes(REMOTE_RIG))).toBe(`▾ ${REMOTE_RIG}`);
    expect(rows.some((l) => l.includes("dev (2)"))).toBe(true);
    // Pods stay collapsed exactly as local pods do.
    expect(rows.some((l) => l.includes("dev.impl"))).toBe(false);
    expect(t.routes).toContain(`/api/rigs/${REMOTE_RIG_ID}/nodes?host=${REMOTE_HOST}`);
  });

  it("closing a host again stops paying for its reads", async () => {
    const t = hubView();
    await t.refresh();
    t.open(`host:${REMOTE_HOST}`);
    await t.refresh();
    t.open(`host:${REMOTE_HOST}`);
    const snap = await t.refresh();

    expect(t.rows().find((l) => l.includes(REMOTE_HOST))).toBe(`▸ ${REMOTE_HOST}`);
    expect(snap.hosts.find((h) => h.name === REMOTE_HOST)!.rigs).toEqual([]);
    // One rigs read total: the collapse did not trigger a second one.
    expect(t.routes.filter((r) => r.includes(`?host=${REMOTE_HOST}`))).toEqual([`/api/rigs/summary?host=${REMOTE_HOST}`]);
  });
});
