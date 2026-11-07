// Stream D through the running app: uploads (the 3 golden invoices, read in the background in
// replay mode, plan M2's done-when), a purchases CSV, document views with their 5-minute links,
// the connector list, forwarding settings and the Worker's email() handler, and client isolation.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { docExtraction, document } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, user } from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { contentDisposition } from "./routes/documents";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness();
afterAll(() => h?.close());

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..");
const file = (dir: string, name: string) => readFileSync(resolve(FIXTURES, dir, name));
const DOMAIN = "in.mezonas.test";

const GOLDEN = [
  { name: "northline-20418.pdf", type: "application/pdf", stem: "northline-20418" },
  { name: "cedar-ridge-7731.png", type: "image/png", stem: "cedar-ridge-7731" },
  { name: "keystone-55102.pdf", type: "application/pdf", stem: "keystone-55102" },
];

describe.skipIf(!h)("documents API", () => {
  const harness = h as NonNullable<typeof h>;
  (harness.env as { EMAIL_FORWARDING_DOMAIN?: string }).EMAIL_FORWARDING_DOMAIN = DOMAIN;

  async function upload(email: string, files: { name: string; type: string; bytes: Uint8Array }[]) {
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.bytes], f.name, { type: f.type }));
    const res = await harness.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: email }, body: form },
      harness.env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as J };
  }

  const ids: Record<string, string> = {};

  it("uploads the 3 golden invoices; each is read and matches its expected JSON", async () => {
    const res = await upload(
      admin("a"),
      GOLDEN.map((g) => ({ name: g.name, type: g.type, bytes: file("invoices", g.name) })),
    );
    expect(res.status).toBe(200);
    expect(res.json.results.map((r: J) => [r.kind, r.created])).toEqual([
      ["document", true],
      ["document", true],
      ["document", true],
    ]);
    for (const [i, g] of GOLDEN.entries()) ids[g.stem] = res.json.results[i].document.id;
    // The request deferred the reading, and the harness's waitUntil has already started it: wait
    // for that first. Starting a second reading alongside it raced: the second saw the documents
    // as already being read and returned, and the checks below ran while the first was still going.
    await harness.settle();
    // Then run it as waitUntil would; documents already read are left as they are.
    const { extractInBackground } = await import("./routes/documents");
    await extractInBackground(
      {
        db: harness.db,
        env: harness.env,
        deps: {
          ...defaultDeps,
          objects: () => harness.objects,
          extractionTransport: () => harness.extraction.transport,
        },
      },
      harness.A.tenantId,
      Object.values(ids),
    );
    for (const g of GOLDEN) {
      const expected = JSON.parse(file("invoices", `${g.stem}.expected.json`).toString("utf8"));
      const got = await harness.call(admin("a"), "GET", `/api/documents/${ids[g.stem]}`);
      expect(got.status).toBe(200);
      const body = got.json as J;
      expect(body.document.status).toBe("extracted");
      const x = body.extraction;
      expect([x.vendorName, x.invoiceNumber, x.invoiceDate, x.poNumber]).toEqual([
        expected.header.vendorName,
        expected.header.invoiceNumber,
        expected.header.invoiceDate,
        expected.header.poNumber,
      ]);
      expect(Number(x.total)).toBe(Number(expected.total));
      expect(x.totalsMatch).toBe(true);
      expect(x.lines).toHaveLength(expected.lines.length);
      x.lines.forEach((l: J, j: number) => {
        const e = expected.lines[j];
        expect(Math.abs(Number(l.extPrice) - Number(e.extPrice))).toBeLessThanOrEqual(0.01);
        expect(Math.abs(Number(l.qty) - Number(e.qty))).toBeLessThanOrEqual(0.01);
        expect(l.description).toBe(e.description);
      });
      // No model name or cost reaches the portal.
      expect(JSON.stringify(body)).not.toMatch(/claude|costUsd|"model"/);
    }
  });

  it("gives a 5-minute link that serves the file, and refuses a tampered one", async () => {
    const got = await harness.call(admin("a"), "GET", `/api/documents/${ids["northline-20418"]}`);
    const url = new URL((got.json as J).url);
    expect(url.pathname.startsWith("/api/files/")).toBe(true);
    const res = await harness.app.request(url.pathname, {}, harness.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(file("invoices", "northline-20418.pdf")),
    );
    const tampered = `${url.pathname.slice(0, -3)}abc`;
    expect((await harness.app.request(tampered, {}, harness.env)).status).toBe(404);
  });

  it("stores a repeat upload once and refuses what is not a document or CSV", async () => {
    const res = await upload(user("a"), [
      {
        name: "again.pdf",
        type: "application/pdf",
        bytes: file("invoices", "northline-20418.pdf"),
      },
      { name: "notes.zip", type: "application/zip", bytes: new Uint8Array([1, 2]) },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.results[0]).toMatchObject({ kind: "document", created: false });
    expect(res.json.results[0].document.id).toBe(ids["northline-20418"]);
    expect(res.json.results[1]).toMatchObject({ kind: "refused" });
  });

  it("imports a CSV of purchases into transactions", async () => {
    const csv = "Date,Vendor,Amount\n10/29/2026,Northline Panel Supply,9742.35\n";
    const res = await upload(admin("a"), [
      { name: "card.csv", type: "text/csv", bytes: new TextEncoder().encode(csv) },
    ]);
    expect(res.json.results[0]).toMatchObject({
      kind: "purchases",
      purchases: { rows: 1, created: 1, duplicates: 0 },
    });
  });

  it("lists a client's documents and hides them from other clients", async () => {
    const list = await harness.call(admin("a"), "GET", "/api/documents");
    expect((list.json as J).documents.map((d: J) => d.id)).toEqual(
      expect.arrayContaining(Object.values(ids)),
    );
    const other = await harness.call(admin("b"), "GET", `/api/documents/${ids["northline-20418"]}`);
    expect(other.status).toBe(404);
    expect(((await harness.call(admin("b"), "GET", "/api/documents")).json as J).documents).toEqual(
      [],
    );
  });

  it("marks a second copy of an invoice already here, in the list and on its page", async () => {
    const first = ids["northline-20418"] as string;
    const [x] = await harness.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, first))
      .orderBy(desc(docExtraction.createdAt))
      .limit(1);
    if (!x) throw new Error("the golden invoice was not read");
    // A scan of the same invoice: other bytes (another sha256), read the same way. Its reading
    // writes the vendor and number with other case and spacing, which still count as the same.
    const [copy] = await harness.t.db
      .insert(document)
      .values({
        tenantId: harness.A.tenantId,
        source: "upload",
        storageKey: `tenants/${harness.A.tenantId.toLowerCase()}/content/cc/${"c".repeat(64)}`,
        mimeType: "application/pdf",
        filename: "northline-20418-scan.pdf",
        sizeBytes: 10,
        sha256: "c".repeat(64),
        status: "extracted",
        receivedAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const header = x.header as Record<string, unknown>;
    const { id: _id, createdAt: _at, documentId: _doc, ...reading } = x;
    await harness.t.db.insert(docExtraction).values({
      ...reading,
      documentId: copy?.id as string,
      header: {
        ...header,
        vendorName: String(header.vendorName).toUpperCase(),
        invoiceNumber: ` ${String(header.invoiceNumber)} `,
      },
    });

    const list = ((await harness.call(admin("a"), "GET", "/api/documents")).json as J).documents;
    const second = list.find((d: J) => d.id === copy?.id);
    expect(second.sameInvoiceAs).toMatchObject({
      id: first,
      filename: "northline-20418.pdf",
      source: "upload",
    });
    // The first one is not a copy of the second.
    expect(list.find((d: J) => d.id === first).sameInvoiceAs).toBeNull();
    // Another invoice is nobody's copy.
    expect(list.find((d: J) => d.id === ids["keystone-55102"]).sameInvoiceAs).toBeNull();
    const page = await harness.call(user("a"), "GET", `/api/documents/${copy?.id}`);
    expect((page.json as J).document.sameInvoiceAs.id).toBe(first);
    // Client B never learns of client A's invoices.
    expect(((await harness.call(admin("b"), "GET", "/api/documents")).json as J).documents).toEqual(
      [],
    );
  });

  it("lists connectors, and upload as built in on every client's Connections page", async () => {
    const c = await harness.call(user("b"), "GET", "/api/connectors");
    expect((c.json as J).connectors.map((x: J) => x.id)).toEqual(["upload", "testkit"]);
    const conns = await harness.call(user("b"), "GET", "/api/connections");
    expect((conns.json as J).connections[0].connector).toBe("upload");
  });

  describe("forwarding", () => {
    let address = "";

    it("gives each client a private address and lets the admin set senders", async () => {
      const got = await harness.call(user("a"), "GET", "/api/connections/upload/forwarding");
      expect(got.status).toBe(200);
      address = (got.json as J).forwarding.address;
      expect(address).toMatch(
        new RegExp(`^client-a-[a-z2-7]{26}-[a-z2-7]{8}@${DOMAIN.replace(/\./g, "\\.")}$`),
      );
      const again = await harness.call(admin("a"), "GET", "/api/connections/upload/forwarding");
      expect((again.json as J).forwarding.address).toBe(address);
      expect(
        (
          await harness.call(user("a"), "PUT", "/api/connections/upload/senders", {
            allowed: ["x.example"],
          })
        ).status,
      ).toBe(403);
      const bad = await harness.call(admin("a"), "PUT", "/api/connections/upload/senders", {
        allowed: ["not an address"],
      });
      expect(bad.status).toBe(422);
      const ok = await harness.call(admin("a"), "PUT", "/api/connections/upload/senders", {
        allowed: ["AP@hollismillwork.example", "@keystonehw.example", "ap@hollismillwork.example"],
      });
      expect((ok.json as J).forwarding.allowedSenders).toEqual([
        "ap@hollismillwork.example",
        "keystonehw.example",
      ]);
    });

    it("email(): an allowed sender's attachments arrive as documents; others are dropped and counted", async () => {
      const deps = {
        ...defaultDeps,
        openDb: () => ({ db: harness.db, close: async () => {} }),
        instances: () => harness.instances,
        objects: () => harness.objects,
        extractionTransport: () => null,
      };
      const pending: Promise<unknown>[] = [];
      const message = (name: string, from: string) => {
        const raw = new Uint8Array(file("email", name));
        return {
          from,
          to: address,
          raw: new Response(raw).body as ReadableStream<Uint8Array>,
          rawSize: raw.length,
        };
      };
      const ok = await handleEmail(
        message("from-vendor.eml", "billing@keystonehw.example"),
        harness.env,
        (p) => pending.push(p),
        deps,
      );
      expect(ok?.status).toBe("accepted");
      const dropped = await handleEmail(
        message("unknown-sender.eml", "accounts@unknown-vendor.example"),
        harness.env,
        (p) => pending.push(p),
        deps,
      );
      expect(dropped).toMatchObject({ status: "dropped", reason: "sender_not_allowed" });
      await Promise.all(pending);
      const docs = ((await harness.call(admin("a"), "GET", "/api/documents")).json as J).documents;
      // Keystone's PDF was already uploaded (same bytes): still one document; the PNG too.
      expect(docs.filter((d: J) => d.source === "email")).toEqual([]);
      const f = (
        (await harness.call(admin("a"), "GET", "/api/connections/upload/forwarding")).json as J
      ).forwarding;
      expect(f).toMatchObject({ accepted: 1, dropped: 1, lastDropReason: "sender_not_allowed" });
    });
  });
});

describe("file links' Content-Disposition", () => {
  it("is a valid header for any file name, with the exact name in UTF-8", () => {
    const h = contentDisposition('发票 20418 "final".pdf');
    expect(() => new Headers({ "content-disposition": h })).not.toThrow();
    expect(h).toContain(`filename="__ 20418 _final_.pdf"`);
    expect(h).toContain("filename*=UTF-8''%E5%8F%91%E7%A5%A8%2020418%20%22final%22.pdf");
    expect(contentDisposition("a\r\nSet-Cookie: x.pdf")).not.toMatch(/[\r\n]/);
  });
});
