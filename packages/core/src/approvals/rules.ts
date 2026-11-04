import { z } from "zod";
import { isUuid } from "../ids";
import { deepEqual, isPlainObject } from "../json";
import { CurrencyCode, Decimal, DecimalString } from "../money";
import { ToolId } from "../schemas/common";
import { Verb } from "../schemas/permissions";
import type { ToolSpec } from "../schemas/tool";

// Approver rules (docs/plan.md §1.17, §1.20): per client, ordered, the first match wins. They
// decide WHO approves a change to a client's tool, never WHETHER it needs approval (invariant 8:
// that stays per step, per connection matrix and per agent mode). Pure, so the API, the runtime
// and both editors (back office and portal) evaluate and check them the same way.

const Uuid = z.string().refine((v) => isUuid(v), "not an id");

/** Who approves. */
export const ApproverTarget = z
  .discriminatedUnion("kind", [
    /** The client's admins. */
    z.strictObject({ kind: z.literal("client_admin") }),
    /** Anyone in the client with this role. */
    z.strictObject({ kind: z.literal("role"), role: z.enum(["client_admin", "client_user"]) }),
    /** One named client user, and only them. */
    z.strictObject({ kind: z.literal("user"), userId: Uuid }),
    /** The operator, on the client's behalf. */
    z.strictObject({ kind: z.literal("operator") }),
  ])
  .meta({ id: "ApproverTarget" });
export type ApproverTarget = z.infer<typeof ApproverTarget>;

/** An amount strictly over `value`, in `currency` only (never compared across currencies). */
export const AmountOver = z.strictObject({ value: DecimalString, currency: CurrencyCode });
export type AmountOver = z.infer<typeof AmountOver>;

export const WriteVerb = Verb.exclude(["read"]);
export type WriteVerb = z.infer<typeof WriteVerb>;

/** What a rule matches on. Every field given must hold; a rule with none matches every change. */
export const ApproverMatch = z
  .strictObject({
    connector: z.string().min(1).max(64).optional(),
    tool: ToolId.optional(),
    verb: WriteVerb.optional(),
    amountOver: AmountOver.optional(),
    /** A client agent of this client. */
    agentId: Uuid.optional(),
  })
  .meta({ id: "ApproverMatch" });
export type ApproverMatch = z.infer<typeof ApproverMatch>;

export const APPROVER_RULES_MAX = 50;
export const APPROVER_RULE_NOTE_MAX = 200;
export const APPROVER_REASON_MAX = 500;

export const ApproverRule = z
  .strictObject({
    id: Uuid,
    match: ApproverMatch,
    approver: ApproverTarget,
    /** Who added the rule. The client admin never removes a rule, whoever added it. */
    setBy: z.enum(["operator", "client"]),
    note: z.string().trim().max(APPROVER_RULE_NOTE_MAX).optional(),
  })
  .meta({ id: "ApproverRule" });
export type ApproverRule = z.infer<typeof ApproverRule>;

export const ApproverRules = z.array(ApproverRule).max(APPROVER_RULES_MAX);

/** A rule as an editor sends it: new rules may leave the id for the server to make. */
export const ApproverRuleInput = ApproverRule.extend({
  id: Uuid.optional(),
  setBy: z.enum(["operator", "client"]).optional(),
});
export type ApproverRuleInput = z.infer<typeof ApproverRuleInput>;

/** `tenant.settings.approver_rules`: the rules and a revision bumped on every save. */
export const ApproverRuleSet = z.object({
  revision: z.number().int().min(0),
  rules: ApproverRules,
});
export type ApproverRuleSet = z.infer<typeof ApproverRuleSet>;

export const EMPTY_RULE_SET: ApproverRuleSet = { revision: 0, rules: [] };

/** Reads the stored rules; anything unreadable counts as no rules (the client admin then approves). */
export function readApproverRuleSet(settings: Record<string, unknown>): ApproverRuleSet {
  const parsed = ApproverRuleSet.safeParse(settings.approver_rules);
  return parsed.success ? parsed.data : EMPTY_RULE_SET;
}

// ── The change being routed ──────────────────────────────────────────────────────────────────────

/** Where a tool that carries money keeps it in its input (dotted paths). */
export const ToolAmount = z
  .strictObject({
    /** E.g. `amount` or `Line.0.Amount`. */
    path: z.string().min(1),
    /** Where the currency code is; else `currency`. */
    currencyPath: z.string().min(1).optional(),
    /** The currency when the input names none. */
    currency: CurrencyCode.optional(),
  })
  .meta({ id: "ToolAmount" });
export type ToolAmount = z.infer<typeof ToolAmount>;

export interface ChangeFacts {
  connector: string;
  tool: string;
  verb: WriteVerb;
  agentId: string | null;
  /** Null when the tool declares no amount or the input has none readable. */
  amount: { value: string; currency: string } | null;
}

