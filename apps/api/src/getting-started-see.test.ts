// See it work through the API (docs/setup-plan.md §6; docs/plan.md §1.199, SU4 and SU5): each step
// marked Looks right, or "We do it differently" filed as a request tied to the step; a try on one of
// the client's own documents that is a test run (nothing written, nobody of the client's asked), up
// to three per agent and one at a time, only by someone who can sign; the try in words ("Would …")
// with nothing of ours in it (invariant 11); verdicts, "not right" filed with the run as its source;
// and See it work's lines on the overview.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  agent,
  document,
  externalAction,
  inboxItem,
  issue,
  run as runRow,
  withOperator,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
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

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SEATS = [
  { role: "bill-approver", kind: "signs", label: "Approves bills" },
  { role: "job-codes", kind: "answers", label: "Answers questions about job codes" },
];

/** Starts on a document that arrives: a change (approval on, the seat signs), then a question. */
function bundle(): unknown {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Bill clerk", role: "Bills", mission: "Enter bills." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      permissions: { mode: "suggest_only" },
    },
    people: SEATS,
    workflows: [
      {
        slug: "bills",
        name: "Bills",
        workflow: {
          schemaVersion: 4,
          triggers: [
            {
              id: "t",
              on: {
                type: "event",
                event: "document.received",
                filter: {
                  match: "all",
                  rules: [{ field: "{{trigger.mimeType}}", op: "is", value: "application/pdf" }],
                },
              },
            },
          ],
          steps: [
            {
              id: "update",
              kind: "write",
              name: "Update the record",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "12.00" },
              checks: { approval: { approvers: [{ who: "seat:bill-approver" }] } },
            },
            {
              id: "ask",
              kind: "person",
              name: "Which job?",
              mode: "ask",
              assignee: "seat:job-codes",
              title: "Which job?",
              deadline: { after: "1 day", ifNoAnswer: "skip" },
            },
          ],
        },
      },
    ],
  };
}

const sha = (n: number) => n.toString(16).padStart(64, "0");

