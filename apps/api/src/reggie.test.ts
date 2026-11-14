// Reggie, the operator's account agent (docs/plan.md §1.101), with scripted model answers: it reads
// as the operator (audited as Reggie's), proposes changes that happen only when confirmed, once,
// asks a client admin on their Desk and reads the answer back, and never reaches another
// operator's conversation or a client the operator doesn't serve.
import { auditEvent, inboxItem, reggieAction, reggieMessage } from "@countersign/db";
import { FakeModel, type FakeTurn, type LlmRequest } from "@countersign/llm";
import { and, eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";
import { REGGIE_MAX_ROUNDS } from "./reggie/reggie";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const use = (name: string, input: unknown): FakeTurn => ({ toolUse: { name, input } });
const say = (text: string): FakeTurn => ({ text });

/** The tool results the model was given in a request. */
function toolResults(req: LlmRequest | undefined): { content: string; is_error?: boolean }[] {
  const out: { content: string; is_error?: boolean }[] = [];
  for (const m of req?.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ content: String(b.content), ...(b.is_error ? { is_error: true } : {}) });
      }
    }
  }
  return out;
}

describe.skipIf(!h)("Reggie", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A.tenantId;
  const C = () => H.C.tenantId;
  const start = async (who: string, clientId?: string) => {
    const res = await H.call(
      who,
      "POST",
      "/api/ops/reggie/conversations",
      clientId ? { clientId } : {},
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).conversation.id as string;
  };
  const ask = (who: string, id: string, text: string) =>
    H.call(who, "POST", `/api/ops/reggie/conversations/${id}/turns`, { text });

  it("is the operator's only", async () => {
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "GET", "/api/ops/reggie/conversations")).status).toBe(403);
    }
  });

  it("reviews a client with the operator's own reads, audited as Reggie's", async () => {
    const id = await start(OPERATOR, A());
    model.push(
      use("client_review", { client: A() }),
      say("Client A has 1 agent and no texting yet."),
    );
    const res = await ask(OPERATOR, id, "How is Client A doing?");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = j(res.json);
    expect(out.conversation).toMatchObject({
      title: "How is Client A doing?",
      client: { id: A() },
    });
    expect(out.messages.map((m: { role: string }) => m.role)).toEqual(["operator", "reggie"]);
    expect(out.messages[1]).toMatchObject({
      text: "Client A has 1 agent and no texting yet.",
      tools: ["client_review"],
    });
    // The model got the review as fenced data, and was told which client this is about.
    const second = model.requests.at(-1);
    const [result] = toolResults(second);
    expect(result?.content).toContain("A review of Client A's account.");
    expect(result?.content).toContain("<untrusted-data");
    expect(String(second?.system)).toContain(
      `This conversation is about Client A (client id ${A()})`,
    );
    // Each read was the back office's own route, audited as Reggie's.
    const audits = await H.t.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(like(auditEvent.action, "reggie %"));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "reggie GET /api/ops/clients/:id",
        "reggie GET /api/ops/clients/:id/lead-requests",
      ]),
    );
  });

  it("asks the client admin on their Desk only once the operator confirms, and reads the answer", async () => {
    const id = await start(OPERATOR, A());
    const question = "Which area code do you want for your texting number?";
    model.push(
      use("lead_request_create", { client: A(), question, choices: ["512", "737"] }),
      say("I proposed a question for Client A's admin: confirm the card to send it."),
    );
    const res = j((await ask(OPERATOR, id, "Ask Client A which area code they want")).json);
    expect(res.actions).toHaveLength(1);
    const card = res.actions[0];
    expect(card).toMatchObject({
      tool: "lead_request_create",
      title: "Ask Client A's admin",
      status: "proposed",
      client: { id: A(), name: "Client A" },
    });
    expect(card.lines).toContain(question);
    expect(card.lines).toContain("Answers to pick from: 512, 737");
    // Nothing on the Desk until it's confirmed.
    const desk = () =>
      H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.subjectType, "lead_request")));
    expect(await desk()).toHaveLength(0);
    // Only the operator who was proposed to may confirm it; and only once.
    expect(
      (await H.call(OTHER_OPERATOR, "POST", `/api/ops/reggie/actions/${card.id}/confirm`)).status,
    ).toBe(404);
    const done = await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${card.id}/confirm`);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).action).toMatchObject({
      status: "done",
      outcome: "Asked on Client A's admin's Desk.",
    });
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${card.id}/confirm`)).status,
    ).toBe(409);
    const [item] = await desk();
    expect(item).toMatchObject({ kind: "request", assigneeRole: "client_admin", title: question });

    // The admin answers on their Desk; the back office (and Reggie) reads it back.
    const answered = await H.call(admin("a"), "POST", `/api/inbox/${item?.id}/resolve`, {
      decision: "approve",
      answer: "512",
    });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    const list = j((await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/lead-requests`)).json);
    expect(list.items[0]).toMatchObject({
      question,
      status: "resolved",
      answer: "512",
      declined: false,
      choices: ["512", "737"],
    });
    expect(list.items[0].answeredBy).toBeTruthy();

    // The next turn tells the model what the operator decided since its last answer.
    model.push(use("lead_requests", { client: A() }), say("They picked 512."));
    await ask(OPERATOR, id, "Did they answer?");
    const [next] = model.requests.slice(-2);
    const opening = next?.messages.at(-1);
    expect(String(opening?.content)).toContain("Confirmed and done: Ask Client A's admin.");
    expect(toolResults(model.requests.at(-1)).at(-1)?.content).toContain('"answer": "512"');
  });

  it("posts in the lead conversation only when confirmed, and a turned-down card stays down", async () => {
    const id = await start(OPERATOR, A());
    model.push(
      use("lead_message_post", { client: A(), text: "Hi, we'll set up texting this week." }),
      say("Proposed a message to Client A."),
    );
    const res = j((await ask(OPERATOR, id, "Tell Client A we'll set up texting this week")).json);
    const card = res.actions[0];
    expect(card.lines).toEqual([
      "Posted in the lead conversation with Client A, as you:",
      "Hi, we'll set up texting this week.",
    ]);
    const cancelled = await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${card.id}/cancel`);
    expect(j(cancelled.json).action.status).toBe("cancelled");
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${card.id}/confirm`)).status,
    ).toBe(409);

    model.push(
      use("lead_message_post", { client: A(), text: "Texting is set up." }),
      say("Proposed."),
    );
    const again = j((await ask(OPERATOR, id, "Say texting is set up")).json);
    const second = again.actions.find((a: { status: string }) => a.status === "proposed");
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${second.id}/confirm`)).status,
    ).toBe(200);
    const lead = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/threads?subject=lead`)).json,
    ).threads[0];
    const messages = j((await H.call(OPERATOR, "GET", `/api/ops/threads/${lead.id}/messages`)).json)
      .messages as { text: string }[];
    expect(messages.map((m) => m.text)).toContain("Texting is set up.");
    expect(messages.map((m) => m.text)).not.toContain("Hi, we'll set up texting this week.");
  });

  it("never reaches a client the operator doesn't serve, or another operator's conversation", async () => {
    const mine = await start(OPERATOR);
    // The other operator serves only client C.
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/reggie/conversations/${mine}`)).status,
    ).toBe(404);
    expect((await ask(OTHER_OPERATOR, mine, "hi")).status).toBe(404);
    expect(
      (await H.call(OTHER_OPERATOR, "POST", "/api/ops/reggie/conversations", { clientId: A() }))
        .status,
    ).toBe(404);
    const theirs = await start(OTHER_OPERATOR, C());
    model.push(
      use("client_review", { client: A() }),
      use("lead_request_create", { client: A(), question: "Can you send your EIN here?" }),
      say("I can't reach Client A."),
    );
    const res = j((await ask(OTHER_OPERATOR, theirs, "Review Client A")).json);
    const results = toolResults(model.requests.at(-1));
    expect(results.every((r) => r.is_error)).toBe(true);
    expect(results.map((r) => r.content.split(":")[0])).toEqual(["not_found", "not_found"]);
    expect(res.actions).toEqual([]);
  });

  it("answers a bad tool call with an error the model can read, and stops after too many steps", async () => {
    const id = await start(OPERATOR);
    model.push(use("no_such_tool", {}), use("client_review", { client: "nope" }), say("Sorry."));
    const res = j((await ask(OPERATOR, id, "Do something")).json);
    expect(res.messages.at(-1).text).toBe("Sorry.");
    const results = toolResults(model.requests.at(-1));
    expect(results.map((r) => r.content.split(":")[0])).toEqual(["unknown_tool", "invalid_input"]);

    for (let i = 0; i < REGGIE_MAX_ROUNDS; i++) model.push(use("whoami", {}));
    const long = j((await ask(OPERATOR, id, "Keep going")).json);
    expect(long.messages.at(-1).text).toBe(
      `I stopped after ${REGGIE_MAX_ROUNDS} steps without an answer. Ask me again with less at once.`,
    );
    const [row] = await H.t.db
      .select()
      .from(reggieMessage)
      .where(and(eq(reggieMessage.conversationId, id), eq(reggieMessage.role, "reggie")))
      .orderBy(reggieMessage.createdAt)
      .limit(1)
      .offset(1);
    expect(row?.meta).toMatchObject({ stopped: true, model: expect.any(String) });
  });

  it("lists the operator's conversations, newest first", async () => {
    const list = j((await H.call(OPERATOR, "GET", "/api/ops/reggie/conversations")).json).items;
    expect(list.length).toBeGreaterThan(2);
    const times = list.map((c: { updatedAt: string }) => c.updatedAt);
    expect([...times].sort().reverse()).toEqual(times);
    const actions = await H.t.db.select().from(reggieAction);
    expect(actions.every((a) => a.userId)).toBe(true);
  });
});
