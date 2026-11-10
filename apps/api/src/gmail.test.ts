// Gmail, send only (plan M10), through the API against a fake Google (nothing live): a person
// connects their own Gmail from the portal (`gmail.send` plus `openid email`; a grant without send
// is refused), the tokens go to the vault and never into a response; the operator binds it as an
// agent's email channel; a reach-out is sent from the mailbox only after approval and only once,
// as a proper UTF-8 message in the contact's language, with the reply-to tagged at the client's
// forwarding address, and the reply comes back through forwarding; test runs send nothing; the
// agent's grant and human release hold at each send; an expired access token is refreshed and an
// ended grant asks for a reconnect; disconnecting revokes the grant at Google.

import {
  createGmailConnector,
  GMAIL_SEND_TOOL,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_GOOGLE, fakeGoogle, readSentEmail } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, externalAction, rawRecord, reachOut, stepRun } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  user,
} from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { reachOutTick } from "./reach/service";
import { credentialsFor, executeRun, reachDepsFor } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const FORWARDING = "in.mezonas.test";
const MAILBOX = "pat.lee@gmail.test";
const MARIA = "maria@proveedor.example";
const PURPOSE = "Confirm Friday's delivery of the oak order";
const SUBJECT = "Entrega del viernes: pedido nº {{trigger.order}}";
const SPANISH = "Hola, ¿confirma la entrega del viernes? Responda SÍ o NO. Gracias.";
const google = fakeGoogle();

const h = await createApiHarness({
  connectors: () => [createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch })],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    EMAIL_FORWARDING_DOMAIN: FORWARDING,
  },
});
afterAll(() => h?.close());

