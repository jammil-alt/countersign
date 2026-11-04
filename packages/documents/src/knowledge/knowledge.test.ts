// The knowledge base over a throwaway database, as cs_worker (RLS as in the Worker): entries keep
// every version, search finds words across entries, documents and memory notes, sources are real
// records, and one client never sees another's knowledge.

import {
  agent,
  docExtraction,
  docLine,
  document,
  knowledgeChunk,
  knowledgeEntry,
  knowledgeEntryVersion,
  memoryNote,
  tenant,
  withTenant,
} from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type Client, createHarness, type Harness } from "../harness.test-helper";
import { chunkText, searchConfigFor } from "./chunk";
import { indexDocuments, indexedDocuments } from "./documents";
import {
  archiveKnowledgeEntry,
  createKnowledgeEntry,
  editKnowledgeEntry,
  KnowledgeError,
  knowledgeEntryVersions,
  listKnowledgeEntries,
} from "./entries";
import { searchKnowledge } from "./search";

describe("chunkText", () => {
  it("packs paragraphs and splits long ones at sentence ends, never over the limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(`Short one.\n\nShort two.\n\n${long}`, 200);
    expect(chunks[0]).toBe("Short one.\n\nShort two.");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("Sentence number 39 is here.");
    expect(chunkText("   \n\n  ")).toEqual([]);
    expect(chunkText("x".repeat(500), 200).every((c) => c.length <= 200)).toBe(true);
  });

  it("maps a client's language to a search configuration", () => {
    expect(searchConfigFor("es")).toBe("spanish");
    expect(searchConfigFor("pt-BR")).toBe("portuguese");
    expect(searchConfigFor(undefined)).toBe("english");
    expect(searchConfigFor("xx")).toBe("english");
  });
});

const h = await createHarness();
afterAll(() => h?.close());

const admin = { id: null, role: "client_admin" as const };
const operator = { id: null, role: "operator" as const };

