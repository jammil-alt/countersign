// Ways in, ways out (owner, 2026-11-23): steps one workflow repeats from another.

import { describe, expect, it } from "vitest";
import { COPY_MIN_STEPS, copiedSteps, copiedStepsMessage } from "./copies";
import type { Step } from "./schema";

const read = (id: string, tool = "qbo.bills.get"): Step =>
  ({ id, name: `Read ${id}`, kind: "read", tool, input: {} }) as Step;
const skill = (id: string, ref = "invoice-check@2"): Step =>
  ({ id, name: `Check ${id}`, kind: "skill", skill: ref, input: {} }) as Step;
const write = (id: string, action = "post"): Step =>
  ({ id, name: `Write ${id}`, kind: "write", tool: "qbo.bill.update", action, input: {} }) as Step;
const notify = (id: string): Step =>
  ({
    id,
    name: `Tell ${id}`,
    kind: "notify",
    notify: { to: ["client_admin"], channel: "inbox", message: "Done" },
  }) as Step;
const person = (id: string): Step => ({ id, name: `Ask ${id}`, kind: "person" }) as Step;
const stop = (id: string): Step =>
  ({ id, name: "Stop", kind: "stop", status: "succeeded" }) as Step;
const loop = (id: string, steps: Step[]): Step =>
  ({ id, name: "Each", kind: "for_each", over: "{{trigger.items}}", steps }) as Step;
const decide = (id: string, steps: Step[]): Step =>
  ({
    id,
    name: "Unread?",
    kind: "if",
    paths: [{ id: `${id}p`, name: "Unread", when: { match: "all", rules: [] }, steps }],
    otherwise: { id: `${id}o`, name: "Otherwise", steps: [] },
  }) as Step;
const wf = (slug: string, steps: Step[]) => ({ slug, workflow: { steps } });

describe("copied steps", () => {
  // The Builder's answer (2026-11-23): a nightly scan whose loop copied every step of the first.
  const main = wf("check-invoice", [read("a"), skill("b"), write("c"), notify("d")]);

  it("finds the main workflow's steps copied into a scan's loop, nested in a decision", () => {
    const scan = wf("nightly-scan", [
      read("find", "qbo.bills.list"),
      loop("each", [decide("u", [read("a2"), skill("b2"), write("c2"), notify("d2")])]),
    ]);
    const [run, ...rest] = copiedSteps([main, scan]);
    expect(rest).toEqual([]);
    expect(run).toEqual({
      from: "check-invoice",
      in: "nightly-scan",
      stepIds: ["a2", "b2", "c2", "d2"],
      names: ["Read a2", "Check b2", "Write c2", "Tell d2"],
    });
    expect(run && copiedStepsMessage(run)).toBe(
      '"nightly-scan" repeats 4 steps of "check-invoice", from "Read a2" on: keep them in "check-invoice" alone and end "nightly-scan" by handing off into "check-invoice" with "@self", one hand-off per item',
    );
  });

  it("matches a skill by id, whatever its version, and a decision only with all inside it", () => {
    const a = wf("a", [read("x"), decide("d", [write("w")]), skill("s", "invoice-check@1")]);
    const b = wf("b", [read("y"), decide("e", [write("v")]), skill("t", "invoice-check")]);
    expect(copiedSteps([a, b])[0]?.stepIds).toEqual(["y", "e", "t"]);
    const c = wf("c", [read("y"), decide("e", [write("v", "void")]), skill("t")]);
    expect(copiedSteps([a, c])).toEqual([]);
  });

  it(`needs ${COPY_MIN_STEPS} steps in a row, two of them calling something`, () => {
    // Two in a row is not a copy.
    expect(copiedSteps([main, wf("b", [read("a2"), skill("b2"), person("p")])])).toEqual([]);
    // Steps that call nothing match by kind alone, and never make a copy by themselves.
    const plain = [person("p"), notify("n"), stop("s")];
    expect(copiedSteps([wf("a", plain), wf("b", [person("q"), notify("m"), stop("t")])])).toEqual(
      [],
    );
    // Another tool is another step.
    expect(
      copiedSteps([main, wf("b", [read("a2", "qbo.vendor.get"), skill("b2"), write("c2")])]),
    ).toEqual([]);
    // Two calls and a notify are.
    expect(
      copiedSteps([main, wf("b", [person("p"), skill("b2"), write("c2"), notify("d2")])])[0]
        ?.stepIds,
    ).toEqual(["b2", "c2", "d2"]);
  });

  it("looks only across workflows, never inside one", () => {
    const twice = wf("a", [
      read("a"),
      skill("b"),
      write("c"),
      read("a2"),
      skill("b2"),
      write("c2"),
    ]);
    expect(copiedSteps([twice])).toEqual([]);
  });
});
