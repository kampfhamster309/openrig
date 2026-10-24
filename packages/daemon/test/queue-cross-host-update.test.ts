// `rig queue update --host` and the truthful relay stamp.
//
// The load-bearing pins:
//   - no hostId / "local" = today's local write byte-for-byte (zero regression for local use);
//   - a registered remote host FORWARDS to the origin's own /update route with hostId stripped,
//     and writes NOTHING local (the origin's row is the record — same rule as create/handoff);
//   - the actor is RE-STAMPED from THIS daemon's authenticated context, exactly like the shipped
//     mission-control forward: the body's actor claim is stripped, so a caller cannot put a forged
//     actor on another host's ledger;
//   - the resolve forward records WHERE the answer was issued — the hub's own host id, stamped
//     server-side, and a caller-supplied value for that key is overwritten, never trusted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { RELAY_AUDIT_KEY } from "../src/routes/relay-origin.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "team-pod", transport: "http", url: "http://team-pod:7433", bearer_env: "RR36" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};
process.env["RR36"] = "remote-token";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

interface Capture { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> }

function makeQueueApp(db: Database.Database, bus: EventBus, fetchImpl?: typeof fetch): Hono {
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", queueRepo);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (fetchImpl) set("remoteFetchImpl", fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

function makeMissionControlApp(fetchImpl?: typeof fetch): { app: Hono; localActs: unknown[] } {
  const localActs: unknown[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("missionControlWriteContract", {
      act: async (req: unknown) => { localActs.push(req); return { ok: true, actionId: "local-act-1" }; },
    });
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (fetchImpl) set("remoteFetchImpl", fetchImpl);
    set("eventBus", { emit: () => {} });
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes({ bearerToken: null }));
  return { app, localActs };
}

function capturing(capture: Capture): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capture.headers = init?.headers as Record<string, string>;
    return jsonResponse({ qitemId: "qitem-origin-1", state: "in-progress" });
  }) as unknown as typeof fetch;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function transitions(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_transitions").get() as { c: number }).c;
}

