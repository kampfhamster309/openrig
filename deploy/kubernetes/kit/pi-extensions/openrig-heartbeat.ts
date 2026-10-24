// OpenRig heartbeat for Pi seats.
//
// Writes $OPENRIG_HOME/state/pi-heartbeat/<seat>.json on every phase change
// (model prefill/thinking/text/toolcall, tool run, compaction, idle) and at most
// every THROTTLE_MS while tokens stream, so a watcher can tell "reasoning for a
// long time" apart from "silent". Each finished model call is also appended to
// <seat>.calls.jsonl (duration, time to first token, longest token gap, usage)
// so thresholds can be calibrated from real runs (bin/pi-seat-status --calibrate).
//
// No imports: loaded by Pi via jiti from the seat's agent extensions directory.

import * as fs from "node:fs";
import * as path from "node:path";

const THROTTLE_MS = 5000;
const RECENT_MAX = 12;

function seatName(): string {
  // OpenRig sets PI_CODING_AGENT_DIR to $OPENRIG_HOME/state/pi/<seat>/agent.
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (dir && path.basename(dir) === "agent") return path.basename(path.dirname(dir));
  return process.env.OPENRIG_SESSION_NAME || `pi-${process.pid}`;
}

function openrigHome(): string {
  return process.env.OPENRIG_HOME || path.join(process.env.HOME || "", ".openrig");
}

function summarizeArgs(tool: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const s = args.command ?? args.path ?? args.file_path ?? args.pattern ?? JSON.stringify(args);
  return String(s).replace(/\s+/g, " ").slice(0, 200);
}

