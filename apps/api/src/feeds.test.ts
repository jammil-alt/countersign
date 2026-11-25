// 2026-11-24: a pack tool that reads a connector's synced records (`feed`) has them brought up to
// date first; a tool without one doesn't, and a failed catch-up never fails the step.

import { describe, expect, it, vi } from "vitest";
import { feedCatchUp } from "./feeds";
import { catchUpFeed } from "./packs";
import type { RunDeps } from "./runs/execute";

vi.mock("./observability/report", () => ({ reportHandled: vi.fn() }));

describe("a feed's catch-up before a pack tool", () => {
  const tenantId = "0190f0c8-0000-7000-8000-000000000001";

  it("catches up the tool's feed, and nothing for a tool without one", async () => {
    const catchUp = vi.fn(async () => {});
    await catchUpFeed({ id: "sales.match_records", feed: "zoho_crm" }, tenantId, { catchUp });
    expect(catchUp).toHaveBeenCalledWith(tenantId, "zoho_crm");
    catchUp.mockClear();
    await catchUpFeed({ id: "sales.matches.confirmed" }, tenantId, { catchUp });
    await catchUpFeed({ id: "sales.match_records", feed: "zoho_crm" }, tenantId, {});
    await catchUpFeed({ id: "sales.match_records", feed: "zoho_crm" }, tenantId, undefined);
    expect(catchUp).not.toHaveBeenCalled();
  });

  it("goes on with what we hold when the catch-up fails", async () => {
    const { reportHandled } = await import("./observability/report");
    const catchUp = vi.fn(async () => {
      throw new Error("Zoho is down");
    });
    await expect(
      catchUpFeed({ id: "sales.match_records", feed: "zoho_crm" }, tenantId, { catchUp }),
    ).resolves.toBeUndefined();
    expect(reportHandled).toHaveBeenCalledWith(
      "zoho_crm catch-up before sales.match_records failed",
      expect.any(Error),
      { job: "feed_catch_up", client: tenantId },
    );
  });

  it("has nothing to catch up with where the run has no credentials", () => {
    expect(feedCatchUp({} as RunDeps)).toBeNull();
  });
});
