import { describe, expect, it } from "vitest";
import { buildPulseModel, hostLabel } from "../src/pulse/pulse-model.js";
import type { PulseExceptionSection } from "../src/pulse/pulse-model.js";
import { renderExceptionSection, renderPulseView, pulseLaneTargets } from "../src/pulse/render-pulse.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, NeedsItem, QueueRead } from "../src/types.js";

// Cross-host PULSE — the hub must show what the OTHER hosts owe, and stay exactly
// as it was for an operator who has no remote hosts. Every assertion here is made on
// the rendered row text, because the `[host]` label and the resolve address are what
// an operator actually reads; a model-only assertion would pass on a row that never
// reaches the screen.

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;

/** Every queue and exception source PROVEN EMPTY, so each test opts into exactly the
 * rows it is about (the discipline pulse-live.test.ts established). */
function quietSnap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    ...demoSnapshot(),
    attention: [], blocked: [], inProgress: [], pending: [], recentlyFinished: [],
    needs: [], fleetQueue: [], hostsDown: [], seatActivity: [],
    ...over,
  };
}

const queueRow = (over: Partial<QueueRead>): QueueRead => ({
  qitemId: "q",
  state: "pending",
  destinationSession: "dev-a@rig-x",
  blockedOn: null,
  handedOffTo: null,
  tier: null,
  tags: null,
  summary: null,
  body: "",
  claimedAt: null,
  tsUpdated: ago(0),
  ...over,
});

const fleetNeed = (over: Partial<NeedsItem>): NeedsItem => ({
  source: "agent",
  kind: "human-routed",
  target: "human-yeah@kernel",
  detail: "should HUBTEST-B.md become NOTES.md?",
  hostId: "t-hubtest-b",
  qitemId: "qitem-remote-1",
  ageIso: ago(22 * MIN),
  ...over,
});

const HUMAN = "human-yeah@kernel";

/** A queue row from the cross-host read. hydrate stamps `hostId` on every row it
 * keeps (and drops the ones it does not), so a fixture standing in for
 * `snap.fleetQueue` carries it the same way. */
const remoteRow = (over: Partial<QueueRead>): QueueRead => queueRow({ hostId: "t-hubtest-b", ...over });

function section(model: ReturnType<typeof buildPulseModel>, label: string): PulseExceptionSection | undefined {
  return model.exceptions.find((s) => s.label === label);
}

/** The section as the operator sees it: one rendered line per entry. */
function rendered(sec: PulseExceptionSection | undefined): string {
  return sec ? renderExceptionSection(sec).map((l) => l.text).join("\n") : "";
}

const laneLabels = (model: ReturnType<typeof buildPulseModel>, lane: number) =>
  model.lanes[lane].rows.map((r) => r.label);

describe("▲ NEEDS YOU across hosts", () => {
  it("shows a remote fleet needs-you item with its [host] label", () => {
    const model = buildPulseModel(quietSnap({ needs: [fleetNeed({})] }), NOW);
    const text = rendered(section(model, "NEEDS YOU"));
    expect(text).toContain("▲ NEEDS YOU (1)");
    expect(text).toContain(`${hostLabel("t-hubtest-b")} should HUBTEST-B.md become NOTES.md?`);
    expect(text).toContain("22m");
  });

  it("keeps the local attention rows it already showed, and does NOT repeat them", () => {
    // The fleet read includes the local host, so the same local qitem arrives on both
    // reads. One row, and no label on it — it is the operator's own machine.
    const model = buildPulseModel(quietSnap({
      attention: [queueRow({ qitemId: "q-local", state: "pending", destinationSession: "human-yeah@kernel", summary: "0.5.0 cut packet ready — waiting on you", claimedAt: ago(3 * HR) })],
      needs: [
        fleetNeed({ hostId: "local", qitemId: "q-local", detail: "0.5.0 cut packet ready — waiting on you", ageIso: ago(3 * HR) }),
        fleetNeed({ hostId: "t-hubtest-a", qitemId: "qitem-remote-a", detail: "team A needs a decision", ageIso: ago(5 * MIN) }),
      ],
    }), NOW);
    const sec = section(model, "NEEDS YOU");
    expect(sec!.rows.length).toBe(2);
    const text = rendered(sec);
    expect(text).toContain("▲ NEEDS YOU (2)");
    expect(text).toContain("0.5.0 cut packet ready");
    expect(text).toContain(`${hostLabel("t-hubtest-a")} team A needs a decision`);
    // the local row is the FIRST one and carries no provenance label
    expect(sec!.rows[0]!.host).toBeUndefined();
    expect(text).not.toContain("[local]");
  });

  it("shows a remote item's age from the age the host's own composer stamped", () => {
    const model = buildPulseModel(quietSnap({ needs: [fleetNeed({ ageIso: ago(2 * HR) })] }), NOW);
    expect(rendered(section(model, "NEEDS YOU"))).toContain("2h");
    // an undated remote row renders no age rather than a invented one
    const undated = buildPulseModel(quietSnap({ needs: [fleetNeed({ ageIso: null })] }), NOW);
    expect(rendered(section(undated, "NEEDS YOU"))).not.toMatch(/· \d+[smhd]\b/);
  });
});

