// The attention aggregate's fan-out budget, in a module of its own: a READER of
// `GET /api/queue/attention-aggregate` must derive its wait from these, and importing
// them must not pull in the aggregator's host-registry and HTTP dependencies.

/** The aggregation READ deadline class (per-host bound). Distinct from the
 *  up-leaf's long-running budget by design — named here, passed explicitly. */
export const ATTENTION_READ_TIMEOUT_MS = 5_000;

/** Fixed fan-out cap — a poll across a handful of hosts; adaptive
 *  throttling is out of scope (same v1 posture as the topology walker). */
export const ATTENTION_FANOUT_CONCURRENCY = 4;
