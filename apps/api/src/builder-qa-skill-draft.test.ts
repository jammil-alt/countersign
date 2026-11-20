// A skill build's move into the draft when the Builder's first skill turn fails (the model down).
// From the Builder QA (BUILDER_QA.md, PR #441): FLOW-5 and INTEG-3. The move fails as an agent
// build's does (503, the build stays in the fit-gap), never "open it to look at the draft" over
// an empty conversation. Scripted model answers only (FakeModel), never a live model.
import type { BuildDetail } from "@countersign/core";
import { build, builderTurn } from "@countersign/db";
import { AnthropicError, FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});
const reviewed = () => ({ toolUse: { name: "submit_review", input: { concerns: [] } } });

/** What the transport throws once its retries are spent on a 529. */
const overloaded = () => {
  const body = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  return { error: new AnthropicError(`529 ${JSON.stringify(body)}`, 529, body, null) };
};

const field = (text: string) => ({ text, state: "confirmed" as const });

describe.skipIf(!h)("a skill build's first draft with the model down", () => {
  const H = h as ApiHarness;
  const ok = async <T = BuildDetail>(method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };

  // FLOW-5
  it("says the skill's first draft failed and keeps the build in the fit-gap to try again", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "skill", title: "Apply volume tiers" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: field("Apply the vendor's volume tier to each line"),
          trigger: field("An invoice line is checked"),
          dataIn: field("The line and the vendor's tier table"),
          dataOut: field("The expected unit price"),
        },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/turns`, { text: "A skill for volume tiers." });
    model.push(reviewed());
    model.push(
      turnAnswer({
        text: "One we'd build.",
        fitgap: { rows: [{ id: "tiers", need: "Volume tiers", verdict: "build", how: "A skill" }] },
      }),
    );
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "fitgap" });
    expect(b.build.phase).toBe("fitgap");
    expect(b.gate.reasons).toEqual([]);

    // The Builder's model is down for the skill's first draft.
    for (let i = 0; i < 6; i++) model.push(overloaded());
    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    const error = (res.json as { error?: { message?: string } }).error;
    expect(res.status, JSON.stringify(res.json)).toBe(503);
    expect(error?.message ?? "").toMatch(/couldn't|try again/i);
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect({ phase: b.build.phase, sessionId: b.draft?.sessionId ?? null }).toEqual({
      phase: "fitgap",
      sessionId: null,
    });
    expect(b.messages.at(-1)?.text ?? "").not.toMatch(/look at the draft/i);
  });

  // INTEG-3
  it("doesn't say a draft is there to look at when the first draft couldn't be made", async () => {
    const [row] = await H.t.db
      .insert(build)
      .values({
        kind: "skill",
        title: "Same item check",
        phase: "fitgap",
        brief: {
          goal: field("Say whether two descriptions name the same item"),
          trigger: field("Called by a step"),
          dataIn: field("Two descriptions"),
          dataOut: field("same or different"),
        },
        fitgap: {
          rows: [{ id: "match", need: "Compare two descriptions", verdict: "native", how: "x" }],
          needsTrue: [],
        },
      })
      .returning();
    const id = row?.id as string;
    // Every model call fails as an overloaded API does.
    model.push(overloaded(), overloaded(), overloaded());

    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    if (res.status !== 200) {
      // Refusing the move (as an agent build's does) is right; then it stays in the fit-gap.
      const b = (await H.call(OPERATOR, "GET", `/api/ops/builds/${id}`)).json as BuildDetail;
      expect(b.build.phase).toBe("fitgap");
      return;
    }
    const b = res.json as BuildDetail;
    expect(b.build.phase).toBe("draft");
    const said = b.messages.filter((m) => m.role === "builder").at(-1)?.text ?? "";
    const sessionId = b.draft?.sessionId as string;
    const turns = await H.t.db
      .select({ role: builderTurn.role, text: builderTurn.text, command: builderTurn.command })
      .from(builderTurn)
      .where(eq(builderTurn.sessionId, sessionId));
    // The request it would have drafted from is kept where the operator can try it again.
    expect
      .soft(
        turns.some((t) => t.role === "operator" && t.command !== "/start"),
        `the skill session's turns: ${JSON.stringify(turns)}`,
      )
      .toBe(true);
    // And the build says the first draft wasn't made, not "open it to look at the draft".
    expect(said, said).not.toMatch(/look at the draft/i);
    expect(said).toMatch(/couldn't|could not|wasn't|isn't/i);
  });
});
