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

/** The fleet usage ARITHMETIC, published for the CLI's fallback read.
 *
 *  `rig usage top --all-hosts` prefers the hub route and falls back to dialing every
 *  host itself when the local daemon is too old to serve it. That fallback has to
 *  produce the same totals and the same ranking as the hub, so it uses these rather
 *  than a second implementation — two sums that can drift is how a hub and a CLI
 *  report different numbers for one fleet at one moment. Dependency-free by design:
 *  whatever rides here rides in the published CLI bundle. */
export {
  addUsageTotals,
  parseUsageTopBody,
  rankFleetSeats,
  sumUsageTotals,
  ZERO_USAGE_TOTALS,
} from "./domain/fleet/fleet-usage-math.js";
export type { UsageLeg } from "./domain/fleet/fleet-usage-math.js";
