// The CLI edge of answering a remote team.
// Pins:
//   - `resolve`/`update` gain `--host`, explicit-only, and carry the host in the out-of-band
//     envelope exactly like `create --host` and `handoff --host`;
//   - WITHOUT `--host` the bodies are byte-identical to before, including the seat-env refusal —
//     local use cannot change;
//   - a cross-host write is the one case that may run with no seat env, and then the actor is the
//     human ref, so the team's row records a person answering rather than one of its own seats;
//   - a managed seat's caller still sends NO body actor: the transport header is the authority.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const HUMAN = "human@host";
const ID = "qitem-20261023131724-7ed2c7733cf4eaa0";

function makeDeps(): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: {} }; }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return { status: 200, data: { qitemId: ID, state: "in-progress" } };
        }),
        delete: vi.fn(async () => ({ status: 204, data: null })),
        postText: vi.fn(async () => ({ status: 200, data: "" })),
        postExpectText: vi.fn(async () => ({ status: 200, data: "" })),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

async function run(argv: string[]): Promise<Array<{ method: string; path: string; body?: unknown }>> {
  const { deps, calls } = makeDeps();
  const program = createProgram({ queueDeps: deps });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", ...argv]);
  } catch {
    /* a deliberate refusal exits; the caller asserts on the absence of any call */
  }
  return calls;
}

const posts = (calls: Awaited<ReturnType<typeof run>>) => calls.filter((c) => c.method === "POST");

describe("rig queue resolve --host", () => {
  const savedSeat = process.env.OPENRIG_SESSION_NAME;
  beforeEach(() => { delete process.env.OPENRIG_SESSION_NAME; });
  afterEach(() => {
    if (savedSeat === undefined) delete process.env.OPENRIG_SESSION_NAME;
    else process.env.OPENRIG_SESSION_NAME = savedSeat;
  });

  it("routes to the named host and declares a HUMAN actor when the caller has no seat env", async () => {
    const calls = posts(await run(["queue", "resolve", ID, "--decision", "ship it", "--host", "team-pod"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/mission-control/action");
    expect(calls[0]!.body).toMatchObject({
      verb: "resolve", qitemId: ID, decision: "ship it", hostId: "team-pod", actorSession: HUMAN,
    });
  });

  it("sends no body actor for a managed seat — the transport header stays the authority", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator-human@kernel");
    const calls = posts(await run(["queue", "resolve", ID, "--decision", "ship it", "--host", "team-pod"]));
    expect(calls[0]!.body).toMatchObject({ hostId: "team-pod" });
    expect(calls[0]!.body).not.toHaveProperty("actorSession");
    vi.unstubAllEnvs();
  });

  it("local resolve is unchanged: no hostId key, and still refuses without a seat env", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "operator-human@kernel");
    const calls = posts(await run(["queue", "resolve", ID, "--decision", "ship it"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty("hostId");
    expect(calls[0]!.body).not.toHaveProperty("actorSession");
    vi.unstubAllEnvs();

    // The shipped refusal: a seatless LOCAL caller is told, and nothing is sent.
    expect(posts(await run(["queue", "resolve", ID, "--decision", "ship it"]))).toHaveLength(0);
  });

  it('"--host local" is the local path: it keeps the local rules, including the seat-env refusal', async () => {
    expect(posts(await run(["queue", "resolve", ID, "--decision", "ship it", "--host", "local"]))).toHaveLength(0);
  });
});

describe("rig queue update --host", () => {
  const savedSeat = process.env.OPENRIG_SESSION_NAME;
  beforeEach(() => { delete process.env.OPENRIG_SESSION_NAME; });
  afterEach(() => {
    if (savedSeat === undefined) delete process.env.OPENRIG_SESSION_NAME;
    else process.env.OPENRIG_SESSION_NAME = savedSeat;
  });

  it("routes the state change to the owning host with the human actor", async () => {
    const calls = posts(await run(["queue", "update", ID, "--state", "in-progress", "--note", "hub picked it up", "--host", "team-pod"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/queue/${ID}/update`);
    expect(calls[0]!.body).toMatchObject({
      state: "in-progress", transitionNote: "hub picked it up", hostId: "team-pod", actorSession: HUMAN,
    });
  });

  it("a managed seat's local update posts exactly the body it always did", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev.build@my-rig");
    const calls = posts(await run(["queue", "update", ID, "--state", "in-progress"]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty("hostId");
    expect(calls[0]!.body).not.toHaveProperty("actorSession");
    vi.unstubAllEnvs();
  });
});
