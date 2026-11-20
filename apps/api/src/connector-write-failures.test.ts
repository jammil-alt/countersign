// PLATFORM_QA INTEG-4, INTEG-5, INTEG-6 (from the audit's integ-connectors repro): connectors'
// writes when the provider fails (a token refresh that fails, a 429), run through the real write
// path: `executeWrite` (what packages/agents `executeAction` calls) and,
// for the action's record, `executeAction` itself over an in-memory external-action store (the
// pattern of packages/agents/src/runtime/write-failures.unit.test.ts). Providers are the
// connectors' own fakes with an injected fetch.

import { actionWrote, DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { SkillCatalog } from "../../../packages/agents/src/registry/skills";
import { ToolRegistry } from "../../../packages/agents/src/registry/tools";
import { executeAction } from "../../../packages/agents/src/runtime/actions";
import type { RuntimeDeps } from "../../../packages/agents/src/runtime/context";
import type {
  ExternalActionRecord,
  ExternalActionStore,
} from "../../../packages/agents/src/runtime/ports";
import { PLATFORM_TOOLS } from "../../../packages/agents/src/tools/platform";
import type {
  WriteAttemptServices,
  WriteAttemptState,
} from "../../../packages/connectors/src/attempts";
import type { ConnectionRef, WriteContext } from "../../../packages/connectors/src/connector";
import { memoryCredentials } from "../../../packages/connectors/src/credentials-accessor";
import { fakeGoogleChat } from "../../../packages/connectors/src/gchat/fake";
import {
  createGchatConnector,
  GCHAT_POST_TOOL,
} from "../../../packages/connectors/src/gchat/index";
import type { FetchLike } from "../../../packages/connectors/src/http";
import { executeWrite } from "../../../packages/connectors/src/invoke";
import { FAKE_LINKEDIN, fakeLinkedIn } from "../../../packages/connectors/src/linkedin/fake";
import {
  createLinkedInConnector,
  LINKEDIN_POST_TOOL,
  LINKEDIN_TOKEN_URL,
} from "../../../packages/connectors/src/linkedin/index";
import { noopLogger } from "../../../packages/connectors/src/logger";
import type {
  MessagingServices,
  OutboundMessage,
  SendAttempt,
} from "../../../packages/connectors/src/messaging/services";
import { SMS_SEND_TOOL, WHATSAPP_SEND_TOOL } from "../../../packages/connectors/src/messaging/spec";
import { ConnectorRegistry } from "../../../packages/connectors/src/registry";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "../../../packages/connectors/src/twilio/fake";
import {
  buyNumber,
  createSubaccount,
  createTwilioConnector,
  type TwilioConfig,
} from "../../../packages/connectors/src/twilio/index";
import { FAKE_META, fakeMeta } from "../../../packages/connectors/src/whatsapp_meta/fake";
import {
  completeEmbeddedSignup,
  createWhatsappMetaConnector,
} from "../../../packages/connectors/src/whatsapp_meta/index";

// ── LinkedIn ────────────────────────────────────────────────────────────────────────────────────

const LI_TENANT = "0192f7a0-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-11-08T12:00:00Z");

