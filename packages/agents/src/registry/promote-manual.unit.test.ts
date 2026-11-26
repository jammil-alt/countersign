// B5 (docs/builder-plan.md §7) x invariant 1: a client's changes to its copy's settings are written
// into the copy's manual (who, when, the value). A promotion or a copy to another client never
// carries them: each such row goes back to the base template's, or is left out.

import type { AgentBundle, AgentManualInput, Decision } from "@countersign/core";
import { AgentManual, cloneJson } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { makeBundle } from "../log/harness.test-helper";
import { stripForPromotion } from "./lineage";

const BUILD_ROW: Decision = {
  id: "tolerance",
  what: "A line within 1.00 of its bill counts as a match",
  why: "The brief's rule.",
  value: "1.00",
  kind: "client_setup",
  risk: "high",
  status: "never_discussed",
  by: null,
  at: null,
};

function withManual(bundle: AgentBundle, manual: AgentManualInput): AgentBundle {
  const out = cloneJson(bundle);
  (out.definition as { manual?: unknown }).manual = AgentManual.parse(manual);
  return out;
}

function decisionsOf(bundle: AgentBundle) {
  return AgentManual.parse((bundle.definition as { manual?: unknown }).manual).decisions;
}

describe("promotion and the manual's record of a client's changes", () => {
  const base = withManual(makeBundle(), { whatItDoes: "Matches bills.", decisions: [BUILD_ROW] });
  const client = withManual(makeBundle(), {
    whatItDoes: "Matches bills.",
    decisions: [
      // The client admin changed the build's decision on their Settings.
      {
        ...BUILD_ROW,
        value: "3.00",
        status: "changed",
        by: "Ada Client",
        at: "2026-11-19T10:00:00Z",
        side: "client",
      },
      // And a setting with no decision of its own.
      {
        id: "set-param-cutoff",
        what: "Cutoff day: 25",
        why: "Set by Ada Client on the agent's settings.",
        value: "25",
        kind: "client_setup",
        risk: "normal",
        status: "changed",
        by: "Ada Client",
        at: "2026-11-19T10:05:00Z",
        side: "client",
      },
      // A row the copy's own build wrote stays.
      { ...BUILD_ROW, id: "credits", what: "Credits go to a person", value: undefined },
    ],
  });

  it("puts a changed row back to the template's and leaves out the client's own rows", () => {
    const out = stripForPromotion(client, base, {});
    const rows = decisionsOf(out);
    expect(rows.map((d) => d.id)).toEqual(["tolerance", "credits"]);
    expect(rows[0]).toEqual(BUILD_ROW);
    const text = JSON.stringify(out);
    expect(text).not.toContain("Ada Client");
    expect(text).not.toContain("3.00");
  });

  it("leaves out a changed row the template doesn't have", () => {
    const out = stripForPromotion(client, withManual(makeBundle(), { decisions: [] }), {});
    expect(decisionsOf(out).map((d) => d.id)).toEqual(["credits"]);
    expect(JSON.stringify(out)).not.toContain("Ada Client");
  });

  it("keeps a manual nobody changed exactly as stored", () => {
    const untouched = withManual(makeBundle(), {
      whatItDoes: "Matches bills.",
      decisions: [BUILD_ROW],
    });
    const out = stripForPromotion(untouched, base, {});
    expect((out.definition as { manual?: unknown }).manual).toEqual(
      (untouched.definition as { manual?: unknown }).manual,
    );
  });
});