describe("cross-host queue update (route)", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    bus = new EventBus(db);
  });
  afterEach(() => { db.close(); setSelfHostId(null); });

  async function seed(qitemId = "qitem-local-1"): Promise<void> {
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    await repo.create({ qitemId, sourceSession: "orch@rig-a", destinationSession: "dev@rig-a", body: "held work" });
  }

  function postUpdate(app: Hono, qitemId: string, body: Record<string, unknown>, session?: string) {
    return app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("no hostId: the local write runs and records the transition locally", async () => {
    await seed();
    const app = makeQueueApp(db, bus);
    const res = await postUpdate(app, "qitem-local-1", { state: "in-progress", transitionNote: "picked up" }, "dev@rig-a");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("in-progress");
    expect(transitions(db)).toBeGreaterThan(0);
  });

  it('hostId "local": the local write runs, nothing is forwarded', async () => {
    await seed();
    let forwarded = false;
    const app = makeQueueApp(db, bus, (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch);
    const res = await postUpdate(app, "qitem-local-1", { hostId: "local", state: "in-progress" }, "dev@rig-a");
    expect(res.status).toBe(200);
    expect(forwarded).toBe(false);
    expect(transitions(db)).toBeGreaterThan(0);
  });

  it("a --host write forwards to the ORIGIN's update route, strips hostId, and writes nothing local", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    const res = await postUpdate(app, "qitem-remote-1", {
      hostId: "team-pod", state: "done", closureReason: "no-follow-on", transitionNote: "closed from the hub",
    }, "orch@rig-a");
    expect(res.status).toBe(200);
    expect(capture.url).toContain("/api/queue/qitem-remote-1/update");
    expect(capture.body).not.toHaveProperty("hostId");
    expect(capture.body).toMatchObject({ state: "done", closureReason: "no-follow-on", transitionNote: "closed from the hub" });
    // The origin's row is the record: the hub wrote no transition of its own.
    expect(transitions(db)).toBe(0);
  });

  it("re-stamps the actor from THIS daemon's transport identity and strips the body claim", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    await postUpdate(app, "qitem-remote-1", { hostId: "team-pod", state: "in-progress", actorSession: "orch@rig-a" }, "orch@rig-a");
    expect(capture.body).not.toHaveProperty("actorSession");
    // F9: a bare `member@rig` on the team reads as one of the TEAM's seats. A hub seat crosses
    // qualified with the hub's own id — the shipped "came from that host" form.
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("orch@rig-a@hub-1");
    expect(headerOf(capture.headers, "X-OpenRig-Relay")).toBe("hub-1");
    expect(headerOf(capture.headers, "X-OpenRig-Provenance")).toBe("transport:v1");
  });

  it("leaves a HUMAN-seat ref unqualified: it is host-independent, and a 3-part ref is not human-class", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    await postUpdate(app, "qitem-remote-1", { hostId: "team-pod", state: "in-progress" }, "human@host");
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("human@host");
  });

  it("with no self host id, forwards the actor unqualified rather than inventing a host", async () => {
    setSelfHostId(null);
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    await postUpdate(app, "qitem-remote-1", { hostId: "team-pod", state: "in-progress" }, "orch@rig-a");
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("orch@rig-a");
    expect(headerOf(capture.headers, "X-OpenRig-Relay")).toBe("unknown");
  });

  it("a forwarded update CANNOT carry a forged actor: the wire decides, the body claim is dropped", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    // A caller tries to attribute the write to a seat it is not: header says one principal, body says
    // another. P18 ruling A — the wire supersedes; the forward then strips the claim entirely, so the
    // origin never sees the forged name at all.
    const res = await postUpdate(app, "qitem-remote-1",
      { hostId: "team-pod", state: "done", closureReason: "no-follow-on", actorSession: "innocent.leader@team-rig" },
      "operator-human@kernel");
    expect(res.status).toBe(200);
    expect(capture.body).not.toHaveProperty("actorSession");
    expect(JSON.stringify(capture.body)).not.toContain("innocent.leader@team-rig");
    // The wire's principal crosses, re-qualified with the hub's id (F9) — `operator-human@kernel` is
    // not the human-seat shape (`human…@kernel`), so it is treated as a seat and cannot arrive on the
    // team looking like one of its own.
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("operator-human@kernel@hub-1");
  });

  it("a seatless caller's declared human actor crosses as claimed:v1 — never laundered up to verified", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const app = makeQueueApp(db, bus, capturing(capture));
    const res = await postUpdate(app, "qitem-remote-1",
      { hostId: "team-pod", state: "in-progress", actorSession: "human@host" });
    expect(res.status).toBe(200);
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("human@host");
    expect(headerOf(capture.headers, "X-OpenRig-Provenance")).toBe("claimed:v1");
  });

  it("an unknown host is a structured host-named failure with nothing written locally", async () => {
    const app = makeQueueApp(db, bus);
    const res = await postUpdate(app, "qitem-remote-1", { hostId: "nowhere", state: "in-progress" }, "dev@rig-a");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string; hostId: string }).error).toBe("remote_queue_write_failed");
    expect(transitions(db)).toBe(0);
  });
});

