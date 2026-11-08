// M46 (docs/plan.md §1.76): a guide published through the platform. An operator points the client's
// Website connection at its site, writes a guide and publishes it: the pack's action signs one
// `website.publish` external action (approved by that person, no run), which the connector runs
// once into the bucket (a memory store here, R2 in the Worker), with the guide, the sitemap and
// the redirects. Without the bucket nothing is written. Preview links are signed, noindex, and
// only for the client's own pages.

import {
  createWebsiteConnector,
  executeWrite,
  MemoryObjectStore,
  memoryCredentials,
  memoryLogger,
  websiteKeys,
} from "@countersign/connectors";
import { DEFAULT_PERMISSIONS, isAlwaysSigned } from "@countersign/core";
import { connection, externalAction } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { deploymentConnectors } from "./platform";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const bucket = new MemoryObjectStore();
const h = await createApiHarness({
  connectors: () => [createWebsiteConnector({ store: bucket })],
  env: { APP_ORIGIN: "https://app.example.com" },
});
afterAll(() => h?.close());

const GUIDE = {
  title: "How approvals work",
  description:
    "Every change an agent wants to make waits for a person to sign it, with the before and after.",
  body: "## Why sign\n\nA change waits for you. See [why](#why-sign).",
};

describe.skipIf(!h)("publishing a guide (M46)", () => {
  const H = h as ApiHarness;
  const act = (tenantId: string, name: string, body: unknown, who = OPERATOR) =>
    H.call(who, "POST", `/api/ops/clients/${tenantId}/packs/marketing/actions/${name}`, body);
  let siteId = "";
  let websiteId = "";
  let pageId = "";

  it("sets up: the pack, a site, and the Website connection pointed at it", async () => {
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`))
        .status,
    ).toBe(200);
    const site = await act(H.A.tenantId, "add-site", {
      domain: "mezonas.com",
      name: "mezonas.com",
    });
    siteId = j(site.json).result.site.id;
    // No website connection yet: pointing it refuses.
    expect((await act(H.A.tenantId, "set-website", { site: siteId })).status).toBe(422);
    const [conn] = await H.t.db
      .insert(connection)
      .values({ tenantId: H.A.tenantId, connector: "website", status: "connected" })
      .returning();
    websiteId = conn?.id ?? "";
    const pointed = await act(H.A.tenantId, "set-website", { site: siteId });
    expect(pointed.status).toBe(200);
    expect(j(pointed.json).result.website.domain).toBe("mezonas.com");
  });

  it("registers website.publish as a change a person always signs", () => {
    const tool = H.platform.tools.get("website.publish");
    expect(tool?.spec.sideEffect).toBe("external");
    expect(tool && isAlwaysSigned(tool.spec)).toBe(true);
    expect(
      isAlwaysSigned(H.platform.tools.get("website.meta")?.spec ?? { sideEffect: "none" }),
    ).toBe(true);
  });

  it("refuses to publish a guide whose checks refuse, writing nothing", async () => {
    const created = await act(H.A.tenantId, "create-page", { site: siteId, slug: "approvals" });
    expect(created.status).toBe(200);
    pageId = j(created.json).result.pageId;
    await act(H.A.tenantId, "save-version", { page: pageId, ...GUIDE, title: "Approvals!" });
    const refused = await act(H.A.tenantId, "publish", { page: pageId });
    expect(refused.status).toBe(422);
    expect(j(refused.json).error.message).toMatch(/^Not published: No exclamation marks/);
    expect(bucket.size).toBe(0);
  });

  it("publishes through one external action the operator signed, into the bucket", async () => {
    await act(H.A.tenantId, "save-version", { page: pageId, ...GUIDE });
    const r = await act(H.A.tenantId, "publish", { page: pageId });
    expect(r.status).toBe(200);
    expect(j(r.json).result).toMatchObject({
      status: "published",
      url: "https://mezonas.com/guides/approvals",
      version: 3,
    });
    const actionId = j(r.json).result.externalActionId;
    const [row] = await H.t.db.select().from(externalAction).where(eq(externalAction.id, actionId));
    expect(row).toMatchObject({
      tool: "website.publish",
      connectionId: websiteId,
      status: "done",
      runId: null,
      agentVersionId: null,
    });
    expect(row?.approvedBy).toBeTruthy();
    expect(row?.idempotencyKey).toMatch(/^signed:marketing:publish:/);
    expect(row?.before).toEqual({ live: null });
    const keys = websiteKeys("mezonas.com");
    const guide = await bucket.get(keys.guide("approvals"));
    expect(JSON.parse(new TextDecoder().decode(guide?.bytes))).toMatchObject({
      title: GUIDE.title,
      description: GUIDE.description,
    });
    expect(await bucket.head(keys.sitemap)).not.toBeNull();

    const detail = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/content/items/${pageId}`,
    );
    expect(j(detail.json).report.page.status).toBe("published");
    expect(j(detail.json).report.liveVersion).toBe(3);
    expect(j(detail.json).report.publishes[0]).toMatchObject({ action: "publish", version: 3 });
  });

  it("unpublishes through the same tool, taking the guide off the site", async () => {
    const r = await act(H.A.tenantId, "unpublish", { page: pageId });
    expect(r.status).toBe(200);
    expect(await bucket.get(websiteKeys("mezonas.com").guide("approvals"))).toBeNull();
  });

  it("writes nothing where the bucket isn't bound: publishing isn't set up", async () => {
    const website = deploymentConnectors({} as never, false).find(
      (c) => c.manifest.id === "website",
    );
    expect(website).toBeDefined();
    if (!website) return;
    await expect(
      executeWrite(
        website,
        "website.publish",
        { action: "publish", slug: "x", title: "T", description: "D", html: "<p>x</p>" },
        {
          tenantId: H.A.tenantId,
          connection: {
            id: websiteId,
            tenantId: H.A.tenantId,
            connector: "website",
            status: "connected",
            externalAccountId: null,
            config: { domain: "mezonas.com" },
            permissions: DEFAULT_PERMISSIONS,
          },
          credentials: memoryCredentials(null),
          logger: memoryLogger(),
          now: () => new Date(),
          idempotencyKey: "k",
        },
      ),
    ).rejects.toThrow("publishing isn't set up");
  });

  it("gives a signed, noindex preview link for the client's own version only", async () => {
    const detail = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/marketing/content/items/${pageId}`,
    );
    const versionId = j(detail.json).report.versions[0].id;
    const link = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/previews`,
      { report: "content-preview", itemId: versionId },
    );
    expect(link.status).toBe(200);
    const url = new URL(j(link.json).url);
    expect(url.origin).toBe("https://app.example.com");
    const page = await H.app.request(url.pathname, {}, H.env);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("<h1>How approvals work</h1>");
    expect(html).toContain('<h2 id="why-sign">Why sign</h2>');

    // A changed token, a report that isn't a preview, and another client's version: no link.
    const tampered = await H.app.request(`${url.pathname.slice(0, -2)}xx`, {}, H.env);
    expect(tampered.status).toBe(404);
    const notPreview = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/previews`,
      { report: "content", itemId: pageId },
    );
    expect(notPreview.status).toBe(404);
    await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/packs/marketing/enable`);
    const theirs = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.B.tenantId}/packs/marketing/previews`,
      { report: "content-preview", itemId: versionId },
    );
    expect(theirs.status).toBe(404);
    // A client's people never ask for one (back office only).
    const client = await H.call(
      admin("a"),
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/previews`,
      { report: "content-preview", itemId: versionId },
    );
    expect(client.status).toBe(403);
  });

  it("keeps the guides from other clients, and out of the portal", async () => {
    const theirs = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.B.tenantId}/reports/marketing/content/items/${pageId}`,
    );
    expect(theirs.status).toBe(404);
    const publishB = await act(H.B.tenantId, "publish", { page: pageId });
    expect(publishB.status).toBe(422);
    // M50 (docs/plan.md §1.78): content is the back office's; the portal never reads it.
    const portal = await H.call(admin("a"), "GET", "/api/reports/marketing/content");
    expect(portal.status).toBe(404);
    expect(forbiddenKeys(portal.json)).toEqual([]);
    const rows = await H.t.db
      .select()
      .from(externalAction)
      .where(
        and(eq(externalAction.tenantId, H.B.tenantId), eq(externalAction.tool, "website.publish")),
      );
    expect(rows).toHaveLength(0);
  });
});
