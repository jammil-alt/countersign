// docs/plan.md §1.230: a pack's configuration fields, their defaults, the operator's values over a
// client's, and the manifest's checks on them.

import { describe, expect, it } from "vitest";
import { PackManifest } from "./pack";
import {
  PackConfigField,
  packConfigDefaults,
  packConfigOf,
  packConfigProblems,
  resolvePackConfig,
} from "./pack-config";

const FIELDS = PackConfigField.array().parse([
  {
    key: "close_day",
    label: "Close the books on this day of the month",
    type: "number",
    default: 5,
    min: 1,
    max: 28,
  },
  {
    key: "auto_reconcile",
    label: "Reconcile each account monthly",
    type: "boolean",
    default: true,
  },
  {
    key: "basis",
    label: "Accounting basis",
    type: "choice",
    options: [
      { value: "accrual", label: "Accrual" },
      { value: "cash", label: "Cash" },
    ],
    default: "accrual",
  },
  { key: "memo", label: "Memo on each entry", type: "text", default: "" },
]);

const manifest = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  description: "",
  area: "bookkeeping",
  events: [],
  tools: [],
  skills: [],
  templates: [],
  screens: [],
};

describe("a pack's configuration", () => {
  it("starts at the defaults", () => {
    expect(packConfigDefaults(FIELDS)).toEqual({
      close_day: 5,
      auto_reconcile: true,
      basis: "accrual",
      memo: "",
    });
    expect(packConfigOf(FIELDS, {}, "demo")).toEqual(packConfigDefaults(FIELDS));
    expect(packConfigOf(FIELDS, null, "demo")).toEqual(packConfigDefaults(FIELDS));
  });

  it("puts the operator's values over the client's, and the rest at their defaults", () => {
    const first = resolvePackConfig(FIELDS, { close_day: 10 });
    expect(first).toEqual({
      ok: true,
      values: { close_day: 10, auto_reconcile: true, basis: "accrual", memo: "" },
    });
    const second = resolvePackConfig(FIELDS, { basis: "cash" }, first.ok ? first.values : {});
    expect(second.ok && second.values).toEqual({
      close_day: 10,
      auto_reconcile: true,
      basis: "cash",
      memo: "",
    });
  });

  it("refuses a setting the pack doesn't have, or a value its field doesn't take", () => {
    const bad = resolvePackConfig(FIELDS, {
      nope: 1,
      close_day: 40,
      basis: "modified",
      auto_reconcile: "yes",
    });
    expect(bad.ok).toBe(false);
    const problems = bad.ok ? [] : bad.problems;
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/nope: this pack has no such setting/);
    expect(problems.join("\n")).toMatch(/close_day: must be at most 28/);
  });

  it("reads a client's kept values, a stale one at its default", () => {
    const settings = {
      packs: { demo: { close_day: 12, basis: "barter", gone: true }, other: { close_day: 3 } },
    };
    expect(packConfigOf(FIELDS, settings, "demo")).toEqual({
      close_day: 12,
      auto_reconcile: true,
      basis: "accrual",
      memo: "",
    });
  });

  it("is checked in the manifest: no secrets, defaults that fit, keys once", () => {
    expect(PackManifest.safeParse({ ...manifest, config: FIELDS }).success).toBe(true);
    const parsed = PackManifest.parse(manifest);
    expect(parsed.config).toEqual([]);
    expect(parsed.processors).toEqual([]);
    expect(parsed.reports).toEqual([]);
    const secret = { key: "token", label: "The bank's password", type: "text", default: "" };
    expect(PackManifest.safeParse({ ...manifest, config: [secret] }).success).toBe(false);
    expect(packConfigProblems(PackConfigField.array().parse([secret]))[0]).toMatch(/secret/);
    const outOfRange = { ...FIELDS[0], default: 30 };
    expect(PackManifest.safeParse({ ...manifest, config: [outOfRange] }).success).toBe(false);
    const badChoice = { ...FIELDS[2], default: "cash-ish" };
    expect(PackManifest.safeParse({ ...manifest, config: [badChoice] }).success).toBe(false);
    expect(PackManifest.safeParse({ ...manifest, config: [FIELDS[1], FIELDS[1]] }).success).toBe(
      false,
    );
  });

  it("names the pack's area, its intake section's too, and its vendors of ours", () => {
    expect(PackManifest.safeParse({ ...manifest, area: "nowhere" }).success).toBe(false);
    expect(PackManifest.safeParse({ ...manifest, processors: ["openai"] }).success).toBe(true);
    expect(PackManifest.safeParse({ ...manifest, processors: ["acme"] }).success).toBe(false);
    expect(PackManifest.safeParse({ ...manifest, reports: ["a", "a"] }).success).toBe(false);
    expect(PackManifest.safeParse({ ...manifest, extends: "bookkeeping" }).success).toBe(true);
    expect(PackManifest.safeParse({ ...manifest, extends: "demo" }).success).toBe(false);
    expect(PackManifest.safeParse({ ...manifest, extends: "Not A Pack" }).success).toBe(false);
  });
});
