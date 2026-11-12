// v0.17 O6 (ARCHITECTURE §10.15 "Home", "Conversation history"): Home's one call carries the
// client's owners (name, area, health in a word, the week's runs) and the areas it doesn't use, and
// nothing of how they work; a person's conversation quiet for 30 minutes becomes one summary, their
// own, once.

import { agent, memoryNote, message, thread } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeQuietConversations } from "./account/summaries";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("Home and conversation history", () => {
  const H = h as ApiHarness;

  beforeAll(async () => {
    await H.t.db.insert(agent).values({
      tenantId: H.A.tenantId,
      kind: "client",
      slug: "home-clerk",
      name: "Home clerk",
      stage: "bench",
      area: "purchasing",
    });
    const sloan = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(sloan.status, JSON.stringify(sloan.json)).toBe(200);
  });

  it("carries the owners and ideas on Home's one call, and nothing of how they work", async () => {
    const res = await H.call(admin("a"), "GET", "/api/table");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    const purchasing = body.owners.find((o: { area: string }) => o.area === "purchasing");
    expect(purchasing).toMatchObject({ health: "working", runs: 0, corrected: 0, last: null });
    expect(purchasing.processes).toBeGreaterThan(0);
    expect(body.ideas.map((i: { area: string }) => i.area)).not.toContain("purchasing");
    expect(body.ideas.length).toBeGreaterThan(0);
    const text = JSON.stringify(body.owners);
    for (const hidden of ["model", "notes", "oversight", "memory", "cost"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("summarizes a quiet conversation once, as its person's own note", async () => {
    const started = await H.call(admin("a"), "POST", "/api/threads", { subject: "account" });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const threadId = j(started.json).thread.id as string;
    const posted = await H.call(admin("a"), "POST", `/api/threads/${threadId}/messages`, {
      text: "Is the Ferguson bill signed yet?",
    });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    // Forty minutes later: quiet for over 30.
    const at = new Date(Date.now() + 40 * 60_000);
    const model = new FakeModel([{ text: "Asked whether the Ferguson bill was signed." }]);
    const made = await summarizeQuietConversations(
      { db: H.db, transport: model },
      H.A.tenantId,
      at,
    );
    expect(made).toBe(1);
    // The conversation went in as data, never as instructions.
    expect(JSON.stringify(model.requests[0]?.system)).not.toContain("Ferguson");
    expect(JSON.stringify(model.requests[0]?.messages)).toContain("Ferguson");
    const [t] = await H.t.db.select().from(thread).where(eq(thread.id, threadId));
    const notes = await H.t.db
      .select()
      .from(memoryNote)
      .where(and(eq(memoryNote.scope, "person"), eq(memoryNote.personId, t?.createdBy as string)));
    expect(notes.map((n) => n.note)).toEqual(["Asked whether the Ferguson bill was signed."]);
    const [last] = await H.t.db.select().from(message).where(eq(message.threadId, threadId));
    expect(notes[0]?.sourceMessageId).toBe(last?.id);
    // Once: the next tick finds it summarized.
    expect(
      await summarizeQuietConversations(
        { db: H.db, transport: new FakeModel([]) },
        H.A.tenantId,
        at,
      ),
    ).toBe(0);
  });
});
