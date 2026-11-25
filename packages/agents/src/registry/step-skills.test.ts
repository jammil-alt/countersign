// Rules and AI written in a step, stored behind it as a skill; Save as skill (stream F). Pure
// checks first, then against a real database as cs_worker.

import type { steps } from "@countersign/core";
import { skill, skillVersion } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../log/harness.test-helper";
import { resolveCustomSkill } from "./skills";
import {
  agentStepSkillPrefix,
  clientLiteralIn,
  fieldsToSchema,
  isStepSkill,
  publishStepSkills,
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
    expect(stepSkillSlug("0190A1B2-C3D4", "n_1")).toBe("step-0190a1b2-c3d4-n-1");
    expect(stepSkillRef("A1", "n1")).toBe("custom:step-a1-n1");
    // Two agents never share one: the agent is in the key.
    expect(stepSkillRef("agent-a", "n1")).not.toBe(stepSkillRef("agent-b", "n1"));
    expect(agentStepSkillPrefix("agent-a")).toBe("step-agent-a-");
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

describe("a shared skill carries nothing of one client (invariant 11)", () => {
  it("finds a record id, an email or a phone in the rows or the text", () => {
    const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const row = (v: string) => ({
      id: "r1",
      when: { match: "all", rules: [{ field: "{{input.vendor}}", op: "=", value: v }] },
      set: { account: "Materials" },
    });
    const rules = (v: string) => rulesStep({ rules: { rows: [row(v)] } as never });
    expect(clientLiteralIn(rules("Home Depot"))).toBeNull();
    expect(clientLiteralIn(rules(id))).toContain(id.slice(0, 10));
    expect(clientLiteralIn(rules("ap@acme.com"))).toContain("ap@acme.com");
    expect(clientLiteralIn(aiStep({ ai: { text: "Ask Maria on +14155550123." } }))).toContain(
      "+1415",
    );
    expect(clientLiteralIn(aiStep({ ai: { text: "Ask about {{trigger.vendor}}." } }))).toBeNull();
    // A rule's own id is a label, not a record.
    expect(
      clientLiteralIn(
        rulesStep({ rules: { rows: [{ ...row("x"), id: id.replace(/^0/, "a") }] } as never }),
      ),
    ).toBeNull();
  });

  it("carries no values into a shared skill, and keeps them in a client's", () => {
    const text = { id: "custom:s", name: "S", description: "S", category: "c" };
    const step = rulesStep({ rules: { ...rulesStep().rules, values: { limit: 500 } } as never });
    expect(stepSkillDefinition(step, text)).toMatchObject({
      parameters: [{ name: "limit", default: 500 }],
    });
    expect(stepSkillDefinition(step, text, { shared: true })).not.toHaveProperty("parameters");
  });
});

describe.skipIf(!harness)("stored in the skill tables", () => {
  const h = harness as Harness;

  const store = (agentId: string, step: steps.DoStep) =>
    h.client(h.A, (tx) =>
      storeStepSkills(tx, {
        agentId,
        tenantId: h.A.tenantId,
        workflow: workflow(step),
        authorId: null,
        tools: h.tools,
      }),
    );
  const resolve = (ref: string) =>
    h.client(h.A, (tx) => resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref }));
  const publishPins = (agentId: string, pins: string[]) =>
    h.client(h.A, (tx) =>
      publishStepSkills(tx, {
        agentId,
        tenantId: h.A.tenantId,
        skills: pins.map((skill) => ({ skill })),
      }),
    );
  const edited = (step: steps.DoStep, account: string) =>
    rulesStep({
      id: step.id,
      rules: {
        rows: [{ ...(step.rules?.rows?.[0] as object), set: { account } } as never],
      },
    });

  it("stores a step's rules as a draft, a new version only when they change, and never live", async () => {
    const step = rulesStep();
    const ref = stepSkillRef("agent-1", step.id);
    const first = await store("agent-1", step);
    expect(first).toEqual([{ stepId: step.id, ref, version: 1, pin: `${ref}@1`, changed: true }]);
    // A draft: the live agent (unpinned) reads nothing, the pin reads it.
    expect(await resolve(ref)).toBeNull();
    expect((await resolve(`${ref}@1`))?.version).toBe(1);
    expect(
      (await resolve(`${ref}@1`)) && isStepSkill((await resolve(`${ref}@1`))?.definition as never),
    ).toBe(true);

    expect((await store("agent-1", step))[0]).toMatchObject({ version: 1, changed: false });
    expect((await store("agent-1", edited(step, "Supplies")))[0]).toMatchObject({
      version: 2,
      pin: `${ref}@2`,
      changed: true,
    });
    const versions = await h.t.db
      .select()
      .from(skillVersion)
      .innerJoin(skill, eq(skill.id, skillVersion.skillId))
      .where(eq(skill.slug, stepSkillSlug("agent-1", step.id)));
    expect(versions.map((v) => [v.skill_version.version, v.skill_version.status]).sort()).toEqual([
      [1, "draft"],
      [2, "draft"],
    ]);
    // Another client never reads it (invariant 1).
    expect(
      await h.client(h.B, (tx) =>
        resolveCustomSkill(tx, { tenantId: h.B.tenantId, ref: `${ref}@1` }),
      ),
    ).toBeNull();
  });

  it("keeps two agents forked from one template apart, step ids and all", async () => {
    const step = rulesStep({ id: "shared-step-id" });
    const [a] = await store("fork-a", step);
    const [b] = await store("fork-b", edited(step, "Supplies"));
    expect(a?.ref).not.toBe(b?.ref);
    expect((await resolve(`${a?.ref}@1`))?.definition.rules?.[0]?.set).toEqual({
      account: "Materials",
    });
    expect((await resolve(`${b?.ref}@1`))?.definition.rules?.[0]?.set).toEqual({
      account: "Supplies",
    });
    // Editing one leaves the other's version where it was.
    await store("fork-a", edited(step, "Fuel"));
    expect((await resolve(`${b?.ref}@1`))?.version).toBe(1);
    expect(await resolve(`${b?.ref}@2`)).toBeNull();
  });

  it("a draft save leaves the live agent's skill as it was; publishing the version pins and makes live", async () => {
    const step = rulesStep({ id: "live-step" });
    const ref = stepSkillRef("agent-live", step.id);
    const v1 = (await store("agent-live", step))[0];
    // The agent version that pins @1 is published: the skill version goes live.
    expect(await publishPins("agent-live", [v1?.pin ?? ""])).toEqual([{ ref, version: 1 }]);
    expect((await resolve(ref))?.version).toBe(1);

    // A later draft save makes version 2, a draft: the live agent still runs version 1.
    const v2 = (await store("agent-live", edited(step, "Supplies")))[0];
    expect(v2?.version).toBe(2);
    expect((await resolve(ref))?.version).toBe(1);
    expect((await resolve(ref))?.definition.rules?.[0]?.set).toEqual({ account: "Materials" });
    expect((await resolve(`${ref}@1`))?.definition.rules?.[0]?.set).toEqual({
      account: "Materials",
    });

    // Publishing the new agent version, which pins @2, makes 2 live; 1 is retired and kept.
    expect(await publishPins("agent-live", [v2?.pin ?? ""])).toEqual([{ ref, version: 2 }]);
    expect((await resolve(ref))?.version).toBe(2);
    expect((await resolve(`${ref}@1`))?.version).toBe(1);
    // Publishing again does nothing more, and another agent's pins and unpinned refs are left alone.
    expect(await publishPins("agent-live", [v2?.pin ?? ""])).toEqual([]);
    const other = (await store("agent-other", step))[0];
    expect(await publishPins("agent-live", [other?.pin ?? "", other?.ref ?? ""])).toEqual([]);
    expect(await resolve(other?.ref ?? "")).toBeNull();
  });

  it("stores AI instructions as a task skill and skips steps that write nothing", async () => {
    const empty = rulesStep({ id: "empty", rules: { rows: [] } });
    const out = await h.client(h.A, (tx) =>
      storeStepSkills(tx, {
        agentId: "agent-ai",
        tenantId: h.A.tenantId,
        workflow: workflow(aiStep(), empty),
        authorId: null,
        tools: h.tools,
      }),
    );
    expect(out.map((s) => s.stepId)).toEqual(["step-ai"]);
    expect((await resolve(out[0]?.pin ?? ""))?.definition.mode).toBe("task");
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
    const live = await resolve(mine.ref);
    expect(live?.source).toBe("client");
    expect(live && isStepSkill(live.definition)).toBe(false);

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

  it("refuses to share a step that names a record of this client, and says what to take out", async () => {
    const withEmail = rulesStep({
      id: "n12",
      rules: {
        rows: [
          {
            id: "r1",
            when: {
              match: "all",
              rules: [{ field: "{{input.email}}", op: "=", value: "ap@acme.com" }],
            },
            set: { account: "Materials" },
          },
        ],
        values: { limit: 500 },
      } as never,
    });
    const share = (step: steps.DoStep, tenantId: string | null) =>
      h.ops((tx) =>
        saveStepAsSkill(tx, {
          tenantId,
          step,
          name: "Acme rule",
          description: "A rule.",
          authorId: null,
          tools: h.tools,
        }),
      );
    await expect(share(withEmail, null)).rejects.toThrow(
      /names a record of this client: "ap@acme.com"/,
    );
    await expect(
      share(aiStep({ id: "n13", ai: { text: "Ask Maria at +14155550123." } }), null),
    ).rejects.toThrow(/names a record of this client/);

    // This client only stays as it is, and keeps its values as the skill's defaults.
    const mine = await h.client(h.A, (tx) =>
      saveStepAsSkill(tx, {
        tenantId: h.A.tenantId,
        step: withEmail,
        name: "Acme rule",
        description: "A rule.",
        authorId: null,
        tools: h.tools,
      }),
    );
    expect((await resolve(mine.ref))?.definition.parameters).toEqual([
      expect.objectContaining({ name: "limit", default: 500 }),
    ]);

    // Shared with nothing of the client's: the values never go in as defaults.
    const clean = rulesStep({
      id: "n14",
      rules: { ...rulesStep().rules, values: { limit: 500 } } as never,
    });
    const sharedClean = await share(clean, null);
    const read = await h.ops((tx) =>
      resolveCustomSkill(tx, { tenantId: null, ref: sharedClean.ref }),
    );
    expect(read?.definition.parameters).toBeUndefined();
  });
});
