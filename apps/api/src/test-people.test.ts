// People in a Sandbox test run (owner, 2026-11-27), against fake Resend and the testkit (nothing
// live). "Ask me" is refused outside the Sandbox, and when a Contact step's channel has no address
// for the test person. In the Sandbox, a Contact step's message goes to the operator who started
// the run (never to the person it names), with "[Test · For Dana Whitfield]" on its subject, after
// the operator signs it in their own Your call; the run waits, and their email reply by the tag is
// Dana's answer. A write waits for the operator's decision: approved, it is still not written;
// rejected, the step takes its reject path. Without "Ask me", nothing is sent or waited for.

import { createResendConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  contact,
  externalAction,
  inboxItem,
  membership,
  stepRun,
  tenant,
} from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  doAction,
  ended,
  FakeWorkflowStep,
  OPERATOR,
  unsigned,
  v5Workflow,
} from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { quietNever } from "./quiet-hours.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const FORWARDING = "in.mezonas.test";
const resend = fakeResend();

const h = await createApiHarness({
  connectors: () => [createResendConnector({ fetch: resend.fetch })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    EMAIL_FORWARDING_DOMAIN: FORWARDING,
  },
  fetch: resend.fetch,
});
afterAll(() => h?.close());

// A real address: the step names a real person, and still nothing reaches them.
const DANA = "dana@ridgeline.co";
const MY_PHONE = "+15125551234";
const GOAL = "Find out how many sheets of ply they need and by when.";
const FOUND = { qty: 12, neededBy: "Friday" };
const turn = (input: Record<string, unknown>): FakeTurn => ({ toolUse: { name: "turn", input } });
const consent = (channels: string[]) =>
  Object.fromEntries(
    channels.map((ch) => [
      ch,
      { grantedAt: new Date().toISOString(), source: "test", basis: "express" },
    ]),
  );

/** A workflow with ids of its own: ids are unique across a bundle's workflows. */
function workflowOf(slug: string, list: unknown[]) {
  return v5Workflow(
    [...list, { id: `end-${slug}`, kind: "end", name: "Done", outputs: [`out-${slug}`] }],
    {
      triggers: [{ id: `trg-${slug}`, on: { type: "manual", input: {} } }],
      outputs: [{ id: `out-${slug}`, name: "Done", kind: "nothing" } as { id: string }],
      end: false,
    },
  );
}

function contactStep(channel: "email" | "sms", id = "talk") {
  return {
    id,
    name: "Ask Dana",
    kind: "do",
    doneBy: "contact",
    contact: {
      with: "{{trigger.contactId}}",
      channel,
      goal: GOAL,
      mayShare: [],
      maxTurns: 4,
      messages: { first: "required", later: "within_goal" },
      deadline: { after: "3 days", hours: "clock", ifNoAnswer: "stop" },
    },
    output: [
      { name: "qty", type: "number", required: true, about: "How many sheets" },
      { name: "neededBy", type: "text", required: true, about: "By when" },
    ],
  };
}

