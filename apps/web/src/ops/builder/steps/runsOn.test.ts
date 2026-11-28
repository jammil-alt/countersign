import { describe, expect, it } from "vitest";
import { NO_USES_CONTEXT, type UsesContext } from "./options";
import { agentModelsOf, picksModel, runsOn } from "./runsOn";
import type { Step } from "./types";

const ctx: UsesContext = {
  ...NO_USES_CONTEXT,
  skills: [
    {
      ref: "read-document",
      name: "Read document",
      description: "",
      kind: "ai",
      input: [],
      output: [],
      mode: "task",
      model: { id: "claude-haiku-5-5" },
    },
  ],
};
const agent = agentModelsOf({
  definition: { model: { id: "claude-sonnet-5-5" }, skills: [{ id: "other", model: { id: "x" } }] },
});
const ai = (extra: Record<string, unknown>) =>
  ({ id: "s", kind: "do", name: "Read", doneBy: "ai", input: {}, ...extra }) as unknown as Step;

describe("runsOn", () => {
  it("names the model an AI step runs on, most specific first", () => {
    // Written in the step, nothing set: the agent's own model.
    expect(runsOn(ai({}), ctx, agent)).toEqual({ id: "claude-sonnet-5-5", from: "default" });
    // An AI skill: its recommended model.
    expect(runsOn(ai({ uses: { type: "skill", skill: "read-document" } }), ctx, agent)).toEqual({
      id: "claude-haiku-5-5",
      from: "skill",
    });
    // Set on the step: that one.
    expect(
      runsOn(
        ai({
          uses: { type: "skill", skill: "read-document" },
          ai: { model: { id: "claude-opus-5-5" } },
        }),
        ctx,
        agent,
      ),
    ).toEqual({ id: "claude-opus-5-5", from: "step" });
  });

  it("names none for a step no model it picks runs", () => {
    const rules = {
      id: "r",
      kind: "do",
      name: "Code",
      doneBy: "rules",
      input: {},
    } as unknown as Step;
    expect(picksModel(rules)).toBe(false);
    expect(runsOn(rules, ctx, agent)).toBeNull();
    const action = ai({ uses: { type: "action", action: "qbo.bills.create" } });
    expect(runsOn(action, ctx, agent)).toBeNull();
    expect(runsOn(ai({}), ctx, null)).toBeNull();
  });
});
