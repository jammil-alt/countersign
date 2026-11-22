// The Bookkeeping manifest (docs/plan.md §1.79): a valid PackManifest; every tool has its handler
// and is the pack's own read or record (never a write outside); every skill uses tools that exist;
// the Bookkeeper keeps approval on for every write and names only the QuickBooks writes it needs.

import {
  BANKFEED_TOOLS,
  BANKING_TOOLS,
  BANKING_FIND_TOOL as QBO_BANKING_FIND,
  QBO_REGISTER_TOOL,
} from "@countersign/connectors";
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
    expect(bundle.definition.extraTools.sort()).toEqual(Object.values(BANKING_TOOLS).sort());
    const skills = new Set(bundle.definition.skills.map((s) => s.skill));
    const actions: string[] = [];
    for (const wf of bundle.workflows) {
      walkSteps(wf.workflow, ({ step }: { step: Step }) => {
        if (step.kind === "skill") expect(skills.has(step.skill), step.skill).toBe(true);
        // R-1: the only connector reads are the bank's balances and QuickBooks' register.
        if (step.kind === "skill" && !step.skill.startsWith("bookkeeping.")) {
          expect([BANKFEED_TOOLS.accounts, QBO_REGISTER_TOOL]).toContain(step.skill);
        }
        if (step.kind === "action") {
          actions.push(step.tool);
          expect(step.approval?.required, step.id).toBe("required");
        }
      });
    }
    expect(actions.sort()).toEqual(Object.values(BANKING_TOOLS).sort());
  });

  it("goes on to the next booking when one can't be written (v4)", () => {
    const [template] = bookkeepingManifest.templates;
    const latest = template?.versions?.at(-1) as AgentBundle | undefined;
    if (!latest) throw new Error("no later version");
    const loops: Step[] = [];
    for (const wf of latest.workflows) {
      walkSteps(wf.workflow, ({ step }: { step: Step }) => {
        if (step.kind === "for_each" && step.id === "post") loops.push(step);
      });
    }
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect((loop as { onError?: string }).onError).toBe("continue");
  });

  it("keeps v4 the same as v3 but for the posting loop going on", () => {
    const [template] = bookkeepingManifest.templates;
    const [, v3, v4] = template?.versions ?? [];
    if (!v3 || !v4) throw new Error("no v3 or v4");
    const diffs: string[] = [];
    const walk = (a: unknown, b: unknown, path: string) => {
      if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
          walk(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
            `${path}.${k}`,
          );
        }
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
    };
    walk(JSON.parse(JSON.stringify(v3)), JSON.parse(JSON.stringify(v4)), "");
    const daily = v3.workflows.findIndex((w) => JSON.stringify(w.workflow).includes('"id":"post"'));
    expect(diffs).toEqual([
      `.workflows.${daily}.workflow.steps.6.onError: undefined -> "continue"`,
    ]);
  });

  it("(PLATFORM_QA INPUT-2) keeps v5 the same as v4 but for the statement's currency on its given side", () => {
    const [template] = bookkeepingManifest.templates;
    const [, , v4, v5] = template?.versions ?? [];
    if (!v4 || !v5) throw new Error("no v4 or v5");
    const diffs: string[] = [];
    const walk = (a: unknown, b: unknown, path: string) => {
      if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
          walk(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
            `${path}.${k}`,
          );
        }
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
    };
    walk(JSON.parse(JSON.stringify(v4)), JSON.parse(JSON.stringify(v5)), "");
    const payout = v4.workflows.findIndex((w) => w.slug === "payout-check");
    expect(diffs).toEqual([
      `.workflows.${payout}.workflow.steps.1.input.b.currency: undefined -> "{{steps.statement.output.currency}}"`,
    ]);
  });

  it("(§1.187) keeps v6 the same as v5 but for the read of QuickBooks and a check before each write", () => {
    const [template] = bookkeepingManifest.templates;
    const [, , , v5, v6] = (template?.versions ?? []) as (AgentBundle | undefined)[];
    if (!v5 || !v6) throw new Error("no v5 or v6");
    const NEW_STEPS = new Set(["find", "check-purchase", "check-deposit", "check-transfer"]);
    const NEW_TOOLS = [QBO_BANKING_FIND, "bookkeeping.booking.write-check"];
    // Where each new step is: the read after the layout, the found path first, a check right
    // before each write.
    let loops = 0;
    for (const wf of v6.workflows) {
      walkSteps(wf.workflow, ({ step }: { step: Step }) => {
        if (step.kind !== "for_each" || step.id !== "post") return;
        loops += 1;
        const body = (step as unknown as { steps: { id: string; kind: string }[] }).steps;
        expect(body.map((s) => s.id)).toEqual(["qin", "find", "which"]);
        const which = body[2] as unknown as {
          paths: { id: string; steps: { id: string; tool?: string }[] }[];
        };
        expect(which.paths.map((p) => [p.id, p.steps.map((s) => s.id)])).toEqual([
          ["post-written", ["recorded"]],
          ["post-purchase", ["check-purchase", "write-purchase", "posted-purchase"]],
          ["post-deposit", ["check-deposit", "write-deposit", "posted-deposit"]],
          ["post-transfer", ["check-transfer", "write-transfer", "posted-transfer"]],
        ]);
        expect(which.paths[0]?.steps[0]?.tool).toBe("bookkeeping.booking.posted");
      });
    }
    expect(loops).toBe(1);
    // Take them out again and v6 is v5, to the letter.
    const strip = (steps: unknown[]): unknown[] =>
      steps
        .filter((s) => !NEW_STEPS.has((s as { id: string }).id))
        .map((s) => {
          const x = s as Record<string, unknown>;
          const out: Record<string, unknown> = { ...x };
          if (Array.isArray(x.steps)) out.steps = strip(x.steps);
          if (Array.isArray(x.paths)) {
            out.paths = (x.paths as Record<string, unknown>[])
              .filter((p) => p.id !== "post-written")
              .map((p) => ({ ...p, steps: strip(p.steps as unknown[]) }));
          }
          if (x.otherwise) {
            const o = x.otherwise as Record<string, unknown>;
            out.otherwise = { ...o, steps: strip(o.steps as unknown[]) };
          }
          return out;
        });
    const back = JSON.parse(JSON.stringify(v6));
    for (const w of back.workflows) w.workflow.steps = strip(w.workflow.steps);
    expect(back.definition.extraTools.slice(-2)).toEqual(NEW_TOOLS);
    back.definition.extraTools = back.definition.extraTools.slice(0, -2);
    expect(back).toEqual(JSON.parse(JSON.stringify(v5)));
    // Every write still asks for its signature.
    for (const wf of v6.workflows) {
      walkSteps(wf.workflow, ({ step }: { step: Step }) => {
        const s = step as unknown as { kind: string; tool?: string; checks?: unknown };
        if (s.kind === "write" && s.tool?.startsWith("qbo.")) {
          expect(s.checks).toMatchObject({ approval: { required: "required" } });
        }
      });
    }
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
