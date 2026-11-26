// Bundles holding v5 workflows through diff, merge, select and flatten: checks by field, triggers by
// id and in order, fork paths and loop bodies as keyed items, and the readers that score a bundle.

import { describe, expect, it } from "vitest";
import { bundleHash } from "../canonical";
import type { ApprovalCheck } from "../process/schema";
import { type AgentBundle, AgentBundle as AgentBundleSchema } from "../schemas/agent";
import type { Trigger } from "../schemas/workflow";
import type { DoStep, ForEachStep, ForkStep, Step, Workflow } from "../steps/schema";
import { bundle, bundleInput, edit } from "../testing/fixtures";
import { stripClientSpecificSettings } from "./client-specific";
import { diffBundles } from "./diff";
import { flattenBundle, unflattenBundle } from "./flatten";
import { applyResolutions, mergeBundles } from "./merge";
import { eachBundleStep } from "./normalize";
import { selectableBetween, selectChanges } from "./select";
import { bundleFeatures, bundleSimilarity } from "./similarity";

const v5 = (): AgentBundle => bundle();

const proc = (b: AgentBundle, slug = "intake"): Workflow => {
  const w = b.workflows.find((x) => x.slug === slug)?.workflow;
  if (!w) throw new Error(`no workflow ${slug}`);
  return w;
};

