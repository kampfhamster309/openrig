// The payload shapes for the hub-side fleet USAGE read.
//
// The shape is deliberately close to the fleet summary's (`fleet-summary-types.ts`):
// `items` (one entry per host) plus `hosts` (a `PerHostStatus` for EVERY host on
// EVERY read, omission-proof). What it adds is the honesty rule that matters most
// for numbers: a host that did not answer contributes NOTHING to a total, and a
// total that is missing a host says so. A zero is a measurement; an absence is not
// a measurement, and rendering one as the other is how a fleet read lies.

import type { AggregatedPayload, PerHostStatus, PerHostStatusKind } from "../hosts/fanout-contract.js";

/** What `/api/telemetry/usage/top` answers on every image that serves it. The hub
 *  does not recompute a seat's numbers — it reads the origin's own projection and
 *  labels it. Kept here (not imported from the daemon's domain module) because it
 *  is a WIRE shape: an older image is the authority on it, not this branch. */
export interface UsageTopBody {
  windowHours: number;
  sinceIso: string;
  ranked: UsageSeatBurn[];
  unknown: UsageUnknownSeat[];
  /** Seats ranked BEFORE the origin's own `top` cap; truncation is never silent. */
  totalRankedSeats: number;
}

/** One seat's burn, exactly as its own host measured it.
 *
 *  `tokensPerHour` is a rate over THAT SEAT's own sample span, and
 *  `windows[].usedPercent*` is a percentage of that seat's own provider window.
 *  Neither is combinable with another seat's; they are per-seat facts and the
 *  fleet read never adds them. */
export interface UsageSeatBurn {
  seatSession: string;
  tokensPerHour: number;
  tokensDelta: number;
  resets: number;
  spanHours: number;
  samples: number;
  /** Provider-window velocities. A lane a runtime does not observe is ABSENT
   *  here, not an entry with zeros — an API-key runtime has no subscription
   *  window, and inventing one would report a window that does not exist. */
  windows: UsageWindowVelocity[];
}

export interface UsageWindowVelocity {
  window: string;
  usedPercentFirst: number | null;
  usedPercentLast: number | null;
  percentPerHour: number | null;
  resetsAt: string | null;
}

export interface UsageUnknownSeat {
  seatSession: string;
  reason: string;
}

/** A seat as the fleet sees it: the origin's row plus the host it came from. */
export interface FleetSeatBurn extends UsageSeatBurn {
  hostId: string;
}

export interface FleetUnknownSeat extends UsageUnknownSeat {
  hostId: string;
}

/** The numbers that honestly ADD — across seats on a host, and again across hosts.
 *
 *  `tokensDelta` is the sum of POSITIVE per-node token deltas inside the window;
 *  a counter that went down is a session restart and is counted in `resets`, never
 *  subtracted. Seats are disjoint, hosts are disjoint, the unit is the same, so the
 *  sum means what it looks like it means.
 *
 *  Deliberately absent: any fleet-wide tokens-per-hour. A rate measured over each
 *  seat's own sample span cannot be summed or averaged into a fleet rate without
 *  inventing a span the fleet never had. Ranking by the per-seat rate is honest
 *  (it is the same comparison the single-host read already makes, over a bigger
 *  pool); publishing a summed rate is not. */
export interface FleetUsageTotals {
  tokensDelta: number;
  resets: number;
  seatsRanked: number;
  seatsUnknown: number;
}

/** One host's usage answer — the local daemon or one `hosts.yaml` entry. Never
 *  omitted from `items`; an unreachable host still appears, with its status and no
 *  numbers. */
