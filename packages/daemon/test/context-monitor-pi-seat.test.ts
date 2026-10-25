import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type Database } from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor, contextSourceForRuntime } from "../src/domain/context-monitor.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

/**
 * A Pi seat's context sidecar, end to end: the monitor includes it, the store labels it, the
 * freshness and retired-occupant rules reach it, and — the part that must never happen — a Pi
 * sample can never put a Claude `/compact` on a Pi seat.
 *
 * The sidecar bytes come from `test/fixtures/pi-context-usage-sidecar.json`, which is the literal
 * output of the Pi-side extension (see the fixture note in this file), so the contract is proven
 * against a real writer rather than a hand-written approximation of one.
 */

/** Written by the Pi-side extension on 2026-10-25; only `sampled_at` is ever rewritten here. */
const PI_SIDECAR_FIXTURE = "pi-context-usage-sidecar.json";
const PI_SEAT = "dev-build@pi-context-fixture";

describe("ContextMonitor with a Pi seat", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let monitor: ContextMonitor;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `pi-context-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir });
    ensureContextCollectorSpy = vi.fn();
    monitor = new ContextMonitor(db, store, { ensureContextCollector: ensureContextCollectorSpy });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSeat(runtime: "pi" | "omp" | "claude-code", sessionName = PI_SEAT, logicalId = "dev.build") {
    const rig = rigRepo.createRig(`rig-${runtime}`);
    const node = rigRepo.addNode(rig.id, logicalId, { runtime });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    return { node, sessionName };
  }

  function sidecarPath(sessionName: string): string {
    return join(tmpDir, "state", "context-usage", `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`);
  }

  /** The real fixture, with `sampled_at` moved to `atMs` and the percentage set. */
  function writePiSidecar(sessionName: string, atMs: number, usedPercentage = 31) {
    const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", PI_SIDECAR_FIXTURE), "utf-8"));
    raw.session_name = sessionName;
    raw.sampled_at = new Date(atMs).toISOString();
    raw.context_window.used_percentage = usedPercentage;
    raw.context_window.remaining_percentage = 100 - Math.round(usedPercentage);
    const file = sidecarPath(sessionName);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    writeFileSync(file, JSON.stringify(raw));
    return raw;
  }

  function installRealCompactionEnforcer(threshold = 80) {
    const settings = new SettingsStore(join(tmpDir, "settings.json"));
    settings.set("policies.claude_compaction.enabled", "true");
    settings.set("policies.claude_compaction.threshold_percent", String(threshold));
    const send = vi.fn(async () => ({ ok: true }));
    const transport = { send } as unknown as SessionTransport;
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: tmpDir,
      resolveOccupantGeneration: () => "fixture-generation",
    });
    monitor = new ContextMonitor(db, store, undefined, enforcer);
    return send;
  }

  it("labels a Pi sidecar by its writer, not by Claude's status line", () => {
    expect(contextSourceForRuntime("pi")).toBe("pi_context_usage_json");
    expect(contextSourceForRuntime("omp")).toBe("pi_context_usage_json");
    expect(contextSourceForRuntime("claude-code")).toBe("claude_statusline_json");
    expect(contextSourceForRuntime("stub")).toBe("claude_statusline_json");
    expect(contextSourceForRuntime(null)).toBe("claude_statusline_json");
  });

  it("reads a real Pi extension's sidecar through ContextUsageStore", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", PI_SIDECAR_FIXTURE), "utf-8"));
    // Pinned to the fixture's own sample time so freshness is decided by the rule, not by when
    // the suite runs.
    const sampledAt = Date.parse(raw.sampled_at);
    vi.spyOn(Date, "now").mockReturnValue(sampledAt + 1_000);
    const usage = store.normalizeSample(raw, "pi_context_usage_json");

    expect(usage.availability).toBe("known");
    expect(usage.source).toBe("pi_context_usage_json");
    // The writer rounds: Pi's float percent becomes a whole number, as Claude's and Codex's writers
    // deliver it, because OpenRig prints this value as written. The exact figure stays in
    // currentUsage, which is provenance rather than a display value.
    expect(usage.usedPercentage).toBe(31);
    expect(usage.remainingPercentage).toBe(69);
    expect(JSON.parse(String(usage.currentUsage)).percent).toBe(30.72);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.totalInputTokens).toBe(61440);
    expect(usage.totalOutputTokens).toBeNull();
    expect(usage.sessionId).toBe("pi-fixture-session-0001");
    expect(usage.sessionName).toBe(PI_SEAT);
    expect(usage.transcriptPath).toBe("/fixture/pi/sessions/pi-fixture-session-0001.jsonl");
    // Pi reports no cost, and an absent figure is not a zero.
    expect(usage.clientCostEstimateUsd).toBeNull();
    expect(usage.fresh).toBe(true);

    // One second past the threshold the same bytes read as stale: the freshness rule is the same
    // rule whichever runtime wrote the sidecar.
    vi.spyOn(Date, "now").mockReturnValue(sampledAt + 600_001);
    expect(store.normalizeSample(raw, "pi_context_usage_json").fresh).toBe(false);
  });

  it("includes a running Pi seat and reads its sidecar with the existing reader", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("pi");
    writePiSidecar(sessionName, now);

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(31);
    expect(usage.source).toBe("pi_context_usage_json");
    expect(usage.fresh).toBe(true);
    // A Pi seat gets no Claude collector: OpenRig writes nothing into a seat's Pi agent directory.
    expect(ensureContextCollectorSpy).not.toHaveBeenCalled();
  });

  it("includes a running omp seat, and a sidecar it never wrote stays unknown rather than zero", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("omp", "dev.qa@pi-context-fixture");

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.source).toBeNull();
    expect(ensureContextCollectorSpy).not.toHaveBeenCalled();
  });

  it("marks a Pi seat unknown when its sidecar is missing, and known once it appears", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("pi");

    await monitor.pollOnce();
    expect(store.getForNode(node.id, sessionName).availability).toBe("unknown");

    writePiSidecar(sessionName, now);
    await monitor.pollOnce();
    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(31);
  });

  it("marks a Pi sample stale by the same freshness rule as a Claude one", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("pi");
    // One second past the threshold: fresh on the boundary is Claude's rule, not a Pi exception.
    writePiSidecar(sessionName, now - 600_001);

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.fresh).toBe(false);
  });

  it("removes a retiring Pi occupant's sidecar so a same-name successor cannot read it", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { sessionName } = seedSeat("pi");
    writePiSidecar(sessionName, now);
    expect(store.readSidecar(sessionName).ok).toBe(true);

    // The handover seam is name-keyed and runtime-agnostic; so is the Pi sidecar it clears.
    store.invalidateOccupantSidecar(sessionName);

    expect(store.readSidecar(sessionName)).toEqual({ ok: false, reason: "missing_sidecar" });
    expect(store.readAndNormalize(sessionName, "pi_context_usage_json").reason).toBe("missing_sidecar");
  });

  it("never sends /compact or any keystroke to a Pi seat, however high and fresh its sample is", async () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("pi");
    const send = installRealCompactionEnforcer(80);
    writePiSidecar(sessionName, now, 95);

    await monitor.pollOnce();
    await monitor.pollOnce();

    // The reading is real and current: the refusal is the runtime, not a missing sample.
    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(95);
    expect(usage.fresh).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("positive control: the same sample on a Claude seat does reach the compaction path", async () => {
    // Without this row the test above could pass because the wiring was broken rather than guarded.
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { sessionName } = seedSeat("claude-code", "dev.build@claude-fixture");
    const send = installRealCompactionEnforcer(80);
    writePiSidecar(sessionName, now, 95);

    await monitor.pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toContain("compaction");
  });

  it("the extension's real post-compaction sample reads as no_data, not parse_error", async () => {
    // The literal bytes the Pi-side extension writes at session_compact, captured live in the P3
    // proof. They are well-formed and say "no reading right now", so the reason must be no_data.
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { node, sessionName } = seedSeat("pi", "dev.probe@pi-nodata-fixture");
    writeFileSync(
      sidecarPath(sessionName),
      JSON.stringify({
        context_window: {
          context_window_size: 262144,
          used_percentage: null,
          remaining_percentage: null,
          total_input_tokens: null,
          total_output_tokens: null,
          current_usage: { runtime: "pi", tokens: null, context_window: 262144, percent: null },
        },
        session_id: "01a172ba-0dfb-76b8-8c00-9c35ddbfdb44",
        session_name: sessionName,
        occupant_generation: "4eafc1f2-9b9e-49b3-a87d-755480982cb6",
        transcript_path: "/tmp/x.jsonl",
        cost: null,
        sampled_at: new Date(now).toISOString(),
      }),
    );

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
    expect(usage.usedPercentage).toBeNull();
  });

  it("a failed Pi seat whose runner reports ready is normalised to ready (F2)", async () => {
    // Including pi/omp in getEligibleSessions also runs normalizeStartupStatus for them for the
    // first time. This pins that behaviour, which was previously unannounced: the Pi readiness
    // checker was registered but no Pi seat ever reached it.
    const now = Date.parse("2026-10-02T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const failed = seedSeat("pi", "dev.probe@pi-startup-failed");
    const alreadyReady = seedSeat("pi", "dev.probe@pi-startup-ready", "dev.other");
    const idOf = (name: string) =>
      db.prepare("SELECT id FROM sessions WHERE session_name = ?").get(name) as { id: string };
    db.prepare("UPDATE sessions SET startup_status = 'failed' WHERE session_name = ?").run(failed.sessionName);
    db.prepare("UPDATE sessions SET startup_status = 'ready' WHERE session_name = ?").run(alreadyReady.sessionName);

    const checkReady = vi.fn(async () => ({ ready: true }));
    // The checker record is a private structural type on the constructor; derive it rather than
    // name a module that does not export it.
    const startupCheckers = { pi: { checkReady } } as unknown as
      NonNullable<ConstructorParameters<typeof ContextMonitor>[4]>;
    const startupMonitor = new ContextMonitor(db, store, undefined, undefined, startupCheckers);

    await startupMonitor.pollOnce();

    // Only the seat that needed it was probed — a ready seat is never re-probed, and the checker
    // holds no database lock while observing the runtime.
    expect(checkReady).toHaveBeenCalledTimes(1);
    expect(checkReady.mock.calls[0]?.[0]).toMatchObject({ tmuxSession: failed.sessionName });

    const statusOf = (name: string) =>
      (db.prepare("SELECT startup_status FROM sessions WHERE session_name = ?").get(name) as { startup_status: string })
        .startup_status;
    expect(statusOf(failed.sessionName)).toBe("ready");
    expect(statusOf(alreadyReady.sessionName)).toBe("ready");

    // A runner that is not ready leaves the recorded status alone: the checker never demotes.
    checkReady.mockResolvedValueOnce({ ready: false });
    db.prepare("UPDATE sessions SET startup_status = 'failed' WHERE session_name = ?").run(failed.sessionName);
    await startupMonitor.pollOnce();
    expect(statusOf(failed.sessionName)).toBe("failed");

    startupMonitor.stop();
  });
});
