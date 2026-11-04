// The client's language on the timeline (docs/plan.md §1.18): summaries render in it with English
// as the fallback; the platform's own words follow it; operator-written labels stay as written.
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, RUN, SKILL, WRITE_TOOL, wf } from "./fakes.test-helper";

describe("the client's language", () => {
  it("renders summaries and the timeline's own words in it, with English as the fallback", async () => {
    const h = new Harness({ ...RUN, language: "de" });
    h.handlers.read = () => ({ kind: "done", output: { lines: 3, vendor: "Acme" } });
    h.handlers.write = (req) => ({ kind: "done", output: req.input });
    await executeWorkflow(
      new FakeStepRunner(),
      h.context({
        catalog: {
          skills: {
            [SKILL.id]: {
              ...SKILL,
              summary: {
                en: "Read {{lines}} lines",
                de: "{{lines}} Zeilen von {{vendor}} gelesen",
              },
            },
          },
          // No German version: the English one.
          tools: { [WRITE_TOOL.id]: { ...WRITE_TOOL, summary: { en: "Updated {{name}}" } } },
        },
      }),
      wf([
        { id: "read", kind: "skill", name: "Read", skill: SKILL.id },
        {
          id: "write",
          kind: "action",
          name: "Update the record",
          tool: WRITE_TOOL.id,
          input: { name: "{{steps.read.output.vendor}}" },
        },
        {
          id: "s",
          kind: "skill",
          name: "Check",
          skill: "x.y",
          // The label stays as the operator wrote it.
          client: { visible: true, label: "Preise geprüft" },
        },
      ]),
      {},
    );
    expect(h.row("read")?.summary).toBe("3 Zeilen von Acme gelesen");
    expect(h.row("write")?.summary).toBe("Updated Acme");
    expect(h.row("s")?.summary).toBe("Preise geprüft: erledigt");
  });

  it("writes English when the run names no language", async () => {
    const h = new Harness();
    await executeWorkflow(
      new FakeStepRunner(),
      h.context(),
      wf([
        {
          id: "s",
          kind: "skill",
          name: "Check",
          skill: "x.y",
          client: { visible: true, label: "Checked prices" },
        },
      ]),
      {},
    );
    expect(h.row("s")?.summary).toBe("Checked prices: done");
  });
});
