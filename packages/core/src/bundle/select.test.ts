import { describe, expect, it } from "vitest";
import { type AgentBundle, AgentBundle as AgentBundleSchema } from "../schemas/agent";
import type { ForkStep, Step, Workflow } from "../schemas/workflow";
import { bundle, edit } from "../testing/fixtures";
import { diffBundles } from "./diff";
import { mergeBundles } from "./merge";
import { selectableBetween, selectableChanges, selectChanges } from "./select";

const wait = (id: string): Step => ({ id, name: id.toUpperCase(), kind: "wait", for: "1 hour" });

/** main: a, f (fork: q1 [x], otherwise oz [z]), b. */
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
        ],
        otherwise: { id: "oz", steps: [wait("z")] },
      },
      wait("b"),
    ],
  };
  b.workflows.push({ slug: "main", name: "Main", enabled: true, workflow: main });
  return AgentBundleSchema.parse(b);
}

const main = (b: AgentBundle) => b.workflows.find((w) => w.slug === "main")?.workflow as Workflow;
const ids = (steps: Step[]) => steps.map((s) => s.id);
const fork = (b: AgentBundle) => main(b).steps.find((s) => s.id === "f") as ForkStep;

/** The client's version: three independent changes and a new fork path holding a new step. */
function client(): AgentBundle {
  return edit(base(), (b) => {
    b.definition.instructions = "Client's own instructions";
    (main(b).steps[0] as Step).name = "A for the client";
    main(b).steps.push(wait("c"));
    fork(b).paths.push({
      id: "q2",
      name: "Two",
      when: { match: "all", rules: [{ field: "{{trigger.n}}", op: "<", value: 0 }] },
      steps: [wait("y")],
    });
  });
}

describe("selectableChanges", () => {
  it("groups changes by item and agent field", () => {
    const groups = selectableBetween(base(), client()).map((g) => g.id);
    expect(groups).toEqual(
      expect.arrayContaining([
        "bundle#/definition/instructions",
        "step:a",
        "step:c",
        "path:q2",
        "step:y",
      ]),
    );
  });

  it("puts a step's move within its list under that list's reorder", () => {
    const moved = edit(base(), (b) => {
      const s = main(b).steps;
      s.push(s.shift() as Step);
    });
    const groups = selectableChanges(diffBundles(base(), moved));
    expect(groups.map((g) => g.id)).toEqual(["workflow:main>steps"]);
    expect(groups[0]?.changes.map((c) => c.kind)).toEqual(["reordered", "moved"]);
  });
});

describe("selectChanges", () => {
  it("with every change selected is the other bundle", () => {
    const all = selectableBetween(base(), client()).map((g) => g.id);
    expect(selectChanges(base(), client(), all)).toEqual(client());
  });

  it("with nothing selected is the first bundle", () => {
    expect(selectChanges(base(), client(), [])).toEqual(base());
  });

  it("applies only the selected changes", () => {
    const out = selectChanges(base(), client(), ["step:c", "bundle#/definition/instructions"]);
    expect(out.definition.instructions).toBe("Client's own instructions");
    expect(ids(main(out).steps)).toEqual(["a", "f", "b", "c"]);
    expect(main(out).steps[0]?.name).toBe("A");
    expect(fork(out).paths.map((p) => p.id)).toEqual(["q1"]);
  });

  it("brings an added container's added contents with it", () => {
    const out = selectChanges(base(), client(), ["path:q2"]);
    expect(fork(out).paths.map((p) => p.id)).toEqual(["q1", "q2"]);
    expect(ids(fork(out).paths[1]?.steps ?? [])).toEqual(["y"]);
  });

  it("leaves out an added step whose new container is not selected", () => {
    const out = selectChanges(base(), client(), ["step:y"]);
    expect(fork(out).paths.map((p) => p.id)).toEqual(["q1"]);
    expect(JSON.stringify(out)).not.toContain('"y"');
  });

  it("keeps a step in its old place when its move into an unselected container is picked", () => {
    const moved = edit(client(), (b) => {
      const s = main(b).steps;
      const bStep = s.splice(
        s.findIndex((x) => x.id === "b"),
        1,
      )[0] as Step;
      fork(b).paths[1]?.steps.push(bStep);
    });
    const out = selectChanges(base(), moved, ["step:b"]);
    expect(ids(main(out).steps)).toEqual(["a", "f", "b"]);
  });

  it("removes a removed item with its contents", () => {
    const removed = edit(base(), (b) => {
      fork(b).paths.splice(0, 1);
    });
    const out = selectChanges(base(), removed, ["path:q1"]);
    expect(fork(out).paths).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  it("takes a reorder only when the list is selected", () => {
    const moved = edit(base(), (b) => {
      const s = main(b).steps;
      s.push(s.shift() as Step);
    });
    expect(ids(main(selectChanges(base(), moved, [])).steps)).toEqual(["a", "f", "b"]);
    expect(ids(main(selectChanges(base(), moved, ["workflow:main>steps"])).steps)).toEqual([
      "f",
      "b",
      "a",
    ]);
  });

  it("feeds a promotion that carries only the picked change", () => {
    const templateLive = edit(base(), (b) => {
      b.definition.identity.mission = "File invoices well";
    });
    const theirs = selectChanges(base(), client(), ["step:c"]);
    const r = mergeBundles(base(), templateLive, theirs);
    expect(r.clean).toBe(true);
    expect(r.bundle.definition.identity.mission).toBe("File invoices well");
    expect(r.bundle.definition.instructions).toBe(base().definition.instructions);
    expect(ids(main(r.bundle).steps)).toEqual(["a", "f", "b", "c"]);
  });
});
