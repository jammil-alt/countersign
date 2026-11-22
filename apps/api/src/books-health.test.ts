// Books health (docs/plan.md §1.216) through the API against the fake QuickBooks: a company seeded
// with one of each known problem is connected and synced, and the report finds every one, ranked by
// dollars, with its evidence; a reconciliation signed off in Mezonas moves the checking account's
// age; the client's admin reads it in the portal (no prompt, model or cost), a client user can't,
// another client sees nothing, and the back office reads the same report.

import { ContentStore, createQboConnector, generateEncryptionKey } from "@countersign/connectors";
import {
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakeBooksCompany,
  fakeQbo,
} from "@countersign/connectors/testing";
import { rawRecord, withTenant } from "@countersign/db";
import { reconciliation } from "@countersign/pack-bookkeeping";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";
import { runQboSync } from "./qbo/sync";
import { credentialsFor } from "./runs/execute";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const ENCRYPTION_KEY = generateEncryptionKey();
const qbo = fakeQbo();
const TODAY = new Date().toISOString().slice(0, 10);
const company = fakeBooksCompany(TODAY);

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: "qbo-verifier",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
  },
  qboSync: new MemoryQboSyncInstances(),
});
afterAll(() => h?.close());

describe.skipIf(!h)("books health on a QuickBooks company with known problems", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  let qboId = "";

  beforeAll(async () => {
    for (const [entity, rows] of Object.entries(company.rows)) {
      for (const row of rows) qbo.put(entity, row as { Id: string });
    }
    const offered = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["qbo"],
    });
    expect(offered.status, JSON.stringify(offered.json)).toBe(200);
    const q = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(q.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    qboId = j(done.json).connection.connection.id;
    await H.settle();
    await H.t.db.execute(
      sql`update connection set sync_cursor = sync_cursor - 'running' - 'pending' where id = ${qboId}`,
    );
    await runQboSync(
      {
        db: H.db,
        platform: H.platform,
        content: new ContentStore(H.objects),
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      },
      { tenantId: A(), connectionId: qboId, reason: "operator" },
      { do: <T>(_name: string, fn: () => Promise<T>) => fn() },
    );
  });

  const report = async (who = admin("a")) => {
    const res = await H.call(who, "GET", "/api/books-health");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json);
  };

  it("finds every problem the company was seeded with, most dollars first", async () => {
    const view = await report();
    expect(view.company.lastSyncAt).not.toBeNull();
    const found = view.report.findings as J[];
    // The fake's own fixtures sit in the same company, so each of ours is found among them: every
    // record the finding was seeded with is among its sources.
    const synced = await H.t.db
      .select({ id: rawRecord.id, externalId: rawRecord.externalId })
      .from(rawRecord)
      .where(eq(rawRecord.tenantId, A()));
    const external = new Map(synced.map((r) => [r.id, r.externalId]));
    for (const e of company.expected) {
      const f = found.find((x) => x.check === e.check);
      expect(f, e.check).toBeDefined();
      const ids = (f.sources as string[]).map((s) => external.get(s));
      for (const id of e.examples) expect(ids, `${e.check} ${id}`).toContain(id);
      expect(f.examples.length).toBeGreaterThan(0);
    }
    expect(view.report.findings.length).toBe(9);
    const amounts = found.map((f) => Number(f.amount));
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    // The checks that need no fixture noise come out exactly.
    for (const check of [
      "duplicate_vendors",
      "price_drift",
      "negative_balances",
      "undeposited_funds",
    ]) {
      const e = company.expected.find((x) => x.check === check);
      const f = found.find((x) => x.check === check);
      expect({ check, amount: f.amount, count: f.count }).toEqual({
        check,
        amount: e?.amount,
        count: e?.count,
      });
    }
  });

  it("rests every example on a synced record of this client", async () => {
    const view = await report();
    const sources = [
      ...new Set((view.report.findings as J[]).flatMap((f) => f.sources as string[])),
    ];
    const rows = await H.t.db
      .select({ id: rawRecord.id })
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, A()), inArray(rawRecord.id, sources)));
    expect(rows.length).toBe(sources.length);
  });

  it("counts a reconciliation signed off in Mezonas", async () => {
    const before = (await report()).report.findings.find(
      (f: J) => f.check === "unreconciled_accounts",
    );
    const checking = before.groups.find((g: J) => g.label === "Checking");
    expect(checking.note).toMatch(/^Never reconciled with us/);
    await withTenant(H.db, A(), (tx) =>
      tx.insert(reconciliation).values({
        tenantId: A(),
        pairKey: `bank:link-1|qbo:${qboId}:9035`,
        aLabel: "Business Checking",
        bLabel: "Checking",
        asOf: company.reconciledThrough["9035"] as string,
        aClosing: "12000",
        bClosing: "12000",
        difference: "0",
        residual: "0",
        outcome: "balanced",
        status: "signed_off",
        signedOffBy: H.A.admin,
        signedOffAt: new Date(),
      }),
    );
    const after = (await report()).report.findings.find(
      (f: J) => f.check === "unreconciled_accounts",
    );
    const g = after.groups.find((x: J) => x.label === "Checking");
    expect(g.note).toMatch(/^Last reconciled through \d{4}-\d{2}-\d{2}, 81 days ago$/);
    expect(g.amount).toBe("4850.0000");
    expect(g.count).toBe(4);
  });

  it("is the admin's: a client user is refused, and nothing in it is a prompt, model or cost", async () => {
    const view = await report();
    expect(forbiddenKeys(view)).toEqual([]);
    const refused = await H.call(user("a"), "GET", "/api/books-health");
    expect(refused.status).toBe(403);
  });

  it("shows another client nothing of this one", async () => {
    const other = await report(admin("b"));
    expect(other.company).toBeNull();
    expect(other.report).toBeNull();
  });

  it("gives the back office the same report", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/books-health`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const mine = await report();
    expect(j(res.json).report.findings.map((f: J) => [f.check, f.amount])).toEqual(
      mine.report.findings.map((f: J) => [f.check, f.amount]),
    );
  });
});
