// What we pay vendors for outside a run's model calls (docs/plan.md §1.210): recorded once each,
// counted by the rollups into the client's usage (an agent's, or the client's own), never the
// back office's; and the back office's Usage shows each vendor, each row's services beside its
// model cost, and the back office's own model calls and services as their own lines.

import { rollupUsageDays } from "@countersign/agents";
import {
  METER_SOURCES,
  METERED_MEASURES,
  PLACEHOLDER_UNIT_COSTS,
  UNIT_COSTS_CHECKED_ON,
} from "@countersign/core";
import {
  agent,
  connection,
  METERED_MEASURES as DB_MEASURES,
  meteredUsage,
  usageDaily,
  usagePlatformDaily,
  withOperator,
  withTenant,
} from "@countersign/db";
import type { LlmCallRecord } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { browserSeconds } from "./browser/services";
import { meter, meterBankItems, meterModelCalls } from "./metering";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe("metering's words", () => {
  it("has the database's measures, a source pattern every source meets, and unverified prices", () => {
    expect([...METERED_MEASURES]).toEqual([...DB_MEASURES]);
    for (const s of METER_SOURCES) expect(s).toMatch(/^[a-z_]{1,40}$/);
    expect(UNIT_COSTS_CHECKED_ON).toBe("unverified");
    expect(Object.keys(PLACEHOLDER_UNIT_COSTS).sort()).toEqual(
      [
        "bank_item_months",
        "browser_seconds",
        "call_seconds",
        "emails",
        "messages",
        "verifications",
      ].sort(),
    );
  });

  it("counts a browser session's whole seconds, rounded up", () => {
    expect(
      browserSeconds({
        startedAt: "2026-11-22T10:00:00.000Z",
        endedAt: "2026-11-22T10:01:30.200Z",
      }),
    ).toBe(91);
    expect(browserSeconds({ startedAt: "2026-11-22T10:00:00.000Z", endedAt: "nope" })).toBe(0);
    expect(
      browserSeconds({
        startedAt: "2026-11-22T10:00:00.000Z",
        endedAt: "2026-11-22T09:00:00.000Z",
      }),
    ).toBe(0);
  });
});

