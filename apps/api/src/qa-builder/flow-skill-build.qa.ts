// QA (flow and usability lens, 2026-11-19): a skill build's move into the draft when the Builder's
// first skill turn fails. Asserts the expected behaviour; fails while the defect is there.
import type { BuildDetail } from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

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

type SessionDetail = {
  session: { id: string; bundle: { definition: unknown } };
  turns: { role: string; text: string; command: string | null }[];
};

describe.skipIf(!h)("QA flow: a skill build's draft", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async <T = BuildDetail>(method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };

  // FLOW-5: makeDraft (ops-builds.ts:1258-1261) swallows a failed first skill turn, and the skill
  // turn route saves nothing on failure (ops-builder.ts:826: the operator's turn is added only
  // after the model answers). The move still goes on and the build says "I started the skill ...
  // Open it to look at the draft", while the conversation it opens holds nothing of the brief or
  // the fit-gap: the operator has to type the whole job again, and nothing says the draft failed.
  it("FLOW-5 says the skill's first draft failed, or keeps the job in its conversation", async () => {
    let b = await ok("POST", "/api/ops/builds", { kind: "skill", title: "Apply volume tiers" });
    const id = b.build.id;
    model.push(
      turnAnswer({
        text: "Got it.",
        brief: {
          goal: { text: "Apply the vendor's volume tier to each line", state: "confirmed" },
          trigger: { text: "An invoice line is checked", state: "confirmed" },
          dataIn: { text: "The line and the vendor's tier table", state: "confirmed" },
          dataOut: { text: "The expected unit price", state: "confirmed" },
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
    for (let i = 0; i < 6; i++) model.push({ error: new Error("model overloaded") });
    b = await ok("POST", `/api/ops/builds/${id}/phase`, { to: "draft" });
    expect(b.build.phase).toBe("draft");
    const sessionId = b.draft?.sessionId;
    expect(sessionId).toBeTruthy();
    const s = await ok<SessionDetail>("GET", `/api/ops/builder/sessions/${sessionId}`);
    const said = b.messages.at(-1);

    const draftFailed =
      !!said?.failed || /didn.t|couldn.t|failed|try again/i.test(said?.text ?? "");
    const jobKept = s.turns.some((t) => t.text.includes("volume tier"));
    // Expected: the build says the draft didn't come through, or the skill's conversation holds
    // the job (the brief and fit-gap) so the operator can retry it there.
    const seen = {
      said: said?.text,
      jobKept,
      drafted: s.session.bundle.definition,
      gate: b.gate.reasons,
      problems: b.draft?.problems.length,
    };
    expect(draftFailed || jobKept, JSON.stringify(seen)).toBe(true);
  });
});