function at(input: unknown, path: string): unknown {
  let node: unknown = input;
  for (const key of path.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(key)) node = node[Number(key)];
    else if (isPlainObject(node)) node = node[key];
    else return undefined;
  }
  return node;
}

/**
 * The amount a tool's input carries, as a decimal string, or null. A JSON number is read through
 * its own decimal text (decimal.js, never float arithmetic).
 */
// DECISION: an amount without a currency (none at currencyPath and no fixed `currency`) is no
// amount: amount rules never match it, rather than guess a currency.
export function amountOf(
  spec: { amount?: ToolAmount | undefined },
  input: unknown,
): ChangeFacts["amount"] {
  const where = spec.amount;
  if (!where) return null;
  const raw = at(input, where.path);
  let value: string;
  if (typeof raw === "string") value = raw.trim();
  else if (typeof raw === "number" && Number.isFinite(raw)) value = String(raw);
  else return null;
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    return null;
  }
  if (!d.isFinite()) return null;
  const fromInput = where.currencyPath ? at(input, where.currencyPath) : undefined;
  const currency =
    typeof fromInput === "string" && CurrencyCode.safeParse(fromInput.toUpperCase()).success
      ? fromInput.toUpperCase()
      : (where.currency ?? null);
  if (!currency) return null;
  return { value: d.toFixed(), currency };
}

/** The facts of a proposed write that rules match on. */
export function changeFacts(input: {
  spec: Pick<ToolSpec, "id" | "verb" | "amount">;
  connector: string;
  agentId: string | null;
  input: unknown;
}): ChangeFacts {
  return {
    connector: input.connector,
    tool: input.spec.id,
    // Writes only reach routing; a read never needs an approver.
    verb: input.spec.verb === "read" ? "update" : input.spec.verb,
    agentId: input.agentId,
    amount: amountOf(input.spec, input.input),
  };
}

// ── Evaluating ───────────────────────────────────────────────────────────────────────────────────

/** Whether a rule's amount condition holds: same currency and strictly over the threshold. */
export function amountMatches(over: AmountOver, amount: ChangeFacts["amount"]): boolean {
  if (!amount || amount.currency !== over.currency) return false;
  return new Decimal(amount.value).greaterThan(new Decimal(over.value));
}

export function ruleMatches(match: ApproverMatch, facts: ChangeFacts): boolean {
  if (match.connector !== undefined && match.connector !== facts.connector) return false;
  if (match.tool !== undefined && match.tool !== facts.tool) return false;
  if (match.verb !== undefined && match.verb !== facts.verb) return false;
  if (match.agentId !== undefined && match.agentId !== facts.agentId) return false;
  if (match.amountOver !== undefined && !amountMatches(match.amountOver, facts.amount)) {
    return false;
  }
  return true;
}

/** The first rule that matches, or null. */
export function firstMatchingRule(
  rules: readonly ApproverRule[],
  facts: ChangeFacts,
): ApproverRule | null {
  return rules.find((r) => ruleMatches(r.match, facts)) ?? null;
}

/** An inbox item's assignee: a role, or one user. */
export interface ApprovalAssignee {
  assigneeRole: "operator" | "client_admin" | "client_user" | null;
  assigneeUserId: string | null;
}

export function assigneeOf(target: ApproverTarget): ApprovalAssignee {
  switch (target.kind) {
    case "client_admin":
      return { assigneeRole: "client_admin", assigneeUserId: null };
    case "role":
      return { assigneeRole: target.role, assigneeUserId: null };
    case "user":
      return { assigneeRole: null, assigneeUserId: target.userId };
    case "operator":
      return { assigneeRole: "operator", assigneeUserId: null };
  }
}

/** A stored approver string (a role or a user id, as steps and agents name them), or null. */
export function approverFromSetting(value: string | null | undefined): ApproverTarget | null {
  if (!value) return null;
  if (isUuid(value)) return { kind: "user", userId: value };
  if (value === "operator") return { kind: "operator" };
  if (value === "client_admin") return { kind: "client_admin" };
  if (value === "client_user") return { kind: "role", role: "client_user" };
  return null;
}

export type ApprovalSource = "rule" | "step" | "agent" | "client" | "default";

export interface ApprovalRoute {
  approver: ApproverTarget;
  assignee: ApprovalAssignee;
  source: ApprovalSource;
  /** The rule that decided, when one did. */
  ruleId: string | null;
}

/**
 * Who approves a proposed write. Precedence: the client's rules (first match), then the step's
 * approver, then the agent's (its definition, then the client agent's override), then the client's
 * default setting, then the client admin.
 */