/** The platform's write-attempt records, in memory (as linkedin.test.ts keeps them). */
function memoryAttempts(): WriteAttemptServices {
  const started = new Map<string, { details: JsonObject; at: Date }>();
  const refused = new Set<string>();
  const done = new Map<string, JsonObject>();
  return {
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
}

describe("INTEG linkedin: a token refresh that fails before the post", () => {
  it("(PLATFORM_QA INTEG-4) a retry under the same key posts, since nothing reached LinkedIn", async () => {
    const li = fakeLinkedIn();
    let tokenDown = false;
    const fetch: FetchLike = async (url, init) => {
      if (tokenDown && url.startsWith(LINKEDIN_TOKEN_URL)) {
        // LinkedIn's token endpoint has an incident (a 503 with OAuth's server_error).
        return {
          status: 503,
          ok: false,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ error: "server_error" }),
        };
      }
      return li.fetch(url, init);
    };
    const connector = createLinkedInConnector({ ...FAKE_LINKEDIN, fetch });
    const grant = await connector.handleCallback?.(
      { code: li.issueCode(), state: "s" },
      { tenantId: LI_TENANT, userId: "u1", redirectUri: "https://app.example.com/cb" },
    );
    if (!grant) throw new Error("no grant");
    const credentials = memoryCredentials(grant.credentials);
    // The access token has expired: the post needs a refresh first.
    await credentials.set({
      ...((await credentials.get()) as JsonObject),
      expiresAt: "2026-11-08T11:00:00.000Z",
    });
    const connection: ConnectionRef = {
      id: "0192f7a0-0000-7000-8000-0000000000b5",
      tenantId: LI_TENANT,
      connector: "linkedin",
      status: "connected",
      externalAccountId: grant.externalAccountId,
      config: grant.config ?? {},
      permissions: {},
    };
    const ctx = {
      tenantId: LI_TENANT,
      connection,
      credentials,
      logger: noopLogger,
      now: () => NOW,
      services: { attempts: memoryAttempts() },
      idempotencyKey: "run-1:post:0",
    };
    const input = { text: "Our spring hours start Monday." };

    tokenDown = true;
    const first = await executeWrite(connector, LINKEDIN_POST_TOOL, input, ctx).then(
      () => null,
      (e: Error & { notWritten?: boolean }) => e,
    );
    // The first try failed at the refresh, before anything was sent to LinkedIn's posts API.
    expect(first?.name).toBe("TokenRefreshError");
    expect(first?.notWritten).toBe(true);
    expect(li.posts).toHaveLength(0);

    // The token endpoint is back; the run's retry carries the approved write under its key.
    tokenDown = false;
    const second = await executeWrite(connector, LINKEDIN_POST_TOOL, input, ctx).then(
      () => "posted",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    expect(second).toBe("posted");
    expect(li.posts).toHaveLength(1);
  });
});

// ── Google Chat ─────────────────────────────────────────────────────────────────────────────────

const T = "0192f7a0-0000-7000-8000-0000000000aa";
const SPACE = "spaces/AAAAops42";

function memoryActions(action: ExternalActionRecord) {
  const rows = new Map<string, ExternalActionRecord>([[action.id, action]]);
  const put = (a: ExternalActionRecord) => {
    rows.set(a.id, a);
    return { ...a };
  };
  const store = {
    keepsAfter: false,
    async get(_t: string, id: string) {
      const a = rows.get(id);
      return a ? { ...a } : null;
    },
    async claim(_t: string, id: string) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      if (a.status !== "approved") return { action: { ...a }, claimed: false };
      return { action: put({ ...a, status: "executing" }), claimed: true };
    },
    async complete(_t: string, id: string, result: { output: unknown; before: unknown }) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      return put({ ...a, status: "done", result: result.output, before: result.before });
    },
    async fail(_t: string, id: string, error: Record<string, unknown>) {
      const a = rows.get(id);
      if (!a) throw new Error("missing");
      return put({ ...a, status: "failed", error: error as never });
    },
  } as unknown as ExternalActionStore;
  return { store, rows };
}

describe("INTEG gchat: a 429 on a post", () => {
  it("(PLATFORM_QA INTEG-5) Google Chat's rate limit is recorded as not written (or retried), never as may-have-posted", async () => {
    const google = await fakeGoogleChat();
    google.addAppTo(SPACE);
    const connector = createGchatConnector({
      serviceAccount: google.serviceAccount,
      projectNumber: google.projectNumber,
      fetch: google.fetch,
    });
    const conn: ConnectionRef = {
      id: "0192f7a0-0000-7000-8000-00000000000a",
      tenantId: T,
      connector: "gchat",
      status: "connected",
      externalAccountId: null,
      config: {
        spaces: [
          {
            name: SPACE,
            displayName: "Shop floor",
            kind: "space",
            boundAt: "2026-11-06T15:00:00.000Z",
            boundBy: "Ana Ruiz",
          },
        ],
      } as unknown as ConnectionRef["config"],
      permissions: { read: "auto", create: "auto", update: "auto", delete: "off" },
    };
    const mem = memoryActions({
      id: "a1",
      tenantId: T,
      connectionId: conn.id,
      tool: GCHAT_POST_TOOL,
      runId: "r1",
      stepRunId: "s1",
      agentVersionId: null,
      input: { space: SPACE, text: "Line 2 is down for 20 minutes." },
      idempotencyKey: "r1:post:0",
      status: "approved",
      inboxItemId: null,
      approvedBy: "u1",
      result: null,
      error: null,
      before: null,
    } as unknown as ExternalActionRecord);
    const deps = {
      tools: new ToolRegistry({
        platform: PLATFORM_TOOLS,
        connectors: new ConnectorRegistry([connector]),
      }),
      catalog: new SkillCatalog([]),
      transport: undefined as never,
      ports: {
        store: {
          connection: async () => conn,
          run: async () => ({ mode: "live", agentId: "agent-1" }),
          grant: async () => null,
        },
        actions: mem.store,
      },
    } as unknown as RuntimeDeps;

    // Chat answers 429 RESOURCE_EXHAUSTED (per-space write quota): nothing was posted.
    google.failNext(429);
    const out = await executeAction(deps, { tenantId: T, actionId: "a1" });
    const action = mem.rows.get("a1");
    if (!action) throw new Error("no action");
    expect(google.messages).toHaveLength(0);
    // Expected: posted after Chat's backoff, or failed as known not written, so the step may go
    // on and a retry isn't told "the change may have happened: check before trying again".
    if (out.status !== "done") {
      expect(action.error).toMatchObject({ notWritten: true });
      expect(actionWrote(action)).toBe(false);
    }
  });
});

