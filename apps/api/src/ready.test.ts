import type { Db } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness } from "./api.test-helper";
import { createApp } from "./app";
import type { Bindings } from "./env";
import { defaultDeps } from "./http";
import { databaseAnswers, deployedSha } from "./ready";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const h = await createApiHarness({ env: { DEPLOYED_SHA: SHA } });
afterAll(() => h?.close());

describe.skipIf(!h)("/api/ready with a database", () => {
  const harness = h as NonNullable<typeof h>;

  it("answers ok with the database and the deployed commit, without a session", async () => {
    const res = await harness.call(null, "GET", "/api/ready");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, db: "ok", sha: SHA });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("/api/ready without a database", () => {
  function appWith(db: Partial<Db>) {
    return createApp({
      ...defaultDeps,
      openDb: () => ({ db: db as Db, close: async () => {} }),
    });
  }
  const env = { DEPLOYED_SHA: SHA } as unknown as Bindings;

  it("answers 503 and says only that the database is unavailable", async () => {
    const app = appWith({
      execute: (async () => {
        throw new Error('password authentication failed for user "cs_worker" at db.internal');
      }) as unknown as Db["execute"],
    });
    const res = await app.request("/api/ready", {}, env);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, db: "unavailable", sha: SHA });
    expect(text).not.toMatch(/password|cs_worker|internal/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when there is no database binding at all", async () => {
    const app = createApp(defaultDeps);
    const res = await app.request("/api/ready", {}, {} as Bindings);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "unavailable", sha: null });
  });
});

describe("databaseAnswers", () => {
  it("gives up after the timeout", async () => {
    const hangs = { execute: () => new Promise(() => {}) } as unknown as Db;
    expect(await databaseAnswers(hangs, 20)).toBe(false);
  });
});

describe("deployedSha", () => {
  it("passes a commit id and nothing else", () => {
    expect(deployedSha(` ${SHA.toUpperCase()} `)).toBe(SHA);
    expect(deployedSha("abc1234")).toBe("abc1234");
    expect(deployedSha(undefined)).toBeNull();
    expect(deployedSha("")).toBeNull();
    expect(deployedSha("v1.2.3")).toBeNull();
    expect(deployedSha("main; drop")).toBeNull();
  });
});
