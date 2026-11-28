import { describe, expect, it } from "vitest";
import {
  NEW_AGENT_OVERSIGHT,
  OversightSettings,
  oversightReviewOf,
  withOversightReview,
} from "../oversight/decision";
import type { ActionKind } from "../steps/catalog";
import { type Step, Workflow } from "../steps/schema";
import { stepModelCheckpoints, stepModelWatched, supervisedSteps } from "./step-model-owner";

const KINDS: Record<string, ActionKind> = {
  "qbo.bill.query": "get",
  "qbo.bill.create": "change",
  "materials.vendor_items.register": "save",
};
const ctx = { kindOf: (a: string) => KINDS[a] };

const wf = (steps: unknown[]) =>
  Workflow.parse({
    schemaVersion: 5,
    triggers: [{ id: "t1", on: { type: "event", event: "document.extracted" } }],
    outputs: [{ id: "o_none", name: "Nothing to do", kind: "nothing" }],
    steps,
  });

const extract = {
  id: "s_read",
  kind: "do",
  name: "Read the invoice",
  doneBy: "ai",
  uses: { type: "skill", skill: "docs.read-document" },
  input: { documentId: "{{trigger.documentId}}" },
};
const find = {
  id: "s_find",
  kind: "do",
  name: "Find the bill",
  doneBy: "rules",
  uses: { type: "action", action: "qbo.bill.query" },
  input: { vendor: "{{steps.s_read.output.vendor}}" },
};
const save = {
  id: "s_save",
  kind: "do",
  name: "Save the items",
  doneBy: "rules",
  uses: { type: "action", action: "materials.vendor_items.register" },
  input: { lines: "{{steps.s_find.output.lines}}" },
};
const create = {
  id: "s_create",
  kind: "do",
  name: "Create the bill",
  doneBy: "rules",
  uses: { type: "action", action: "qbo.bill.create" },
  input: { lines: "{{steps.s_read.output.lines}}" },
};
const tell = {
  id: "s_tell",
  kind: "do",
  name: "Tell the team",
  doneBy: "rules",
  uses: { type: "tell" },
  tell: { to: ["client_admin"], message: "Done" },
};
const end = { id: "s_end", kind: "end", name: "Done", outputs: ["o_none"] };

describe("the owner on a v5 workflow", () => {
  it("watches the steps that run as a read, a skill, a write or a conversation, and Loops", () => {
    const w = wf([
      extract,
      tell,
      { id: "s_loop", kind: "loop", name: "Look around", goal: "Find it" },
      { id: "s_wait", kind: "wait", name: "Wait", for: "1 hour" },
      end,
    ]);
    const watched = (id: string) => stepModelWatched(w.steps.find((s) => s.id === id) as Step, ctx);
    expect(watched("s_read")).toBe(true);
    expect(watched("s_loop")).toBe(true);
    expect(watched("s_tell")).toBe(false);
    expect(watched("s_wait")).toBe(false);
  });

  it("makes a checkpoint of a step whose output feeds a Change, not a Save", () => {
    const w = wf([extract, find, save, create, end]);
    expect(stepModelCheckpoints(w, ctx)).toEqual(["s_read"]);
  });

  it("makes a checkpoint of a step set to always, and none from an action it doesn't know", () => {
    const w = wf([
      { ...find, review: "always" },
      { ...create, uses: { type: "action", action: "acme.unknown" } },
      end,
    ]);
    expect(stepModelCheckpoints(w, ctx)).toEqual(["s_find"]);
  });

  it("reads steps inside a Fork's paths and a For each", () => {
    const w = wf([
      extract,
      {
        id: "s_fork",
        kind: "fork",
        name: "Known?",
        paths: [
          {
            id: "p_yes",
            name: "Yes",
            when: { match: "all", rules: [] },
            steps: [
              { id: "s_each", kind: "for_each", name: "Each line", over: "{{x}}", steps: [create] },
            ],
          },
        ],
        otherwise: { id: "p_else", steps: [] },
      },
      end,
    ]);
    expect(stepModelCheckpoints(w, ctx)).toEqual(["s_read"]);
  });

  it("lists the steps reviewed after they succeed, at each level", () => {
    const w = wf([
      extract,
      find,
      { ...save, review: "always" },
      { ...create, review: "off" },
      tell,
      end,
    ]);
    const at = (r: "off" | "failures" | "checkpoints" | "all") =>
      Object.fromEntries(supervisedSteps(w, r, ctx));
    // `always` on a step holds under every level; `off` on a step wins.
    expect(at("off")).toEqual({ s_save: "always" });
    expect(at("failures")).toEqual({ s_save: "always" });
    expect(at("checkpoints")).toEqual({ s_read: "checkpoint", s_save: "always" });
    expect(at("all")).toEqual({ s_read: "all", s_find: "all", s_save: "always" });
  });

  it("skips a draft's Do step that has no engine yet", () => {
    const w = wf([
      { id: "s_new", kind: "do", name: "", doneBy: "contact", uses: { type: "tell" } },
      end,
    ]);
    expect(Object.fromEntries(supervisedSteps(w, "all", ctx))).toEqual({});
  });
});

describe("the owner's level in the step builder", () => {
  it("reads the saved level, else the new-agent default", () => {
    expect(oversightReviewOf(undefined)).toBe("failures");
    expect(oversightReviewOf({ review: "all" })).toBe("all");
  });

  it("changes the review and keeps the rest; starts from the new-agent default", () => {
    const saved = OversightSettings.parse({
      review: "failures",
      verify: "writes",
      maxPerRun: 5,
      model: { id: "some-model", maxTokens: 1000 },
    });
    expect(withOversightReview(saved, "all")).toEqual({ ...saved, review: "all" });
    const fresh = withOversightReview(undefined, "checkpoints");
    expect(fresh).toEqual(
      OversightSettings.parse({ ...NEW_AGENT_OVERSIGHT, review: "checkpoints" }),
    );
    expect(fresh.verify).toBe("writes");
  });
});
