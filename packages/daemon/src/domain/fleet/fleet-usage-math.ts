// The fleet usage ARITHMETIC, on its own, with no transport and no fan-out.
//
// This module exists so there is ONE implementation of "what do these seats add
// up to". The daemon needs it for the hub-side read; the CLI needs it for its
// fallback, which dials every host itself when the local daemon is too old to
// serve the hub route. Two copies of the sums is how a hub and a CLI come to
// report different totals for the same fleet at the same moment — and a total is
// the exact number an operator compares teams on.
//
// It is dependency-free on purpose: the CLI imports it through the daemon's public
// fleet surface, and anything it dragged along would ride in the published CLI
// bundle.
//
// The honesty rules live here because this is where they bite:
//   * Only numbers that honestly add are summed (`sumUsageTotals`).
//   * A row whose numbers are not finite is DROPPED and disclosed, never coerced:
//     `tokensDelta ?? 0` puts a fabricated zero into a total.
//   * A lane a runtime does not observe stays absent.

import type { UsageSeatBurn, UsageTopBody, UsageUnknownSeat } from "./fleet-usage-types.js";

/** One host's usage answer: the numbers, or the reason there are none. */
export type UsageLeg =
  | { ok: true; body: UsageTopBody }
  | { ok: false; reason: string };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

/** One seat row, as the wire delivered it.
 *
 *  A row whose burn numbers are not finite is rejected rather than coerced. The
 *  caller counts it and says so; silently reading it as zero would move a total. */
function parseSeatRow(raw: Record<string, unknown>): UsageSeatBurn | null {
  const seatSession = typeof raw["seatSession"] === "string" ? raw["seatSession"] : null;
  const tokensPerHour = finiteNumber(raw["tokensPerHour"]);
  const tokensDelta = finiteNumber(raw["tokensDelta"]);
  if (seatSession === null || tokensPerHour === null || tokensDelta === null) return null;
  const windows: UsageSeatBurn["windows"] = [];
  const rawWindows = Array.isArray(raw["windows"]) ? raw["windows"] : [];
  for (const entry of rawWindows) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    // A window with no name is not a window. Its percentages stay unread rather
    // than being attached to a lane nobody named.
    if (typeof w["window"] !== "string") continue;
    windows.push({
      window: w["window"],
      usedPercentFirst: nullableNumber(w["usedPercentFirst"]),
      usedPercentLast: nullableNumber(w["usedPercentLast"]),
      percentPerHour: nullableNumber(w["percentPerHour"]),
      resetsAt: typeof w["resetsAt"] === "string" ? w["resetsAt"] : null,
    });
  }
  return {
    seatSession,
    tokensPerHour,
    tokensDelta,
    resets: finiteNumber(raw["resets"]) ?? 0,
    spanHours: finiteNumber(raw["spanHours"]) ?? 0,
    samples: finiteNumber(raw["samples"]) ?? 0,
    windows,
  };
}

/** The `usage/top` body, defensively read. An OLDER image is the authority on this
 *  shape — the reader cannot assume the branch it was built from. */
export function parseUsageTopBody(payload: unknown): { leg: UsageLeg; droppedRows: number } {
  if (!payload || typeof payload !== "object") {
    return { leg: { ok: false, reason: "the usage read answered something that is not an object" }, droppedRows: 0 };
  }
  const body = payload as Record<string, unknown>;
  const windowHours = finiteNumber(body["windowHours"]);
  const sinceIso = isoString(body["sinceIso"]);
  if (windowHours === null || sinceIso === null || !Array.isArray(body["ranked"])) {
    return { leg: { ok: false, reason: "the usage read is missing its window, its window start, or its ranked seats" }, droppedRows: 0 };
  }
  const ranked: UsageSeatBurn[] = [];
  let dropped = 0;
  for (const row of body["ranked"]) {
    if (!row || typeof row !== "object") { dropped += 1; continue; }
    const seat = parseSeatRow(row as Record<string, unknown>);
    if (seat) ranked.push(seat);
    else dropped += 1;
  }
  const unknown: UsageUnknownSeat[] = [];
  for (const row of Array.isArray(body["unknown"]) ? body["unknown"] : []) {
    if (!row || typeof row !== "object") continue;
    const u = row as Record<string, unknown>;
    if (typeof u["seatSession"] !== "string") continue;
    unknown.push({ seatSession: u["seatSession"], reason: typeof u["reason"] === "string" ? u["reason"] : "unspecified" });
  }
  const totalRankedSeats = finiteNumber(body["totalRankedSeats"]) ?? ranked.length;
  return {
    leg: { ok: true, body: { windowHours, sinceIso, ranked, unknown, totalRankedSeats } },
    droppedRows: dropped,
  };
}

/** Sum the numbers that honestly add. `tokensPerHour`, `spanHours` and every
 *  percentage is left out on purpose — see `FleetUsageTotals`. */
export function sumUsageTotals(ranked: readonly UsageSeatBurn[], unknownCount: number): {
  tokensDelta: number; resets: number; seatsRanked: number; seatsUnknown: number;
} {
  let tokensDelta = 0;
  let resets = 0;
  for (const seat of ranked) {
    tokensDelta += seat.tokensDelta;
    resets += seat.resets;
  }
  return { tokensDelta, resets, seatsRanked: ranked.length, seatsUnknown: unknownCount };
}

/** Add two per-host totals. Used by every reader that rolls a fleet number up. */
export function addUsageTotals(a: { tokensDelta: number; resets: number; seatsRanked: number; seatsUnknown: number },
                               b: { tokensDelta: number; resets: number; seatsRanked: number; seatsUnknown: number }) {
  return {
    tokensDelta: a.tokensDelta + b.tokensDelta,
    resets: a.resets + b.resets,
    seatsRanked: a.seatsRanked + b.seatsRanked,
    seatsUnknown: a.seatsUnknown + b.seatsUnknown,
  };
}

/** The empty total to start a sum from. */
export const ZERO_USAGE_TOTALS = { tokensDelta: 0, resets: 0, seatsRanked: 0, seatsUnknown: 0 };

/** Fleet ranking: the per-seat rate the ORIGIN computed, over a bigger pool. This
 *  is the same comparison the single-host read already makes; a reader adds a host
 *  label, not a new metric. Ties break on host then seat so the order is
 *  deterministic across runs and across readers. */
export function rankFleetSeats<T extends { hostId: string; seatSession: string; tokensPerHour: number }>(seats: readonly T[]): T[] {
  return [...seats].sort((a, b) => (
    b.tokensPerHour - a.tokensPerHour
    || a.hostId.localeCompare(b.hostId)
    || a.seatSession.localeCompare(b.seatSession)
  ));
}
