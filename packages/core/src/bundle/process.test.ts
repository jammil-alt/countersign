// R1 (docs/plan.md §1.86, §9): bundles holding v4 processes, and v3 bundles read as v4, through
// the same diff, merge and select as v3 bundles.

import { describe, expect, it } from "vitest";
import { bundleHash, canonicalJson } from "../canonical";
import type { ConvertLookup } from "../process/convert";
import type {
  ApprovalCheck,
  ForEachStep,
  IfStep,
  Process,
  SkillStep as ProcessSkillStep,
  Step as ProcessStep,
} from "../process/schema";
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  holdsProcess,
} from "../schemas/agent";
import type { Step, Trigger } from "../schemas/workflow";
import { bundle, bundleInput, edit } from "../testing/fixtures";
import { stripClientSpecificSettings } from "./client-specific";
import { diffBundles } from "./diff";
import { flattenBundle, unflattenBundle } from "./flatten";
import { applyResolutions, mergeBundles } from "./merge";
import { eachProcessStep, readBundles, toProcessBundle } from "./normalize";
import { selectableBetween, selectChanges } from "./select";
import { bundleFeatures, bundleSimilarity } from "./similarity";

/** No tool-mode skills (every skill step stays a skill step); the QuickBooks upload writes out. */
const lookup: ConvertLookup = {
  wrappedTool: () => null,
  sideEffect: (tool) => (tool === "qbo.attachable.upload" ? "external" : null),
};

/** The fixture bundle with its one workflow read as a v4 process. */
const v4 = (): AnyAgentBundle => toProcessBundle(bundle(), lookup);

const proc = (b: AnyAgentBundle, slug = "intake"): Process => {
  const w = b.workflows.find((x) => x.slug === slug)?.workflow;
  if (w?.schemaVersion !== 4) throw new Error(`${slug} is not a v4 process`);
  return w;
};

