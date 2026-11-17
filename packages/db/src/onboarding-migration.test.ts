// Onboarding v1 (migration 0066, docs/plan.md §1.125) as the Worker's role sees it. A client file,
// its facts and the saved starts are the operator's: a client's session reads none of them, and an
// operator sees only files about the clients it serves or about none (prospects), and a fact only
// with its file. A client's intake, its people, answers, scope and log are its own: forced RLS, and
// one client's session never reads another's. Facts, answers and the log are insert only; a scope
// version takes only its signature; nothing is deleted.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  CLIENT_FILE_TABLES,
  clientFact,
  clientFile,
  deal,
  INTAKE_TABLES,
  intake,
  intakeAnswer,
  intakeScope,
  salesStart,
} from "./schema";
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

// The value lists are checked against core's word for word with the code that names them
// (the onboarding code's own PR adds that test here).

describe.skipIf(!online)("the onboarding tables", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let C: ClientFixture;
  const fileOf: Record<string, string> = {};

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    // Each client gets an intake with a person, an answer, a scope and an event (the fixture).
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    C = await insertClient(t.db, "C");
    // A file (with a fact) about A, about B, and about no client (a prospect); and one start.
    for (const [key, clientId] of [
      ["A", A.tenantId],
      ["B", B.tenantId],
      ["lead", null],
    ] as const) {
      const [f] = await t.db
        .insert(clientFile)
        .values({ name: `Company ${key}`, clientId, status: clientId ? "client" : "prospect" })
        .returning({ id: clientFile.id });
      fileOf[key] = f?.id ?? "";
      await t.db.insert(clientFact).values({
        fileId: f?.id ?? "",
        section: "volumes",
        text: "About 340 bills a month",
        sourceKind: "call",
        actor: "operator",
      });
    }
    await t.db.insert(salesStart).values({
      name: "Purchasing starter",
      covers: { general: true, areas: ["purchasing"], templateIds: [] },
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  type Tx = Parameters<Parameters<typeof withOperator>[2]>[0];
  const count = async (tx: Tx, table: string) =>
    Number(
      [...(await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))][0]
        ?.n ?? 0,
    );

  const can = async (table: string, privilege: string) =>
    (
      await t.db.$client<{ ok: boolean }[]>`
        select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
    )[0]?.ok;

  it("force row-level security with one policy on every table", async () => {
    const all = [...CLIENT_FILE_TABLES, "sales_start", ...INTAKE_TABLES];
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client(all)}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...all].sort());
    for (const r of rows) {
      expect(r.rls && r.forced, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(1);
    }
  });

  it("show a client's session no file, fact or start, and let it write none", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of [...CLIENT_FILE_TABLES, "sales_start"]) {
        expect(await count(tx, table), table).toBe(0);
      }
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(clientFile).values({ name: "x", clientId: A.tenantId });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(clientFact).values({
            fileId: fileOf.A ?? "",
            section: "notes",
            text: "x",
            sourceKind: "note",
            actor: "client",
          });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx
            .insert(salesStart)
            .values({ name: "x", covers: { general: true, areas: [], templateIds: [] } });
        }),
      ),
    ).toBe("42501");
  });

  it("show an operator only files about the clients it serves, or about none", async () => {
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      // A's and the prospect's; not B's.
      for (const table of CLIENT_FILE_TABLES) expect(await count(tx, table), table).toBe(2);
      expect(await count(tx, "sales_start")).toBe(1);
      const facts = await tx.select({ fileId: clientFact.fileId }).from(clientFact);
      expect(facts.map((f) => f.fileId)).not.toContain(fileOf.B);
    });
    await withOperator(t.db, [A.tenantId, B.tenantId, C.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of CLIENT_FILE_TABLES) expect(await count(tx, table), table).toBe(3);
    });
  });

  it("refuse an operator a file or fact about a client it doesn't serve", async () => {
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.insert(clientFile).values({ name: "x", clientId: C.tenantId });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.insert(clientFact).values({
            fileId: fileOf.B ?? "",
            section: "notes",
            text: "x",
            sourceKind: "note",
            actor: "operator",
          });
        }),
      ),
    ).toBe("42501");
    // Moving a prospect's file onto an unserved client is refused too (WITH CHECK).
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx
            .update(clientFile)
            .set({ clientId: C.tenantId })
            .where(eq(clientFile.id, fileOf.lead ?? ""));
        }),
      ),
    ).toBe("42501");
  });

  it("show a client's session its own intake rows, never another client's", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of INTAKE_TABLES) {
        const rows = [
          ...(await tx.execute<{ t: string }>(
            sql.raw(`select tenant_id::text as t from ${table}`),
          )),
        ];
        expect(rows.length, table).toBe(1);
        expect(rows[0]?.t, table).toBe(A.tenantId);
      }
      // Asking for B's intake by its id finds nothing.
      const [bIntake] = await t.db
        .select({ id: intake.id })
        .from(intake)
        .where(eq(intake.tenantId, B.tenantId));
      const seen = [
        ...(await tx.execute(sql`select 1 from intake where id = ${bIntake?.id ?? ""}`)),
      ];
      expect(seen).toHaveLength(0);
    });
    // And refuses writing one for another client.
    const [bIntake] = await t.db
      .select({ id: intake.id })
      .from(intake)
      .where(eq(intake.tenantId, B.tenantId));
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(intakeAnswer).values({
            tenantId: B.tenantId,
            intakeId: bIntake?.id ?? "",
            fieldKey: "general.approver",
            value: "Mallory",
            state: "answered",
            source: "form",
          });
        }),
      ),
    ).toBe("42501");
    // An answer can't point at another client's intake under its own client either (the key).
    expect(
      await errorCode(
        t.db.insert(intakeAnswer).values({
          tenantId: A.tenantId,
          intakeId: bIntake?.id ?? "",
          fieldKey: "general.approver",
          value: "Mallory",
          state: "answered",
          source: "form",
        }),
      ),
    ).toBe("23503");
  });

  it("keep facts, answers and the log as written, take only a scope's signature, delete nothing", async () => {
    for (const table of ["client_fact", "intake_answer", "intake_scope", "intake_event"]) {
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "UPDATE"), table).toBe(false);
    }
    for (const table of ["client_file", "sales_start", "intake", "intake_person"]) {
      expect(await can(table, "UPDATE"), table).toBe(true);
    }
    for (const table of [...CLIENT_FILE_TABLES, "sales_start", ...INTAKE_TABLES]) {
      expect(await can(table, "SELECT"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
      expect(await can(table, "TRUNCATE"), table).toBe(false);
    }
    // The signature, never the body.
    const [scope] = await t.db
      .select({ id: intakeScope.id })
      .from(intakeScope)
      .where(eq(intakeScope.tenantId, A.tenantId));
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .update(intakeScope)
        .set({ signedBy: A.userId, signedAt: new Date() })
        .where(eq(intakeScope.id, scope?.id ?? ""));
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx
            .update(intakeScope)
            .set({ body: { agents: ["changed"] } })
            .where(eq(intakeScope.id, scope?.id ?? ""));
        }),
      ),
    ).toBe("42501");
  });

  it("replace a fact at most once, keep values in their lists, and widen two checks", async () => {
    const [first] = await t.db
      .select({ id: clientFact.id })
      .from(clientFact)
      .where(eq(clientFact.fileId, fileOf.lead ?? ""));
    const correction = {
      fileId: fileOf.lead ?? "",
      section: "volumes" as const,
      text: "About 360 bills a month",
      sourceKind: "intake" as const,
      sureness: "confirmed" as const,
      audience: "theirs" as const,
      actor: "client" as const,
      replacesId: first?.id ?? "",
    };
    await t.db.insert(clientFact).values(correction);
    expect(await errorCode(t.db.insert(clientFact).values(correction))).toBe("23505");
    expect(
      await errorCode(
        t.db.insert(clientFact).values({ ...correction, replacesId: undefined, text: "" }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.$client`
          insert into client_fact (file_id, section, text, source_kind, actor, audience)
          values (${fileOf.lead ?? ""}, 'notes', 'x', 'note', 'operator', 'everyone')`,
      ),
    ).toBe("23514");
    // A not-sure answer has no value; an answer has one.
    const [aIntake] = await t.db
      .select({ id: intake.id })
      .from(intake)
      .where(eq(intake.tenantId, A.tenantId));
    await t.db.insert(intakeAnswer).values({
      tenantId: A.tenantId,
      intakeId: aIntake?.id ?? "",
      fieldKey: "general.volume",
      state: "not_sure",
      source: "form",
    });
    expect(
      await errorCode(
        t.db.insert(intakeAnswer).values({
          tenantId: A.tenantId,
          intakeId: aIntake?.id ?? "",
          fieldKey: "general.volume",
          state: "answered",
          source: "form",
        }),
      ),
    ).toBe("23514");
    // A seeded start carries its seed key, once.
    await t.db.insert(salesStart).values({
      name: "General only",
      covers: { general: true, areas: [], templateIds: [] },
      seeded: true,
      seedKey: "general",
    });
    expect(
      await errorCode(
        t.db.insert(salesStart).values({
          name: "General only",
          covers: { general: true, areas: [], templateIds: [] },
          seeded: true,
          seedKey: "general",
        }),
      ),
    ).toBe("23505");
    expect(
      await errorCode(
        t.db.insert(salesStart).values({
          name: "x",
          covers: { general: true, areas: [], templateIds: [] },
          seeded: true,
        }),
      ),
    ).toBe("23514");
    // knowledge_entry takes `about`; notification takes the onboarding emails' kinds.
    await t.db.$client`
      insert into knowledge_entry (tenant_id, kind) values (${A.tenantId}, 'about')`;
    await t.db.$client`
      insert into notification (tenant_id, user_id, channel, kind, dedupe_key, link)
      values (${A.tenantId}, ${A.userId}, 'email', 'intake_invite', 'intake_invite:p1', '/start/x')`;
  });

  it("point a deal at its file, and let the file go without the deal", async () => {
    const [d] = await t.db
      .insert(deal)
      .values({
        kind: "new",
        company: "Company lead",
        title: "Invoice review",
        stage: "lead",
        clientFileId: fileOf.lead ?? "",
      })
      .returning({ id: deal.id });
    // Only the owner deletes (a purge); the deal stays and forgets the file.
    await t.db.delete(clientFact).where(eq(clientFact.fileId, fileOf.lead ?? ""));
    await t.db.delete(clientFile).where(eq(clientFile.id, fileOf.lead ?? ""));
    const [after] = await t.db
      .select({ fileId: deal.clientFileId })
      .from(deal)
      .where(eq(deal.id, d?.id ?? ""));
    expect(after?.fileId).toBeNull();
  });
});
