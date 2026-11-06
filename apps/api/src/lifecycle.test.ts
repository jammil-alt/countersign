// Go-live stages, client controls and running a past event live (ARCHITECTURE §10.9, §11.5;
// docs/plan.md §1.36, M13), through the app: Activate starts the trial (or goes live with "no
// writes"), the hourly pass asks the client admin, approve → live and reject → trial again, the
// operator's skips with reasons, the client admin's pauses, Run now, and a past event run live once.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
} from "@countersign/core";
import {
  agent,
  agentChange,
  auditEvent,
  event,
  inboxItem,
  membership,
  run,
  withTenant,
} from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { lifecycleTick } from "./lifecycle/cron";
import { USAGE_SWEEP_MINUTE } from "./runs/dispatch";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type Json = any;

/** A bundle that writes nothing to a client's tool: one notify step. */
function quietBundle(): AgentBundle {
  const b = testBundle("Note taker") as AgentBundleInput;
  return AgentBundleSchema.parse({
    ...b,
    definition: { ...b.definition, extraTools: [] },
    workflows: [
      {
        slug: "note",
        name: "Note",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          steps: [{ id: "n", name: "Note", kind: "notify", channel: "thread", message: "hello" }],
        },
      },
    ],
  });
}

/** testBundle plus a workflow on `document.received` and one the client may run. */
function fullBundle(): AgentBundle {
  const b = testBundle() as AgentBundleInput;
  const update = (id: string) => ({
    id,
    name: "Update",
    kind: "action",
    tool: TESTKIT_UPDATE_TOOL,
    input: { id: "r1", amount: "1.00" },
    approval: { required: "required" },
  });
  return AgentBundleSchema.parse({
    ...b,
    workflows: [
      ...b.workflows,
      {
        slug: "on-doc",
        name: "On a document",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-doc", on: { type: "event", event: "document.received" } },
          steps: [update("u-doc")],
        },
      },
      {
        slug: "client-run",
        name: "Recount",
        workflow: {
          schemaVersion: 3,
          trigger: {
            id: "trg-client",
            on: {
              type: "manual",
              input: {
                type: "object",
                properties: { note: { type: "string", minLength: 1 } },
                required: ["note"],
              },
              client: { canRun: true, label: "Recount the records" },
            },
          },
          steps: [update("u-client")],
        },
      },
    ],
  });
}

