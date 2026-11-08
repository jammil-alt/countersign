// §1.77: the forum watch's tools and actions against a throwaway database, as the Worker's role
// (RLS applies): threads seen once each, a reply draft refused unless it opens with the
// disclosure, names no site of the client's and has no exclamation mark; one draft per thread
// with its agent version and sources; test runs write nothing; a person approves naming the
// poster, rejects with a reason, marks it posted; and client B never sees or touches A's.

import { closeDb, createDb, type Db, membership, withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackTool, PackToolContext } from "../pack";
import { forumReply, forumThread } from "../schema";
import { insertMarketingClient, type MarketingClient } from "../testing.test-helper";
import { FORUM_ACTIONS } from "./actions";
import { defaultDisclosure, disclosureFor, mentionsDomain, replyProblems } from "./rules";
import { forumReplyDraft, forumThreadMark, forumThreadsUnseen } from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

describe("forum reply rules (pure)", () => {
  const rules = { disclosure: "I work at Mezonas", domains: ["mezonas.com"] };
  it("keeps a reply that opens with the disclosure and names no site of ours", () => {
    expect(
      replyProblems("I work at Mezonas, so take this with salt. We approve by email.", rules),
    ).toEqual([]);
    expect(replyProblems("i work at mezonas. Email works for us.", rules)).toEqual([]);
  });

  it("refuses a missing disclosure, an exclamation mark and our own site, each in words", () => {
    expect(replyProblems("Great question. I work at Mezonas.", rules).map((p) => p.code)).toEqual([
      "no_disclosure",
    ]);
    expect(replyProblems("I work at Mezonasco and like it", rules).map((p) => p.code)).toEqual([
      "no_disclosure",
    ]);
    expect(replyProblems("I work at Mezonas. Try it!", rules).map((p) => p.code)).toEqual([
      "exclamation",
    ]);
    expect(replyProblems("I work at Mezonas. Try it！", rules).map((p) => p.code)).toEqual([
      "exclamation",
    ]);
    for (const body of [
      "I work at Mezonas. See https://mezonas.com/guides/approvals",
      "I work at Mezonas. Sign in at app.mezonas.com.",
      "I work at Mezonas. www.MEZONAS.com has more",
    ]) {
      expect(replyProblems(body, rules).map((p) => p.code)).toEqual(["own_site"]);
    }
    expect(replyProblems("   ", rules).map((p) => p.code)).toEqual(["empty"]);
  });

  it("reads hosts, not words, and keeps the disclosure from being dropped by a setting", () => {
    expect(mentionsDomain("notmezonas.com is someone else", "mezonas.com")).toBe(false);
    expect(mentionsDomain("mezonas.community", "mezonas.com")).toBe(false);
    expect(mentionsDomain("(mezonas.com)", "mezonas.com")).toBe(true);
    expect(defaultDisclosure("Mezonas")).toBe("I work at Mezonas");
    expect(disclosureFor({ disclosure: "I work at Mezonas (the founder)" }, "Mezonas")).toBe(
      "I work at Mezonas (the founder)",
    );
    expect(disclosureFor({ disclosure: "" }, "Mezonas")).toBe("I work at Mezonas");
    expect(disclosureFor({ disclosure: "Hi there" }, "Acme")).toBe("I work at Acme");
  });
});