// ── Twilio ──────────────────────────────────────────────────────────────────────────────────────

const TW_NOW = new Date("2026-11-04T15:00:00.000Z");
const TW_TENANT = "0190f0c8-0000-7000-8000-000000000001";

/** Contacts, consent and send records in memory, as apps/api's MessagingServices answer them. */
function memoryMessaging() {
  const recorded: OutboundMessage[] = [];
  const attempts: SendAttempt[] = [];
  const refused = new Set<string>();
  const tryOf = (a: SendAttempt) => a.attempt ?? 1;
  const services: MessagingServices = {
    async checkSend() {
      return {
        ok: true,
        contact: { id: "c1", name: "Pat Lee", language: null },
        lastInboundAt: null,
        lastTextAt: new Date(TW_NOW.getTime() - 24 * 60 * 60 * 1000),
        client: "Rivera Supply",
      };
    },
    async sentFor(key) {
      const r = recorded.find((m) => m.idempotencyKey === key);
      return r
        ? {
            sid: r.sid,
            status: r.status,
            channel: r.channel,
            to: r.to,
            from: r.from,
            templateId: r.templateId,
            contactId: r.contactId,
            contactName: "Pat Lee",
          }
        : null;
    },
    // One record per key and try; a try the provider refused is recorded beside it.
    async startAttempt(a) {
      if (!attempts.some((x) => x.idempotencyKey === a.idempotencyKey && tryOf(x) === tryOf(a))) {
        attempts.push({ ...a, attempt: tryOf(a) });
      }
    },
    async attemptFor(key) {
      const newest = attempts
        .filter((a) => a.idempotencyKey === key)
        .sort((x, y) => tryOf(y) - tryOf(x))[0];
      return newest ? { ...newest, refused: refused.has(`${key}#${tryOf(newest)}`) } : null;
    },
    async refuseAttempt({ idempotencyKey, attempt }) {
      refused.add(`${idempotencyKey}#${attempt}`);
    },
    async recordedSids(sids) {
      return sids.filter((sid) => recorded.some((m) => m.sid === sid));
    },
    async recordOutbound(m) {
      if (!recorded.some((r) => r.sid === m.sid)) recorded.push(m);
    },
  };
  return { services, recorded, attempts };
}

