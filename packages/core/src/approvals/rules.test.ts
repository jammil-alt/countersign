import { describe, expect, it } from "vitest";
import {
  type ApproverRule,
  amountOf,
  approverStrictness,
  type ChangeFacts,
  changeFacts,
  clientApproverChoices,
  clientTighteningProblems,
  firstMatchingRule,
  readApproverRuleSet,
  routeApproval,
} from "./rules";

const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const AGENT = "00000000-0000-4000-8000-00000000a001";
const OTHER_AGENT = "00000000-0000-4000-8000-00000000a002";
const ANA = "00000000-0000-4000-8000-00000000b001";
const BO = "00000000-0000-4000-8000-00000000b002";

const facts = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({
  connector: "qbo",
  tool: "qbo.bill.create",
  verb: "create",
  agentId: AGENT,
  amount: { value: "750.00", currency: "USD" },
  ...over,
});

const rule = (n: number, match: ApproverRule["match"], approver: ApproverRule["approver"]) =>
  ({ id: R(n), match, approver, setBy: "operator" }) satisfies ApproverRule;

describe("matching", () => {
  it("matches each field on its own", () => {
    const cases: [ApproverRule["match"], boolean][] = [
      [{}, true],
      [{ connector: "qbo" }, true],
      [{ connector: "gmail" }, false],
      [{ tool: "qbo.bill.create" }, true],
      [{ tool: "qbo.bill.update" }, false],
      [{ verb: "create" }, true],
      [{ verb: "update" }, false],
      [{ agentId: AGENT }, true],
      [{ agentId: OTHER_AGENT }, false],
      [{ amountOver: { value: "500", currency: "USD" } }, true],
      [{ amountOver: { value: "1000", currency: "USD" } }, false],
      [{ connector: "qbo", verb: "update" }, false],
    ];
    for (const [match, expected] of cases) {
      const hit = firstMatchingRule([rule(1, match, { kind: "operator" })], facts());
      expect(hit !== null, JSON.stringify(match)).toBe(expected);
    }
  });

  it("compares amounts as decimals, strictly over, in one currency only", () => {
    const over = (value: string, currency = "USD") => [
      rule(1, { amountOver: { value, currency } }, { kind: "client_admin" }),
    ];
    const at = (value: string, currency = "USD") => facts({ amount: { value, currency } });
    expect(firstMatchingRule(over("750.00"), at("750"))).toBeNull();
    expect(firstMatchingRule(over("750"), at("750.0001"))).not.toBeNull();
    expect(firstMatchingRule(over("0.1"), at("0.3"))).not.toBeNull();
    // Decimals compare exactly: 0.3 is not over 0.3000.
    expect(firstMatchingRule(over("0.3"), at("0.3000"))).toBeNull();
    expect(firstMatchingRule(over("-5"), at("0"))).not.toBeNull();
    // Another currency never matches, however large.
    expect(firstMatchingRule(over("1", "USD"), at("1000000", "EUR"))).toBeNull();
    // No amount (the tool declares none) never matches an amount rule.
    expect(firstMatchingRule(over("0"), facts({ amount: null }))).toBeNull();
  });

  it("takes the first match in order", () => {
    const rules = [
      rule(1, { amountOver: { value: "5000", currency: "USD" } }, { kind: "user", userId: ANA }),
      rule(2, { connector: "qbo" }, { kind: "operator" }),
      rule(3, {}, { kind: "client_admin" }),
    ];
    expect(firstMatchingRule(rules, facts())?.id).toBe(R(2));
    expect(
      firstMatchingRule(rules, facts({ amount: { value: "9000", currency: "USD" } }))?.id,
    ).toBe(R(1));
    expect(firstMatchingRule(rules, facts({ connector: "gmail" }))?.id).toBe(R(3));
    expect(firstMatchingRule([], facts())).toBeNull();
  });
});

describe("amounts in tool input", () => {
  const spec = { amount: { path: "Line.0.Amount", currencyPath: "CurrencyRef.value" } };
  it("reads the path, strings and numbers alike, and the currency", () => {
    expect(amountOf(spec, { Line: [{ Amount: 1234.5 }], CurrencyRef: { value: "cad" } })).toEqual({
      value: "1234.5",
      currency: "CAD",
    });
    expect(amountOf(spec, { Line: [{ Amount: "10.25" }], CurrencyRef: { value: "USD" } })).toEqual({
      value: "10.25",
      currency: "USD",
    });
  });
  it("falls back to the fixed currency, and is null without one or without a number", () => {
    expect(amountOf({ amount: { path: "a", currency: "USD" } }, { a: "5" })).toEqual({
      value: "5",
      currency: "USD",
    });
    expect(amountOf(spec, { Line: [{ Amount: "5" }] })).toBeNull();
    expect(amountOf({ amount: { path: "a", currency: "USD" } }, { a: "five" })).toBeNull();
    expect(amountOf({ amount: { path: "a", currency: "USD" } }, {})).toBeNull();
    expect(amountOf({}, { a: "5" })).toBeNull();
  });
  it("builds the facts of a change", () => {
    expect(
      changeFacts({
        spec: {
          id: "testkit.record.update",
          verb: "update",
          amount: { path: "amount", currency: "USD" },
        },
        connector: "testkit",
        agentId: AGENT,
        input: { id: "r1", amount: "12.00" },
      }),
    ).toEqual({
      connector: "testkit",
      tool: "testkit.record.update",
      verb: "update",
      agentId: AGENT,
      amount: { value: "12", currency: "USD" },
    });
  });
});

