// The Marketing pack through the platform (M43, docs/plan.md §1.72): an operator switches it on for
// a client and adds the client's website; the site's pages post beacons to the public inbound
// route, which always answers 204 and stores only what the pack accepts, for a client with the
// pack on; the nightly pass builds the day as the Worker's role; and the overview report reaches
// the back office and the client's portal. The pack's own tests cover measuring in depth
// (packs/marketing).

import { routes } from "@countersign/core";
import { siteEvent, siteVisit } from "@countersign/pack-marketing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { packNightly } from "./app";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const VIEW = "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b";

describe.skipIf(!h)("the Marketing pack on the platform", () => {
  const H = h as ApiHarness;
  let siteId = "";

  const inbound = (tenantId: string, target: string, headers: Record<string, string> = {}) =>
    H.call(
      null,
      "POST",
      routes.packInbound.path
        .replace(":pack", "marketing")
        .replace(":tenantId", tenantId)
        .replace(":target", target),
      JSON.stringify({ events: [{ k: "view", id: VIEW, p: "/", r: "https://www.bing.com/" }] }),
      {
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://www.mezonas.com",
        "user-agent": UA,
        "cf-connecting-ip": "203.0.113.9",
        cookie: "session=not-read",
        ...headers,
      },
    );

  it("is registered, and switched on and given a site by an operator", async () => {
    const enabled = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(enabled.status).toBe(200);
    expect(j(enabled.json).pack).toMatchObject({ id: "marketing", enabled: true });

    const added = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/add-site`,
      { domain: "https://www.mezonas.com", name: "mezonas.com", goals: ["hero-talk"] },
    );
    expect(added.status).toBe(200);
    expect(j(added.json).result.site).toMatchObject({ domain: "mezonas.com", status: "on" });
    siteId = j(added.json).result.site.id;

    const again = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/add-site`,
      { domain: "mezonas.com", name: "Again" },
    );
    expect(again.status).toBe(422);
  });

  it("answers every beacon 204 with no body, and stores only the site's own", async () => {
    const ok = await inbound(H.A.tenantId, siteId);
    expect([ok.status, ok.json]).toEqual([204, null]);
    // Another site's page, a client without the pack, an unknown pack or target: all 204.
    for (const res of [
      await inbound(H.A.tenantId, siteId, { origin: "https://elsewhere.example" }),
      await inbound(H.B.tenantId, siteId),
      await H.call(null, "POST", `/api/in/nopack/${H.A.tenantId}/${siteId}`, "{}"),
      await H.call(null, "POST", `/api/in/marketing/not-a-uuid/${siteId}`, "{}"),
    ]) {
      expect(res.status).toBe(204);
    }
    const rows = await H.t.db.select().from(siteEvent).where(eq(siteEvent.siteId, siteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: H.A.tenantId,
      sourceGroup: "search",
      sourceName: "bing",
    });
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });

  it("builds the day in the nightly pass, at the pack's minute only", async () => {
    const today = new Date();
    const tomorrow = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, 3, 41),
    );
    expect(await packNightly(H.db, H.platform.packs, new Date(tomorrow.getTime() + 60_000))).toBe(
      0,
    );
    expect(await packNightly(H.db, H.platform.packs, tomorrow)).toBe(1);
    const visits = await H.t.db.select().from(siteVisit).where(eq(siteVisit.siteId, siteId));
    expect(visits).toHaveLength(1);
  });

  it("gives the overview to the back office and to the client, with nothing forbidden", async () => {
    const ops = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/overview`,
    );
    expect(ops.status).toBe(200);
    expect(j(ops.json).report.sites).toHaveLength(1);
    const portal = await H.call(admin("a"), "GET", "/api/reports/marketing/overview");
    expect(portal.status).toBe(200);
    expect(forbiddenKeys(portal.json)).toEqual([]);
    // A client without the pack has no such report.
    const other = await H.call(admin("b"), "GET", "/api/reports/marketing/overview");
    expect(other.status).toBe(404);
  });
});
