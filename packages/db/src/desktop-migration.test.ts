// Migration 0080 (docs/plan.md §1.151, §1.204): `desktop_device`, a client's paired computers, and
// `desktop_job`, the jobs queued for them. The Worker's role sees and writes only its own client's
// rows, never deletes one, changes only the columns the guard allows, a removed computer keeps no
// key, and the lookup names the client of a paired computer only.

import { DesktopJobRequest } from "@countersign/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { DESKTOP_JOB_KINDS } from "./schema";
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

it("the job kinds are core's", () => {
  expect([...DESKTOP_JOB_KINDS].sort()).toEqual(
    DesktopJobRequest.options.map((o) => o.shape.kind.value).sort(),
  );
});

describe.skipIf(!online)("0080: desktop_device and desktop_job", () => {
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

  const pair = async (name: string) => {
    const [row] = (await asA((run) =>
      run(`insert into desktop_device (tenant_id, connection_id, name, platform, app_version,
             public_key, paired_by)
           values ('${A.tenantId}', '${A.connectionId}', '${name}', 'mac', '0.1.0', ${KEY},
             '${A.userId}') returning id`),
    )) as unknown as { id: string }[];
    return row?.id ?? "";
  };
  const revoke = (id: string) =>
    asA((run) =>
      run(`update desktop_device set revoked_at = now(), public_key = null where id = '${id}'`),
    );

  it("forces row-level security on both tables", async () => {
    const rows = await t.db.execute<{ relname: string; rls: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relname in ('desktop_device', 'desktop_job') order by relname`);
    expect([...rows]).toEqual([
      { relname: "desktop_device", rls: true, forced: true },
      { relname: "desktop_job", rls: true, forced: true },
    ]);
  });

  it("shows a client only its own computers and jobs", async () => {
    for (const table of ["desktop_device", "desktop_job"]) {
      const rows = (await asA((run) => run(`select tenant_id from ${table}`))) as unknown as {
        tenant_id: string;
      }[];
      expect(rows.length, table).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.tenant_id)), table).toEqual(new Set([A.tenantId]));
    }
    const code = await errorCode(
      asA((run) =>
        run(`insert into desktop_device (tenant_id, connection_id, name, platform, app_version,
               public_key, paired_by)
             values ('${B.tenantId}', '${B.connectionId}', 'Not mine', 'mac', '0.1.0', ${KEY},
               '${B.userId}')`),
      ),
    );
    expect(code).toBe("42501");
  });

  it("pairs, renames and removes a computer, never deletes one, and keeps no key once removed", async () => {
    // The fixture's computer is live on A's connection: one live computer per connection.
    expect(await errorCode(pair("Second"))).toBe("23505");
    const [live] = (await asA((run) =>
      run(`select id from desktop_device where connection_id = '${A.connectionId}'
           and revoked_at is null`),
    )) as unknown as { id: string }[];
    const id = live?.id ?? "";
    await asA((run) =>
      run(`update desktop_device set name = 'Desk PC', app_version = '0.2.0',
           last_seen_at = now() where id = '${id}'`),
    );
    // Removed with its key kept: refused.
    expect(
      await errorCode(
        asA((run) => run(`update desktop_device set revoked_at = now() where id = '${id}'`)),
      ),
    ).toBe("23514");
    await revoke(id);
    expect(
      await errorCode(asA((run) => run(`delete from desktop_device where id = '${id}'`))),
    ).toBe("42501");
    // Its client, platform and connection never change.
    expect(
      await errorCode(
        asA((run) => run(`update desktop_device set platform = 'mac' where id = '${id}'`)),
      ),
    ).toBe("23001");
    // A new pairing on the same connection once the old one is removed.
    const again = await pair("Front office PC");
    expect(again).not.toBe(id);
    expect(
      await errorCode(
        asA((run) =>
          run(`insert into desktop_device (tenant_id, connection_id, name, platform, app_version,
                 public_key, paired_by)
               values ('${A.tenantId}', '${A.connectionId}', 'Phone', 'ios', '0.1.0', ${KEY},
                 '${A.userId}')`),
        ),
      ),
    ).toBe("23514");
  });

  it("queues a job, sends it and answers it once, and changes nothing else", async () => {
    const [device] = (await asA((run) =>
      run(`select id from desktop_device where connection_id = '${A.connectionId}'
           and revoked_at is null`),
    )) as unknown as { id: string }[];
    const [job] = (await asA((run) =>
      run(`insert into desktop_job (tenant_id, device_id, kind, request, expires_at)
           values ('${A.tenantId}', '${device?.id}', 'file.read',
             '{"kind":"file.read","folderId":"x","path":"a.txt"}', now() + interval '2 minutes')
           returning id`),
    )) as unknown as { id: string }[];
    const id = job?.id ?? "";
    await asA((run) => run(`update desktop_job set sent_at = now() where id = '${id}'`));
    // An answer needs its time, and the time its answer.
    expect(
      await errorCode(
        asA((run) => run(`update desktop_job set answered_at = now() where id = '${id}'`)),
      ),
    ).toBe("23514");
    await asA((run) =>
      run(`update desktop_job set answered_at = now(),
           result = '{"ok":false,"error":{"code":"not_found","message":"gone"}}' where id = '${id}'`),
    );
    expect(
      await errorCode(
        asA((run) => run(`update desktop_job set request = '{}' where id = '${id}'`)),
      ),
    ).toBe("23001");
    expect(await errorCode(asA((run) => run(`delete from desktop_job where id = '${id}'`)))).toBe(
      "42501",
    );
    expect(
      await errorCode(
        asA((run) =>
          run(`insert into desktop_job (tenant_id, device_id, kind, request, expires_at)
               values ('${A.tenantId}', '${device?.id}', 'file.delete', '{}',
                 now() + interval '2 minutes')`),
        ),
      ),
    ).toBe("23514");
  });

  it("names the client of a paired computer only, to the Worker's role", async () => {
    const [b] = (await withTenant(t.db, B.tenantId, (tx) =>
      tx.execute(sql`select id from desktop_device where revoked_at is null`),
    )) as unknown as { id: string }[];
    // From A's scope, the lookup still answers B's computer's client: it is the one way in.
    const lookup = async (id: string) => {
      const rows = (await asA((run) =>
        run(`select desktop_device_tenant('${id}') as tenant_id`),
      )) as unknown as { tenant_id: string | null }[];
      return rows[0]?.tenant_id ?? null;
    };
    expect(await lookup(b?.id ?? "")).toBe(B.tenantId);
    const removed = await asA((run) =>
      run(`select id from desktop_device where revoked_at is not null limit 1`),
    );
    const removedId = (removed as unknown as { id: string }[])[0]?.id ?? "";
    expect(removedId).not.toBe("");
    expect(await lookup(removedId)).toBeNull();
    expect(await lookup(crypto.randomUUID())).toBeNull();
  });
});
