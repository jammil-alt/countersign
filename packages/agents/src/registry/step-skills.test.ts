// Rules and AI written in a step, stored behind it as a skill; Save as skill (stream F). Pure
// checks first, then against a real database as cs_worker.

import type { steps } from "@countersign/core";
import { skill, skillVersion } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../log/harness.test-helper";
import { resolveCustomSkill } from "./skills";
import {
  fieldsToSchema,
  isStepSkill,
  saveAsSkillRefusal,
  saveStepAsSkill,
  stepSkillDefinition,
  stepSkillRef,
  stepSkillSlug,
  storeStepSkills,
  writtenInStep,
} from "./step-skills";

const rulesStep = (over: Partial<steps.DoStep> = {}): steps.DoStep =>
  ({
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    kind: "do",
    name: "Pick the account",
    doneBy: "rules",
    input: { vendor: "{{trigger.vendor}}" },
    rules: {
      rows: [
        {
          id: "home-depot",
          name: "Home Depot is materials",
          when: {
            match: "all",
            rules: [{ field: "{{input.vendor}}", op: "=", value: "Home Depot" }],
          },
          set: { account: "Materials" },
        },
      ],
    },
    output: [{ name: "account", type: "text", required: true }],
    ...over,
  }) as steps.DoStep;

const aiStep = (over: Partial<steps.DoStep> = {}): steps.DoStep =>
  ({
    id: "step-ai",
    kind: "do",
    name: "Read the note",
    doneBy: "ai",
    input: { note: "{{trigger.note}}" },
    ai: { text: "Say whether the note asks for a refund." },
    output: [{ name: "refund", type: "yes_no", required: true }],
    ...over,
  }) as steps.DoStep;

const workflow = (...list: steps.Step[]) =>
  ({ schemaVersion: 5, triggers: [], outputs: [], steps: list }) as unknown as steps.Workflow;

describe("what a step writes in itself", () => {
  it("names the skill behind a step by its id", () => {
    expect(stepSkillSlug("0190A1B2_c3d4")).toBe("step-0190a1b2-c3d4");
    expect(stepSkillRef("n1")).toBe("custom:step-n1");
  });

  it("is rules with rows, or AI with text, and nothing else", () => {
    expect(writtenInStep(rulesStep())).toBe("rules");
    expect(writtenInStep(aiStep())).toBe("ai");
    expect(writtenInStep(rulesStep({ rules: { rows: [] } }))).toBeNull();
    expect(writtenInStep(aiStep({ ai: { text: "  " } }))).toBeNull();
    // A step that uses something has its instructions elsewhere.
    expect(writtenInStep(rulesStep({ uses: { type: "skill", skill: "custom:x" } }))).toBeNull();
  });

  it("becomes a rules skill, or a task on a model, that never writes", () => {
    const text = { id: "custom:s", name: "S", description: "S", category: "c" };
    const r = stepSkillDefinition(rulesStep(), text) as Record<string, unknown>;
    expect(r).toMatchObject({ mode: "tool", method: "rules", tools: [] });
    expect(r.rules).toHaveLength(1);
    const a = stepSkillDefinition(aiStep(), text) as Record<string, unknown>;
    expect(a).toMatchObject({
      mode: "task",
      method: "ai",
      instructions: "Say whether the note asks for a refund.",
    });
    expect(a.model).toBeTruthy();
    expect(stepSkillDefinition(rulesStep({ rules: { rows: [] } }), text)).toBeNull();
  });

  it("writes the output fields as a schema, required ones listed", () => {
    expect(
      fieldsToSchema([
        { name: "total", type: "money", required: true },
        {
          name: "lines",
          type: "list",
          required: false,
          of: [{ name: "sku", type: "text", required: true }],
        },
      ]),
    ).toMatchObject({
      required: ["total"],
      properties: {
        total: { type: "object" },
        lines: { type: "array", items: { required: ["sku"] } },
      },
    });
  });
});

describe("save as skill, refused", () => {
  it("says why in plain words", () => {
    expect(saveAsSkillRefusal(rulesStep())).toBeNull();
    expect(saveAsSkillRefusal({ id: "l", kind: "loop", name: "", goal: "" } as steps.Step)).toMatch(
      /Loop designer/,
    );
    expect(saveAsSkillRefusal({ id: "w", kind: "wait", name: "" } as steps.Step)).toMatch(
      /Only a Do step/,
    );
    expect(saveAsSkillRefusal(rulesStep({ uses: { type: "skill", skill: "custom:x" } }))).toMatch(
      /already uses/,
    );
    expect(saveAsSkillRefusal(rulesStep({ doneBy: "person" }))).toMatch(/rules or by AI/);
    expect(saveAsSkillRefusal(rulesStep({ rules: { rows: [] } }))).toMatch(/at least one rule/);
    expect(saveAsSkillRefusal(aiStep({ ai: {} }))).toMatch(/Write what the AI does/);
  });
});

