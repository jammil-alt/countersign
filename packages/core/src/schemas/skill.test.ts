// R2 (docs/plan.md §1.86, §9): a skill's method, declared reads, browsing and rule rows.

import { describe, expect, it } from "vitest";
import { skills } from "../testing/fixtures";
import { isToolWrapper, SkillDefinition, skillMethod } from "./skill";

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties });

const task = {
  schemaVersion: 1,
  id: "test.categorize",
  name: "Categorize",
  description: "Pick an account for a transaction",
  category: "bookkeeping",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Pick the account.",
  tools: [],
  input: obj({ payee: { type: "string" } }),
  output: obj({ account: { type: "string" }, reason: { type: "string" } }),
};

const rule = {
  id: "home-depot",
  when: { match: "all", rules: [{ field: "{{input.payee}}", op: "=", value: "Home Depot" }] },
  set: { account: "Materials" },
};

describe("skill method", () => {
  it("parses stored rows unchanged and derives the method from the mode", () => {
    const extract = skills["docs.extract"] as SkillDefinition;
    const itemize = skills["test.itemize"] as SkillDefinition;
    expect(extract.method).toBeUndefined();
    expect(skillMethod(extract)).toBe("rules");
    expect(skillMethod(itemize)).toBe("ai");
    expect(skillMethod(SkillDefinition.parse(task))).toBe("ai");
    expect(skillMethod({ ...SkillDefinition.parse(task), method: "rules_then_ai" })).toBe(
      "rules_then_ai",
    );
  });

  it("keeps the method and the mode in step", () => {
    expect(SkillDefinition.safeParse({ ...task, method: "rules_then_ai" }).success).toBe(true);
    expect(SkillDefinition.safeParse({ ...task, method: "rules" }).success).toBe(false);
    const extract = skills["docs.extract"] as SkillDefinition;
    expect(SkillDefinition.safeParse({ ...extract, method: "rules" }).success).toBe(true);
    expect(SkillDefinition.safeParse({ ...extract, method: "ai" }).success).toBe(false);
  });

  it("tells a tool wrapper from a skill that computes", () => {
    expect(isToolWrapper(skills["docs.extract"] as SkillDefinition)).toBe(true);
    expect(isToolWrapper(skills["test.itemize"] as SkillDefinition)).toBe(false);
    expect(
      isToolWrapper({ mode: "tool", handler: "docs.extract", tools: ["qbo.bill.query"] }),
    ).toBe(false);
  });
});

describe("skill reads, browsing and rules", () => {
  it("declares read tools once each", () => {
    expect(SkillDefinition.parse({ ...task, reads: ["qbo.bill.query"] }).reads).toEqual([
      "qbo.bill.query",
    ]);
    expect(
      SkillDefinition.safeParse({ ...task, reads: ["qbo.bill.query", "qbo.bill.query"] }).success,
    ).toBe(false);
    expect(SkillDefinition.safeParse({ ...task, reads: ["Not A Tool"] }).success).toBe(false);
  });

  it("lets only an ai skill browse, and only named sites and pages", () => {
    const browse = { sites: ["supplier-portal"], pages: ["/orders/*", "/account/invoices"] };
    expect(SkillDefinition.safeParse({ ...task, browse }).success).toBe(true);
    expect(
      SkillDefinition.safeParse({ ...skills["docs.extract"], browse }).success,
      "a rules skill",
    ).toBe(false);
    for (const bad of [
      { sites: [], pages: ["/orders/*"] },
      { sites: ["supplier-portal"], pages: [] },
      { sites: ["supplier-portal"], pages: ["https://example.com/orders"] },
      { sites: ["Supplier Portal"], pages: ["/orders/*"] },
      { sites: ["supplier-portal"], pages: ["/orders/*"], web: true },
    ]) {
      expect(SkillDefinition.safeParse({ ...task, browse: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("keeps browsing on the site's own pages: no //, no . or .., no encoded dots or slashes", () => {
    const pages = (p: string) =>
      SkillDefinition.safeParse({ ...task, browse: { sites: ["supplier-portal"], pages: [p] } })
        .success;
    for (const good of ["/", "/orders/*", "/orders/2026.11/*", "/a/.well-known", "/x%20y"]) {
      expect(pages(good), good).toBe(true);
    }
    for (const bad of [
      "//host/x",
      "//evil.example.com/orders",
      "/orders//x",
      "/../x",
      "/orders/../admin",
      "/./x",
      "/orders/..",
      "/%2e%2e/x",
      "/%2E%2E/x",
      "/orders%2f..%2fadmin",
      "/orders/%2F",
      "/orders/%5c..%5cadmin",
      "/orders/.%2e/admin",
    ]) {
      expect(pages(bad), bad).toBe(false);
    }
  });

  it("refuses the rest of a bad browse", () => {
    for (const bad of [{ sites: ["supplier-portal"], pages: ["/orders/*", "/../x"] }]) {
      expect(SkillDefinition.safeParse({ ...task, browse: bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("holds rule rows on rules skills only, with unique ids", () => {
    expect(
      SkillDefinition.safeParse({ ...task, method: "rules_then_ai", rules: [rule] }).success,
    ).toBe(true);
    expect(SkillDefinition.safeParse({ ...task, rules: [rule] }).success, "an ai skill").toBe(
      false,
    );
    expect(
      SkillDefinition.safeParse({ ...task, method: "rules_then_ai", rules: [rule, rule] }).success,
    ).toBe(false);
    expect(
      SkillDefinition.safeParse({
        ...task,
        method: "rules_then_ai",
        rules: [{ ...rule, output: { account: "x" } }],
      }).success,
      "rows are strict",
    ).toBe(false);
  });
});
