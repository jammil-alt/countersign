// A client's saved match rules (docs/plan.md §1.215) against a real database as cs_worker: the
// operator saves a correction as a rule (normalised by its configuration), lists and retires it;
// values that already agree save nothing; an operator who doesn't serve the client, and the
// client's own people, can't reach the rules.

import { matchRule } from "@countersign/db";
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

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("saved match rules", () => {
  const H = h as ApiHarness;
  const path = () => `/api/ops/clients/${H.B.tenantId}/match-rules`;

  it("saves a correction as a rule, normalised, and lists the configurations", async () => {
    const saved = await H.call(OPERATOR, "POST", path(), {
      config: "invoice_two_systems",
      field: "counterparty",
      a: "Rocky Mountain Coal Co.",
      b: "ROMCO, Inc.",
      note: "Their system's name for them",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).rules).toMatchObject([
      {
        config: "invoice_two_systems",
        field: "counterparty",
        aValue: "rocky mountain coal",
        bValue: "romco",
        note: "Their system's name for them",
      },
    ]);
    expect(
      j(saved.json)
        .configs.map((c: { id: string }) => c.id)
        .sort(),
    ).toEqual(["bank_to_ledger", "invoice_two_systems"]);
    const rows = await H.t.db.select().from(matchRule).where(eq(matchRule.tenantId, H.B.tenantId));
    expect(rows).toHaveLength(1);
  });

  it("saves nothing when the values already agree, or the configuration is unknown", async () => {
    const same = await H.call(OPERATOR, "POST", path(), {
      config: "invoice_two_systems",
      field: "reference",
      a: "INV-000042",
      b: "42",
    });
    expect(same.status).toBe(400);
    expect(j(same.json).error?.code).toBe("no_rule");
    const unknown = await H.call(OPERATOR, "POST", path(), {
      config: "nothing_like_it",
      field: "reference",
      a: "1",
      b: "2",
    });
    expect(unknown.status).toBe(404);
  });

  it("retires a rule, which stays as history", async () => {
    const list = await H.call(OPERATOR, "GET", path());
    const id = j(list.json).rules[0].id as string;
    const gone = await H.call(OPERATOR, "DELETE", `${path()}/${id}`);
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect(j(gone.json).rules).toEqual([]);
    expect((await H.call(OPERATOR, "DELETE", `${path()}/${id}`)).status).toBe(404);
    const [row] = await H.t.db.select().from(matchRule).where(eq(matchRule.id, id));
    expect(row?.retiredAt).not.toBeNull();
  });

  it("is out of reach of an operator who doesn't serve the client, and of the client", async () => {
    expect((await H.call(OTHER_OPERATOR, "GET", path())).status).toBe(404);
    expect(
      (
        await H.call(OTHER_OPERATOR, "POST", path(), {
          config: "bank_to_ledger",
          field: "reference",
          a: "ACH 1",
          b: "TRF 1",
        })
      ).status,
    ).toBe(404);
    expect((await H.call(admin("b"), "GET", path())).status).toBe(403);
  });
});
