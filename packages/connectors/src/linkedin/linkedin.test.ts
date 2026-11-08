// §1.77 (M49): the LinkedIn connector against its fake: "not available yet" without our app's
// keys; sign-in asks for the two page scopes only and keeps the pages the person administers;
// `linkedin.post` is always signed (no matrix, step or mode lets it run on its own), posts only as
// one of those pages, escapes LinkedIn's markup, refreshes an expired token, never posts twice
// for one action, and treats a lost answer as unconfirmed.

import {
  DEFAULT_PERMISSIONS,
  decideToolCall,
  isAlwaysSigned,
  type JsonObject,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteAttemptServices, WriteAttemptState } from "../attempts";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode, parseUrl } from "../http";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import { FAKE_LINKEDIN, fakeLinkedIn } from "./fake";
import {
  createLinkedInConnector,
  LINKEDIN_AUTH_URL,
  LINKEDIN_POST_TOOL,
  LINKEDIN_VERSION,
  LinkedInNotConfiguredError,
  linkedInCommentary,
} from "./index";

const TENANT = "0192f7a0-0000-7000-8000-0000000000b1";
const REDIRECT = "https://app.example.com/connections/linkedin/callback";
const NOW = new Date("2026-11-08T12:00:00Z");

function memoryAttempts() {
  const started = new Map<string, { details: JsonObject; at: Date }>();
  const refused = new Set<string>();
  const done = new Map<string, JsonObject>();
  const s: WriteAttemptServices = {
    async stateFor(key): Promise<WriteAttemptState> {
      const mine = [...started.entries()].filter(([k]) => k.startsWith(`${key}#`));
      const last = mine.at(-1)?.[1];
      return {
        done: done.get(key) ?? null,
        started: mine.length,
        refused: [...refused].filter((k) => k.startsWith(`${key}#`)).length,
        last: last ? { details: last.details, startedAt: last.at } : null,
      };
    },
    async start({ idempotencyKey, attempt, details, at }) {
      const k = `${idempotencyKey}#${attempt}`;
      if (started.has(k)) return false;
      started.set(k, { details, at });
      return true;
    },
    async refused({ idempotencyKey, attempt }) {
      refused.add(`${idempotencyKey}#${attempt}`);
    },
    async done({ idempotencyKey, output }) {
      if (!done.has(idempotencyKey)) done.set(idempotencyKey, output);
    },
  };
  return s;
}

async function signIn(pages?: string[]) {
  const li = fakeLinkedIn();
  const connector = createLinkedInConnector({ ...FAKE_LINKEDIN, fetch: li.fetch });
  const code = li.issueCode(pages ? { pages } : {});
  const grant = await connector.handleCallback?.(
    { code, state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { li, connector, grant };
}

async function setup(pages?: string[], key = "run-1:post:0") {
  const { li, connector, grant } = await signIn(pages);
  const credentials = memoryCredentials(grant.credentials);
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-0000000000b5",
    tenantId: TENANT,
    connector: "linkedin",
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: grant.config ?? {},
    permissions: {},
  };
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { attempts: memoryAttempts() },
    idempotencyKey: key,
  };
  return { li, connector, grant, ctx, credentials };
}

