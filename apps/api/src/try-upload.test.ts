// builder-plan.md B1: a document uploaded to try a build's draft on (`POST
// /api/ops/clients/:id/uploads?for=try`) is stored in the Sandbox quietly: no `document.received`,
// so no Sandbox agent starts on it (the try runs it), and no CSV import; it is still read.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { document, event, membership, tenant } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const NORTHLINE = readFileSync(
  resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", "northline-20418.pdf"),
);

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("a document uploaded to try a draft on", () => {
  const H = h as ApiHarness;
  let sandbox = "";
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };

  async function upload(files: File[]) {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const res = await H.app.request(
      `/api/ops/clients/${sandbox}/uploads?for=try`,
      { method: "POST", headers: { [DEV_USER_HEADER]: OPERATOR }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    return { status: res.status, json: j(await res.json()) };
  }

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true, connectors_offered: ["testkit"] } })
      .returning();
    if (!row) throw new Error("no sandbox");
    sandbox = row.id;
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox, userId: H.operator, role: "operator" });
  });

  it("is stored and read, and starts nothing", async () => {
    const res = await upload([
      new File([NORTHLINE], "northline-20418.pdf", { type: "application/pdf" }),
      new File(["a,b\n1,2\n"], "purchases.csv", { type: "text/csv" }),
    ]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [pdf, csv] = res.json.results;
    expect(pdf).toMatchObject({ kind: "document", created: true });
    // §1.164: a CSV that isn't a purchases export is a document, kept quietly for the try too.
    expect(csv).toMatchObject({ kind: "document", created: true, purchases: null });
    await settle();
    const [doc] = await H.t.db.select().from(document).where(eq(document.id, pdf.document.id));
    expect(doc).toMatchObject({ tenantId: sandbox, status: "extracted" });
    expect(doc?.meta).toEqual({ uploadedBy: H.operator, via: "try" });
    const types = (await H.t.db.select().from(event).where(eq(event.tenantId, sandbox))).map(
      (e) => e.type,
    );
    expect(types).not.toContain("document.received");
    expect(types).not.toContain("transaction.created");
  });
});
