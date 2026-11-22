// A client's saved match rules (docs/plan.md §1.215) through ./match-rules.ts, as cs_worker: saved,
// read by configuration, replaced by a newer correction, retired; one client never reads another's.

import { MATCH_RULE_FIELDS as CORE_FIELDS } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { listMatchRules, liveMatchRules, retireMatchRule, saveMatchRule } from "./match-rules";
import { MATCH_RULE_FIELDS } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

it("the fields are core's", () => {
  expect([...MATCH_RULE_FIELDS]).toEqual([...CORE_FIELDS]);
});

describe.skipIf(!online)("saved match rules", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  const as = <T>(c: ClientFixture, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(t.db, c.tenantId, async (tx) => {
      await asWorker(tx);
      return fn(tx);
    });

  it("saves, replaces, reads by configuration and retires a client's rules", async () => {
    const first = await as(A, (tx) =>
      saveMatchRule(tx, {
        tenantId: A.tenantId,
        userId: A.userId,
        config: "invoice_two_systems",
        field: "counterparty",
        aValue: "rocky mountain coal",
        bValue: "romco",
      }),
    );
    expect(first.replaced).toBeNull();
    const second = await as(A, (tx) =>
      saveMatchRule(tx, {
        tenantId: A.tenantId,
        userId: A.userId,
        config: "invoice_two_systems",
        field: "counterparty",
        aValue: "rocky mountain coal",
        bValue: "romco industries",
        note: "Their system renamed them",
      }),
    );
    expect(second.replaced).toBe(first.id);
    const live = await as(A, (tx) => liveMatchRules(tx, A.tenantId, "invoice_two_systems"));
    expect(live).toEqual([
      {
        id: second.id,
        field: "counterparty",
        aValue: "rocky mountain coal",
        bValue: "romco industries",
      },
    ]);
    // The fixture's bank rule is another configuration's.
    const all = await as(A, (tx) => listMatchRules(tx, A.tenantId));
    expect(all.map((r) => r.config).sort()).toEqual(["bank_to_ledger", "invoice_two_systems"]);
    expect(
      await as(A, (tx) =>
        retireMatchRule(tx, { tenantId: A.tenantId, userId: A.userId, id: second.id }),
      ),
    ).toBe(true);
    expect(
      await as(A, (tx) =>
        retireMatchRule(tx, { tenantId: A.tenantId, userId: A.userId, id: second.id }),
      ),
    ).toBe(false);
    expect(await as(A, (tx) => liveMatchRules(tx, A.tenantId, "invoice_two_systems"))).toEqual([]);
  });

  it("never reads or retires another client's rules", async () => {
    const mine = await as(A, (tx) =>
      saveMatchRule(tx, {
        tenantId: A.tenantId,
        userId: A.userId,
        config: "invoice_two_systems",
        field: "reference",
        aValue: "1050",
        bValue: "r1050",
      }),
    );
    expect(await as(B, (tx) => liveMatchRules(tx, A.tenantId, "invoice_two_systems"))).toEqual([]);
    expect(
      await as(B, (tx) =>
        retireMatchRule(tx, { tenantId: A.tenantId, userId: B.userId, id: mine.id }),
      ),
    ).toBe(false);
    expect(
      (await as(A, (tx) => liveMatchRules(tx, A.tenantId, "invoice_two_systems"))).map((r) => r.id),
    ).toEqual([mine.id]);
  });
});