describe("a remote row offers the address instead of an action", () => {
  it("park-on-human: prints a resolve command that RUNS AS PRINTED, on the owning host", () => {
    // `--decision` is a requiredOption on the CLI, so an address without it fails in
    // commander before it ever reaches the daemon.
    const model = buildPulseModel(quietSnap({
      needs: [fleetNeed({ kind: "park-on-human", qitemId: "qitem-20261023131724-7ed2c7733cf4eaa0" })],
    }), NOW);
    const lines = renderExceptionSection(section(model, "NEEDS YOU")!).map((l) => l.text);
    expect(lines.length).toBe(3); // header + the row + its address line
    expect(lines[2]).toContain('on t-hubtest-b: rig queue resolve qitem-20261023131724-7ed2c7733cf4eaa0 --decision "<answer>"');
  });

  it("human-routed: prints the non-mutating read, because there is nothing to resolve", () => {
    // A pending row addressed to a human seat is not a leg-1 park; `resolve` does not
    // apply to it and would refuse.
    const model = buildPulseModel(quietSnap({
      needs: [fleetNeed({ kind: "human-routed", qitemId: "qitem-20261023140000-abcdef0123456789" })],
    }), NOW);
    const lines = renderExceptionSection(section(model, "NEEDS YOU")!).map((l) => l.text);
    expect(lines[2]).toContain("on t-hubtest-b: rig queue show qitem-20261023140000-abcdef0123456789");
    expect(lines[2]).not.toContain("resolve");
  });

  it("prints no address line for a row with no actionable qitem (a derived exception)", () => {
    const model = buildPulseModel(quietSnap({ needs: [fleetNeed({ kind: "stuck", qitemId: null, detail: "team A lead looks stuck — idle 47m >= 30m" })] }), NOW);
    expect(renderExceptionSection(section(model, "NEEDS YOU")!).length).toBe(2); // header + row
  });

  it("keeps the lane hit-spans correct when an address line is present", () => {
    // pulseLaneTargets derives the lane block's first line from the rendered height
    // of the exception strip; an extra address line must shift it, not desync it.
    const lanes = { pending: [queueRow({ qitemId: "p1", state: "pending", destinationSession: HUMAN, summary: "backlog" })] };
    const without = buildPulseModel(quietSnap(lanes), NOW);
    const withHint = buildPulseModel(quietSnap({ ...lanes, needs: [fleetNeed({})] }), NOW);
    // the whole NEEDS YOU section appears (header + row + address) where there was none
    expect(renderPulseView(withHint).length - renderPulseView(without).length).toBe(3);
    expect(pulseLaneTargets(withHint)[0]!.lineIndex).toBe(pulseLaneTargets(without)[0]!.lineIndex + 3);
  });
});