export interface FleetHostUsage {
  hostId: string;
  kind: "local" | "remote";
  /** Reachability, in the SAME closed enum the fleet summary reports, so one
   *  operator-facing word means one thing across both reads. */
  status: PerHostStatusKind;
  /** Convenience for renderers: `status === "ok"`. */
  reachable: boolean;
  /** The failure detail behind a non-`ok` status, when there is one. */
  statusError?: string;
  /** The usage leg's own state. A host can be REACHABLE and still have no usable
   *  usage read (an image with no usage route, a usage query that failed); those
   *  are different facts and the operator's fix differs, so they are not merged. */
  usage: {
    state: "ok" | "unavailable";
    /** Why there is no number. Present when unavailable — an empty string here
     *  would be a zero dressed up as an explanation. */
    reason?: string;
    /** The window the ORIGIN answered with, and its own `since`. Absent with no read. */
    windowHours?: number;
    sinceIso?: string;
    /** Always present so a renderer never branches on undefined. Empty when there is
     *  no read — which `state` already says. The field that carries "no measurement"
     *  is `totals` below, never an empty list read as "this host has no seats". */
    ranked: FleetSeatBurn[];
    unknown: FleetUnknownSeat[];
    /** Verbatim from the origin, so a per-host truncation stays visible. */
    totalRankedSeats?: number;
    /** Honest sums over THIS host's ranked seats. Absent when there is no read —
     *  never zeros, which a reader would render as "this host used nothing". */
    totals?: FleetUsageTotals;
  };
  /** Honest per-leg failure notes for a host that answered SOME legs and failed
     *  others (health probe fine, usage route 500). Disclosed, never folded into
     *  a clean `ok`. */
  partialFailures: string[];
}

/** The `/api/fleet/usage` payload. */
export interface FleetUsagePayload extends AggregatedPayload<FleetHostUsage> {
  generatedAt: string;
  /** The window every host was asked for. */
  windowHours: number;
  /** The hub's own window start, so a reader can say "in the last N hours"
   *  without recomputing it from each origin's clock. */
  sinceIso: string;
  /** The top seats across every host that answered, each labelled with its host,
   *  ranked by the per-seat rate the origin computed. */
  top: FleetSeatBurn[];
  /** The cap applied to `top`; null when the request asked for no cap. Echoed so a
   *  reader never renders a partial list as the whole fleet. */
  topCap: number | null;
  /** Seats ranked across every host that answered, BEFORE `topCap`. With
   *  `top.length` this tells a reader whether the list was cut. */
  totalSeatsRanked: number;
  /** Seats every answering host could not rank, each with the origin's reason. */
  unknown: FleetUnknownSeat[];
  /** Summed over the hosts that ANSWERED. Null when none did: a fleet that used
   *  nothing and a fleet nobody heard from are different answers, and only one of
   *  them is `0`. */
  totals: (FleetUsageTotals & {
    hostsAnswered: number;
    /** Every host the fan-out targeted, local included. */
    hostsTargeted: number;
  }) | null;
  /** Per-host deadline in force — each host's own budget, not a shared one. */
  hostTimeoutMs: number;
  concurrency: number;
  /** The host ids the fan-out targeted, in order. Lets a reader tell a missing
   *  host from an unregistered one. */
  targetedHostIds: string[];
  /** Set only when `hosts.yaml` EXISTS but could not be read: the fleet is
   *  local-only for a stated reason rather than a silently thin one. */
  registryError?: string;
  /** True when this payload came from the short cache instead of a fresh fan-out. */
  fromCache: boolean;
  cacheAgeMs: number;
  cacheStaleWhileRevalidate: boolean;
  cacheTtlMs: number;
}

/** What ONE usage fan-out produces: the payload minus the cache fields, which the
 *  shared cache layer adds. */
export interface FleetUsageFanOutResult extends Omit<FleetUsagePayload,
  "fromCache" | "cacheAgeMs" | "cacheStaleWhileRevalidate" | "cacheTtlMs"> {}

/** The status the summary reports for a host the hub could not use. Exported so the
 *  route and the tests read ONE enum rather than retyping strings. */
export type FleetUsageHostStatus = PerHostStatus;
