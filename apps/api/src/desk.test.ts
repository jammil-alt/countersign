// The Desk against a real database as cs_worker (ARCHITECTURE §11.1, §4; docs/plan.md §1.39, M16):
// why a change waits, quick answers, snooze, edits before signing (re-checked and re-routed),
// signing part of a batch, the undo window (held, delivered by the cron's resume, undone before
// it ends and never after) and viewers, driven through the API and the real executor.

import { executeAction } from "@countersign/agents";
import { defineConnector, defineWriteTool } from "@countersign/connectors";
import {
  AgentBundle,
  type AgentBundleInput,
  DecimalString,
} from "@countersign/core";
import { agent, connection, externalAction, inboxItem, membership, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { executeRun, runtimeFor } from "./runs/execute";
import { dbInboxPort } from "./runs/ports";
import { redeliverResolutions } from "./runs/resume";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** What the fake mail system sent, by idempotency key: each change is written at most once. */
const sent = new Map<string, { to: string; subject: string; total: string }>();

const Send = z.object({
  to: z.string().min(3),
  subject: z.string().min(1).max(200),
  body: z.string(),
  total: DecimalString,
});

/** A connector whose one write has a display with editable fields and a proposal check. */
const deskkit = defineConnector({
  id: "deskkit",
  name: "Deskkit",
  description: "A fake mail system for the Desk's tests.",
  icon: "mail",
  auth: "none",
  entities: ["Message"],
  tools: [
    defineWriteTool({
      id: "deskkit.message.send",
      description: "Send a message.",
      verb: "create",
      amount: { path: "total", currency: "USD" },
      display: {
        name: "Email",
        fields: [
          { label: "To", kind: "text", after: "input.to" },
          { label: "Subject", kind: "text", after: "input.subject", editable: true },
          { label: "Body", kind: "text", after: "input.body", editable: true },
          { label: "Total", kind: "money", after: "input.total", currency: "USD", editable: true },
        ],
      },
      input: Send,
      output: z.object({ id: z.string() }),
      beforeSchema: z.object({}),
      async before(input) {
        // The connector's own proposal check, run again on an edit.
        if (input.subject.includes("REFUSE")) throw new Error("the provider refuses this subject");
        return null;
      },
      async run(input, ctx) {
        sent.set(ctx.idempotencyKey, { to: input.to, subject: input.subject, total: input.total });
        return { id: ctx.idempotencyKey };
      },
    }),
  ],
});

const SEND = "deskkit.message.send";

function bundle(): AgentBundle {
  const send = (id: string, input: Record<string, string>, onReject = "stop") => ({
    id,
    name: "Send",
    kind: "action",
    tool: SEND,
    input,
    approval: { required: "required", onReject },
  });
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Mailer", role: "sends mail", mission: "send what is asked" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Send mail only when asked.",
      skills: [],
      extraTools: [SEND],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "one",
        name: "Send one",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-one", on: { type: "manual", input: {} } },
          steps: [
            send("send1", { to: "pat@example.com", subject: "Your invoice", body: "Hi", total: "10.00" }),
          ],
        },
      },
      {
        slug: "many",
        name: "Send many",
        workflow: {
          schemaVersion: 3,
          trigger: {
            id: "trg-many",
            on: {
              type: "manual",
              input: {
                type: "object",
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { to: { type: "string" }, subject: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          steps: [
            {
              id: "each",
              name: "Each message",
              kind: "for_each",
              over: "{{trigger.messages}}",
              concurrency: 5,
              steps: [
                send(
                  "send",
                  { to: "{{item.to}}", subject: "{{item.subject}}", body: "Hi", total: "1.00" },
                  "continue",
                ),
              ],
            },
          ],
        },
      },
      {
        slug: "ask",
        name: "Ask",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-ask", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "pay",
              name: "Pay now?",
              kind: "person",
              mode: "ask",
              assignee: "client_admin",
              title: "Pay this bill now?",
              timeout: "1 day",
              onTimeout: "stop",
              choices: [
                { value: "now", label: { en: "Pay now", es: "Pagar ya" } },
                { value: "later", label: "Pay on the due date" },
              ],
            },
          ],
        },
      },
    ],
  } satisfies AgentBundleInput);
}

