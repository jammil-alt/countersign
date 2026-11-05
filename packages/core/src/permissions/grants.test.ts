import { describe, expect, it } from "vitest";
import { decideToolCall } from "./decide";
import {
  effectiveMatrix,
  GrantLimits,
  grantAllowsTool,
  grantLoosening,
  grantProblems,
  isRevoked,
  normalizeGrant,
  REVOKED_GRANT,
} from "./grants";

const OPEN = { read: "auto", create: "auto", update: "auto", delete: "off" } as const;

describe("effective matrix: the stricter of the connection and the grant", () => {
  it("no grant changes nothing", () => {
    expect(effectiveMatrix(OPEN, null)).toEqual(OPEN);
    expect(effectiveMatrix(OPEN, {})).toEqual(OPEN);
  });

  it("a grant narrows, never widens", () => {
    expect(effectiveMatrix(OPEN, { verbs: { create: "approval", update: "off" } })).toEqual({
      ...OPEN,
      create: "approval",
      update: "off",
    });
    // The matrix's off wins over a grant's auto.
    expect(effectiveMatrix({ ...OPEN, create: "off" }, { verbs: { create: "auto" } }).create).toBe(
      "off",
    );
  });
});

describe("decideToolCall with a grant", () => {
  it("a read-only grant refuses a write even when the matrix lets it run", () => {
    const readOnly = { verbs: { create: "off", update: "off", delete: "off" } } as const;
    const base = {
      sideEffect: "external",
      verb: "update",
      matrix: OPEN,
      stepApproval: "not_required",
      agentMode: "act",
    } as const;
    expect(decideToolCall(base)).toBe("run");
    expect(decideToolCall({ ...base, grant: readOnly })).toBe("refused");
    expect(decideToolCall({ ...base, sideEffect: "none", verb: "read", grant: readOnly })).toBe(
      "run",
    );
  });

  it("a grant at approval makes an automatic step wait", () => {
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: OPEN,
        grant: { verbs: { create: "approval" } },
        stepApproval: "not_required",
        agentMode: "act",
      }),
    ).toBe("approval");
  });

  it("a revoked grant refuses reads too", () => {
    expect(
      decideToolCall({
        sideEffect: "none",
        verb: "read",
        matrix: OPEN,
        grant: REVOKED_GRANT,
        agentMode: "act",
      }),
    ).toBe("refused");
    expect(isRevoked(REVOKED_GRANT)).toBe(true);
    expect(isRevoked({ tools: [] })).toBe(true);
    expect(isRevoked({ verbs: { create: "off" } })).toBe(false);
  });
});

describe("tools subset", () => {
  it("no subset allows every tool; a subset only its own", () => {
    expect(grantAllowsTool(null, "testkit.record.update")).toBe(true);
    expect(grantAllowsTool({ tools: ["testkit.record.query"] }, "testkit.record.query")).toBe(true);
    expect(grantAllowsTool({ tools: ["testkit.record.query"] }, "testkit.record.update")).toBe(
      false,
    );
  });
});

describe("loosening (client roles may only tighten)", () => {
  it("raising a verb, dropping it, or widening tools loosens", () => {
    expect(grantLoosening({ verbs: { create: "off" } }, { verbs: { create: "approval" } })).toEqual(
      { verbs: ["create"], tools: false },
    );
    expect(grantLoosening({ verbs: { create: "off" } }, {})).toEqual({
      verbs: ["create"],
      tools: false,
    });
    expect(grantLoosening({ tools: ["a"] }, {}).tools).toBe(true);
    expect(grantLoosening({ tools: ["a"] }, { tools: ["a", "b"] }).tools).toBe(true);
  });

  it("lowering a verb, narrowing tools or revoking does not", () => {
    expect(grantLoosening(null, { verbs: { update: "approval" } })).toEqual({
      verbs: [],
      tools: false,
    });
    expect(grantLoosening({ tools: ["a", "b"] }, { tools: ["a"] }).tools).toBe(false);
    expect(grantLoosening(null, { tools: ["a"] }).tools).toBe(false);
    expect(grantLoosening({ verbs: { create: "approval" } }, REVOKED_GRANT).verbs).toEqual([]);
  });
});

describe("what the operator may set", () => {
  it("no verb above the connection's matrix, tools only from the connector", () => {
    const matrix = { read: "auto", create: "approval", update: "approval", delete: "off" } as const;
    expect(grantProblems({ verbs: { create: "approval" } }, matrix, [])).toEqual([]);
    expect(grantProblems({ verbs: { create: "auto" } }, matrix, [])).toEqual([
      "create can't be auto: the connection allows approval at most",
    ]);
    expect(grantProblems({ tools: ["x.y"] }, matrix, ["x.z"])).toEqual([
      "x.y is not one of the connector's tools",
    ]);
  });
});

describe("GrantLimits", () => {
  it("parses limits and refuses unknown keys or levels", () => {
    expect(GrantLimits.safeParse({ verbs: { read: "auto" }, tools: ["a.b"] }).success).toBe(true);
    expect(GrantLimits.safeParse({ verbs: { read: "sometimes" } }).success).toBe(false);
    expect(GrantLimits.safeParse({ admin: true }).success).toBe(false);
  });

  it("normalizes by dropping verbs left unset", () => {
    expect(normalizeGrant({ verbs: {} })).toEqual({});
    expect(normalizeGrant({ verbs: { create: "off" }, tools: ["a"] })).toEqual({
      verbs: { create: "off" },
      tools: ["a"],
    });
  });
});
