// Offering the Marketing area to a client (M50, docs/plan.md §1.78), through the platform: the
// client's portal reads its website, search and weekly report, with nothing forbidden in them,
// and none of the back office's other marketing reports; a client in HIPAA mode has its site's
// beacons held (nothing stored, the same 204) until the mode is off; and Search Console by Google
// sign-in is registered everywhere, available only with the deployment's Google client.

import { GSC_OAUTH_CONNECTOR_ID } from "@countersign/connectors";
import { routes } from "@countersign/core";
import { tenant } from "@countersign/db";
import { marketingManifest, siteEvent } from "@countersign/pack-marketing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { screenReports } from "./packs";
import { deploymentConnectors } from "./platform";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const VIEW = "6a1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1c";

describe("the portal reads what the pack's portal screens name", () => {
  it("derives the portal's reports from the pack's screens", () => {
    expect(screenReports(marketingManifest)).toEqual(["overview", "search", "weekly-report"]);
  });
});

describe("Search Console by Google sign-in", () => {
  it("is registered everywhere, and signs in only with the Google client", () => {
    const off = deploymentConnectors({}, false).find(
      (c) => c.manifest.id === GSC_OAUTH_CONNECTOR_ID,
    );
    expect(off?.manifest.auth).toBe("oauth2");
    expect(off?.isConfigured?.()).toBe(false);
    const on = deploymentConnectors(
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", OAUTH_STATE_SECRET: "s" },
      true,
    ).find((c) => c.manifest.id === GSC_OAUTH_CONNECTOR_ID);
    expect(on?.isConfigured?.()).toBe(true);
    // Without the state secret nobody can sign in, whatever the client.
    const noState = deploymentConnectors(
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
      true,
    ).find((c) => c.manifest.id === GSC_OAUTH_CONNECTOR_ID);
    expect(noState?.isConfigured?.()).toBe(false);
  });
});

describe.skipIf(!h)("the Marketing area for a client", () => {
  const H = h as ApiHarness;
  let siteId = "";
  const portal = (path: string) => H.call(admin("a"), "GET", `/api/reports/marketing/${path}`);
  const beacon = () =>
    H.call(
      null,
      "POST",
      routes.packInbound.path
        .replace(":pack", "marketing")
        .replace(":tenantId", H.A.tenantId)
        .replace(":target", siteId),
      JSON.stringify({ events: [{ k: "view", id: VIEW, p: "/" }] }),
      {
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://www.clinic.example",
        "user-agent": UA,
        "cf-connecting-ip": "203.0.113.20",
      },
    );
  const stored = async () =>
    (await H.t.db.select().from(siteEvent).where(eq(siteEvent.siteId, siteId))).length;
  const setHipaa = async (on: boolean) => {
    const [row] = await H.t.db
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, H.A.tenantId));
    const settings = { ...((row?.settings as Record<string, unknown>) ?? {}) };
    settings.compliance = { hipaa: on };
    await H.t.db.update(tenant).set({ settings }).where(eq(tenant.id, H.A.tenantId));
  };

  it("is switched on for the client, with its site", async () => {
    const on = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(on.status).toBe(200);
    const added = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/actions/add-site`,
      { domain: "clinic.example", name: "clinic.example", goals: [] },
    );
    expect(added.status).toBe(200);
    siteId = j(added.json).result.site.id;
  });

  it("gives the portal its website, search and weekly report, nothing forbidden in them", async () => {
    for (const path of [
      "overview",
      "overview?period=7",
      `search?site=${siteId}`,
      "weekly-report",
      `weekly-report?site=${siteId}`,
    ]) {
      const res = await portal(path);
      expect(res.status, path).toBe(200);
      expect(forbiddenKeys(res.json, /agentVersionId|runId|model/i), path).toEqual([]);
    }
    expect(j((await portal("weekly-report")).json).report).toMatchObject({
      site: { id: siteId },
      reports: [],
      latest: null,
    });
    for (const path of ["overview/csv", "search/csv", "weekly-report/csv"]) {
      expect((await portal(path)).status, path).toBe(200);
    }
    // A report that doesn't parse is still a 400 in the portal.
    expect((await portal("overview?period=14")).status).toBe(400);
  });

  it("keeps the back office's other marketing reports out of the portal", async () => {
    for (const path of ["visits", "sites", "pages", "content", "claims", "search-sources"]) {
      const res = await portal(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect((await portal(`${path}/csv`)).status, path).toBe(404);
    }
    expect(
      (await H.call(admin("a"), "GET", `/api/reports/marketing/content/items/${siteId}`)).status,
    ).toBe(404);
    // The operator still reads them.
    const ops = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/sites`,
    );
    expect(ops.status).toBe(200);
    // A client without the pack has none of them.
    expect((await H.call(admin("b"), "GET", "/api/reports/marketing/overview")).status).toBe(404);
  });

  it("holds a site's beacons for a client in HIPAA mode, and stores them again once off", async () => {
    await setHipaa(true);
    const held = await beacon();
    expect([held.status, held.json]).toEqual([204, null]);
    expect(await stored()).toBe(0);
    await setHipaa(false);
    expect((await beacon()).status).toBe(204);
    expect(await stored()).toBe(1);
  });
});
