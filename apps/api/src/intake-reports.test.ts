// File and email intake (docs/plan.md §1.213) through the API: the operator proposes a report
// profile from a file the client sent, saves it and reads it back with the files it landed;
// operator only (invariant 11), each call audited (invariant 14), the client's own only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { auditEvent } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const CSV = readFileSync(resolve(DEFAULT_FIXTURE_DIR, "../intake/cr2-daily-sales-2026-11-19.csv"));

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("report profiles through the API", () => {
  const H = h as ApiHarness;
  let documentId = "";
  const path = () => `/api/ops/clients/${H.A.tenantId}/intake/reports`;

  it("proposes columns from a file the client sent", async () => {
    const form = new FormData();
    form.append("files", new File([CSV], "cr2-daily-sales-2026-11-19.csv", { type: "text/csv" }));
    const deferred: Promise<unknown>[] = [];
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: admin("a") }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void deferred.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
    expect(res.status).toBe(200);
    documentId = j(await res.json()).results[0].document.id;
    expect(documentId).toBeTruthy();

    const r = await H.call(OPERATOR, "POST", `${path()}/propose`, { documentId, headerRow: 4 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(j(r.json)).toMatchObject({ rowCount: 5, totals: 1, sheet: null });
    expect(
      j(r.json).columns.map((c: { field: string; type: string }) => [c.field, c.type]),
    ).toEqual([
      ["ticket", "text"],
      ["date", "date"],
      ["customer", "text"],
      ["item", "text"],
      ["qty", "number"],
      ["netSales", "money"],
    ]);
  });

  it("saves profiles, refusing one that can't tell its files apart", async () => {
    const bad = await H.call(OPERATOR, "PUT", path(), {
      profiles: [{ id: "x", name: "X", read: { columns: [{ field: "a", type: "text" }] } }],
    });
    expect(bad.status).toBe(422);
    const profile = {
      id: "cr2-daily-sales",
      name: "CR2 daily sales",
      match: { filename: "cr2-daily-sales-*.csv" },
      read: {
        header_row: 4,
        columns: [
          { field: "ticket", headers: ["Ticket"], type: "text", required: true },
          { field: "netSales", headers: ["Net Sales"], type: "money", required: true },
        ],
      },
      controlTotal: { field: "netSales" },
      expected: { every: "day", byHour: 8 },
    };
    const saved = await H.call(OPERATOR, "PUT", path(), { profiles: [profile] });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).profiles[0]).toMatchObject({
      id: "cr2-daily-sales",
      createdAt: expect.any(String),
    });
    const read = await H.call(OPERATOR, "GET", path());
    expect(read.status).toBe(200);
    expect(j(read.json)).toMatchObject({
      profiles: [{ id: "cr2-daily-sales" }],
      duplicates: 0,
      rejected: 0,
      recent: [],
    });
    const audited = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.tenantId, H.A.tenantId));
    expect(audited.some((a) => JSON.stringify(a).includes("intake/reports"))).toBe(true);
  });

  it("is the operator's, and only for the clients they serve", async () => {
    expect((await H.call(admin("a"), "GET", path())).status).toBe(403);
    expect((await H.call(OTHER_OPERATOR, "GET", path())).status).toBe(404);
  });
});
