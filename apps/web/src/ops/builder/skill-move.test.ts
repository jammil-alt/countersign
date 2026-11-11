import { processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { applySkillMove, outputFields, remappable, rewriteReference } from "./skill-move";

const process: processes.Process = processes.Process.parse({
  schemaVersion: 4,
  triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
  steps: [
    { id: "match", kind: "skill", name: "Match", skill: "custom:m@1", input: {} },
    {
      id: "pick",
      kind: "if",
      name: "Sure?",
      paths: [
        {
          id: "sure",
          name: "Sure",
          when: {
            match: "all",
            rules: [{ field: "{{steps.match.output.score}}", op: ">", value: 1 }],
          },
          steps: [],
        },
      ],
      otherwise: { id: "else", steps: [] },
    },
    {
      id: "tell",
      kind: "notify",
      name: "Tell",
      notify: {
        to: ["client_admin"],
        channel: "inbox",
        message: "{{steps.match.output.itemId}} / {{steps.match.output.itemIds}}",
      },
    },
  ],
});

describe("moving a skill step to another version", () => {
  it("rewrites a field and what is under it, never a field that only starts the same", () => {
    expect(rewriteReference("{{steps.m.output.a.b}} {{steps.m.output.ab}}", "m", "a", "x")).toBe(
      "{{steps.m.output.x.b}} {{steps.m.output.ab}}",
    );
  });

  it("names the new version and remaps each picked reference, ids unchanged", () => {
    const refs = [
      { stepId: "tell", at: "notify.message", expr: "steps.match.output.itemId", field: "itemId" },
      {
        stepId: "pick",
        at: "paths.0.when.rules.0.field",
        expr: "steps.match.output.score",
        field: "score",
      },
    ];
    const moved = applySkillMove(
      process,
      "match",
      "custom:m@2",
      new Map([
        [refs[0] as (typeof refs)[number], "catalogItemId"],
        [refs[1] as (typeof refs)[number], "confidence"],
      ]),
    );
    expect(processes.findStep(moved, "match")?.step).toMatchObject({ skill: "custom:m@2" });
    expect(processes.findStep(moved, "tell")?.step).toMatchObject({
      notify: { message: "{{steps.match.output.catalogItemId}} / {{steps.match.output.itemIds}}" },
    });
    const pick = processes.findStep(moved, "pick")?.step;
    expect(pick?.kind === "if" ? pick.paths[0]?.when.rules[0] : null).toMatchObject({
      field: "{{steps.match.output.confidence}}",
    });
    expect(processes.allSteps(moved).map((l) => l.step.id)).toEqual(
      processes.allSteps(process).map((l) => l.step.id),
    );
    // The whole output, and the step's own input, are fixed by hand.
    expect(remappable({ ...(refs[0] as (typeof refs)[number]), field: "*" }, "match")).toBe(false);
    expect(
      remappable({ stepId: "match", at: "input.x", expr: "input.x", field: "x" }, "match"),
    ).toBe(false);
    expect(outputFields({ output: { properties: { a: {}, b: {} } } })).toEqual(["a", "b"]);
  });
});
