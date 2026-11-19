// QA (input abuse, 2026-11-19): a POC try's input pasted from a PDF carries a NUL character. The
// try route's schema takes it (any JSON under 100,000 characters), the test case insert (jsonb)
// refuses it, and the operator gets a 500 instead of being told what is wrong.
import { build } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "../api.test-helper";
import { MemoryTestSuiteJobs } from "../testbench/instances";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const jobs = new MemoryTestSuiteJobs();
const model = new FakeModel();
const h = await createApiHarness({ llm: model, testSuites: jobs });
afterAll(() => h?.close());

const skillDef = {
  schemaVersion: 1,
  id: "custom:same-item-nul",
  name: "Same item",
  description: "Says whether two descriptions name the same item",
  category: "matching",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Compare the two descriptions.",
  tools: [],
  input: {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
  },
  output: {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  },
};

describe.skipIf(!h)("input abuse: a POC try's input", () => {
  const H = h as ApiHarness;

  it("INPUT-1e refuses a try input with a NUL character with a 400, not a 500", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", { definition: skillDef });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const skillId = (created.json as { skill: { id: string } }).skill.id;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "skill", title: "Same item", phase: "poc", skillId })
      .returning();
    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${row?.id}/tries`, {
      input: { a: "Oak board 2x4\u0000", b: "Oak bd 2x4" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });
});
