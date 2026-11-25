// PLATFORM_QA TOOL-1 (invariant 8, docs/plan.md "approval stays on"): a promotion or a copy into
// another client never carries the client's mode or a loosened approval. stripForPromotion puts
// them back to the base template's, or turns approval on. The API test covers the v3 path end to
// end (apps/api/src/platform-qa-lineage.test.ts); these are the v4 shapes.

import {
  type AgentBundle,
  type ProcessAgentBundle,
  processes,
  toProcessBundle,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, makeBundle, UPDATE_STEP } from "../log/harness.test-helper";
import { stripForPromotion } from "./lineage";
import { convertLookup } from "./skills";

const harness = await createHarness();
afterAll(() => harness?.close());

function writeOf(b: AgentBundle): processes.WriteStep {
  const w = b.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("fixture: expected a process");
  const s = processes.findStep(w, UPDATE_STEP)?.step;
  if (s?.kind !== "write") throw new Error("fixture: expected the write step");
  return s;
}

describe.skipIf(!harness)("(PLATFORM_QA TOOL-1) promotion keeps approval on", () => {
  const h = harness as Harness;
  const v4 = (edit?: (b: ProcessAgentBundle) => void): ProcessAgentBundle => {
    const b = toProcessBundle(makeBundle(), convertLookup(h.catalog, h.tools));
    edit?.(b);
    return b;
  };
  const loosen = (b: ProcessAgentBundle) => {
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

  it("(PLATFORM_QA TOOL-1) turns a v4 write's loosened approval back on when the base is v3, and resets the mode", () => {
    const out = stripForPromotion(v4(loosen), makeBundle(), {});
    expect(out.definition.permissions.mode).toBe("suggest_only");
    const approval = writeOf(out).checks?.approval;
    expect(approval?.required).toBe("required");
    expect(processes.approvalLoosenings(approval, "a")).toEqual([]);
  });

  it("(PLATFORM_QA TOOL-1) puts a v4 write's loosened approval back to the base's", () => {
    const base = v4();
    const out = stripForPromotion(v4(loosen), base, {});
    expect(writeOf(out).checks?.approval).toEqual(writeOf(base).checks?.approval);
  });

  it("(PLATFORM_QA TOOL-1) keeps what the base template itself already had", () => {
    const base = v4(loosen);
    const out = stripForPromotion(v4(loosen), base, {});
    expect(writeOf(out).checks?.approval).toEqual(writeOf(base).checks?.approval);
    expect(out.definition.permissions.mode).toBe("act");
  });

  it("(PLATFORM_QA TOOL-1) suggests only and turns approval on when there is no base", () => {
    const out = stripForPromotion(v4(loosen), null, {});
    expect(out.definition.permissions.mode).toBe("suggest_only");
    expect(processes.approvalLoosenings(writeOf(out).checks?.approval, "a")).toEqual([]);
  });
});
