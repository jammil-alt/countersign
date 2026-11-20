// Builds and the Builder (docs/plan.md §1.108) with text Postgres can't store and names that give
// the same slug (BUILDER_QA, PR #441: INPUT-1, INPUT-3, INPUT-4). Each answer is a 400 with a clear
// message, or the value saved, never a 500. Scripted model answers only (FakeModel).
import { TESTKIT_QUERY_TOOL } from "@countersign/connectors";
import type { BuildDetail } from "@countersign/core";
import { build, buildMessage } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { MemoryTestSuiteJobs } from "./testbench/instances";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model, testSuites: new MemoryTestSuiteJobs() });
afterAll(() => h?.close());

type Json = Record<string, unknown>;

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

describe.skipIf(!h)("builds: text Postgres can't store", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail & { error?: { message: string } } };
  };
  const start = async (title = "Input checks") => {
    const res = await call("POST", "/api/ops/builds", { kind: "agent", title });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.build.id;
  };

  // BUILDER_QA INPUT-1a.
  it("refuses a NUL byte in a build's title with a 400, not a 500", async () => {
    const res = await call("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Invoice\u0000 review",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.error?.message).toMatch(/title/);
  });

  // BUILDER_QA INPUT-1b.
  it("refuses a NUL byte in a brief field with a 400, not a 500", async () => {
    const id = await start();
    const res = await call("PATCH", `/api/ops/builds/${id}`, {
      brief: { goal: { text: "Check invoices\u0000 against contracts", state: "confirmed" } },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  // BUILDER_QA INPUT-1c.
  it("refuses a NUL byte in the operator's words to the Builder with a 400, not a 500", async () => {
    const id = await start();
    const res = await call("POST", `/api/ops/builds/${id}/turns`, {
      text: "Pasted from the PDF:\u0000 vendor terms",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  // BUILDER_QA INPUT-1d.
  it("refuses a lone surrogate in a brief field with a 400, not a 500", async () => {
    const id = await start();
    // What a browser sends for text cut inside an emoji: JSON allows the escape on its own.
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/builds/${id}`, {
      brief: { goal: { text: "Flag late invoices \ud83d", state: "confirmed" } },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  // BUILDER_QA INPUT-1e.
  it("refuses a try input with a NUL character with a 400, not a 500", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: {
        schemaVersion: 1,
        id: "custom:same-item-nul",
        name: "Same item",
        description: "Says whether two descriptions name the same item",
        category: "matching",
        mode: "task",
        model: { id: "claude-haiku-5-5" },
        instructions: "Compare the two descriptions.",
        tools: [],
        input: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
        },
        output: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const skillId = (created.json as { skill: { id: string } }).skill.id;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "skill", title: "Same item", phase: "poc", skillId })
      .returning();
    const res = await H.call(OPERATOR, "POST", `/api/ops/builds/${row?.id}/tries`, {
      input: { a: "Oak board 2x4\u0000", b: "Oak bd 2x4" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  // BUILDER_QA INPUT-3.
  it("keeps the Builder's fit-gap when a long 'how' is cut inside a surrogate pair", async () => {
    const id = await start("Japanese vendor contracts");
    await H.t.db.update(build).set({ phase: "fitgap" }).where(eq(build.id, id));
    // Japanese has no spaces and no ". ": clampText cuts at 499 code units, here between the two
    // halves of 𠮷 (U+20BB7, as in the vendor name 𠮷野家), and appends "…".
    const phrase = "契約書の単価を請求書と照合する";
    const lead = phrase.repeat(Math.floor(498 / phrase.length));
    const how = `${lead}${"あ".repeat(498 - lead.length)}𠮷野家の請求書も同じく照合する`;
    expect(how.length).toBeGreaterThan(500);
    expect(how.charCodeAt(498)).toBe(0xd842);
    model.push(
      turnAnswer({
        text: "Here is the fit-gap.",
        fitgap: {
          rows: [{ id: "match", need: "Match prices", verdict: "native", how }],
          needsTrue: [],
          setup: [],
        },
      }),
    );
    const res = await call("POST", `/api/ops/builds/${id}/turns`, { text: "Write the fit-gap." });
    expect.soft(res.status, JSON.stringify(res.json)).toBe(200);
    const [stored] = await H.t.db
      .select({ fitgap: build.fitgap })
      .from(build)
      .where(eq(build.id, id));
    expect
      .soft((stored?.fitgap as { rows?: { id: string }[] } | undefined)?.rows?.map((r) => r.id))
      .toEqual(["match"]);
    const messages = await H.t.db
      .select({ role: buildMessage.role })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, id))
      .orderBy(asc(buildMessage.createdAt));
    // The operator's words have the Builder's answer after them.
    expect(messages.map((m) => m.role)).toEqual(["operator", "builder"]);
  });

  // BUILDER_QA INPUT-3: a save the database refuses is a failed turn with Retry, not a 500.
  it("says a turn failed, with Retry, when its answer can't be saved", async () => {
    const id = await start("A save that fails");
    // Half an emoji from the model in a chip (kept in the message's jsonb meta) gets past the
    // answer's schema; Postgres refuses it.
    model.push(turnAnswer({ text: "Noted.", chips: ["Yes, flag it \ud83d"] }));
    const res = await call("POST", `/api/ops/builds/${id}/turns`, { text: "Go on." });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const said = await H.t.db
      .select({ role: buildMessage.role, meta: buildMessage.meta })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, id))
      .orderBy(asc(buildMessage.createdAt));
    expect(said.map((m) => m.role)).toEqual(["operator", "builder"]);
    expect((said.at(-1)?.meta as { failed?: string } | undefined)?.failed).toBe("save_failed");
  });
});

describe.skipIf(!h)("the skill Builder: skills whose names give the same slug", () => {
  const H = h as NonNullable<typeof h>;

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
    return {
      id,
      saved: await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${id}/save`, {}),
    };
  }

  // BUILDER_QA INPUT-4.
  it("saves a second non-Latin-named skill under its own id instead of a 409", async () => {
    const first = await draftAndSave("Сверка счетов с договором");
    expect(first.saved.status, JSON.stringify(first.saved.json)).toBe(200);
    expect((first.saved.json as { skill: Json }).skill.ref).toBe("custom:skill");
    const second = await draftAndSave("請求書の単価チェック");
    expect(second.saved.status, JSON.stringify(second.saved.json)).toBe(200);
    expect((second.saved.json as { skill: Json }).skill.ref).toBe("custom:skill-2");
    // The conversation keeps its id: a later save is a new version of the same skill.
    model.push(skillAnswer("請求書の単価チェック (v2)"));
    const turn = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${second.id}/turns`, {
      text: "Name it v2.",
    });
    expect(turn.status, JSON.stringify(turn.json)).toBe(200);
    const again = await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${second.id}/save`, {});
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((again.json as { skill: Json }).skill.ref).toBe("custom:skill-2");
  });
});
