import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { DaemonClient, resolveQitemNotice, REMOTE_HUMAN_ACTOR } from "../src/daemon-client.js";
import { remoteHostForQitem } from "../src/pulse/pulse-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, NeedsItem, QueueRead } from "../src/types.js";

// The operator answers a remote team's park from the hub's own TUI.
// Three things must hold, and each is asserted here at the layer that decides it:
//   1. the command parses and refuses a half-answer (grammar);
//   2. the write is ROUTED by the host the fleet read served for that row, never guessed (model);
//   3. the request carries the host envelope and a HUMAN actor, so the team's daemon records a
//      person answering rather than one of its own seats (transport).

function quietSnap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    ...demoSnapshot(),
    attention: [], blocked: [], inProgress: [], pending: [], recentlyFinished: [],
    needs: [], fleetQueue: [], hostsDown: [], seatActivity: [],
    ...over,
  };
}

const REMOTE = "t-hubtest-b";
const ID = "qitem-20261023131724-7ed2c7733cf4eaa0";

const fleetNeed = (over: Partial<NeedsItem> = {}): NeedsItem => ({
  source: "agent",
  kind: "park-on-human",
  target: "human-yeah@kernel",
  detail: "should HUBTEST-B.md become NOTES.md?",
  hostId: REMOTE,
  qitemId: ID,
  ageIso: new Date().toISOString(),
  ...over,
});

const queueRow = (over: Partial<QueueRead> = {}): QueueRead => ({
  qitemId: ID,
  state: "blocked",
  destinationSession: "orch@rig-x",
  blockedOn: "human-yeah@kernel",
  handedOffTo: null,
  tier: null,
  tags: null,
  summary: null,
  body: "",
  claimedAt: null,
  tsUpdated: new Date().toISOString(),
  ...over,
});

describe("answer command (grammar)", () => {
  it("takes the id and the whole rest of the line as the decision — spaces stay literal", () => {
    expect(parseCommand(`answer ${ID} ship it, but only after the migration lands`)).toEqual({
      type: "act", act: "resolve-qitem", qitemId: ID, decision: "ship it, but only after the migration lands",
    });
  });

  it("refuses an id with no decision, because the daemon records the text verbatim", () => {
    const action = parseCommand(`answer ${ID}`);
    expect(action.type).toBe("error");
    expect((action as { message: string }).message).toContain("decision");
  });

  it("refuses anything that is not an id AND a decision", () => {
    // One token cannot be both. The daemon records the decision text verbatim and refuses an
    // empty one, so a half-answer must fail here rather than at the write.
    for (const line of ["answer", `answer ${ID}`]) {
      const action = parseCommand(line);
      expect(action.type).toBe("error");
      expect((action as { message: string }).message).toMatch(/decision|queue id/);
    }
  });
});

describe("routing an answer to the host that owns the row", () => {
  it("uses the host the fleet NEEDS YOU read carried", () => {
    expect(remoteHostForQitem(quietSnap({ needs: [fleetNeed()] }), ID)).toBe(REMOTE);
  });

  it("uses the host the cross-host attention read carried", () => {
    expect(remoteHostForQitem(quietSnap({ fleetQueue: [queueRow({ hostId: REMOTE })] }), ID)).toBe(REMOTE);
  });

  it("routes a local row here: the `local` sentinel is not a remote host", () => {
    expect(remoteHostForQitem(quietSnap({ fleetQueue: [queueRow({ hostId: "local" })] }), ID)).toBeUndefined();
    expect(remoteHostForQitem(quietSnap({ needs: [fleetNeed({ hostId: undefined })] }), ID)).toBeUndefined();
  });

  it("names no host for an id no served row carries — the daemon answers, the TUI does not guess", () => {
    expect(remoteHostForQitem(quietSnap({ needs: [fleetNeed()] }), "qitem-never-served")).toBeUndefined();
  });
});