const find = (b: AnyAgentBundle, id: string): ProcessStep => {
  let found: ProcessStep | undefined;
  for (const w of b.workflows) {
    if (w.workflow.schemaVersion !== 4) continue;
    eachProcessStep(w.workflow.steps, (s) => {
      if (s.id === id) found = s;
    });
  }
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

const approval = (b: AnyAgentBundle, id: string): ApprovalCheck => {
  const a = find(b, id).checks?.approval;
  if (!a) throw new Error(`no approval on ${id}`);
  return a;
};

const ids = (steps: readonly { id: string }[]) => steps.map((s) => s.id);

const v3Steps = (b: AgentBundle) => b.workflows[0]?.workflow.steps as Step[];

const secondTrigger: Trigger = { id: "t2", on: { type: "manual", input: { type: "object" } } };

describe("AnyAgentBundle", () => {
  it("parses and hashes a stored v3 bundle exactly as before", async () => {
    const v3 = AgentBundleSchema.parse(bundleInput());
    const any = AnyAgentBundleSchema.parse(bundleInput());
    expect(canonicalJson(any)).toBe(canonicalJson(v3));
    // Pinned from the bundle before R1 (commit 78ff2c8): R1 must not move a stored v3 hash.
    const pinned = "5696400647df18674e8351fd0968e020b3631bc6baf8834555a783aebb88f28d";
    expect(await bundleHash(v3)).toBe(pinned);
    expect(await bundleHash(any)).toBe(pinned);
    // Re-parsing a stored (parsed) bundle is a no-op under either schema.
    const stored = JSON.parse(JSON.stringify(v3));
    expect(await bundleHash(AnyAgentBundleSchema.parse(stored))).toBe(pinned);
    expect(holdsProcess(any)).toBe(false);
  });

  it("holds v4 processes and v3 workflows side by side; AgentBundle stays v3 only", async () => {
    const mixed = edit(bundle() as AnyAgentBundle, (d) => {
      d.workflows.push({
        slug: "intake-v4",
        name: "Intake v4",
        enabled: true,
        workflow: proc(v4()),
      });
    });
    // Ids repeat across the two entries; parsing doesn't check ids (validation does).
    const parsed = AnyAgentBundleSchema.parse(JSON.parse(JSON.stringify(mixed)));
    expect(parsed.workflows.map((w) => w.workflow.schemaVersion)).toEqual([3, 4]);
    expect(holdsProcess(parsed)).toBe(true);
    expect(await bundleHash(parsed)).toBe(await bundleHash(mixed));
    expect(AgentBundleSchema.safeParse(mixed).success).toBe(false);
  });
});

describe("toProcessBundle", () => {
  it("reads every v3 workflow as v4, keeping every id", () => {
    const a = bundle();
    const b = toProcessBundle(a, lookup);
    const p = proc(b);
    expect(p.triggers.map((t) => t.id)).toEqual(["t1"]);
    expect(ids(p.steps)).toEqual(["s1", "s2", "s5", "s7"]);
    const fork = find(b, "s2") as IfStep;
    expect(fork.kind).toBe("if");
    expect(ids(fork.paths)).toEqual(["p1"]);
    expect(fork.otherwise.id).toBe("o1");
    expect(find(b, "s7")).toMatchObject({ kind: "write", tool: "qbo.attachable.upload" });
    expect(approval(b, "s7")).toMatchObject({ required: "required", mode: "in_turn" });
    // The input is untouched, the result parses, and a v4 bundle is read as it is.
    expect(a.workflows[0]?.workflow.schemaVersion).toBe(3);
    expect(AnyAgentBundleSchema.parse(b)).toEqual(b);
    expect(toProcessBundle(b, lookup)).toEqual(b);
  });

  it("reads a v3 draft that v4's minimums refuse, without failing", () => {
    // A v3 draft is saved with its errors: here a fork with no paths and a person with no one
    // assigned (stored JSON, so the v3 schema's own minimum isn't applied on the way in).
    const draft = edit(bundle(), (d) => {
      const steps = v3Steps(d);
      const fork = steps.find((s) => s.id === "s2") as Extract<Step, { kind: "fork" }>;
      (fork.paths[0]?.steps[0] as Extract<Step, { kind: "person" }>).assignee = "";
      steps.push({
        id: "f9",
        name: "Empty fork",
        kind: "fork",
        paths: [],
        otherwise: { id: "o9", steps: [] },
      });
    });
    const b = toProcessBundle(draft, lookup);
    const p = proc(b);
    expect(ids(p.steps)).toEqual(["s1", "s2", "s5", "s7", "f9"]);
    expect(find(b, "s3")).toMatchObject({ kind: "person", assignee: "" });
    expect(find(b, "f9")).toMatchObject({ kind: "if", paths: [], otherwise: { id: "o9" } });
    // The parts that parse still get v4's defaults: the write's approval, the trigger.
    expect(approval(b, "s7")).toMatchObject({ required: "required", mode: "in_turn" });
    expect(find(b, "s2")).toMatchObject({ kind: "if", paths: [{ id: "p1" }] });
    // Diff, merge and select read it; whether it is valid is for validation to say.
    expect(diffBundles(draft, v4(), { lookup }).map((c) => c.entity)).toEqual(
      expect.arrayContaining(["step:s3", "step:f9"]),
    );
    expect(mergeBundles(draft, draft, v4(), [], { lookup }).bundle.workflows).toHaveLength(1);
    expect(selectableBetween(draft, v4(), { lookup }).length).toBeGreaterThan(0);
  });

  it("refuses to compare v3 with v4 without a lookup", () => {
    expect(() => diffBundles(bundle(), v4())).toThrow(/pass a lookup/);
    expect(() => mergeBundles(bundle(), bundle(), v4())).toThrow(/pass a lookup/);
    // All v3, or all v4: no lookup needed.
    expect(readBundles([bundle(), bundle()]).asProcess).toBe(false);
    expect(readBundles([v4(), v4()]).asProcess).toBe(true);
  });
});

describe("flattening a v4 process", () => {
  it("round-trips, with triggers by id, if paths and loop bodies as keyed items", () => {
    const b = edit(v4(), (d) => {
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
    expect(unflattenBundle<AnyAgentBundle>(flat)).toEqual(b);
  });

  it("refuses a process with one trigger id twice", () => {
    const b = edit(v4(), (d) => {
      proc(d).triggers.push({ ...secondTrigger, id: "t1" });
    });
    expect(() => flattenBundle(b)).toThrow(/duplicate trigger t1/);
  });

  it("leaves a v3 workflow's triggers as fields, as before", () => {
    const flat = flattenBundle(bundle());
    expect(flat.entities.get("workflow:intake")?.content).toHaveProperty(
      "workflow.trigger.id",
      "t1",
    );
  });
});

describe("diffBundles on v4", () => {
  it("reads nothing as changed between a v3 version and its v4 reading", () => {
    expect(diffBundles(bundle(), v4(), { lookup })).toEqual([]);
    expect(selectableBetween(bundle(), v4(), { lookup })).toEqual([]);
  });

  it("reports checks by field, triggers by id and steps moved into an if path", () => {
    const a = v4();
    const b = edit(a, (d) => {
      approval(d, "s7").mode = "any";
      const s1 = find(d, "s1");
      s1.checks = { confer: { with: [{ ai: { focus: "Is the vendor right?" } }] } };
      proc(d).triggers.push(secondTrigger);
      const steps = proc(d).steps;
      const s7 = steps.pop() as ProcessStep;
      (find(d, "s2") as IfStep).paths[0]?.steps.push(s7);
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

  it("diffs a v3 base against a v4 version only where they differ", () => {
    const b = edit(v4(), (d) => {
      (find(d, "s1") as ProcessSkillStep).name = "Read the invoice";
    });
    expect(diffBundles(bundle(), b, { lookup }).map((c) => c.path)).toEqual(["step:s1#/name"]);
  });
});

describe("mergeBundles on v4", () => {
  it("merges checks field by field: approval mode on one side, approvers on the other", () => {
    const base = v4();
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
    expect(AnyAgentBundleSchema.safeParse(r.bundle).success).toBe(true);
  });

  it("conflicts on one notify list changed two ways, and the resolution settles it", () => {
    const base = v4();
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

  it("merges if paths like fork paths: a step moved into a path and edited on the other side", () => {
    const base = v4();
    const ours = edit(base, (d) => {
      const steps = proc(d).steps;
      const s7 = steps.splice(
        steps.findIndex((s) => s.id === "s7"),
        1,
      )[0] as ProcessStep;
      (find(d, "s2") as IfStep).paths[0]?.steps.push(s7);
    });
    const theirs = edit(base, (d) => {
      find(d, "s7").name = "Attach the bill";
      (find(d, "s5") as ForEachStep).concurrency = 3;
    });
    const r = mergeBundles(base, ours, theirs);
    expect(r.clean).toBe(true);
    const path = (find(r.bundle, "s2") as IfStep).paths[0];
    expect(ids(path?.steps ?? [])).toEqual(["s3", "s7"]);
    expect(find(r.bundle, "s7").name).toBe("Attach the bill");
    expect((find(r.bundle, "s5") as ForEachStep).concurrency).toBe(3);
  });

  it("conflicts on a trigger removed on one side and edited on the other", () => {
    const base = edit(v4(), (d) => {
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
    const base = v4();
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
    edit(v4(), (d) => {
      proc(d).triggers.push(...extra);
    });
  const reorder = (b: AnyAgentBundle, order: string[]) =>
    edit(b, (d) => {
      const p = proc(d);
      p.triggers = order.map((id) => p.triggers.find((t) => t.id === id) as Trigger);
    });
  const triggerIds = (b: AnyAgentBundle) => proc(b).triggers.map((t) => t.id);

  it("keeps trigger order through flattening, numeric ids included", () => {
    const b = reorder(withTriggers(secondTrigger, thirdTrigger), ["t2", "t1", "2"]);
    expect(triggerIds(unflattenBundle<AnyAgentBundle>(flattenBundle(b)))).toEqual([
      "t2",
      "t1",
      "2",
    ]);
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
});

describe("mixed v3 and v4 merges", () => {
  it("merges a v3 base and v3 template update into a client's v4 version", () => {
    const base = bundle();
    // The client's version, saved as v4 with a new approval mode.
    const ours = edit(toProcessBundle(base, lookup), (d) => {
      approval(d, "s7").mode = "any";
    });
    // The template's next version, still v3: a renamed step and a new wait at the end.
    const theirs = edit(base, (d) => {
      const steps = v3Steps(d);
      (steps[0] as Step).name = "Extract the invoice";
      steps.push({ id: "w1", name: "Pause", kind: "wait", for: "1 hour" });
    });
    const r = mergeBundles(base, ours, theirs, [], { lookup });
    expect(r.clean).toBe(true);
    expect(r.bundle.workflows[0]?.workflow.schemaVersion).toBe(4);
    expect(ids(proc(r.bundle).steps)).toEqual(["s1", "s2", "s5", "s7", "w1"]);
    expect(find(r.bundle, "s1").name).toBe("Extract the invoice");
    expect(approval(r.bundle, "s7").mode).toBe("any");
    expect(AnyAgentBundleSchema.parse(r.bundle)).toEqual(r.bundle);
  });

  it("merges a v3 client edit with a v4 template that adds a trigger and a confer", () => {
    const base = bundle();
    const ours = edit(base, (d) => {
      const wf = d.workflows[0]?.workflow;
      if (wf?.trigger.on.type === "event") wf.trigger.on.filter = { match: "any", rules: [] };
      (v3Steps(d)[2] as Extract<Step, { kind: "for_each" }>).concurrency = 2;
    });
    const theirs = edit(toProcessBundle(base, lookup), (d) => {
      proc(d).triggers.push(secondTrigger);
      find(d, "s1").checks = { confer: { with: [{ ai: { focus: "Right vendor?" } }] } };
    });
    const r = mergeBundles(base, ours, theirs, [], { lookup });
    expect(r.clean).toBe(true);
    const p = proc(r.bundle);
    expect(p.triggers.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(p.triggers[0]?.on).toMatchObject({ filter: { match: "any" } });
    expect((find(r.bundle, "s5") as ForEachStep).concurrency).toBe(2);
    expect(find(r.bundle, "s1").checks?.confer).toBeDefined();
  });

  it("still conflicts where both sides changed one field, whatever their versions", () => {
    const base = bundle();
    const ours = edit(base, (d) => {
      (v3Steps(d)[0] as Step).name = "Ours";
    });
    const theirs = edit(toProcessBundle(base, lookup), (d) => {
      find(d, "s1").name = "Theirs";
    });
    const r = mergeBundles(base, ours, theirs, [], { lookup });
    expect(r.conflicts.map((c) => c.path)).toEqual(["step:s1#/name"]);
    expect(find(r.bundle, "s1").name).toBe("Ours");
  });

  it("merges three v3 bundles as v3, as before", () => {
    const base = bundle();
    const r = mergeBundles(base, base, base, [], { lookup });
    expect(r.bundle).toEqual(base);
    expect(r.bundle.workflows[0]?.workflow.schemaVersion).toBe(3);
  });
});

describe("selectChanges on v4", () => {
  it("applies only the picked changes, reading a v3 side as v4", () => {
    const a = bundle();
    const b = edit(v4(), (d) => {
      find(d, "s1").name = "Picked";
      find(d, "s6").name = "Left out";
    });
    const groups = selectableBetween(a, b, { lookup }).map((g) => g.id);
    expect(groups).toEqual(["step:s1", "step:s6"]);
    const out = selectChanges(a, b, ["step:s1"], { lookup });
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

describe("the rest of the bundle code on v4", () => {
  it("strips client-specific settings from a v4 skill step", () => {
    const b = edit(v4(), (d) => {
      (find(d, "s6") as ProcessSkillStep).settings = { vendors: ["Acme"], tone: "plain" };
    });
    const out = stripClientSpecificSettings(b, {
      "test.summarize": {
        settings: [
          { key: "vendors", type: "string", clientSpecific: true },
          { key: "tone", type: "string" },
        ] as never,
      },
    });
    expect((find(out, "s6") as ProcessSkillStep).settings).toEqual({ tone: "plain" });
  });

  it("scores a v4 bundle on its triggers, skills, tools and step kinds", () => {
    const f = bundleFeatures(v4());
    expect(f.triggers).toEqual(["event"]);
    expect(f.skills).toEqual(["docs.extract", "test.itemize", "test.summarize"]);
    expect(f.tools).toEqual(["qbo.attachable.upload"]);
    expect(f.steps).toEqual(["skill", "if", "person", "notify", "for_each", "skill", "write"]);
    expect(bundleSimilarity(v4(), v4()).score).toBe(1);
  });
});
