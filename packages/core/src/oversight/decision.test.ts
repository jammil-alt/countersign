// v0.13 W2-I: run oversight's decision schema, settings and words (docs/plan.md §1.54).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { routeFamily } from "../api/contract";
import { routes } from "../api/routes";
import { LOCALES } from "../i18n/locale";
import { OVERSIGHT_WORDS, oversightLine } from "../i18n/oversight";
import { isPlainObject } from "../json";
import { AgentDefinition } from "../schemas/agent";
import { ActionStep, SkillStep } from "../schemas/workflow";
import {
  changedFields,
  fieldLabel,
  NEW_AGENT_OVERSIGHT,
  OversightSettings,
  oversightFingerprint,
  oversightFinishSchema,
  parseOversightDecision,
  reviewsFailures,
  stepPathOf,
} from "./decision";

const note = "The vendor name had a trailing space.";

describe("the decision schema", () => {
  it("takes each decision after a failure, with its note, sources and proposal", () => {
    for (const raw of [
      { action: "retry", after: "30 seconds", note, sources: [] },
      { action: "retry_with", input: { name: "Acme" }, note, sources: ["r1"] },
      { action: "ask", question: "Is the vendor Acme?", note, sources: [] },
      {
        action: "stop",
        note,
        sources: [],
        proposal: { summary: "Trim the vendor name", change: "Add a trim before the lookup" },
      },
    ]) {
      expect(parseOversightDecision(raw, "failed"), JSON.stringify(raw)).toMatchObject({
        ok: true,
      });
    }
  });

  it("refuses what §10.11's table doesn't allow: continue after a failure, retry at a checkpoint", () => {
    expect(parseOversightDecision({ action: "continue", note, sources: [] }, "failed")).toEqual({
      ok: false,
      reason: "continue is not allowed after a failed step",
    });
    expect(
      parseOversightDecision({ action: "retry", note, sources: [] }, "checkpoint"),
    ).toMatchObject({ ok: false });
    expect(
      parseOversightDecision({ action: "continue", note, sources: [] }, "checkpoint"),
    ).toMatchObject({ ok: true });
  });

  it("has no field for changing a step, an approval, a permission, a mode or a stage", () => {
    for (const extra of [
      { approval: { required: "not_required" } },
      { mode: "act" },
      { steps: [] },
      { skip: true },
      { stage: "live" },
      { permissions: { update: "auto" } },
    ]) {
      expect(
        parseOversightDecision({ action: "retry", note, sources: [], ...extra }, "failed").ok,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("bounds the note, the wait and the question", () => {
    expect(parseOversightDecision({ action: "stop", note: "", sources: [] }, "failed").ok).toBe(
      false,
    );
    expect(
      parseOversightDecision({ action: "stop", note: "x".repeat(2001), sources: [] }, "failed").ok,
    ).toBe(false);
    expect(
      parseOversightDecision({ action: "retry", after: "2 hours", note, sources: [] }, "failed"),
    ).toEqual({ ok: false, reason: "a retry waits at most an hour" });
    expect(
      parseOversightDecision({ action: "retry", after: "1 hour", note, sources: [] }, "failed").ok,
    ).toBe(true);
    expect(parseOversightDecision({ action: "ask", note, sources: [] }, "failed").ok).toBe(false);
    expect(
      parseOversightDecision({ action: "retry_with", input: "Acme", note, sources: [] }, "failed")
        .ok,
    ).toBe(false);
  });

  it("offers the model one flat finish schema with only the cause's actions", () => {
    const schema = oversightFinishSchema("failed") as {
      type: string;
      properties: { action: { enum: string[] } };
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.action.enum).toEqual(["retry", "retry_with", "ask", "stop"]);
    expect(schema.required).toEqual(["action", "note", "sources"]);
  });
});

describe("oversight settings", () => {
  it("is absent on agents made before v0.13, and new agents review failures", () => {
    const def = {
      schemaVersion: 2,
      identity: { name: "A", role: "r", mission: "m" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5" },
      instructions: "",
      skills: [],
    };
    expect(AgentDefinition.parse(def).oversight).toBeUndefined();
    expect(AgentDefinition.parse({ ...def, oversight: NEW_AGENT_OVERSIGHT }).oversight).toEqual({
      review: "failures",
      maxPerRun: 3,
      maxCostUsd: "0.25",
    });
    expect(OversightSettings.safeParse({ review: "sometimes" }).success).toBe(false);
    expect(OversightSettings.safeParse({ review: "all", approval: "off" }).success).toBe(false);
  });

  it("lets a skill or action step say off or always, and follows the agent otherwise", () => {
    const skill = SkillStep.parse({
      id: "s",
      kind: "skill",
      name: "S",
      skill: "docs.extract",
      review: "always",
    });
    expect(skill.review).toBe("always");
    expect(
      ActionStep.safeParse({ id: "a", kind: "action", name: "A", tool: "x.y", review: "never" })
        .success,
    ).toBe(false);
    const failures = OversightSettings.parse({ review: "failures" });
    const off = OversightSettings.parse({ review: "off" });
    expect(reviewsFailures(undefined, {})).toBe(false);
    expect(reviewsFailures(off, {})).toBe(false);
    expect(reviewsFailures(failures, {})).toBe(true);
    expect(reviewsFailures(failures, { review: "off" })).toBe(false);
    expect(reviewsFailures(undefined, { review: "always" })).toBe(true);
    expect(reviewsFailures(off, { review: "auto" })).toBe(false);
  });
});

describe("helpers", () => {
  it("finds the changed fields and names them for people", () => {
    expect(changedFields({ name: "Acme ", n: 1 }, { name: "Acme", n: 1 })).toEqual(["name"]);
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(fieldLabel({ properties: { name: { title: "vendor name" } } }, "name")).toBe(
      "vendor name",
    );
    expect(fieldLabel({}, "vendorName")).toBe("vendor name");
    expect(fieldLabel(null, "due_date")).toBe("due date");
    // A field name is never looked up through the prototype.
    expect(fieldLabel({ properties: {} }, "__proto__")).toBe("proto");
    expect(fieldLabel({ properties: {} }, "constructor")).toBe("constructor");
  });

  it("fingerprints a proposal by agent, workflow, step and its summary in any wording of spaces and case", () => {
    const a = oversightFingerprint({
      agentId: "ag",
      workflowSlug: "wf",
      nodeId: "each:3:lookup",
      summary: "Trim  the vendor\nname",
    });
    const b = oversightFingerprint({
      agentId: "ag",
      workflowSlug: "wf",
      nodeId: "each:7:lookup",
      summary: " trim the Vendor name ",
    });
    expect(a).toBe(b);
    expect(stepPathOf("each:12:inner")).toBe("each:inner");
    expect(stepPathOf("use/inner")).toBe("use/inner");
  });
});

describe("the client's words", () => {
  it("has every line in all six languages", () => {
    for (const l of LOCALES) {
      const w = OVERSIGHT_WORDS[l];
      expect(w, l).toBeDefined();
      for (const line of [
        w.triedAgain,
        w.correctedField("x"),
        w.correctedInput,
        w.asked("Dana"),
        w.askedTeam,
        w.stopped,
        w.checked,
        w.askTitle("Find"),
      ]) {
        expect(line.trim().length, l).toBeGreaterThan(0);
      }
    }
  });

  it("says what happened in the platform's words", () => {
    expect(oversightLine("en", { action: "retry_with", field: "vendor name" })).toBe(
      "Corrected the vendor name and tried again",
    );
    expect(oversightLine("en", { action: "retry_with" })).toBe(
      "Corrected the input and tried again",
    );
    expect(oversightLine("en", { action: "retry" })).toBe("Tried again");
    expect(oversightLine("en", { action: "ask", askedName: "Dana" })).toBe("Asked Dana");
    expect(oversightLine("en", { action: "stop" })).toBe("Stopped");
    expect(oversightLine("es", { action: "retry" })).toBe("Se intentó de nuevo");
  });
});

describe("the portal never carries a decision", () => {
  /** Property names anywhere in a schema. */
  function fields(schema: z.ZodType): string[] {
    const found = new Set<string>();
    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      if (!isPlainObject(node)) return;
      if (isPlainObject(node.properties))
        for (const k of Object.keys(node.properties)) found.add(k);
      for (const v of Object.values(node)) visit(v);
    };
    visit(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));
    return [...found];
  }

  it("no portal route returns oversight_decision fields or model names", () => {
    const forbidden = new Set([
      "inputBefore",
      "inputAfter",
      "diagnosis",
      "proposal",
      "model",
      "models",
      "oversightDecision",
      "oversightNote",
    ]);
    const problems: string[] = [];
    for (const [name, r] of Object.entries(routes)) {
      if (routeFamily(r) !== "portal") continue;
      const bad = fields(r.response).filter((f) => forbidden.has(f));
      if (bad.length > 0) problems.push(`${name}: ${bad.join(", ")}`);
    }
    expect(problems).toEqual([]);
    // The timeline's oversight lines are plain strings.
    expect(routes.portalRun.response.shape.steps.element.shape.oversight).toBeDefined();
  });
});
