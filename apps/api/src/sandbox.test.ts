// A client's sandbox through the API (docs/plan.md §1.243): an agent run on the client's own data
// from the portal or the back office, as a test run that writes nothing; its view lists what it
// would have changed (a record's fields before and after, an email as it would arrive, a text);
// "Send to me" sends the email from the mailbox the agent would have used to the person asking
// and nobody else, once a minute, recorded and counted; a text can't be sent until the client's
// own number can text; the operator sends only in the Sandbox client; the portal sees only
// sandbox runs, of the agents the person sees, with nothing of ours in them (invariant 11).
import {
  type Connector,
  defineConnector,
  defineWriteTool,
  generateEncryptionKey,
  type PreviewEmail,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { SANDBOX_SEND_CHANGE } from "@countersign/core";
import {
  connection,
  connectionChange,
  externalAction,
  meteredUsage,
  tenant,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const MAIL_TOOL = "fakemail.send";
const SMS_TOOL = "fakesms.send";
const previews: { to: string; subject: string; text: string; connectionId: string }[] = [];
const sent: string[] = [];

const EmailInput = z.object({ to: z.string(), subject: z.string(), text: z.string() });
const SmsInput = z.object({ to: z.string(), text: z.string() });

/** A mailbox like Gmail's: one send tool, and previews to a person. */
function fakeMail(): Connector {
  const c = defineConnector({
    id: "fakemail",
    askFirst: [{ verb: "create", entity: "message" }],
    name: "Fake mail",
    description: "A mailbox for tests.",
    icon: "mail",
    auth: "none",
    testOnly: true,
    entities: [],
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    tools: [
      defineWriteTool({
        id: MAIL_TOOL,
        entity: "message",
        description: "Email a contact.",
        verb: "create",
        undo: { kind: "none" },
        recipient: { path: "to", channel: "email" },
        input: EmailInput,
        output: z.object({ id: z.string() }),
        beforeSchema: z.object({
          contact: z.object({ id: z.string(), name: z.string() }),
          to: z.string(),
          from: z.string(),
          subject: z.string(),
          text: z.string(),
        }),
        async before(input) {
          return {
            contact: { id: "c1", name: "Northside Lumber" },
            from: "office@a.example.com",
            ...input,
          };
        },
        async run(input) {
          sent.push(input.to);
          return { id: "m1" };
        },
        testOutput: () => ({ id: "test-m1" }),
      }),
    ],
  });
  return Object.assign(c, {
    async sendPreview(ctx: { connection: { id: string } }, email: PreviewEmail) {
      previews.push({ ...email, connectionId: ctx.connection.id });
      return { id: `p${previews.length}`, from: "office@a.example.com" };
    },
  });
}

/** A texting tool, as Twilio's `sms.send` is. */
function fakeSms(): Connector {
  return defineConnector({
    id: "fakesms",
    askFirst: [{ verb: "create", entity: "message" }],
    name: "Fake texts",
    description: "Texts for tests.",
    icon: "message",
    auth: "none",
    testOnly: true,
    entities: [],
    permissionEntities: [{ id: "message", label: "Messages", verbs: ["create"] }],
    tools: [
      defineWriteTool({
        id: SMS_TOOL,
        entity: "message",
        description: "Text a contact.",
        verb: "create",
        undo: { kind: "none" },
        recipient: { path: "to", channel: "sms" },
        input: SmsInput,
        output: z.object({ sid: z.string() }),
        beforeSchema: SmsInput,
        async before(input) {
          return input;
        },
        async run(input) {
          sent.push(input.to);
          return { sid: "s1" };
        },
        testOutput: () => ({ sid: "test-s1" }),
      }),
    ],
  });
}

const h = await createApiHarness({
  connectors: () => [fakeMail(), fakeSms()],
  env: { ENCRYPTION_KEY: generateEncryptionKey() },
});
afterAll(() => h?.close());

/** Started by hand (the client may run it) and on a document: an email, a record, a text. */
function bundle(): unknown {
  const steps = [
    {
      id: "email",
      kind: "write",
      name: "Email the vendor",
      tool: MAIL_TOOL,
      input: {
        to: "orders@northside.example.com",
        subject: "Order 1042",
        text: "Please confirm Friday.",
      },
    },
    {
      id: "update",
      kind: "write",
      name: "Update the record",
      tool: TESTKIT_UPDATE_TOOL,
      input: { id: "r1", amount: "12.00" },
    },
    {
      id: "text",
      kind: "write",
      name: "Text the driver",
      tool: SMS_TOOL,
      input: { to: "+15125550100", text: "Pick up at 9." },
    },
  ];
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Order desk", role: "Orders", mission: "Send orders." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: [MAIL_TOOL, TESTKIT_UPDATE_TOOL, SMS_TOOL],
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: "orders",
        name: "Send the order",
        workflow: {
          schemaVersion: 4,
          triggers: [
            {
              id: "t",
              on: {
                type: "manual",
                input: { type: "object", properties: { note: { type: "string" } } },
                client: { canRun: true, label: "Send an order" },
              },
            },
          ],
          steps,
        },
      },
    ],
  };
}

