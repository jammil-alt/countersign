// Browser sites (docs/plan.md §1.26, phase 3) at the database: the catalogue is the operator's, so
// only operator sessions read or write it (client sessions, runs and no-scope transactions see
// nothing), site versions are immutable and never deleted, and tiers and slugs are checked.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOperatorCatalogue, type Tx, withOperator, withTenant, withTenants } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { browserSite, browserSiteVersion, OPERATOR_ONLY_TABLES } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const INSUFFICIENT_PRIVILEGE = "42501";
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

const PROFILE = { login: { url: "https://portal.example.com/login" }, allow: ["*"] };

describe.skipIf(!online)("browser_site and browser_site_version", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let siteId: string;
  let versionId: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    // Written as the Worker in an operator session, as the back office does.
    ({ siteId, versionId } = await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      const [site] = await tx
        .insert(browserSite)
        .values({ slug: "acme-supply", name: "Acme Supply", tier: "low", notes: "Terms: J.M." })
        .returning();
      const [version] = await tx
        .insert(browserSiteVersion)
        .values({ siteId: site?.id as string, version: 1, profile: PROFILE })
        .returning();
      return { siteId: site?.id as string, versionId: version?.id as string };
    }));
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = (tx: Tx, table: string) =>
    tx
      .execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))
      .then((r) => [...r][0]?.n);

  it("an operator session reads and changes the catalogue", async () => {
    await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      for (const table of OPERATOR_ONLY_TABLES) expect(await count(tx, table), table).toBe(1);
      await tx.update(browserSite).set({ tier: "medium" }).where(eq(browserSite.id, siteId));
    });
  });

  it("a client session, a run's scope and a scope with no clients see nothing and write nothing", async () => {
    const scopes = [
      (fn: (tx: Tx) => Promise<void>) => withTenant(t.db, A.tenantId, fn),
      (fn: (tx: Tx) => Promise<void>) => withTenants(t.db, [A.tenantId], fn),
      (fn: (tx: Tx) => Promise<void>) => t.db.transaction(fn),
    ];
    for (const scope of scopes) {
      await scope(async (x) => {
        await asWorker(x);
        for (const table of OPERATOR_ONLY_TABLES) expect(await count(x, table), table).toBe(0);
        const updated = await x
          .update(browserSite)
          .set({ tier: "low" })
          .where(eq(browserSite.id, siteId))
          .returning();
        expect(updated).toEqual([]);
      });
    }
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(browserSite).values({ slug: "sneaky", name: "Sneaky", tier: "low" });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(browserSiteVersion).values({ siteId, version: 2, profile: PROFILE });
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("site versions are immutable and never deleted, for the Worker and the owner alike", async () => {
    expect(
      await errorCode(
        withOperator(t.db, [], async (tx) => {
          await asWorker(tx);
          await tx
            .update(browserSiteVersion)
            .set({ changeNote: "edited" })
            .where(eq(browserSiteVersion.id, versionId));
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        t.db
          .update(browserSiteVersion)
          .set({ profile: { changed: true } })
          .where(eq(browserSiteVersion.id, versionId)),
      ),
    ).toBe(RESTRICT_VIOLATION);
    expect(
      await errorCode(t.db.delete(browserSiteVersion).where(eq(browserSiteVersion.id, versionId))),
    ).toBe(RESTRICT_VIOLATION);
  });

  it("checks tiers, slugs and version numbers; one version number per site", async () => {
    expect(
      await errorCode(
        t.db.insert(browserSite).values({ slug: "x", name: "X", tier: "unknown" as "low" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(
        t.db.insert(browserSite).values({ slug: "Not A Slug", name: "X", tier: "low" }),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(
        t.db.insert(browserSite).values({ slug: "acme-supply", name: "X", tier: "low" }),
      ),
    ).toBe("23505");
    expect(
      await errorCode(
        t.db.insert(browserSiteVersion).values({ siteId, version: 1, profile: PROFILE }),
      ),
    ).toBe("23505");
    expect(
      await errorCode(
        t.db.insert(browserSiteVersion).values({ siteId, version: 0, profile: PROFILE }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("readOperatorCatalogue: inside a client's transaction, the catalogue and no client rows, then back", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      expect(await count(tx, "browser_site")).toBe(0);
      const ownBefore = await count(tx, "connection");
      expect(ownBefore).toBeGreaterThan(0);
      const inside = await readOperatorCatalogue(tx, async (inner) => ({
        sites: await count(inner, "browser_site"),
        versions: await count(inner, "browser_site_version"),
        connections: await count(inner, "connection"),
      }));
      expect(inside).toEqual({ sites: 1, versions: 1, connections: 0 });
      // Back to the client's scope.
      expect(await count(tx, "browser_site")).toBe(0);
      expect(await count(tx, "connection")).toBe(ownBefore);
    });
    // Put back even when the read fails.
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await readOperatorCatalogue(tx, async () => {
        throw new Error("boom");
      }).catch(() => undefined);
      expect(await count(tx, "browser_site")).toBe(0);
    });
  });
});
