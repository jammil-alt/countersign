// The skills library and the Builder through the API (ARCHITECTURE §9.2, §9.6, §14): operator
// skills are created, versioned, published, rolled back and assigned, shared or for one client;
// the Builder drafts and revises with FakeModel answers that break its rules, and its drafts are
// saved as drafts that keep approvals on.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { type AgentBundle, type Step, walkSteps } from "@countersign/core";
import { inboxItem } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR, OTHER_OPERATOR, testBundle } from "./api.test-helper";

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;

function skillDef(slug: string, over: Json = {}) {
  return {
    schemaVersion: 1,
    id: `custom:${slug}`,
    name: "Summarize records",
    description: "Reads records and writes a short summary",
    category: "writing",
    mode: "agent",
    instructions: "Summarize the records you are given.",
    tools: ["testkit.record.query"],
    input: { type: "object", properties: { about: { type: "string" } } },
    output: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
    settings: [
      { key: "vendors", label: "Vendors", type: "string", default: "", clientSpecific: true },
    ],
    ...over,
  };
}

const stepsOf = (b: AgentBundle) => {
  const out: Step[] = [];
  for (const w of b.workflows) walkSteps(w.workflow, ({ step }) => out.push(step));
  return out;
};

describe.skipIf(!h)("skills library", () => {
  const H = h as NonNullable<typeof h>;

  it("creates, versions, publishes, rolls back and assigns a shared skill", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: skillDef("summarize"),
    });
    expect(created.status).toBe(200);
    const { skill, version } = created.json as { skill: Json; version: Json };
    expect(skill).toMatchObject({
      ref: "custom:summarize",
      source: "shared",
      latestVersion: 1,
      latestStatus: "draft",
      liveVersion: null,
      inputs: ["about"],
      outputs: ["summary"],
      tools: ["testkit.record.query"],
      connectors: ["testkit"],
      usedBy: 0,
    });
    const id = skill.id as string;

    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/skills/${id}/versions/${version.id}/publish`))
        .status,
    ).toBe(200);
    const v2 = await H.call(OPERATOR, "POST", `/api/ops/skills/${id}/versions`, {
      definition: skillDef("summarize", { description: "Writes a two-line summary" }),
      changeNote: "Shorter",
    });
    expect(v2.json).toMatchObject({ version: { version: 2, status: "draft" } });
    const same = await H.call(OPERATOR, "POST", `/api/ops/skills/${id}/versions`, {
      definition: skillDef("summarize", { description: "Writes a two-line summary" }),
    });
    expect(same.status).toBe(409);
    const v2id = (v2.json as { version: Json }).version.id;
    await H.call(OPERATOR, "POST", `/api/ops/skills/${id}/versions/${v2id}/publish`);
    const back = await H.call(OPERATOR, "POST", `/api/ops/skills/${id}/rollback`, {
      versionId: version.id,
    });
    expect(back.json).toMatchObject({ version: { version: 3, status: "live" } });

    // Assign it: a template that uses it is listed, but the library counts client agents only.
    const bundle = testBundle("Summarizer");
    bundle.definition.skills.push({ skill: "custom:summarize", settings: {} });
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "summarizer",
      bundle,
    });
    expect(tpl.status).toBe(200);
    const detail = await H.call(OPERATOR, "GET", `/api/ops/skills/${id}`);
    expect(detail.json).toMatchObject({
      skill: { liveVersion: 3, latestVersion: 3, usedBy: 0, usedByNames: [] },
      usedBy: [{ slug: "summarizer", kind: "template", ref: "custom:summarize" }],
    });
    // Its client copy is the one use, named.
    const tid = (tpl.json as { agent: Json }).agent.id as string;
    const tv1 = (tpl.json as { version: Json }).version.id as string;
    await H.call(OPERATOR, "POST", `/api/ops/agents/${tid}/versions/${tv1}/publish`);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const counted = await H.call(OPERATOR, "GET", `/api/ops/skills/${id}`);
    expect(counted.json).toMatchObject({
      skill: { usedBy: 1, usedByNames: ["Summarizer · Client A"] },
    });
    const versions = (detail.json as { versions: Json[] }).versions;
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [3, "live"],
      [2, "retired"],
      [1, "retired"],
    ]);
  });

  it("keeps a client's own skill to that client and its operators", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      clientId: H.A.tenantId,
      definition: skillDef("vendor-notes", { name: "Vendor notes" }),
    });
    expect(created.json).toMatchObject({
      skill: { source: "client", clientId: H.A.tenantId, clientName: "Client A" },
    });
    const id = (created.json as { skill: Json }).skill.id;
    const list = async (who: string, query = "") =>
      ((await H.call(who, "GET", `/api/ops/skills${query}`)).json as { skills: Json[] }).skills;
    expect((await list(OPERATOR)).some((s) => s.id === id)).toBe(true);
    expect((await list(OPERATOR, `?client=${H.B.tenantId}`)).some((s) => s.id === id)).toBe(false);
    expect((await list(OTHER_OPERATOR)).some((s) => s.id === id)).toBe(false);
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/skills/${id}`)).status).toBe(404);
    // An operator can't write a skill for a client they don't serve.
    const foreign = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      clientId: H.C.tenantId,
      definition: skillDef("x"),
    });
    expect(foreign.status).toBe(404);
  });

  it("refuses skills that aren't agent-mode custom skills over registered tools", async () => {
    const bad = async (definition: Json) =>
      (await H.call(OPERATOR, "POST", "/api/ops/skills", { definition })).status;
    expect(await bad(skillDef("t1", { tools: ["card.charge.query"] }))).toBe(422);
    expect(await bad(skillDef("t2", { mode: "tool", handler: "testkit.record.query" }))).toBe(422);
    expect(await bad(skillDef("t3", { id: "docs.extract" }))).toBe(422);
    expect(await bad({ name: "nothing else" })).toBe(422);
  });

  it("clones a built-in or an operator skill into a new draft, and refuses one that runs code", async () => {
    const library = (await H.call(OPERATOR, "GET", "/api/ops/skills")).json as { skills: Json[] };
    const builtins = library.skills.filter((s) => s.source === "builtin");
    const reasoning = builtins.find((s) => s.mode !== "tool");
    const code = builtins.find((s) => s.mode === "tool");
    if (!reasoning || !code) throw new Error("the harness has no built-in of each kind");

    const first = await H.call(OPERATOR, "POST", `/api/ops/skills/${reasoning.id}/clone`, {});
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const slug = `${String(reasoning.ref).replace(/[^a-z0-9]+/g, "-")}-copy`;
    expect(first.json).toMatchObject({
      skill: {
        ref: `custom:${slug}`,
        name: `${reasoning.name} (copy)`,
        source: "shared",
        mode: reasoning.mode,
        latestStatus: "draft",
        liveVersion: null,
      },
      version: { version: 1, status: "draft", changeNote: `Cloned from ${reasoning.ref}` },
    });
    // A second clone takes the next free slug.
    const second = await H.call(OPERATOR, "POST", `/api/ops/skills/${reasoning.id}/clone`, {});
    expect(second.json).toMatchObject({ skill: { ref: `custom:${slug}-2` } });

    // An operator skill's clone keeps its client, and copies its latest version.
    const own = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      clientId: H.A.tenantId,
      definition: skillDef("clone-me", { name: "Clone me" }),
    });
    const ownId = (own.json as { skill: Json }).skill.id;
    const copy = await H.call(OPERATOR, "POST", `/api/ops/skills/${ownId}/clone`, {});
    expect(copy.json).toMatchObject({
      skill: { ref: "custom:clone-me-copy", source: "client", clientId: H.A.tenantId },
      version: { changeNote: "Cloned from custom:clone-me@1" },
    });
    // Another operator can't reach it, and a code skill isn't cloned.
    expect(
      (await H.call(OTHER_OPERATOR, "POST", `/api/ops/skills/${ownId}/clone`, {})).status,
    ).toBe(404);
    expect((await H.call(OPERATOR, "POST", `/api/ops/skills/${code.id}/clone`, {})).status).toBe(
      422,
    );
    expect((await H.call(OPERATOR, "POST", "/api/ops/skills/no.such.skill/clone", {})).status).toBe(
      404,
    );
  });
});

