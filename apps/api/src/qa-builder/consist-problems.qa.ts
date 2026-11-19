// Consistency QA (Agent Builder): one draft, its problems as the build page and the Builder's
// build conversation read them (apps/api/src/build/store.ts `draftFacts`, keyed
// workflow|step|field|code, counted raw by the draft gate) vs as the workflow builder counts them
// (apps/web/src/ops/builder/problems.ts `problemLines`: one step's references to the same later
// step are one problem). Each issue's key must name one issue (core build/issues.ts: "Stable
// across turns"). Fails while they disagree (findings-consist.md, CONS-6). Local Postgres.
import { type BuildDetail, buildIssues } from "@countersign/core";
import { build } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

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
        schemaVersion: 4,
        triggers: [{ id: "t", on: { type: "manual", input: {} } }],
        steps: [
          {
            id: "tell",
            kind: "notify",
            name: "Tell",
            notify: {
              to: ["client_admin"],
              channel: "inbox",
              message:
                "{{steps.ask.output.vendor}} {{steps.ask.output.total}} {{steps.ask.output.number}}",
            },
          },
          {
            id: "ask",
            kind: "person",
            name: "Ask",
            mode: "ask",
            assignee: "client_admin",
            title: "Which vendor?",
            payload: {},
            deadline: { after: "1 day" },
            channel: "inbox",
            onReject: "stop",
          },
        ],
      },
    },
  ],
};

describe.skipIf(!h)(
  "CONS-6: a draft's problems on the build page vs in the workflow builder",
  () => {
    const H = h as NonNullable<typeof h>;

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
      // The draft gate counts each validator error: "The draft has 3 problems to fix."
      expect(detail.gate.reasons).toEqual(["The draft has 3 problems to fix."]);
      // The workflow builder shows the same draft as 1 problem (consist-builder-count.qa.ts in
      // apps/web). Here: the three share one key, so the page renders duplicate React keys and the
      // conversation can't be about one of them (`issueByKey` finds the first).
      const keys = problems.map((p) => p.key);
      expect(new Set(keys).size, `keys: ${JSON.stringify(keys)}`).toBe(problems.length);
      const issueKeys = buildIssues(detail).map((i) => i.key);
      expect(new Set(issueKeys).size, `issue keys: ${JSON.stringify(issueKeys)}`).toBe(
        issueKeys.length,
      );
    });
  },
);