describe.skipIf(!h)("See it work", () => {
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
  const docs: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const runs: string[] = [];
  const base = () => `/api/getting-started/agents/${agentId}`;

  async function addDocument(
    tenantId: string,
    filename: string,
    n: number,
    at: string,
    mimeType = "application/pdf",
  ) {
    const [row] = await H.t.db
      .insert(document)
      .values({
        tenantId,
        source: "email",
        storageKey: `${tenantId}/documents/${n}.pdf`,
        mimeType,
        filename,
        sizeBytes: 1000,
        sha256: sha(n),
        status: "stored",
        meta: { email: { from: "ap@northside.example.com", subject: "Bill" } },
        receivedAt: new Date(at),
      })
      .returning({ id: document.id });
    return row?.id as string;
  }

  /** Runs a started try to its end: nobody answers its question, so the try goes past it. */
  async function finish(runId: string) {
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("the try was not started");
    return executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
  }

  it("sets up an agent with a seat filled and documents to try it on", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "see-bills",
      bundle: bundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = j(created.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const users = await H.call(admin("a"), "GET", "/api/users");
    for (const u of j(users.json).users) ids[u.email] = u.userId;
    const seat = await H.call(admin("a"), "PUT", "/api/getting-started/people/bill-approver", {
      userIds: [ids[admin("a")]],
    });
    expect(seat.status, JSON.stringify(seat.json)).toBe(200);

    docs.old = await addDocument(A(), "NL-20930.pdf", 1, "2026-11-18T10:00:00Z");
    docs.new = await addDocument(A(), "NL-20931.pdf", 2, "2026-11-19T10:00:00Z");
    // A photo the trigger's filter doesn't take is never offered.
    docs.photo = await addDocument(A(), "IMG_0001.jpg", 3, "2026-11-20T10:00:00Z", "image/jpeg");
    docs.other = await addDocument(H.B.tenantId, "B-1.pdf", 4, "2026-11-21T10:00:00Z");
  });

  it("lists what it can be tried on, newest first, and who may try", async () => {
    const res = await H.call(admin("a"), "GET", `${base()}/walkthrough`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json);
    expect(view).toMatchObject({
      agentId,
      name: "Bill clerk",
      marks: [],
      tries: { used: 0, max: 3, recent: [] },
      canTry: true,
      canSign: true,
    });
    expect(view.candidates.map((c: { documentId: string }) => c.documentId)).toEqual([
      docs.new,
      docs.old,
    ]);
    expect(view.candidates[0]).toMatchObject({
      title: "NL-20931.pdf",
      from: "ap@northside.example.com",
    });
    expect(forbiddenKeys(res.json)).toEqual([]);
    // Another client sees nothing of it (invariant 1).
    expect((await H.call(admin("b"), "GET", `${base()}/walkthrough`)).status).toBe(404);
  });

  it("puts See it work's lines on the overview", async () => {
    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    const line = j(res.json).agents.find((a: { agentId: string }) => a.agentId === agentId);
    expect(line.left.filter((l: { chapter: string }) => l.chapter === "see")).toEqual([
      { key: "see", chapter: "see", label: "Read how it works", who: null },
      { key: "try", chapter: "see", label: "Try it on a real one", who: null },
    ]);
    const see = j(res.json).chapters.find((c: { key: string }) => c.key === "see");
    expect(see.total).toBeGreaterThanOrEqual(1);
  });

  it("marks a step Looks right, and files a request tied to a step done differently", async () => {
    const ok = await H.call(user("a"), "POST", `${base()}/steps/update`, { ok: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).marks).toEqual([
      expect.objectContaining({ stepId: "update", state: "ok", text: null, request: null }),
    ]);
    const diff = await H.call(user("a"), "POST", `${base()}/steps/ask`, {
      different: "Mark answers job codes, but only on weekdays.",
    });
    expect(diff.status, JSON.stringify(diff.json)).toBe(200);
    const asked = j(diff.json).marks.find((m: { stepId: string }) => m.stepId === "ask");
    expect(asked).toMatchObject({
      state: "asked",
      text: "Mark answers job codes, but only on weekdays.",
      byName: "Client A user",
    });
    expect(asked.request.number).toBeGreaterThan(0);
    const [row] = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(issue).where(eq(issue.id, asked.request.id)),
    );
    expect(row).toMatchObject({ tenantId: A(), agentId, source: "portal" });
    expect(row?.description).toContain("Mark answers job codes, but only on weekdays.");

    // A step the agent doesn't have is not found; a body that is neither is refused.
    expect((await H.call(user("a"), "POST", `${base()}/steps/nope`, { ok: true })).status).toBe(
      404,
    );
    expect((await H.call(user("a"), "POST", `${base()}/steps/update`, { ok: false })).status).toBe(
      400,
    );

    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    const line = j(res.json).agents.find((a: { agentId: string }) => a.agentId === agentId);
    expect(line.left.map((l: { key: string }) => l.key)).not.toContain("see");
    expect(line.left.map((l: { key: string }) => l.key)).toContain("try");
  });

  it("refuses a viewer, and another client's document", async () => {
    await H.call(admin("a"), "PATCH", `/api/users/${ids[user("a")]}`, { canSign: false });
    const viewer = await H.call(user("a"), "POST", `${base()}/try`, { documentId: docs.new });
    expect(viewer.status).toBe(403);
    const read = j((await H.call(user("a"), "GET", `${base()}/walkthrough`)).json);
    expect(read).toMatchObject({ canTry: false, canSign: false });
    // A viewer reads only: no word on a step either.
    expect((await H.call(user("a"), "POST", `${base()}/steps/update`, { ok: true })).status).toBe(
      403,
    );
    await H.call(admin("a"), "PATCH", `/api/users/${ids[user("a")]}`, { canSign: true });

    const theirs = await H.call(admin("a"), "POST", `${base()}/try`, { documentId: docs.other });
    expect(theirs.status).toBe(404);
    const photo = await H.call(admin("a"), "POST", `${base()}/try`, { documentId: docs.photo });
    expect(photo.status).toBe(422);
    expect(j(photo.json).error.code).toBe("cannot_try");
  });

  it("tries it: a test run that writes nothing and asks nobody of the client's", async () => {
    const res = await H.call(user("a"), "POST", `${base()}/try`, { documentId: docs.new });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json).try;
    expect(view).toMatchObject({ title: "NL-20931.pdf", status: "running", steps: [] });
    runs.push(view.runId);
    const [r] = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(runRow).where(eq(runRow.id, view.runId)),
    );
    expect(r).toMatchObject({ mode: "test", agentId, workflowSlug: "bills" });
    expect(r?.trigger).toMatchObject({
      payload: { documentId: docs.new, filename: "NL-20931.pdf" },
    });

    // One at a time.
    const second = await H.call(admin("a"), "POST", `${base()}/try`, { documentId: docs.old });
    expect(second.status).toBe(409);
    expect(j(second.json).error.code).toBe("try_running");

    await finish(view.runId);
    // Nothing written: the record is as it was, and the change was only proposed.
    expect(H.backend.company(H.A.connectionId).get("r1")).toMatchObject({ amount: "10.00" });
    const actions = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(externalAction).where(eq(externalAction.runId, view.runId)),
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.status).not.toBe("done");
      expect(a.executedAt).toBeNull();
    }
    // Nobody of the client's was asked: a test run's items are ours.
    const items = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(inboxItem).where(eq(inboxItem.runId, view.runId)),
    );
    for (const i of items) expect(i.assigneeRole).toBe("operator");
  });

  it("reads the try in words, a write as Would …, with nothing of ours", async () => {
    const res = await H.call(user("a"), "GET", `${base()}/tries/${runs[0]}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = j(res.json).try;
    expect(view.status).toBe("done");
    const update = view.steps.find((s: { id: string }) => s.id === "update");
    expect(update).toMatchObject({
      name: "Update the record",
      state: "done",
      person: true,
      verdict: null,
    });
    expect(update.summary).toMatch(/^Would update the record/);
    expect(update.summary).toContain("(test run, not written). Would ask Client A admin first.");
    const ask = view.steps.find((s: { id: string }) => s.id === "ask");
    expect(ask).toMatchObject({ person: true });
    expect(ask.summary).toContain("Would ask your admin");
    expect(forbiddenKeys(res.json, /cost|token|prompt|model|bundle|instruction/i)).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain("seat:");

    // The walkthrough lists it, newest first; it is the only way the portal shows a test run.
    const walk = j((await H.call(admin("a"), "GET", `${base()}/walkthrough`)).json);
    expect(walk.tries.used).toBe(1);
    expect(walk.tries.recent.map((t: { runId: string }) => t.runId)).toEqual([runs[0]]);
    expect((await H.call(admin("a"), "GET", `/api/runs/${runs[0]}`)).status).toBe(404);
    // A run that isn't one of the agent's tries is not found.
    const stranger = "01a00000-0000-7000-8000-0000000000ff";
    expect((await H.call(admin("a"), "GET", `${base()}/tries/${stranger}`)).status).toBe(404);
  });

  it("keeps verdicts, and files not right with the run as its source", async () => {
    const right = await H.call(user("a"), "POST", `${base()}/tries/${runs[0]}/steps/update`, {
      right: true,
    });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    expect(j(right.json).try.steps.find((s: { id: string }) => s.id === "update").verdict).toBe(
      "right",
    );
    const wrong = await H.call(user("a"), "POST", `${base()}/tries/${runs[0]}/steps/ask`, {
      right: false,
      because: "Freight goes to overhead, so nobody needs asking.",
    });
    expect(wrong.status, JSON.stringify(wrong.json)).toBe(200);
    expect(j(wrong.json).try.steps.find((s: { id: string }) => s.id === "ask").verdict).toBe(
      "not_right",
    );
    const filed = await withOperator(H.db, [A()], (tx) =>
      tx
        .select()
        .from(issue)
        .where(eq(issue.originRunId, runs[0] as string)),
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ tenantId: A(), agentId, source: "portal" });
    expect(filed[0]?.description).toContain("Freight goes to overhead");
    const [a] = await withOperator(H.db, [A()], (tx) =>
      tx.select().from(agent).where(eq(agent.id, agentId)),
    );
    const stored = (a?.stageState as { guide?: { tries?: { verdicts?: unknown }[] } } | undefined)
      ?.guide;
    expect(stored?.tries?.[0]?.verdicts).toMatchObject({
      update: { right: true },
      ask: { right: false, requestId: filed[0]?.id },
    });
    // A step the try doesn't have is not found.
    const none = await H.call(user("a"), "POST", `${base()}/tries/${runs[0]}/steps/nope`, {
      right: true,
    });
    expect(none.status).toBe(404);

    const res = await H.call(admin("a"), "GET", "/api/getting-started");
    const line = j(res.json).agents.find((x: { agentId: string }) => x.agentId === agentId);
    expect(line.left.filter((l: { chapter: string }) => l.chapter === "see")).toEqual([]);
  });

  it("allows three tries per agent", async () => {
    for (const documentId of [docs.old, docs.new]) {
      const res = await H.call(admin("a"), "POST", `${base()}/try`, { documentId });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      runs.push(j(res.json).try.runId);
      await finish(j(res.json).try.runId);
    }
    const fourth = await H.call(admin("a"), "POST", `${base()}/try`, { documentId: docs.new });
    expect(fourth.status).toBe(409);
    expect(j(fourth.json).error.code).toBe("tries_used");
    const walk = j((await H.call(admin("a"), "GET", `${base()}/walkthrough`)).json);
    expect(walk.tries.used).toBe(3);
    expect(walk.canTry).toBe(false);
    expect(walk.tries.recent.map((t: { runId: string }) => t.runId)).toEqual([...runs].reverse());
  });
});
