// §1.210: the Builder's drafts and revisions, and Builder calls that fail, each leave a cost row:
// the back office's (ours), recorded once the request ends, so a failure that rolls the request
// back still keeps what its calls cost. Usage shows them under the Builder. Scripted model
// answers only.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { meteredUsage, withOperator } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const draft = (slug: string) => ({
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It answers.",
      gaps: [],
      slug,
      startFromTemplate: null,
      decisions: [],
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "Metered", role: "Records", mission: "Keep records right" },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Answer.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "main",
            name: "Answer",
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
  usage: { input: 2000, output: 500, cacheRead: 300 },
});

describe.skipIf(!h)("the Builder's cost", () => {
  const H = h as NonNullable<typeof h>;
  const builderRows = () =>
    withOperator(H.db, [], (tx) =>
      tx
        .select()
        .from(meteredUsage)
        .where(and(eq(meteredUsage.source, "builder"), isNull(meteredUsage.tenantId))),
    );

  it("records a draft's calls as ours", async () => {
    const before = (await builderRows()).length;
    model.push(draft("metered-draft"));
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "An agent that answers.",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    const rows = await builderRows();
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1);
    expect(row).toMatchObject({
      measure: "model",
      ours: true,
      tokensIn: 2000,
      tokensOut: 500,
      cacheReadTokens: 300,
    });
    expect(Number(row?.costUsd)).toBeGreaterThan(0);
  });

  it("records a failed draft's calls, though the request failed", async () => {
    const before = (await builderRows()).length;
    // Two answers that don't fit the schema: the repair fails too, and nothing is saved.
    const bad = {
      toolUse: { name: "submit_draft", input: { summary: 1 } },
      usage: { input: 900 },
    };
    model.push(bad, bad);
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "An agent that answers.",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await H.settle();
    const rows = await builderRows();
    expect(rows.length).toBe(before + 2);
    expect(rows.slice(-2).every((r) => r.tokensIn === 900 && Number(r.costUsd) > 0)).toBe(true);
    expect(model.remaining).toBe(0);

    // Usage counts them under the Builder, with their tokens.
    const today = new Date().toISOString().slice(0, 10);
    const report = (await H.call(OPERATOR, "GET", `/api/ops/usage?from=${today}&to=${today}`))
      .json as { backOffice: { total: { tokensIn: number }; lines: { id: string }[] } };
    expect(report.backOffice.lines.map((l) => l.id)).toContain("builder");
    expect(report.backOffice.total.tokensIn).toBeGreaterThanOrEqual(2000 + 300 + 900 * 2);
  });
});
