import * as jsonLogicModule from "json-logic-js";
import type { Rule, Rules } from "../schemas/rules";
import { singleRef } from "../template/template";

/**
 * Rules → JSONLogic (docs/plan.md §1.2 "Expressions and rules"). Fork paths and trigger filters
 * are stored as rules (what the builder shows) and compiled here; nothing is ever eval'd.
 */

export type JsonLogic = boolean | { [op: string]: unknown };

// json-logic-js is a UMD module: under Node ESM its functions sit on `default`, under bundlers
// on the namespace itself.
const jsonLogic = ((jsonLogicModule as { default?: typeof jsonLogicModule }).default ??
  jsonLogicModule) as { apply(logic: unknown, data?: unknown): unknown };

export class RuleCompileError extends Error {
  constructor(
    message: string,
    readonly index: number,
    readonly field: "field" | "value" | "op",
  ) {
    super(message);
    this.name = "RuleCompileError";
  }
}

function fieldVar(field: string, index: number): { var: string } {
  let path: string[] | null;
  try {
    path = singleRef(field);
  } catch (e) {
    throw new RuleCompileError((e as Error).message, index, "field");
  }
  if (!path) {
    throw new RuleCompileError(
      `a rule's field must be one reference like {{trigger.total}}`,
      index,
      "field",
    );
  }
  return { var: path.join(".") };
}

/** A value that is exactly one reference compares against that field; anything else is literal. */
function operand(value: unknown, index: number): unknown {
  if (typeof value === "string" && value.startsWith("{{")) {
    try {
      const path = singleRef(value);
      if (path) return { var: path.join(".") };
    } catch (e) {
      throw new RuleCompileError((e as Error).message, index, "value");
    }
  }
  return value;
}

export function compileRule(rule: Rule, index = 0): JsonLogic {
  const a = fieldVar(rule.field, index);
  const b = () => operand(rule.value, index);
  switch (rule.op) {
    case ">":
    case ">=":
    case "<":
    case "<=":
      return { [rule.op]: [a, b()] };
    // DECISION: '=' and '!=' compare loosely (JSONLogic ==), so "5" from a form equals 5 from data.
    case "=":
      return { "==": [a, b()] };
    case "!=":
      return { "!=": [a, b()] };
    case "contains":
      // Substring for text, membership for arrays.
      return { in: [b(), a] };
    case "in":
      if (
        !Array.isArray(rule.value) &&
        !(typeof rule.value === "string" && rule.value.startsWith("{{"))
      ) {
        throw new RuleCompileError("'in' needs a list of values", index, "value");
      }
      return { in: [a, b()] };
    case "is":
      // For true, false and null: strict, so "false" and 0 don't match false.
      return { "===": [a, b()] };
    case "exists":
      return { "!=": [a, null] };
  }
}

/** An empty `all` matches everything and an empty `any` matches nothing. */
export function compileRules(rules: Rules): JsonLogic {
  const parts = rules.rules.map((r, i) => compileRule(r, i));
  if (parts.length === 0) return rules.match === "all";
  if (parts.length === 1) return parts[0] as JsonLogic;
  return rules.match === "all" ? { and: parts } : { or: parts };
}

export function evaluateLogic(logic: JsonLogic, data: unknown): boolean {
  if (typeof logic === "boolean") return logic;
  return Boolean(jsonLogic.apply(logic, data));
}

/** Rules against data such as a RunContext (`{ trigger, steps, item, index }`). */
export function evaluateRules(rules: Rules, data: unknown): boolean {
  return evaluateLogic(compileRules(rules), data);
}