const harness = await createHarness();
afterAll(() => harness?.close());

describe.skipIf(!harness)("stored in the skill tables", () => {
  const h = harness as Harness;

  it("stores a step's rules as its client's skill, a new version only when they change", async () => {
    const step = rulesStep();
    const store = (s: steps.DoStep) =>
      h.client(h.A, (tx) =>
        storeStepSkills(tx, {
          tenantId: h.A.tenantId,
          workflow: workflow(s),
          authorId: null,
          tools: h.tools,
        }),
      );
    expect(await store(step)).toEqual([
      { stepId: step.id, ref: stepSkillRef(step.id), version: 1, changed: true },
    ]);

    // The same text again changes nothing.
    expect((await store(step))[0]).toMatchObject({ version: 1, changed: false });

    // An edit is a version 2, live, and version 1 is kept.
    const edited = rulesStep({
      rules: {
        rows: [{ ...(step.rules?.rows?.[0] as object), set: { account: "Supplies" } } as never],
      },
    });
    expect((await store(edited))[0]).toMatchObject({ version: 2, changed: true });
    const resolved = await h.client(h.A, (tx) =>
      resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref: stepSkillRef(step.id) }),
    );
    expect(resolved?.version).toBe(2);
    expect(resolved && isStepSkill(resolved.definition)).toBe(true);
    const versions = await h.t.db
      .select()
      .from(skillVersion)
      .innerJoin(skill, eq(skill.id, skillVersion.skillId))
      .where(eq(skill.slug, stepSkillSlug(step.id)));
    expect(versions.map((v) => v.skill_version.version).sort()).toEqual([1, 2]);

    // Another client never reads it (invariant 1).
    const other = await h.client(h.B, (tx) =>
      resolveCustomSkill(tx, { tenantId: h.B.tenantId, ref: stepSkillRef(step.id) }),
    );
    expect(other).toBeNull();
  });

  it("stores AI instructions as a task skill and skips steps that write nothing", async () => {
    const empty = rulesStep({ id: "empty", rules: { rows: [] } });
    const out = await h.client(h.A, (tx) =>
      storeStepSkills(tx, {
        tenantId: h.A.tenantId,
        workflow: workflow(aiStep(), empty),
        authorId: null,
        tools: h.tools,
      }),
    );
    expect(out.map((s) => s.stepId)).toEqual(["step-ai"]);
    const resolved = await h.client(h.A, (tx) =>
      resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref: stepSkillRef("step-ai") }),
    );
    expect(resolved?.definition.mode).toBe("task");
  });

  it("saves as a named skill this client's or shared, and the step uses it", async () => {
    const mine = await h.client(h.A, (tx) =>
      saveStepAsSkill(tx, {
        tenantId: h.A.tenantId,
        step: rulesStep({ id: "n9" }),
        name: "Pick the account",
        description: "Sets the account from the vendor.",
        authorId: null,
        tools: h.tools,
      }),
    );
    expect(mine.ref).toBe("custom:pick-the-account");
    expect(mine.step.uses).toEqual({ type: "skill", skill: "custom:pick-the-account" });
    expect(mine.step.rules).toBeUndefined();
    expect(mine.step.output).toBeUndefined();
    expect(mine.step.input).toEqual({ vendor: "{{trigger.vendor}}" });
    const live = await h.client(h.A, (tx) =>
      resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref: mine.ref }),
    );
    expect(live?.source).toBe("client");
    expect(live && isStepSkill(live.definition)).toBe(false);

    // The same name again is "-2", not an overwrite.
    const twice = await h.client(h.A, (tx) =>
      saveStepAsSkill(tx, {
        tenantId: h.A.tenantId,
        step: aiStep({ id: "n10" }),
        name: "Pick the account",
        description: "Reads it by AI.",
        authorId: null,
        tools: h.tools,
      }),
    );
    expect(twice.ref).toBe("custom:pick-the-account-2");

    // Shared: every agent may use it; a client's run reads its copy, made at the agent's next
    // publish (invariant 11), so the client's own rows don't hold it yet.
    const shared = await h.ops((tx) =>
      saveStepAsSkill(tx, {
        tenantId: null,
        step: aiStep({ id: "n11" }),
        name: "Refund check",
        description: "Says whether a note asks for a refund.",
        authorId: null,
        tools: h.tools,
      }),
    );
    const seen = await h.ops((tx) => resolveCustomSkill(tx, { tenantId: null, ref: shared.ref }));
    expect(seen?.source).toBe("shared");
    expect(
      await h.client(h.B, (tx) =>
        resolveCustomSkill(tx, { tenantId: h.B.tenantId, ref: shared.ref }),
      ),
    ).toBeNull();
  });
});