function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Orders", role: "orders desk", mission: "Keep deliveries on time." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: ["testkit.record.update"],
      canCommand: [],
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      { slug: "ask", name: "Ask", workflow: workflowOf("ask", [contactStep("email")]) },
      {
        slug: "text",
        name: "Text",
        workflow: workflowOf("text", [contactStep("sms", "text-talk")]),
      },
      {
        slug: "fix",
        name: "Fix",
        workflow: workflowOf("fix", [
          doAction("update", "Update the record", "testkit.record.update", {
            id: "r1",
            amount: "12.00",
          }),
        ]),
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("people in a Sandbox test run", () => {
  const H = h as ApiHarness;
  let sandbox = "";
  let agentId = "";
  let versionId = "";
  let dana = "";
  let me = "";
  let model = new FakeModel();
  const SANDBOX_ADMIN = "admin@sandbox-people.example.com";

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: model,
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });

  const testRun = (workflow: string, body: Record<string, unknown> = {}, id = agentId) =>
    H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${versionId}/test-run`, {
      workflow,
      payload: { contactId: dana },
      ...body,
    });

  /** The operator answers from their own mailbox, to the reply address with its tag. */
  async function replyAs(from: string, to: string, subject: string, text: string, n: number) {
    const raw = new TextEncoder().encode(
      [
        `Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=${from}`,
        `From: Me <${from}>`,
        `To: ${to}`,
        `Subject: Re: ${subject}`,
        `Message-ID: <reply-people-${n}@mailbox.test>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
      ].join("\r\n"),
    );
    const pending: Promise<unknown>[] = [];
    await handleEmail(
      { from, to, raw: new Response(raw).body as ReadableStream<Uint8Array>, rawSize: raw.length },
      H.env,
      (p) => pending.push(p),
      {
        ...defaultDeps,
        openDb: () => ({ db: H.db, close: async () => {} }),
        instances: () => H.instances,
        objects: () => H.objects,
        extractionTransport: () => null,
      },
    );
    await Promise.all(pending);
    await H.settle();
  }

  const openItem = async (runId: string) => {
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, runId), eq(inboxItem.status, "open")));
    if (!item) throw new Error("nothing asked");
    return item;
  };

  const decide = async (itemId: string, decision: "approve" | "reject") => {
    const done = await H.call(OPERATOR, "POST", `/api/ops/inbox/${itemId}/resolve`, { decision });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  };

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({
        name: "Sandbox",
        settings: {
          sandbox: true,
          connectors_offered: ["testkit"],
          approvals: { undoSeconds: 0 },
          messaging: { quietHours: quietNever() },
        },
      })
      .returning();
    sandbox = row?.id as string;
    const [you] = await H.t.db
      .insert(appUser)
      .values({ email: SANDBOX_ADMIN, name: "Sandbox admin" })
      .returning();
    await H.t.db.insert(membership).values([
      { tenantId: sandbox, userId: H.operator, role: "operator" },
      { tenantId: sandbox, userId: you?.id as string, role: "client_admin" },
    ]);
    const fwd = await H.call(SANDBOX_ADMIN, "GET", "/api/connections/upload/forwarding");
    expect(fwd.status, JSON.stringify(fwd.json)).toBe(200);
    const made = await H.call(OPERATOR, "POST", `/api/ops/clients/${sandbox}/email`, {
      domain: "ridgeline.example",
      localPart: "orders",
      fromName: "Ridgeline orders",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const emailConn = j(made.json).setup.connection.connectionId as string;
    const [testkit] = await H.t.db
      .insert(connection)
      .values({ tenantId: sandbox, connector: "testkit", status: "pending" })
      .returning();
    const auth = await H.call(SANDBOX_ADMIN, "POST", "/api/connections/testkit/authorize");
    expect(auth.status, JSON.stringify(auth.json)).toBe(200);
    const people = await H.t.db
      .insert(contact)
      .values([
        {
          tenantId: sandbox,
          name: "Dana Whitfield",
          email: DANA,
          relationship: "vendor",
          consent: consent(["email"]),
        },
        // The operator, as an employee of the Sandbox: their phone is known from here.
        {
          tenantId: sandbox,
          name: "Operator (you)",
          email: OPERATOR,
          phone: MY_PHONE,
          relationship: "employee",
          consent: consent(["email", "sms"]),
        },
      ])
      .returning();
    dana = people[0]?.id as string;
    me = people[1]?.id as string;
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${sandbox}/agents`, {
      slug: "orders-people",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    versionId = j(created.json).version.id;
    const ops = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: testkit?.id },
    });
    expect(ops.status, JSON.stringify(ops.json)).toBe(200);
    const ch = await H.call(OPERATOR, "PUT", `/api/ops/agents/${agentId}/channels`, {
      channels: { email: emailConn },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, agentId));
  });

  it("is refused outside the Sandbox, and with no address for a Contact step's channel", async () => {
    // A client's own agent never sends from a test run.
    const own = bundle();
    own.workflows = own.workflows.filter((w) => w.slug === "fix");
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "orders-client",
      bundle: own,
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const client = j(created.json);
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${client.agent.id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const outside = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${client.agent.id}/versions/${client.version.id}/test-run`,
      { workflow: "fix", payload: {}, people: "ask_me" },
    );
    expect(outside.status).toBe(422);
    expect(j(outside.json).error.code).toBe("not_sandbox");
    expect(j(outside.json).error.message).toContain(
      "People in a test are asked only in the Sandbox",
    );

    // A text with no phone known for the operator.
    await H.t.db.update(contact).set({ phone: null }).where(eq(contact.id, me));
    const noPhone = await testRun("text", { people: "ask_me" });
    expect(noPhone.status).toBe(422);
    expect(j(noPhone.json).error.code).toBe("no_test_person");
    expect(j(noPhone.json).error.message).toContain("We have no phone number to text you at");
    await H.t.db.update(contact).set({ phone: MY_PHONE }).where(eq(contact.id, me));
    const withPhone = await testRun("text", { people: "ask_me" });
    expect(withPhone.status, JSON.stringify(withPhone.json)).toBe(200);
    const params = H.instances.started.get(j(withPhone.json).runId);
    expect(params?.testPeople).toEqual({ by: H.operator, email: OPERATOR, phone: MY_PHONE });
  });

  it("sends a Contact step's message to the operator only, waits, and their reply is Dana's answer", async () => {
    const res = await testRun("ask", { people: "ask_me" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no test run");
    const OPENING = "Hi Dana, how many sheets do you need, and by when?";
    const CONFIRM = "To confirm: 12 sheets by Friday?";
    model = new FakeModel([
      turn({ action: "ask", message: OPENING }),
      turn({ action: "confirm", message: CONFIRM, result: FOUND }),
      turn({ action: "done", result: FOUND, confirmed: true }),
    ]);
    const before = resend.emails.length;
    const conversation = `conversation-${params.runId}_ctalk`;
    const waits: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      waits.push(type);
      expect(type).toBe(conversation);
      const from = H.instances.events.length;
      const out = resend.emails.slice(before);
      if (waits.length === 1) {
        // Nothing goes before the operator signs it, in their own Your call.
        expect(out).toHaveLength(0);
        const item = await openItem(params.runId);
        expect(item).toMatchObject({ assigneeRole: "operator", assigneeUserId: H.operator });
        await decide(item.id, "approve");
      } else {
        const sent = out.at(-1);
        // To the operator, never to Dana, marked as the test's.
        expect(out.every((m) => m.to?.length === 1 && m.to[0] === OPERATOR)).toBe(true);
        expect(sent?.subject?.startsWith(`[Test · For Dana Whitfield] ${GOAL}`)).toBe(true);
        expect(unsigned(sent?.text as string) ?? sent?.text).toContain(
          waits.length === 2 ? OPENING : CONFIRM,
        );
        await replyAs(
          OPERATOR,
          sent?.reply_to as string,
          sent?.subject as string,
          waits.length === 2 ? "12 sheets, by Friday" : "Yes",
          waits.length,
        );
      }
      const woke = H.instances.events.slice(from).find((e) => e.event.type === conversation);
      if (!woke) throw new Error("the conversation's event wasn't sent");
      return woke.event.payload;
    });
    const result = await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(result).toEqual(ended());
    expect(waits).toHaveLength(3);
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "talk")));
    expect(row?.output).toMatchObject({ status: "done", found: FOUND });
    expect(resend.emails.slice(before).some((m) => m.to?.includes(DANA))).toBe(false);
  });

  it("without people, sends nothing and waits for nobody", async () => {
    const res = await testRun("ask");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no test run");
    expect(params.testPeople).toBeUndefined();
    model = new FakeModel([turn({ action: "ask", message: "Hi Dana, which sheets?" })]);
    const before = resend.emails.length;
    const result = await executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
    expect(result).toEqual(ended());
    expect(resend.emails.length).toBe(before);
    const [row] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "talk")));
    expect(j(row?.output).summary).toContain("Test run: nothing was sent.");
  });

  it("waits for the operator's decision on a write: approved, it is still not written", async () => {
    const run = async (decision: "approve" | "reject") => {
      const res = await testRun("fix", { payload: {}, people: "ask_me" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const params = H.instances.started.get(j(res.json).runId);
      if (!params) throw new Error("no test run");
      const step = new FakeWorkflowStep(async (_name, type) => {
        const item = await openItem(params.runId);
        expect(type).toBe(`inbox-${item.id.replace(/-/g, "")}`);
        expect(item).toMatchObject({
          kind: "approval",
          assigneeRole: "operator",
          assigneeUserId: H.operator,
        });
        expect(j(item.payload)).toMatchObject({ testRun: true, notWritten: true });
        await decide(item.id, decision);
        return H.instances.events.find((e) => e.event.type === type)?.event.payload;
      });
      const result = await executeRun(deps(), params, cloudflareStepRunner(step));
      expect(step.waits).toHaveLength(1);
      const actions = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, params.runId));
      // Never executed, either way (invariant 8).
      expect(actions.map((a) => a.status)).toEqual(["proposed"]);
      const [row] = await H.t.db
        .select()
        .from(stepRun)
        .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "update")));
      return { result, row };
    };
    const yes = await run("approve");
    expect(yes.result).toEqual(ended());
    expect(yes.row).toMatchObject({ status: "succeeded" });
    expect(yes.row?.summary).toContain("test run, not written");
    const no = await run("reject");
    expect(no.result).toMatchObject({ status: "cancelled", reason: "rejected", nodeId: "update" });
    expect(no.row).toMatchObject({ status: "skipped" });
  });
});