function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Orders", role: "orders desk", mission: "Keep deliveries on time." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [{ skill: "comms.reach-out" }],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: {
            id: "trg",
            on: {
              type: "manual",
              input: {
                type: "object",
                properties: { order: { type: "string" } },
                required: ["order"],
              },
            },
          },
          steps: [
            {
              id: "reach",
              name: "Ask the vendor",
              kind: "skill",
              skill: "comms.reach-out",
              input: {
                to: { role: "vendor" },
                about: ["{{trigger.order}}"],
                purpose: PURPOSE,
                subject: SUBJECT,
                message: {
                  template: {
                    en: "Can you confirm Friday's delivery? Reply YES or NO.",
                    es: SPANISH,
                  },
                },
                urgency: "fyi",
                expectReply: true,
                timeout: "2 days",
              },
              approval: { required: "required" },
              client: { visible: true, label: "Asked the vendor" },
            },
          ],
        },
      },
    ],
    people: [{ role: "vendor", description: "Ships the oak", required: true, channels: ["email"] }],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Gmail, send only, through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  let gmailConn = "";
  let agentId = "";
  let versionId = "";
  let maria = "";
  let forwarding = "";
  /** Every response either side read, to look for a token in any of them. */
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    return res;
  };

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });

  const appDeps = () => ({
    ...defaultDeps,
    openDb: () => ({ db: H.db, close: async () => {} }),
    instances: () => H.instances,
    objects: () => H.objects,
    extractionTransport: () => null,
  });

  async function startRun(order: string, mode: "run" | "test" = "run") {
    const res =
      mode === "test"
        ? await call(
            OPERATOR,
            "POST",
            `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
            {
              workflow: "main",
              payload: { order },
            },
          )
        : await call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
            workflow: "main",
            input: { order },
          });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no run started");
    return params;
  }

  async function approveItem(type: string, check?: (item: ReturnType<typeof j>) => void) {
    const res = await call(admin("a"), "GET", "/api/inbox");
    const item = j(res.json).items.find(
      (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
    );
    if (!item) throw new Error(`no open item for ${type}`);
    check?.(item);
    const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "approve",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return H.instances.events.find((e) => e.event.type === type)?.event.payload;
  }

  /** Runs one reach-out: approves its plan; no reply comes, so the cron ends it after its timeout. */
  async function runWithoutReply(order: string) {
    const params = await startRun(order);
    const step = new FakeWorkflowStep(async (_name, type) => {
      if (type.startsWith("inbox-")) return approveItem(type);
      await reachOutTick(reachDepsFor(deps()), A(), new Date(Date.now() + 3 * 86_400_000));
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    await executeRun(deps(), params, cloudflareStepRunner(step));
    return params;
  }

  const stepOutput = async (runId: string) => {
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, runId), eq(stepRun.nodeId, "reach")));
    return j(row?.output);
  };

  const actionsOf = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));

  async function signIn(who: string, code: string) {
    const start = await call(who, "POST", "/api/connections/gmail/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    return call(who, "POST", "/api/connections/gmail/callback", { params: { code, state } });
  }

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "gmail"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const fwd = await call(admin("a"), "GET", "/api/connections/upload/forwarding");
    expect(fwd.status, JSON.stringify(fwd.json)).toBe(200);
    forwarding = j(fwd.json).forwarding.address;
    const made = await call(admin("a"), "POST", "/api/contacts", {
      name: "María Núñez",
      email: MARIA,
      language: "es",
      consent: { channels: ["email"], source: "signed the supplier agreement" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    maria = j(made.json).contact.id;
  });

  it("lets a person connect their own Gmail: send only, state bound, tokens in the vault", async () => {
    const list = await call(user("a"), "GET", "/api/connections");
    // Wave 3b: how it connects, from its manifest (the portal says "you sign in" only for these).
    expect(
      j(list.json).connections.find((c: { connector: string }) => c.connector === "gmail"),
    ).toMatchObject({ available: true, personal: true, connection: null, auth: "oauth2" });
    // The operator never signs a client in; a client user signs in to their own account only.
    expect((await call(OPERATOR, "POST", "/api/connections/gmail/authorize")).status).toBe(403);
    expect((await call(user("a"), "POST", "/api/connections/testkit/authorize")).status).toBe(403);

    const start = await call(user("a"), "POST", "/api/connections/gmail/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(redirect.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.send",
    );
    expect(redirect.searchParams.get("access_type")).toBe("offline");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/connections/gmail/callback`,
    );
    const state = redirect.searchParams.get("state") ?? "";

    // Google returns to the API path, which only forwards the parameters to the portal's page.
    const code = google.issueCode({ address: MAILBOX });
    const back = await H.call(
      null,
      "GET",
      `/api/connections/gmail/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=x`,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(
      `/connections/gmail/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=x`,
    );

    // Send left unticked on Google's screen: refused, nothing kept.
    const noSend = await call(user("a"), "POST", "/api/connections/gmail/callback", {
      params: { code: google.issueCode({ scopes: ["openid", "email"] }), state },
    });
    expect(noSend.status).toBe(422);
    expect(j(noSend.json).error.code).toBe("sign_in_refused");
    expect(
      await H.t.db
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, A()), eq(connection.connector, "gmail"))),
    ).toEqual([]);
    // Another client's admin can't land this state.
    expect(
      (
        await call(admin("b"), "POST", "/api/connections/gmail/callback", {
          params: { code, state },
        })
      ).status,
    ).toBe(404);

    const done = await call(user("a"), "POST", "/api/connections/gmail/callback", {
      params: { code, state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).connection.connection).toMatchObject({
      status: "connected",
      externalAccountId: MAILBOX,
      connectedByYou: true,
    });
    gmailConn = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, gmailConn));
    expect(row?.connectedBy).toBe(H.A.user);
    expect(row?.config).toEqual({ address: MAILBOX, scopes: ["gmail.send"] });
    expect(row?.permissions).toMatchObject({ create: "approval", delete: "off" });
    const stored = JSON.stringify(row?.credentialsEncrypted);
    for (const t of [...google.issued().accessTokens, ...google.issued().refreshTokens]) {
      expect(stored).not.toContain(t);
    }
    // The client admin sees it, not as theirs.
    const asAdmin = await call(admin("a"), "GET", "/api/connections");
    expect(
      j(asAdmin.json).connections.find((c: { connector: string }) => c.connector === "gmail")
        .connection,
    ).toMatchObject({ externalAccountId: MAILBOX, accountName: MAILBOX, connectedByYou: false });
  });

  it("binds Gmail as the agent's email channel, by the operator only", async () => {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "orders",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    agentId = j(created.json).agent.id;
    versionId = j(created.json).version.id;
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const bound = await call(admin("a"), "PUT", `/api/people/${agentId}`, {
      people: { vendor: { contactIds: [maria], conditions: { maxPerDay: 10 } } },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    expect(
      (
        await call(admin("a"), "PUT", `/api/ops/agents/${agentId}/channels`, {
          channels: { email: gmailConn },
        })
      ).status,
    ).toBe(403);
    // Gmail carries email only.
    expect(
      (
        await call(OPERATOR, "PUT", `/api/ops/agents/${agentId}/channels`, {
          channels: { sms: gmailConn },
        })
      ).status,
    ).toBe(409);
    const ch = await call(OPERATOR, "PUT", `/api/ops/agents/${agentId}/channels`, {
      channels: { email: gmailConn },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    expect(j(ch.json).channels.channels).toEqual({ email: gmailConn });
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
  });

  it("never sends from a test run", async () => {
    const params = await startRun("PO-T1", "test");
    const result = await executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
    expect(result.status).toBe("succeeded");
    expect(await stepOutput(params.runId)).toMatchObject({
      testRun: true,
      plan: ["email"],
      contact: { id: maria },
    });
    expect(google.sent).toHaveLength(0);
    expect(await actionsOf(params.runId)).toEqual([]);
    expect(
      await H.t.db.select().from(reachOut).where(eq(reachOut.runId, params.runId)),
    ).toHaveLength(0);
  });

  it("sends from the mailbox only after approval, once, in Spanish; the reply comes back by forwarding", async () => {
    const params = await startRun("PO-1042");
    let reachEvent = "";
    const step = new FakeWorkflowStep(async (_name, type) => {
      if (type.startsWith("inbox-")) {
        return approveItem(type, (item) => {
          // Nothing is sent before a person approves.
          expect(google.sent).toHaveLength(0);
          expect(item.payload.reachOut).toMatchObject({
            contact: { id: maria, name: "María Núñez" },
            channels: ["email"],
            language: "es",
            message: SPANISH,
          });
        });
      }
      if (!type.startsWith("reachout-")) throw new Error(`unexpected wait ${type}`);
      reachEvent = type;
      expect(google.sent).toHaveLength(1);
      const sent = google.sent[0];
      expect(sent?.account).toBe(MAILBOX);
      const mail = await readSentEmail(sent?.message ?? "");
      expect(mail.from).toBe(MAILBOX);
      expect(mail.to).toEqual([MARIA]);
      expect(mail.subject).toBe("Entrega del viernes: pedido nº PO-1042");
      expect(mail.text?.trim()).toBe(SPANISH);
      const replyTo = mail.replyTo[0] ?? "";
      const [local, domain] = forwarding.split("@");
      expect(replyTo).toMatch(new RegExp(`^${local}\\+[0-9a-f]{32}@${domain}$`));

      // María answers from her own address; someone else writing to the tagged address doesn't count.
      const raw = new TextEncoder().encode(
        [
          `From: María Núñez <${MARIA}>`,
          `To: ${replyTo}`,
          "Subject: Re: Entrega del viernes",
          `In-Reply-To: ${mail.messageId}`,
          "Message-ID: <reply-1@proveedor.example>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Sí, el viernes está bien.",
          "",
          "El mar., Pat escribió:",
          "> Hola, ¿confirma la entrega del viernes?",
        ].join("\r\n"),
      );
      const pending: Promise<unknown>[] = [];
      const deliver = (from: string) =>
        handleEmail(
          {
            from,
            to: replyTo,
            raw: new Response(raw).body as ReadableStream<Uint8Array>,
            rawSize: raw.length,
          },
          H.env,
          (p) => pending.push(p),
          appDeps(),
        );
      await deliver("mallory@evil.example");
      expect(H.instances.events.find((e) => e.event.type === type)).toBeUndefined();
      await deliver(MARIA);
      await Promise.all(pending);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(reachEvent).not.toBe("");
    expect(await stepOutput(params.runId)).toMatchObject({
      outcome: "replied",
      channel: "email",
      contact: { id: maria },
      // Her own words, cut at Gmail's Spanish line above the quote: data, never instructions.
      reply: { channel: "email", text: "Sí, el viernes está bien.", untrusted: true },
      sources: ["PO-1042"],
    });

    // One external action, executed once, its before state what was sent.
    const actions = await actionsOf(params.runId);
    expect(actions.map((a) => [a.tool, a.status, a.connectionId])).toEqual([
      [GMAIL_SEND_TOOL, "done", gmailConn],
    ]);
    expect(actions[0]?.idempotencyKey).toMatch(/:reach:0$/);
    expect(actions[0]?.before).toMatchObject({
      contact: { id: maria, name: "María Núñez" },
      to: MARIA,
      from: MAILBOX,
      subject: "Entrega del viernes: pedido nº PO-1042",
      text: SPANISH,
    });
    // The email is in María's thread, as Gmail's.
    const records = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.connectionId, gmailConn), eq(rawRecord.entityType, "EmailMessage")));
    expect(records).toHaveLength(1);
    expect(records[0]?.connector).toBe("gmail");

    // Replaying the run sends nothing more.
    await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(google.sent).toHaveLength(1);
  });

  it("holds the agent's grant and human release at each send", async () => {
    // Grants narrow a binding: the operator binds the agent to the Gmail connection too.
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { gmail: gmailConn },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const grantPath = `/api/ops/agents/${agentId}/grants/${gmailConn}`;
    const off = await call(OPERATOR, "PUT", grantPath, { limits: { verbs: { create: "off" } } });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const refused = await runWithoutReply("PO-2001");
    expect(google.sent).toHaveLength(1);
    expect(await stepOutput(refused.runId)).toMatchObject({
      outcome: "not_allowed",
      attempts: 0,
      reason: "nothing could be sent: email: create is off for this agent on the gmail connection",
    });
    expect((await actionsOf(refused.runId)).filter((a) => a.status === "done")).toEqual([]);
    expect((await call(OPERATOR, "PUT", grantPath, { limits: {} })).status).toBe(200);

    // Human release on: an attempt can't wait for a code, so it isn't sent without a live release.
    const releasePath = `/api/access/connections/${gmailConn}/release`;
    const on = await call(admin("a"), "PUT", releasePath, {
      mode: "code",
      personId: H.A.admin,
      channel: "email",
      window: "run",
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const held = await runWithoutReply("PO-2002");
    expect(google.sent).toHaveLength(1);
    expect(await stepOutput(held.runId)).toMatchObject({
      outcome: "not_allowed",
      attempts: 0,
      reason:
        "nothing could be sent: email: the gmail connection needs a person to release it first",
    });
    expect((await call(admin("a"), "PUT", releasePath, { mode: "off" })).status).toBe(200);
  });

  it("refreshes an expired access token; a grant Google ended asks for a reconnect", async () => {
    google.expireAccessTokens();
    const refreshed = await runWithoutReply("PO-3001");
    expect(google.sent).toHaveLength(2);
    expect((await actionsOf(refreshed.runId)).map((a) => a.status)).toEqual(["done"]);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, gmailConn));
    expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(
      google.issued().accessTokens.at(-1),
    );

    // Seven days in Testing: the refresh token stops working. Nothing is sent and the connection
    // needs the person to connect again.
    google.expireRefreshTokens();
    google.expireAccessTokens();
    const ended = await runWithoutReply("PO-3002");
    expect(google.sent).toHaveLength(2);
    expect((await actionsOf(ended.runId)).map((a) => a.status)).toEqual(["failed"]);
    const list = await call(user("a"), "GET", "/api/connections");
    expect(
      j(list.json).connections.find((c: { connector: string }) => c.connector === "gmail")
        .connection.status,
    ).toBe("error");
  });

  it("revokes the grant at Google when the person disconnects; only they or the admin may", async () => {
    // The person connects again (the old grant ended), then disconnects.
    const again = await signIn(user("a"), google.issueCode({ address: MAILBOX }));
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(j(again.json).connection.connection.id).toBe(gmailConn);
    const refresh = google.issued().refreshTokens.at(-1) as string;
    const off = await call(user("a"), "DELETE", `/api/connections/${gmailConn}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(google.requests.filter((r) => r.url === GOOGLE_REVOKE_URL).at(-1)?.body).toBe(
      `token=${encodeURIComponent(refresh)}`,
    );
    expect(google.revoked()).toContain(refresh);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, gmailConn));
    expect(row).toMatchObject({ status: "disconnected", credentialsEncrypted: null });

    // The admin connects a shared mailbox: the client user can neither take it over nor remove it.
    const shared = await signIn(admin("a"), google.issueCode({ address: "orders@gmail.test" }));
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect((await call(user("a"), "POST", "/api/connections/gmail/authorize")).status).toBe(403);
    expect((await call(user("a"), "DELETE", `/api/connections/${gmailConn}`)).status).toBe(403);
    expect((await call(admin("a"), "DELETE", `/api/connections/${gmailConn}`)).status).toBe(200);
  });

  it("never puts a token in any response", async () => {
    for (const who of [OPERATOR, admin("a"), user("a")]) {
      await call(
        who,
        "GET",
        who === OPERATOR ? `/api/ops/clients/${A()}/connections` : "/api/access",
      );
    }
    await call(OPERATOR, "GET", `/api/ops/agents/${agentId}/grants`);
    const { accessTokens, refreshTokens } = google.issued();
    expect(accessTokens.length).toBeGreaterThan(2);
    const all = seen.join("\n");
    for (const t of [...accessTokens, ...refreshTokens]) expect(all).not.toContain(t);
    expect(all).not.toMatch(/accessToken|refreshToken|id_token/);
  });
});
