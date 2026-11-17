// §1.110: files attached to a message in the portal. `POST /api/uploads?for=chat` stores PDFs and
// images quietly (no `document.received`, nothing read, no CSV import); a message carries only
// the client's own documents, by id, and shows them back with their names, in the portal and in
// the back office.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { docExtraction, event } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness();
afterAll(() => h?.close());

const INVOICE = readFileSync(resolve(DEFAULT_FIXTURE_DIR, "../invoices/northline-20418.pdf"));

describe.skipIf(!h)("files in a conversation", () => {
  const H = h as NonNullable<typeof h>;

  async function attach(email: string, files: { name: string; type: string; bytes: Uint8Array }[]) {
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.bytes], f.name, { type: f.type }));
    const res = await H.app.request(
      "/api/uploads?for=chat",
      { method: "POST", headers: { [DEV_USER_HEADER]: email }, body: form },
      H.env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as J };
  }

  let fileId = "";

  it("stores a file for a message quietly", async () => {
    const res = await attach(user("a"), [
      { name: "northline-20418.pdf", type: "application/pdf", bytes: INVOICE },
      { name: "purchases.csv", type: "text/csv", bytes: new TextEncoder().encode("a,b\n1,2\n") },
    ]);
    expect(res.status).toBe(200);
    const [pdf, csv] = res.json.results;
    expect(pdf).toMatchObject({ kind: "document", created: true });
    // A CSV in a chat is not imported as purchases.
    expect(csv.kind).toBe("refused");
    fileId = pdf.document.id;
    await H.settle();
    const received = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "document.received"), eq(event.subjectId, fileId)));
    expect(received).toEqual([]);
    const read = await H.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, fileId));
    expect(read).toEqual([]);
  });

  it("carries the client's own files on a message, and shows them with their names", async () => {
    const t = await H.call(user("a"), "POST", "/api/threads", { subject: "account" });
    expect(t.status).toBe(200);
    const threadId = (t.json as J).thread.id;
    const posted = await H.call(user("a"), "POST", `/api/threads/${threadId}/messages`, {
      text: "Can you send this to Pia?",
      documents: [fileId],
    });
    expect(posted.status).toBe(200);
    expect((posted.json as J).messages[0].documents).toEqual([
      { id: fileId, name: "northline-20418.pdf", contentType: "application/pdf" },
    ]);
    const read = await H.call(user("a"), "GET", `/api/threads/${threadId}/messages`);
    expect((read.json as J).messages[0].documents).toHaveLength(1);
    // The back office sees the same file on the message.
    const ops = await H.call(OPERATOR, "GET", `/api/ops/threads/${threadId}/messages`);
    expect(ops.status).toBe(200);
    expect((ops.json as J).messages[0].documents).toEqual([
      { id: fileId, name: "northline-20418.pdf", contentType: "application/pdf" },
    ]);
  });

  it("refuses another client's file", async () => {
    const t = await H.call(admin("b"), "POST", "/api/threads", { subject: "account" });
    const threadId = (t.json as J).thread.id;
    const posted = await H.call(admin("b"), "POST", `/api/threads/${threadId}/messages`, {
      text: "Process this",
      documents: [fileId],
    });
    expect(posted.status).toBe(422);
    expect((posted.json as J).error.code).toBe("invalid_document");
  });
});
