// A draft's problems on the build page and in the Builder's build conversation
// (apps/api/src/build/store.ts `draftProblems`) count as the workflow builder counts them
// (apps/web/src/ops/builder/problems.ts `problemLines`: one step's references to the same later
// step are one problem, core `groupProblems`), and each has its own key (core build/issues.ts:
// "Stable across turns"). BUILDER_QA CONS-6, PR #441. Local Postgres.
import { type BuildDetail, buildIssues } from "@countersign/core";
import { build } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { draftProblems } from "./build/store";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

/** "Tell" reads three fields of "Ask", which runs after it: three validator errors, one place. */
const outOfOrder = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Vendor check", role: "checks vendors", mission: "Vendors checked." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the process says.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 4, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 5,
        triggers: [{ id: "t", on: { type: "manual", input: {} } }],
        outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
        steps: [
          {
            id: "tell",
            name: "Tell",
            kind: "do",
            doneBy: "rules",
            uses: { type: "tell" },
            tell: {
              to: ["client_admin"],
              channel: "inbox",
              message:
                "{{steps.ask.output.vendor}} {{steps.ask.output.total}} {{steps.ask.output.number}}",
            },
          },
          {
            id: "ask",
            name: "Ask",
            kind: "do",
            doneBy: "person",
            person: {
              mode: "ask",
              who: "client_admin",
              question: "Which vendor?",
              show: {},
              deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
              channel: "inbox",
              onReject: "stop",
            },
          },
          { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
        ],
      },
    },
  ],
};

describe.skipIf(!h)(
  "builds: a draft's problems on the build page and in the workflow builder",
  () => {
    const H = h as NonNullable<typeof h>;

    // BUILDER_QA CONS-6.
    it("each draft problem on the build has its own key", async () => {
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
        slug: "vendor-check",
        bundle: outOfOrder,
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      const agentId = (created.json as { agent: { id: string } }).agent.id;
      const started = await H.call(OPERATOR, "POST", "/api/ops/builds", {
        kind: "agent",
        title: "Vendor check",
        clientId: H.A.tenantId,
      });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      const buildId = (started.json as BuildDetail).build.id;
      await H.t.db.update(build).set({ phase: "draft", agentId }).where(eq(build.id, buildId));

      const res = await H.call(OPERATOR, "GET", `/api/ops/builds/${buildId}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const detail = res.json as BuildDetail;
      const problems = detail.draft?.problems ?? [];
      // Three validator errors, one place: the draft gate counts them as the workflow builder
      // shows them, one problem (apps/web problems.test.ts).
      expect(detail.gate.reasons).toEqual(["The draft has 1 problem to fix."]);
      // Each problem has its own key, so the page has no duplicate React keys and the conversation
      // can be about one of them (`issueByKey`).
      const keys = problems.map((p) => p.key);
      expect(new Set(keys).size, `keys: ${JSON.stringify(keys)}`).toBe(problems.length);
      const issueKeys = buildIssues(detail).map((i) => i.key);
      expect(new Set(issueKeys).size, `issue keys: ${JSON.stringify(issueKeys)}`).toBe(
        issueKeys.length,
      );
    });
  },
);

// BUILDER_QA CONS-6: problems the old key (workflow|step|field|code) can't tell apart.
describe("draftProblems", () => {
  const ref = (expr: string, after: string) => ({
    workflow: "main",
    stepId: "tell",
    field: "notify.message",
    code: "bad_reference",
    message: `{{${expr}}}: step "${after}" does not run before this one on its path`,
  });
  const unknown = (expr: string) => ({
    workflow: "main",
    stepId: "tell",
    field: "notify.message",
    code: "bad_reference",
    message: `{{${expr}}}: unknown reference`,
  });

  it("joins one step's references to the same later step into one problem", () => {
    const out = draftProblems(
      [ref("steps.ask.output.vendor", "ask"), ref("steps.ask.output.total", "ask")],
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe("main|tell|notify.message|bad_reference");
    expect(out[0]?.title).toContain("{{steps.ask.output.vendor}}, {{steps.ask.output.total}}");
  });

  it("gives each problem its own key, keeping the old one for the first", () => {
    const out = draftProblems(
      [
        ref("steps.ask.output.vendor", "ask"),
        ref("steps.check.output.total", "check"),
        unknown("trigger.nope"),
        unknown("trigger.nope"),
      ],
      null,
    );
    expect(out.map((p) => p.key)).toEqual([
      "main|tell|notify.message|bad_reference",
      "main|tell|notify.message|bad_reference|after:check",
      "main|tell|notify.message|bad_reference|trigger.nope",
      "main|tell|notify.message|bad_reference|2",
    ]);
  });
});
