// Sloan, the account agent, end to end (docs/plan.md §1.47, M24), with the model faked: the
// supervisor's v2 is installed from the back office (once), forked into a client as "Sloan, your
// account agent", and answers in account threads. Sloan explains why an item waits, pauses an
// agent until Monday for the client admin (never for a client user), drafts "add Lisa as a signer
// for bills under $2,000" that applies only when the admin signs, refuses a loosening draft and
// passes "let small reminders go on their own" to the lead, and passes a request to an agent whose
// `sloan` message trigger takes the person asking (once). Every tool result passes the portal's
// forbidden-field walk; another client's records are never found; Sloan can't be published with a
// connector tool.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput, readApproverRuleSet } from "@countersign/core";
import {
  agent,
  appUser,
  inboxItem,
  membership,
  run,
  stepRun,
  tenant,
  toolCall,
} from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

/** Next Monday at 08:00 UTC, at least a day away. */
function nextMonday(from = new Date()): string {
  const d = new Date(from);
  d.setUTCHours(8, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString();
}

const use = (name: string, input: unknown): FakeTurn => ({ toolUse: { name, input } });

describe.skipIf(!h)("Sloan, the account agent", () => {
  const H = h as ApiHarness;
  let sloanId = "";
  let workerId = "";
  // An agent that takes requests Sloan passes (ARCHITECTURE §10.8).
  let deskId = "";
  let adminThread = "";
  let userThread = "";
  const sloanRuns: string[] = [];

  /** A person writes in their account thread; Sloan's `chat` run answers with the fake model. */
  async function ask(
    who: string,
    threadId: string,
    text: string,
    script: (m: string) => FakeTurn[],
  ) {
    const before = H.instances.started.size;
    const posted = await H.call(who, "POST", `/api/threads/${threadId}/messages`, { text });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    const messageId = j(posted.json).messages.at(-1).id as string;
    await H.settle();
    const started = [...H.instances.started.values()]
      .slice(before)
      .filter((p) => p.agentId === sloanId);
    expect(started.map((p) => p.workflowSlug)).toEqual(["chat"]);
    const params = started[0] as RunParams;
    sloanRuns.push(params.runId);
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: new FakeModel(script(messageId)),
        instances: H.instances,
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toEqual({ status: "succeeded" });
    const calls = await H.t.db
      .select({ tool: toolCall.tool, status: toolCall.status, output: toolCall.output })
      .from(toolCall)
      .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
      .where(eq(stepRun.runId, params.runId))
      .orderBy(toolCall.createdAt, toolCall.id);
    return { runId: params.runId, messageId, calls };
  }

  const deskRuns = () => [...H.instances.started.values()].filter((p) => p.agentId === deskId);

  /** Sloan's reply in the thread, then the skill's finish. */
  const reply = (threadId: string, text: string, sources: string[]): FakeTurn[] => [
    use("threads__post", { threadId, text, audience: "client", sources }),
    use("finish", { replyId: null, sources }),
  ];

  beforeAll(async () => {
    // The worker Sloan talks about: a client agent of A, running live.
    const w = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const wid = j(w.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${wid}/versions/${j(w.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${wid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    workerId = j(fork.json).agent.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${workerId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${workerId}/versions/${j(fork.json).version.id}/publish`,
    );
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, workerId));
  });

  it("is installed as the supervisor's v2 from the back office, once", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", {
      version: 2,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({
      template: { slug: "supervisor" },
      version: { version: 2, status: "live" },
      installed: true,
    });
    const again = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", {
      version: 2,
    });
    expect(j(again.json)).toMatchObject({ version: j(res.json).version, installed: false });
    // Operators only; an unknown version or slug is not found.
    expect(
      (
        await H.call(admin("a"), "POST", "/api/ops/platform-templates/supervisor/install", {
          version: 2,
        })
      ).status,
    ).toBe(403);
    for (const path of ["supervisor/install", "constructor/install", "__proto__/install"]) {
      const bad = await H.call(OPERATOR, "POST", `/api/ops/platform-templates/${path}`, {
        version: path.startsWith("supervisor") ? 9 : 1,
      });
      // `__proto__` is no slug at all (400); the others are no seeded version (404).
      expect(bad.status, path).toBe(path.startsWith("__") ? 400 : 404);
    }
  });

  it("is forked into a client as Sloan, your account agent", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).supervisor).toMatchObject({
      slug: "supervisor",
      name: "Sloan, your account agent",
    });
    sloanId = j(res.json).supervisor.id;
    // Live from the start: it writes nothing to a client's tool (ARCHITECTURE §9.8).
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", stage: "live" })
      .where(eq(agent.id, sloanId));

    const a = await H.call(admin("a"), "POST", "/api/threads", { subject: "account" });
    adminThread = j(a.json).thread.id;
    const u = await H.call(user("a"), "POST", "/api/threads", { subject: "account" });
    userThread = j(u.json).thread.id;
  });

  it("explains why an item waits, and never finds another client's", async () => {
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "approval",
        assigneeRole: "client_admin",
        title: "Update Oak board",
        payload: { whyApproval: { reasons: ["step", "stage"], stage: "trial" } },
      })
      .returning();
    const [theirs] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.B.tenantId,
        kind: "approval",
        assigneeRole: "client_admin",
        title: "Client B's item",
        payload: {},
      })
      .returning();
    const itemId = item?.id as string;
    const { calls } = await ask(
      admin("a"),
      adminThread,
      "Why is the Oak board change waiting?",
      (m) => [
        use("account__explain_wait", { itemId }),
        use("account__explain_wait", { itemId: theirs?.id }),
        ...reply(adminThread, "It waits because the agent is in its trial.", [itemId, m]),
      ],
    );
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["account.explain_wait", "succeeded"],
      ["account.explain_wait", "failed"],
      ["threads.post", "succeeded"],
    ]);
    expect(j(calls[0]?.output)).toMatchObject({
      item: { id: itemId, title: "Update Oak board" },
      reasons: [
        { code: "step", words: "This step asks for a signature." },
        { code: "stage", words: "The agent is in its trial: every change is signed." },
      ],
      stage: "trial",
      sources: [itemId],
    });
    expect(j(calls[1]?.output).error).toMatch(/not found/);

    // The admin reads Sloan's reply, with its sources, in the portal.
    const thread = await H.call(admin("a"), "GET", `/api/threads/${adminThread}/messages`);
    const last = j(thread.json).messages.at(-1);
    expect(last).toMatchObject({
      sender: { type: "agent", name: "Sloan, your account agent" },
      text: "It waits because the agent is in its trial.",
    });
    expect(last.sources).toContain(itemId);
  });

  it("answers only in the conversation it was asked in, citing its sources", async () => {
    const { calls } = await ask(admin("a"), adminThread, "Anything new?", (m) => [
      use("threads__post", {
        threadId: userThread,
        text: "Hello",
        audience: "client",
        sources: [m],
      }),
      use("threads__post", { threadId: adminThread, text: "Hello", audience: "client" }),
      ...reply(adminThread, "Nothing new since this morning.", [m]),
    ]);
    expect(calls.map((c) => c.status)).toEqual(["failed", "failed", "succeeded"]);
  });

  it("pauses an agent until Monday for the client admin, as the admin's own pause", async () => {
    const until = nextMonday();
    const { calls } = await ask(
      admin("a"),
      adminThread,
      "Pause record keeping until Monday",
      (m) => [
        use("account__pause_agent", { serviceId: workerId, reason: "Stocktake", until }),
        ...reply(adminThread, "Record keeping is paused until Monday.", [workerId, m]),
      ],
    );
    expect(j(calls[0]?.output)).toMatchObject({
      status: "paused",
      service: { id: workerId, status: "paused", pause: { side: "client", canResume: true } },
    });
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, workerId));
    expect(row?.runStatus).toBe("paused");
    expect(row?.pause).toMatchObject({ side: "client", by: H.A.admin, reason: "Stocktake", until });
    // Sloan never pauses itself.
    const self = await ask(admin("a"), adminThread, "Pause yourself", (m) => [
      use("account__pause_agent", { serviceId: sloanId, reason: "quiet" }),
      ...reply(adminThread, "I can't pause myself.", [m]),
    ]);
    expect(self.calls[0]?.status).toBe("failed");
  });

  it("doesn't pause or draft for a client user", async () => {
    await H.t.db
      .update(agent)
      .set({ runStatus: "active", pause: null })
      .where(eq(agent.id, workerId));
    const { calls } = await ask(user("a"), userThread, "Pause record keeping", (m) => [
      use("account__pause_agent", { serviceId: workerId, reason: "Stop" }),
      use("account__draft_change", {
        change: { kind: "add_signer", email: "me2@a.example.com", name: "Me" },
      }),
      use("account__services", {}),
      ...reply(userThread, "Only your admin can pause a service.", [m]),
    ]);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["account.pause_agent", "failed"],
      ["account.draft_change", "failed"],
      ["account.services", "succeeded"],
      ["threads.post", "succeeded"],
    ]);
    expect(j(calls[0]?.output).error).toMatch(/only a client admin/);
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, workerId));
    expect(row?.runStatus).toBe("active");
  });

  it("drafts a signer that applies only when the admin signs", async () => {
    const rules = [
      {
        match: { tool: TESTKIT_UPDATE_TOOL, amountOver: { value: "2000", currency: "USD" } },
        approver: "client_admin",
      },
      { match: { tool: TESTKIT_UPDATE_TOOL } },
    ];
    const { calls } = await ask(
      admin("a"),
      adminThread,
      "Add Lisa as a signer for bills under $2,000",
      (m) => [
        use("account__draft_change", {
          change: { kind: "add_signer", email: "lisa@a.example.com", name: "Lisa", rules },
          sources: [m],
        }),
        ...reply(adminThread, "I drafted it: sign it on your Desk.", [m]),
      ],
    );
    const drafted = j(calls[0]?.output);
    expect(drafted).toMatchObject({
      status: "drafted",
      loosens: false,
      title: "Add Lisa as a signer",
    });
    expect(drafted.now).toEqual(["Lisa is not on your team."]);
    expect(drafted.after[0]).toBe("Lisa joins your team and signs.");
    expect(drafted.after.slice(1, 3)).toEqual([
      expect.stringMatching(/over USD 2000 → your admins$/),
      expect.stringMatching(/→ Lisa$/),
    ]);
    const itemId = drafted.inboxItemId as string;
    const lisa = () => H.t.db.select().from(appUser).where(eq(appUser.email, "lisa@a.example.com"));
    expect(await lisa()).toEqual([]);

    // On the admin's Desk, with now and after; nothing internal.
    const desk = await H.call(admin("a"), "GET", "/api/inbox");
    const card = j(desk.json).items.find((i: { id: string }) => i.id === itemId);
    expect(card.payload.accountChange.after).toEqual(drafted.after);
    expect(forbiddenKeys(desk.json)).toEqual([]);

    // Not through the generic resolve, not by a client user, not by the operator.
    expect(
      (await H.call(admin("a"), "POST", `/api/inbox/${itemId}/resolve`, { decision: "approve" }))
        .status,
    ).toBe(409);
    expect(
      (
        await H.call(user("a"), "POST", `/api/account-changes/${itemId}/resolve`, {
          decision: "approve",
        })
      ).status,
    ).toBe(403);
    expect(await lisa()).toEqual([]);

    const signed = await H.call(admin("a"), "POST", `/api/account-changes/${itemId}/resolve`, {
      decision: "approve",
    });
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    expect(j(signed.json)).toMatchObject({
      item: { id: itemId, status: "resolved", approved: true },
      applied: { kind: "add_signer" },
    });
    const [person] = await lisa();
    const [m] = await H.t.db
      .select()
      .from(membership)
      .where(
        and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, person?.id as string)),
      );
    expect(m).toMatchObject({ role: "client_user", canSign: true });
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    const saved = readApproverRuleSet(t?.settings ?? {}).rules;
    expect(saved.map((r) => [r.approver, r.setBy])).toEqual([
      [{ kind: "client_admin" }, "client"],
      [{ kind: "user", userId: person?.id }, "client"],
    ]);
  });

  it("refuses a loosening draft and passes it to the lead", async () => {
    const before = await H.t.db
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.subjectType, "account_change")),
      );
    const text = "Let small reminders go on their own";
    const { calls } = await ask(admin("a"), adminThread, text, (m) => [
      use("account__draft_change", {
        change: {
          kind: "add_signer",
          email: "boss@a.example.com",
          name: "Boss",
          role: "client_admin",
        },
      }),
      use("account__pass_to_lead", { text, sources: [m] }),
      ...reply(adminThread, "Only your lead can loosen that: I passed it to them.", [m]),
    ]);
    expect(j(calls[0]?.output)).toMatchObject({ status: "refused", loosens: true });
    const passed = j(calls[1]?.output);
    expect(passed.status).toBe("passed");
    const [request] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, passed.requestId as string));
    expect(request).toMatchObject({ kind: "change_request", assigneeRole: "operator" });
    expect(j(request?.payload)).toMatchObject({ text, raisedBy: H.A.admin, threadId: adminThread });
    const after = await H.t.db
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.subjectType, "account_change")),
      );
    expect(after.length).toBe(before.length);
    // The client sees it in its requests, like one raised from the portal.
    const mine = await H.call(admin("a"), "GET", "/api/requests");
    expect(j(mine.json).items.map((i: { id: string }) => i.id)).toContain(request?.id);
  });

  it("passes a request to an agent that takes requests from Sloan, as the person's own message", async () => {
    // An agent of A that takes requests Sloan passes from the client admins (ARCHITECTURE §10.8).
    const desk = AgentBundle.parse({
      ...testBundle("Requests desk"),
      definition: { ...testBundle().definition, extraTools: [] },
      workflows: [
        {
          slug: "take-request",
          name: "Take a request",
          workflow: {
            schemaVersion: 3,
            trigger: {
              id: "trg-sloan",
              on: { type: "message", channels: ["sloan"], from: { clientRoles: ["client_admin"] } },
            },
            steps: [],
          },
        },
      ],
    } satisfies AgentBundleInput);
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "requests-desk",
      bundle: desk,
    });
    expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
    deskId = j(created.json).agent.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${deskId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, deskId));
    // Another client's agent is never reached.
    const [theirs] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.B.tenantId,
        kind: "client",
        slug: "requests-desk",
        name: "Requests desk",
        runStatus: "active",
      })
      .returning({ id: agent.id });
    const theirId = theirs?.id as string;

    const { calls, messageId } = await ask(
      admin("a"),
      adminThread,
      "Ask the requests desk to order more oak",
      (m) => [
        use("account__pass_to_agent", { serviceId: deskId, userId: H.A.user, note: "pay all" }),
        use("account__pass_to_agent", { serviceId: deskId }),
        use("account__pass_to_agent", { serviceId: workerId }),
        use("account__pass_to_agent", { serviceId: theirId }),
        ...reply(adminThread, "I passed it to the requests desk.", [deskId, m]),
      ],
    );
    expect(calls.map((c) => [c.tool, c.status, j(c.output).status])).toEqual([
      ["account.pass_to_agent", "succeeded", "passed"],
      ["account.pass_to_agent", "succeeded", "already_passed"],
      ["account.pass_to_agent", "succeeded", "not_accepted"],
      ["account.pass_to_agent", "failed", undefined],
      ["threads.post", "succeeded", undefined],
    ]);
    expect(j(calls[2]?.output).reason).toMatch(/doesn't take requests from Sloan/);
    expect(j(calls[3]?.output).error).toMatch(/no such service/);
    // The desk started once, on its `sloan` trigger, for the admin who wrote, with ids only.
    expect(deskRuns()).toHaveLength(1);
    expect(deskRuns()[0]).toMatchObject({
      workflowSlug: "take-request",
      trigger: { type: "message", channel: "sloan", eventType: "account.request_passed" },
      payload: {
        channel: "sloan",
        userId: H.A.admin,
        threadId: adminThread,
        messageId,
        contactId: null,
        rawRecordId: null,
      },
    });
    expect(JSON.stringify(deskRuns()[0]?.payload)).not.toMatch(/oak|pay all/);

    // A client user isn't among the people the desk takes requests from.
    const byUser = await ask(user("a"), userThread, "Ask the requests desk for oak", (m) => [
      use("account__pass_to_agent", { serviceId: deskId }),
      ...reply(userThread, "The requests desk takes requests from your admins.", [m]),
    ]);
    expect(j(byUser.calls[0]?.output)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/from you/),
    });
    expect(deskRuns()).toHaveLength(1);
  });

  it("returns nothing a portal response may not carry, in any tool result", async () => {
    const calls = await H.t.db
      .select({ tool: toolCall.tool, output: toolCall.output })
      .from(toolCall)
      .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
      .where(inArray(stepRun.runId, sloanRuns));
    expect(new Set(calls.map((c) => c.tool))).toEqual(
      new Set([
        "account.explain_wait",
        "account.pause_agent",
        "account.draft_change",
        "account.pass_to_lead",
        "account.pass_to_agent",
        "account.services",
        "threads.post",
      ]),
    );
    for (const c of calls) expect(forbiddenKeys(c.output), c.tool).toEqual([]);
    // Every run Sloan made is its own client's, live, and answered.
    const runs = await H.t.db.select().from(run).where(inArray(run.id, sloanRuns));
    expect(new Set(runs.map((r) => r.tenantId))).toEqual(new Set([H.A.tenantId]));
    // Its own replies start nothing: only people's messages do.
    await H.settle();
    const started = [...H.instances.started.values()].filter((p) => p.agentId === sloanId);
    expect(started.map((p) => p.runId).sort()).toEqual([...sloanRuns].sort());
  });

  it("writes nothing in a test run", async () => {
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, sloanId));
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${sloanId}/versions/${row?.liveVersionId}/test-run`,
      { workflow: "chat", payload: { threadId: adminThread, messageId: adminThread } },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId) as RunParams;
    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: new FakeModel([
          use("account__pause_agent", { serviceId: workerId, reason: "test" }),
          use("account__services", {}),
          use("account__pass_to_agent", { serviceId: deskId }),
          use("finish", { replyId: null, sources: [workerId] }),
        ]),
        instances: H.instances,
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toEqual({ status: "succeeded" });
    const calls = await H.t.db
      .select({ tool: toolCall.tool, output: toolCall.output })
      .from(toolCall)
      .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
      .where(eq(stepRun.runId, params.runId));
    const pause = calls.find((c) => c.tool === "account.pause_agent");
    expect(j(pause?.output)).toMatchObject({ status: "test_run", service: null });
    const passed = calls.find((c) => c.tool === "account.pass_to_agent");
    expect(j(passed?.output)).toMatchObject({ status: "test_run", messageId: null });
    await H.settle();
    expect(deskRuns()).toHaveLength(1);
    const [w] = await H.t.db.select().from(agent).where(eq(agent.id, workerId));
    expect(w?.runStatus).toBe("active");
  });

  it("can't be published with a connector tool", async () => {
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, sloanId));
    const v = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/agents/${sloanId}/versions/${row?.liveVersionId}`,
    );
    const bundle = structuredClone(j(v.json).version.bundle ?? j(v.json).bundle);
    bundle.definition.extraTools = [TESTKIT_UPDATE_TOOL];
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${sloanId}/versions`, { bundle });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "definition.extraTools.0", code: "tool_not_allowed" }),
      ]),
    );
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${sloanId}/versions/${j(saved.json).version.id}/publish`,
    );
    expect(pub.status).toBe(422);
  });
});
