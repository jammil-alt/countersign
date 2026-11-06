import { describe, expect, it } from "vitest";
import { decideToolCall } from "./decide";
import { explainWrite, readWhyApproval } from "./explain";

describe("explainWrite", () => {
  it("names the step's default approval and the connection's approval level", () => {
    expect(
      explainWrite({ verb: "create", matrix: undefined, agentMode: "act" }).reasons,
    ).toEqual(["step", "matrix"]);
  });

  it("lists only what asks for a signature", () => {
    const why = explainWrite({
      verb: "update",
      matrix: { update: "auto" },
      stepApproval: "not_required",
      agentMode: "suggest_only",
    });
    expect(why.reasons).toEqual(["mode"]);
  });

  it("names a grant that narrows to approval", () => {
    const why = explainWrite({
      verb: "update",
      matrix: { update: "auto" },
      grant: { verbs: { update: "approval" } },
      stepApproval: "not_required",
      agentMode: "act",
    });
    expect(why.reasons).toEqual(["grant"]);
  });

  it("names the stage apart from the mode, and the route", () => {
    const why = explainWrite({
      verb: "create",
      matrix: { create: "auto" },
      stepApproval: "not_required",
      agentMode: "act",
      stage: "trial",
      person: "approval",
      route: { source: "rule", ruleId: "r1" },
    });
    expect(why).toEqual({
      reasons: ["stage", "person"],
      stage: "trial",
      route: { source: "rule", ruleId: "r1" },
    });
    expect(explainWrite({ verb: "create", matrix: {}, agentMode: "act", stage: "live" }).stage)
      .toBeUndefined();
  });

  it("never changes the gate's decision", () => {
    const input = {
      sideEffect: "external" as const,
      verb: "create" as const,
      matrix: { create: "auto" as const },
      stepApproval: "not_required" as const,
      agentMode: "act" as const,
    };
    const before = decideToolCall(input);
    explainWrite({ ...input, stage: "trial" });
    expect(decideToolCall(input)).toBe(before);
  });

  it("reads back what it stored, and nothing else", () => {
    const why = explainWrite({ verb: "create", matrix: undefined, agentMode: "act" });
    expect(readWhyApproval(JSON.parse(JSON.stringify(why)))).toEqual(why);
    expect(readWhyApproval({ reasons: ["because"] })).toBeNull();
  });
});
