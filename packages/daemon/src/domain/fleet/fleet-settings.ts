// The knob that decides when "quiet" becomes "stuck".
//
// A team with open work and no progress for longer than this is reported
// `stalled` whatever its seats' activity says. The case that made this a setting
// rather than a constant: a seat stuck in a self-matching `while pgrep …; sleep`
// loop stayed "active" for 17 minutes because its pane kept producing output while
// nothing on the team moved and its lead idled. Pane output is therefore not
// progress; only a queue transition written by a seat or a human is.
//
// 30 minutes is paired with the guidance that
// a team posts a milestone note on its queue item every 15-20 minutes during long
// work. The threshold sits at roughly twice that cadence, so a team following the
// guidance is never called stalled and a silent one is caught inside half an
// hour. A live proof sets it to a few minutes.

/** The settings-store key. Added to the daemon's SETTINGS_VALID_KEYS and the
 *  CLI's VALID_KEYS twin in lockstep, like every other queue/fleet knob. */
export const FLEET_STALL_THRESHOLD_MINUTES_KEY = "fleet.stall_threshold_minutes";

/** The default lives here (a dependency-free module) so the settings store and
 *  the fleet domain state ONE default rather than two that can drift. */
export const FLEET_STALL_THRESHOLD_MINUTES_DEFAULT = 30;

/** How long ONE host leg may take before that host is reported unreachable, and how
 *  many hosts may be dialed at once. Both are operator-configurable (see the
 *  `fleet.*` settings keys); these are the defaults, and they live in this
 *  dependency-free module so the domain, the route and the settings store all read
 *  ONE pair of numbers instead of three that can drift. */
export const FLEET_HOST_TIMEOUT_MS_DEFAULT = 5_000;
export const FLEET_FANOUT_CONCURRENCY_DEFAULT = 4;

/** How long a fleet payload stays fresh, and how old it may get before a reader
 *  stops being served it as stale. ONE pair of numbers for every fleet read: a
 *  summary and a usage read that disagreed about what "fresh enough" means would
 *  have the operator see two fleets at once. */
export const FLEET_CACHE_MS = 3_000;
export const FLEET_STALE_BOUND_MS = 60_000;

/** The settings keys for the two knobs above. A hub with a slow team and a hub with
 *  thirty teams want different numbers, and neither should require a code change. */
export const FLEET_HOST_TIMEOUT_MS_KEY = "fleet.host_timeout_ms";
export const FLEET_FANOUT_CONCURRENCY_KEY = "fleet.fanout_concurrency";

/** The margin added on top of the fan-out's own worst case when a READER (the CLI or
 *  the TUI) decides how long to wait for `GET /api/fleet/summary`.
 *
 *  This number exists because the route answers only after EVERY host leg has finished.
 *  A reader that gives up before that does not get a partial answer: the CLI silently
 *  falls back to dialing every host itself, and the TUI loses its remote sections for
 *  that poll. Both outcomes are the failure this read was written to remove, so the
 *  reader's patience must be derived from the fan-out's real worst case, not fixed at
 *  whatever the default client timeout happens to be. */
export const FLEET_READER_MARGIN_MS = 10_000;

/** A floor, so a one-host fleet still gets a sane wait: the local leg, the queue legs
 *  and JSON serialization are not covered by the per-host budget. */
export const FLEET_READER_MIN_TIMEOUT_MS = 20_000;

/** ONE rule for how long a reader waits for the fleet summary, shared by every client
 *  so no reader can drift below the fan-out it is waiting for.
 *
 *  The fan-out's worst case is not the slowest host; it is the number of waves the
 *  concurrency cap forces, times the per-host budget. Fourteen hosts at a cap of four
 *  is four waves, so a 5 s budget is a 20 s wait — and a reader on a 5 s timeout would
 *  abandon a healthy fan-out that was simply queued. */
export function fleetSummaryReaderTimeoutMs(
  hostCount: number,
  hostTimeoutMs: number = FLEET_HOST_TIMEOUT_MS_DEFAULT,
  concurrency: number = FLEET_FANOUT_CONCURRENCY_DEFAULT,
  marginMs: number = FLEET_READER_MARGIN_MS,
): number {
  const waves = Math.max(1, Math.ceil(Math.max(1, hostCount) / Math.max(1, concurrency)));
  return Math.max(FLEET_READER_MIN_TIMEOUT_MS, waves * hostTimeoutMs + marginMs);
}
