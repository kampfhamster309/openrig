import { describe, expect, it } from "vitest";
import { ATTENTION_FANOUT_CONCURRENCY, ATTENTION_READ_TIMEOUT_MS } from "../src/domain/feed/attention-aggregator.js";
import { attentionAggregateReaderTimeoutMs, fleetSummaryReaderTimeoutMs } from "../src/fleet-surface.js";

// A reader of GET /api/queue/attention-aggregate waits for the route's own worst case, by the
// rule the fleet summary's readers use, built from the budget the aggregator really applies.
describe("attentionAggregateReaderTimeoutMs", () => {
  it("is the summary's reader rule over the aggregator's own per-host budget and cap", () => {
    for (const hosts of [0, 1, 4, 5, 14, 40]) {
      expect(attentionAggregateReaderTimeoutMs(hosts))
        .toBe(fleetSummaryReaderTimeoutMs(hosts, ATTENTION_READ_TIMEOUT_MS, ATTENTION_FANOUT_CONCURRENCY));
    }
  });

  it("always outlasts one host taking its whole budget", () => {
    // The race that emptied a hub's view: a team at its 5 s limit, a reader at the client's 5 s default.
    expect(attentionAggregateReaderTimeoutMs(1)).toBeGreaterThan(ATTENTION_READ_TIMEOUT_MS);
    expect(attentionAggregateReaderTimeoutMs(1)).toBe(20_000);
  });

  it("counts the waves the concurrency cap forces", () => {
    // Fourteen hosts at four at a time: four waves of 5 s, plus the 10 s margin.
    expect(attentionAggregateReaderTimeoutMs(14)).toBe(30_000);
  });
});