describe.skipIf(!h)("metered usage", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;
  const today = new Date().toISOString().slice(0, 10);
  const call = (o: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
    model: "claude-haiku-5-5" as LlmCallRecord["model"],
    ok: true,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 30,
    },
    costUsd: "0.000123",
    durationMs: 10,
    stopReason: "end_turn",
    ...o,
  });

  it("records each thing once, rolls the client's up and leaves ours out", async () => {
    const A = H.A.tenantId;
    const [a] = await db
      .insert(agent)
      .values({ tenantId: A, kind: "client", slug: "metered", name: "Metered" })
      .returning();
    if (!a) throw new Error("no agent");
    await db.insert(connection).values({
      tenantId: A,
      connector: "bankfeed",
      status: "connected",
      externalAccountId: "item-1",
    });
    await withTenant(H.db, A, async (tx) => {
      // An agent's email, twice with one key: counted once.
      for (let i = 0; i < 2; i++) {
        await meter(tx, {
          tenantId: A,
          measure: "emails",
          source: "run",
          key: "resend:e1",
          agentId: a.id,
        });
      }
      await meter(tx, {
        tenantId: A,
        measure: "browser_seconds",
        source: "run",
        key: "b1",
        quantity: 90.2,
        agentId: a.id,
      });
      // The client's own: a notification text and an inbound one.
      await meter(tx, {
        tenantId: A,
        measure: "messages",
        source: "notification",
        key: "twilio:SM1",
      });
      await meter(tx, { tenantId: A, measure: "messages", source: "inbound", key: "twilio:SM2" });
      // Its bank, counted once a month however often the sweep runs.
      await meterBankItems(tx, A, new Date());
      await meterBankItems(tx, A, new Date());
      // Nothing for a quantity of 0.
      await meter(tx, { tenantId: A, measure: "emails", source: "run", key: "none", quantity: 0 });
    });
    await withOperator(H.db, [A], async (tx) => {
      await meterModelCalls(tx, {
        tenantId: A,
        source: "reggie_read",
        key: "read-1",
        calls: [call()],
      });
      await meter(tx, {
        tenantId: A,
        measure: "emails",
        source: "back_office",
        key: "issue-1",
        ours: true,
      });
    });
    // A sign-in code: no client, ours, written before any client is in scope.
    await withOperator(H.db, [], async (tx) =>
      meter(tx, { tenantId: null, measure: "verifications", source: "sign_in_code", key: "v1" }),
    );

    const rows = await withOperator(H.db, [A], (tx) =>
      tx.select().from(meteredUsage).where(eq(meteredUsage.tenantId, A)),
    );
    expect(rows.map((r) => r.key).sort()).toEqual(
      [
        "b1",
        "issue-1",
        `plaid:item-1:${today.slice(0, 7)}`,
        "read-1:0",
        "resend:e1",
        "twilio:SM1",
        "twilio:SM2",
      ].sort(),
    );
    const read = rows.find((r) => r.key === "read-1:0");
    // Rounded up to the ten-thousandth; input counts cache reads.
    expect(read).toMatchObject({
      measure: "model",
      ours: true,
      costUsd: "0.0002",
      tokensIn: 100,
      cacheReadTokens: 30,
      tokensOut: 20,
    });
    expect(rows.find((r) => r.key === "b1")?.quantity).toBe(91);
    // A client's own session never sees ours.
    const mine = await withTenant(H.db, A, (tx) =>
      tx.select({ key: meteredUsage.key }).from(meteredUsage),
    );
    expect(mine.map((r) => r.key)).not.toContain("read-1:0");
    expect(mine.map((r) => r.key)).not.toContain("issue-1");

    await withTenant(H.db, A, (tx) => rollupUsageDays(tx, { tenantId: A, days: [today] }));
    const [daily] = await db
      .select()
      .from(usageDaily)
      .where(
        and(eq(usageDaily.tenantId, A), eq(usageDaily.agentId, a.id), eq(usageDaily.day, today)),
      );
    expect(daily).toMatchObject({ emails: 1, browserSeconds: 91 });
    const [own] = await db
      .select()
      .from(usagePlatformDaily)
      .where(and(eq(usagePlatformDaily.tenantId, A), eq(usagePlatformDaily.day, today)));
    // The back office's email is not the client's.
    expect(own).toMatchObject({ messages: 2, emails: 0, browserSeconds: 0, bankItemMonths: 1 });

    const res = await H.call(OPERATOR, "GET", `/api/ops/usage?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const report = j(res.json);
    const vendor = (id: string) => report.byVendor.find((v: { id: string }) => v.id === id);
    expect(vendor("resend")).toMatchObject({ emails: 2, estimated: true, costUsd: "0.0018" });
    expect(vendor("twilio")).toMatchObject({ messages: 2, costUsd: "0.0166" });
    expect(vendor("browser_run")).toMatchObject({ browserSeconds: 91, costUsd: "0.0023" });
    expect(vendor("plaid")).toMatchObject({ bankItemMonths: 1, costUsd: "0.3000" });
    expect(vendor("twilio_verify")).toMatchObject({ verifications: 1, costUsd: "0.0500" });
    // The agent's row: its email and browser time beside its (no) model cost.
    const row = report.agents.find((r: { id: string }) => r.id === a.id);
    expect(row.total).toMatchObject({ costUsd: "0.0000", servicesUsd: "0.0032" });
    // The client: its agent's and its own (texts and bank), never ours.
    const client = report.clients.find((r: { id: string }) => r.id === A);
    expect(client.total.servicesUsd).toBe("0.3198");
    // Ours: Reggie's read (a model line) and the back office's email with the sign-in code.
    const lines = Object.fromEntries(
      report.backOffice.lines.map((l: { id: string; costUsd: string }) => [l.id, l.costUsd]),
    );
    expect(lines.reggie_read).toBe("0.0002");
    expect(lines.services).toBe("0.0509");
    expect(report.byModel.some((m: { model: string }) => m.model === "claude-haiku-5-5")).toBe(
      true,
    );
  });
});