export default function (pi: any) {
  const seat = seatName();
  const dir = path.join(openrigHome(), "state", "pi-heartbeat");
  const file = path.join(dir, `${seat}.json`);
  const callsFile = path.join(dir, `${seat}.calls.jsonl`);
  const now = () => Date.now();
  const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

  const hb: any = {
    seat,
    pid: process.pid,
    state: "starting", // idle | model | tool | compacting | exited
    phase: null, // model: prefill | thinking | text | toolcall
    state_since: now(),
    last_event_at: now(),
    run_started_at: null,
    turn: 0,
    current_tool: null,
    current_call: null,
    totals: { turns: 0, model_calls: 0, tool_calls: 0, tool_errors: 0, compactions: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 },
    context: null,
    last_model_call: null,
    recent: [] as string[],
  };
  let lastWrite = 0;

  function write(force = true) {
    const t = now();
    hb.last_event_at = t;
    if (!force && t - lastWrite < THROTTLE_MS) return;
    lastWrite = t;
    const out = {
      ...hb,
      state_since: iso(hb.state_since),
      last_event_at: iso(hb.last_event_at),
      run_started_at: iso(hb.run_started_at),
      current_tool: hb.current_tool && { ...hb.current_tool, started_at: iso(hb.current_tool.started_at) },
      current_call: hb.current_call && {
        ...hb.current_call,
        started_at: iso(hb.current_call.started_at),
        first_token_at: iso(hb.current_call.first_token_at),
        last_token_at: iso(hb.current_call.last_token_at),
      },
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
      fs.renameSync(tmp, file);
    } catch {
      /* telemetry must never break the agent */
    }
  }

  function setState(state: string, phase: string | null = null) {
    if (hb.state !== state || hb.phase !== phase) hb.state_since = now();
    hb.state = state;
    hb.phase = phase;
  }

  function note(line: string) {
    hb.recent.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (hb.recent.length > RECENT_MAX) hb.recent.shift();
  }

  function updateContext(ctx: any) {
    try {
      const u = ctx?.getContextUsage?.();
      if (u) hb.context = { tokens: u.tokens, window: u.contextWindow, percent: u.percent };
    } catch {
      /* optional */
    }
  }

  pi.on("session_start", (_e: any, ctx: any) => {
    setState("idle");
    updateContext(ctx);
    note("session start");
    write();
  });

  pi.on("agent_start", () => {
    hb.run_started_at = now();
    setState("model", "prefill");
    note("run start");
    write();
  });

  pi.on("turn_start", (e: any) => {
    hb.turn = e?.turnIndex ?? hb.turn + 1;
    write();
  });

  pi.on("message_start", (e: any) => {
    if (e?.message?.role !== "assistant") return;
    hb.current_call = { started_at: now(), first_token_at: null, last_token_at: null, max_gap_ms: 0, deltas: 0 };
    setState("model", "prefill");
    write();
  });

  pi.on("message_update", (e: any) => {
    const c = hb.current_call;
    const t = now();
    if (c) {
      if (c.first_token_at == null) c.first_token_at = t;
      else c.max_gap_ms = Math.max(c.max_gap_ms, t - c.last_token_at);
      c.last_token_at = t;
      c.deltas++;
    }
    const type = String(e?.assistantMessageEvent?.type ?? "");
    const phase = type.startsWith("thinking") ? "thinking" : type.startsWith("toolcall") ? "toolcall" : type.startsWith("text") ? "text" : hb.phase;
    const changed = phase !== hb.phase;
    setState("model", phase);
    write(changed);
  });

  pi.on("message_end", (e: any, ctx: any) => {
    const m = e?.message;
    if (m?.role !== "assistant") return;
    const u = m.usage || {};
    const T = hb.totals;
    T.model_calls++;
    T.input += u.input || 0;
    T.output += u.output || 0;
    T.cache_read += u.cacheRead || 0;
    T.cache_write += u.cacheWrite || 0;
    const c = hb.current_call;
    const end = now();
    const rec = {
      ended_at: new Date(end).toISOString(),
      duration_s: c ? (end - c.started_at) / 1000 : null,
      ttft_s: c && c.first_token_at ? (c.first_token_at - c.started_at) / 1000 : null,
      max_gap_s: c ? c.max_gap_ms / 1000 : null,
      input: u.input ?? null,
      cache_read: u.cacheRead ?? null,
      output: u.output ?? null,
      stop: m.stopReason ?? null,
    };
    hb.last_model_call = rec;
    hb.current_call = null;
    updateContext(ctx);
    note(`model call ${rec.duration_s?.toFixed(0)}s, ${rec.output ?? "?"} out tok, stop=${rec.stop}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(callsFile, JSON.stringify({ seat, ...rec }) + "\n");
    } catch {
      /* optional */
    }
    write();
  });

  pi.on("tool_execution_start", (e: any) => {
    if (e?.parentToolCallId) return;
    hb.current_tool = { name: e.toolName, args: summarizeArgs(e.toolName, e.args), started_at: now() };
    hb.totals.tool_calls++;
    setState("tool");
    note(`tool ${e.toolName}: ${hb.current_tool.args.slice(0, 80)}`);
    write();
  });

  pi.on("tool_execution_end", (e: any) => {
    if (e?.parentToolCallId) return;
    if (e?.isError) hb.totals.tool_errors++;
    const started = hb.current_tool?.started_at;
    note(`tool ${e.toolName} done${e?.isError ? " (error)" : ""} ${started ? ((now() - started) / 1000).toFixed(0) + "s" : ""}`);
    hb.current_tool = null;
    setState("model", "prefill");
    write();
  });

  pi.on("turn_end", (_e: any, ctx: any) => {
    hb.totals.turns++;
    updateContext(ctx);
    write();
  });

  pi.on("session_before_compact", () => {
    hb.totals.compactions++;
    setState("compacting");
    note("compaction start");
    write();
  });

  pi.on("session_compact", (_e: any, ctx: any) => {
    updateContext(ctx);
    note("compaction done");
    setState(hb.run_started_at ? "model" : "idle", hb.run_started_at ? "prefill" : null);
    write();
  });

  pi.on("session_compact_failed", () => {
    note("compaction FAILED");
    write();
  });

  pi.on("agent_settled", (e: any) => {
    hb.run_started_at = null;
    hb.current_tool = null;
    hb.current_call = null;
    setState("idle");
    note(`run settled${e?.aborted ? " (aborted)" : ""}`);
    write();
  });

  pi.on("session_shutdown", () => {
    setState("exited");
    note("session shutdown");
    write();
  });
}
