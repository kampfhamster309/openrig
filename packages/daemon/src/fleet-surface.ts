/**
 * The cross-package surface for the hub-side fleet read.
 *
 * The one thing other packages must not reimplement is how long a READER waits for
 * `GET /api/fleet/summary`. The route answers only after every host leg has finished,
 * so a client that guesses — or that keeps its generic 5 s default — abandons a
 * healthy fan-out whenever a host is slow or the concurrency cap queues legs up, and
 * then pays for a second fan-out in its fallback. Deriving the wait from the fan-out's
 * own worst case is the rule, and it lives here so the CLI and the TUI cannot drift
 * from it or from each other.
 */
export {
  fleetSummaryReaderTimeoutMs,
  FLEET_HOST_TIMEOUT_MS_DEFAULT,
  FLEET_FANOUT_CONCURRENCY_DEFAULT,
  FLEET_READER_MARGIN_MS,
  FLEET_READER_MIN_TIMEOUT_MS,
} from "./domain/fleet/fleet-settings.js";
