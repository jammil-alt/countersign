import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient, type LlmCallRecord, LlmToolError, toolInputSchema } from "./client";
import { FakeModel, type FakeTurn } from "./fake";

const Verdict = z.object({
  same: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const tool = {
  name: "record_verdict",
  description: "Record whether two lines match",
  schema: Verdict,
};

function setup(...turns: FakeTurn[]) {
  const model = new FakeModel(turns);
  const records: LlmCallRecord[] = [];
  const llm = createLlmClient({ transport: model, onCall: (r) => void records.push(r) });
  return { model, records, llm };
}

describe("callTool", () => {
  it("returns the validated tool input", async () => {
    const { llm, model, records } = setup({
      toolUse: {
        name: "record_verdict",
        input: { same: true, confidence: 0.9, reason: "same SKU" },
      },
    });
    const { value } = await llm.callTool({
      model: "claude-haiku-5-5",
      system: "Compare the lines.",
      messages: [{ role: "user", content: "A vs B" }],
      tool,
    });
    expect(value).toEqual({ same: true, confidence: 0.9, reason: "same SKU" });

    const sent = model.requests[0];
    expect(sent?.model).toBe("claude-haiku-5-5");
    expect(sent?.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(sent?.tools?.[0]).toMatchObject({ name: "record_verdict" });
    expect(JSON.stringify(sent?.system)).toContain("record_verdict");
    expect(records).toHaveLength(1);
    expect(records[0]?.ok).toBe(true);
  });

  it("throws invalid_input with the issues when the input fails the schema", async () => {
    const { llm, records } = setup({
      toolUse: { name: "record_verdict", input: { same: "yes", confidence: 2 } },
    });
    const error = await llm
      .callTool({ messages: [{ role: "user", content: "A vs B" }], tool })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmToolError);
    const e = error as LlmToolError;
    expect(e.code).toBe("invalid_input");
    expect(e.input).toEqual({ same: "yes", confidence: 2 });
    expect(e.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["same", "confidence", "reason"]),
    );
    // The call was still paid for and recorded.
    expect(records).toHaveLength(1);
    expect(e.result.record.costUsd).not.toBeNull();
  });

  it("throws no_tool_call when the model answers in text", async () => {
    const { llm } = setup({ text: "They look the same to me." });
    await expect(
      llm.callTool({ messages: [{ role: "user", content: "A vs B" }], tool }),
    ).rejects.toMatchObject({ code: "no_tool_call" });
  });

  it("throws refusal on a refusal stop", async () => {
    const { llm } = setup({ refusal: true });
    await expect(
      llm.callTool({ messages: [{ role: "user", content: "A vs B" }], tool }),
    ).rejects.toMatchObject({ code: "refusal" });
  });
});

describe("message", () => {
  it("records a failed call with no cost and rethrows", async () => {
    const { llm, records } = setup({ error: new Error("overloaded") });
    await expect(llm.message({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "overloaded",
    );
    expect(records).toEqual([
      expect.objectContaining({ ok: false, costUsd: null, error: "Error: overloaded" }),
    ]);
  });

  it("defaults the model to Sonnet and carries the label", async () => {
    const { llm, model, records } = setup({ text: "ok" });
    await llm.message({ messages: [{ role: "user", content: "hi" }] }, { label: "skill:x" });
    expect(model.requests[0]?.model).toBe("claude-sonnet-5-5");
    expect(records[0]?.label).toBe("skill:x");
  });
});

describe("toolInputSchema", () => {
  it("is an object schema without $schema", () => {
    const schema = toolInputSchema(Verdict);
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("$schema");
    expect(() => toolInputSchema(z.string())).toThrow(/object/);
  });
});