describe.skipIf(!online)("the forum watch (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: MarketingClient;
  let B: MarketingClient;
  let operatorId: string;

  const ctx = (c: MarketingClient, mode: "live" | "test" = "live"): PackToolContext => ({
    tenantId: c.tenantId,
    agentVersionId: c.agentVersionId,
    runId: c.runId,
    mode,
    settings: {},
    db,
    llm: null,
  });
  const call = async (tool: PackTool, input: unknown, c: MarketingClient = A, mode?: "test") =>
    tool.output.parse(await tool.run(input, ctx(c, mode))) as J;
  const fails = async (tool: PackTool, input: unknown, c: MarketingClient = A) => {
    try {
      await tool.run(input, ctx(c));
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return null;
  };
  const act = (
    name: keyof typeof FORUM_ACTIONS,
    c: MarketingClient,
    input: unknown,
    userId = c.userId,
  ) =>
    FORUM_ACTIONS[name].run(db, {
      tenantId: c.tenantId,
      userId,
      input: FORUM_ACTIONS[name].input.parse(input),
    });
  const actFails = async (
    name: keyof typeof FORUM_ACTIONS,
    c: MarketingClient,
    input: unknown,
    userId = c.userId,
  ) => {
    try {
      await act(name, c, input, userId);
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return null;
  };

  const story = (id: string, title = `Story ${id}`) => ({
    source: "hackernews",
    id,
    url: `https://news.ycombinator.com/item?id=${id}`,
    title,
  });

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertMarketingClient(t.db, "Mezonas", "mezonas.com");
    B = await insertMarketingClient(t.db, "Other client", "other.example.com");
    // An operator serving A (a membership), who will post by hand.
    const other = await insertMarketingClient(t.db, "Third", "third.example.com");
    operatorId = other.userId;
    await t.db
      .insert(membership)
      .values({ tenantId: A.tenantId, userId: operatorId, role: "operator" });
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  it("tells unseen threads from seen ones, each once, for this client only", async () => {
    const first = await call(forumThreadsUnseen, {
      threads: [
        { source: "hackernews", id: "100" },
        { source: "hackernews", id: "101" },
        { source: "hackernews", id: "100" },
      ],
    });
    expect(first.unseen).toEqual([
      { source: "hackernews", id: "100" },
      { source: "hackernews", id: "101" },
    ]);
    const marked = await call(forumThreadMark, { ...story("100"), outcome: "seen" });
    expect(marked).toMatchObject({ recorded: true, outcome: null });
    expect(marked.sources).toEqual([marked.threadId]);
    const passed = await call(forumThreadMark, { ...story("101"), outcome: "passed" });
    expect(passed).toMatchObject({ recorded: true, outcome: "passed" });
    const again = await call(forumThreadsUnseen, {
      threads: [
        { source: "hackernews", id: "100" },
        { source: "hackernews", id: "101" },
        { source: "hackernews", id: "102" },
      ],
    });
    expect(again.unseen).toEqual([{ source: "hackernews", id: "102" }]);
    expect(again.seen).toEqual([
      { source: "hackernews", id: "100", threadId: marked.threadId, outcome: null },
      { source: "hackernews", id: "101", threadId: passed.threadId, outcome: "passed" },
    ]);
    // Client B has seen none of them.
    const b = await call(forumThreadsUnseen, { threads: [{ source: "hackernews", id: "100" }] }, B);
    expect(b.unseen).toEqual([{ source: "hackernews", id: "100" }]);
    // The agent's row carries its version and run.
    const [row] = await withTenant(db, A.tenantId, (tx) =>
      tx.select().from(forumThread).where(eq(forumThread.id, marked.threadId)),
    );
    expect(row).toMatchObject({
      agentVersionId: A.agentVersionId,
      runId: A.runId,
      addedByUserId: null,
    });
    // Marking again changes nothing once decided.
    expect(await call(forumThreadMark, { ...story("101"), outcome: "seen" })).toMatchObject({
      recorded: false,
      outcome: "passed",
    });
  });

  it("keeps one reply draft per thread, by the rules, with its version and sources", async () => {
    const thread = await call(forumThreadMark, { ...story("200"), outcome: "seen" });
    expect(
      await fails(forumReplyDraft, { threadId: thread.threadId, body: "Email works well!" }),
    ).toMatch(
      /^PackRefusal: The reply wasn't kept\. The reply must open with "I work at Mezonas"\. The reply has an exclamation mark/,
    );
    expect(
      await fails(forumReplyDraft, {
        threadId: thread.threadId,
        body: "I work at Mezonas. Our guide is at https://mezonas.com/guides/approvals",
      }),
    ).toMatch(/names mezonas\.com/);
    const draft = await call(forumReplyDraft, {
      threadId: thread.threadId,
      body: "I work at Mezonas, so I'm biased. A shared inbox and one approver per vendor worked for us.",
    });
    expect(draft).toMatchObject({ recorded: true, status: "waiting", threadId: thread.threadId });
    expect(draft.sources).toEqual([thread.threadId, draft.replyId]);
    const [reply] = await withTenant(db, A.tenantId, (tx) =>
      tx.select().from(forumReply).where(eq(forumReply.id, draft.replyId)),
    );
    expect(reply).toMatchObject({
      status: "waiting",
      agentVersionId: A.agentVersionId,
      runId: A.runId,
      posterUserId: null,
    });
    const [after] = await withTenant(db, A.tenantId, (tx) =>
      tx.select().from(forumThread).where(eq(forumThread.id, thread.threadId)),
    );
    expect(after?.outcome).toBe("drafted");
    // Each thread once; a passed thread gets none; B can't reach A's thread.
    expect(
      await fails(forumReplyDraft, {
        threadId: thread.threadId,
        body: "I work at Mezonas. Again.",
      }),
    ).toMatch(/already has a reply draft/);
    const passed = await call(forumThreadMark, { ...story("201"), outcome: "passed" });
    expect(
      await fails(forumReplyDraft, { threadId: passed.threadId, body: "I work at Mezonas. Hm." }),
    ).toMatch(/passed over/);
    expect(
      await fails(
        forumReplyDraft,
        { threadId: thread.threadId, body: "I work at Other client. Hi." },
        B,
      ),
    ).toMatch(/no such forum thread/);
  });

  it("writes nothing in a test run", async () => {
    const seen = await call(forumThreadMark, { ...story("300"), outcome: "seen" }, A, "test");
    expect(seen).toEqual({ recorded: false, threadId: null, outcome: null, sources: [] });
    const still = await call(forumThreadsUnseen, {
      threads: [{ source: "hackernews", id: "300" }],
    });
    expect(still.unseen).toHaveLength(1);
    const live = await call(forumThreadMark, { ...story("301"), outcome: "seen" });
    const draft = await call(
      forumReplyDraft,
      { threadId: live.threadId, body: "I work at Mezonas. A test draft." },
      A,
      "test",
    );
    expect(draft).toMatchObject({ recorded: false, replyId: null });
    const rows = await withTenant(db, A.tenantId, (tx) =>
      tx.select().from(forumReply).where(eq(forumReply.threadId, live.threadId)),
    );
    expect(rows).toEqual([]);
  });

  it("lets a person add a thread, approve naming the poster or reject, and mark it posted", async () => {
    const added = (await act("add-forum-thread", A, {
      url: "https://news.ycombinator.com/item?id=400#c1",
      title: "Ask HN: Who approves your bills?",
    })) as J;
    expect(added.thread).toMatchObject({
      source: "hackernews",
      externalId: "400",
      url: "https://news.ycombinator.com/item?id=400",
    });
    expect(
      await actFails("add-forum-thread", A, {
        url: "https://news.ycombinator.com/item?id=400",
        title: "Again",
      }),
    ).toMatch(/already in the forum watch/);
    const pasted = (await act("add-forum-thread", A, {
      url: "https://forum.example.org/t/approvals#reply",
      title: "Approvals",
    })) as J;
    expect(pasted.thread).toMatchObject({
      source: "pasted",
      externalId: "https://forum.example.org/t/approvals",
    });
    // The watch sees what a person added and hasn't decided.
    const unseen = await call(forumThreadsUnseen, { threads: [] });
    expect(unseen.waiting.map((w: J) => w.id)).toEqual([
      "400",
      "https://forum.example.org/t/approvals",
    ]);

    const draft = await call(forumReplyDraft, {
      threadId: added.thread.id,
      body: "I work at Mezonas. We route each bill to one approver.",
    });
    // Only a person of this client's may be named; B can't decide A's draft.
    expect(
      await actFails("decide-forum-reply", A, {
        replyId: draft.replyId,
        decision: "approve",
        posterUserId: B.userId,
      }),
    ).toMatch(/person of this client's/);
    expect(
      await actFails("decide-forum-reply", B, {
        replyId: draft.replyId,
        decision: "approve",
        posterUserId: B.userId,
      }),
    ).toMatch(/person of this client's|no such reply/);
    expect(await actFails("mark-forum-posted", A, { replyId: draft.replyId })).toMatch(
      /Only an approved reply/,
    );
    const approved = (await act("decide-forum-reply", A, {
      replyId: draft.replyId,
      decision: "approve",
      posterUserId: operatorId,
    })) as J;
    expect(approved.reply).toMatchObject({ status: "approved", posterUserId: operatorId });
    expect(
      await actFails("decide-forum-reply", A, {
        replyId: draft.replyId,
        decision: "reject",
        reason: "Too late",
      }),
    ).toMatch(/already approved/);
    expect(await actFails("mark-forum-posted", B, { replyId: draft.replyId })).toMatch(
      /no such reply/,
    );
    const posted = (await act("mark-forum-posted", A, { replyId: draft.replyId })) as J;
    expect(posted.reply.status).toBe("posted");
    const [row] = await withTenant(db, A.tenantId, (tx) =>
      tx
        .select()
        .from(forumReply)
        .where(and(eq(forumReply.id, draft.replyId), eq(forumReply.tenantId, A.tenantId))),
    );
    expect(row).toMatchObject({ status: "posted", decidedByUserId: A.userId });
    expect(row?.postedAt).toBeInstanceOf(Date);

    // A rejection keeps the reason.
    const other = await call(forumReplyDraft, {
      threadId: pasted.thread.id,
      body: "I work at Mezonas. One approver per vendor.",
    });
    const rejected = (await act("decide-forum-reply", A, {
      replyId: other.replyId,
      decision: "reject",
      reason: "Not our thread",
    })) as J;
    expect(rejected.reply.status).toBe("rejected");
    expect(
      FORUM_ACTIONS["decide-forum-reply"].input.safeParse({
        replyId: other.replyId,
        decision: "reject",
      }).success,
    ).toBe(false);
  });
});
