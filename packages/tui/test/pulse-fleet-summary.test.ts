// The hub's PULSE, fed by the hub-side fleet summary.
//
// Two things had to become true, and both were refused before because the fact did
// not exist: a REMOTE in-progress row could not join ◌ PARKED (per-seat activity was
// a local-only read, so a remote owner's idleness was unknown and unknown is never
// assumed idle), and nothing on the page said "this team has been stuck for N
// minutes". The fleet read supplies both, and the old refusal is now the guard: a
// remote row may only join against a seat the hub read off THAT host.
//
// Every assertion is on rendered row text, because the `[host]` label and the
// duration are what an operator reads.

import { describe, expect, it } from "vitest";
import { buildPulseModel } from "../src/pulse/pulse-model.js";
import type { PulseExceptionSection } from "../src/pulse/pulse-model.js";
import { renderExceptionSection } from "../src/pulse/render-pulse.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, QueueRead, SeatActivitySummary } from "../src/types.js";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function quietSnap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    ...demoSnapshot(),
    attention: [], blocked: [], inProgress: [], pending: [], recentlyFinished: [],
    needs: [], fleetQueue: [], hostsDown: [], seatActivity: [],
    remoteSeatActivity: [], stalled: [], fleetProbed: false,
    ...over,
  };
}

const queueRow = (over: Partial<QueueRead>): QueueRead => ({
  qitemId: "q", state: "pending", destinationSession: "dev-a@rig-x", blockedOn: null,
  handedOffTo: null, tier: null, tags: null, summary: null, body: "", claimedAt: null,
  tsUpdated: ago(0), ...over,
});

/** A row from the cross-host queue read: `hostId` stamped, as hydrate does. */
const remoteRow = (over: Partial<QueueRead>): QueueRead => queueRow({ hostId: "t-hubtest-b", ...over });

/** A seat the hub read off another host. */
const remoteSeat = (over: Partial<SeatActivitySummary>): SeatActivitySummary => ({
  session: "dev-a@rig-x", logicalId: "dev.a", terminalActive: false,
  lastActivityAt: ago(40 * MIN), hostId: "t-hubtest-b", ...over,
});

function section(model: ReturnType<typeof buildPulseModel>, label: string): PulseExceptionSection | undefined {
  return model.exceptions.find((s) => s.label === label);
}

function rendered(sec: PulseExceptionSection | undefined): string {
  return sec ? renderExceptionSection(sec).map((l) => l.text).join("\n") : "";
}

describe("◌ PARKED WITH BATON — a remote owner can now be proven idle", () => {
  it("a remote in-progress row whose remote seat is idle joins PARKED, labelled with its host", () => {
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-park", state: "in-progress", destinationSession: "dev-a@rig-x", claimedAt: ago(50 * MIN) })],
      remoteSeatActivity: [remoteSeat({})],
      fleetProbed: true,
    }), NOW);
    const text = rendered(section(model, "PARKED WITH BATON"));
    // The label is the whole point: an unlabelled remote row would read as local work.
    expect(text).toContain("[t-hubtest-b]");
    expect(text).toContain("dev-a@rig-x");
    expect(text).toContain("40m idle");
    expect(text).toContain("no handoff");
  });

  it("a local seat of the SAME name never stands in for the remote owner", () => {
    // The failure the old code refused: the join looked up by bare session and would
    // paint a remote host's stranded baton under a local seat. Here a local idle seat
    // shares the name, and the remote row has no seat of its own — so it stays out.
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-park", state: "in-progress", destinationSession: "dev-a@rig-x" })],
      seatActivity: [{ session: "dev-a@rig-x", logicalId: "dev.a", terminalActive: false, lastActivityAt: ago(40 * MIN) }],
      remoteSeatActivity: [],
      fleetProbed: true,
    }), NOW);
    expect(section(model, "PARKED WITH BATON")).toBeUndefined();
  });

  it("a remote seat on ANOTHER host with the same name does not satisfy the join either", () => {
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-park", state: "in-progress", destinationSession: "dev-a@rig-x", hostId: "host-one" })],
      remoteSeatActivity: [remoteSeat({ hostId: "host-two" })],
      fleetProbed: true,
    }), NOW);
    expect(section(model, "PARKED WITH BATON")).toBeUndefined();
  });

  it("a remote owner that is working, or whose signal is unknown, is NOT parked", () => {
    for (const terminalActive of [true, null]) {
      const model = buildPulseModel(quietSnap({
        fleetQueue: [remoteRow({ qitemId: "qitem-remote-park", state: "in-progress" })],
        remoteSeatActivity: [remoteSeat({ terminalActive })],
        fleetProbed: true,
      }), NOW);
      expect(section(model, "PARKED WITH BATON")).toBeUndefined();
    }
  });

  it("a handed-off remote row is not a stranded baton", () => {
    const model = buildPulseModel(quietSnap({
      fleetQueue: [remoteRow({ qitemId: "qitem-remote-park", state: "in-progress", handedOffTo: "dev-b@rig-x" })],
      remoteSeatActivity: [remoteSeat({})],
      fleetProbed: true,
    }), NOW);
    expect(section(model, "PARKED WITH BATON")).toBeUndefined();
  });

  it("a local in-progress row still joins exactly as before, with no host label", () => {
    const model = buildPulseModel(quietSnap({
      inProgress: [queueRow({ qitemId: "qitem-local-park", state: "in-progress", destinationSession: "dev50.guard@openrig-build", claimedAt: ago(50 * MIN) })],
      seatActivity: [{ session: "dev50.guard@openrig-build", logicalId: "dev50.guard", terminalActive: false, lastActivityAt: ago(47 * MIN) }],
    }), NOW);
    const text = rendered(section(model, "PARKED WITH BATON"));
    expect(text).toContain("47m idle");
    expect(text).not.toContain("[");
  });
});

