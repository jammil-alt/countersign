// FLOW-6 and FLOW-9 (QA 2026-11-19): the canvas's edits carried onto a newer draft.
import type { ProcessAgentBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { PROCESS_BUNDLE } from "../../test/fixtures";
import { rebase } from "./rebase";

type Step = { id: string; name: string };

const base = PROCESS_BUNDLE as ProcessAgentBundle;
const read = (b: unknown) => b as ProcessAgentBundle;

function editMain(b: ProcessAgentBundle, fn: (steps: Step[]) => Step[]): ProcessAgentBundle {
  return {
    ...b,
    workflows: b.workflows.map((w) =>
      w.slug === "new-bill"
        ? { ...w, workflow: { ...w.workflow, steps: fn(w.workflow.steps as Step[]) } }
        : w,
    ),
  } as ProcessAgentBundle;
}

const stepIds = (b: ProcessAgentBundle | null) =>
  ((b?.workflows.find((w) => w.slug === "new-bill")?.workflow.steps ?? []) as Step[]).map(
    (s) => s.id,
  );

describe("rebase", () => {
  it("takes theirs when the canvas has no edits, and keeps ours when theirs has none", () => {
    const theirs = editMain(base, (s) => s.filter((x) => x.id !== "update"));
    expect(rebase(base, base, theirs, read)).toBe(theirs);
    expect(rebase(base, theirs, base, read)).toBe(theirs);
  });

  it("carries the canvas's edit onto theirs", () => {
    const theirs = editMain(base, (s) => s.filter((x) => x.id !== "update"));
    const ours = editMain(base, (s) => s.filter((x) => x.id !== "find"));
    const out = rebase(base, ours, theirs, read);
    expect(stepIds(out)).not.toContain("update");
    expect(stepIds(out)).not.toContain("find");
    expect(stepIds(out)).toContain("confidence");
  });

  it("gives up where both changed the same thing", () => {
    const rename = (name: string) =>
      editMain(base, (s) => s.map((x) => (x.id === "find" ? { ...x, name } : x)));
    expect(rebase(base, rename("Ours"), rename("Theirs"), read)).toBeNull();
  });
});
