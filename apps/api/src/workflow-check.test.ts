// One checker (staging, 2026-11-28): the step builder asks the server what would stop its unsaved
// draft publishing (`opsWorkflowCheck`), and the answer is what saving that draft would say,
// because it is the same check (`validateForPublish`, against the version it was edited from).
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  createApiHarness,
  doAction,
  OPERATOR,
  testBundle,
  v5Workflow,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const j = (v: unknown) => v as Json;

describe.skipIf(!h)("checking a workflow's draft", () => {
  const H = h as NonNullable<typeof h>;

  async function template(slug: string) {
    const bundle = testBundle("Records clerk");
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", { slug, bundle });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    return {
      bundle,
      id: j(j(created.json).agent).id as string,
      version: j(j(created.json).version).id as string,
    };
  }

  it("says what a save of it would say, and nothing for a good one", async () => {
    const t = await template("check-records-clerk");
    const good = t.bundle.workflows[0]?.workflow;
    const ok = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.id}/workflow-check`, {
      slug: "fix-record",
      workflow: good,
      parentVersionId: t.version,
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).errors).toEqual([]);

    // Miswired: the change is given nothing it needs, and a Fork's path has no name.
    const miswired = v5Workflow([
      doAction("update", "Update the record", TESTKIT_UPDATE_TOOL, {}),
      {
        id: "pick",
        kind: "fork",
        name: "Which record",
        paths: [{ id: "p1", name: " ", when: { match: "all", rules: [] }, steps: [] }],
        otherwise: { id: "p_else", steps: [] },
      },
    ]);
    const checked = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.id}/workflow-check`, {
      slug: "fix-record",
      workflow: miswired,
      parentVersionId: t.version,
    });
    expect(checked.status, JSON.stringify(checked.json)).toBe(200);
    const errors = j(checked.json).errors as Json[];
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepId: "update", stepCode: "input_missing" }),
        expect.objectContaining({ stepId: "pick", code: "fork_path_unnamed" }),
      ]),
    );
    // Nothing was stored by the check: the template still has only its first version.
    const versions = await H.call(OPERATOR, "GET", `/api/ops/agents/${t.id}`);
    expect((j(versions.json).versions as unknown[]).length).toBe(1);

    // The same draft saved: the same errors.
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.id}/versions`, {
      bundle: {
        ...t.bundle,
        workflows: [{ ...t.bundle.workflows[0], workflow: miswired }],
      },
      parentVersionId: t.version,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).errors).toEqual(errors);
  });

  it("refuses a workflow the step model can't read, and one the version doesn't have", async () => {
    const t = await template("check-records-clerk-2");
    const bad = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.id}/workflow-check`, {
      slug: "fix-record",
      workflow: { schemaVersion: 4, steps: [] },
    });
    expect(bad.status).toBe(422);
    const missing = await H.call(OPERATOR, "POST", `/api/ops/agents/${t.id}/workflow-check`, {
      slug: "no-such-workflow",
      workflow: t.bundle.workflows[0]?.workflow,
    });
    expect(missing.status).toBe(404);
  });

  it("is the operator's only", async () => {
    const t = await template("check-records-clerk-3");
    const res = await H.call(admin("a"), "POST", `/api/ops/agents/${t.id}/workflow-check`, {
      slug: "fix-record",
      workflow: t.bundle.workflows[0]?.workflow,
    });
    expect(res.status).toBe(403);
  });
});
