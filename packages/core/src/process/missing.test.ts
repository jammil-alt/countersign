// v0.18 (owner, 2026-11-15; docs/plan.md §1.103): a missing step holds a piece nobody has built
// yet where it belongs. It parses, saves and diffs like any step, never publishes (`missing_step`),
// and older bundles parse and hash as before.

import { describe, expect, it } from "vitest";
import { diffBundles } from "../bundle/diff";
import { mergeBundles } from "../bundle/merge";
import { bundleHash, canonicalJson } from "../canonical";
import { type AgentBundle, AgentBundle as AgentBundleSchema } from "../schemas/agent";
import { ToolSpec } from "../schemas/tool";
import type { Step as StepV5 } from "../steps/schema";
import { bundle, ctx, edit } from "../testing/fixtures";
import { Process, Step as StepSchema } from "./schema";
import { missingStepMessage, validateProcess } from "./validate";

const missing = {
  id: "m1",
  kind: "missing",
  name: "Read card charges",
  need: "There is no card feed connector, so it can't read card charges.",
  fill: "connector",
};

function process(steps: Record<string, unknown>[]) {
  return {
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
    steps,
  };
}

const notify = (id: string, message: string) => ({
  id,
  kind: "notify",
  name: "Tell",
  notify: { to: ["client_admin"], message },
});

describe("the missing step's schema", () => {
  it("parses with a need and an optional fill, and adds nothing", () => {
    const parsed = StepSchema.parse(missing);
    expect(parsed).toEqual(missing);
    const { fill: _f, ...noFill } = missing;
    expect(StepSchema.parse(noFill)).toEqual(noFill);
  });

  it("needs one sentence of need, and a fill it knows", () => {
    expect(StepSchema.safeParse({ ...missing, need: " " }).success).toBe(false);
    expect(StepSchema.safeParse({ ...missing, need: "x".repeat(301) }).success).toBe(false);
    expect(StepSchema.safeParse({ ...missing, fill: "agent" }).success).toBe(false);
  });
});

describe("validating a missing step", () => {
  it("is an error that stops a publish, at the step, in the Builder's words", () => {
    const r = validateProcess(process([missing, notify("s2", "Done")]), ctx);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual([
      {
        stepId: "m1",
        field: "",
        code: "missing_step",
        message: missingStepMessage(missing),
      },
    ]);
    expect(r.errors[0]?.message).toBe(
      `"Read card charges" is missing: There is no card feed connector, so it can't read card charges.`,
    );
  });

  it("lets later steps read its output untyped, so the hole is the only problem", () => {
    const r = validateProcess(
      process([missing, notify("s2", "Charges: {{steps.m1.output.charges}}")]),
      ctx,
    );
    expect(r.errors.map((e) => e.code)).toEqual(["missing_step"]);
  });

  it("finds one inside an if's path", () => {
    const r = validateProcess(
      process([
        {
          id: "if1",
          kind: "if",
          name: "Big?",
          paths: [
            {
              id: "p1",
              name: "Big",
              when: { match: "all", rules: [{ field: "{{trigger.total}}", op: ">", value: 5 }] },
              steps: [missing],
            },
          ],
          otherwise: { id: "o1", steps: [] },
        },
      ]),
      ctx,
    );
    expect(r.errors.filter((e) => e.code === "missing_step").map((e) => e.stepId)).toEqual(["m1"]);
  });
});

describe("older bundles and tools", () => {
  it("parse to exactly what they were: no new field appears", () => {
    const p = process([notify("s1", "Hello")]);
    expect(canonicalJson(Process.parse(p))).not.toContain('"need"');
    const spec = {
      id: "docs.get",
      description: "A document",
      input: { type: "object" },
      output: { type: "object" },
      sideEffect: "none",
      verb: "read",
      source: "platform",
    };
    expect(ToolSpec.parse(spec)).toEqual(spec);
  });

  it("hash the same whether or not another bundle holds a missing step", async () => {
    const before = await bundleHash(bundle());
    expect(await bundleHash(AgentBundleSchema.parse(JSON.parse(JSON.stringify(bundle()))))).toBe(
      before,
    );
  });
});

describe("diff and merge", () => {
  /** The step model's missing step: a Do that uses a gap. */
  const gap = {
    id: "m1",
    kind: "do",
    name: "Read card charges",
    uses: { type: "missing", need: missing.need, fill: "connector" },
  } as StepV5;
  const base = (): AgentBundle => bundle();
  const withMissing = (b: AgentBundle): AgentBundle =>
    edit(b, (d) => {
      const w = d.workflows[0]?.workflow;
      if (!w) throw new Error("no workflow");
      w.steps.push(gap);
    });

  it("a missing step added reads as an added step", () => {
    const changes = diffBundles(base(), withMissing(base()));
    expect(changes.some((c) => c.kind === "added" && JSON.stringify(c).includes('"m1"'))).toBe(
      true,
    );
  });

  it("merges cleanly when one side adds it and the other edits something else", () => {
    const theirs = edit(base(), (d) => {
      d.definition.instructions = "Changed upstream.";
    });
    const r = mergeBundles(base(), withMissing(base()), theirs);
    expect(r.clean).toBe(true);
    const w = r.bundle.workflows[0]?.workflow;
    expect(w?.steps.some((s) => s.id === "m1")).toBe(true);
    expect(r.bundle.definition.instructions).toBe("Changed upstream.");
  });
});