describe("routing", () => {
  const rules = [rule(1, { connector: "qbo" }, { kind: "user", userId: ANA })];
  it("puts the client's rules first, then the step, the agent, the client's default, the admin", () => {
    expect(routeApproval({ rules, facts: facts(), step: "operator", agent: ["operator"] })).toEqual(
      {
        approver: { kind: "user", userId: ANA },
        assignee: { assigneeRole: null, assigneeUserId: ANA },
        source: "rule",
        ruleId: R(1),
      },
    );
    const other = facts({ connector: "gmail" });
    expect(routeApproval({ rules, facts: other, step: "operator" }).source).toBe("step");
    expect(routeApproval({ rules, facts: other, agent: [null, "operator"] })).toMatchObject({
      source: "agent",
      assignee: { assigneeRole: "operator" },
    });
    expect(routeApproval({ rules, facts: other, client: "client_user" })).toMatchObject({
      source: "client",
      assignee: { assigneeRole: "client_user", assigneeUserId: null },
    });
    expect(routeApproval({ rules, facts: other })).toMatchObject({
      source: "default",
      assignee: { assigneeRole: "client_admin", assigneeUserId: null },
    });
  });
  it("sends a rule's named person who left the client to the admin", () => {
    const route = routeApproval({ rules, facts: facts(), members: new Set([BO]) });
    expect(route).toMatchObject({ source: "rule", approver: { kind: "client_admin" } });
  });
  it("reads unreadable stored rules as none", () => {
    expect(readApproverRuleSet({ approver_rules: { rules: "x" } })).toEqual({
      revision: 0,
      rules: [],
    });
    expect(readApproverRuleSet({ approver_rules: { revision: 2, rules } }).rules).toHaveLength(1);
  });
});

describe("stricter only", () => {
  const current = [
    rule(1, { amountOver: { value: "500", currency: "USD" } }, { kind: "operator" }),
    rule(2, { connector: "qbo" }, { kind: "role", role: "client_user" }),
    rule(3, {}, { kind: "user", userId: ANA }),
  ];
  const codes = (next: Parameters<typeof clientTighteningProblems>[1]) =>
    clientTighteningProblems(current, next).map((p) => p.code);

  it("ranks approvers", () => {
    expect(approverStrictness({ kind: "operator" })).toBe(0);
    expect(approverStrictness({ kind: "role", role: "client_user" })).toBe(1);
    expect(approverStrictness({ kind: "client_admin" })).toBe(2);
    expect(approverStrictness({ kind: "user", userId: ANA })).toBe(2);
    expect(clientApproverChoices({ kind: "operator" })).toEqual(["role", "client_admin", "user"]);
    expect(clientApproverChoices({ kind: "user", userId: ANA })).toEqual(["client_admin", "user"]);
    expect(clientApproverChoices(null)).toEqual(["client_admin", "user"]);
  });

  it("allows taking an approval back from the operator, narrowing, and adding strict rules", () => {
    expect(codes(current)).toEqual([]);
    const [a, b, c] = current as [ApproverRule, ApproverRule, ApproverRule];
    expect(
      codes([
        { ...a, approver: { kind: "role", role: "client_user" } },
        { ...b, approver: { kind: "user", userId: BO } },
        { ...c, approver: { kind: "client_admin" } },
      ]),
    ).toEqual([]);
    expect(
      codes([
        { match: { verb: "create" }, approver: { kind: "client_admin" } },
        a,
        { match: { connector: "gmail" }, approver: { kind: "user", userId: BO } },
        b,
        c,
      ]),
    ).toEqual([]);
    // The same threshold written another way is the same match.
    expect(
      codes([{ ...a, match: { amountOver: { value: "500.00", currency: "USD" } } }, b, c]),
    ).toEqual([]);
  });

  it("refuses every way of loosening", () => {
    const [a, b, c] = current as [ApproverRule, ApproverRule, ApproverRule];
    expect(codes([a, b])).toEqual(["removed"]);
    expect(codes([b, a, c])).toEqual(["reordered"]);
    expect(
      codes([{ ...a, match: { amountOver: { value: "900", currency: "USD" } } }, b, c]),
    ).toEqual(["match_changed"]);
    expect(codes([a, b, { ...c, approver: { kind: "role", role: "client_user" } }])).toEqual([
      "looser",
    ]);
    expect(codes([a, { ...b, approver: { kind: "operator" } }, c])).toEqual(["to_operator"]);
    expect(codes([{ match: {}, approver: { kind: "operator" } }, a, b, c])).toEqual([
      "to_operator",
    ]);
    expect(
      codes([{ match: {}, approver: { kind: "role", role: "client_user" } }, a, b, c]),
    ).toEqual(["new_rule_too_loose"]);
  });
});
