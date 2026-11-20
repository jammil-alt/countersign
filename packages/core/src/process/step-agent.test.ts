// PLATFORM_QA CONS-1: a skill step's `agent` (ARCHITECTURE §10.1: "another agent of the same
// client; default the owner"). The executor's agent port runs every skill step as the run's own
// agent, so the validator refuses a step that names another one, rather than letting it publish and
// then run as the owner (or fail on a skill the owner doesn't have).
import { describe, expect, it } from "vitest";
import type { SkillStep as V3SkillStep } from "../schemas/workflow";
import { bundleInput, ctx, edit, workflowInput } from "../testing/fixtures";
import { validateWorkflow } from "../workflow/validate";
import type { Process } from "./schema";
import { validateProcess } from "./validate";

/** The owner: may ask `helper`, and has no skills of its own. */
const owner = { ...bundleInput().definition, skills: [], canCommand: ["helper"] } as never;

const process = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    {
      id: "ask",
      kind: "skill",
      name: "Ask the helper",
      skill: "docs.extract",
      agent: "helper",
      input: { documentId: "d-1" },
    },
  ],
} as unknown as Process;

const codesOf = (errors: readonly { code: string; stepId: string | null; field: string }[]) =>
  errors.map((e) => `${e.code}@${e.stepId}:${e.field}`);

describe("a skill step's agent", () => {
  it("(PLATFORM_QA CONS-1) a skill step naming another agent is refused, since the executor runs it as the owner", () => {
    const v = validateProcess(process, { ...ctx, agent: owner });
    // Not publishable: the step names another agent, and the owner it would run as lacks the skill.
    expect(codesOf(v.errors)).toEqual(
      expect.arrayContaining(["step_agent_unsupported@ask:agent", "skill_not_allowed@ask:skill"]),
    );
    // A template (no owner yet) is refused the same way.
    expect(codesOf(validateProcess(process, ctx).errors)).toContain(
      "step_agent_unsupported@ask:agent",
    );
  });

  it("(PLATFORM_QA CONS-1) the v3 validator refuses it too", () => {
    const wf = edit(workflowInput(), (w) => {
      (w.steps[0] as V3SkillStep).agent = "helper";
    });
    const v = validateWorkflow(wf, { ...ctx, agent: owner });
    expect(codesOf(v.errors)).toEqual(
      expect.arrayContaining(["step_agent_unsupported@s1:agent", "skill_not_allowed@s1:skill"]),
    );
  });
});
