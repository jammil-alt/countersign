// v0.19 O6 (ARCHITECTURE §10.15 "Home", "Conversation history"): Home's one call carries the
// client's owners (name, area, health in a word, the week's runs) and the areas it doesn't use, and
// nothing of how they work; a person's conversation quiet for 30 minutes becomes one summary, their
// own, once.

import {
  agent,
  auditEvent,
  memoryNote,
  message,
  modelCall,
  run,
  thread,
  usageDaily,
} from "@countersign/db";
import { FakeModel, type LlmTransport } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SUMMARY_AUDIT_ACTION,
  SUMMARY_RETRY_AFTER_MS,
  summarizeQuietConversations,
  summaryPass,
} from "./account/summaries";
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
    // Free to the client: no run, no model_call, no usage of its own; logged as our cost, and
    // audited (the thread's id only).
    expect(await attempts(threadId)).toEqual(["ok"]);
  });

  const attempts = async (threadId: string) =>
    (
      await H.t.db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, SUMMARY_AUDIT_ACTION),
            sql`${auditEvent.target}->>'threadId' = ${threadId}`,
          ),
        )
        .orderBy(auditEvent.createdAt)
    ).map((a) => a.outcome);

  it("charges the client nothing: no runs, model calls or usage, the cost logged as ours", async () => {
    const threadId = await quietThread("Is the Home Depot credit in?");
    // Counted once the person's message and the chat run it starts (after its commit) are in.
    await vi.waitFor(async () => {
      const chat = await H.t.db
        .select()
        .from(run)
        .where(
          and(
            eq(run.tenantId, H.A.tenantId),
            sql`${run.trigger}->'payload'->>'threadId' = ${threadId}`,
          ),
        );
      expect(chat.length).toBeGreaterThan(0);
    });
    const before = {
      runs: (await H.t.db.select().from(run).where(eq(run.tenantId, H.A.tenantId))).length,
      calls: (await H.t.db.select().from(modelCall).where(eq(modelCall.tenantId, H.A.tenantId)))
        .length,
      usage: (await H.t.db.select().from(usageDaily).where(eq(usageDaily.tenantId, H.A.tenantId)))
        .length,
    };
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});
    const made = await summarizeQuietConversations(
      {
        db: H.db,
        transport: new FakeModel(
          Array.from({ length: 5 }, () => ({ text: "Asked about a Home Depot credit." })),
        ),
      },
      H.A.tenantId,
      new Date(Date.now() + 40 * 60_000),
    );
    // This conversation, and any other of the client's gone quiet meanwhile.
    expect(made).toBeGreaterThanOrEqual(1);
    const cost = logged.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("account.summary.cost"));
    logged.mockRestore();
    expect(JSON.parse(cost as string)).toMatchObject({
      who: "operator",
      tenantId: H.A.tenantId,
      tokensIn: 100,
      tokensOut: 20,
    });
    expect((await H.t.db.select().from(run).where(eq(run.tenantId, H.A.tenantId))).length).toBe(
      before.runs,
    );
    expect(
      (await H.t.db.select().from(modelCall).where(eq(modelCall.tenantId, H.A.tenantId))).length,
    ).toBe(before.calls);
    expect(
      (await H.t.db.select().from(usageDaily).where(eq(usageDaily.tenantId, H.A.tenantId))).length,
    ).toBe(before.usage);
    expect(await attempts(threadId)).toEqual(["ok"]);
  });

  async function quietThread(text: string) {
    const started = await H.call(admin("a"), "POST", "/api/threads", { subject: "account" });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const threadId = j(started.json).thread.id as string;
    const posted = await H.call(admin("a"), "POST", `/api/threads/${threadId}/messages`, { text });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    return threadId;
  }

  /** A model that never answers: it only ends when the call is aborted (its own time limit). */
  const hanging: LlmTransport = {
    create: (_request, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")));
      }),
  };

  it("records a failed summary and tries that thread again only after an hour", async () => {
    const threadId = await quietThread("Did the Grainger credit post?");
    const at = new Date(Date.now() + 2 * 60 * 60_000);
    const failing = new FakeModel([{ error: new Error("529 overloaded") }]);
    expect(
      await summarizeQuietConversations({ db: H.db, transport: failing }, H.A.tenantId, at),
    ).toBe(0);
    expect(failing.requests).toHaveLength(1);
    expect(await attempts(threadId)).toEqual(["error"]);
    // The next minute it is not picked again: no call at all.
    const next = new FakeModel([]);
    await summarizeQuietConversations(
      { db: H.db, transport: next },
      H.A.tenantId,
      new Date(at.getTime() + 60_000),
    );
    expect(next.requests).toHaveLength(0);
    // An answer with no text is a failure too, once the hour is up.
    const empty = new FakeModel([{ text: "" }]);
    const later = new Date(at.getTime() + SUMMARY_RETRY_AFTER_MS + 60_000);
    expect(
      await summarizeQuietConversations({ db: H.db, transport: empty }, H.A.tenantId, later),
    ).toBe(0);
    expect(empty.requests).toHaveLength(1);
    expect(await attempts(threadId)).toEqual(["error", "error"]);
  });

  it("stops a hanging call at its own limit; a call the budget can't hold never starts", async () => {
    const fastenal = await quietThread("Where is the Fastenal statement?");
    const uline = await quietThread("Can you resend the Uline bill?");
    const at = new Date(Date.now() + 5 * 60 * 60_000);
    // A clock the test moves: each call takes its whole limit.
    let now = 0;
    const clock = () => now;
    const calls: number[] = [];
    const hangsThenTicks: LlmTransport = {
      create: (request, options) => {
        calls.push(now);
        now += 200;
        return hanging.create(request, options);
      },
    };
    await summaryPass(
      {
        db: H.db,
        clients: [H.A.tenantId],
        transportFor: () => hangsThenTicks,
        report: (_tenantId, error) => {
          throw error;
        },
      },
      at,
      { budgetMs: 300, callTimeoutMs: 200, clock },
    );
    // One call fit the budget; it ran out its own limit and is marked failed. The second didn't
    // fit (100 ms left of 200), so it never started and is not marked: next tick takes it.
    expect(calls).toHaveLength(1);
    const outcomes = [...(await attempts(fastenal)), ...(await attempts(uline))];
    expect(outcomes).toEqual(["error"]);
  });
});
