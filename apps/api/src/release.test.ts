// Human release through the API (docs/plan.md §1.26 "Human release", phase 4), against fake Twilio
// and Resend: the operator turns it on and never off, the client admin turns it on and off and
// picks the person, the gate pauses a run until that person enters the code (in the portal, by
// replying to the text from their own number, or to the email from their own address with DMARC
// passing), wrong codes run out, expiry fails the step `access_not_released`, run and hours windows,
// re-sends, revokes, test runs, nothing crosses clients, and the code is in no response, log line,
// step output, event or stored message.

import {
  createResendConnector,
  createTwilioConnector,
  type FetchLike,
  formEncode,
  generateEncryptionKey,
  RESEND_API,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  FAKE_RESEND_MAIN,
  FAKE_TWILIO_MAIN,
  fakeResend,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput, RELEASE_TEXT_PREFIXES } from "@countersign/core";
import {
  accessRelease,
  agent,
  connectionChange,
  externalAction,
  inboxItem,
  message,
  rawRecord,
  run,
  stepRun,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { releaseDepsFromEnv } from "./access/release";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { credentialsFor, executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const FORWARDING = "in.mezonas.test";
const ADMIN_PHONE = "+15555550142";
const STRANGER = "+15555550199";
const twilio = fakeTwilio();
const resend = fakeResend();
const fetch: FetchLike = (url, init) =>
  url.startsWith(RESEND_API) ? resend.fetch(url, init) : twilio.fetch(url, init);

// Every line the code logs, to look for codes in.
const logged: string[] = [];
for (const level of process.env.SHOW_LOGS
  ? []
  : (["log", "info", "warn", "error", "debug"] as const)) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    logged.push(
      args
        .map((a) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a));
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  });
}

