// scripts/migrate.mjs: the migrating session's timeouts, and its retry when a lock is not free.
// Runs with the package's other database tests (vitest), on a throwaway database.

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../src/testing";
import {
  LOCK_TIMEOUT,
  runMigrations,
  STATEMENT_TIMEOUT,
  sqlState,
  withLockRetry,
} from "./migrate.mjs";

const lockError = () => Object.assign(new Error("Failed query"), { cause: { code: "55P03" } });

describe("withLockRetry", () => {
  it("tries again after a lock timeout or a deadlock, then succeeds", async () => {
    const errors = [lockError(), Object.assign(new Error("deadlock"), { code: "40P01" })];
    const waits = [];
    const lines = [];
    let tries = 0;
    const result = await withLockRetry(
      async () => {
        tries++;
        const e = errors.shift();
        if (e) throw e;
        return "done";
      },
      { delays: [1, 2], sleep: async (ms) => waits.push(ms), log: (l) => lines.push(l) },
    );
    expect(result).toBe("done");
    expect(tries).toBe(3);
    expect(waits).toEqual([1, 2]);
    expect(lines[0]).toMatch(/55P03/);
  });

  it("gives up after the last try", async () => {
    let tries = 0;
    const run = withLockRetry(
      async () => {
        tries++;
        throw lockError();
      },
      { delays: [1, 1], sleep: async () => {}, log: () => {} },
    );
    await expect(run).rejects.toThrow("Failed query");
    expect(tries).toBe(3);
  });

  it("does not try again on any other error", async () => {
    let tries = 0;
    const run = withLockRetry(
      async () => {
        tries++;
        throw Object.assign(new Error("syntax"), { cause: { code: "42601" } });
      },
      { delays: [1], sleep: async () => {}, log: () => {} },
    );
    await expect(run).rejects.toThrow("syntax");
    expect(tries).toBe(1);
  });

  it("reads the code through drizzle's wrapper", () => {
    expect(sqlState(lockError())).toBe("55P03");
    expect(sqlState(new Error("plain"))).toBeUndefined();
  });
});

const t = await createTestDatabase();
afterAll(() => t?.drop());

describe.skipIf(!t)("runMigrations", () => {
  const db = t;

  it("is a no-op on a migrated database", async () => {
    const before = await db.db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    const n = await runMigrations(db.url);
    expect(n).toBe(before[0].n);
    expect(n).toBeGreaterThan(50);
  });

  it("migrates with lock and statement timeouts on its own session", async () => {
    let seen;
    await runMigrations(db.url, {
      apply: async (sql) => {
        const [lock] = await sql`show lock_timeout`;
        const [statement] = await sql`show statement_timeout`;
        seen = { lock: lock.lock_timeout, statement: statement.statement_timeout };
      },
    });
    expect(seen).toEqual({ lock: LOCK_TIMEOUT, statement: STATEMENT_TIMEOUT });
  });

  it("stops waiting for a held lock, rolls back and tries again once it is free", async () => {
    const holder = postgres(db.url, { max: 1, onnotice: () => {} });
    let release;
    const released = new Promise((done) => {
      release = done;
    });
    let locked;
    const isLocked = new Promise((done) => {
      locked = done;
    });
    // Live traffic holding a table: a transaction that keeps its lock until released.
    const holding = holder.begin(async (tx) => {
      await tx`lock table tenant in access exclusive mode`;
      locked();
      await released;
    });
    await isLocked;
    const lines = [];
    let tries = 0;
    try {
      await runMigrations(db.url, {
        apply: (sql) =>
          sql.begin(async (tx) => {
            tries++;
            await tx`alter table tenant add column if not exists migrate_probe text`;
            await tx`alter table tenant drop column migrate_probe`;
          }),
        delays: [1],
        sleep: async () => {
          release();
          await holding;
        },
        log: (line) => lines.push(line),
      });
    } finally {
      release();
      await holding;
      await holder.end();
    }
    expect(tries).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/55P03/);
  }, 20_000);
});
