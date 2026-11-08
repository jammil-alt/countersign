import {
  DEFAULT_PERMISSIONS,
  decideToolCall,
  isAlwaysSigned,
  type JsonObject,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite } from "../invoke";
import { memoryLogger } from "../logger";
import { ConnectorRegistry } from "../registry";
import { fromUtf8 } from "../runtime";
import { MemoryObjectStore } from "../storage/memory";
import { fakeReceiver } from "../testing";
import {
  createWebsiteConnector,
  unsafeHtml,
  WEBSITE_META_TOOL,
  WEBSITE_PUBLISH_TOOL,
  websiteKeys,
} from "./index";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";

function ctx(config: JsonObject = { domain: "mezonas.com" }, key = "k-1"): WriteContext {
  const connection: ConnectionRef = {
    id: "0190f0c8-0000-7000-8000-0000000000c1",
    tenantId: tenant,
    connector: "website",
    status: "connected",
    externalAccountId: null,
    config,
    permissions: DEFAULT_PERMISSIONS,
  };
  return {
    tenantId: tenant,
    connection,
    credentials: memoryCredentials(null),
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: key,
  };
}

const publish = {
  action: "publish",
  slug: "approval-basics",
  title: "How approvals work",
  description: "Every change waits for a person to sign it.",
  html: '<h2 id="why">Why</h2><p>A change waits for you.</p>',
  redirects: [{ from: "/guides/old", to: "/guides/approval-basics" }],
};

async function readJson(store: MemoryObjectStore, key: string): Promise<unknown> {
  const o = await store.get(key);
  return o ? JSON.parse(fromUtf8(o.bytes)) : null;
}

