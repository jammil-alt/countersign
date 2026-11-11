// The test databases themselves (docs/audit-plan.md 9.5): each is a copy of one migrated template,
// the copies don't share data, nothing connects to the template, and a template dropped under a
// running process (another checkout's clean-up) is built again. Building it again also drops other
// checkouts' templates built more than a week ago, and keeps newer ones.

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { adminUrl, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const made: TestDatabase[] = [];
afterAll(async () => {
  for (const t of made) await t.drop();
});

async function fresh(): Promise<TestDatabase> {
  const t = await createTestDatabase();
  if (!t) throw new Error("no test database");
  made.push(t);
  return t;
}

/** Every cs_template_* on the server, this checkout's and any other's. */
async function templates(admin: postgres.Sql): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`
    select datname from pg_database where datistemplate and starts_with(datname, 'cs_template_')`;
  return rows.map((r) => r.datname);
}

describe.skipIf(!online)("test databases from a template", () => {
  it("gives each test its own migrated copy", async () => {
    const [a, b] = [await fresh(), await fresh()];
    for (const t of [a, b]) {
      const [row] = await t.db.execute<{ n: number }>(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      expect(row?.n).toBeGreaterThan(40);
    }
    await a.db.execute(sql`create table only_in_a (x int)`);
    const [inB] = await b.db.execute<{ t: string | null }>(
      sql`select to_regclass('only_in_a')::text as t`,
    );
    expect(inB?.t).toBeNull();
  });

  it("takes no connections to the template", async () => {
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    try {
      const names = await templates(admin);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const [row] = await admin<{ allowed: boolean }[]>`
          select datallowconn as allowed from pg_database where datname = ${name}`;
        expect(row?.allowed).toBe(false);
      }
    } finally {
      await admin.end();
    }
  });

  it("builds the template again when it is dropped, dropping only other old templates", async () => {
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    const tag = randomBytes(4).toString("hex");
    const recent = `cs_template_recent_${tag}`;
    const old = `cs_template_old_${tag}`;
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await fresh();
      for (const [name, built] of [
        [recent, new Date().toISOString()],
        [old, weekAgo],
      ]) {
        await admin.unsafe(`CREATE DATABASE ${name} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
        await admin.unsafe(`COMMENT ON DATABASE ${name} IS 'built ${built}'`);
      }
      // As another checkout's clean-up would: the template this process found is gone.
      const [current] = (await templates(admin)).filter((n) =>
        /^cs_template_[0-9a-f]{16}$/.test(n),
      );
      expect(current).toBeDefined();
      await admin.unsafe(`ALTER DATABASE ${current} WITH IS_TEMPLATE false`);
      await admin.unsafe(`DROP DATABASE ${current} WITH (FORCE)`);

      await fresh();
      const after = await templates(admin);
      expect(after).toContain(current);
      expect(after).toContain(recent);
      expect(after).not.toContain(old);
    } finally {
      for (const name of [recent, old]) {
        if ((await admin`select 1 from pg_database where datname = ${name}`).length === 0) continue;
        await admin.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`);
        await admin.unsafe(`DROP DATABASE ${name}`);
      }
      await admin.end();
    }
  }, 120_000);
});