const h = await createApiHarness({
  connectors: () => [
    createTwilioConnector({ fetch: twilio.fetch }),
    createResendConnector({ fetch: resend.fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    EMAIL_FORWARDING_DOMAIN: FORWARDING,
  },
  fetch,
});
afterAll(() => h?.close());

function bundle(): AgentBundle {
  const read = (id: string) => ({
    id,
    name: "Read the records",
    kind: "skill",
    skill: TESTKIT_QUERY_TOOL,
    input: {},
    client: { visible: true, label: "Read the records" },
  });
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Intake", role: "reads records", mission: "Keep records in view." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [{ skill: TESTKIT_QUERY_TOOL }],
      extraTools: [TESTKIT_UPDATE_TOOL],
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
          trigger: { id: "trg", on: { type: "manual", input: {} } },
          // Two reads through the same connection: one release covers both in a run.
          steps: [read("first"), read("second")],
        },
      },
      {
        slug: "fix",
        name: "Fix a record",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-fix", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "update",
              name: "Update the record",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "12.00" },
              approval: { required: "required" },
              client: { visible: true, label: "Corrected the record" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

/** A code message in any language: its prefix, then the code. */
const CODE_RE = new RegExp(
  `^(?:${RELEASE_TEXT_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) (\\d{6})\\.`,
);

const timeout = () =>
  Object.assign(new Error("Execution timed out after 1000ms"), { name: "WorkflowTimeoutError" });

describe.skipIf(!h)("human release through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const conn = () => H.A.connectionId;
  const msg = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  const releasePath = () => `/api/access/connections/${conn()}/release`;
  const opsRelease = (client = A()) => `/api/ops/clients/${client}/connections/${conn()}/release`;
  let setup: ReturnType<typeof j> = null;
  let number = "";
  let agentId = "";
  let versionId = "";
  let forwarding = "";
  let clock = Date.now();
  const responses: unknown[] = [];
  const codes = new Set<string>();

  /** Every call made here, its response kept to look for codes in. */
  async function call(...args: Parameters<ApiHarness["call"]>) {
    const res = await H.call(...args);
    responses.push(res.json);
    return res;
  }

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    release: releaseDepsFromEnv(H.env, {
      db: H.db,
      platform: H.platform,
      instances: H.instances,
      fetch,
    }),
    now: () => new Date(clock),
  });

  /** Code texts to the client admin's phone, newest last. */
  const textedCodes = () =>
    [...twilio.messages.values()]
      .filter((m) => m.to === ADMIN_PHONE && m.direction === "outbound-api")
      .map((m) => m.body);
  function lastTextedCode(): string {
    const body = textedCodes().at(-1) ?? "";
    const code = CODE_RE.exec(body)?.[1];
    if (!code) throw new Error(`no code in ${body}`);
    codes.add(code);
    return code;
  }
  function lastEmailedCode() {
    const email = resend.emails.at(-1);
    const code = CODE_RE.exec(email?.text ?? "")?.[1];
    if (!email || !code) throw new Error("no code email");
    codes.add(code);
    return { email, code };
  }
  const other = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  async function textIn(from: string, body: string) {
    const m = await twilio.inbound({
      account: setup.twilio.subaccountSid,
      from,
      to: number,
      body,
      url: setup.webhooks.messages,
    });
    const res = await H.call(
      null,
      "POST",
      setup.webhooks.messages.replace(ORIGIN, ""),
      formEncode(m.params),
      { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": m.signature },
    );
    expect(res.status).toBe(200);
    await H.settle();
    return m.sid;
  }

  async function startRun(workflow = "main"): Promise<RunParams> {
    const before = [...H.instances.started.keys()];
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow,
      input: {},
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    const params = [...H.instances.started.entries()].find(([k]) => !before.includes(k))?.[1];
    if (!params) throw new Error("no run started");
    return params;
  }

  /** The open request item the run waits on (`type` is its event), as the client admin sees it. */
  async function requestItem(type: string) {
    const res = await call(admin("a"), "GET", "/api/inbox");
    const item = j(res.json).items.find(
      (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
    );
    if (!item) throw new Error(`no open item for ${type}`);
    return item;
  }
  const sentEvent = (type: string) =>
    H.instances.events.find((e) => e.event.type === type)?.event.payload;
  const enter = (who: string, itemId: string, code: string) =>
    call(who, "POST", `/api/access/requests/${itemId}/code`, { code });

  async function stepRow(runId: string, nodeId: string) {
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, runId), eq(stepRun.nodeId, nodeId)));
    return row;
  }
  const releaseLog = async () =>
    (
      await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, conn()))
        .orderBy(connectionChange.createdAt)
    )
      .map((r) => j(r.change))
      .filter((c) => c.kind === "release");

  beforeAll(async () => {
    // Texting: a subaccount, a number, A2P approved, and quiet hours that never fall now.
    await call(OPERATOR, "PUT", msg(), { quietHours: { start: "03:00", end: "03:01" } });
    setup = j((await call(OPERATOR, "POST", msg("/twilio"))).json).setup;
    setup = j(
      (await call(OPERATOR, "POST", msg("/numbers"), { phoneNumber: "+15125550101" })).json,
    ).setup;
    number = setup.twilio.numbers[0].phoneNumber;
    const brandSid = `BN${"1".repeat(32)}`;
    const serviceSid = `MG${"2".repeat(32)}`;
    await call(OPERATOR, "PUT", msg("/a2p"), { brandSid, messagingServiceSid: serviceSid });
    twilio.setBrand(brandSid, "APPROVED");
    twilio.setCampaign(serviceSid, "VERIFIED");
    await call(OPERATOR, "POST", msg("/a2p/refresh"));
    // The client admin is also a contact with a phone and text consent.
    const made = await call(admin("a"), "POST", "/api/contacts", {
      name: "Client A admin",
      phone: ADMIN_PHONE,
      email: "admin@a.example.com",
      consent: { channels: ["sms", "email"], source: "signed the service agreement" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const fwd = await call(admin("a"), "GET", "/api/connections/upload/forwarding");
    forwarding = j(fwd.json).forwarding.address;

    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "intake",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    versionId = j(created.json).version.id;
    const bound = await call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: conn() },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", serviceName: "Intake" })
      .where(eq(agent.id, agentId));
  });

  it("the operator turns it on, never off; the client admin turns it off and on and picks the person", async () => {
    const people = await call(OPERATOR, "GET", opsRelease());
    expect(people.status, JSON.stringify(people.json)).toBe(200);
    expect(j(people.json).release).toMatchObject({ mode: "off", live: [] });
    const adminPerson = j(people.json).people.find((p: { id: string }) => p.id === H.A.admin);
    // Masked address; a text can reach the admin (a contact with phone and consent), not the user.
    expect(adminPerson).toMatchObject({ email: "a•••@a.example.com", canText: true });
    expect(j(people.json).people.find((p: { id: string }) => p.id === H.A.user).canText).toBe(
      false,
    );

    const on = { mode: "code", personId: H.A.admin, channel: "sms", window: "run" };
    const turnedOn = await call(OPERATOR, "PUT", opsRelease(), on);
    expect(turnedOn.status, JSON.stringify(turnedOn.json)).toBe(200);
    expect(j(turnedOn.json).release).toMatchObject({
      mode: "code",
      person: { id: H.A.admin },
      channel: "sms",
      window: "run",
      sentTo: "•••0142",
    });
    // The operator can't turn it off, or change who or how long once it is on.
    const off = await call(OPERATOR, "PUT", opsRelease(), { mode: "off" });
    expect(off.status).toBe(403);
    expect(j(off.json).error.code).toBe("client_only");
    expect(
      (await call(OPERATOR, "PUT", opsRelease(), { ...on, window: { hours: 24 } })).status,
    ).toBe(403);
    // Nor for a client they don't serve.
    expect((await call(OTHER_OPERATOR, "PUT", opsRelease(), on)).status).toBe(404);

    // The client admin can turn it off and on; a client user can't touch it.
    expect((await call(user("a"), "PUT", releasePath(), { mode: "off" })).status).toBe(403);
    const adminOff = await call(admin("a"), "PUT", releasePath(), { mode: "off" });
    expect(adminOff.status, JSON.stringify(adminOff.json)).toBe(200);
    expect(j(adminOff.json).item.release.mode).toBe("off");
    // Texts need a phone that agreed to them.
    const noPhone = await call(admin("a"), "PUT", releasePath(), { ...on, personId: H.A.user });
    expect(noPhone.status).toBe(422);
    expect(j(noPhone.json).error.code).toBe("no_phone");
    // Only people of this client.
    expect(
      (await call(admin("a"), "PUT", releasePath(), { ...on, personId: H.B.admin })).status,
    ).toBe(422);
    const adminOn = await call(admin("a"), "PUT", releasePath(), on);
    expect(adminOn.status, JSON.stringify(adminOn.json)).toBe(200);
    expect(j(adminOn.json).item.release).toMatchObject({ mode: "code", channel: "sms" });

    const view = await call(admin("a"), "GET", "/api/access");
    const item = j(view.json).items.find(
      (i: { connectionId: string }) => i.connectionId === conn(),
    );
    expect(item.release).toMatchObject({ mode: "code", person: { id: H.A.admin } });
    expect(j(view.json).people.length).toBe(2);
    // A client user sees the setting but not the people to pick from.
    expect(j((await call(user("a"), "GET", "/api/access")).json).people).toEqual([]);

    const settings = (await releaseLog()).filter((c) => c.event === "setting");
    expect(settings.map((c) => [c.by, c.after.mode])).toEqual([
      ["operator", "code"],
      ["client", "off"],
      ["client", "code"],
    ]);
  });

  it("pauses the run until the person enters the code in the portal; one release covers the run", async () => {
    const params = await startRun();
    let waited = "";
    const step = new FakeWorkflowStep(async (_name, type) => {
      waited = type;
      // Nothing was read before the release.
      expect((await stepRow(params.runId, "first"))?.status).toBe("waiting");
      const item = await requestItem(type);
      expect(item.kind).toBe("request");
      expect(item.title).toBe("Enter the code we texted you to let Intake use Testkit");
      expect(item.payload.accessRelease).toMatchObject({ channel: "sms", agentName: "Intake" });
      const text = textedCodes().at(-1) ?? "";
      const code = lastTextedCode();
      expect(text).toBe(
        `Mezonas code: ${code}. Enter it to let Intake use Testkit for this run. It expires in 10 minutes.`,
      );
      expect(text).not.toMatch(/https?:|www\./);

      // The generic resolve can't release it, and only the person the code went to can enter it.
      const clicked = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(clicked.status).toBe(409);
      expect(j(clicked.json).error.code).toBe("enter_code");
      expect((await enter(user("a"), item.id, code)).status).toBe(403);
      expect((await enter(OPERATOR, item.id, code)).status).toBe(403);
      const view = j((await call(admin("a"), "GET", `/api/access/requests/${item.id}`)).json);
      expect(view.request).toMatchObject({
        status: "pending",
        channel: "sms",
        sentTo: "•••0142",
        triesLeft: 5,
        resendsLeft: 3,
        mine: true,
      });

      const wrong = await enter(admin("a"), item.id, other(code));
      expect(wrong.status).toBe(200);
      expect(j(wrong.json)).toMatchObject({ result: "wrong", request: { triesLeft: 4 } });
      expect(sentEvent(type)).toBeUndefined();
      const right = await enter(admin("a"), item.id, code.replace(/(\d{3})/, "$1 "));
      expect(j(right.json)).toMatchObject({ result: "released", request: { status: "released" } });
      // A code works once.
      expect(j((await enter(admin("a"), item.id, code)).json).result).toBe("closed");
      return sentEvent(type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(waited).toMatch(/^inbox-/);
    // One code for the whole run: the second read went through under the same release.
    expect(step.waits).toHaveLength(1);
    expect(j((await stepRow(params.runId, "second"))?.output).records.length).toBeGreaterThan(0);
    expect(j((await stepRow(params.runId, "first"))?.output).records.length).toBeGreaterThan(0);
    const events = (await releaseLog()).map((c) => c.event);
    expect(events).toEqual(expect.arrayContaining(["requested", "failed_try", "released"]));
    const released = (await releaseLog()).find((c) => c.event === "released");
    expect(released).toMatchObject({ via: "portal", runId: params.runId, validUntil: null });

    // A run window covers that run only: the next run asks again.
    const next = await startRun();
    const again = new FakeWorkflowStep(async () => {
      clock = Date.now() + 11 * 60_000;
      throw timeout();
    });
    const ended = await executeRun(deps(), next, cloudflareStepRunner(again)).finally(() => {
      clock = Date.now();
    });
    expect(ended.status).toBe("failed");
    expect(again.waits).toHaveLength(1);
  });

  it("fails the step access_not_released when nobody enters the code in time", async () => {
    const params = await startRun();
    const step = new FakeWorkflowStep(async () => {
      lastTextedCode();
      clock = Date.now() + 11 * 60_000;
      throw timeout();
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step)).finally(() => {
      clock = Date.now();
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/^access_not_released/);
    const [r] = await H.t.db.select().from(run).where(eq(run.id, params.runId));
    expect(r?.status).toBe("failed");
    const [rel] = await H.t.db
      .select()
      .from(accessRelease)
      .where(eq(accessRelease.runId, params.runId));
    expect(rel?.status).toBe("expired");
    const [item] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, params.runId));
    expect(item?.status).toBe("expired");
    expect(
      (await releaseLog()).some((c) => c.event === "expired" && c.runId === params.runId),
    ).toBe(true);
  });

  it("runs out after 5 wrong codes, and the person may ask for a new code up to 3 times", async () => {
    const params = await startRun();
    let n = 0;
    const step = new FakeWorkflowStep(async (_name, type) => {
      n += 1;
      const item = await requestItem(type);
      if (n === 1) {
        const code = lastTextedCode();
        for (let i = 4; i >= 0; i--) {
          const res = await enter(admin("a"), item.id, other(code));
          expect(j(res.json)).toMatchObject({ result: "wrong", request: { triesLeft: i } });
        }
        // Out of tries: even the right code does nothing now.
        expect(j((await enter(admin("a"), item.id, code)).json)).toMatchObject({
          result: "closed",
          request: { status: "failed" },
        });
        // A new code: the old one is void, the new one has 5 tries.
        for (let i = 2; i >= 0; i--) {
          const res = await call(admin("a"), "POST", `/api/access/requests/${item.id}/resend`);
          expect(res.status, JSON.stringify(res.json)).toBe(200);
          expect(j(res.json).request).toMatchObject({
            status: "pending",
            triesLeft: 5,
            resendsLeft: i,
          });
          lastTextedCode();
        }
        expect(
          (await call(user("a"), "POST", `/api/access/requests/${item.id}/resend`)).status,
        ).toBe(403);
        const none = await call(admin("a"), "POST", `/api/access/requests/${item.id}/resend`);
        expect(none.status).toBe(429);
        // The wait ends at the first code's expiry; the newest code still has time.
        throw timeout();
      }
      // Waiting again on the newest code: the last one but one was voided by the re-send.
      const all = [...codes];
      const voided = all.at(-2) as string;
      expect(j((await enter(admin("a"), item.id, voided)).json).result).toBe("wrong");
      expect(j((await enter(admin("a"), item.id, lastTextedCode())).json).result).toBe("released");
      return sentEvent(type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect(n).toBe(2);
    const rows = await H.t.db
      .select({ status: accessRelease.status, tries: accessRelease.tries })
      .from(accessRelease)
      .where(eq(accessRelease.runId, params.runId))
      .orderBy(accessRelease.createdAt);
    expect(rows.map((r) => r.status)).toEqual(["failed", "void", "void", "released"]);
    expect(rows[0]?.tries).toBe(5);
    const events = (await releaseLog()).filter((c) => c.runId === params.runId).map((c) => c.event);
    expect(events.filter((e) => e === "failed_try")).toHaveLength(5);
    expect(events).toEqual(expect.arrayContaining(["failed", "resent", "void", "released"]));
  });

  it("releases on a reply from the person's own number; another number's reply does nothing; neither is stored", async () => {
    const params = await startRun();
    const step = new FakeWorkflowStep(async (_name, type) => {
      const code = lastTextedCode();
      const threadsBefore = await H.t.db.select().from(message);
      // The right code from another number: consumed, not a release, not in any thread.
      await textIn(STRANGER, code);
      expect(sentEvent(type)).toBeUndefined();
      // A wrong code from the person's number uses a try.
      await textIn(ADMIN_PHONE, other(code));
      const item = await requestItem(type);
      expect(
        j((await call(admin("a"), "GET", `/api/access/requests/${item.id}`)).json).request,
      ).toMatchObject({ status: "pending", triesLeft: 4 });
      // The person's own reply releases it.
      const sid = await textIn(ADMIN_PHONE, ` ${code} `);
      expect(sentEvent(type)).toMatchObject({ approved: true, by: H.A.admin });
      // Twilio retrying the same delivery does nothing more.
      const before = H.instances.events.length;
      const m = [...twilio.messages.values()].find((x) => x.sid === sid);
      if (!m) throw new Error("no message");
      expect((await H.t.db.select().from(message)).length).toBe(threadsBefore.length);
      const stored = await H.t.db.select().from(rawRecord).where(eq(rawRecord.externalId, sid));
      expect(stored.map((r) => r.entityType)).toEqual(["ReleaseReply"]);
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(H.instances.events.length).toBe(before);
      return sentEvent(type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    expect((await releaseLog()).some((c) => c.event === "wrong_sender")).toBe(true);
    expect(
      (await releaseLog()).find((c) => c.event === "released" && c.runId === params.runId),
    ).toMatchObject({ via: "sms" });
  });

  it("covers later runs for the hours window, by email, until revoked; the email reply must pass DMARC", async () => {
    const set = await call(admin("a"), "PUT", releasePath(), {
      mode: "code",
      personId: H.A.admin,
      channel: "email",
      window: { hours: 2 },
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const params = await startRun();
    const appDeps = {
      ...defaultDeps,
      openDb: () => ({ db: H.db, close: async () => {} }),
      instances: () => H.instances,
      objects: () => H.objects,
      extractionTransport: () => null,
    };
    const step = new FakeWorkflowStep(async (_name, type) => {
      const { email, code } = lastEmailedCode();
      expect(email).toMatchObject({
        from: "Mezonas <codes@mail.mezonas.test>",
        to: ["admin@a.example.com"],
        subject: "Your Mezonas code",
      });
      expect(email.text).toContain(
        `Mezonas code: ${code}. Enter it to let Intake use Testkit for the next 2 hours.`,
      );
      expect(email.text).not.toMatch(/https?:|www\./);
      const replyTo = email.reply_to as string;
      expect(replyTo.split("+")[0]).toBe(forwarding.split("@")[0]);
      const item = await requestItem(type);
      expect(item.title).toBe("Enter the code we emailed you to let Intake use Testkit");
      const mail = (from: string, auth: string | null, text: string) => {
        const raw = new TextEncoder().encode(
          [
            ...(auth ? [`Authentication-Results: mx.cloudflare.net; ${auth}`] : []),
            `From: ${from}`,
            `To: ${replyTo}`,
            "Subject: Re: Your Mezonas code",
            "Content-Type: text/plain; charset=utf-8",
            "",
            text,
          ].join("\r\n"),
        );
        return {
          from,
          to: replyTo,
          raw: new Response(raw).body as ReadableStream<Uint8Array>,
          rawSize: raw.length,
        };
      };
      const pass = "spf=pass; dkim=pass; dmarc=pass header.from=a.example.com";
      const send = (m: ReturnType<typeof mail>) => handleEmail(m, H.env, () => {}, appDeps);
      // No DMARC pass, someone else, or more than the code: nothing is released.
      await send(mail("admin@a.example.com", null, code));
      await send(mail("mallory@evil.example", "dmarc=pass header.from=evil.example", code));
      await send(
        mail("admin@a.example.com", pass, `Out of office.\nMezonas code: ${code}. Enter it`),
      );
      expect(sentEvent(type)).toBeUndefined();
      await send(mail("admin@a.example.com", pass, `${code}\n`));
      return sentEvent(type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual({ status: "succeeded" });
    const live = j((await call(admin("a"), "GET", "/api/access/releases")).json).releases;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      agentId,
      agentName: "Intake",
      person: { id: H.A.admin },
      channel: "email",
      runId: null,
    });
    expect(new Date(live[0].validUntil).getTime() - new Date(live[0].releasedAt).getTime()).toBe(
      2 * 3_600_000,
    );

    // A later run goes through without a code.
    const later = await startRun();
    const none = new FakeWorkflowStep(async () => {
      throw new Error("no wait expected");
    });
    expect(await executeRun(deps(), later, cloudflareStepRunner(none))).toEqual({
      status: "succeeded",
    });

    // The client user can't revoke; the client admin can, and then the next run asks again.
    expect(
      (await call(user("a"), "POST", `/api/access/releases/${live[0].id}/revoke`)).status,
    ).toBe(403);
    const revoked = await call(admin("a"), "POST", `/api/access/releases/${live[0].id}/revoke`);
    expect(revoked.status, JSON.stringify(revoked.json)).toBe(200);
    expect(j(revoked.json).item.release.live).toEqual([]);
    const [row] = await H.t.db.select().from(accessRelease).where(eq(accessRelease.id, live[0].id));
    expect(row).toMatchObject({ status: "revoked", revokedBy: H.A.admin });
    expect((await releaseLog()).some((c) => c.event === "revoked")).toBe(true);
    const third = await startRun();
    const asks = new FakeWorkflowStep(async () => {
      lastEmailedCode();
      clock = Date.now() + 11 * 60_000;
      throw timeout();
    });
    const thirdResult = await executeRun(deps(), third, cloudflareStepRunner(asks)).finally(() => {
      clock = Date.now();
    });
    expect(thirdResult.status).toBe("failed");
    expect(asks.waits).toHaveLength(1);
  });

  it("needs a release for test runs too", async () => {
    await call(admin("a"), "PUT", releasePath(), {
      mode: "code",
      personId: H.A.admin,
      channel: "sms",
      window: "run",
    });
    const res = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
      { workflow: "main", payload: {} },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no test run");
    const step = new FakeWorkflowStep(async (_name, type) => {
      const code = lastTextedCode();
      expect(textedCodes().at(-1)).toContain("for this test run");
      const item = await requestItem(type);
      expect(item.payload.testRun).toBe(true);
      expect(j((await enter(admin("a"), item.id, code)).json).result).toBe("released");
      return sentEvent(type);
    });
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
  });

  it("never runs an approved write once its release is revoked: an approval is not a release", async () => {
    const writes = H.backend.writes.length;
    const params = await startRun("fix");
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = j((await call(admin("a"), "GET", "/api/inbox")).json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no item for ${type}`);
      if (item.payload.accessRelease) {
        expect(j((await enter(admin("a"), item.id, lastTextedCode())).json).result).toBe(
          "released",
        );
        return sentEvent(type);
      }
      // The write waits for approval; meanwhile the client admin revokes the release.
      expect(item.kind).toBe("external_action");
      const live = j((await call(admin("a"), "GET", "/api/access/releases")).json).releases;
      const mine = live.find((r: { runId: string }) => r.runId === params.runId);
      expect(
        (await call(admin("a"), "POST", `/api/access/releases/${mine.id}/revoke`)).status,
      ).toBe(200);
      const ok = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      return sentEvent(type);
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("needs a person to release it");
    expect(H.backend.writes.length).toBe(writes);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({ status: "failed", error: { release: true } });
  });

  it("writes the code message in the person's language, else the client's", async () => {
    // Ana reads Spanish: her text and her inbox item are in Spanish.
    expect((await call(admin("a"), "PUT", "/api/me/language", { language: "es" })).status).toBe(
      200,
    );
    const es = await startRun();
    const step = new FakeWorkflowStep(async (_name, type) => {
      const text = textedCodes().at(-1) ?? "";
      const code = lastTextedCode();
      expect(text).toBe(
        `Código de Mezonas: ${code}. Introdúzcalo para que Intake use Testkit en esta ejecución. Caduca en 10 minutos.`,
      );
      expect(text).not.toMatch(/https?:|www\./);
      const item = await requestItem(type);
      expect(item.title).toBe(
        "Introduzca el código que le enviamos por SMS para que Intake use Testkit",
      );
      expect(j((await enter(admin("a"), item.id, code)).json).result).toBe("released");
      return sentEvent(type);
    });
    expect(await executeRun(deps(), es, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });

    // No choice of her own: the client's default, German, by email.
    await call(admin("a"), "PUT", "/api/me/language", { language: null });
    expect((await call(admin("a"), "PUT", "/api/client/language", { language: "de" })).status).toBe(
      200,
    );
    await call(admin("a"), "PUT", releasePath(), {
      mode: "code",
      personId: H.A.admin,
      channel: "email",
      window: { hours: 1 },
    });
    const de = await startRun();
    const german = new FakeWorkflowStep(async (_name, type) => {
      const { email, code } = lastEmailedCode();
      expect(email.subject).toBe("Ihr Mezonas-Code");
      expect(email.text).toBe(
        `Mezonas-Code: ${code}. Geben Sie ihn ein, damit Intake Testkit für die nächste Stunde nutzen kann. Er läuft in 10 Minuten ab.\n\nAntworten Sie auf diese E-Mail nur mit dem Code oder geben Sie ihn in Mezonas ein.`,
      );
      const item = await requestItem(type);
      expect(j((await enter(admin("a"), item.id, code)).json).result).toBe("released");
      return sentEvent(type);
    });
    expect(await executeRun(deps(), de, cloudflareStepRunner(german))).toEqual({
      status: "succeeded",
    });
    await call(admin("a"), "PUT", "/api/client/language", { language: "en" });
  });

  it("keeps releases per client", async () => {
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.subjectType, "access_release")))
      .orderBy(desc(inboxItem.createdAt))
      .limit(1);
    if (!item) throw new Error("no request");
    expect((await call(admin("b"), "GET", `/api/access/requests/${item.id}`)).status).toBe(404);
    expect((await enter(admin("b"), item.id, "123456")).status).toBe(404);
    expect((await call(admin("b"), "POST", `/api/access/requests/${item.id}/resend`)).status).toBe(
      404,
    );
    const [rel] = await H.t.db
      .select()
      .from(accessRelease)
      .where(eq(accessRelease.tenantId, A()))
      .limit(1);
    expect((await call(admin("b"), "POST", `/api/access/releases/${rel?.id}/revoke`)).status).toBe(
      404,
    );
    expect(j((await call(admin("b"), "GET", "/api/access/releases")).json).releases).toEqual([]);
    const bView = j((await call(admin("b"), "GET", "/api/access")).json);
    expect(JSON.stringify(bView)).not.toContain(conn());
    expect((await call(OTHER_OPERATOR, "GET", opsRelease())).status).toBe(404);
    expect(
      (await call(admin("b"), "PUT", `/api/access/connections/${conn()}/release`, { mode: "off" }))
        .status,
    ).toBe(404);
  });

  it("puts the code in no response, log line, step output, event or stored message", async () => {
    expect(codes.size).toBeGreaterThan(8);
    // The log lines were captured (and say what happened, without the code).
    expect(logged.join("\n")).toContain("access release requested");
    // Read everything both surfaces can see, so those responses are searched too.
    for (const who of [admin("a"), user("a")]) {
      await call(who, "GET", "/api/access");
      await call(who, "GET", "/api/access/releases");
      await call(who, "GET", "/api/inbox?status=resolved");
      await call(who, "GET", "/api/inbox?status=expired");
      await call(who, "GET", "/api/runs");
    }
    await call(OPERATOR, "GET", `/api/ops/agents/${agentId}/grants`);
    await call(OPERATOR, "GET", opsRelease());
    await call(OPERATOR, "GET", `/api/ops/inbox?client=${A()}`);
    const runs = await H.t.db.select({ id: run.id }).from(run).where(eq(run.tenantId, A()));
    for (const r of runs) await call(OPERATOR, "GET", `/api/ops/runs/${r.id}`);

    // Every row of every table, as JSON, but the code's own hash.
    const tables = await H.t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await H.t.db.execute<{ row: unknown }>(
        sql`select to_jsonb(t) - 'code_hash' as row from ${sql.identifier(table_name)} t`,
      );
      dump.push(JSON.stringify(rows));
    }
    // Timestamps, ids, SIDs and hashes are taken out first: their digits aren't codes.
    const clean = (text: string) =>
      text
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?/g, "T")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
        .replace(/[0-9a-f]{16,}/gi, "H");
    const places = {
      responses: clean(JSON.stringify(responses)),
      logs: clean(logged.join("\n")),
      database: clean(dump.join("\n")),
    };
    for (const code of codes) {
      const found = new RegExp(`(?<!\\d)${code}(?!\\d)`);
      for (const [where, text] of Object.entries(places)) {
        expect(found.test(text), `code found in ${where}`).toBe(false);
      }
    }
    // And the stored hashes are not the codes.
    const hashes = await H.t.db.select({ h: accessRelease.codeHash }).from(accessRelease);
    for (const { h } of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
