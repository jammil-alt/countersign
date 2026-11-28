// The connector self-test (2026-11-28): a fixed list of checks run against the Sandbox client's own
// live connections (QuickBooks' sandbox company, Resend, Twilio) through the same connector code
// agents use, so a call that passes every test against our fakes and fails on the real service is
// found by us, not by an operator. It reads and parses only: no write is ever executed and nothing
// is sent. Run once a day on staging by the cron, or now from the back office or the MCP server.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

/** `connection_change.change.kind` of a self-test's results for one connection. */
export const SELFTEST_CHANGE = "selftest";

/** pass; fail (the provider or our code refused); skip (nothing to check it with, or turned off). */
export const SelftestStatus = z.enum(["pass", "fail", "skip"]);
export type SelftestStatus = z.infer<typeof SelftestStatus>;

export const SelftestCheck = z.object({
  /** Stable: the tool or call and its variant, e.g. `qbo.purchase.query:vendorId`. */
  id: z.string().min(1).max(120),
  /** What it checks, in plain words. */
  what: z.string().max(300),
  status: SelftestStatus,
  ms: z.number().int().nonnegative(),
  /** The provider's or our refusal, scrubbed of anything shaped like a secret (fail, skip). */
  error: z.string().max(600).nullable(),
});
export type SelftestCheck = z.infer<typeof SelftestCheck>;

/** One connection's checks, as stored in its `connection_change` row. */
export const SelftestConnectionResult = z.object({
  connectionId: Id,
  connector: z.string(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  checks: z.array(SelftestCheck),
});
export type SelftestConnectionResult = z.infer<typeof SelftestConnectionResult>;

/** `connection_change.change` of a self-test. */
export const SelftestChange = SelftestConnectionResult.omit({ connectionId: true }).extend({
  kind: z.literal(SELFTEST_CHANGE),
  at: z.string(),
  environment: z.string(),
  /** Who started it: the cron, or an operator from the back office or the MCP server. */
  by: z.enum(["cron", "operator"]),
});
export type SelftestChange = z.infer<typeof SelftestChange>;

export const SelftestRun = z.object({
  tenantId: Id,
  at: z.string().nullable(),
  environment: z.string().nullable(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  connections: z.array(SelftestConnectionResult.extend({ at: z.string() })),
});
export type SelftestRun = z.infer<typeof SelftestRun>;

export const selftestRoutes = {
  opsClientSelftestRun: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/selftest",
    auth: "session",
    roles: OPS,
    summary:
      "Run the connector self-test now on the Sandbox client's live connections (staging only; reads and parses, never writes or sends)",
    params: z.object({ id: Id }),
    response: SelftestRun,
  }),
  opsClientSelftestLast: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/selftest",
    auth: "session",
    roles: OPS,
    summary:
      "The connector self-test's latest results for each of the Sandbox client's connections",
    params: z.object({ id: Id }),
    response: SelftestRun,
  }),
};
