import { describe, expect, it } from "vitest";
import { bundleHash } from "../canonical";
import { type AgentBundle, AgentBundle as AgentBundleSchema } from "../schemas/agent";
import type { ForkStep, Step, Workflow } from "../schemas/workflow";
import { bundle, ctx, edit } from "../testing/fixtures";
import { validateBundle } from "../workflow/validate";
import { nodeIds } from "../workflow/walk";
import { stripClientSpecificSettings } from "./client-specific";
import { diffBundles } from "./diff";
import { applyResolutions, mergeBundles } from "./merge";

const wait = (id: string, f = "1 hour"): Step => ({
  id,
  name: id.toUpperCase(),
  kind: "wait",
  for: f,
});

/** A bundle whose "main" workflow is: a, f (fork: q1 [x], q2 [y], otherwise oz [z]), b, c. */
function base(): AgentBundle {
  const b = bundle();
  const main: Workflow = {
    schemaVersion: 3,
    trigger: { id: "tm", on: { type: "manual", input: { type: "object" } } },
    steps: [
      wait("a"),
      {
        id: "f",
        name: "Fork",
        kind: "fork",
        paths: [
          {
            id: "q1",
            name: "One",
            when: { match: "all", rules: [{ field: "{{trigger.n}}", op: ">", value: 1 }] },
            steps: [wait("x")],
          },
          {
            id: "q2",
            name: "Two",
            when: { match: "all", rules: [{ field: "{{trigger.n}}", op: "<", value: 0 }] },
            steps: [wait("y")],
          },
        ],
        otherwise: { id: "oz", steps: [wait("z")] },
      },
      wait("b"),
      wait("c"),
    ],
  };
  b.workflows.push({ slug: "main", name: "Main", enabled: true, workflow: main });
  return AgentBundleSchema.parse(b);
}

const main = (b: AgentBundle) => b.workflows.find((w) => w.slug === "main")?.workflow as Workflow;
const top = (b: AgentBundle) => main(b).steps;
const ids = (steps: Step[]) => steps.map((s) => s.id);
const fork = (b: AgentBundle) => main(b).steps.find((s) => s.id === "f") as ForkStep;
const step = (b: AgentBundle, id: string) => {
  let found: Step | undefined;
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      if (s.id === id) found = s;
      if (s.kind === "fork") {
        for (const p of s.paths) visit(p.steps);
        visit(s.otherwise.steps);
      }
      if (s.kind === "for_each") visit(s.steps);
    }
  };
  for (const w of b.workflows) visit(w.workflow.steps);
  return found;
};
const change = (fn: (b: AgentBundle) => void) => edit(base(), fn);

function moveStep(b: AgentBundle, id: string, to: (b: AgentBundle) => Step[], at: number) {
  const remove = (steps: Step[]): Step | undefined => {
    const i = steps.findIndex((s) => s.id === id);
    if (i >= 0) return steps.splice(i, 1)[0];
    for (const s of steps) {
      const inner =
        s.kind === "fork"
          ? [...s.paths.map((p) => p.steps), s.otherwise.steps]
          : s.kind === "for_each"
            ? [s.steps]
            : [];
      for (const list of inner) {
        const r = remove(list);
        if (r) return r;
      }
    }
    return undefined;
  };
  const s = remove(main(b).steps);
  if (!s) throw new Error(`no step ${id}`);
  to(b).splice(at, 0, s);
}