describe("the resolve write itself", () => {
  const savedSeat = process.env.OPENRIG_SESSION_NAME;
  beforeEach(() => { delete process.env.OPENRIG_SESSION_NAME; });
  afterEach(() => {
    if (savedSeat === undefined) delete process.env.OPENRIG_SESSION_NAME;
    else process.env.OPENRIG_SESSION_NAME = savedSeat;
  });

  /** A client whose single request is captured; the daemon answers with the row unparked. */
  function capturingClient(): { client: DaemonClient; route: () => string; body: () => Record<string, unknown> } {
    const seen: { route: string; body: Record<string, unknown> } = { route: "", body: {} };
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.route = String(input);
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ actionId: "act-1", verb: "resolve", qitemId: ID, closedQitem: { qitemId: ID, state: "in-progress" } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    return { client: new DaemonClient({ baseUrl: "http://hub.test:7433", fetchImpl: impl }), route: () => seen.route, body: () => seen.body };
  }

  it("posts the one mission-control resolve path with the host envelope", async () => {
    const { client, route, body } = capturingClient();
    await client.resolveQitem(ID, "ship it", REMOTE);
    expect(route()).toBe("http://hub.test:7433/api/mission-control/action");
    expect(body()).toMatchObject({ verb: "resolve", qitemId: ID, decision: "ship it", hostId: REMOTE });
  });

  it("declares a HUMAN actor from a seatless surface, never a seat on the team's host", async () => {
    const { client, body } = capturingClient();
    await client.resolveQitem(ID, "ship it", REMOTE);
    expect(body().actorSession).toBe(REMOTE_HUMAN_ACTOR);
  });

  it("ALWAYS sends a body actor: this client sends no session header, so omitting it is a 400", async () => {
    // F1. The TUI's only headers are the terminal bearer — there is no X-OpenRig-Session to lean on,
    // so a seat's TUI must name its own seat in the body or the operator watches the answer fail.
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator-human@kernel");
    const { client, body } = capturingClient();
    await client.resolveQitem(ID, "ship it", REMOTE);
    expect(body().actorSession).toBe("operator-human@kernel");
    vi.unstubAllEnvs();
  });

  it("treats a whitespace-only seat env as no seat, not as an actor of one space", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "   ");
    const { client, body } = capturingClient();
    await client.resolveQitem(ID, "ship it", REMOTE);
    expect(body().actorSession).toBe(REMOTE_HUMAN_ACTOR);
    vi.unstubAllEnvs();
  });

  it("sends no host envelope for a local answer — the local write is byte-identical", async () => {
    const { client, body } = capturingClient();
    await client.resolveQitem(ID, "ship it");
    expect(body()).not.toHaveProperty("hostId");
  });

  it("reports the owning daemon's answer back, including which host it came from", () => {
    expect(resolveQitemNotice(ID, REMOTE, { closedQitem: { state: "in-progress" } }))
      .toBe(`answered ${ID} on host ${REMOTE} — row is now in-progress`);
    expect(resolveQitemNotice(ID, null, { closedQitem: { state: "in-progress" } }))
      .toContain("this daemon");
    expect(resolveQitemNotice(ID, REMOTE, { error: "remote_action_failed", detail: "unreachable" }))
      .toContain("answer NOT recorded");
  });

  it("surfaces the daemon's own refusal instead of a bare status (F8)", async () => {
    // A cross-host refusal comes back as a non-2xx carrying the origin's structured error. Swallowed
    // into a thrown status, the operator loses whether it was auth, unreachable, or the team refusing.
    const client = new DaemonClient({
      baseUrl: "http://hub.test:7433",
      fetchImpl: (async () => new Response(JSON.stringify({
        error: "remote_action_failed", hostId: REMOTE, failureClass: "unreachable", detail: "connect timed out",
      }), { status: 502, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
    });
    const result = await client.resolveQitem(ID, "ship it", REMOTE);
    expect(result.error).toBe("remote_action_failed");
    expect(result.detail).toBe("connect timed out");
    expect(resolveQitemNotice(ID, REMOTE, result)).toContain("connect timed out");
  });
});
