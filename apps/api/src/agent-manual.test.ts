// The agent manual (docs/builder-plan.md §5, B3) through the API, with scripted model answers: a
// build writes the manual into its draft when the draft is made and when it moves to the POC test
// (one new version per move, never per turn), a template's copy carries it, the back office reads
// it with the copy's notes, and the portal reads a view made by code: never the bundle,
// instructions, prompts or cost (invariant 11), what it learned only for the client admin, and
// nothing of another client's.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { type BuildDetail, type ManualView, manualRoutes } from "@countersign/core";
import { memoryNote } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, forbiddenKeys, OPERATOR, user } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const INSTRUCTIONS = "Update records when asked, carefully.";

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
        slug: "record-manual",
        startFromTemplate: null,
        decisions: [
          {
            id: "post",
            what: "The record is updated only after a person approves",
            why: "Writes start strict.",
            kind: "decision_point",
            stepId: "update",
          },
        ],
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record manual", role: "Records", mission: "Keep records right" },
            kind: "functional",
            model: { id: "claude-sonnet-5-5" },
            instructions: INSTRUCTIONS,
            skills: [],
            permissions: { mode: "suggest_only" },
          },
          workflows: [
            {
              slug: "main",
              name: "Review a record",
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

describe.skipIf(!h)("the agent manual", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async <T>(method: string, path: string, body?: unknown, who = OPERATOR) => {
    const res = await H.call(who, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };
  type Versions = { versions: { id: string; version: number; changeNote: string | null }[] };
  const versionsOf = async (agentId: string) =>
    (await ok<Versions>("GET", `/api/ops/agents/${agentId}`)).versions;
  const latestBundle = async (agentId: string) => {
    const vs = await versionsOf(agentId);
    const top = vs.reduce((a, b) => (b.version > a.version ? b : a));
    const one = await ok<{ version: { bundle: { definition: Record<string, unknown> } } }>(
      "GET",
      `/api/ops/agents/${agentId}/versions/${top.id}`,
    );
    return { id: top.id, bundle: one.version.bundle };
  };

  let templateId = "";
  let templateVersion = "";

  it("is written into the draft when it is made, and again on the move to the POC test", async () => {
    let b = await ok<BuildDetail>("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Record manual",
    });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Keep each record right", state: "confirmed" },
          measure: { text: "No record is wrong after a run", state: "confirmed" },
          trigger: { text: "Someone asks", state: "confirmed" },
          dataIn: { text: "The record", state: "confirmed" },
          dataOut: { text: "The corrected record", state: "confirmed" },
        },
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });

    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we do as is, one for later.",
        fitgap: {
          rows: [
            { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" },
            {
              id: "multi",
              need: "Several records in one request",
              verdict: "build",
              how: "A split step",
              later: true,
            },
          ],
          needsTrue: [],
        },
        decisions: [
          {
            id: "freight",
            what: "Freight and fees stay out of the record",
            why: "The brief is about the record's amount.",
            kind: "assumption",
          },
        ],
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });

    model.push(draftAnswer());
    b = await ok<BuildDetail>("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    templateId = b.draft?.agentId as string;
    expect(templateId).toBeTruthy();
    // The Builder's draft, then the manual written into it: one more version.
    let versions = await versionsOf(templateId);
    expect(versions).toHaveLength(2);
    // A template build writes its setup checklist in the same version (B4).
    expect(versions.map((v) => v.changeNote)).toContain(
      "The manual and setup checklist, written from the build",
    );
    let latest = await latestBundle(templateId);
    const manual = latest.bundle.definition.manual as {
      whatItDoes: string;
      decisions: { id: string; risk: string; status: string; stepId?: string }[];
      decisionPoints: { stepId: string | null; decisionId: string | null }[];
      knownRisks: { what: string; detail: string }[];
    };
    expect(manual.whatItDoes).toBe(
      "Keep each record right. Done well means: No record is wrong after a run.",
    );
    expect(manual.decisions.map((d) => [d.id, d.status])).toEqual([
      ["freight", "never_discussed"],
      ["post", "never_discussed"],
    ]);
    // Its risk worked out by code, as the build shows it: the step writes to a client's tool.
    const post = manual.decisions.find((d) => d.id === "post");
    expect(post?.risk).toBe("high");
    expect(manual.decisionPoints).toEqual([
      expect.objectContaining({ stepId: post?.stepId, decisionId: "post" }),
    ]);
    expect(manual.knownRisks).toEqual([
      {
        id: expect.stringContaining("multi"),
        what: "Several records in one request",
        detail: "Not built in this version: when it happens, a person handles it.",
      },
    ]);

    // A turn that records a decision saves no version: the manual is written on the next move.
    model.push(
      turnAnswer({
        text: "Noted.",
        decisions: [{ id: "tax", what: "Tax stays on the record", kind: "assumption" }],
      }),
    );
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Tax stays, right?" });
    expect(await versionsOf(templateId)).toHaveLength(2);

    model.push(turnAnswer({ text: "One record will do.", testPlan: { datasets: [] } }));
    b = await ok<BuildDetail>("POST", `/api/ops/builds/${id}/phase`, { to: "poc" });
    expect(b.build.phase).toBe("poc");
    versions = await versionsOf(templateId);
    expect(versions).toHaveLength(3);
    latest = await latestBundle(templateId);
    templateVersion = latest.id;
    expect(
      (latest.bundle.definition.manual as { decisions: { id: string }[] }).decisions.map(
        (d) => d.id,
      ),
    ).toEqual(["freight", "post", "tax"]);
  });

  it("is read in the back office from the version, with the step names in words", async () => {
    const view = await ok<ManualView>("GET", `/api/ops/agents/${templateId}/manual`);
    expect(view).toMatchObject({ written: true, learned: [] });
    expect(view.howItWorks).toEqual([
      expect.objectContaining({
        name: "Update the record",
        words: "Updates your tools, after a person approves",
      }),
    ]);
    expect(view.decisions.find((d) => d.id === "post")).toMatchObject({
      step: "Update the record",
      statusWords: "Never discussed",
    });
    const v1 = await ok<ManualView>("GET", `/api/ops/agents/${templateId}/manual?version=1`);
    expect(v1.written).toBe(false);
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/manual?version=9`)).status,
    ).toBe(404);
  });

  it("travels with a copy, and the portal reads it made by code, its notes for the admin only", async () => {
    // PLATFORM_QA TOOL-2: only a published template version is forked into a client.
    await ok("POST", `/api/ops/agents/${templateId}/versions/${templateVersion}/publish`);
    const forked = await ok<{ agent: { id: string } }>(
      "POST",
      `/api/ops/templates/${templateId}/fork`,
      { clientId: H.A.tenantId, versionId: templateVersion, slug: "record-manual" },
    );
    const copy = forked.agent.id;
    expect((await latestBundle(copy)).bundle.definition.manual).toBeTruthy();

    // What it learned for this client, live; a test run's note stays out.
    await H.t.db.insert(memoryNote).values([
      { tenantId: H.A.tenantId, agentId: copy, note: "Acme sends two PDFs per bill" },
      { tenantId: H.A.tenantId, agentId: copy, note: "A test note", scope: "test:run" },
    ]);

    const path = buildPathOf(copy);
    const res = await H.call(admin("a"), "GET", path);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const view = res.json as ManualView;
    expect(forbiddenKeys(view)).toEqual([]);
    const text = JSON.stringify(view);
    expect(text).not.toContain(INSTRUCTIONS);
    expect(text).not.toContain("claude-sonnet");
    expect(text).not.toContain("costUsd");
    expect(view.learned.map((n) => n.note)).toEqual(["Acme sends two PDFs per bill"]);
    expect(view.decisions.map((d) => d.id)).toEqual(["freight", "post", "tax"]);
    // The portal never names who on our side looked at a decision.
    expect(view.decisions.every((d) => d.by === null)).toBe(true);
    expect(view.knownRisks.map((r) => r.what)).toEqual(["Several records in one request"]);

    // A client user reads the manual, not what it learned.
    const asUser = (await ok<ManualView>("GET", path, undefined, user("a"))) as ManualView;
    expect(asUser.learned).toEqual([]);
    expect(asUser.decisions).toHaveLength(3);

    // Another client's admin, and a template, are not found.
    expect((await H.call(admin("b"), "GET", path)).status).toBe(404);
    expect((await H.call(admin("a"), "GET", buildPathOf(templateId))).status).toBe(404);

    // The back office reads the copy's notes too.
    const ops = await ok<ManualView>("GET", `/api/ops/agents/${copy}/manual`);
    expect(ops.learned.map((n) => n.note)).toEqual(["Acme sends two PDFs per bill"]);
  });
});

function buildPathOf(id: string): string {
  return manualRoutes.portalAgentManual.path.replace(":id", id);
}
