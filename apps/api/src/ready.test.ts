import type { Db } from "@countersign/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness } from "./api.test-helper";
import { createApp } from "./app";
import type { Bindings } from "./env";
import { defaultDeps } from "./http";
import { reportHandled, reportProblem } from "./observability/report";
import {
  databaseAnswers,
  deployedSha,
  mayReport,
  READY_REPORT_EVERY_MS,
  resetReadyReports,
} from "./ready";

vi.mock("./observability/report", async (load) => ({
  ...(await load<typeof import("./observability/report")>()),
  reportHandled: vi.fn(),
  reportProblem: vi.fn(),
}));

beforeEach(() => {
  resetReadyReports();
  vi.mocked(reportHandled).mockClear();
  vi.mocked(reportProblem).mockClear();
});

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

  it("reports a failing check to error tracking at most once a minute", async () => {
    const app = appWith({
      execute: (async () => {
        throw new Error("connection refused");
      }) as unknown as Db["execute"],
    });
    for (let i = 0; i < 3; i++) {
      expect((await app.request("/api/ready", {}, env)).status).toBe(503);
    }
    expect(reportHandled).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when there is no database binding at all", async () => {
    const app = createApp(defaultDeps);
    const res = await app.request("/api/ready", {}, {} as Bindings);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "unavailable", sha: null });
  });
});

describe("databaseAnswers", () => {
  it("asks a query Hyperdrive never caches", async () => {
    let text = "";
    const db = {
      execute: async (q: SQL) => {
        text = new PgDialect().sqlToQuery(q).sql;
        return [];
      },
    } as unknown as Db;
    expect(await databaseAnswers(db, 1_000)).toBe(true);
    expect(text).toBe("select now()");
  });

  it("gives up after the timeout and ends the client at once", async () => {
    const end = vi.fn(async () => {});
    const hangs = { execute: () => new Promise(() => {}), $client: { end } } as unknown as Db;
    expect(await databaseAnswers(hangs, 20)).toBe(false);
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
    expect(reportProblem).toHaveBeenCalledTimes(1);
  });
});

describe("mayReport", () => {
  it("allows one report a minute", () => {
    expect(mayReport(1_000)).toBe(true);
    expect(mayReport(1_000 + READY_REPORT_EVERY_MS - 1)).toBe(false);
    expect(mayReport(1_000 + READY_REPORT_EVERY_MS)).toBe(true);
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
