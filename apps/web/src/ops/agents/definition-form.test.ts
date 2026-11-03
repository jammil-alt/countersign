import { type SkillOption, validateBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE } from "../../test/fixtures";
import { describeChanges } from "./changes";
import {
  applyForm,
  blankBundle,
  checkBundle,
  formFromBundle,
  slugify,
  validateForm,
} from "./definition-form";

const PRICE_WATCH: SkillOption = {
  id: "custom:price-watch",
  name: "Price watch",
  description: "Flags price changes",
  category: "custom",
  source: "shared",
  version: 1,
  settings: [
    {
      key: "threshold_pct",
      label: "Threshold %",
      type: "number",
      default: 5,
      clientSpecific: false,
    },
    { key: "notify", label: "Notify", type: "boolean", default: true, clientSpecific: false },
    {
      key: "channel",
      label: "Channel",
      type: "enum",
      default: "thread",
      options: ["thread", "email"],
      clientSpecific: false,
    },
  ],
  requiresConnectors: [],
};

describe("definition form", () => {
  it("round-trips a bundle without touching its workflows", () => {
    const form = formFromBundle(FORK_BUNDLE);
    expect(form).toMatchObject({
      name: "Material costs",
      modelId: "claude-opus-5-5",
      maxTokens: "4096",
      mode: "suggest_only",
      approver: "",
      maxCostUsd: "0.50",
    });
    const back = applyForm(FORK_BUNDLE, form, []);
    expect(back).toEqual(FORK_BUNDLE);
  });

  it("refuses an empty name, bad numbers and a cost that is not a dollar amount", () => {
    const form = {
      ...formFromBundle(FORK_BUNDLE),
      name: "  ",
      maxTokens: "0",
      maxSteps: "2.5",
      maxCostUsd: "0.123456",
    };
    expect(validateForm(form, [])).toEqual({
      name: expect.any(String),
      maxTokens: expect.any(String),
      maxSteps: expect.any(String),
      maxCostUsd: expect.any(String),
    });
    expect(
      validateForm({ ...form, name: "x", maxTokens: "1", maxSteps: "3", maxCostUsd: "-1" }, []),
    ).toEqual({ maxCostUsd: expect.any(String) });
  });

  it("checks skill settings against each skill's settings schema", () => {
    const form = {
      ...formFromBundle(FORK_BUNDLE),
      skills: [
        { skill: "custom:price-watch", settings: { threshold_pct: "lots", channel: "fax" } },
        { skill: "custom:price-watch@1", settings: {} },
      ],
    };
    expect(validateForm(form, [PRICE_WATCH])).toEqual({
      "skills.0.threshold_pct": "Threshold % must be a number.",
      "skills.0.channel": "Channel must be one of thread, email.",
      "skills.1": "This skill is listed twice.",
    });
  });

  it("writes overrides by the setting's type and drops empty ones (the default applies)", () => {
    const form = {
      ...formFromBundle(FORK_BUNDLE),
      skills: [
        {
          skill: "custom:price-watch",
          settings: { threshold_pct: "7.5", notify: false, channel: "", kept: "as is" },
        },
      ],
      mode: "act" as const,
      approver: "client_admin",
      maxCostUsd: "1.25",
    };
    const bundle = applyForm(FORK_BUNDLE, form, [PRICE_WATCH]);
    expect(bundle.definition.skills).toEqual([
      {
        skill: "custom:price-watch",
        settings: { threshold_pct: 7.5, notify: false, kept: "as is" },
      },
    ]);
    expect(bundle.definition.permissions).toEqual({ mode: "act", approver: "client_admin" });
    expect(bundle.definition.budgets.maxCostUsd).toBe("1.25");
    expect(bundle.workflows).toBe(FORK_BUNDLE.workflows);
    expect(checkBundle(bundle)).toBeNull();
  });

  it("makes a blank bundle: suggest only, one manual workflow with no steps, a fresh trigger id", () => {
    const bundle = blankBundle(
      {
        name: "Card receipts",
        role: "Expenses",
        mission: "Chase receipts",
        instructions: "",
        modelId: "",
      },
      () => "0190a1b2-0000-7000-8000-000000000001",
    );
    expect(bundle.definition.permissions.mode).toBe("suggest_only");
    expect(bundle.definition.model.id).toBe("claude-opus-5-5");
    expect(bundle.workflows).toHaveLength(1);
    expect(bundle.workflows[0]?.workflow.trigger.id).toBe("0190a1b2-0000-7000-8000-000000000001");
    expect(bundle.workflows[0]?.workflow.steps).toEqual([]);
    expect(validateBundle(bundle, {}).errors).toEqual([]);
    expect(slugify("Card receipts — Q4!")).toBe("card-receipts-q4");
  });
});

describe("changes as sentences", () => {
  const labels = {
    "workflow:new-bill": "New bill",
    "step:ask": "Ask Jammil",
    "path:low": "Any line below 90%",
    "step:confidence": "Match confidence",
  };

  it("writes fields, entities, moves and reorders as lines", () => {
    const lines = describeChanges(
      [
        {
          kind: "changed",
          entity: "bundle",
          path: "bundle#/definition/instructions",
          before: "Itemize bills.",
          after: "Itemize every bill.",
        },
        {
          kind: "added",
          entity: "step:notify",
          path: "step:notify",
          after: { id: "notify", kind: "notify", name: "Tell purchasing" },
        },
        { kind: "removed", entity: "skill:docs.extract", path: "skill:docs.extract", before: {} },
        {
          kind: "changed",
          entity: "step:ask",
          path: "step:ask#/timeout",
          before: "2 days",
          after: "1 day",
        },
        {
          kind: "moved",
          entity: "step:ask",
          path: "step:ask#@location",
          before: "path:low>steps",
          after: "workflow:new-bill>steps",
        },
        {
          kind: "reordered",
          entity: "workflow:new-bill>steps",
          path: "workflow:new-bill>steps#@order",
          before: ["a", "b"],
          after: ["b", "a"],
        },
        {
          kind: "changed",
          entity: "skill:custom:price-watch",
          path: "skill:custom:price-watch#/settings/threshold_pct",
          before: 5,
          after: 7,
        },
      ],
      labels,
    );
    expect(lines.map((l) => l.text)).toEqual([
      "Instructions changed",
      "Added notify step “Tell purchasing”",
      "Removed skill docs.extract",
      "Step “Ask Jammil”: timeout changed",
      "Moved step “Ask Jammil” from fork path “Any line below 90%” to workflow “New bill”",
      "Reordered the steps in workflow “New bill”",
      "Skill custom:price-watch: setting threshold_pct changed",
    ]);
    expect(lines[0]).toMatchObject({ before: "Itemize bills.", after: "Itemize every bill." });
    expect(lines[6]).toMatchObject({ before: "5", after: "7" });
  });
});
