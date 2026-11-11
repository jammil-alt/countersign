import { describe, expect, it } from "vitest";
import { clientStepData, stepDocumentIds } from "./step-data";

describe("clientStepData", () => {
  it("keeps business data and drops prompts, models, cost and secrets at any depth", () => {
    const out = clientStepData({
      bill: { number: "20418", total: "1250.0000", lines: [{ sku: "MDF-18", costUsd: "0.01" }] },
      instructions: "Read the bill",
      prompt: "You are…",
      model: "claude-x",
      models: ["claude-x"],
      tokensIn: 120,
      nested: { systemPrompt: "x", accessToken: "secret", note: "Matched by SKU" },
    });
    expect(out).toEqual({
      bill: { number: "20418", total: "1250.0000", lines: [{ sku: "MDF-18" }] },
      nested: { note: "Matched by SKU" },
    });
  });

  it("is undefined when nothing is left", () => {
    expect(clientStepData(null)).toBeUndefined();
    expect(clientStepData({ prompt: "x" })).toBeUndefined();
    expect(clientStepData("Done")).toBe("Done");
    expect(clientStepData([{ cost: 1 }, 2])).toEqual([null, 2]);
  });
});

describe("stepDocumentIds", () => {
  it("finds documentId and documentIds once each, in order", () => {
    expect(
      stepDocumentIds(
        { documentId: "d1", bill: { documentIds: ["d2", "d1"] } },
        { unextractedDocumentIds: ["d9"], items: [{ documentId: "d3" }] },
      ),
    ).toEqual(["d1", "d2", "d3"]);
    expect(stepDocumentIds(null, "x", [])).toEqual([]);
  });
});
