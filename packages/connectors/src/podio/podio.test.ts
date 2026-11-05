import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteContext } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { memoryLogger } from "../logger";
import { beginAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError } from "../oauth/tokens";
import { ConnectorRegistry } from "../registry";
import { fakePodio, PODIO_FIXTURES } from "../testing";
import { mapPodioField, podioFieldValues } from "./fields";
import { createPodioConnector, mapPodioItem, PODIO_TOOLS, PodioApiError } from "./index";

const NOW = new Date("2026-11-04T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const APP = PODIO_FIXTURES.app.app_id;
const ITEM = PODIO_FIXTURES.item.item_id;

function creds(over: Record<string, unknown> = {}): JsonObject {
  return {
    accessToken: PODIO_FIXTURES.tokenCode.access_token,
    refreshToken: PODIO_FIXTURES.tokenCode.refresh_token,
    expiresAt: "2026-11-04T23:00:00.000Z",
    userId: 4071234,
    ...over,
  } as JsonObject;
}

function ctx(credentials: JsonObject | null) {
  const store = memoryCredentials(credentials);
  const c: WriteContext = {
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "podio",
      status: "connected",
      externalAccountId: "user:4071234",
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: "run-1:create:0",
  };
  return { c, store };
}

const options = (fetch: ReturnType<typeof fakePodio>["fetch"]) => ({
  clientId: "mezonas-test",
  clientSecret: "podio-secret",
  fetch,
});

const fields = () =>
  PODIO_FIXTURES.app.fields
    .map(mapPodioField)
    .filter((f): f is NonNullable<typeof f> => f !== null);

describe("podio connector", () => {
  it("declares reads and approval-gated writes, no delete", () => {
    const c = createPodioConnector();
    new ConnectorRegistry([c]);
    expect(c.manifest.auth).toBe("oauth2");
    expect(c.manifest.tools.map((t) => [t.id, t.sideEffect, t.verb])).toEqual([
      [PODIO_TOOLS.spaces, "none", "read"],
      [PODIO_TOOLS.apps, "none", "read"],
      [PODIO_TOOLS.app, "none", "read"],
      [PODIO_TOOLS.filter, "none", "read"],
      [PODIO_TOOLS.get, "none", "read"],
      [PODIO_TOOLS.create, "external", "create"],
      [PODIO_TOOLS.update, "external", "update"],
      [PODIO_TOOLS.comment, "external", "create"],
      [PODIO_TOOLS.task, "external", "create"],
    ]);
    expect(c.isConfigured?.()).toBe(false);
  });

  it("signs in: state checked, code exchanged, tokens encrypted, the user as the account", async () => {
    const podio = fakePodio();
    const connector = createPodioConnector(options(podio.fetch));
    const redirectUri = "https://app.mezonas.com/connections/podio/callback";
    const begun = await beginAuthorization({
      connector,
      tenantId: tenant,
      userId: user,
      redirectUri,
      stateSecret: "s".repeat(32),
      now: NOW,
    });
    expect(begun.redirectUrl.startsWith("https://podio.com/oauth/authorize?")).toBe(true);
    expect(begun.redirectUrl).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const done = await completeAuthorization({
      connector,
      params: { code: "fixture-code", state: begun.state },
      session: { tenantId: tenant, userId: user },
      connectionId,
      redirectUri,
      stateSecret: "s".repeat(32),
      cipher,
      now: NOW,
    });
    expect(done.grant).toEqual({ externalAccountId: "user:4071234", config: {} });
    const opened = await cipher.decrypt(done.credentials, { tenantId: tenant, connectionId });
    expect(opened).toMatchObject({
      accessToken: PODIO_FIXTURES.tokenCode.access_token,
      refreshToken: PODIO_FIXTURES.tokenCode.refresh_token,
      userId: 4071234,
    });
    expect(podio.requests[0]?.body).toContain("client_secret=podio-secret");
    await expect(
      connector.handleCallback?.({ code: "used" }, { tenantId: tenant, userId: user, redirectUri }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("lists workspaces and apps, reads an app's fields and filters items by external id", async () => {
    const podio = fakePodio();
    const connector = createPodioConnector(options(podio.fetch));
    const { c } = ctx(creds());
    const spaces = await runReadTool(connector, PODIO_TOOLS.spaces, {}, c);
    expect(spaces.output).toEqual({
      spaces: [
        { spaceId: 7721001, name: "Jobs", orgId: 310045, orgName: "Harbor Millwork" },
        { spaceId: 7721002, name: "Purchasing", orgId: 310045, orgName: "Harbor Millwork" },
      ],
    });
    const apps = await runReadTool(connector, PODIO_TOOLS.apps, { spaceId: 7721001 }, c);
    expect(apps.output).toEqual({
      apps: [
        { appId: APP, name: "Jobs", itemName: "Job" },
        { appId: 26550012, name: "Quotes", itemName: "Quote" },
      ],
    });
    const app = await runReadTool(connector, PODIO_TOOLS.app, { appId: APP }, c);
    const out = app.output as {
      app: { fields: { externalId: string; writable: boolean; options?: unknown }[] };
    };
    expect(out.app.fields.map((f) => [f.externalId, f.writable])).toEqual([
      ["title", true],
      ["status", true],
      ["budget", true],
      ["due", true],
      ["progress", true],
      ["margin", false],
    ]);
    expect(out.app.fields[1]?.options).toEqual([
      { id: 1, text: "Quoted" },
      { id: 2, text: "In production" },
      { id: 3, text: "Delivered" },
    ]);
    expect(podio.apiCalls()[0]?.headers.authorization).toBe(
      `OAuth2 ${PODIO_FIXTURES.tokenCode.access_token}`,
    );

    const found = await runReadTool(
      connector,
      PODIO_TOOLS.filter,
      { appId: APP, filters: { status: [1] } },
      c,
    );
    expect(found.summary).toBe("Found 1 of 1 items");
    expect(found.output).toMatchObject({
      total: 37,
      filtered: 1,
      items: [
        {
          itemId: ITEM,
          appId: APP,
          title: "Kitchen cabinets, Lee",
          fields: { status: ["Quoted"] },
        },
      ],
    });
    const filterCall = podio.apiCalls().find((r) => r.url.endsWith("/filter/"));
    expect(JSON.parse(filterCall?.body ?? "")).toMatchObject({
      filters: { "210002": [1] },
      limit: 20,
    });
    await expect(
      runReadTool(connector, PODIO_TOOLS.filter, { appId: APP, filters: { nope: 1 } }, c),
    ).rejects.toThrow(/no field nope/);
  });

  it("reads an item as plain values", async () => {
    const podio = fakePodio();
    const connector = createPodioConnector(options(podio.fetch));
    const got = await runReadTool(connector, PODIO_TOOLS.get, { itemId: ITEM }, ctx(creds()).c);
    expect(got.output).toEqual({
      item: {
        itemId: ITEM,
        appId: APP,
        appItemId: 42,
        title: "Kitchen cabinets, Lee",
        link: "https://podio.com/harbormillwork/jobs/apps/jobs/items/42",
        revision: 3,
        createdOn: "2026-10-28 14:02:11",
        fields: {
          title: "Kitchen cabinets, Lee",
          status: ["Quoted"],
          budget: { value: "18500.0000", currency: "USD" },
          due: { start: "2026-12-01 00:00:00", end: null },
          margin: "0.2100",
        },
      },
    });
    const missing = await runReadTool(connector, PODIO_TOOLS.get, { itemId: 1 }, ctx(creds()).c);
    expect(missing.output).toEqual({ item: null });
    expect(() => mapPodioItem({ title: "no id" })).toThrow();
  });

  it("checks fields against the app's definition", () => {
    const f = fields();
    expect(
      podioFieldValues(
        f,
        {
          title: "Vanity",
          status: "in production",
          budget: { value: "900.00", currency: "USD" },
          due: "2026-12-05",
          progress: 10,
        },
        { create: true },
      ),
    ).toEqual({
      title: "Vanity",
      status: [2],
      budget: { value: "900.00", currency: "USD" },
      due: { start_date: "2026-12-05" },
      progress: 10,
    });
    expect(() => podioFieldValues(f, { status: "Quoted" }, { create: true })).toThrow(
      /title: required/,
    );
    expect(() => podioFieldValues(f, { title: "x", status: "Lost" }, { create: true })).toThrow(
      /not one of its choices/,
    );
    expect(() => podioFieldValues(f, { title: "x", status: 4 }, { create: true })).toThrow(
      /not one of its choices/,
    );
    expect(() => podioFieldValues(f, { margin: "1" }, { create: false })).toThrow(/can't be set/);
    expect(() => podioFieldValues(f, { "old-notes": "x" }, { create: false })).toThrow(
      /no such field/,
    );
    expect(() => podioFieldValues(f, { budget: 12.5 }, { create: false })).toThrow(
      /budget \(money\)/,
    );
    expect(() => podioFieldValues(f, { progress: 120 }, { create: false })).toThrow(/progress/);
    expect(
      podioFieldValues(
        f,
        { due: { start: "2026-12-05 09:30", end: "2026-12-06" } },
        { create: false },
      ),
    ).toEqual({
      due: { start_utc: "2026-12-05 09:30:00", end_date: "2026-12-06" },
    });
  });

  it("creates an item once (a retried create finds the first by external id), comments, makes a task", async () => {
    const podio = fakePodio();
    const connector = createPodioConnector(options(podio.fetch));
    const { c } = ctx(creds());
    const input = { appId: APP, fields: { title: "Vanity, Okafor", status: "Quoted" } };
    expect((await captureBefore(connector, PODIO_TOOLS.create, input, c)).before).toBeNull();
    const created = await executeWrite(connector, PODIO_TOOLS.create, input, c);
    expect(created.output).toEqual({
      itemId: 1890005678,
      title: "Vanity, Okafor",
      link: "https://podio.com/harbormillwork/jobs/apps/jobs/items/43",
    });
    const post = podio
      .apiCalls()
      .find((r) => r.method === "POST" && r.url.endsWith(`/item/app/${APP}/`));
    expect(JSON.parse(post?.body ?? "")).toEqual({
      fields: { title: "Vanity, Okafor", status: [1] },
      external_id: "run-1:create:0",
    });
    // The same action again (a retry after a lost answer) finds the item instead of making a second.
    await executeWrite(connector, PODIO_TOOLS.create, input, c);
    expect(
      podio.apiCalls().filter((r) => r.method === "POST" && r.url.endsWith(`/item/app/${APP}/`)),
    ).toHaveLength(1);
    await expect(
      executeWrite(connector, PODIO_TOOLS.create, { appId: APP, fields: { status: "Quoted" } }, c),
    ).rejects.toThrow(/required/);

    const comment = await executeWrite(
      connector,
      PODIO_TOOLS.comment,
      { itemId: ITEM, text: "Deposit received." },
      c,
    );
    expect(comment.output).toEqual({ itemId: ITEM, commentId: 771230001 });
    const task = await executeWrite(
      connector,
      PODIO_TOOLS.task,
      { text: "Order hinges", dueDate: "2026-11-10", itemId: ITEM },
      c,
    );
    expect(task.output).toEqual({ taskId: 551230001, link: "https://podio.com/tasks/551230001" });
    expect(JSON.parse(podio.apiCalls().at(-1)?.body ?? "")).toEqual({
      text: "Order hinges",
      due_date: "2026-11-10",
      ref_type: "item",
      ref_id: ITEM,
      external_id: "run-1:create:0",
    });
  });

  it("updates with the fields' before state and refuses a stale revision", async () => {
    const podio = fakePodio();
    const connector = createPodioConnector(options(podio.fetch));
    const { c } = ctx(creds());
    const input = {
      itemId: ITEM,
      fields: { status: "In production", progress: 25 },
      expectedRevision: 3,
    };
    const proposed = await captureBefore(connector, PODIO_TOOLS.update, input, c);
    expect(proposed.before).toEqual({
      itemId: ITEM,
      appId: APP,
      revision: 3,
      fields: { status: ["Quoted"], progress: null },
    });
    const done = await executeWrite(connector, PODIO_TOOLS.update, input, c);
    expect(done.output).toEqual({ itemId: ITEM, revision: 4 });
    const put = podio.apiCalls().find((r) => r.method === "PUT");
    expect(JSON.parse(put?.body ?? "")).toEqual({
      fields: { status: [2], progress: 25 },
      revision: 3,
    });
    await expect(executeWrite(connector, PODIO_TOOLS.update, input, c)).rejects.toThrow(
      /changed since/,
    );
    expect(podio.apiCalls().filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("refreshes on an expired token and persists it; asks for a reconnect when the grant is gone", async () => {
    const podio = fakePodio({ acceptAccessTokens: [PODIO_FIXTURES.tokenRefresh.access_token] });
    const connector = createPodioConnector(options(podio.fetch));
    const { c, store } = ctx(creds());
    await runReadTool(connector, PODIO_TOOLS.get, { itemId: ITEM }, c);
    expect(store.writes).toBe(1);
    expect(store.current()).toMatchObject({
      accessToken: PODIO_FIXTURES.tokenRefresh.access_token,
      refreshToken: PODIO_FIXTURES.tokenRefresh.refresh_token,
      expiresAt: "2026-11-04T23:00:00.000Z",
    });
    const expiring = fakePodio();
    const { c: c2, store: s2 } = ctx(creds({ expiresAt: "2026-11-04T15:02:00.000Z" }));
    await runReadTool(
      createPodioConnector(options(expiring.fetch)),
      PODIO_TOOLS.get,
      { itemId: ITEM },
      c2,
    );
    expect(expiring.requests[0]?.url).toBe("https://api.podio.com/oauth/token");
    expect(s2.writes).toBe(1);

    const revoked = fakePodio({ acceptAccessTokens: [] });
    revoked.failRefreshes();
    await expect(
      runReadTool(
        createPodioConnector(options(revoked.fetch)),
        PODIO_TOOLS.get,
        { itemId: ITEM },
        ctx(creds()).c,
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("marks rate limits (420) retryable", async () => {
    const podio = fakePodio({ rateLimitNext: 1 });
    const err = await runReadTool(
      createPodioConnector(options(podio.fetch)),
      PODIO_TOOLS.get,
      { itemId: ITEM },
      ctx(creds()).c,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PodioApiError);
    expect(err).toMatchObject({ status: 420, retryable: true });
  });
});