describe("blocked, in progress and pending across hosts", () => {
  // Every fixture here is ATTENTION-class — destined for a human seat — because that
  // is the only class the aggregate can deliver (listAttention: human-destined, or
  // blocked on a human). An agent-destined fixture would prove a path production
  // cannot reach.
  it("⧗ BLOCKED ON AGENTS shows a remote row with its [host] label", () => {
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-blocked", state: "blocked", destinationSession: HUMAN, blockedOn: "qitem-review-blocker", summary: "terminal verdict for the matrix", claimedAt: ago(1 * HR) })],
    }), NOW);
    const text = rendered(section(model, "BLOCKED ON AGENTS"));
    expect(text).toContain("⧗ BLOCKED ON AGENTS (1)");
    expect(text).toContain(`${hostLabel("t-hubtest-b")} ${HUMAN} blocked on qitem-review-blocker`);
  });

  it("○ UP NEXT shows a remote unclaimed row with its [host] label", () => {
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-pending", state: "pending", destinationSession: HUMAN, summary: "51-02 scenario runner" })],
    }), NOW);
    expect(laneLabels(model, 2)).toContain(`${hostLabel("t-hubtest-b")} 51-02 scenario runner`);
  });

  it("does not duplicate a local row the aggregate also carried (hydrate drops the local leg)", () => {
    // quietSnap carries fleetQueue ONLY with remote rows — hydrate.toFleetQueueRead
    // drops anything stamped `local`, so a local row can only arrive once. Asserted
    // at the join: one local pending row plus one remote one is two rows, not three.
    const model = buildPulseModel(quietSnap({
      pending: [queueRow({ qitemId: "q-local-pending", state: "pending", destinationSession: HUMAN, summary: "local backlog" })],
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-pending", state: "pending", destinationSession: HUMAN, summary: "remote backlog" })],
    }), NOW);
    expect(model.lanes[2].count).toBe(2);
    expect(laneLabels(model, 2)).toEqual(["local backlog", `${hostLabel("t-hubtest-b")} remote backlog`]);
  });

  it("drops a cross-host row whose qitem a local read already carries", () => {
    // The hardening case: a host that subscribes ITSELF stamps its rows with its own
    // id rather than the sentinel, so hydrate's sentinel filter lets them through and
    // the same qitem would appear in UP NEXT twice — once bare, once labelled.
    const model = buildPulseModel(quietSnap({
      pending: [queueRow({ qitemId: "q-same", state: "pending", destinationSession: HUMAN, summary: "the same work" })],
      fleetQueue: [remoteRow({ qitemId: "q-same", state: "pending", destinationSession: HUMAN, summary: "the same work" })],
    }), NOW);
    expect(model.lanes[2].count).toBe(1);
    expect(laneLabels(model, 2)).toEqual(["the same work"]);
  });

  it("does not show the same remote row twice — NEEDS YOU wins, as it does locally", () => {
    // A qitem parked on a human is BOTH a needs-you row and a blocked row. The local
    // join already resolves that by keeping it under NEEDS YOU; the remote join obeys
    // the same rule instead of inventing its own.
    const snap = quietSnap({
      needs: [fleetNeed({ kind: "park-on-human", qitemId: "qitem-parked-on-human", detail: "should this become NOTES.md?" })],
      fleetQueue: [remoteRow({ qitemId: "qitem-parked-on-human", state: "blocked", destinationSession: HUMAN, blockedOn: "human@host" })],
    });
    const model = buildPulseModel(snap, NOW);
    expect(section(model, "NEEDS YOU")!.rows.length).toBe(1);
    expect(section(model, "BLOCKED ON AGENTS")).toBeUndefined();
  });

  it("keeps a remote in-progress row out of PARKED and NOW entirely", () => {
    // Both joins look the row up in the LOCAL seatActivity by bare destinationSession
    // and ignore the host, and seatActivity holds only agent seats — so an attention-
    // class (human-destined) remote row can never join honestly. A coincidental name
    // match across hosts would paint a remote host's work under a LOCAL seat with no
    // [host] label, which is worse than silence.
    const model = buildPulseModel(quietSnap({
      seatActivity: [{ session: "dev-a@rig-x", logicalId: "dev.a", terminalActive: false, lastActivityAt: ago(60 * MIN) }],
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-inprog", state: "in-progress", destinationSession: "dev-a@rig-x", summary: "remote work", claimedAt: ago(50 * MIN) })],
    }), NOW);
    expect(section(model, "PARKED WITH BATON")).toBeUndefined();
    expect(model.lanes[0].rows).toEqual([]);
  });
});