const find = (b: AgentBundle, id: string): Step => {
  let found: Step | undefined;
  eachBundleStep(b, (s) => {
    if (s.id === id) found = s;
  });
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

const approval = (b: AgentBundle, id: string): ApprovalCheck => {
  const a = find(b, id).checks?.approval;
  if (!a) throw new Error(`no approval on ${id}`);
  return a;
};

const ids = (steps: readonly { id: string }[]) => steps.map((s) => s.id);

const secondTrigger: Trigger = { id: "t2", on: { type: "manual", input: { type: "object" } } };

describe("AgentBundle", () => {
  it("re-parsing a stored bundle is a no-op, and hashes the same", async () => {
    const parsed = AgentBundleSchema.parse(bundleInput());
    const stored = JSON.parse(JSON.stringify(parsed));
    expect(AgentBundleSchema.parse(stored)).toEqual(parsed);
    expect(await bundleHash(AgentBundleSchema.parse(stored))).toBe(await bundleHash(parsed));
  });
});

describe("flattening a workflow", () => {
  it("round-trips, with triggers by id, fork paths and loop bodies as keyed items", () => {
    const b = edit(v5(), (d) => {
      proc(d).triggers.push(secondTrigger);
    });
    const flat = flattenBundle(b);
    expect(flat.lists.get("step:s2>paths")).toEqual(["path:p1"]);
    expect(flat.lists.get("step:s2>otherwise")).toEqual(["otherwise:o1"]);
    expect(flat.lists.get("step:s5>steps")).toEqual(["step:s6"]);
    const content = flat.entities.get("workflow:intake")?.content as {
      workflow: { triggers: Record<string, Trigger> };
    };
    expect(Object.keys(content.workflow.triggers)).toEqual(["t1", "t2"]);
    expect(content.workflow.triggers.t2).toEqual(secondTrigger);
    expect(unflattenBundle<AgentBundle>(flat)).toEqual(b);
  });

  it("refuses a workflow with one trigger id twice", () => {
    const b = edit(v5(), (d) => {
      proc(d).triggers.push({ ...secondTrigger, id: "t1" });
    });
    expect(() => flattenBundle(b)).toThrow(/duplicate trigger t1/);
  });
});

describe("diffBundles on workflows", () => {
  it("reports checks by field, triggers by id and steps moved into a fork path", () => {
    const a = v5();
    const b = edit(a, (d) => {
      approval(d, "s7").mode = "any";
      const s1 = find(d, "s1");
      s1.checks = { confer: { with: [{ ai: { focus: "Is the vendor right?" } }] } };
      proc(d).triggers.push(secondTrigger);
      const steps = proc(d).steps;
      const s7 = steps.pop() as Step;
      (find(d, "s2") as ForkStep).paths[0]?.steps.push(s7);
    });
    const brief = diffBundles(a, b).map((c) => [c.kind, c.path]);
    expect(brief).toEqual(
      expect.arrayContaining([
        ["changed", "step:s7#/checks/approval/mode"],
        ["changed", "step:s1#/checks"],
        ["changed", "workflow:intake#/workflow/triggers/t2"],
        ["moved", "step:s7#@location"],
      ]),
    );
  });
});

describe("mergeBundles on workflows", () => {
  it("merges checks field by field: approval mode on one side, approvers on the other", () => {
    const base = v5();
    const ours = edit(base, (d) => {
      approval(d, "s7").mode = "all";
    });
    const theirs = edit(base, (d) => {
      approval(d, "s7").approvers = [{ who: "client_admin" }];
      find(d, "s7").checks = {
        ...find(d, "s7").checks,
        confer: { with: [{ ai: { focus: "Does the upload match the bill?" } }] },
      };
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(approval(r.bundle, "s7")).toMatchObject({
      mode: "all",
      approvers: [{ who: "client_admin" }],
    });
    expect(find(r.bundle, "s7").checks?.confer?.with).toHaveLength(1);
    expect(AgentBundleSchema.safeParse(r.bundle).success).toBe(true);
  });

  it("conflicts on one notify list changed two ways, and the resolution settles it", () => {
    const base = v5();
    const note = (message: string) => [{ to: ["lead"], channel: "inbox" as const, message }];
    const ours = edit(base, (d) => {
      find(d, "s1").checks = { notify: note("Ours") };
    });
    const theirs = edit(base, (d) => {
      find(d, "s1").checks = { notify: note("Theirs") };
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.conflicts.map((c) => c.path)).toEqual(["step:s1#/checks/notify"]);
    const settled = applyResolutions({ base, ours, theirs }, [
      { path: "step:s1#/checks/notify", choice: "theirs" },
    ]);
    expect(settled.clean).toBe(true);
    expect(find(settled.bundle, "s1").checks?.notify?.[0]?.message).toBe("Theirs");
  });

  it("merges fork paths: a step moved into a path and edited on the other side", () => {
    const base = v5();
    const ours = edit(base, (d) => {
      const steps = proc(d).steps;
      const s7 = steps.splice(
        steps.findIndex((s) => s.id === "s7"),
        1,
      )[0] as Step;
      (find(d, "s2") as ForkStep).paths[0]?.steps.push(s7);
    });
    const theirs = edit(base, (d) => {
      find(d, "s7").name = "Attach the bill";
      (find(d, "s5") as ForEachStep).concurrency = 3;
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.clean).toBe(true);
    const path = (find(r.bundle, "s2") as ForkStep).paths[0];
    expect(ids(path?.steps ?? [])).toEqual(["s3", "s7"]);
    expect(find(r.bundle, "s7").name).toBe("Attach the bill");
    expect((find(r.bundle, "s5") as ForEachStep).concurrency).toBe(3);
  });

  it("conflicts on a trigger removed on one side and edited on the other", () => {
    const base = edit(v5(), (d) => {
      proc(d).triggers.push(secondTrigger);
    });
    const ours = edit(base, (d) => {
      proc(d).triggers.pop();
    });
    const theirs = edit(base, (d) => {
      const t = proc(d).triggers[1];
      if (t?.on.type === "manual") t.on.input = { type: "object", properties: {} };
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.conflicts.map((c) => c.path)).toEqual(["workflow:intake#/workflow/triggers/t2"]);
    expect(proc(r.bundle).triggers.map((t) => t.id)).toEqual(["t1"]);
    // Removed on one side and untouched on the other: removed.
    expect(proc(mergeBundles(base, ours, base).bundle).triggers.map((t) => t.id)).toEqual(["t1"]);
  });

  it("merges triggers by id: one side adds a trigger, the other edits the first", () => {
    const base = v5();
    const ours = edit(base, (d) => {
      const t = proc(d).triggers[0];
      if (t?.on.type === "event") t.on.filter = { match: "all", rules: [] };
    });
    const theirs = edit(base, (d) => {
      proc(d).triggers.push(secondTrigger);
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(proc(r.bundle).triggers).toEqual([
      {
        id: "t1",
        on: { type: "event", event: "document.received", filter: { match: "all", rules: [] } },
      },
      secondTrigger,
    ]);
  });

  const thirdTrigger: Trigger = { id: "2", on: { type: "manual", input: { type: "object" } } };
  const withTriggers = (...extra: Trigger[]) =>
    edit(v5(), (d) => {
      proc(d).triggers.push(...extra);
    });
  const reorder = (b: AgentBundle, order: string[]) =>
    edit(b, (d) => {
      const p = proc(d);
      p.triggers = order.map((id) => p.triggers.find((t) => t.id === id) as Trigger);
    });
  const triggerIds = (b: AgentBundle) => proc(b).triggers.map((t) => t.id);

  it("keeps trigger order through flattening, numeric ids included", () => {
    const b = reorder(withTriggers(secondTrigger, thirdTrigger), ["t2", "t1", "2"]);
    expect(triggerIds(unflattenBundle<AgentBundle>(flattenBundle(b)))).toEqual(["t2", "t1", "2"]);
  });

  it("shows a trigger reorder as a change, and select carries it with the workflow", () => {
    const a = withTriggers(secondTrigger);
    const b = reorder(a, ["t2", "t1"]);
    expect(diffBundles(a, b).map((c) => [c.kind, c.path])).toEqual([
      ["changed", "workflow:intake#/workflow/triggerOrder"],
    ]);
    const picks = selectableBetween(a, b);
    expect(picks.map((s) => s.id)).toEqual(["workflow:intake"]);
    expect(triggerIds(selectChanges(a, b, ["workflow:intake"]))).toEqual(["t2", "t1"]);
    expect(triggerIds(selectChanges(a, b, []))).toEqual(["t1", "t2"]);
  });

  it("merges trigger order as a sequence: a reorder and an add both land", () => {
    const base = withTriggers(secondTrigger);
    const ours = reorder(base, ["t2", "t1"]);
    const theirs = withTriggers(secondTrigger, thirdTrigger);
    const r = mergeBundles(base, ours, theirs);
    expect(r.clean).toBe(true);
    // Their new trigger stays next to the one it followed on their side.
    expect(triggerIds(r.bundle)).toEqual(["t2", "2", "t1"]);
  });

  it("conflicts on two different trigger reorders", () => {
    const base = withTriggers(secondTrigger, thirdTrigger);
    const ours = reorder(base, ["t2", "t1", "2"]);
    const theirs = reorder(base, ["2", "t1", "t2"]);
    const r = mergeBundles(base, ours, theirs);
    expect(r.conflicts.map((c) => [c.kind, c.path])).toEqual([
      ["order", "workflow:intake#/workflow/triggerOrder"],
    ]);
    expect(triggerIds(r.bundle)).toEqual(["t2", "t1", "2"]);
    const settled = applyResolutions({ base, ours, theirs }, [
      { path: "workflow:intake#/workflow/triggerOrder", choice: "theirs" },
    ]);
    expect(settled.clean).toBe(true);
    expect(triggerIds(settled.bundle)).toEqual(["2", "t1", "t2"]);
  });

  it("still conflicts where both sides changed one field", () => {
    const base = v5();
    const ours = edit(base, (d) => {
      find(d, "s1").name = "Ours";
    });
    const theirs = edit(base, (d) => {
      find(d, "s1").name = "Theirs";
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.conflicts.map((c) => c.path)).toEqual(["step:s1#/name"]);
    expect(find(r.bundle, "s1").name).toBe("Ours");
  });

  it("merges three equal bundles as themselves", () => {
    const base = v5();
    const r = mergeBundles(base, base, base);
    expect(r.bundle).toEqual(base);
  });
});

describe("selectChanges on workflows", () => {
  it("applies only the picked changes", () => {
    const a = v5();
    const b = edit(a, (d) => {
      find(d, "s1").name = "Picked";
      find(d, "s6").name = "Left out";
    });
    const groups = selectableBetween(a, b).map((g) => g.id);
    expect(groups).toEqual(["step:s1", "step:s6"]);
    const out = selectChanges(a, b, ["step:s1"]);
    expect(find(out, "s1").name).toBe("Picked");
    expect(find(out, "s6").name).toBe("Summarize");
  });

  it("keeps the bundle's people", () => {
    const a = edit(bundle(), (d) => {
      d.people = AgentBundleSchema.shape.people.parse([{ role: "purchaser" }]);
    });
    const b = edit(a, (d) => {
      d.definition.instructions = "Work faster.";
    });
    const out = selectChanges(a, b, ["bundle#/definition/instructions"]);
    expect(out.people?.map((p) => p.role)).toEqual(["purchaser"]);
    expect(out.definition.instructions).toBe("Work faster.");
  });
});

describe("the rest of the bundle code on workflows", () => {
  it("strips client-specific settings from a skill step's values", () => {
    const b = edit(v5(), (d) => {
      (find(d, "s6") as DoStep).ai = { values: { vendors: ["Acme"], tone: "plain" } };
    });
    const out = stripClientSpecificSettings(b, {
      "test.summarize": {
        settings: [
          { key: "vendors", type: "string", clientSpecific: true },
          { key: "tone", type: "string" },
        ] as never,
      },
    });
    expect((find(out, "s6") as DoStep).ai?.values).toEqual({ tone: "plain" });
  });

  it("scores a bundle on its triggers, skills, tools and step kinds", () => {
    const f = bundleFeatures(v5());
    expect(f.triggers).toEqual(["event"]);
    expect(f.skills).toEqual(["docs.extract", "test.itemize", "test.summarize"]);
    expect(f.tools).toEqual(["docs.extract", "qbo.attachable.upload"]);
    expect(f.steps).toEqual([
      "do:rules:action",
      "fork",
      "do:person:-",
      "wait",
      "for_each",
      "do:ai:skill",
      "do:rules:action",
    ]);
    expect(bundleSimilarity(v5(), v5()).score).toBe(1);
  });
});