describe.skipIf(!h)("knowledge base", () => {
  const harness = h as Harness;
  const as = <T>(c: Client, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(harness.db, c.tenantId, fn);

  async function addAgent(c: Client, slug: string): Promise<string> {
    const [a] = await harness.t.db
      .insert(agent)
      .values({ tenantId: c.tenantId, kind: "client", slug, name: slug })
      .returning();
    if (!a) throw new Error("no agent");
    return a.id;
  }

  async function addDocument(c: Client, filename: string, vendorName: string, lines: string[]) {
    const sha = crypto.randomUUID().replace(/-/g, "").repeat(2);
    const [d] = await harness.t.db
      .insert(document)
      .values({
        tenantId: c.tenantId,
        source: "email",
        connectionId: c.uploadConnectionId,
        storageKey: `tenants/${c.tenantId}/content/${sha}`,
        mimeType: "application/pdf",
        filename,
        sizeBytes: 10,
        sha256: sha,
        meta: { subject: `Invoice from ${vendorName}` },
      })
      .returning();
    if (!d) throw new Error("no document");
    const [x] = await harness.t.db
      .insert(docExtraction)
      .values({
        tenantId: c.tenantId,
        documentId: d.id,
        model: "test",
        header: { vendorName, invoiceNumber: "INV-7", invoiceDate: "2026-10-01" },
        subtotal: "10",
        total: "10",
        linesSum: "10",
        totalsMatch: true,
      })
      .returning();
    if (!x) throw new Error("no extraction");
    await harness.t.db.insert(docLine).values(
      lines.map((rawDescription, i) => ({
        tenantId: c.tenantId,
        extractionId: x.id,
        lineNo: i + 1,
        rawDescription,
        qty: "1",
        unitPrice: "10",
        extPrice: "10",
      })),
    );
    return { documentId: d.id, extractionId: x.id };
  }

  it("keeps every version of an entry and refuses an edit from a stale version", async () => {
    const created = await as(harness.A, (tx) =>
      createKnowledgeEntry(tx, harness.A.tenantId, {
        kind: "faq",
        title: "Opening hours",
        body: "We open at 8am on weekdays.",
        author: operator,
      }),
    );
    expect(created.version).toBe(1);
    const edited = await as(harness.A, (tx) =>
      editKnowledgeEntry(tx, harness.A.tenantId, created.id, {
        title: "Opening hours",
        body: "We open at 8am on weekdays and 9am on Saturdays.",
        baseVersion: 1,
        author: admin,
      }),
    );
    expect(edited.version).toBe(2);
    expect(edited.updatedBy.role).toBe("client_admin");
    // Same text again: nothing new to keep.
    const same = await as(harness.A, (tx) =>
      editKnowledgeEntry(tx, harness.A.tenantId, created.id, {
        title: edited.title,
        body: edited.body,
        baseVersion: 2,
        author: admin,
      }),
    );
    expect(same.version).toBe(2);
    await expect(
      as(harness.A, (tx) =>
        editKnowledgeEntry(tx, harness.A.tenantId, created.id, {
          title: "x",
          body: "y",
          baseVersion: 1,
          author: admin,
        }),
      ),
    ).rejects.toMatchObject({ code: "stale" });
    const versions = await as(harness.A, (tx) =>
      knowledgeEntryVersions(tx, harness.A.tenantId, created.id),
    );
    expect(versions.map((v) => [v.version, v.author.role])).toEqual([
      [1, "operator"],
      [2, "client_admin"],
    ]);
    expect(versions[0]?.body).toBe("We open at 8am on weekdays.");
  });

  it("finds entries by any of a question's words, with excerpts and sources that are real rows", async () => {
    const returns = await as(harness.A, (tx) =>
      createKnowledgeEntry(tx, harness.A.tenantId, {
        kind: "policy",
        title: "Returns",
        body: "Unused boards can be returned within 30 days with the receipt.\n\nCustom cuts are final.",
        author: operator,
      }),
    );
    const hits = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "Can I return boards I bought?" }),
    );
    const hit = hits.find((x) => x.id === returns.id);
    expect(hit).toMatchObject({ kind: "policy", title: "Returns" });
    expect(hit?.excerpt).toContain("returned within 30 days");
    expect(hit?.sources).toEqual([returns.id, returns.versionId]);
    // "Saturday" finds the hours FAQ (stemmed: Saturdays), not the returns policy.
    const hours = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "are you open on saturday" }),
    );
    expect(hours[0]?.title).toBe("Opening hours");
    for (const s of hours[0]?.sources ?? []) {
      const rows = await harness.t.db.execute(sql`
        select 1 from knowledge_entry where id = ${s}
        union all select 1 from knowledge_entry_version where id = ${s}`);
      expect(rows.length, s).toBe(1);
    }
    // Nothing to search for: no hits, no error.
    expect(
      await as(harness.A, (tx) => searchKnowledge(tx, harness.A.tenantId, { query: "?!" })),
    ).toEqual([]);
  });

  it("archiving takes an entry out of search and keeps it as a version", async () => {
    const [entry] = await as(harness.A, (tx) => listKnowledgeEntries(tx, harness.A.tenantId));
    const returns = (
      await as(harness.A, (tx) => listKnowledgeEntries(tx, harness.A.tenantId))
    ).find((e) => e.title === "Returns");
    if (!entry || !returns) throw new Error("entries missing");
    const archived = await as(harness.A, (tx) =>
      archiveKnowledgeEntry(tx, harness.A.tenantId, returns.id, {
        baseVersion: returns.version,
        author: operator,
      }),
    );
    expect(archived.status).toBe("archived");
    const hits = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "returned receipt" }),
    );
    expect(hits.find((x) => x.id === returns.id)).toBeUndefined();
    expect(
      (await as(harness.A, (tx) => listKnowledgeEntries(tx, harness.A.tenantId))).map((e) => e.id),
    ).not.toContain(returns.id);
    // Editing an archived entry restores it.
    const restored = await as(harness.A, (tx) =>
      editKnowledgeEntry(tx, harness.A.tenantId, returns.id, {
        title: "Returns",
        body: "Unused boards can be returned within 14 days.",
        baseVersion: archived.version,
        author: admin,
      }),
    );
    expect(restored).toMatchObject({ status: "active", version: archived.version + 1 });
    await expect(
      as(harness.A, (tx) =>
        archiveKnowledgeEntry(tx, harness.A.tenantId, returns.id, {
          baseVersion: 1,
          author: admin,
        }),
      ),
    ).rejects.toBeInstanceOf(KnowledgeError);
  });

  it("indexes documents from their latest extraction, and again when they are read again", async () => {
    const doc = await addDocument(harness.A, "acme-oct.pdf", "Acme Lumber", [
      "White oak plank 8/4",
      "Walnut veneer sheet",
    ]);
    expect(
      (await as(harness.A, (tx) => indexedDocuments(tx, harness.A.tenantId)))[0]?.indexed,
    ).toBe(false);
    expect(await as(harness.A, (tx) => indexDocuments(tx, harness.A.tenantId))).toBe(1);
    expect(await as(harness.A, (tx) => indexDocuments(tx, harness.A.tenantId))).toBe(0);
    const listed = await as(harness.A, (tx) => indexedDocuments(tx, harness.A.tenantId));
    expect(listed[0]).toMatchObject({
      id: doc.documentId,
      indexed: true,
      title: "Invoice INV-7 from Acme Lumber",
    });
    const hits = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "walnut veneer" }),
    );
    expect(hits[0]).toMatchObject({ kind: "document", id: doc.documentId });
    expect(hits[0]?.sources).toEqual([doc.documentId, doc.extractionId]);
    expect(hits[0]?.excerpt).toContain("Walnut veneer");

    // A new reading replaces the passages.
    const [x2] = await harness.t.db
      .insert(docExtraction)
      .values({
        tenantId: harness.A.tenantId,
        documentId: doc.documentId,
        model: "test",
        header: { vendorName: "Acme Lumber", invoiceNumber: "INV-8" },
        subtotal: "10",
        total: "10",
        linesSum: "10",
        totalsMatch: true,
      })
      .returning();
    expect(await as(harness.A, (tx) => indexDocuments(tx, harness.A.tenantId))).toBe(1);
    const chunks = await harness.t.db
      .select()
      .from(knowledgeChunk)
      .where(eq(knowledgeChunk.documentId, doc.documentId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((c) => c.extractionId))).toEqual(new Set([x2?.id]));
  });

  it("searches only the asking agent's own memory notes, in the scopes given", async () => {
    const mine = await addAgent(harness.A, "intake");
    const other = await addAgent(harness.A, "collections");
    const [note] = await harness.t.db
      .insert(memoryNote)
      .values([
        { tenantId: harness.A.tenantId, agentId: mine, note: "Acme calls plywood 'ply sheets'." },
        { tenantId: harness.A.tenantId, agentId: other, note: "Plywood invoices go to Dana." },
        {
          tenantId: harness.A.tenantId,
          agentId: mine,
          note: "Plywood test note",
          scope: "test-run:x",
        },
      ])
      .returning();
    const hits = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, {
        query: "plywood",
        memory: { agentId: mine, scopes: ["agent"] },
      }),
    );
    expect(hits.filter((x) => x.kind === "memory").map((x) => x.sources)).toEqual([[note?.id]]);
    const none = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "plywood", memory: null }),
    );
    expect(none.filter((x) => x.kind === "memory")).toEqual([]);
  });

  it("one client never sees another's knowledge, even when it asks for it by id", async () => {
    await as(harness.B, (tx) =>
      createKnowledgeEntry(tx, harness.B.tenantId, {
        kind: "faq",
        title: "Delivery",
        body: "We deliver walnut and oak on Saturdays.",
        author: operator,
      }),
    );
    await addDocument(harness.B, "b.pdf", "Other Supplier", ["Walnut veneer sheet"]);
    await as(harness.B, (tx) => indexDocuments(tx, harness.B.tenantId));
    // A's session, asking for B's rows by B's tenant id: RLS returns nothing.
    const leaked = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.B.tenantId, { query: "walnut saturdays delivery" }),
    );
    expect(leaked).toEqual([]);
    const aHits = await as(harness.A, (tx) =>
      searchKnowledge(tx, harness.A.tenantId, { query: "walnut saturdays delivery", limit: 20 }),
    );
    expect(aHits.map((x) => x.title)).not.toContain("Delivery");
    for (const table of [knowledgeEntry, knowledgeEntryVersion, knowledgeChunk]) {
      const rows = await as(harness.A, (tx) => tx.select({ t: table.tenantId }).from(table));
      expect(new Set(rows.map((r) => r.t))).toEqual(new Set([harness.A.tenantId]));
    }
    // Writing into another client from A's session is refused.
    await expect(
      as(harness.A, (tx) =>
        createKnowledgeEntry(tx, harness.B.tenantId, {
          kind: "faq",
          title: "x",
          body: "y",
          author: operator,
        }),
      ),
    ).rejects.toThrow();
  });

  it("indexes with the client's language", async () => {
    await harness.t.db
      .update(tenant)
      .set({ settings: { language: "es" } })
      .where(eq(tenant.id, harness.B.tenantId));
    await as(harness.B, (tx) =>
      createKnowledgeEntry(tx, harness.B.tenantId, {
        kind: "faq",
        title: "Horario",
        body: "Abrimos los sábados a las nueve.",
        author: operator,
      }),
    );
    const hits = await as(harness.B, (tx) =>
      searchKnowledge(tx, harness.B.tenantId, { query: "¿abren el sábado?" }),
    );
    expect(hits[0]?.title).toBe("Horario");
  });
});