// DECISION: the client's rules come before every approver an agent or step names, so the client
// admin's tightening (a rule) wins over an operator-set step or agent approver at once. A rule
// naming a user who is no longer in the client routes to the client admin instead (stricter, and
// never stuck with nobody able to approve).
export function routeApproval(input: {
  rules: readonly ApproverRule[];
  facts: ChangeFacts;
  step?: string | null | undefined;
  agent?: readonly (string | null | undefined)[];
  client?: string | null | undefined;
  /** The client's user ids, when known: a rule naming anyone else falls to the client admin. */
  members?: ReadonlySet<string>;
}): ApprovalRoute {
  const rule = firstMatchingRule(input.rules, input.facts);
  if (rule) {
    const approver: ApproverTarget =
      rule.approver.kind === "user" && input.members && !input.members.has(rule.approver.userId)
        ? { kind: "client_admin" }
        : rule.approver;
    return { approver, assignee: assigneeOf(approver), source: "rule", ruleId: rule.id };
  }
  const chain: [ApprovalSource, string | null | undefined][] = [
    ["step", input.step],
    ...(input.agent ?? []).map((a): [ApprovalSource, string | null | undefined] => ["agent", a]),
    ["client", input.client],
  ];
  for (const [source, value] of chain) {
    const approver = approverFromSetting(value);
    if (approver) return { approver, assignee: assigneeOf(approver), source, ruleId: null };
  }
  const approver: ApproverTarget = { kind: "client_admin" };
  return { approver, assignee: assigneeOf(approver), source: "default", ruleId: null };
}

// ── Stricter only (the client admin's edits) ─────────────────────────────────────────────────────

/**
 * How strict an approver is, from the client's side: the operator approving for the client is the
 * loosest, anyone in a role next, the admins or one named person the strictest.
 */
// DECISION: client_admin and a named person are equally strict (both "narrow"), so the client
// admin may move a rule between them, or between named people; never down to a role or the operator.
export function approverStrictness(target: ApproverTarget): 0 | 1 | 2 {
  switch (target.kind) {
    case "operator":
      return 0;
    case "role":
      return target.role === "client_admin" ? 2 : 1;
    case "client_admin":
    case "user":
      return 2;
  }
}

export type TighteningProblemCode =
  | "removed"
  | "reordered"
  | "match_changed"
  | "looser"
  | "to_operator"
  | "new_rule_too_loose";

export interface TighteningProblem {
  ruleId: string | null;
  code: TighteningProblemCode;
  message: string;
}

/**
 * What in `next` would loosen `current` if the client admin saved it. Allowed: a stricter (or
 * equally strict) approver on an existing rule, and new rules, anywhere, that name the client
 * admin or one person. Never removing, reordering or re-matching a rule, and never the operator.
 * Any new rule of that kind can only make a change's approver stricter, because rules come first.
 */
export function clientTighteningProblems(
  current: readonly ApproverRule[],
  next: readonly (ApproverRuleInput | ApproverRule)[],
): TighteningProblem[] {
  const problems: TighteningProblem[] = [];
  const byId = new Map(current.map((r) => [r.id, r]));
  const kept: string[] = [];
  for (const rule of next) {
    const old = rule.id ? byId.get(rule.id) : undefined;
    if (!old) {
      if (rule.approver.kind === "operator") {
        problems.push({
          ruleId: rule.id ?? null,
          code: "to_operator",
          message: "a new rule can't send approvals to the operator",
        });
      } else if (approverStrictness(rule.approver) < 2) {
        problems.push({
          ruleId: rule.id ?? null,
          code: "new_rule_too_loose",
          message: "a new rule must name the admin or one person",
        });
      }
      continue;
    }
    kept.push(old.id);
    if (!deepEqual(normalMatch(old.match), normalMatch(rule.match))) {
      problems.push({
        ruleId: old.id,
        code: "match_changed",
        message: "only the operator changes what a rule matches",
      });
    }
    if (deepEqual(old.approver, rule.approver)) continue;
    if (rule.approver.kind === "operator") {
      problems.push({
        ruleId: old.id,
        code: "to_operator",
        message: "you can't send approvals to the operator",
      });
    } else if (approverStrictness(rule.approver) < approverStrictness(old.approver)) {
      problems.push({ ruleId: old.id, code: "looser", message: "that approver is less strict" });
    }
  }
  for (const r of current) {
    if (!kept.includes(r.id)) {
      problems.push({ ruleId: r.id, code: "removed", message: "only the operator removes rules" });
    }
  }
  const order = current.map((r) => r.id).filter((id) => kept.includes(id));
  if (order.some((id, i) => kept[i] !== id)) {
    problems.push({ ruleId: null, code: "reordered", message: "only the operator reorders rules" });
  }
  return problems;
}

function normalMatch(m: ApproverMatch): ApproverMatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined) out[k] = v;
  if (m.amountOver) {
    out.amountOver = {
      value: new Decimal(m.amountOver.value).toFixed(),
      currency: m.amountOver.currency,
    };
  }
  return out as ApproverMatch;
}

/** What a client admin may choose for a rule's approver: the same or stricter, never the operator. */
export function clientApproverChoices(current: ApproverTarget | null): ApproverTarget["kind"][] {
  const floor = current ? approverStrictness(current) : 2;
  const kinds: ApproverTarget["kind"][] = [];
  if (floor <= 1) kinds.push("role");
  kinds.push("client_admin", "user");
  return kinds;
}