describe.skipIf(!h)("A client's sandbox", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    modelCallBodies: H.objects,
  });
  let agentId = "";
  let versionId = "";
  let portalRun = "";
  let mailConn = "";

  async function finish(runId: string) {
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("the run was not started");
    return executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
  }

  it("sets up an agent bound to a mailbox, the record system and a texting tool", async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "fakemail", "fakesms"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const conns: Record<string, string> = {};
    for (const connector of ["fakemail", "fakesms"]) {
      const [row] = await H.t.db
        .insert(connection)
        .values({ tenantId: A(), connector, status: "connected" })
        .returning();
      conns[connector] = row?.id as string;
    }
    mailConn = conns.fakemail as string;
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "order-desk",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    versionId = j(created.json).version.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId, fakemail: conns.fakemail, fakesms: conns.fakesms },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("lists the agents the person can try, with the form it starts from", async () => {
    const res = await H.call(admin("a"), "GET", "/api/sandbox");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    expect(view.canTry).toBe(true);
    expect(view.use).toMatchObject({ runs: 0, maxRuns: 20, sends: 0, maxSends: 20 });
    const a = view.agents.find((x: { id: string }) => x.id === agentId);
    expect(a).toMatchObject({ name: "Order desk", running: false, documents: [] });
    expect(a.forms).toEqual([
      expect.objectContaining({ workflow: "orders", label: "Send an order" }),
    ]);
    expect(forbiddenKeys(view)).toEqual([]);
  });

  it("refuses an input the form doesn't take, and another client's agent", async () => {
    const bad = await H.call(admin("a"), "POST", "/api/sandbox/runs", {
      agentId,
      workflow: "orders",
      input: { note: 12 },
    });
    expect(bad.status, JSON.stringify(bad.json)).toBe(422);
    const other = await H.call(admin("b"), "POST", "/api/sandbox/runs", {
      agentId,
      workflow: "orders",
      input: {},
    });
    expect(other.status).toBe(404);
  });

  it("runs from the portal as a test run that writes nothing", async () => {
    const res = await H.call(admin("a"), "POST", "/api/sandbox/runs", {
      agentId,
      workflow: "orders",
      input: { note: "rush" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    portalRun = j(res.json).run.runId;
    expect(j(res.json).run).toMatchObject({
      status: "running",
      side: "portal",
      title: "Send an order",
    });
    // One open run per agent.
    const again = await H.call(admin("a"), "POST", "/api/sandbox/runs", {
      agentId,
      workflow: "orders",
      input: {},
    });
    expect(again.status, JSON.stringify(again.json)).toBe(409);
    await finish(portalRun);
    expect(sent).toEqual([]);
    expect(H.backend.get(H.A.connectionId, "r1")?.amount).toBe("10.00");
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, portalRun));
    expect(actions.map((a) => a.status)).toEqual(["proposed", "proposed", "proposed"]);
  });

  it("shows what it would have changed: the email, the record's fields, the text", async () => {
    const res = await H.call(admin("a"), "GET", `/api/sandbox/runs/${portalRun}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const run = j(res.json).run;
    expect(forbiddenKeys(run)).toEqual([]);
    expect(run).toMatchObject({ status: "done", changeCount: 3, byName: expect.any(String) });
    const [email, record, text] = run.changes;
    expect(email).toMatchObject({
      kind: "message",
      title: "Email to Northside Lumber",
      tool: { connector: "fakemail", connectorName: "Fake mail" },
      message: {
        channel: "email",
        to: "orders@northside.example.com",
        toName: "Northside Lumber",
        from: "office@a.example.com",
        subject: "Order 1042",
        text: "Please confirm Friday.",
        attachments: 0,
      },
      fields: [],
      send: { channel: "email", to: admin("a"), can: true, reason: null },
      sent: [],
    });
    expect(record).toMatchObject({
      kind: "record",
      title: "Update the record",
      message: null,
      send: null,
    });
    expect(record.fields).toEqual(
      expect.arrayContaining([{ field: "amount", before: "10.00", after: "12.00" }]),
    );
    // The client's number isn't set up: a text is read here but can't be sent.
    expect(text).toMatchObject({
      kind: "message",
      message: { channel: "sms", to: "+15125550100", text: "Pick up at 9." },
      send: { channel: "sms", can: false },
    });
    expect(text.send.reason).toMatch(/texting number isn't set up/);
    expect(run.steps.map((s: { id: string }) => s.id)).toEqual(["email", "update", "text"]);
  });

  it("sends the email to the person asking only, from the mailbox, and records it", async () => {
    const res = await H.call(admin("a"), "GET", `/api/sandbox/runs/${portalRun}`);
    const email = j(res.json).run.changes[0];
    const send = await H.call(
      admin("a"),
      "POST",
      `/api/sandbox/runs/${portalRun}/changes/${email.id}/send`,
    );
    expect(send.status, JSON.stringify(send.json)).toBe(200);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      to: admin("a"),
      subject: "[Sandbox] Order 1042",
      connectionId: mailConn,
    });
    expect(previews[0]?.text).toContain("Nothing was sent to anyone else");
    expect(previews[0]?.text).toContain("Northside Lumber <orders@northside.example.com>");
    expect(previews[0]?.text).toContain("Please confirm Friday.");
    expect(sent).toEqual([]);
    const after = j(send.json).run.changes[0];
    expect(after.sent).toEqual([expect.objectContaining({ channel: "email", to: admin("a") })]);
    const [change] = await H.t.db
      .select()
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.connectionId, mailConn),
          sql`${connectionChange.change}->>'kind' = ${SANDBOX_SEND_CHANGE}`,
        ),
      );
    expect(change?.change).toMatchObject({
      by: "client",
      runId: portalRun,
      actionId: email.id,
      to: admin("a"),
    });
    const usage = await H.t.db
      .select()
      .from(meteredUsage)
      .where(and(eq(meteredUsage.tenantId, A()), eq(meteredUsage.source, "sandbox_preview")));
    expect(usage.map((u) => u.measure)).toEqual(["emails"]);
    // Once a minute per person.
    const again = await H.call(
      admin("a"),
      "POST",
      `/api/sandbox/runs/${portalRun}/changes/${email.id}/send`,
    );
    expect(again.status).toBe(429);
    // A text that can't go is refused with why.
    const text = j(send.json).run.changes[2];
    const refused = await H.call(
      admin("a"),
      "POST",
      `/api/sandbox/runs/${portalRun}/changes/${text.id}/send`,
    );
    expect(refused.status).toBe(409);
    expect(j(refused.json).error.code ?? j(refused.json).code).toBe("cannot_send");
  });

  it("lets the operator start one from the back office and read both, but not send in a real client", async () => {
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
      { workflow: "orders", payload: {}, sandbox: true },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const opsRun = j(res.json).runId;
    await finish(opsRun);
    const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/sandbox`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(j(list.json).canSend).toBe(false);
    expect(j(list.json).runs.map((r: { runId: string }) => r.runId)).toEqual([opsRun, portalRun]);
    expect(j(list.json).runs[0]).toMatchObject({ side: "ops", changes: 3, messages: 2 });
    const view = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/sandbox/runs/${opsRun}`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    const email = j(view.json).run.changes[0];
    expect(email.send).toMatchObject({ can: false });
    expect(email.send.reason).toMatch(/client's own people/);
    const send = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/sandbox/runs/${opsRun}/changes/${email.id}/send`,
    );
    expect(send.status).toBe(409);
    // The client sees the back office's run in its own sandbox, as ours.
    const portal = await H.call(user("a"), "GET", "/api/sandbox");
    const theirs = j(portal.json).runs.find((r: { runId: string }) => r.runId === opsRun);
    expect(theirs).toMatchObject({ side: "ops", byName: "Mezonas" });
  });

  it("lets the operator send in the Sandbox client", async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: sql`${tenant.settings} || '{"sandbox": true}'::jsonb` })
      .where(eq(tenant.id, A()));
    const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/sandbox`);
    expect(j(list.json).canSend).toBe(true);
    const opsRun = j(list.json).runs[0].runId;
    const view = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/sandbox/runs/${opsRun}`);
    const email = j(view.json).run.changes[0];
    const send = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/sandbox/runs/${opsRun}/changes/${email.id}/send`,
    );
    expect(send.status, JSON.stringify(send.json)).toBe(200);
    expect(previews.at(-1)?.to).toBe(OPERATOR);
    await H.t.db
      .update(tenant)
      .set({ settings: sql`${tenant.settings} - 'sandbox'` })
      .where(eq(tenant.id, A()));
  });

  it("keeps other test runs out of the sandbox, and other clients' runs out of reach", async () => {
    const plain = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/test-run`,
      { workflow: "orders", payload: {} },
    );
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    const runId = j(plain.json).runId;
    await finish(runId);
    const hidden = await H.call(admin("a"), "GET", `/api/sandbox/runs/${runId}`);
    expect(hidden.status).toBe(404);
    const elsewhere = await H.call(admin("b"), "GET", `/api/sandbox/runs/${portalRun}`);
    expect(elsewhere.status).toBe(404);
    const list = await H.call(admin("b"), "GET", "/api/sandbox");
    expect(j(list.json).runs).toEqual([]);
  });
});
