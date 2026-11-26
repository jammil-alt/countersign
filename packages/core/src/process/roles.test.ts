// Triggers and outputs (owner, 2026-11-23): each workflow's role, from the self hand-offs.
import { describe, expect, it } from "vitest";
import { workflowRoles, workflowsOfRole } from "./roles";
import type { Step } from "./schema";

const read = (id: string): Step => ({ id, name: id, kind: "read", tool: "t.read", input: {} });
const handTo = (id: string, workflow: string, step = "s1"): Step => ({
  id,
  name: `Hand off to ${workflow}`,
  kind: "handoff",
  to: { agent: "@self", workflow, step },
  input: {},
});
const wf = (slug: string, steps: Step[], enabled = true) => ({
  slug,
  enabled,
  workflow: {
    schemaVersion: 4 as const,
    triggers: [{ id: `${slug}-t`, on: { type: "manual" as const, input: { type: "object" } } }],
    steps,
  },
});

describe("workflow roles", () => {
  it("reads the main workflow, its triggers and its outputs from the hand-offs", () => {
    const roles = workflowRoles([
      wf("check", [
        read("s1"),
        read("s2"),
        handTo("out-bill", "bill"),
        handTo("out-prices", "prices"),
      ]),
      wf("upload", [read("u1"), handTo("in-u", "check", "s1")]),
      // The hand-in sits inside a loop: still a trigger.
      wf("scan", [
        read("b1"),
        {
          id: "each",
          name: "Each bill",
          kind: "for_each",
          over: "{{steps.b1.output}}",
          concurrency: 1,
          steps: [read("b2"), handTo("in-s", "check", "s1")],
        } as Step,
      ]),
      wf("bill", [read("l1")]),
      wf("prices", [read("p1")]),
      wf("loose", [read("x1")]),
    ]);
    expect(roles.get("check")).toEqual({ role: "main", main: "check", at: null });
    expect(roles.get("upload")).toEqual({ role: "trigger", main: "check", at: "s1" });
    expect(roles.get("scan")?.role).toBe("trigger");
    expect(roles.get("bill")).toEqual({ role: "output", main: "check", at: "out-bill" });
    expect(roles.get("prices")).toEqual({ role: "output", main: "check", at: "out-prices" });
    expect(roles.get("loose")?.role).toBe("other");
    expect(workflowsOfRole(roles, "trigger")).toEqual(["upload", "scan"]);
    expect(workflowsOfRole(roles, "output")).toEqual(["bill", "prices"]);
  });

  it("takes the first enabled workflow as main, and leaves turned-off ones out", () => {
    const roles = workflowRoles([
      wf("old", [handTo("h", "check")], false),
      wf("check", [read("s1"), handTo("out", "off")]),
      wf("off", [read("o1")], false),
    ]);
    expect(roles.get("check")?.role).toBe("main");
    expect(roles.get("old")?.role).toBe("other");
    // A hand-off to a turned-off workflow makes no output.
    expect(roles.get("off")?.role).toBe("other");
  });

  it("calls a workflow the main one hands off to an output, even when it hands back in", () => {
    const roles = workflowRoles([
      wf("check", [read("s1"), handTo("out", "fix")]),
      wf("fix", [read("f1"), handTo("back", "check")]),
    ]);
    expect(roles.get("fix")?.role).toBe("output");
  });

  it("has no main without an enabled v4 workflow", () => {
    const roles = workflowRoles([
      { slug: "v3", workflow: { schemaVersion: 3 } },
      wf("off", [read("o1")], false),
    ]);
    expect([...roles.values()].every((r) => r.role === "other" && r.main === null)).toBe(true);
  });
});