const h = await createApiHarness({ connectors: () => [deskkit] });
afterAll(() => h?.close());

describe.skipIf(!h)("the Desk", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  async function start(workflow: string, input?: unknown) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow,
      ...(input === undefined ? {} : { input }),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    return { runId, params };
  }

  const itemFor = async (type: string) => {
    const items = await H.t.db.select().from(inboxItem);
    const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
    if (!item) throw new Error(`no item for ${type}`);
    return item;
  };
  const eventFor = (type: string) => H.instances.events.filter((e) => e.event.type === type);
  const actionOf = async (itemId: string) => {
    const [a] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.inboxItemId, itemId));
    if (!a) throw new Error("no action");
    return a;
  };
  /** The window passes: the database's clock is ahead of `deliver_after`. */
  const windowPasses = (itemId: string) =>
    H.t.db
      .update(inboxItem)
      .set({ deliverAfter: sql`now() - interval '1 second'` })
      .where(eq(inboxItem.id, itemId));
  const setUndo = async (undoSeconds: number) => {
    const res = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/desk`, {
      undoSeconds,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  };

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit", "deskkit"] } })
      .where(eq(tenant.id, H.A.tenantId));
    const [conn] = await H.t.db
      .insert(connection)
      .values({ tenantId: H.A.tenantId, connector: "deskkit", status: "connected" })
      .returning();
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "mailer",
      bundle: bundle(),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Mail",
    });
    agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { deskkit: conn?.id },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const live = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    expect(live.status, JSON.stringify(live.json)).toBe(200);
    // Activation's test-run check is covered elsewhere; here the agent is simply live.
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    // Changes over 500 USD go to the client user (a signer for now).
    const rules = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/approver-rules`, {
      revision: 0,
      rules: [
        {
          match: { connector: "deskkit", amountOver: { value: "500", currency: "USD" } },
          approver: { kind: "user", userId: H.A.user },
        },
      ],
      reason: "Big sends go to the user",
    });
    expect(rules.status, JSON.stringify(rules.json)).toBe(200);
  });

  it("explains why a change waits, edits it before signing, and holds the approval in its window", async () => {
    const { runId, params } = await start("one");
    let checked = false;
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = await itemFor(type);
      const path = `/api/inbox/${item.id}`;
      // Why it waits: the step, the connection's level, the agent's mode; the default route.
      const list = await H.call(admin("a"), "GET", "/api/inbox");
      expect(forbiddenKeys(list.json)).toEqual([]);
      const card = j(list.json).items.find((i: { id: string }) => i.id === item.id);
      expect(card.payload.whyApproval).toEqual({
        reasons: ["step", "matrix", "mode"],
        route: { source: "default", ruleId: null },
      });
      expect(card.batchKey).toBe(`${runId}:send1`);
      expect(card.deliverAfter).toBeNull();

      // Edits: only editable fields, validated by the tool and the connector, routed again.
      const original = (await actionOf(item.id)).input as Record<string, unknown>;
      const edit = (input: Record<string, unknown>, who = admin("a")) =>
        H.call(who, "PUT", `${path}/edit`, { input });
      const to = await edit({ ...original, to: "someone@else.com" });
      expect(to.status).toBe(422);
      expect(j(to.json).error.code).toBe("not_editable");
      const refused = await edit({ ...original, subject: "REFUSE this" });
      expect(refused.status).toBe(422);
      expect(j(refused.json).error.code).toBe("invalid_input");
      const bad = await edit({ ...original, total: "not money" });
      expect(bad.status).toBe(422);
      const reroute = await edit({ ...original, total: "600.00" });
      expect(reroute.status).toBe(409);
      expect(j(reroute.json).error.code).toBe("reroute");
      expect((await edit({ ...original, subject: "x" }, user("a"))).status).toBe(404);
      const ok = await edit({ ...original, subject: "Your invoice, corrected" });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      const action = await actionOf(item.id);
      expect(action.input).toEqual(original);
      expect(action.editedInput).toMatchObject({ subject: "Your invoice, corrected" });
      const run = await H.call(OPERATOR, "GET", `/api/ops/runs/${runId}`);
      // The run page shows both versions.
      const [opsAction] = j(run.json).actions;
      expect(opsAction.input).toMatchObject({ subject: "Your invoice" });
      expect(opsAction.editedInput).toMatchObject({ subject: "Your invoice, corrected" });
      expect(opsAction.editedBy).toBe(H.A.admin);

      // Approve: held in the undo window, nothing is sent to the run, nothing is written.
      const approved = await H.call(admin("a"), "POST", `${path}/resolve`, { decision: "approve" });
      expect(approved.status, JSON.stringify(approved.json)).toBe(200);
      expect(j(approved.json).item.deliverAfter).not.toBeNull();
      expect(eventFor(type)).toEqual([]);
      const inbox = dbInboxPort(H.db, { ...params, id: runId } as never);
      expect(await inbox.resolution(item.id)).toBeNull();
      const early = await executeAction(runtimeFor(deps()), {
        tenantId: H.A.tenantId,
        actionId: action.id,
      });
      expect(early.status).toBe("awaiting_approval");
      expect(sent.size).toBe(0);
      expect(await redeliverResolutions(deps(), H.A.tenantId, new Date(Date.now() + 61_000)))
        .toMatchObject({ sent: 0 });

      // Undo inside the window: open again, the change proposed again, the undo recorded.
      expect((await H.call(user("a"), "POST", `${path}/undo`)).status).toBe(404);
      const undone = await H.call(admin("a"), "POST", `${path}/undo`);
      expect(undone.status, JSON.stringify(undone.json)).toBe(200);
      expect(j(undone.json).item).toMatchObject({ status: "open", deliverAfter: null });
      expect((await actionOf(item.id)).status).toBe("proposed");
      const [reopened] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, item.id));
      expect((reopened?.payload as { undos?: unknown[] }).undos).toHaveLength(1);
      expect((await H.call(admin("a"), "POST", `${path}/undo`)).status).toBe(409);

      // Approve again and let the window pass: too late to undo; the cron's resume delivers it.
      await H.call(admin("a"), "POST", `${path}/resolve`, { decision: "approve" });
      await windowPasses(item.id);
      const late = await H.call(admin("a"), "POST", `${path}/undo`);
      expect(late.status).toBe(409);
      expect(j(late.json).error.code).toBe("too_late");
      expect(await inbox.resolution(item.id)).toMatchObject({ approved: true });
      expect(await redeliverResolutions(deps(), H.A.tenantId, new Date())).toEqual({
        sent: 1,
        failed: 0,
      });
      const [delivered] = eventFor(type);
      checked = true;
      return delivered?.event.payload;
    });
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(checked).toBe(true);
    // Written once, with the person's edit; the agent's input is kept.
    expect([...sent.values()]).toEqual([
      { to: "pat@example.com", subject: "Your invoice, corrected", total: "10.00" },
    ]);
  });

  it("writes nothing when an approval is undone, and delivers a rejection at once", async () => {
    const before = sent.size;
    const { params } = await start("one");
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = await itemFor(type);
      const path = `/api/inbox/${item.id}`;
      await H.call(admin("a"), "POST", `${path}/resolve`, { decision: "approve" });
      expect((await H.call(admin("a"), "POST", `${path}/undo`)).status).toBe(200);
      const rejected = await H.call(admin("a"), "POST", `${path}/resolve`, { decision: "reject" });
      expect(j(rejected.json).item.deliverAfter).toBeNull();
      const [event] = eventFor(type);
      return event?.event.payload;
    });
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toMatchObject({
      status: "cancelled",
    });
    expect(sent.size).toBe(before);
  });

  it("signs part of a batch in one go, all or nothing", async () => {
    await setUndo(0);
    const before = sent.size;
    const { runId, params } = await start("many", {
      messages: [
        { to: "a@example.com", subject: "A" },
        { to: "b@example.com", subject: "B" },
        { to: "c@example.com", subject: "C" },
      ],
    });
    let signing: Promise<void> | null = null;
    const step = new FakeWorkflowStep(async (_name, type) => {
      signing ??= (async () => {
        // Wait until the loop has proposed all three.
        let open: (typeof inboxItem.$inferSelect)[] = [];
        for (let i = 0; i < 50 && open.length < 3; i++) {
          open = await H.t.db
            .select()
            .from(inboxItem)
            .where(and(eq(inboxItem.runId, runId), eq(inboxItem.status, "open")));
          if (open.length < 3) await new Promise((r) => setTimeout(r, 20));
        }
        expect(open).toHaveLength(3);
        const key = `${runId}:each`;
        expect(new Set(open.map((i) => i.batchKey))).toEqual(new Set([key]));
        const byTo = (to: string) =>
          open.find((i) => (i.payload as { input: { to: string } }).input.to === to)?.id as string;
        const [a, b, c] = [byTo("a@example.com"), byTo("b@example.com"), byTo("c@example.com")];
        const batch = (body: unknown, who = admin("a")) =>
          H.call(who, "POST", "/api/inbox/batch/resolve", body);
        expect((await batch({ batchKey: "other", approve: [a] })).status).toBe(422);
        expect((await batch({ batchKey: key, approve: [a], reject: [a] })).status).toBe(400);
        // All or nothing: one item the person can't sign fails the whole batch.
        await H.t.db
          .update(inboxItem)
          .set({ assigneeRole: "operator" })
          .where(eq(inboxItem.id, c));
        expect((await batch({ batchKey: key, approve: [a, b], reject: [c] })).status).toBe(404);
        await H.t.db
          .update(inboxItem)
          .set({ assigneeRole: "client_admin" })
          .where(eq(inboxItem.id, c));
        const none = await H.t.db
          .select()
          .from(inboxItem)
          .where(and(eq(inboxItem.runId, runId), eq(inboxItem.status, "open")));
        expect(none).toHaveLength(3);
        const res = await batch({ batchKey: key, approve: [a, b], reject: [c], note: "not C" });
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        expect(j(res.json).items.map((i: { status: string }) => i.status)).toEqual([
          "resolved",
          "resolved",
          "resolved",
        ]);
        const keys = await H.t.db
          .select({ key: externalAction.idempotencyKey })
          .from(externalAction)
          .where(eq(externalAction.runId, runId));
        expect(new Set(keys.map((k) => k.key)).size).toBe(3);
      })();
      // Every iteration waits for the one signature of the batch.
      await signing;
      const [event] = eventFor(type);
      return event?.event.payload;
    });
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    const added = [...sent.values()].slice(before).map((s) => s.to).sort();
    expect(added).toEqual(["a@example.com", "b@example.com"]);
    await setUndo(60);
  });

  it("takes one quick answer, and snoozes up to an hour before the due time", async () => {
    const { params } = await start("ask");
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = await itemFor(type);
      const path = `/api/inbox/${item.id}`;
      expect((item.payload as { choices?: unknown[] }).choices).toHaveLength(2);
      // Snooze: cut to an hour before the item is due; out of "waiting", in "snoozed".
      const far = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
      const snoozed = await H.call(admin("a"), "POST", `${path}/snooze`, { until: far });
      expect(snoozed.status, JSON.stringify(snoozed.json)).toBe(200);
      const until = new Date(j(snoozed.json).item.snoozedUntil).getTime();
      expect(until).toBe((item.dueAt as Date).getTime() - 60 * 60_000);
      const past = await H.call(admin("a"), "POST", `${path}/snooze`, {
        until: new Date(Date.now() - 1000).toISOString(),
      });
      expect(past.status).toBe(422);
      const waiting = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items;
      expect(waiting.map((i: { id: string }) => i.id)).not.toContain(item.id);
      const later = j((await H.call(admin("a"), "GET", "/api/inbox?view=snoozed")).json).items;
      expect(later.map((i: { id: string }) => i.id)).toContain(item.id);
      // Quick answers: one of the values, nothing else.
      const wrong = await H.call(admin("a"), "POST", `${path}/resolve`, { answer: "maybe" });
      expect(wrong.status).toBe(422);
      expect(j(wrong.json).error.code).toBe("invalid_answer");
      const right = await H.call(admin("a"), "POST", `${path}/resolve`, { answer: "now" });
      expect(right.status, JSON.stringify(right.json)).toBe(200);
      // An answer is not an approval of a change: delivered at once.
      expect(j(right.json).item.deliverAfter).toBeNull();
      const [event] = eventFor(type);
      return event?.event.payload;
    });
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
  });

  it("lets a viewer see but never sign, and keeps them out of the rules", async () => {
    await H.t.db
      .update(membership)
      .set({ canSign: false })
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, H.A.user)));
    const rule = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/approver-rules`, {
      revision: 1,
      rules: [
        {
          match: { connector: "deskkit" },
          approver: { kind: "user", userId: H.A.user },
        },
      ],
      reason: "try naming a viewer",
    });
    expect(rule.status).toBe(422);
    expect(j(rule.json).error.code).toBe("not_a_signer");

    const team = await H.call(user("a"), "GET", "/api/team");
    expect(team.status, JSON.stringify(team.json)).toBe(200);
    expect(forbiddenKeys(team.json)).toEqual([]);
    const members = j(team.json).members as { userId: string; canSign: boolean; signs: string[] }[];
    const viewer = members.find((m) => m.userId === H.A.user);
    expect(viewer).toMatchObject({ canSign: false, signs: ["Sees everything, signs nothing."] });
    const boss = members.find((m) => m.userId === H.A.admin);
    expect(boss?.signs).toEqual(["Every change no rule sends to someone else."]);
    expect(j(team.json).settings).toEqual({ undoSeconds: 60 });

    const { params } = await start("one");
    const step = new FakeWorkflowStep(async (_name, type) => {
      const item = await itemFor(type);
      // An item named for the viewer (from before they became one): seen, never signed.
      await H.t.db
        .update(inboxItem)
        .set({ assigneeRole: null, assigneeUserId: H.A.user })
        .where(eq(inboxItem.id, item.id));
      const res = await H.call(user("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(res.status).toBe(403);
      expect(j(res.json).error.code).toBe("cannot_sign");
      const batch = await H.call(user("a"), "POST", "/api/inbox/batch/resolve", {
        batchKey: item.batchKey,
        approve: [item.id],
      });
      expect(batch.status).toBe(403);
      expect((await actionOf(item.id)).status).toBe("proposed");
      const snooze = await H.call(user("a"), "POST", `/api/inbox/${item.id}/snooze`, {
        until: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      expect(snooze.status).toBe(403);
      throw Object.assign(new Error("Execution timed out after 1000ms"), {
        name: "WorkflowTimeoutError",
      });
    });
    expect((await executeRun(deps(), params, cloudflareStepRunner(step))).status).toBe(
      "cancelled",
    );
  });

  it("invites a viewer, never a viewer admin, and sets the undo window within its limits", async () => {
    const viewer = await H.call(admin("a"), "POST", "/api/users", {
      email: "viewer@a.example.com",
      role: "client_user",
      canSign: false,
    });
    expect(viewer.status, JSON.stringify(viewer.json)).toBe(200);
    expect(j(viewer.json).member.canSign).toBe(false);
    const adminViewer = await H.call(admin("a"), "POST", "/api/users", {
      email: "boss2@a.example.com",
      role: "client_admin",
      canSign: false,
    });
    expect(adminViewer.status).toBe(422);
    const set = (body: unknown, who = admin("a")) => H.call(who, "PUT", "/api/desk/settings", body);
    expect((await set({ undoSeconds: 120 })).status).toBe(200);
    expect((await set({ undoSeconds: 301 })).status).toBe(400);
    expect((await set({ undoSeconds: 30 }, user("a"))).status).toBe(403);
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    expect((t?.settings as { approvals?: unknown }).approvals).toEqual({ undoSeconds: 120 });
  });
});
