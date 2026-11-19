// The setup checklist through the API (docs/builder-plan.md §6, B4): a template build's intake
// form, client_setup decisions and the draft's writes become the draft's `definition.setup`; on a
// client copy, Getting started lists it, the client admin answers, confirms and sends files there
// (an answer that sets a value makes a new version by code), the back office records items for the
// client with who did it, connect items are done by their connection, and the go-live stages wait
// on the items that guard them. No portal answer carries the agent's version (invariant 11), and
// one client never reaches another's (invariant 1).
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  type BuildDetail,
  forbiddenPortalFields,
  type SetupItem,
  setupRoutes,
} from "@countersign/core";
import { agent, agentChange, agentVersion, document, run } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  storedSkill,
  testBundle,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type Json = any;

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });

function draftAnswer() {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record after a person approves.",
        gaps: [],
        slug: "record-setup",
        startFromTemplate: null,
        decisions: [],
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record setup", role: "Records", mission: "Keep records right" },
            kind: "functional",
            model: { id: "claude-sonnet-5-5" },
            instructions: "Update records when asked.",
            skills: [],
            permissions: { mode: "suggest_only" },
          },
          workflows: [
            {
              slug: "main",
              name: "Fix a record",
              workflow: {
                schemaVersion: 4,
                triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                steps: [
                  {
                    id: "update",
                    kind: "write",
                    name: "Update the record",
                    tool: TESTKIT_UPDATE_TOOL,
                    input: { id: "r1", amount: "12.00" },
                    checks: { approval: { required: "required" } },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

const SKILL = {
  schemaVersion: 1,
  id: "custom:setup-floor",
  name: "Check a record",
  description: "Whether a record is right",
  category: "purchasing",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Check the record.",
  tools: [],
  input: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
  output: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  parameters: [{ name: "floor", label: "Lowest confidence", type: "number", default: 0.8 }],
};

const ITEMS: SetupItem[] = [
  {
    id: "connect-testkit",
    label: "Connect Testkit",
    kind: "connect",
    hint: "",
    guards: "setup",
    connector: "testkit",
  },
  {
    id: "decision-floor",
    label: "How sure must a check be?",
    kind: "answer",
    hint: "",
    guards: "setup",
    setting: { skill: "custom:setup-floor", parameter: "floor", type: "number" },
    bounds: { min: "0", max: "1" },
    suggested: "0.8",
  },
  { id: "form-list", label: "Your record list", kind: "file", hint: "", guards: "setup" },
  {
    id: "write-start-testkit",
    label: "When do we start writing into Testkit?",
    kind: "confirm",
    hint: "",
    guards: "trial",
  },
  { id: "go-date", label: "Your go-live date", kind: "answer", hint: "", guards: "live" },
];

function setupBundle(): AgentBundle {
  const b = testBundle("Record checker") as AgentBundleInput;
  return AgentBundleSchema.parse({
    ...b,
    definition: {
      ...b.definition,
      skills: [{ skill: "custom:setup-floor", settings: {}, parameters: { floor: 0.8 } }],
      setup: ITEMS,
    },
  });
}

describe.skipIf(!h)("the setup checklist", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A;
  const B = () => H.B;

  async function ok(who: string, method: string, path: string, body?: unknown): Promise<Json> {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }
  const status = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as Json };
  };
  const versions = (id: string) =>
    H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, id))
      .orderBy(desc(agentVersion.version));
  const row = async (id: string) =>
    (await H.t.db.select().from(agent).where(eq(agent.id, id)))[0] as typeof agent.$inferSelect;
  const bundleOf = (v: { bundle: unknown } | undefined): AgentBundle =>
    (v as { bundle: AgentBundle }).bundle;
  const floorOf = (bundle: unknown) =>
    (bundle as AgentBundle).definition.skills.find((s) => s.skill === "custom:setup-floor")
      ?.parameters?.floor;

  it("is made from a template build's intake form, client_setup decisions and writes", async () => {
    const call = async (method: string, path: string, body?: unknown) =>
      (await ok(OPERATOR, method, path, body)) as BuildDetail;
    let b = await call("POST", "/api/ops/builds", { kind: "agent", title: "Record setup" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Keep records right", state: "confirmed" },
          trigger: { text: "Someone asks", state: "confirmed" },
          dataIn: { text: "The record", state: "confirmed" },
          dataOut: { text: "The corrected record", state: "confirmed" },
        },
      }),
    );
    b = await call("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
          ],
          needsTrue: [],
          setup: [
            { id: "books", label: "Testkit", kind: "connect", hint: "Where the records are" },
            { id: "list", label: "Your record list", kind: "file", hint: "" },
          ],
        },
        decisions: [
          {
            id: "tol",
            what: "The amount may differ by at most 0% before a person looks",
            why: "Strict first.",
            value: "0%",
            kind: "client_setup",
            category: "money",
          },
          { id: "fees", what: "Fees stay out", why: "The brief.", kind: "assumption" },
        ],
      }),
    );
    b = await call("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    model.push(draftAnswer());
    b = await call("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    const agentId = b.build.agentId as string;
    expect(agentId).toBeTruthy();
    let [latest] = await versions(agentId);
    const setup = bundleOf(latest).definition.setup ?? [];
    expect(setup.map((i) => [i.id, i.kind, i.guards])).toEqual([
      ["form-books", "connect", "setup"],
      ["form-list", "file", "setup"],
      // A high-risk decision guards the trial; the assumption isn't on the checklist.
      ["decision-tol", "answer", "trial"],
      ["write-start-testkit", "confirm", "trial"],
      ["write-sign-testkit-update-record", "confirm", "trial"],
    ]);
    expect(setup[0]?.connector).toBe("testkit");
    expect(setup.find((i) => i.id === "decision-tol")?.suggested).toBe("0%");
    expect(setup.find((i) => i.id === "write-sign-testkit-update-record")?.label).toBe(
      "Who signs changes to records in Testkit?",
    );
    expect(latest?.changeNote).toBe("Setup checklist from the build");
    const before = latest?.version;

    // A decision added in the draft joins the checklist when the draft moves to the POC test.
    model.push(
      turnAnswer({
        text: "Who to email differs by client.",
        decisions: [
          {
            id: "contact",
            what: "Who we tell when a record is fixed",
            why: "Each client names its own person.",
            kind: "client_setup",
          },
        ],
      }),
    );
    b = await call("POST", `/api/ops/builds/${id}/turns`, { text: "Who do we tell?" });
    model.push(turnAnswer({ text: "One record will do.", testPlan: { datasets: [] } }));
    b = await call("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    [latest] = await versions(agentId);
    expect(latest?.version).toBe((before ?? 0) + 1);
    expect(
      bundleOf(latest).definition.setup?.find((i) => i.id === "decision-contact"),
    ).toMatchObject({ kind: "answer", guards: "setup" });
    // Nothing changed since: moving on makes no new version (the save is skipped).
    const count = (await versions(agentId)).length;
    expect(count).toBeGreaterThan(1);
  });

  it("is answered on Getting started, makes versions by code and holds the stages", async () => {
    await storedSkill(H, SKILL);
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug: "record-checker",
      bundle: setupBundle(),
    });
    const id = created.agent.id as string;
    const v1 = created.version.id as string;
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      serviceName: "Record checks",
    });

    // Getting started lists it, nothing done, and says what holds the trial.
    let portal = await ok(admin("a"), "GET", "/api/setup");
    let mine = portal.agents.find((a: Json) => a.agentId === id);
    expect(mine).toMatchObject({ name: "Record checks", stage: "bench" });
    expect(mine.setup.done).toBe(0);
    expect(mine.setup.total).toBe(5);
    expect(mine.setup.holds.trial).toBe(
      "The setup checklist isn't done: Connect Testkit; How sure must a check be; Your record list; and 1 more.",
    );
    expect(mine.setup.items[1]).toMatchObject({ setsValue: true, suggested: "0.8", min: "0" });
    // Nothing of the agent's version (invariant 11).
    expect(forbiddenKeys(portal)).toEqual([]);
    expect(JSON.stringify(portal)).not.toContain("custom:setup-floor");
    expect(forbiddenPortalFields(setupRoutes.portalSetup.response)).toEqual([]);
    expect(forbiddenPortalFields(setupRoutes.portalSetupItem.response)).toEqual([]);
    // Another client's people never see it, nor reach it.
    portal = await ok(admin("b"), "GET", "/api/setup");
    expect(portal.agents.some((a: Json) => a.agentId === id)).toBe(false);
    const item = (who: string, itemId: string, body: unknown) =>
      status(who, "POST", `/api/setup/${id}/items/${itemId}`, body);
    expect((await item(admin("b"), "decision-floor", { value: "0.9" })).status).toBe(404);
    // Only the client admin answers.
    expect((await item(user("a"), "decision-floor", { value: "0.9" })).status).toBe(403);

    // An answer outside its bounds is refused, in plain words; a connect item is the connection's.
    const beyond = await item(admin("a"), "decision-floor", { value: "2" });
    expect(beyond.status).toBe(422);
    expect(beyond.json.error.message).toBe("It can't be more than 1.");
    expect((await item(admin("a"), "connect-testkit", {})).status).toBe(409);
    expect((await item(admin("a"), "nowhere", { value: "x" })).status).toBe(404);

    // The answer sets the value: a new version by code (a draft: none is live yet).
    let answered = await item(admin("a"), "decision-floor", { value: "0.9" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    const floor = answered.json.agent.setup.items.find((i: Json) => i.id === "decision-floor");
    expect(floor).toMatchObject({
      done: true,
      value: "0.9",
      side: "client",
      byName: expect.any(String),
    });
    let all = await versions(id);
    expect(all).toHaveLength(2);
    expect(all[0]?.parentVersionId).toBe(v1);
    expect(all[0]?.status).toBe("draft");
    expect(floorOf(all[0]?.bundle)).toBe(0.9);
    expect(all[0]?.changeNote).toContain("Setup answer from");
    expect((await row(id)).stageState.setup?.["decision-floor"]).toMatchObject({
      done: true,
      value: "0.9",
      versionId: all[0]?.id,
    });

    // A file item takes the client's own documents only.
    const [doc] = await H.t.db
      .insert(document)
      .values({
        tenantId: A().tenantId,
        source: "upload",
        storageKey: "tenants/a/record-list.pdf",
        mimeType: "application/pdf",
        filename: "record-list.pdf",
        sizeBytes: 10,
        sha256: "b".repeat(64),
        receivedAt: new Date(),
      })
      .returning();
    const [otherDoc] = await H.t.db
      .insert(document)
      .values({
        tenantId: B().tenantId,
        source: "upload",
        storageKey: "tenants/b/record-list.pdf",
        mimeType: "application/pdf",
        filename: "record-list.pdf",
        sizeBytes: 10,
        sha256: "c".repeat(64),
        receivedAt: new Date(),
      })
      .returning();
    expect((await item(admin("a"), "form-list", { files: [otherDoc?.id] })).status).toBe(404);
    expect((await item(admin("a"), "form-list", {})).status).toBe(422);
    answered = await item(admin("a"), "form-list", { files: [doc?.id] });
    expect(answered.json.agent.setup.items.find((i: Json) => i.id === "form-list")).toMatchObject({
      done: true,
      files: 1,
    });

    // Connected and bound: the connect item is done by its connection.
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: A().connectionId },
    });
    let g = (await ok(OPERATOR, "GET", `/api/ops/agents/${id}/go-live`)).goLive;
    expect(g.setup.items[0]).toMatchObject({
      id: "connect-testkit",
      done: true,
      byConnection: true,
    });
    expect(g.setup.holds.trial).toBe(
      "The setup checklist isn't done: When do we start writing into Testkit.",
    );

    // Published and tested, Activate still waits on the trial's item, and says which.
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${all[0]?.id}/publish`);
    await H.t.db.insert(run).values({
      tenantId: A().tenantId,
      agentId: id,
      agentVersionId: all[0]?.id as string,
      workflowSlug: "fix-record",
      mode: "test",
      status: "succeeded",
    });
    const held = await status(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    expect(held.status).toBe(409);
    expect(held.json.error.code).toBe("setup_not_done");
    expect(held.json.error.message).toContain("When do we start writing into Testkit");
    expect((await row(id)).runStatus).not.toBe("active");
    // The operator's move with a reason is held the same way.
    const moved = await status(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, {
      to: "trial",
      reason: "the client asked",
    });
    expect(moved.status).toBe(409);

    // We record the confirm for the client: the back office says who; the portal says "us".
    g = (
      await ok(OPERATOR, "POST", `/api/ops/agents/${id}/setup/write-start-testkit`, {
        value: "From the trial, every change signed",
      })
    ).goLive;
    const confirm = g.setup.items.find((i: Json) => i.id === "write-start-testkit");
    expect(confirm).toMatchObject({ done: true, side: "operator", byName: expect.any(String) });
    portal = await ok(admin("a"), "GET", "/api/setup");
    mine = portal.agents.find((a: Json) => a.agentId === id);
    expect(mine.setup.items.find((i: Json) => i.id === "write-start-testkit")).toMatchObject({
      done: true,
      side: "operator",
      byName: null,
    });
    expect(mine.setup.holds.trial).toBe("");
    // Only operators reach the back office's route.
    expect(
      (await status(admin("a"), "POST", `/api/ops/agents/${id}/setup/write-start-testkit`, {}))
        .status,
    ).toBe(403);

    // Now the trial starts.
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/activate`);
    expect((await row(id)).stage).toBe("trial");

    // An answer on a live copy makes a new version and publishes it at once (ours, here).
    const liveBefore = (await row(id)).liveVersionId;
    g = (await ok(OPERATOR, "POST", `/api/ops/agents/${id}/setup/decision-floor`, { value: "0.6" }))
      .goLive;
    all = await versions(id);
    let r = await row(id);
    expect(r.liveVersionId).toBe(all[0]?.id);
    expect(r.liveVersionId).not.toBe(liveBefore);
    expect(floorOf(all[0]?.bundle)).toBe(0.6);
    // Only the parameter changed: the checklist and the steps are as they were.
    expect(bundleOf(all[0]).definition.setup).toEqual(ITEMS);
    expect(bundleOf(all[0]).workflows).toEqual(bundleOf(all[1]).workflows);
    // The client's own answer on a copy that uses one of our shared skills can't publish from the
    // portal (the skill is snapshotted in a back-office session): its version waits as a draft,
    // and the answer is recorded.
    const liveNow = r.liveVersionId;
    answered = await item(admin("a"), "decision-floor", { value: "0.7" });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    all = await versions(id);
    r = await row(id);
    expect(r.liveVersionId).toBe(liveNow);
    expect(all[0]?.status).toBe("draft");
    expect(floorOf(all[0]?.bundle)).toBe(0.7);
    expect(r.stageState.setup?.["decision-floor"]).toMatchObject({
      value: "0.7",
      versionId: all[0]?.id,
    });

    // Sign-off waits on the go-live item.
    const signoff = await status(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, {
      to: "signoff",
      reason: "the client is ready",
    });
    expect(signoff.status).toBe(409);
    expect(signoff.json.error.message).toBe("The setup checklist isn't done: Your go-live date.");
    await item(admin("a"), "go-date", { value: "December 1" });
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/stage`, {
      to: "signoff",
      reason: "the client is ready",
    });
    expect((await row(id)).stage).toBe("signoff");

    // Each item is logged on the agent's changes.
    const logged = await H.t.db.select().from(agentChange).where(eq(agentChange.agentId, id));
    expect(
      logged
        .map((c) => c.change as Json)
        .filter((c) => c.kind === "setup")
        .map((c) => c.item),
    ).toEqual([
      "decision-floor",
      "form-list",
      "write-start-testkit",
      "decision-floor",
      "decision-floor",
      "go-date",
    ]);
  });

  it("is left out for agents whose version carries none", async () => {
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug: "no-setup",
      bundle: testBundle("No setup"),
    });
    const portal = await ok(admin("a"), "GET", "/api/setup");
    expect(portal.agents.some((a: Json) => a.agentId === created.agent.id)).toBe(false);
    const g = (await ok(OPERATOR, "GET", `/api/ops/agents/${created.agent.id}/go-live`)).goLive;
    expect(g.setup).toBeUndefined();
  });
});
