// GET /metrics — the fleet, in Prometheus text format.
//
// WHY THIS EXISTS. Team pods live for minutes to hours, so scraping each pod gives
// a dashboard a fleet of disappearing targets. The hub already fans out to every
// team for the TUI and the CLI, so the hub is the one place that can answer for the
// whole fleet in one request — and one scrape target for a fleet that changes
// underneath you is worth more than N targets you have to discover.
//
// WHAT IT IS BUILT ON. Exactly the two fleet reads the TUI already pays for, through
// the SAME single-flight cache (`createFleetReads`). A scrape that arrives while the
// fleet cache is fresh costs nothing; one that arrives while it is stale gets the
// cached payload and joins the one refresh already running. This route adds no
// fan-out, no deadline arithmetic and no second opinion about which hosts answered —
// and it adds nothing a TEAM daemon has to serve, so an old pod is still fully
// represented here.
//
// HOW A SCRAPER AUTHENTICATES, and why. Two gates, both already the daemon's.
//
// The first is the browser boundary the `/api/*` routes use — the SAME instance, mounted
// on `/metrics` too (see server.ts). It refuses a request addressed to a name that is not
// this machine's, which is the DNS-rebinding defence: without it a page the operator
// visits could rebind its own hostname to loopback and read the fleet here while
// `/api/fleet/summary` refuses the same request. Only the Host check stops rebinding, so
// this endpoint needs that check and not merely an Origin one.
//
// The second is the bearer middleware the daemon already uses for its non-browser
// surfaces (`/api/transport`, `/api/compaction`), with the SAME token. Prometheus sends
// `Authorization: Bearer <t>` natively (`scrape_config.authorization`, or `bearer_token`),
// so no secret has to travel in a query string where it would land in access logs. That
// token is null exactly when the daemon binds loopback or a tailnet interface — where
// every other read is open by design — and is the configured bearer wherever the bind is
// genuinely wider. A valid bearer also waives the boundary's Host check, so an
// authenticating scraper is unaffected by either gate.
//
// Together they are what makes the claim below true rather than aspirational: `/metrics`
// is open exactly where `/api/fleet/*` is open and gated exactly where that read is
// gated. It introduces no new secret, no new mechanism and nothing extra to rotate.
//
// THE HONESTY RULES live with the exposition (`domain/fleet/fleet-metrics.ts`), not
// here: an unanswered host is `up 0` and nothing else, and a null is an absent series
// rather than a zero.

import { Hono } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { PROMETHEUS_TEXT_FORMAT, renderFleetMetrics } from "../domain/fleet/fleet-metrics.js";
import type { FleetSummaryPayload } from "../domain/fleet/fleet-summary-types.js";
import type { FleetUsagePayload } from "../domain/fleet/fleet-usage-types.js";
import {
  createFleetReads,
  resolveUsageWindow,
  FleetReadUnavailableError,
  type FleetReads,
} from "./fleet.js";

export interface MetricsRouteOptions {
  /** The shared fleet reads. Pass the daemon's holder so a scrape reuses the fan-out
   *  the TUI and CLI already paid for; a fresh one is a fresh cache, which is what a
   *  test wants and the opposite of what a running hub wants. */
  reads?: FleetReads;
  /** The daemon's bearer for non-browser clients. Null passes through, which is the
   *  loopback/tailnet posture every other read here already has. */
  bearerToken?: string | null;
  /** One call per failed usage read, so a hub whose usage leg is broken says so
   *  instead of quietly publishing a fleet with no numbers on it. */
  onUsageReadError?: (err: unknown) => void;
}

export function metricsRoutes(opts: MetricsRouteOptions = {}) {
  const app = new Hono();
  const reads = opts.reads ?? createFleetReads();
  const reportUsageError = opts.onUsageReadError
    ?? ((err: unknown) => console.warn(`[metrics] fleet usage read failed; publishing the fleet without it: ${(err as Error)?.message ?? String(err)}`));

  app.use("*", authBearerTokenMiddleware({ expectedToken: opts.bearerToken ?? null }));

  app.get("/", async (c) => {
    const window = resolveUsageWindow(c.req.query("window_hours"));
    if ("error" in window) return c.json({ code: "metrics_invalid_request", error: window.error }, 400);
    const fresh = c.req.query("fresh") === "1";

    // The summary is the scrape: without it there is no fleet to report, so an
    // unwired daemon or a failed fan-out is a scrape failure (Prometheus treats a
    // non-200 as one) rather than an empty body a dashboard would plot as an empty
    // fleet.
    let summary: FleetSummaryPayload;
    try {
      summary = await reads.readSummary(c, fresh);
    } catch (err) {
      if (err instanceof FleetReadUnavailableError) return c.json({ error: "fleet_metrics_unavailable" }, 503);
      throw err;
    }

    // Usage is the optional section. A usage read that fails while the fleet read
    // answered is disclosed (`openrig_fleet_usage_read_ok 0`), not folded into the
    // fleet as "nobody used anything".
    let usage: FleetUsagePayload | null = null;
    try {
      usage = await reads.readUsage(c, window.windowHours, fresh);
    } catch (err) {
      reportUsageError(err);
    }

    return c.body(renderFleetMetrics({ summary, usage }), 200, { "content-type": PROMETHEUS_TEXT_FORMAT });
  });

  return app;
}
