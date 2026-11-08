import { describe, expect, it } from "vitest";
import { canSkipApproval, decideToolCall, decideWrite, loosenedVerbs } from "./decide";

describe("decideWrite truth table (update)", () => {
  // level × step approval × agent mode → decision. Approval whenever any of them says so.
  const table = [
    ["auto", "not_required", "act", "run"],
    ["auto", "not_required", "suggest_only", "approval"],
    ["auto", "required", "act", "approval"],
    ["auto", "required", "suggest_only", "approval"],
    ["auto", undefined, "act", "approval"],
    ["auto", undefined, "suggest_only", "approval"],
    ["approval", "not_required", "act", "approval"],
    ["approval", "not_required", "suggest_only", "approval"],
    ["approval", "required", "act", "approval"],
    ["approval", "required", "suggest_only", "approval"],
    ["approval", undefined, "act", "approval"],
    ["approval", undefined, "suggest_only", "approval"],
    ["off", "not_required", "act", "refused"],
    ["off", "not_required", "suggest_only", "refused"],
    ["off", "required", "act", "refused"],
    ["off", "required", "suggest_only", "refused"],
    ["off", undefined, "act", "refused"],
    ["off", undefined, "suggest_only", "refused"],
  ] as const;

  it.each(table)("connection %s, step %s, agent %s → %s", (level, step, mode, expected) => {
    expect(
      decideWrite({
        verb: "update",
        matrix: { update: level },
        stepApproval: step,
        agentMode: mode,
      }),
    ).toBe(expected);
  });
});

describe("decideWrite across verbs", () => {
  it("runs reads unless the connection turns them off", () => {
    expect(decideWrite({ verb: "read", matrix: {}, agentMode: "suggest_only" })).toBe("run");
    expect(
      decideWrite({ verb: "read", matrix: { read: "approval" }, agentMode: "suggest_only" }),
    ).toBe("run");
    expect(decideWrite({ verb: "read", matrix: { read: "off" }, agentMode: "act" })).toBe(
      "refused",
    );
  });

  it("uses the defaults: create/update approval, delete off", () => {
    const allSkip = { stepApproval: "not_required", agentMode: "act" } as const;
    expect(decideWrite({ verb: "create", matrix: undefined, ...allSkip })).toBe("approval");
    expect(decideWrite({ verb: "update", matrix: {}, ...allSkip })).toBe("approval");
    expect(decideWrite({ verb: "delete", matrix: {}, ...allSkip })).toBe("refused");
    expect(decideWrite({ verb: "create", matrix: { create: "auto" }, ...allSkip })).toBe("run");
  });

  it("lets a client's tightening override a step at once", () => {
    const step = { verb: "create", stepApproval: "not_required", agentMode: "act" } as const;
    expect(decideWrite({ ...step, matrix: { create: "auto" } })).toBe("run");
    expect(decideWrite({ ...step, matrix: { create: "approval" } })).toBe("approval");
  });
});

describe("decideToolCall", () => {
  it("runs internal writes and connection-less reads; gates external writes", () => {
    expect(
      decideToolCall({ sideEffect: "internal", verb: "create", agentMode: "suggest_only" }),
    ).toBe("run");
    expect(decideToolCall({ sideEffect: "none", verb: "read", agentMode: "suggest_only" })).toBe(
      "run",
    );
    expect(
      decideToolCall({
        sideEffect: "none",
        verb: "read",
        matrix: { read: "off" },
        agentMode: "act",
      }),
    ).toBe("refused");
    expect(
      decideToolCall({ sideEffect: "external", verb: "update", matrix: {}, agentMode: "act" }),
    ).toBe("approval");
  });
});

// §1.73: publishing and posting.
describe("verbs a person always signs", () => {
  const loosest = {
    sideEffect: "external" as const,
    verb: "create" as const,
    matrix: { create: "auto" as const },
    grant: null,
    stepApproval: "not_required" as const,
    agentMode: "act" as const,
  };

  it("wait for a person even when everything else would let them run", () => {
    expect(decideToolCall(loosest)).toBe("run");
    expect(decideToolCall({ ...loosest, alwaysSigned: true })).toBe("approval");
  });

  it("are still refused where the connection turns the verb off, and never loosen", () => {
    expect(decideToolCall({ ...loosest, matrix: { create: "off" }, alwaysSigned: true })).toBe(
      "refused",
    );
    expect(decideToolCall({ ...loosest, agentMode: "suggest_only", alwaysSigned: true })).toBe(
      "approval",
    );
    // Not a write to a client's tool: nothing to sign.
    expect(decideToolCall({ ...loosest, sideEffect: "internal", alwaysSigned: true })).toBe("run");
  });
});

describe("matrix changes", () => {
  it("finds loosened verbs (clients may only tighten)", () => {
    expect(loosenedVerbs({}, { create: "off", update: "approval" })).toEqual([]);
    expect(loosenedVerbs({ update: "approval" }, { update: "auto" })).toEqual(["update"]);
    expect(loosenedVerbs({}, { delete: "approval", read: "auto" })).toEqual(["delete"]);
  });

  it("offers skipping approval only where the connection allows auto", () => {
    expect(canSkipApproval({ update: "auto" }, "update")).toBe(true);
    expect(canSkipApproval({}, "update")).toBe(false);
    expect(canSkipApproval({ read: "auto" }, "read")).toBe(false);
  });
});