describe("the resolve forward records which host answered", () => {
  afterEach(() => setSelfHostId(null));

  it("with no self host id, a caller's ONLY key is the forged one: it is dropped, not forwarded", async () => {
    // F2. The strip must not hand back the caller's object when nothing is left to stamp — that is
    // precisely the case where the object contains only the forged claim.
    setSelfHostId(null);
    const capture: Capture = {};
    const { app } = makeMissionControlApp(capturing(capture));
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verb: "resolve", qitemId: "qitem-remote-1", decision: "ship it", hostId: "team-pod",
        actorSession: "human@host", auditNotes: { [RELAY_AUDIT_KEY]: { from_host: "forged" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(capture.body ?? "")).not.toContain("forged");
    expect(capture.body).not.toHaveProperty("auditNotes");
  });

  it("a LOCAL resolve strips a caller's relay claim: this path is not a relay hop (F3)", async () => {
    const { app, localActs } = makeMissionControlApp();
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verb: "resolve", qitemId: "qitem-local-1", decision: "ship it", actorSession: "human@host",
        auditNotes: { [RELAY_AUDIT_KEY]: { from_host: "somewhere-flattering" }, mine: "kept" },
      }),
    });
    expect(res.status).toBe(200);
    const acted = localActs[0] as { auditNotes?: Record<string, unknown> };
    expect(acted.auditNotes).toEqual({ mine: "kept" });
  });

  it("a request that ARRIVED relayed keeps its relay note — it came from a forwarding hub", async () => {
    const { app, localActs } = makeMissionControlApp();
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Relay": "hub-1", "X-OpenRig-Provenance": "transport:v1" },
      body: JSON.stringify({
        verb: "resolve", qitemId: "qitem-local-1", decision: "ship it", actorSession: "human@host",
        auditNotes: { [RELAY_AUDIT_KEY]: { from_host: "hub-1" } },
      }),
    });
    expect(res.status).toBe(200);
    const acted = localActs[0] as { auditNotes?: Record<string, unknown> };
    expect(acted.auditNotes).toEqual({ [RELAY_AUDIT_KEY]: { from_host: "hub-1" } });
  });

  it("a SEAT caller on the hub crosses QUALIFIED, not as one of the team's own seats (R1)", async () => {
    // The MC forward is the path `resolve --host` and the TUI `answer` actually take, so this is the
    // main path, not an edge: `canonicalSenderSession` has already stripped THIS hub's own suffix, and
    // a bare `member@rig` arriving on the team reads as a seat the team has never had.
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const { app } = makeMissionControlApp(capturing(capture));
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch-lead@rigA" },
      body: JSON.stringify({ verb: "resolve", qitemId: "qitem-remote-1", decision: "ship it", hostId: "team-pod" }),
    });
    expect(res.status).toBe(200);
    expect(headerOf(capture.headers, "X-OpenRig-Session")).toBe("orch-lead@rigA@hub-1");
    expect(headerOf(capture.headers, "X-OpenRig-Provenance")).toBe("transport:v1");
  });

  it("a relayed arrival whose note names ANOTHER host than the relay header is stripped (R3)", async () => {
    // Otherwise anyone who can set X-OpenRig-Relay can park any `from_host` they like on the row.
    const { app, localActs } = makeMissionControlApp();
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Relay": "hub-1", "X-OpenRig-Provenance": "transport:v1" },
      body: JSON.stringify({
        verb: "resolve", qitemId: "qitem-local-1", decision: "ship it", actorSession: "human@host",
        auditNotes: { [RELAY_AUDIT_KEY]: { from_host: "somewhere-flattering" }, mine: "kept" },
      }),
    });
    expect(res.status).toBe(200);
    const acted = localActs[0] as { auditNotes?: Record<string, unknown> };
    expect(acted.auditNotes).toEqual({ mine: "kept" });
  });

  it("stamps the hub's own host id into the forwarded audit notes", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const { app, localActs } = makeMissionControlApp(capturing(capture));
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "resolve", qitemId: "qitem-remote-1", decision: "ship it", hostId: "team-pod", actorSession: "human@host" }),
    });
    expect(res.status).toBe(200);
    expect(localActs).toHaveLength(0);
    const notes = capture.body?.["auditNotes"] as Record<string, Record<string, string>>;
    expect(notes[RELAY_AUDIT_KEY]).toEqual({ from_host: "hub-1" });
  });

  it("OVERWRITES a caller-supplied relay note — a client cannot choose which host it answered from", async () => {
    setSelfHostId("hub-1");
    const capture: Capture = {};
    const { app } = makeMissionControlApp(capturing(capture));
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verb: "resolve", qitemId: "qitem-remote-1", decision: "ship it", hostId: "team-pod", actorSession: "human@host",
        auditNotes: { [RELAY_AUDIT_KEY]: { from_host: "somewhere-flattering" }, mine: "kept" },
      }),
    });
    expect(res.status).toBe(200);
    const notes = capture.body?.["auditNotes"] as Record<string, Record<string, string>>;
    expect(notes[RELAY_AUDIT_KEY]).toEqual({ from_host: "hub-1" });
    expect(notes["mine"]).toBe("kept");
  });

  it("a local resolve carries no relay stamp — nothing changed for local use", async () => {
    const { app, localActs } = makeMissionControlApp();
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "resolve", qitemId: "qitem-local-1", decision: "ship it", actorSession: "human@host" }),
    });
    expect(res.status).toBe(200);
    expect(localActs).toHaveLength(1);
    expect((localActs[0] as { auditNotes?: unknown }).auditNotes).toBeUndefined();
  });
});