/** "Flag card charges over $500 missing receipts", with no card connector anywhere. */
function cardChargesAnswer() {
  return {
    summary: "It lists card charges over $500 without a receipt and asks you about each.",
    gaps: ["There is no card feed connector, so it can't read card charges."],
    slug: "card-receipts",
    startFromTemplate: null,
    bundle: {
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Card receipts", role: "Expenses", mission: "Chase missing receipts" },
        kind: "functional",
        model: { id: "claude-sonnet-5-5" },
        instructions: "Find card charges over $500 without receipts.",
        skills: [{ skill: "custom:find-card-charges", settings: {} }],
        permissions: { mode: "act" },
      },
      workflows: [
        {
          slug: "weekly",
          name: "Weekly check",
          workflow: {
            schemaVersion: 3,
            trigger: { id: "t", on: { type: "schedule", cron: "0 9 * * 1" } },
            steps: [
              {
                id: "find",
                kind: "skill",
                name: "Find card charges over $500 without a receipt",
                skill: "custom:find-card-charges",
                input: {},
              },
              {
                id: "ask",
                kind: "person",
                name: "Ask for the receipts",
                mode: "ask",
                assignee: "client_admin",
                title: "Receipts needed for card charges over $500",
                timeout: "3 days",
                onTimeout: "notify_operator",
              },
              {
                id: "note",
                kind: "action",
                name: "Note it on the record",
                tool: TESTKIT_UPDATE_TOOL,
                input: { id: "r1", name: "Receipt asked for" },
                approval: { required: "not_required" },
              },
            ],
          },
        },
      ],
    },
  };
}

