// The Builder in the step model through the API (docs/step-model-plan.md §10, build item 9): a draft
// written in the step is stored behind its steps and pinned in its first version, as the workflow
// builder saves one (stream F), so it runs; the draft route offers Save as skill where another of
// the client's agents writes the same, and the Loop designer for a Loop written in the step. The
// model is scripted (FakeModel), in the step model.

import { agentStepSkillPrefix } from "@countersign/agents";
import { TESTKIT_QUERY_TOOL } from "@countersign/connectors";
import { skill, skillVersion } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;

const CLASSIFY = "Say which category the charge is in, with one sentence on why.";

/** A v5 bundle: read the records, classify with AI written in the step, look into it, end. */
function bundle(name: string) {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "Expenses", mission: "Classify card charges" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5" },
      instructions: "Classify card charges.",
      skills: [],
    },
    workflows: [
      {
        slug: "main",
        name: "Classify",
        workflow: {
          schemaVersion: 5,
          triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
          outputs: [{ id: "r1", name: "Classified", kind: "nothing" }],
          steps: [
            {
              id: "read",
              kind: "do",
              name: "Find the charges",
              doneBy: "rules",
              uses: { type: "action", action: TESTKIT_QUERY_TOOL },
              input: { nameContains: "card" },
            },
            {
              id: "classify",
              kind: "do",
              name: "Say what the charge is for",
              doneBy: "ai",
              ai: { text: CLASSIFY },
              input: { charge: "{{steps.read.output.records}}" },
              output: [{ name: "category", type: "text", required: true }],
            },
            {
              id: "look",
              kind: "loop",
              name: "Look into the odd ones",
              goal: "Explain each charge the category doesn't fit.",
              reads: [TESTKIT_QUERY_TOOL],
              output: [{ name: "notes", type: "text", required: true }],
            },
            { id: "done", kind: "end", name: "Done", outputs: ["r1"] },
          ],
        },
      },
    ],
  };
}

const draftAnswer = (name: string) => ({
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It classifies card charges.",
      gaps: [],
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      startFromTemplate: null,
      bundle: bundle(name),
    },
  },
});

describe.skipIf(!h)("the Builder in the step model", () => {
  const H = h as NonNullable<typeof h>;

  it("stores a step written in the step and pins it in the draft's first version", async () => {
    model.push(draftAnswer("Charge sorter"));
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Classify card charges",
      clientId: H.A.tenantId,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = res.json as {
      agent: { id: string };
      version: { version: number };
      bundle: { definition: { skills: { skill: string }[] }; workflows: Json[] };
      loops: { stepId: string; loop: Json; text: string }[];
      saveAsSkill: unknown[];
    };
    expect(out.version.version).toBe(1);
    const prefix = `custom:${agentStepSkillPrefix(out.agent.id)}`;
    const pins = out.bundle.definition.skills
      .map((s) => s.skill)
      .filter((s) => s.startsWith(prefix));
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatch(/@1$/);
    // The skill behind the step is the client's own, a draft until the agent is published.
    const slug = (pins[0] as string).slice("custom:".length).split("@")[0] as string;
    const [row] = await H.t.db.select().from(skill).where(eq(skill.slug, slug));
    expect(row?.tenantId).toBe(H.A.tenantId);
    const [v] = await H.t.db
      .select()
      .from(skillVersion)
      .where(eq(skillVersion.skillId, row?.id as string));
    expect(v?.status).toBe("draft");
    expect(JSON.stringify(v?.definition)).toContain(CLASSIFY);
    // The Loop written in the step is offered to the Loop designer, never published by itself.
    expect(out.loops).toEqual([
      expect.objectContaining({
        loop: expect.objectContaining({
          name: "Look into the odd ones",
          reads: [TESTKIT_QUERY_TOOL],
        }),
        text: expect.stringContaining("Loop designer"),
      }),
    ]);
    expect(out.saveAsSkill).toEqual([]);
  });

  it("suggests Save as skill when another of the client's agents writes the same instructions", async () => {
    model.push(draftAnswer("Charge sorter two"));
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Classify card charges again",
      clientId: H.A.tenantId,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = res.json as {
      saveAsSkill: { stepName: string; alsoIn: { agent: { name: string } }[]; text: string }[];
    };
    expect(out.saveAsSkill).toEqual([
      expect.objectContaining({
        stepName: "Say what the charge is for",
        alsoIn: [
          expect.objectContaining({ agent: expect.objectContaining({ name: "Charge sorter" }) }),
        ],
      }),
    ]);
    // Never another client's: B's draft doesn't see A's agents.
    model.push(draftAnswer("Charge sorter b"));
    const b = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Classify card charges",
      clientId: H.B.tenantId,
    });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect((b.json as { saveAsSkill: unknown[] }).saveAsSkill).toEqual([]);
  });
});
