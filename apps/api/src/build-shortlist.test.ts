// The Builder's two rounds through the API (owner, 2026-11-24: "can we do 2 rounds, a short
// catalogue and then a full description of the short list it wants to assess?"): draft it now
// asks for a shortlist from the catalog in short, then drafts with the shortlist in full and every
// other part by id, a fraction of the whole catalog's size. Both calls are counted.
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model, env: { BUILDER_SHORTLIST: "on" } });
afterAll(() => h?.close());

const draft = {
  toolUse: {
    name: "submit_draft",
    input: {
      summary: "It fixes the record's amount and asks the client first.",
      gaps: [],
      startFromTemplate: null,
      bundle: {
        schemaVersion: 1,
        definition: {
          schemaVersion: 2,
          identity: { name: "Record fixer", role: "Records", mission: "Keep records right" },
          kind: "functional",
          model: { id: "claude-sonnet-5-5" },
          instructions: "Fix records when asked.",
          skills: [],
          permissions: { mode: "suggest_only" },
        },
        workflows: [
          {
            slug: "main",
            name: "Fix a record",
            workflow: {
              schemaVersion: 4,
              triggers: [{ id: "t", on: { type: "manual", input: {} } }],
              steps: [
                {
                  id: "update",
                  kind: "write",
                  name: "Update the record",
                  tool: TESTKIT_UPDATE_TOOL,
                  input: { id: "r1", amount: "12.00" },
                  checks: { approval: { required: "required" } },
                },
              ],
            },
          },
        ],
      },
    },
  },
};

const text = (req: LlmRequest | undefined) => JSON.stringify(req?.messages ?? []);

describe.skipIf(!h)("the Builder's two rounds", () => {
  const H = h as NonNullable<typeof h>;
  it("shortlists, then drafts with a fraction of the catalog", async () => {
    const started = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Record fixer",
    });
    const id = (started.json as BuildDetail).build.id;
    const from = model.requests.length;
    model.push(
      {
        toolUse: {
          name: "submit_shortlist",
          input: {
            skills: [],
            tools: [TESTKIT_UPDATE_TOOL, "testkit.record.query"],
            automations: [],
          },
        },
      },
      draft,
    );
    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/draft-now`, {
      description: "When someone asks, fix the amount on the record in the testkit.",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((res.json as BuildDetail).build.phase).toBe("draft");
    const [round1, round2] = model.requests.slice(from);
    expect(round1?.tools?.[0]).toMatchObject({ name: "submit_shortlist" });
    expect(round2?.tools?.[0]).toMatchObject({ name: "submit_draft" });
    const second = text(round2);
    expect(second).toContain("<other_parts>");
    const catalog = second.slice(second.indexOf("<catalog>"), second.indexOf("</catalog>"));
    expect(catalog).toContain(TESTKIT_UPDATE_TOOL);
    // The whole catalog went with every draft before; the shortlist's is a fraction of it.
    expect(catalog.length).toBeLessThan(text(round1).length / 2);
  });

  it("keeps a conversation's shortlist from its first turn for the turns after it", async () => {
    const start = await H.call(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "agent",
      name: "Record fixer",
    });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const sid = (start.json as { session: { id: string } }).session.id;
    /** A turn that keeps the draft it was shown. */
    const same = (req: LlmRequest) => {
      const content = req.messages[0]?.content as string;
      const from = content.indexOf("<current_bundle>") + "<current_bundle>".length;
      const bundle = JSON.parse(content.slice(from, content.indexOf("</current_bundle>")));
      return { toolUse: { name: "submit_turn", input: { text: "Noted.", bundle } } };
    };
    const from = model.requests.length;
    model.push(
      {
        toolUse: {
          name: "submit_shortlist",
          input: { skills: [], tools: [TESTKIT_UPDATE_TOOL], automations: [], events: [] },
        },
      },
      same,
    );
    const t1 = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${sid}/turns`, {
      text: "It fixes amounts on testkit records.",
    });
    expect(t1.status, JSON.stringify(t1.json)).toBe(200);
    model.push(same);
    const t2 = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${sid}/turns`, {
      text: "And asks the client first.",
    });
    expect(t2.status, JSON.stringify(t2.json)).toBe(200);
    const asked = model.requests.slice(from);
    // Turn one: the shortlist, then the turn. Turn two: the turn alone, on the same shortlist.
    expect(asked.map((r) => r.tools?.[0]?.name)).toEqual([
      "submit_shortlist",
      "submit_turn",
      "submit_turn",
    ]);
    const second = text(asked[2]);
    expect(second).toContain("<other_parts>");
    const catalog = second.slice(second.indexOf("<catalog>"), second.indexOf("</catalog>"));
    expect(catalog).toContain(TESTKIT_UPDATE_TOOL);
  });
});
