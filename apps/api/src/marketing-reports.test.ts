// The Marketing area's read reports through the platform (M44, docs/plan.md §1.74): the Sandbox's
// sample traffic is an operator's action that any other client refuses; every read report answers
// the back office, with its query parsed (a bad one is a 400) and nothing forbidden in it; the
// CSV downloads; and one client's site asked for under another reads as no site. The figures
// themselves are checked in packs/marketing (src/measure/reports.test.ts).

import { tenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the Marketing area's read reports", () => {
  const H = h as ApiHarness;
  const ops = (tenantId: string, path: string) =>
    H.call(OPERATOR, "GET", `/api/ops/clients/${tenantId}/reports/marketing/${path}`);
  let siteId = "";

  it("fills the Sandbox with sample traffic, and refuses any other client", async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { sandbox: true } })
      .where(eq(tenant.id, H.A.tenantId));
    for (const c of [H.A, H.B]) {
      const on = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${c.tenantId}/packs/marketing/enable`,
      );
      expect(on.status).toBe(200);
    }
    const refused = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.B.tenantId}/packs/marketing/actions/sample-traffic`,
      {},
    );
    expect([refused.status, j(refused.json).error?.code]).toEqual([422, "refused"]);
    const filled = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/sample-traffic`,
      {},
    );
    expect(filled.status).toBe(200);
    expect(j(filled.json).result.sample.days).toBe(28);
    siteId = j(filled.json).result.sample.siteId;
  });

  it("answers every read report, nothing forbidden in it", async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const list = j((await ops(H.A.tenantId, `visits?site=${siteId}&period=7`)).json).report;
    expect(list.total).toBeGreaterThan(0);
    const visit = list.visits[0];
    for (const path of [
      "overview?period=90",
      "pages?period=7",
      `page?path=${encodeURIComponent("/how-it-works")}`,
      "sources?campaign=newsletter-nov&referrer=news.ycombinator.com",
      "journeys",
      "audience?country=US",
      `visits?goal=yes&page=1&day=${day}`,
      `visit?day=${visit.day}&visit=${visit.visit}`,
      "sites",
    ]) {
      const res = await ops(H.A.tenantId, path);
      expect(res.status, path).toBe(200);
      expect(forbiddenKeys(res.json), path).toEqual([]);
    }
    const csv = await ops(H.A.tenantId, "pages/csv?period=28");
    expect(csv.status).toBe(200);
    expect(String(csv.json)).toMatch(/^path,views,entries/);
  });

  it("refuses a query that doesn't parse", async () => {
    for (const path of [
      "overview?period=14",
      "page",
      "visits?source=nowhere",
      "visit?day=2026-11-01",
      "audience?country=usa",
      "pages?unknown=1",
    ]) {
      const res = await ops(H.A.tenantId, path);
      expect([path, res.status, j(res.json).error?.code]).toEqual([path, 400, "invalid_query"]);
    }
  });

  it("never gives one client's figures under another", async () => {
    const res = await ops(H.B.tenantId, `overview?site=${siteId}`);
    expect(res.status).toBe(200);
    expect(j(res.json).report.site).toBeNull();
    expect(j(res.json).report.totals.visits).toBe(0);
    // The client's own portal never reaches another client's.
    const portal = await H.call(
      admin("b"),
      "GET",
      `/api/reports/marketing/overview?site=${siteId}`,
    );
    expect(portal.status).toBe(200);
    expect(j(portal.json).report.totals.visits).toBe(0);
  });
});