describe("linkedin sign-in", () => {
  it("is not available without our app's keys", async () => {
    const off = createLinkedInConnector({});
    expect(off.isConfigured?.()).toBe(false);
    await expect(
      off.authorize?.({ tenantId: TENANT, userId: "u1", state: "x", redirectUri: REDIRECT }),
    ).rejects.toThrow(LinkedInNotConfiguredError);
    expect(createLinkedInConnector(FAKE_LINKEDIN).isConfigured?.()).toBe(true);
  });

  it("asks for posting as a page and listing the pages, nothing else", async () => {
    const connector = createLinkedInConnector(FAKE_LINKEDIN);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const url = parseUrl(redirectUrl);
    expect(`${url?.origin}${url?.pathname}`).toBe(LINKEDIN_AUTH_URL);
    expect(formDecode(redirectUrl.split("?")[1] ?? "")).toEqual({
      response_type: "code",
      client_id: FAKE_LINKEDIN.clientId,
      redirect_uri: REDIRECT,
      state: "the-state",
      scope: "w_organization_social r_organization_admin",
    });
  });

  it("keeps the tokens and the pages the person administers", async () => {
    const { grant } = await signIn(["2414183", "5550001"]);
    expect(grant.externalAccountId).toBe("urn:li:organization:2414183");
    expect(grant.config).toEqual({
      pages: [
        { id: "2414183", name: "Mezonas" },
        { id: "5550001", name: "Twelve Thirty-Four" },
      ],
      accountName: "Mezonas, Twelve Thirty-Four",
      scopes: ["w_organization_social", "r_organization_admin"],
    });
    expect(grant.credentials).toMatchObject({
      accessToken: expect.stringMatching(/^li-access-/),
      refreshToken: expect.stringMatching(/^li-refresh-/),
      scope: "w_organization_social r_organization_admin",
    });
  });

  it("refuses a grant without posting, with more than we ask, or with no page", async () => {
    const li = fakeLinkedIn();
    const connector = createLinkedInConnector({ ...FAKE_LINKEDIN, fetch: li.fetch });
    const req = { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT };
    for (const scopes of [
      ["r_organization_admin"],
      ["w_organization_social", "r_organization_admin", "w_member_social"],
    ]) {
      await expect(
        connector.handleCallback?.({ code: li.issueCode({ scopes }), state: "s" }, req),
      ).rejects.toThrow(SignInRefusedError);
    }
    await expect(
      connector.handleCallback?.({ code: li.issueCode({ pages: [] }), state: "s" }, req),
    ).rejects.toThrow(/don't administer a LinkedIn company page/);
  });

  it("revokes the token on disconnect", async () => {
    const { li, connector, ctx, grant } = await setup();
    await connector.revoke?.(ctx);
    expect(li.revoked).toEqual([grant.credentials.accessToken]);
  });
});

describe("linkedin.post", () => {
  it("is always signed: no matrix, step or mode lets it run on its own", async () => {
    const { connector } = await setup();
    const spec = connector.manifest.tools.find((t) => t.id === LINKEDIN_POST_TOOL);
    expect(spec).toMatchObject({
      sideEffect: "external",
      verb: "create",
      entity: "post",
      approval: "always",
    });
    if (!spec) throw new Error("no spec");
    expect(isAlwaysSigned(spec)).toBe(true);
    const matrix = { ...connectionDefaults(connector.manifest), create: "auto" as const };
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix,
        stepApproval: "not_required",
        agentMode: "act",
        alwaysSigned: isAlwaysSigned(spec),
      }),
    ).toBe("approval");
  });

  it("posts as the one page, escaped, once per action", async () => {
    const { li, connector, ctx } = await setup();
    const input = { text: "Approvals by email #ops @here (still) <3" };
    const { before } = await captureBefore(connector, LINKEDIN_POST_TOOL, input, ctx);
    expect(before).toEqual({ page: { id: "2414183", name: "Mezonas" }, text: input.text });
    const { output } = await executeWrite(connector, LINKEDIN_POST_TOOL, input, ctx);
    expect(output).toEqual({
      id: "urn:li:share:7000003",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7000003/",
      page: { id: "2414183", name: "Mezonas" },
    });
    expect(li.posts).toHaveLength(1);
    expect(li.posts[0]).toMatchObject({
      author: "urn:li:organization:2414183",
      version: LINKEDIN_VERSION,
      body: {
        commentary: "Approvals by email \\#ops \\@here \\(still\\) \\<3",
        visibility: "PUBLIC",
        lifecycleState: "PUBLISHED",
      },
    });
    // The same action again returns what was posted, and posts nothing.
    const again = await executeWrite(connector, LINKEDIN_POST_TOOL, input, ctx);
    expect(again.output).toEqual(output);
    expect(li.posts).toHaveLength(1);
  });

  it("needs the page named when there are several, and only the client's", async () => {
    const { connector, ctx } = await setup(["2414183", "5550001"]);
    await expect(
      captureBefore(connector, LINKEDIN_POST_TOOL, { text: "Hello" }, ctx),
    ).rejects.toThrow(/name the company page/);
    await expect(
      captureBefore(connector, LINKEDIN_POST_TOOL, { text: "Hello", page: "999" }, ctx),
    ).rejects.toThrow(/not one of the client's/);
    const { before } = await captureBefore(
      connector,
      LINKEDIN_POST_TOOL,
      { text: "Hello", page: "5550001" },
      ctx,
    );
    expect(before).toMatchObject({ page: { name: "Twelve Thirty-Four" } });
  });

  it("refreshes an expired token and posts", async () => {
    const { li, connector, ctx, credentials } = await setup();
    li.expireTokens();
    await executeWrite(connector, LINKEDIN_POST_TOOL, { text: "After a refresh" }, ctx);
    expect(li.posts).toHaveLength(1);
    expect(credentials.writes).toBeGreaterThan(0);
  });

  it("may try again after a refusal, never after a lost answer", async () => {
    const refused = await setup(undefined, "run-2:post:0");
    refused.li.refuseNext(422);
    await expect(
      executeWrite(refused.connector, LINKEDIN_POST_TOOL, { text: "Try" }, refused.ctx),
    ).rejects.toThrow(/LinkedIn refused the post \(422\)/);
    await executeWrite(refused.connector, LINKEDIN_POST_TOOL, { text: "Try" }, refused.ctx);
    expect(refused.li.posts).toHaveLength(1);

    const lost = await setup(undefined, "run-3:post:0");
    lost.li.loseNextAnswer();
    await expect(
      executeWrite(lost.connector, LINKEDIN_POST_TOOL, { text: "Lost" }, lost.ctx),
    ).rejects.toThrow(/connection dropped/);
    await expect(
      executeWrite(lost.connector, LINKEDIN_POST_TOOL, { text: "Lost" }, lost.ctx),
    ).rejects.toThrow(UnconfirmedWriteError);
    expect(lost.li.posts).toHaveLength(1);
  });

  it("escapes every markup character", () => {
    expect(linkedInCommentary("a\\b|c{d}e@f[g]h(i)j<k>l#m*n_o~p\u0007")).toBe(
      "a\\\\b\\|c\\{d\\}e\\@f\\[g\\]h\\(i\\)j\\<k\\>l\\#m\\*n\\_o\\~p",
    );
    expect(linkedInCommentary("line one\nline two")).toBe("line one\nline two");
  });
});
