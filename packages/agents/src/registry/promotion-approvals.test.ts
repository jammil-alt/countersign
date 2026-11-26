// PLATFORM_QA TOOL-1 (invariant 8, docs/plan.md "approval stays on"): a promotion or a copy into
// another client never carries the client's mode or a loosened approval. stripForPromotion puts
// them back to the base template's, or turns approval on. The API test covers it end to end
// (apps/api/src/platform-qa-lineage.test.ts); these are the step shapes.

import { type AgentBundle, cloneJson, processes, steps } from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, makeBundle, UPDATE_STEP } from "../log/harness.test-helper";
import { stripForPromotion } from "./lineage";

const harness = await createHarness();
afterAll(() => harness?.close());

function writeOf(b: AgentBundle): steps.DoStep {
  const w = b.workflows[0]?.workflow;
  const s = w ? steps.findStep(w.steps, UPDATE_STEP) : undefined;
  if (s?.kind !== "do") throw new Error("fixture: expected the write step");
  return s;
}

const REQUIRED = {
  required: "required",
  mode: "in_turn",
  ifNoAnswer: "stop",
  onReject: "stop",
} as const;

describe.skipIf(!harness)("(PLATFORM_QA TOOL-1) promotion keeps approval on", () => {
  const bundle = (edit?: (b: AgentBundle) => void): AgentBundle => {
    const b = cloneJson(makeBundle()) as AgentBundle;
    edit?.(b);
    return b;
  };
  const loosen = (b: AgentBundle) => {
    b.definition.permissions.mode = "act";
    const w = writeOf(b);
    w.checks = {
      ...w.checks,
      approval: {
        required: "not_required",
        mode: "in_turn",
        ifNoAnswer: "proceed",
        onReject: "stop",
      },
    };
  };
  const withApproval = (b: AgentBundle) => {
    const w = writeOf(b);
    w.checks = { ...w.checks, approval: { ...REQUIRED } };
  };

  it("(PLATFORM_QA TOOL-1) turns a write's loosened approval back on when the base has none, and resets the mode", () => {
    const out = stripForPromotion(bundle(loosen), bundle(), {});
    expect(out.definition.permissions.mode).toBe("suggest_only");
    const approval = writeOf(out).checks?.approval;
    expect(approval?.required).toBe("required");
    expect(processes.approvalLoosenings(approval, "a")).toEqual([]);
  });

  it("(PLATFORM_QA TOOL-1) puts a write's loosened approval back to the base's", () => {
    const base = bundle(withApproval);
    const out = stripForPromotion(bundle(loosen), base, {});
    expect(writeOf(out).checks?.approval).toEqual(writeOf(base).checks?.approval);
  });

  it("(PLATFORM_QA TOOL-1) keeps what the base template itself already had", () => {
    const base = bundle(loosen);
    const out = stripForPromotion(bundle(loosen), base, {});
    expect(writeOf(out).checks?.approval).toEqual(writeOf(base).checks?.approval);
    expect(out.definition.permissions.mode).toBe("act");
  });

  it("(PLATFORM_QA TOOL-1) suggests only and turns approval on when there is no base", () => {
    const out = stripForPromotion(bundle(loosen), null, {});
    expect(out.definition.permissions.mode).toBe("suggest_only");
    expect(processes.approvalLoosenings(writeOf(out).checks?.approval, "a")).toEqual([]);
  });
});
