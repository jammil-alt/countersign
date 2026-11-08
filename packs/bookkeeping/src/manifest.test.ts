// The Bookkeeping manifest (docs/plan.md §1.79): a valid PackManifest; every tool has its handler
// and is the pack's own read or record (never a write outside); every skill uses tools that exist;
// the Bookkeeper keeps approval on for every write and names only the QuickBooks writes it needs.

import { BANKFEED_TOOLS, BANKING_TOOLS, QBO_REGISTER_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  PackManifest,
  SkillDefinition,
  type Step,
  walkSteps,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { BOOKKEEPING_ACTIONS, BOOKKEEPING_REPORTS, BOOKKEEPING_REVIEWS } from "./api";
import { BOOKKEEPING_HANDLERS, BOOKKEEPING_SKILLS, bookkeepingManifest } from "./manifest";

describe("the Bookkeeping manifest", () => {
  it("parses, and names its tools after the pack", () => {
    expect(PackManifest.safeParse(bookkeepingManifest).success).toBe(true);
    for (const t of bookkeepingManifest.tools) expect(t.id.startsWith("bookkeeping.")).toBe(true);
  });

  it("has a handler for every tool, and no tool that writes outside", () => {
    expect(Object.keys(BOOKKEEPING_HANDLERS).sort()).toEqual(
      bookkeepingManifest.tools.map((t) => t.id).sort(),
    );
    for (const spec of bookkeepingManifest.tools) {
      expect(BOOKKEEPING_HANDLERS[spec.id]?.spec).toEqual(spec);
      expect(spec.sideEffect).not.toBe("external");
      expect(spec.source).toBe("bookkeeping");
    }
  });

  it("gives every skill tools that exist, and requires the pack", () => {
    // The statement reader reads the document with the platform's own docs tools.
    const tools = new Set([...bookkeepingManifest.tools.map((t) => t.id), "docs.read", "docs.get"]);
    for (const skill of BOOKKEEPING_SKILLS) {
      expect(SkillDefinition.safeParse(skill).success, skill.id).toBe(true);
      for (const t of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
        expect(tools.has(t), `${skill.id} → ${t}`).toBe(true);
      }
      expect(skill.requiresPacks).toContain("bookkeeping");
    }
  });

  it("ships the Bookkeeper with approval on for every write, in suggest-only mode", () => {
    const [template] = bookkeepingManifest.templates;
    expect(template?.slug).toBe("bookkeeper");
    const bundle = template?.bundle as AgentBundle;
    expect(bundle.definition.permissions.mode).toBe("suggest_only");
    // The QuickBooks writes, and two reads for reconciling (R-1).
    const reads = [BANKFEED_TOOLS.accounts, QBO_REGISTER_TOOL];
    expect(bundle.definition.extraTools.sort()).toEqual(
      [...Object.values(BANKING_TOOLS), ...reads].sort(),
    );
    const skills = new Set(bundle.definition.skills.map((s) => s.skill));
    const actions: string[] = [];
    for (const wf of bundle.workflows) {
      walkSteps(wf.workflow, ({ step }: { step: Step }) => {
        if (step.kind === "skill") expect(skills.has(step.skill), step.skill).toBe(true);
        if (step.kind === "action") {
          actions.push(step.tool);
          expect(step.approval?.required, step.id).toBe("required");
        }
      });
    }
    expect(actions.sort()).toEqual([...Object.values(BANKING_TOOLS), ...reads].sort());
  });

  it("serves its cards, actions and reports by name", () => {
    expect(Object.keys(BOOKKEEPING_REVIEWS).sort()).toEqual([
      "bookkeeping.account-questions",
      "bookkeeping.bookings",
      "bookkeeping.reconciliation",
    ]);
    expect(Object.keys(BOOKKEEPING_ACTIONS).sort()).toEqual([
      "add-account-note",
      "add-rule",
      "import",
      "link-account",
      "turn-off-rule",
    ]);
    expect(Object.keys(BOOKKEEPING_REPORTS).sort()).toEqual([
      "accounts",
      "reconciliations",
      "rules",
      "transactions",
    ]);
  });
});