describe("⚑ STALLED — the hub's verdict, with the duration", () => {
  it("renders a stalled rig with its age and the threshold it was judged against", () => {
    const model = buildPulseModel(quietSnap({
      fleetProbed: true,
      stalled: [{ level: "rig", hostId: "t-hubtest-b", rigName: "team-b", openWorkCount: 3, minutesSinceProgress: 47, lastProgressAt: ago(47 * MIN), thresholdMinutes: 30 }],
    }), NOW);
    const text = rendered(section(model, "STALLED"));
    expect(text).toContain("team-b");
    expect(text).toContain("47m since last progress");
    expect(text).toContain("3 open");
    expect(text).toContain("threshold 30m");
    expect(text).toContain("[t-hubtest-b]");
  });

  it("a host with one stalled rig is ONE line, not two that differ only in the name", () => {
    // The host row and the rig row carried the same duration, the same open count and
    // the same threshold; the only difference was whether the rig name appeared. With a
    // single rig that is the same sentence twice. The rig is named, because the team is
    // the useful referent.
    const model = buildPulseModel(quietSnap({
      fleetProbed: true,
      stalled: [
        { level: "host", hostId: "t-hubtest-b", rigName: null, openWorkCount: 5, minutesSinceProgress: 61, lastProgressAt: ago(61 * MIN), thresholdMinutes: 30 },
        { level: "rig", hostId: "t-hubtest-b", rigName: "team-b", openWorkCount: 5, minutesSinceProgress: 61, lastProgressAt: ago(61 * MIN), thresholdMinutes: 30 },
      ],
    }), NOW);
    const sec = section(model, "STALLED");
    expect(sec?.rows.length).toBe(1);
    expect(sec?.rows[0].subject).toBe("team-b");
  });

  it("a host with SEVERAL stalled rigs keeps its own row — machine and teams answer different questions", () => {
    // The counterweight to the fold: with two teams the host line is not a duplicate,
    // it is the fleet-level claim that the whole box is behind.
    const model = buildPulseModel(quietSnap({
      fleetProbed: true,
      stalled: [
        { level: "host", hostId: "t-hubtest-b", rigName: null, openWorkCount: 9, minutesSinceProgress: 61, lastProgressAt: ago(61 * MIN), thresholdMinutes: 30 },
        { level: "rig", hostId: "t-hubtest-b", rigName: "team-b", openWorkCount: 5, minutesSinceProgress: 61, lastProgressAt: ago(61 * MIN), thresholdMinutes: 30 },
        { level: "rig", hostId: "t-hubtest-b", rigName: "team-c", openWorkCount: 4, minutesSinceProgress: 61, lastProgressAt: ago(61 * MIN), thresholdMinutes: 30 },
      ],
    }), NOW);
    const sec = section(model, "STALLED");
    expect(sec?.rows.map((r) => r.subject)).toEqual(["t-hubtest-b", "team-b", "team-c"]);
  });

  it("an unknown duration renders honestly, never as a fabricated age", () => {
    const model = buildPulseModel(quietSnap({
      fleetProbed: true,
      stalled: [{ level: "rig", hostId: "h", rigName: "r", openWorkCount: 1, minutesSinceProgress: null, lastProgressAt: null, thresholdMinutes: 30 }],
    }), NOW);
    expect(rendered(section(model, "STALLED"))).toContain("age unknown");
  });

  it("nothing stalled is silence — no section, no placeholder", () => {
    const model = buildPulseModel(quietSnap({ fleetProbed: true, stalled: [] }), NOW);
    expect(section(model, "STALLED")).toBeUndefined();
  });
});

describe("no remote hosts — the page is the page it always was", () => {
  it("an empty fleet contribution changes nothing about the built model", () => {
    const before = buildPulseModel(quietSnap(), NOW);
    const after = buildPulseModel(quietSnap({ remoteSeatActivity: [], stalled: [], fleetProbed: true, stallThresholdMinutes: 30 }), NOW);
    expect(after.exceptions.map((s) => `${s.label}:${rendered(s)}`))
      .toEqual(before.exceptions.map((s) => `${s.label}:${rendered(s)}`));
    expect(after.lanes.map((l) => `${l.label}:${l.count}`)).toEqual(before.lanes.map((l) => `${l.label}:${l.count}`));
  });
});
