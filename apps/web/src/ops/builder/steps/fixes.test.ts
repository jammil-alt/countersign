import { describe, expect, it } from "vitest";
import { fixFor } from "./fixes";
import { NO_USES_CONTEXT } from "./options";
import type { Workflow } from "./types";

const wf = (w: Partial<Workflow>) =>
  ({ schemaVersion: 5, triggers: [], outputs: [], steps: [], ...w }) as unknown as Workflow;

describe("fixFor", () => {
  it("takes a removed output off an End, and ends the main line", () => {
    const w = wf({
      outputs: [{ id: "o", name: "Done", kind: "nothing", fields: [] }] as never,
      steps: [{ id: "e", kind: "end", name: "", outputs: ["o", "gone"] }] as never,
    });
    const fix = fixFor({ at: "e", code: "unknown_output", message: "" }, w, NO_USES_CONTEXT);
    const after = fix.apply?.run(w) as Workflow;
    expect((after.steps[0] as { outputs: string[] }).outputs).toEqual(["o"]);
    const open = wf({ steps: [{ id: "d", kind: "do", name: "Read" }] as never });
    const ended = fixFor({ code: "no_end", message: "" }, open, NO_USES_CONTEXT).apply?.run(open);
    expect(ended?.steps.at(-1)?.kind).toBe("end");
  });

  it("offers nothing it can't settle on its own", () => {
    const w = wf({});
    expect(fixFor({ at: "x", code: "goal_missing", message: "" }, w, NO_USES_CONTEXT)).toEqual({});
    // A write output with no action and no single action that fits: the Builder's, not a click.
    const out = wf({ outputs: [{ id: "o", name: "Bill", kind: "write", fields: [] }] as never });
    expect(
      fixFor({ at: "o", code: "output_incomplete", message: "" }, out, NO_USES_CONTEXT).apply,
    ).toBeUndefined();
  });
});
