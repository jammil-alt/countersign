// The knowledge base's routes (docs/plan.md §1.21) over a throwaway database: the operator and the
// client admin add and edit a client's FAQs and policies, each save keeps a version, a stale edit
// is refused, documents are indexed, search cites real records, and one client's knowledge never
// reaches another client or an operator who doesn't serve it.

import { agent, document, knowledgeEntryVersion, memoryNote } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Entry = Json & { id: string; version: number; status: string; updatedBy: Json };

describe.skipIf(!h)("knowledge base routes", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const A = () => H.A.tenantId;
  const B = () => H.B.tenantId;
  let faq: Entry;

  it("the operator adds an FAQ to a client and edits it into a second version", async () => {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/knowledge/entries`, {
      kind: "faq",
      title: "Opening hours",
      body: "We open at 8am on weekdays.",
    });
    expect(created.status).toBe(200);
    faq = (created.json as { entry: Entry }).entry;
    expect(faq).toMatchObject({ kind: "faq", version: 1, status: "active" });
    expect(faq.updatedBy).toEqual({ role: "operator", name: "Operator" });

    const edited = await call(
      OPERATOR,
      "PUT",
      `/api/ops/clients/${A()}/knowledge/entries/${faq.id}`,
      {
        title: "Opening hours",
        body: "We open at 8am on weekdays and 9am on Saturdays.",
        baseVersion: 1,
      },
    );
    expect(edited.status).toBe(200);
    faq = (edited.json as { entry: Entry }).entry;
    expect(faq.version).toBe(2);
  });

  it("the client admin edits it from the portal; the portal says 'us' for our edits", async () => {
    const list = await call(admin("a"), "GET", "/api/knowledge");
    expect(list.status).toBe(200);
    const entries = (list.json as { entries: Entry[] }).entries;
    expect(entries.map((e) => e.id)).toEqual([faq.id]);
    expect(entries[0]?.updatedBy).toEqual({ role: "operator", name: null });

    const stale = await call(admin("a"), "PUT", `/api/knowledge/entries/${faq.id}`, {
      title: "Hours",
      body: "Old text",
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: Json }).error.code).toBe("stale");

    const ok = await call(admin("a"), "PUT", `/api/knowledge/entries/${faq.id}`, {
      title: "Opening hours",
      body: "We open at 8am on weekdays and 9am on Saturdays. Closed on Sundays.",
      baseVersion: 2,
    });
    expect(ok.status).toBe(200);
    faq = (ok.json as { entry: Entry }).entry;
    expect(faq).toMatchObject({
      version: 3,
      updatedBy: { role: "client_admin", name: "Client A admin" },
    });

    const added = await call(admin("a"), "POST", "/api/knowledge/entries", {
      kind: "policy",
      title: "Returns",
      body: "Unused boards can be returned within 30 days.",
    });
    expect(added.status).toBe(200);
  });

  it("keeps every version, with who saved it", async () => {
    const res = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${A()}/knowledge/entries/${faq.id}/versions`,
    );
    expect(res.status).toBe(200);
    const versions = (res.json as { versions: (Json & { author: Json })[] }).versions;
    expect(versions.map((v) => [v.version, v.author.role])).toEqual([
      [1, "operator"],
      [2, "operator"],
      [3, "client_admin"],
    ]);
    const rows = await H.t.db
      .select()
      .from(knowledgeEntryVersion)
      .where(eq(knowledgeEntryVersion.entryId, faq.id));
    expect(rows).toHaveLength(3);
  });

  it("client users can't reach the portal's knowledge routes; other clients' entries are not found", async () => {
    expect((await call(user("a"), "GET", "/api/knowledge")).status).toBe(403);
    expect(
      (
        await call(user("a"), "POST", "/api/knowledge/entries", {
          kind: "faq",
          title: "x",
          body: "y",
        })
      ).status,
    ).toBe(403);
    // Client B's admin asks for A's entry by id: not found (RLS and the tenant filter).
    const res = await call(admin("b"), "PUT", `/api/knowledge/entries/${faq.id}`, {
      title: "Hijack",
      body: "Nope",
      baseVersion: 3,
    });
    expect(res.status).toBe(404);
    expect(
      ((await call(admin("b"), "GET", "/api/knowledge")).json as { entries: [] }).entries,
    ).toEqual([]);
    // An operator who doesn't serve A sees nothing of it.
    expect((await call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/knowledge`)).status).toBe(
      404,
    );
    expect(
      (await call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/knowledge/search?q=hours`))
        .status,
    ).toBe(404);
    // The operator can't edit A's entry through B's path.
    const cross = await call(
      OPERATOR,
      "PUT",
      `/api/ops/clients/${B()}/knowledge/entries/${faq.id}`,
      { title: "x", body: "y", baseVersion: 3 },
    );
    expect(cross.status).toBe(404);
  });

  it("the Knowledge tab lists entries, indexed documents and live memory notes", async () => {
    // An uploaded document of client A, and memory notes of one of its agents.
    const [doc] = await H.t.db
      .insert(document)
      .values({
        tenantId: A(),
        source: "upload",
        storageKey: `tenants/${A()}/content/aa`,
        mimeType: "application/pdf",
        filename: "walnut-quote.pdf",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      })
      .returning();
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: A(), kind: "client", slug: "front-desk", name: "Front desk" })
      .returning();
    await H.t.db.insert(memoryNote).values([
      { tenantId: A(), agentId: a?.id ?? "", note: "Dana answers walnut questions." },
      { tenantId: A(), agentId: a?.id ?? "", note: "Test note", scope: "test-run:r" },
    ]);
    const res = await call(OPERATOR, "GET", `/api/ops/clients/${A()}/knowledge`);
    expect(res.status).toBe(200);
    const body = res.json as {
      entries: Entry[];
      documents: (Json & { id: string })[];
      memoryNotes: { count: number; recent: (Json & { agent: Json })[] };
    };
    expect(body.entries.map((e) => e.title).sort()).toEqual(["Opening hours", "Returns"]);
    expect(body.documents).toEqual([
      expect.objectContaining({ id: doc?.id, filename: "walnut-quote.pdf", indexed: true }),
    ]);
    expect(body.memoryNotes.count).toBe(1);
    expect(body.memoryNotes.recent[0]).toMatchObject({
      note: "Dana answers walnut questions.",
      agent: { name: "Front desk" },
    });
  });

  it("search finds by words across entries, documents and notes, citing real records", async () => {
    const res = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${A()}/knowledge/search?q=${encodeURIComponent("walnut on saturday")}`,
    );
    expect(res.status).toBe(200);
    const results = (res.json as { results: (Json & { kind: string; sources: string[] })[] })
      .results;
    expect(results.map((r) => r.kind).sort()).toEqual(["document", "faq", "memory"]);
    const hours = results.find((r) => r.kind === "faq");
    expect(hours?.sources[0]).toBe(faq.id);
    const [v] = await H.t.db
      .select()
      .from(knowledgeEntryVersion)
      .where(eq(knowledgeEntryVersion.id, hours?.sources[1] ?? ""));
    expect(v?.version).toBe(3);
    // B searches for the same words: nothing of A.
    await call(OPERATOR, "POST", `/api/ops/clients/${B()}/knowledge/entries`, {
      kind: "faq",
      title: "B only",
      body: "Client B is open on Saturday.",
    });
    const bRes = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${B()}/knowledge/search?q=${encodeURIComponent("walnut on saturday")}`,
    );
    const bTitles = (bRes.json as { results: Json[] }).results.map((r) => r.title);
    expect(bTitles).toEqual(["B only"]);
  });

  it("archiving takes an entry out of the list and of search; editing restores it", async () => {
    const archived = await call(admin("a"), "POST", `/api/knowledge/entries/${faq.id}/archive`, {
      baseVersion: 3,
    });
    expect(archived.status).toBe(200);
    expect((archived.json as { entry: Entry }).entry).toMatchObject({
      status: "archived",
      version: 4,
    });
    const again = await call(admin("a"), "POST", `/api/knowledge/entries/${faq.id}/archive`, {
      baseVersion: 4,
    });
    expect(again.status).toBe(409);
    const list = await call(admin("a"), "GET", "/api/knowledge");
    expect((list.json as { entries: Entry[] }).entries.map((e) => e.id)).not.toContain(faq.id);
    const all = await call(admin("a"), "GET", "/api/knowledge?show=all");
    expect((all.json as { entries: Entry[] }).entries.map((e) => e.id)).toContain(faq.id);
    const search = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${A()}/knowledge/search?q=saturdays`,
    );
    expect((search.json as { results: Json[] }).results.map((r) => r.id)).not.toContain(faq.id);
    const restored = await call(admin("a"), "PUT", `/api/knowledge/entries/${faq.id}`, {
      title: "Opening hours",
      body: "We open at 9am every day.",
      baseVersion: 4,
    });
    expect((restored.json as { entry: Entry }).entry).toMatchObject({
      status: "active",
      version: 5,
    });
  });

  it("checks bodies: kind, title and text are required", async () => {
    const res = await call(admin("a"), "POST", "/api/knowledge/entries", {
      kind: "rule",
      title: "",
      body: "x",
    });
    expect(res.status).toBe(400);
  });
});