describe.skipIf(!h)("go-live stages and client controls", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A;

  async function ok(who: string, method: string, path: string, body?: unknown): Promise<Json> {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }

  /** A client agent of client A, bound, published and test-run: ready for Activate. */
  async function ready(slug: string, bundle: AgentBundle = fullBundle()) {
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug,
      bundle,
    });
    const id = created.agent.id as string;
    const versionId = created.version.id as string;
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: A().connectionId },
      serviceName: slug,
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${versionId}/publish`);
    await H.t.db.insert(run).values({
      tenantId: A().tenantId,
      agentId: id,
      agentVersionId: versionId,
      workflowSlug: "fix-record",
      mode: "test",
      status: "succeeded",
    });
    return { id, versionId };
  }

  const goLive = async (id: string) =>
    (await ok(OPERATOR, "GET", `/api/ops/agents/${id}/go-live`)).goLive;
  const row = async (id: string) =>
    (await H.t.db.select().from(agent).where(eq(agent.id, id)))[0] as typeof agent.$inferSelect;
  const changes = async (id: string) =>
    (
      await H.t.db
        .select()
        .from(agentChange)
        .where(eq(agentChange.agentId, id))
        .orderBy(agentChange.createdAt)
    ).map((c) => c.change as Json);

  /** Finished live runs of the agent, as if they ran. */
  async function liveRuns(id: string, versionId: string, n: number) {
    await H.t.db.insert(run).values(
      Array.from({ length: n }, () => ({
        tenantId: A().tenantId,
        agentId: id,
        agentVersionId: versionId,
        workflowSlug: "fix-record",
        mode: "live" as const,
        status: "succeeded" as const,
      })),
    );
  }

  /** The next tick at minute `minute` after now (the trial's clock runs on real time). */
  const nextTick = (minute: number) => {
    const t = new Date();
    t.setUTCMinutes(minute, 0, 0);
    if (t.getTime() <= Date.now()) t.setTime(t.getTime() + 3_600_000);
    return t;
  };
  const hourly = () => lifecycleTick(H.db, nextTick(USAGE_SWEEP_MINUTE));

  it("a new client agent starts on the bench; Activate starts its trial", async () => {
    const { id } = await ready("trial-agent");
    expect((await goLive(id)).stage).toBe("bench");
    const activated = await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    expect(activated.agent.runStatus).toBe("active");
    const g = await goLive(id);
    expect(g).toMatchObject({
      stage: "trial",
      writes: true,
      trial: { minDays: 14, minRuns: 25, runs: 0, ready: false },
      signoff: null,
    });
    expect((await changes(id)).filter((c) => c.kind === "stage")).toEqual([
      { kind: "stage", from: "bench", to: "trial", reason: null },
    ]);
  });

  it('an agent that writes nothing goes from the bench to live with "no writes"', async () => {
    const { id } = await ready("quiet-agent", quietBundle());
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    const g = await goLive(id);
    expect(g.stage).toBe("live");
    expect(g.writes).toBe(false);
    expect(g.skipped.map((s: Json) => [s.stage, s.reason])).toEqual([
      ["trial", "no writes"],
      ["signoff", "no writes"],
    ]);
    expect((await changes(id)).find((c) => c.kind === "stage")).toMatchObject({
      from: "bench",
      to: "live",
      reason: "no writes",
    });
  });

  it("the trial needs both its minimums; the hourly pass then asks the client admin", async () => {
    const { id, versionId } = await ready("signoff-agent");
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    // Lowered by the operator: logged.
    const set = await ok(OPERATOR, "PUT", `/api/ops/agents/${id}/trial`, {
      minDays: 0,
      minRuns: 3,
    });
    expect(set.goLive.trial).toMatchObject({ minDays: 0, minRuns: 3 });
    expect((await changes(id)).find((c) => c.kind === "trial")).toMatchObject({
      after: { minDays: 0, minRuns: 3 },
    });
    const bad = await H.call(OPERATOR, "PUT", `/api/ops/agents/${id}/trial`, {});
    expect(bad.status).toBe(400);

    await liveRuns(id, versionId, 2);
    await hourly();
    expect((await goLive(id)).stage).toBe("trial");
    // Not on a minute other than the usage sweep's.
    await liveRuns(id, versionId, 1);
    await lifecycleTick(H.db, nextTick((USAGE_SWEEP_MINUTE + 1) % 60));
    expect((await goLive(id)).stage).toBe("trial");
    // Days met (0) and runs met (3): signoff, and the client admin is asked on the Desk.
    await hourly();
    const g = await goLive(id);
    expect(g.stage).toBe("signoff");
    expect(g.signoff).toMatchObject({ status: "open", summary: { runs: 3, succeeded: 3 } });

    const inbox = await ok(admin("a"), "GET", "/api/inbox");
    const item = inbox.items.find((i: Json) => i.id === g.signoff.inboxItemId);
    expect(item).toMatchObject({ kind: "approval", title: "signoff-agent going live" });
    expect(item.payload.goLive.text).toMatch(/^In its trial: 3 runs \(0 failed\)/);
    expect(forbiddenKeys(inbox)).toEqual([]);
    // A client user isn't asked.
    const userInbox = await ok(user("a"), "GET", "/api/inbox");
    expect(userInbox.items.find((i: Json) => i.id === item.id)).toBeUndefined();
    // A second pass asks nothing more.
    await hourly();
    const open = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.agentId, id), eq(inboxItem.subjectType, "go_live")));
    expect(open).toHaveLength(1);

    // Rejected: back to trial with a new start, the reason kept and posted to the client's lead.
    await ok(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
      decision: "reject",
      note: "It missed two vendor credits",
    });
    const back = await goLive(id);
    expect(back.stage).toBe("trial");
    expect(back.trial).toMatchObject({ minDays: 0, minRuns: 3, runs: 0 });
    expect(back.rejections.map((r: Json) => r.reason)).toEqual(["It missed two vendor credits"]);
    // An operator note in the lead thread, from the client admin who rejected; no review item.
    const lead = await ok(OPERATOR, "GET", `/api/ops/clients/${A().tenantId}/threads?subject=lead`);
    const leadId = lead.threads[0].id as string;
    const notes = (await ok(OPERATOR, "GET", `/api/ops/threads/${leadId}/messages`)).messages;
    const note = notes.find(
      (m: Json) => m.text === "Kept Records clerk in trial: It missed two vendor credits",
    );
    expect(note).toMatchObject({
      audience: "operator",
      sender: { type: "user", id: A().admin },
      sources: [item.id],
    });
    const posted = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "thread.message_posted"), eq(event.subjectId, leadId)));
    expect(posted.map((e) => (e.payload as Json).messageId)).toContain(note.id);
    // The client doesn't see the note meant for the lead.
    const portalLead = await ok(admin("a"), "GET", "/api/threads?subject=lead");
    const portalNotes = await ok(
      admin("a"),
      "GET",
      `/api/threads/${portalLead.threads[0].id}/messages`,
    );
    expect(portalNotes.messages.map((m: Json) => m.id)).not.toContain(note.id);
    const opsItems = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.agentId, id), eq(inboxItem.subjectType, "go_live_rejected")));
    expect(opsItems).toHaveLength(0);

    // Runs again since the new start, asked again, approved: live.
    await liveRuns(id, versionId, 3);
    await hourly();
    const again = await goLive(id);
    expect(again.stage).toBe("signoff");
    await ok(admin("a"), "POST", `/api/inbox/${again.signoff.inboxItemId}/resolve`, {
      decision: "approve",
    });
    expect((await goLive(id)).stage).toBe("live");
    expect(
      (await changes(id)).filter((c) => c.kind === "stage").map((c) => `${c.from}→${c.to}`),
    ).toEqual(["bench→trial", "trial→signoff", "signoff→trial", "trial→signoff", "signoff→live"]);
  });

  it("the operator skips forward only with a reason, logged; moving back needs none", async () => {
    const { id } = await ready("skip-agent");
    // Leaving the bench is starting it: the activation check holds there too.
    const noReason = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, { to: "live" });
    expect(noReason.status).toBe(422);
    expect((noReason.json as Json).error.code).toBe("reason_required");
    const skipped = await ok(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, {
      to: "live",
      reason: "The owner ran it with us for a month",
    });
    expect(skipped.goLive.stage).toBe("live");
    expect(skipped.goLive.skipped.map((s: Json) => s.stage)).toEqual(["trial", "signoff"]);
    expect((await row(id)).runStatus).toBe("active");
    const audit = await withTenant(H.db, A().tenantId, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, A().tenantId), eq(auditEvent.action, "agent.stage")))
        .orderBy(desc(auditEvent.createdAt)),
    ).catch(() =>
      H.t.db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, A().tenantId), eq(auditEvent.action, "agent.stage")))
        .orderBy(desc(auditEvent.createdAt)),
    );
    expect(audit[0]?.target).toMatchObject({ agent: id, from: "bench", to: "live" });

    // Back to signoff: asks the client admin; back to the bench: only test runs again.
    const signoff = await ok(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, { to: "signoff" });
    expect(signoff.goLive.signoff).toMatchObject({ status: "open" });
    const bench = await ok(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, { to: "bench" });
    expect(bench.goLive.stage).toBe("bench");
    expect((await row(id)).runStatus).toBe("testing");
    // The sign-off it no longer waits for is expired.
    const [asked] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, signoff.goLive.signoff.inboxItemId));
    expect(asked?.status).toBe("expired");
  });

  it("the client admin pauses with a reason and resumes; pause all leaves the account agent on", async () => {
    const one = await ready("pause-one");
    const two = await ready("pause-two");
    const sloan = await ready("supervisor", quietBundle());
    for (const a of [one, two, sloan])
      await ok(OPERATOR, "POST", `/api/ops/agents/${a.id}/activate`);

    const noReason = await H.call(admin("a"), "POST", `/api/services/${one.id}/pause`, {
      reason: "",
    });
    expect(noReason.status).toBe(400);
    const tooLong = await H.call(admin("a"), "POST", `/api/services/${one.id}/pause`, {
      reason: "Close",
      until: new Date(Date.now() + 100 * 86_400_000).toISOString(),
    });
    expect(tooLong.status).toBe(422);
    const asUser = await H.call(user("a"), "POST", `/api/services/${one.id}/pause`, {
      reason: "Close",
    });
    expect(asUser.status).toBe(403);

    const all = await ok(admin("a"), "POST", "/api/services/pause-all", {
      reason: "Month-end close",
    });
    const byId = new Map(all.services.map((s: Json) => [s.id, s]));
    expect(byId.get(one.id)).toMatchObject({
      status: "paused",
      pause: { side: "client", reason: "Month-end close", canResume: true },
    });
    expect(byId.get(sloan.id)).toMatchObject({ status: "active", pause: null, accountAgent: true });
    expect((await row(one.id)).pause).toMatchObject({ side: "client", all: true });
    expect((await changes(one.id)).find((c) => c.kind === "pause")).toMatchObject({
      side: "client",
      reason: "Month-end close",
    });

    const resumed = await ok(admin("a"), "POST", `/api/services/${one.id}/resume`);
    expect(resumed.service).toMatchObject({ status: "active", pause: null });
    await ok(admin("a"), "POST", "/api/services/resume-all");
    expect((await row(two.id)).runStatus).toBe("active");

    // The operator's pause is the operator's: the client can't lift it; the operator can.
    await ok(OPERATOR, "POST", `/api/ops/agents/${two.id}/pause`);
    expect((await row(two.id)).pause).toMatchObject({ side: "operator" });
    const lift = await H.call(admin("a"), "POST", `/api/services/${two.id}/resume`);
    expect(lift.status).toBe(403);
    const controls = await ok(admin("a"), "GET", "/api/controls");
    expect(controls.services.find((s: Json) => s.id === two.id).pause).toMatchObject({
      side: "operator",
      canResume: false,
    });
    const opsView = await goLive(two.id);
    expect(opsView.pause).toMatchObject({ side: "operator" });
    await ok(OPERATOR, "POST", `/api/ops/agents/${two.id}/activate`);
    expect(await row(two.id)).toMatchObject({ runStatus: "active", pause: null, stage: "trial" });

    // A pause with an end resumes on the minute cron once it has passed.
    const until = new Date(Date.now() + 3_600_000);
    await ok(admin("a"), "POST", `/api/services/${one.id}/pause`, {
      reason: "Back in an hour",
      until: until.toISOString(),
    });
    await lifecycleTick(H.db, new Date(until.getTime() - 60_000));
    expect((await row(one.id)).runStatus).toBe("paused");
    await lifecycleTick(H.db, new Date(until.getTime() + 60_000));
    expect(await row(one.id)).toMatchObject({ runStatus: "active", pause: null });
    // Another client's admin can't touch it.
    const other = await H.call(admin("b"), "POST", `/api/services/${one.id}/pause`, {
      reason: "x",
    });
    expect(other.status).toBe(404);
  });

  it("Run now starts a client-runnable workflow with a valid form, for signers, in a running stage", async () => {
    const { id } = await ready("run-now");
    // On the bench: no forms, and nothing starts.
    expect((await ok(admin("a"), "GET", `/api/services/${id}/run-forms`)).forms).toEqual([]);
    const bench = await H.call(admin("a"), "POST", `/api/services/${id}/workflows/client-run/run`, {
      input: { note: "now" },
    });
    expect([bench.status, (bench.json as Json).error.code]).toEqual([409, "not_live"]);

    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    const forms = (await ok(user("a"), "GET", `/api/services/${id}/run-forms`)).forms;
    expect(forms).toEqual([
      expect.objectContaining({ workflow: "client-run", label: "Recount the records" }),
    ]);
    const invalid = await H.call(
      admin("a"),
      "POST",
      `/api/services/${id}/workflows/client-run/run`,
      {
        input: { note: "" },
      },
    );
    expect([invalid.status, (invalid.json as Json).error.code]).toEqual([422, "invalid_input"]);
    // A workflow the client may not start is not there.
    const operatorOnly = await H.call(
      admin("a"),
      "POST",
      `/api/services/${id}/workflows/fix-record/run`,
      {},
    );
    expect(operatorOnly.status).toBe(404);

    const started = await ok(user("a"), "POST", `/api/services/${id}/workflows/client-run/run`, {
      input: { note: "after the delivery" },
    });
    const [r] = await H.t.db.select().from(run).where(eq(run.id, started.runId));
    expect(r).toMatchObject({ mode: "live", workflowSlug: "client-run" });
    expect(r?.trigger).toMatchObject({ type: "manual", startedBy: { userId: A().user } });
    expect(H.instances.started.has(started.runId)).toBe(true);

    const otherClient = await H.call(admin("b"), "GET", `/api/services/${id}/run-forms`);
    expect(otherClient.status).toBe(404);

    // A viewer (membership.can_sign false) sees the forms but starts nothing, like on the Desk.
    const signs = (canSign: boolean) =>
      H.t.db
        .update(membership)
        .set({ canSign })
        .where(and(eq(membership.tenantId, A().tenantId), eq(membership.userId, A().user)));
    await signs(false);
    try {
      expect((await ok(user("a"), "GET", `/api/services/${id}/run-forms`)).forms).toHaveLength(1);
      const viewer = await H.call(
        user("a"),
        "POST",
        `/api/services/${id}/workflows/client-run/run`,
        { input: { note: "from a viewer" } },
      );
      expect([viewer.status, (viewer.json as Json).error.code]).toEqual([403, "cannot_sign"]);
      const runs = await H.t.db.select().from(run).where(eq(run.agentId, id));
      expect(runs.filter((x) => x.workflowSlug === "client-run")).toHaveLength(1);
    } finally {
      await signs(true);
    }
  });

  it("runs a past event live once, never on the bench and never a test run's event", async () => {
    const { id } = await ready("past-event");
    const [e] = await H.t.db
      .insert(event)
      .values({ tenantId: A().tenantId, type: "document.received", payload: { filename: "a.pdf" } })
      .returning();
    const [testEvent] = await H.t.db
      .insert(event)
      .values({
        tenantId: A().tenantId,
        type: "document.received",
        payload: { runId: (await H.t.db.select().from(run).where(eq(run.agentId, id)))[0]?.id },
      })
      .returning();
    if (!e || !testEvent) throw new Error("no event");

    const onBench = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run-event`, {
      eventId: e.id,
    });
    expect([onBench.status, (onBench.json as Json).error.code]).toEqual([409, "not_live"]);

    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    const fromTest = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run-event`, {
      eventId: testEvent.id,
    });
    expect([fromTest.status, (fromTest.json as Json).error.code]).toEqual([422, "test_event"]);

    const res = await ok(OPERATOR, "POST", `/api/ops/agents/${id}/run-event`, { eventId: e.id });
    expect(res.runs.map((r: Json) => r.workflow)).toEqual(["on-doc"]);
    const [r] = await H.t.db.select().from(run).where(eq(run.id, res.runs[0].runId));
    expect(r).toMatchObject({ mode: "live", agentId: id });
    expect(r?.trigger).toMatchObject({ type: "event", eventId: e.id });
    expect((await changes(id)).find((c) => c.kind === "run_event")).toMatchObject({
      eventId: e.id,
      runIds: [res.runs[0].runId],
    });

    const again = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run-event`, {
      eventId: e.id,
    });
    expect([again.status, (again.json as Json).error.code]).toEqual([409, "already_ran"]);
    // Client roles never reach it (contract.test.ts checks every /api/ops route too).
    const asClient = await H.call(admin("a"), "POST", `/api/ops/agents/${id}/run-event`, {
      eventId: e.id,
    });
    expect(asClient.status).toBe(403);
  });
});
