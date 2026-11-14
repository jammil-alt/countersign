// Migration 0049 (docs/plan.md §1.99): `person_device`, a person's phones with the Mezonas app, and
// `push` as a notification channel. The Worker's role sees and writes only its own client's phones,
// never deletes one, a removed phone keeps no token or key, and the notification check takes push.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

const KEY = `'{"kty":"EC","crv":"P-256","x":"${"A".repeat(43)}","y":"${"B".repeat(43)}"}'`;

describe.skipIf(!online)("0049: person_device and push", () => {
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

  const asA = <T>(fn: (run: (q: string) => Promise<unknown>) => Promise<T>) =>
    withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return fn((q) => tx.execute(q));
    });

  it("shows a client only its own phones", async () => {
    const rows = (await asA((run) => run("select tenant_id from person_device"))) as unknown as {
      tenant_id: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    const code = await errorCode(
      asA((run) =>
        run(`insert into person_device (tenant_id, user_id, name, platform)
             values ('${B.tenantId}', '${B.userId}', 'Not mine', 'ios')`),
      ),
    );
    expect(code).toBe("42501");
  });

  it("registers, renames and removes a phone, and never deletes one", async () => {
    const [row] = (await asA((run) =>
      run(`insert into person_device (tenant_id, user_id, name, platform, push_token, public_key)
           values ('${A.tenantId}', '${A.userId}', 'Maria''s iPhone', 'ios',
             'ExponentPushToken[abc]', ${KEY}) returning id`),
    )) as unknown as { id: string }[];
    const id = row?.id ?? "";
    await asA((run) => run(`update person_device set name = 'iPhone' where id = '${id}'`));
    // Removed: a phone that keeps its token or key is refused.
    expect(
      await errorCode(
        asA((run) => run(`update person_device set revoked_at = now() where id = '${id}'`)),
      ),
    ).toBe("23514");
    await asA((run) =>
      run(`update person_device set revoked_at = now(), push_token = null, public_key = null
           where id = '${id}'`),
    );
    expect(await errorCode(asA((run) => run(`delete from person_device where id = '${id}'`)))).toBe(
      "42501",
    );
    expect(
      await errorCode(
        asA((run) =>
          run(`insert into person_device (tenant_id, user_id, name, platform)
               values ('${A.tenantId}', '${A.userId}', 'Tablet', 'windows')`),
        ),
      ),
    ).toBe("23514");
  });

  it("takes push as a notification channel", async () => {
    await asA((run) =>
      run(`insert into notification (tenant_id, user_id, channel, kind, dedupe_key, link)
           values ('${A.tenantId}', '${A.userId}', 'push', 'items_waiting', 'items-push:x', '/inbox')`),
    );
    expect(
      await errorCode(
        asA((run) =>
          run(`insert into notification (tenant_id, user_id, channel, kind, dedupe_key, link)
               values ('${A.tenantId}', '${A.userId}', 'pager', 'items_waiting', 'x', '/inbox')`),
        ),
      ),
    ).toBe("23514");
  });
});