describe("website connector", () => {
  it("has two external tools a person always signs, whatever the matrix and mode", () => {
    const c = createWebsiteConnector();
    new ConnectorRegistry([c]);
    expect(c.manifest.auth).toBe("none");
    for (const tool of c.manifest.tools) {
      expect([tool.id, tool.sideEffect, tool.verb, tool.approval]).toEqual([
        tool.id,
        "external",
        "update",
        "always",
      ]);
      expect(isAlwaysSigned(tool)).toBe(true);
      // Every setting loosened: the matrix on auto, the step not_required, the agent acting.
      const decision = decideToolCall({
        sideEffect: tool.sideEffect,
        verb: tool.verb,
        matrix: { ...DEFAULT_PERMISSIONS, update: "auto" },
        stepApproval: "not_required",
        agentMode: "act",
        alwaysSigned: isAlwaysSigned(tool),
      });
      expect(decision).toBe("approval");
    }
    expect(c.manifest.tools.map((t) => t.id)).toEqual([WEBSITE_PUBLISH_TOOL, WEBSITE_META_TOOL]);
  });

  it("refuses every write while publishing isn't set up (no bucket): nothing public changes", async () => {
    const c = createWebsiteConnector();
    await expect(executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx())).rejects.toThrow(
      "publishing isn't set up",
    );
    await expect(
      executeWrite(
        c,
        WEBSITE_META_TOOL,
        { path: "/guides/approval-basics", title: "T", description: "D" },
        ctx(),
      ),
    ).rejects.toThrow("publishing isn't set up");
  });

  it("writes the guide, the sitemap and the redirects under the connection's domain only", async () => {
    const store = new MemoryObjectStore();
    const c = createWebsiteConnector({ store });
    const before = await captureBefore(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect(before.before).toEqual({ live: null });
    const r = await executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect(r.output).toMatchObject({
      action: "publish",
      domain: "mezonas.com",
      url: "https://mezonas.com/guides/approval-basics",
      guides: 1,
      pinged: false,
    });
    expect(r.summary).toBe("published /guides/approval-basics on mezonas.com");
    const keys = websiteKeys("mezonas.com");
    expect(await readJson(store, keys.guide("approval-basics"))).toEqual({
      title: publish.title,
      description: publish.description,
      html: publish.html,
      publishedAt: NOW.toISOString(),
    });
    expect(await readJson(store, keys.sitemap)).toEqual({
      updatedAt: NOW.toISOString(),
      urls: [{ path: "/guides/approval-basics", lastmod: "2026-11-08" }],
    });
    expect(await readJson(store, keys.redirects)).toEqual(publish.redirects);
    const listed = await store.list({ prefix: "site/" });
    expect(listed.objects.every((o) => o.key.startsWith("site/mezonas.com/"))).toBe(true);
    // The next publish sees what visitors see now as its before state.
    const again = await captureBefore(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect(again.before).toEqual({
      live: {
        title: publish.title,
        description: publish.description,
        publishedAt: NOW.toISOString(),
      },
    });
  });

  it("unpublishes: the guide's key and its sitemap entry go", async () => {
    const store = new MemoryObjectStore();
    const c = createWebsiteConnector({ store });
    await executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    await executeWrite(
      c,
      WEBSITE_PUBLISH_TOOL,
      { ...publish, slug: "second-guide" },
      ctx(undefined, "k-2"),
    );
    const r = await executeWrite(
      c,
      WEBSITE_PUBLISH_TOOL,
      { action: "unpublish", slug: "approval-basics" },
      ctx(undefined, "k-3"),
    );
    expect(r.output).toMatchObject({ action: "unpublish", guides: 1, publishedAt: null });
    const keys = websiteKeys("mezonas.com");
    expect(await store.get(keys.guide("approval-basics"))).toBeNull();
    expect((await readJson(store, keys.sitemap)) as { urls: unknown[] }).toMatchObject({
      urls: [{ path: "/guides/second-guide" }],
    });
    expect(await readJson(store, keys.redirects)).toEqual([]);
  });

  it("refuses a connection not pointed at a site, and html no checked guide has", async () => {
    const c = createWebsiteConnector({ store: new MemoryObjectStore() });
    await expect(executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx({}))).rejects.toThrow(
      "isn't pointed at a site",
    );
    for (const html of [
      "<p>hi</p><script>alert(1)</script>",
      '<p onclick="x()">hi</p>',
      '<a href="javascript:alert(1)">x</a>',
      "<h1>Second title</h1>",
      '<img src="x">',
    ]) {
      expect(unsafeHtml(html)).toBe(true);
      await expect(
        executeWrite(c, WEBSITE_PUBLISH_TOOL, { ...publish, html }, ctx()),
      ).rejects.toThrow("isn't a checked guide");
    }
    // Over the search-result limits is refused at the input.
    await expect(
      executeWrite(c, WEBSITE_PUBLISH_TOOL, { ...publish, title: "t".repeat(61) }, ctx()),
    ).rejects.toThrow();
  });

  it("keeps the first publish time when the same action runs again", async () => {
    const store = new MemoryObjectStore();
    const c = createWebsiteConnector({ store });
    await executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    const later = { ...ctx(), now: () => new Date("2026-11-08T13:00:00.000Z") };
    const r = await executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, later);
    expect((r.output as { publishedAt: string }).publishedAt).toBe(NOW.toISOString());
  });

  it("pings IndexNow only when its key is set, and a failed ping fails nothing", async () => {
    const quiet = fakeReceiver();
    const off = createWebsiteConnector({ store: new MemoryObjectStore(), fetch: quiet.fetch });
    await executeWrite(off, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect(quiet.received).toHaveLength(0);

    const receiver = fakeReceiver({ status: 202 });
    const on = createWebsiteConnector({
      store: new MemoryObjectStore(),
      indexNowKey: "abc123",
      fetch: receiver.fetch,
    });
    const r = await executeWrite(on, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect((r.output as { pinged: boolean }).pinged).toBe(true);
    expect(receiver.received[0]?.url).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(receiver.received[0]?.body))).toEqual({
      host: "mezonas.com",
      key: "abc123",
      keyLocation: "https://mezonas.com/abc123.txt",
      urlList: ["https://mezonas.com/guides/approval-basics"],
    });

    const down = fakeReceiver({ status: 500 });
    const failing = createWebsiteConnector({
      store: new MemoryObjectStore(),
      indexNowKey: "abc123",
      fetch: down.fetch,
    });
    const f = await executeWrite(failing, WEBSITE_PUBLISH_TOOL, publish, ctx());
    expect((f.output as { pinged: boolean }).pinged).toBe(false);
  });

  it("changes a live guide's title and description, and records a core page's for a person", async () => {
    const store = new MemoryObjectStore();
    const c = createWebsiteConnector({ store });
    await executeWrite(c, WEBSITE_PUBLISH_TOOL, publish, ctx());
    const input = {
      path: "/guides/approval-basics",
      title: "Approvals, explained",
      description: "D",
    };
    const before = await captureBefore(c, WEBSITE_META_TOOL, input, ctx());
    expect(before.before).toEqual({ title: publish.title, description: publish.description });
    const r = await executeWrite(c, WEBSITE_META_TOOL, input, ctx(undefined, "k-meta"));
    expect(r.output).toMatchObject({ applied: true });
    expect(
      (await readJson(store, websiteKeys("mezonas.com").guide("approval-basics"))) as object,
    ).toMatchObject({ title: "Approvals, explained", description: "D", html: publish.html });

    const core = await executeWrite(
      c,
      WEBSITE_META_TOOL,
      { path: "/", title: "Mezonas", description: "Back-office work, signed by you." },
      ctx(undefined, "k-core"),
    );
    expect(core.output).toMatchObject({ applied: false, path: "/" });
    await expect(
      executeWrite(
        c,
        WEBSITE_META_TOOL,
        { path: "/guides/missing", title: "T", description: "D" },
        ctx(undefined, "k-missing"),
      ),
    ).rejects.toThrow("no live guide");
  });
});