describe("INTEG twilio: a 429 on a text", () => {
  it("(PLATFORM_QA INTEG-6) a text Twilio turned away (429) is sent by the run's retry, not held as may-have-been-sent", async () => {
    const twilio = fakeTwilio({ now: () => TW_NOW });
    const sub = await createSubaccount(twilio.fetch, FAKE_TWILIO_MAIN, "Client A");
    const bought = await buyNumber(twilio.fetch, sub, {
      phoneNumber: "+15125550101",
      smsUrl: "https://app.mezonas.test/api/twilio/x/messages",
      friendlyName: "Client A",
      now: TW_NOW,
    });
    const config: TwilioConfig = {
      subaccountSid: sub.accountSid,
      numbers: [{ ...bought, whatsapp: false }],
      a2p: {
        brandSid: null,
        messagingServiceSid: null,
        brandStatus: "APPROVED",
        campaignStatus: "VERIFIED",
        status: "approved",
        checkedAt: null,
      },
      webhooks: {
        messages: "https://app.mezonas.test/api/twilio/x/messages",
        status: "https://app.mezonas.test/api/twilio/x/status",
      },
      provisionedAt: TW_NOW.toISOString(),
    };
    let limited = true;
    const fetch: FetchLike = async (url, init) => {
      if (limited && init?.method === "POST" && url.endsWith("/Messages.json")) {
        limited = false;
        // Twilio's rate limit (error 20429): the message was not created.
        return {
          status: 429,
          ok: false,
          headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "1" : null) },
          text: async () =>
            JSON.stringify({ code: 20429, message: "Too Many Requests", status: 429 }),
        };
      }
      return twilio.fetch(url, init);
    };
    const connector = createTwilioConnector({ fetch });
    const m = memoryMessaging();
    const ctx: WriteContext = {
      tenantId: TW_TENANT,
      connection: {
        id: "0190f0c8-0000-7000-8000-0000000000c1",
        tenantId: TW_TENANT,
        connector: "twilio",
        status: "connected",
        externalAccountId: sub.accountSid,
        config: config as unknown as JsonObject,
        permissions: DEFAULT_PERMISSIONS,
      },
      credentials: memoryCredentials(sub as unknown as JsonObject),
      logger: noopLogger,
      now: () => TW_NOW,
      idempotencyKey: "run-1:send:0",
      services: { messaging: m.services },
    };
    const input = { to: "+15555550100", text: "Your order is ready." };
    const first = await executeWrite(connector, SMS_SEND_TOOL, input, ctx).then(
      () => null,
      (e: Error & { status?: number }) => e,
    );
    expect(first?.status).toBe(429);
    expect(twilio.sends()).toHaveLength(0);
    // The run's retry, under the same key (a carried approval), once the limit has passed.
    const second = await executeWrite(connector, SMS_SEND_TOOL, input, ctx).then(
      () => "sent",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    expect(second).toBe("sent");
    expect(m.recorded).toHaveLength(1);
    expect(twilio.sends()).toHaveLength(1);
    // The refused try and the one that went out are both on record.
    expect(m.attempts.map((a) => a.attempt)).toEqual([1, 2]);
  });
});

// ── WhatsApp through Meta ───────────────────────────────────────────────────────────────────────

describe("INTEG whatsapp_meta: Meta's rate limit on a send", () => {
  it("(PLATFORM_QA INTEG-6) a WhatsApp message Meta turned away (130429) is sent by the run's retry", async () => {
    const meta = fakeMeta();
    const m = memoryMessaging();
    const services: MessagingServices = {
      ...m.services,
      async checkSend() {
        return {
          ok: true,
          contact: { id: "c1", name: "Pat Lee", language: "es" },
          lastInboundAt: new Date("2026-11-06T14:00:00Z"),
        };
      },
      async statusSidFor() {
        return null;
      },
    };
    const connector = createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch });
    const grant = await completeEmbeddedSignup(meta.fetch, FAKE_META, { code: meta.issueCode() });
    const ctx: WriteContext = {
      tenantId: "t1",
      connection: {
        id: "conn-meta",
        tenantId: "t1",
        connector: "whatsapp_meta",
        status: "connected",
        externalAccountId: grant.externalAccountId ?? null,
        config: grant.config ?? {},
        permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      },
      credentials: memoryCredentials(grant.credentials),
      logger: noopLogger,
      now: () => new Date("2026-11-06T15:00:00Z"),
      services: { messaging: services },
      idempotencyKey: "r:s:0",
    };
    const input = { to: "+15555550100", text: "Your order is ready" };
    // Meta's "rate limit hit" (130429): Graph answered with an error and sent nothing.
    meta.refuseNext(1, 130429);
    await expect(executeWrite(connector, WHATSAPP_SEND_TOOL, input, ctx)).rejects.toThrow();
    expect(meta.sent).toHaveLength(0);
    const second = await executeWrite(connector, WHATSAPP_SEND_TOOL, input, ctx).then(
      () => "sent",
      (e: Error) => `${e.name}: ${e.message}`,
    );
    expect(second).toBe("sent");
    expect(meta.sent).toHaveLength(1);
  });
});
