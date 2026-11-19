// QA (input abuse, 2026-11-19): a skill named in words with no Latin letters (Cyrillic, Japanese,
// emoji only) gets the id `custom:skill` (builderSlug gives "" and guardSkill falls back to
// "skill"). The id is fixed at the first draft, so the second such skill in a scope can never be
// saved: the conversation's work is stuck behind a 409 "that already exists".
import { TESTKIT_QUERY_TOOL } from "@countersign/connectors";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;

/** The skill Builder's answer: a skill by this name, with no slug of its own. */
function skillAnswer(name: string) {
  return {
    toolUse: {
      name: "submit_skill",
      input: {
        text: `Drafted ${name}.`,
        definition: {
          name,
          description: "Checks an invoice against its contract",
          category: "data",
          mode: "task",
          model: { id: "claude-haiku-5-5" },
          instructions: "Compare each line's price with the contract's.",
          tools: [TESTKIT_QUERY_TOOL],
          input: { type: "object", properties: { invoice: { type: "string" } } },
          output: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        cases: [],
      },
    },
  };
}

describe.skipIf(!h)("input abuse: skill names with no Latin letters", () => {
  const H = h as NonNullable<typeof h>;

  async function draftAndSave(name: string) {
    const started = await H.call(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "skill",
      clientId: H.A.tenantId,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const id = ((started.json as { session: Json }).session as Json).id as string;
    model.push(skillAnswer(name));
    const turn = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/turns`, {
      text: `Draft a skill: ${name}`,
    });
    expect(turn.status, JSON.stringify(turn.json)).toBe(200);
    return H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/save`, {});
  }

  it("INPUT-4 saves a second non-Latin-named skill under its own id instead of a 409", async () => {
    const first = await draftAndSave("Сверка счетов с договором");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect((first.json as { skill: Json }).skill.ref).toBe("custom:skill");
    const second = await draftAndSave("請求書の単価チェック");
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect((second.json as { skill: Json }).skill.ref).not.toBe("custom:skill");
  });
});