describe("mergeBundles golden cases", () => {
  it("takes a change made on one side only", () => {
    const ours = change((b) => {
      (step(b, "a") as Step).name = "Ours A";
    });
    const theirs = change((b) => {
      b.definition.instructions = "Theirs";
    });
    const r = mergeBundles(base(), ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.clean).toBe(true);
    expect(step(r.bundle, "a")?.name).toBe("Ours A");
    expect(r.bundle.definition.instructions).toBe("Theirs");
  });

  it("takes the same change on both sides once", () => {
    const fn = (b: AgentBundle) => {
      (step(b, "b") as { for: string }).for = "2 hours";
      main(b).steps.push(wait("same"));
    };
    const r = mergeBundles(base(), change(fn), change(fn));
    expect(r.conflicts).toEqual([]);
    expect(r.bundle).toEqual(change(fn));
  });

  it("reports a conflicting field and applies its resolution", () => {
    const ours = change((b) => {
      (step(b, "b") as { for: string }).for = "2 hours";
    });
    const theirs = change((b) => {
      (step(b, "b") as { for: string }).for = "3 hours";
    });
    const r = mergeBundles(base(), ours, theirs);
    expect(r.conflicts).toEqual([
      {
        path: "step:b#/for",
        kind: "field",
        entity: "step:b",
        base: "1 hour",
        ours: "2 hours",
        theirs: "3 hours",
      },
    ]);
    expect((step(r.bundle, "b") as { for: string }).for).toBe("2 hours");
    const resolved = applyResolutions({ base: base(), ours, theirs }, [
      { path: "step:b#/for", choice: "theirs" },
    ]);
    expect(resolved.clean).toBe(true);
    expect((step(resolved.bundle, "b") as { for: string }).for).toBe("3 hours");
    const custom = applyResolutions({ base: base(), ours, theirs }, [
      { path: "step:b#/for", choice: "value", value: "4 hours" },
      { path: "step:nope#/for", choice: "ours" },
    ]);
    expect((step(custom.bundle, "b") as { for: string }).for).toBe("4 hours");
    expect(custom.unusedResolutions).toEqual(["step:nope#/for"]);
  });

  // v0.13 W2-H (docs/plan.md §1.53): a step's model merges like any step field.
  it("takes a step's model from one side, and conflicts when both sides set different ones", () => {
    const setModel = (id: string) =>
      change((b) => {
        (step(b, "s6") as { model?: { id: string } }).model = { id };
      });
    const one = mergeBundles(base(), setModel("claude-haiku-5-5"), base());
    expect(one.conflicts).toEqual([]);
    expect((step(one.bundle, "s6") as { model?: { id: string } }).model).toEqual({
      id: "claude-haiku-5-5",
    });
    const both = mergeBundles(base(), setModel("claude-haiku-5-5"), setModel("claude-opus-5-5"));
    expect(both.conflicts.length).toBeGreaterThan(0);
    expect(both.conflicts.every((c) => c.path.startsWith("step:s6#/model"))).toBe(true);
    const same = mergeBundles(base(), setModel("claude-opus-5-5"), setModel("claude-opus-5-5"));
    expect(same.conflicts).toEqual([]);
  });

  it("merges agent fields and skills by key", () => {
    const ours = change((b) => {
      (b.definition.skills[1] as { settings: Record<string, unknown> }).settings.threshold = 9;
      b.definition.permissions.approver = "operator";
    });
    const theirs = change((b) => {
      b.definition.skills.push({ skill: "custom:weekly-note", settings: {} });
      b.definition.budgets.maxSteps = 20;
    });
    const r = mergeBundles(base(), ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.bundle.definition.skills.map((s) => s.skill)).toEqual([
      "docs.extract",
      "test.itemize",
      "test.summarize",
      "custom:weekly-note",
    ]);
    expect(r.bundle.definition.skills[1]?.settings).toEqual({ threshold: 9 });
    expect(r.bundle.definition.permissions.approver).toBe("operator");
    expect(r.bundle.definition.budgets.maxSteps).toBe(20);
  });

  describe("delete vs edit", () => {
    it("deletes cleanly when the other side didn't touch it", () => {
      const ours = change((b) => {
        main(b).steps = main(b).steps.filter((s) => s.id !== "c");
      });
      const r = mergeBundles(base(), ours, base());
      expect(r.clean).toBe(true);
      expect(ids(main(r.bundle).steps)).toEqual(["a", "f", "b"]);
    });

    it("conflicts when the other side edited it", () => {
      const ours = change((b) => {
        main(b).steps = main(b).steps.filter((s) => s.id !== "c");
      });
      const theirs = change((b) => {
        (step(b, "c") as Step).name = "Edited C";
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.conflicts).toEqual([
        expect.objectContaining({ path: "step:c#@exists", kind: "exists", ours: undefined }),
      ]);
      expect(step(r.bundle, "c")).toBeUndefined();
      const keep = applyResolutions({ base: base(), ours, theirs }, [
        { path: "step:c#@exists", choice: "theirs" },
      ]);
      expect(keep.clean).toBe(true);
      expect(step(keep.bundle, "c")?.name).toBe("Edited C");
    });

    it("reports a deleted fork against an edit inside it once, at the fork", () => {
      const ours = change((b) => {
        main(b).steps = main(b).steps.filter((s) => s.id !== "f");
      });
      const theirs = change((b) => {
        (step(b, "x") as Step).name = "Edited X";
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.conflicts.map((c) => c.path)).toEqual(["step:f#@exists"]);
      expect(step(r.bundle, "x")).toBeUndefined();
      const keep = applyResolutions({ base: base(), ours, theirs }, [
        { path: "step:f#@exists", choice: "theirs" },
      ]);
      expect(keep.clean).toBe(true);
      expect(step(keep.bundle, "x")?.name).toBe("Edited X");
      expect(ids(fork(keep.bundle).otherwise.steps)).toEqual(["z"]);
    });

    it("conflicts when a step is added into a container the other side deleted", () => {
      const ours = change((b) => {
        main(b).steps = main(b).steps.filter((s) => s.id !== "f");
      });
      const theirs = change((b) => {
        fork(b).paths[1]?.steps.push(wait("new"));
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.conflicts.map((c) => c.path)).toEqual(["step:f#@exists"]);
      expect(step(r.bundle, "new")).toBeUndefined();
    });
  });

  describe("workflow added on both sides", () => {
    const add =
      (name: string, extra: Step[] = []) =>
      (b: AgentBundle) => {
        b.workflows.push({
          slug: "weekly",
          name,
          enabled: true,
          workflow: {
            schemaVersion: 3,
            trigger: { id: "tw", on: { type: "schedule", cron: "0 7 * * 1" } },
            steps: [wait("w1"), ...extra],
          },
        });
      };

    it("is taken once when identical", () => {
      const r = mergeBundles(base(), change(add("Weekly")), change(add("Weekly")));
      expect(r.clean).toBe(true);
      expect(r.bundle.workflows.map((w) => w.slug)).toEqual(["intake", "main", "weekly"]);
      expect(ids(r.bundle.workflows[2]?.workflow.steps ?? [])).toEqual(["w1"]);
    });

    it("conflicts field by field when different, keeping both sides' new steps", () => {
      const r = mergeBundles(
        base(),
        change(add("Weekly", [wait("o1")])),
        change(add("Monday", [wait("t1x")])),
      );
      expect(r.conflicts.map((c) => c.path)).toEqual(["workflow:weekly#/name"]);
      expect(ids(r.bundle.workflows[2]?.workflow.steps ?? [])).toEqual(["w1", "o1", "t1x"]);
    });
  });

  describe("moves", () => {
    it("takes a move within a list on one side with an edit on the other", () => {
      const ours = change((b) => {
        (step(b, "a") as Step).name = "Ours A";
      });
      const theirs = change((b) => {
        moveStep(b, "c", top, 0);
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.clean).toBe(true);
      expect(ids(main(r.bundle).steps)).toEqual(["c", "a", "f", "b"]);
      expect(step(r.bundle, "a")?.name).toBe("Ours A");
    });

    it("takes a move between fork paths on one side with an edit on the other", () => {
      const ours = change((b) => {
        (step(b, "x") as Step).name = "Ours X";
      });
      const theirs = change((b) => {
        moveStep(b, "x", (d) => fork(d).paths[1]?.steps as Step[], 1);
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.clean).toBe(true);
      expect(ids(fork(r.bundle).paths[0]?.steps ?? [])).toEqual([]);
      expect(ids(fork(r.bundle).paths[1]?.steps ?? [])).toEqual(["y", "x"]);
      expect(step(r.bundle, "x")?.name).toBe("Ours X");
    });

    it("moves a step out of a fork to the top level", () => {
      const theirs = change((b) => {
        moveStep(b, "z", top, 4);
      });
      const r = mergeBundles(base(), base(), theirs);
      expect(r.clean).toBe(true);
      expect(ids(main(r.bundle).steps)).toEqual(["a", "f", "b", "c", "z"]);
      expect(fork(r.bundle).otherwise.steps).toEqual([]);
    });

    it("conflicts when one step is moved to two different places", () => {
      const ours = change((b) => {
        moveStep(b, "x", (d) => fork(d).paths[1]?.steps as Step[], 0);
      });
      const theirs = change((b) => {
        moveStep(b, "x", (d) => fork(d).otherwise.steps, 0);
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.conflicts).toEqual([
        {
          path: "step:x#@location",
          kind: "location",
          entity: "step:x",
          base: "path:q1>steps",
          ours: "path:q2>steps",
          theirs: "otherwise:oz>steps",
        },
      ]);
      expect(ids(fork(r.bundle).paths[1]?.steps ?? [])).toEqual(["x", "y"]);
      const t = applyResolutions({ base: base(), ours, theirs }, [
        { path: "step:x#@location", choice: "theirs" },
      ]);
      expect(ids(fork(t.bundle).otherwise.steps)).toEqual(["x", "z"]);
      expect(ids(fork(t.bundle).paths[1]?.steps ?? [])).toEqual(["y"]);
    });

    it("conflicts on two different reorders of one list", () => {
      const ours = change((b) => {
        moveStep(b, "c", top, 0);
      });
      const theirs = change((b) => {
        moveStep(b, "a", top, 3);
      });
      const r = mergeBundles(base(), ours, theirs);
      expect(r.conflicts).toEqual([
        {
          path: "workflow:main>steps#@order",
          kind: "order",
          entity: "workflow:main>steps",
          base: ["step:a", "step:f", "step:b", "step:c"],
          ours: ["step:c", "step:a", "step:f", "step:b"],
          theirs: ["step:f", "step:b", "step:c", "step:a"],
        },
      ]);
      expect(ids(main(r.bundle).steps)).toEqual(["c", "a", "f", "b"]);
      const t = applyResolutions({ base: base(), ours, theirs }, [
        {
          path: "workflow:main>steps#@order",
          choice: "value",
          value: ["step:b", "step:a", "step:c", "step:f"],
        },
      ]);
      expect(ids(main(t.bundle).steps)).toEqual(["b", "a", "c", "f"]);
    });

    it("takes the same reorder on both sides", () => {
      const fn = (b: AgentBundle) => moveStep(b, "c", top, 0);
      const r = mergeBundles(base(), change(fn), change(fn));
      expect(r.clean).toBe(true);
      expect(ids(main(r.bundle).steps)).toEqual(["c", "a", "f", "b"]);
    });
  });

  it("keeps inserts next to their neighbours", () => {
    const ours = change((b) => {
      main(b).steps.splice(1, 0, wait("n1"));
    });
    const theirs = change((b) => {
      main(b).steps.splice(3, 0, wait("n2"));
      fork(b).paths.push({
        id: "q3",
        name: "Three",
        when: { match: "all", rules: [{ field: "{{trigger.n}}", op: "=", value: 0 }] },
        steps: [],
      });
    });
    const r = mergeBundles(base(), ours, theirs);
    expect(r.clean).toBe(true);
    expect(ids(main(r.bundle).steps)).toEqual(["a", "n1", "f", "b", "n2", "c"]);
    expect(fork(r.bundle).paths.map((p) => p.id)).toEqual(["q1", "q2", "q3"]);
  });

  it("never generates ids: every id comes from an input, and the result validates", async () => {
    const ours = change((b) => {
      main(b).steps.splice(1, 0, wait("n1"));
      moveStep(b, "y", (d) => fork(d).paths[0]?.steps as Step[], 0);
    });
    const theirs = change((b) => {
      (step(b, "z") as Step).name = "Z!";
      fork(b).paths.push({
        id: "q3",
        name: "Three",
        when: { match: "all", rules: [{ field: "{{trigger.n}}", op: "=", value: 0 }] },
        steps: [wait("q")],
      });
    });
    const r = mergeBundles(base(), ours, theirs);
    expect(r.clean).toBe(true);
    const all = new Set(
      [base(), ours, theirs].flatMap((b) => b.workflows.flatMap((w) => nodeIds(w.workflow))),
    );
    for (const id of r.bundle.workflows.flatMap((w) => nodeIds(w.workflow)))
      expect(all.has(id)).toBe(true);
    expect(validateBundle(r.bundle, ctx).errors).toEqual([]);
    expect(AgentBundleSchema.parse(r.bundle)).toEqual(r.bundle);
    expect(await bundleHash(r.bundle)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fast-forwards: an unchanged side yields the other side exactly", async () => {
    const custom = change((b) => {
      (step(b, "x") as Step).name = "Client X";
      main(b).steps.push(wait("client-only"));
    });
    const update = change((b) => {
      b.definition.instructions = "v2";
    });
    expect(await bundleHash(mergeBundles(base(), custom, base()).bundle)).toBe(
      await bundleHash(custom),
    );
    expect(await bundleHash(mergeBundles(base(), base(), update).bundle)).toBe(
      await bundleHash(update),
    );
    // Template update over a customized client: both kept, and the customizations survive.
    const merged = mergeBundles(base(), custom, update).bundle;
    expect(
      diffBundles(update, merged)
        .map((c) => c.path)
        .sort(),
    ).toEqual(
      diffBundles(base(), custom)
        .map((c) => c.path)
        .sort(),
    );
  });
});

describe("stripClientSpecificSettings", () => {
  it("drops settings the skill marks client-specific, in the agent and in steps", () => {
    const b = change((d) => {
      (d.definition.skills[1] as { settings: Record<string, unknown> }).settings = {
        vendors: "Acme",
        threshold: 7,
      };
      main(d).steps.push({
        id: "it",
        name: "Itemize",
        kind: "skill",
        skill: "test.itemize",
        input: {},
        settings: { vendors: "Acme", threshold: 3 },
      });
    });
    const out = stripClientSpecificSettings(b, ctx.skills ?? {});
    expect(out.definition.skills[1]?.settings).toEqual({ threshold: 7 });
    expect((step(out, "it") as { settings: unknown }).settings).toEqual({ threshold: 3 });
    expect((b.definition.skills[1] as { settings: Record<string, unknown> }).settings.vendors).toBe(
      "Acme",
    );
  });
});
