// A template build made before 2026-11-27 at its client test or QA (docs/plan.md §1.108; the
// Builder QA's STATE-8 was about its client test after a fix). The owner retired the client test:
// a build goes from its draft straight to Publish, so one stored there reads as its draft and is
// published from it. Scripted model answers only.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { agentVersion, build } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const holder = { model: new FakeModel() };
const h = await createApiHarness({
  llm: { create: (req) => holder.model.create(req) },
});
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });
const BRIEF = {
  goal: { text: "Keep records right", state: "confirmed" },
  trigger: { text: "Someone asks", state: "confirmed" },
  dataIn: { text: "The record", state: "confirmed" },
  dataOut: { text: "The corrected record", state: "confirmed" },
};
const ROW = { id: "update", need: "Update the record", verdict: "native", how: "Testkit update" };

function draftAnswer(slug: string) {
  return {
    toolUse: {
      name: "submit_draft",
      input: {
        summary: "It updates the record and asks the client first.",
        gaps: [],
        slug,
        startFromTemplate: null,
        bundle: {
          schemaVersion: 1,
          definition: {
            schemaVersion: 2,
            identity: { name: "Record review", role: "Records", mission: "Keep records right" },
            kind: "functional",
            model: { id: "claude-sonnet-5-5" },
            instructions: "Update records when asked.",
            skills: [],
            permissions: { mode: "suggest_only" },
          },
          workflows: [
            {
              slug: "main",
              name: "Review a record",
              workflow: {
                schemaVersion: 5,
                triggers: [{ id: "t", on: { type: "manual", input: {} } }],
                outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
                steps: [
                  {
                    id: "update",
                    name: "Update the record",
                    checks: { approval: { required: "required" } },
                    kind: "do",
                    doneBy: "rules",
                    uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
                    input: { id: "r1", amount: "12.00" },
                  },
                  { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

describe.skipIf(!h)("a template build made before at its client test", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  };
  const code = (json: unknown) => (json as { error: { code: string } }).error.code;

  beforeEach(() => {
    holder.model = new FakeModel();
  });

  /** A template build drafted through intake and the fit-gap. */
  async function drafted(title: string, slug: string): Promise<BuildDetail> {
    const b = await ok("POST", "/api/ops/builds", { kind: "agent", title });
    const id = b.build.id;
    holder.model.push(turnAnswer({ text: "Got it.", brief: BRIEF }));
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "An agent that fixes records." });
    holder.model.push(
      reviewed(),
      turnAnswer({ text: "As is.", fitgap: { rows: [ROW], needsTrue: [] } }),
    );
    await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    holder.model.push(draftAnswer(slug));
    return ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
  }

  // Owner (2026-11-27): no client test. One stored there reads as its draft and is published
  // from it; the client test's start is refused in plain words.
  it("reads as its draft, refuses the client test and is published from the draft", async () => {
    const d = await drafted("Was at its client test", "was-at-client-test");
    const id = d.build.id;
    await H.t.db
      .update(build)
      .set({ phase: "client_test", testClientId: H.A.tenantId, testAgentId: d.build.agentId })
      .where(eq(build.id, id));
    let b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.build.phase).toBe("draft");
    expect(b.gate).toEqual({ next: null, reasons: [] });
    const refused = await call("POST", `/api/ops/builds/${id}/client-test`, {
      clientId: H.A.tenantId,
    });
    expect(refused.status).toBe(409);
    expect(code(refused.json)).toBe("no_client_test");
    const back = await call("POST", `/api/ops/builds/${id}/phase`, { to: "client_test" });
    expect(code(back.json)).toBe("no_such_phase");

    b = await ok("POST", `/api/ops/builds/${id}/publish`);
    expect(b.build.status).toBe("live");
    expect(b.draft?.live).toBe(true);
    // A template's publish forks nothing into a client (invariant 11).
    const forks = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.basedOnTemplateVersionId, b.draft?.versionId as string));
    expect(forks).toEqual([]);
  });

  it("whose draft was already published at QA is only marked live", async () => {
    const d = await drafted("Was at QA", "was-at-qa");
    const id = d.build.id;
    const templateId = d.build.agentId as string;
    const vid = d.draft?.versionId as string;
    await ok("POST", `/api/ops/agents/${templateId}/versions/${vid}/publish`);
    // As a build from before left it: in QA, still open, its draft live.
    await H.t.db.update(build).set({ phase: "qa", status: "open" }).where(eq(build.id, id));
    const before = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, templateId));
    const b = await ok("POST", `/api/ops/builds/${id}/publish`);
    expect(b.build.status).toBe("live");
    expect(b.draft).toMatchObject({ versionId: vid, live: true });
    const after = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, templateId));
    expect(after).toHaveLength(before.length);
  });
});