describe.skipIf(!h)("the Builder", () => {
  const H = h as NonNullable<typeof h>;
  beforeEach(() => {
    model.requests.length = 0;
  });

  it("drafts a template for card charges, with gaps and approval on", async () => {
    model.push({ toolUse: { name: "submit_draft", input: cardChargesAnswer() } });
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Flag card charges over $500 missing receipts",
    });
    expect(res.status).toBe(200);
    const out = res.json as {
      agent: Json;
      version: Json;
      bundle: AgentBundle;
      gaps: string[];
      notes: string[];
      errors: unknown[];
    };
    expect(out.errors).toEqual([]);
    expect(out.agent).toMatchObject({
      kind: "template",
      slug: "card-receipts",
      liveVersionId: null,
    });
    expect(out.version).toMatchObject({ version: 1, status: "draft", authorType: "builder" });
    expect(out.bundle.definition.permissions.mode).toBe("suggest_only");
    expect(out.gaps).toEqual(
      expect.arrayContaining([
        "There is no card feed connector, so it can't read card charges.",
        expect.stringContaining("custom:find-card-charges"),
      ]),
    );
    const action = stepsOf(out.bundle).find((s) => s.kind === "action");
    expect(action?.kind === "action" && action.approval.required).toBe("required");
    expect(stepsOf(out.bundle).every((s) => /^[0-9a-f-]{36}$/.test(s.id))).toBe(true);
    // It is saved: the agent page opens it.
    const page = await H.call(OPERATOR, "GET", `/api/ops/agents/${out.agent.id}`);
    expect(page.json).toMatchObject({ latest: { status: "draft" } });
  });

  it("drafts a client agent with what that client has connected", async () => {
    model.push({ toolUse: { name: "submit_draft", input: cardChargesAnswer() } });
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Flag card charges over $500 missing receipts",
      clientId: H.A.tenantId,
      name: "Card receipts",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      agent: { kind: "client", tenantId: H.A.tenantId, slug: "card-receipts" },
    });
    const prompt = JSON.stringify(model.requests[0]?.messages);
    expect(prompt).toContain("Client A");
    // A client's draft is checked against its (absent) bindings: the operator binds, not the model.
    expect((res.json as { errors: Json[] }).errors.map((e) => e.code)).toEqual([
      "connection_missing",
    ]);
    expect(
      (
        await H.call(OTHER_OPERATOR, "POST", "/api/ops/agents/draft", {
          description: "x",
          clientId: H.A.tenantId,
        })
      ).status,
    ).toBe(404);
  });

  it("says when the model can't be reached, and refuses an answer it can't use", async () => {
    model.push({ error: new Error("ANTHROPIC_API_KEY is not set") });
    const down = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", { description: "x" });
    expect(down.status).toBe(503);
    model.push({ text: "I would rather chat." });
    const chat = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", { description: "x" });
    expect(chat.status).toBe(422);
    expect(chat.json).toMatchObject({ error: { code: "builder_failed" } });
  });

  it("revises a client agent: 'skip approval for invoices under $200' keeps approval on", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const agentId = (created.json as { agent: Json }).agent.id as string;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const source = (created.json as { version: Json }).version;
    const before = testBundle();
    const update = before.workflows[0]?.workflow.steps[0] as Step;
    const revised = structuredClone(before);
    const wf = revised.workflows[0]?.workflow;
    if (!wf) throw new Error("no workflow");
    wf.steps = [
      {
        id: "small-or-not",
        kind: "fork",
        name: "Invoice under $200?",
        paths: [
          {
            id: "small",
            name: "Under $200",
            when: {
              match: "all",
              rules: [{ field: "{{trigger.amount}}", op: "<", value: 200 }],
            },
            steps: [
              {
                id: "update-small",
                kind: "action",
                name: "Update without approval",
                tool: TESTKIT_UPDATE_TOOL,
                input: { id: "r1", amount: "12.00" },
                approval: { required: "not_required", onReject: "stop" },
              },
            ],
          },
        ],
        otherwise: { id: "big", steps: [update] },
      },
      ...wf.steps.slice(1),
    ];
    model.push({
      toolUse: {
        name: "submit_revision",
        input: {
          summary: "Invoices under $200 are updated without waiting.",
          gaps: [],
          changeNote: "Skip approval under $200",
          bundle: revised,
        },
      },
    });
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/revise`, {
      instruction: "For this client, skip the approval for invoices under $200",
      fromVersionId: source.id,
    });
    expect(res.status).toBe(200);
    const out = res.json as {
      version: Json;
      bundle: AgentBundle;
      errors: unknown[];
      notes: string[];
      diff: { changes: Json[]; labels: Record<string, string> };
    };
    expect(out.errors).toEqual([]);
    expect(out.version).toMatchObject({
      version: 2,
      status: "draft",
      authorType: "builder",
      parentVersionId: source.id,
      changeNote: "Builder: Skip approval under $200",
    });
    const actions = stepsOf(out.bundle).filter((s) => s.kind === "action");
    expect(actions.map((s) => s.kind === "action" && s.approval.required)).toEqual([
      "required",
      "required",
    ]);
    expect(stepsOf(out.bundle).find((s) => s.name === "Update the record")?.id).toBe("update");
    expect(out.notes.join(" ")).toMatch(/Approval stays on/);
    expect(out.diff.changes.length).toBeGreaterThan(0);
    expect(Object.values(out.diff.labels)).toContain("Invoice under $200?");
  });

  it("takes a client's change request as the instruction", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "clerk-b",
      bundle: testBundle(),
    });
    const agentId = (created.json as { agent: Json }).agent.id as string;
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.B.tenantId,
        kind: "change_request",
        title: "Please change the note",
        assigneeRole: "operator",
        payload: { text: "Say 'Record checked' at the end instead." },
      })
      .returning();
    const changed = testBundle();
    const note = changed.workflows[0]?.workflow.steps[2];
    if (note?.kind === "notify") note.message = "Record checked";
    model.push({
      toolUse: {
        name: "submit_revision",
        input: {
          summary: "The note now says Record checked.",
          gaps: [],
          changeNote: "New note",
          bundle: changed,
        },
      },
    });
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/revise`, {
      requestId: item?.id,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("Record checked' at the end");
    // A request of another client can't be handed over.
    const other = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/revise`, {
      requestId: crypto.randomUUID(),
    });
    expect(other.status).toBe(404);
  });
});

describe.skipIf(!h)("discarding drafts", () => {
  const H = h as NonNullable<typeof h>;

  it("discards an unwanted Builder draft, keeps it out of lists, and restores it", async () => {
    model.push({ toolUse: { name: "submit_draft", input: cardChargesAnswer() } });
    const drafted = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Flag card charges over $500 missing receipts",
      name: "Unwanted draft",
    });
    const { agent, version } = drafted.json as { agent: Json; version: Json };
    const listed = async (query = "") =>
      (
        (await H.call(OPERATOR, "GET", `/api/ops/templates${query}`)).json as {
          templates: Json[];
        }
      ).templates.some((t) => t.id === agent.id);
    expect(await listed()).toBe(true);

    const gone = await H.call(OPERATOR, "POST", `/api/ops/agents/${agent.id}/discard`);
    expect(gone.json).toMatchObject({ agent: { status: "disabled" } });
    expect(await listed()).toBe(false);
    expect(await listed("?include=discarded")).toBe(true);
    // It can't be published while discarded; its versions are kept.
    const publish = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agent.id}/versions/${version.id}/publish`,
    );
    expect(publish.status).toBe(409);
    expect((await H.call(OPERATOR, "GET", `/api/ops/agents/${agent.id}`)).json).toMatchObject({
      versions: [{ id: version.id }],
    });
    // The slug stays taken: the next draft of the same name gets another.
    model.push({ toolUse: { name: "submit_draft", input: cardChargesAnswer() } });
    const again = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "x",
      name: "Unwanted draft",
    });
    expect((again.json as { agent: Json }).agent.slug).toBe("unwanted-draft-2");

    const back = await H.call(OPERATOR, "POST", `/api/ops/agents/${agent.id}/restore`);
    expect(back.json).toMatchObject({ agent: { status: "active" } });
    expect(await listed()).toBe(true);
  });

  it("refuses to discard a published agent, and hides a discarded client draft", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "to-discard",
      bundle: testBundle(),
    });
    const id = (created.json as { agent: Json }).agent.id;
    await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/discard`);
    const agents = async (q = "") =>
      (
        (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.B.tenantId}/agents${q}`)).json as {
          agents: Json[];
        }
      ).agents.map((a) => a.slug);
    expect(await agents()).not.toContain("to-discard");
    expect(await agents("?include=discarded")).toContain("to-discard");
    const activation = await H.call(OPERATOR, "GET", `/api/ops/agents/${id}/activation`);
    expect((activation.json as { problems: string[] }).problems).toContain(
      "it was discarded: restore it first",
    );

    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "published-one",
      bundle: testBundle(),
    });
    const t = tpl.json as { agent: Json; version: Json };
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${t.agent.id}/versions/${t.version.id}/publish`,
    );
    const refused = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.agent.id}/discard`);
    expect(refused.status).toBe(409);
  });
});
