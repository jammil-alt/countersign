// The Bookkeeping manifest (docs/plan.md §1.79): a valid PackManifest; every tool has its handler
// and is the pack's own read or record (never a write outside); every skill uses tools that exist;
// the pack ships no agent template for now (they are built again one by one, step-model-plan §12 R0).

import { PackManifest, SkillDefinition } from "@countersign/core";
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
    // The statement reader reads the document with the platform's own docs tools, and the chart of
    // accounts is Shared's (one list for every area).
    const tools = new Set([
      ...bookkeepingManifest.tools.map((t) => t.id),
      "docs.read",
      "docs.get",
      "ledger.accounts.list",
    ]);
    for (const skill of BOOKKEEPING_SKILLS) {
      expect(SkillDefinition.safeParse(skill).success, skill.id).toBe(true);
      for (const t of [
        ...(skill.handler ? [skill.handler] : []),
        ...skill.tools,
        ...(skill.reads ?? []),
      ]) {
        expect(tools.has(t), `${skill.id} → ${t}`).toBe(true);
      }
      expect(skill.requiresPacks).toContain("bookkeeping");
    }
  });

  it("ships its Loop reading only: Get actions, no write, its own limits (step model §8)", () => {
    const loop = BOOKKEEPING_SKILLS.find((s) => s.id === "bookkeeping.investigate-leftovers");
    expect(loop?.mode).toBe("agent");
    expect(loop?.loop).toMatchObject({ maxTurns: 10, atLimit: "hand_back" });
    const specs = new Map(bookkeepingManifest.tools.map((t) => [t.id, t]));
    expect(loop?.tools).toEqual([]);
    expect(loop?.reads?.length).toBeGreaterThan(0);
    for (const t of loop?.reads ?? []) expect(specs.get(t)?.sideEffect, t).toBe("none");
    // It never proposes by itself: the write is a step after it.
    expect(loop?.reads).not.toContain("bookkeeping.reconcile.propose");
  });

  it("ships its Loop with a test set, and isn't a manifest without one", () => {
    expect(Object.keys(bookkeepingManifest.loopTests ?? {})).toEqual([
      "bookkeeping.investigate-leftovers",
    ]);
    const without = PackManifest.safeParse({ ...bookkeepingManifest, loopTests: undefined });
    expect(without.success).toBe(false);
    expect(JSON.stringify(without.error?.issues)).toContain("ships without a test set");
    const stray = PackManifest.safeParse({
      ...bookkeepingManifest,
      loopTests: {
        ...bookkeepingManifest.loopTests,
        "bookkeeping.read-statement":
          bookkeepingManifest.loopTests?.["bookkeeping.investigate-leftovers"],
      },
    });
    expect(stray.success).toBe(false);
  });

  it("ships no agent template until the Bookkeeper is built again in the step model", () => {
    expect(bookkeepingManifest.templates).toEqual([]);
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
