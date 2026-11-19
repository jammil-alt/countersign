// QA (integration fragility): moving a skill build from the fit-gap to the draft while the model is
// down (529 overloaded after the transport's retries). makeDraft (routes/ops-builds.ts) starts the
// skill's Builder session, then asks for its first draft and swallows the failure; the move goes on
// and the build says "I started the skill in its own Builder conversation. Open it to look at the
// draft", while the session holds no draft and not even the request (the failed turn rolled back,
// so the description written from the brief and fit-gap is gone). An agent build answers the same
// outage with 503 and stays in the fit-gap (builds.test.ts, "says a draft that can't be finished").

import type { BuildDetail } from "@countersign/core";
import { build, builderTurn } from "@countersign/db";
import { AnthropicError, FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

/** What the transport throws once its retries are spent on a 529. */
const overloaded = () => {
  const body = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  return { error: new AnthropicError(`529 ${JSON.stringify(body)}`, 529, body, null) };
};

const field = (text: string) => ({ text, state: "confirmed" as const });

describe.skipIf(!h)("a skill build's draft while the model is down (QA integ)", () => {
  const H = h as ApiHarness;

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
      // Refusing the move (as an agent build's does) is also right; then it stays in the fit-gap.
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