describe("✕ HOSTS DOWN is rendered", () => {
  it("renders the served hostId, status and error verbatim", () => {
    const model = buildPulseModel(quietSnap({
      hostsDown: [{ hostId: "t-hubtest-a", status: "unreachable", error: "read timed out after 5000ms" }],
    }), NOW);
    const text = rendered(section(model, "HOSTS DOWN"));
    expect(text).toContain("✕ HOSTS DOWN (1)");
    expect(text).toContain("t-hubtest-a — unreachable");
    expect(text).toContain("read timed out after 5000ms");
  });

  it("leaves LOCAL rig-down rows out — they are rigs, not hosts", () => {
    // hydrate composes rig-down BESIDE host-down in the SAME snapshot field, so the
    // section has to tell them apart. A recoverable local rig is a normal state on an
    // ordinary machine; showing it as a red HOSTS DOWN would put a red section on a
    // PULSE that has no remote host at all.
    const model = buildPulseModel(quietSnap({
      hostsDown: [{ hostId: "rig:downrig", status: "recoverable (down)", error: "0/2 seats running" }],
    }), NOW);
    expect(section(model, "HOSTS DOWN")).toBeUndefined();
  });

  it("shows only the host leg when a host is down AND a local rig is down", () => {
    const model = buildPulseModel(quietSnap({
      hostsDown: [
        { hostId: "t-hubtest-a", status: "unreachable", error: "read timed out after 5000ms" },
        { hostId: "rig:kernel", status: "recoverable" },
      ],
    }), NOW);
    const text = rendered(section(model, "HOSTS DOWN"));
    expect(text).toContain("✕ HOSTS DOWN (1)");
    expect(text).not.toContain("rig:kernel");
  });
});

describe("an operator with no remote hosts sees no change", () => {
  it("adds no section and no label when nothing is remote and nothing is down", () => {
    const local = quietSnap({
      attention: [queueRow({ qitemId: "q1", state: "pending", destinationSession: "human-yeah@kernel", summary: "0.5.0 cut packet ready — waiting on you", claimedAt: ago(22 * MIN) })],
      blocked: [queueRow({ qitemId: "b1", state: "blocked", destinationSession: "dev-a@rig-x", blockedOn: "qitem-blocker", summary: "verdict", claimedAt: ago(1 * HR) })],
      needs: [fleetNeed({ hostId: "local" })],
    });
    const model = buildPulseModel(local, NOW);
    const labels = model.exceptions.map((s) => s.label);
    expect(labels).toEqual(["NEEDS YOU", "BLOCKED ON AGENTS"]);
    expect(labels).not.toContain("HOSTS DOWN");
    for (const sec of model.exceptions) {
      expect(rendered(sec)).not.toContain("[");
      expect(sec.rows.every((r) => r.host === undefined)).toBe(true);
    }
  });

  it("opens no HOSTS DOWN section for a stopped or recoverable LOCAL rig with no remote host", () => {
    // Regression guard: this is an ordinary laptop with no hosts subscribed at
    // all, and the rig summary really does report recoverable rigs. Such an operator
    // must see nothing new.
    const model = buildPulseModel(quietSnap({
      hostsDown: [
        { hostId: "rig:kernel", status: "recoverable" },
        { hostId: "rig:claude-trio", status: "recoverable" },
      ],
    }), NOW);
    expect(model.exceptions.map((s) => s.label)).toEqual([]);
  });

  it("keeps an empty strip silent rather than opening a new empty section", () => {
    const model = buildPulseModel(quietSnap(), NOW);
    expect(model.exceptions).toEqual([]);
  });
});
