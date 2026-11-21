// Migration 0072 (docs/plan.md §1.164 "The Sales area, first tables"): the Sales pack's
// `crm_record_key`, `crm_match` and `crm_alias`. It applies on a database the previous Worker used
// (new tables only), each table forces row-level security as the pack's, the Worker's role reads
// and writes only its own client's rows, never deletes one, and never changes a decision once made.
// The pack's tables aren't in this package's schema (the platform never imports a pack), so this
// test speaks SQL.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "./client";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

const TABLES = ["crm_record_key", "crm_match", "crm_alias"] as const;
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

/** A vector of 1,024 numbers, as SQL reads it. */
const vector = (first: number) => `[${[first, ...Array(1023).fill(0)].join(",")}]`;

describe.skipIf(!online)("0072 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  /** As the Worker, in one client's session. */
  const asClient = <T>(c: ClientFixture, work: (tx: Tx) => Promise<T>) =>
    withTenant(t.db, c.tenantId, async (tx) => {
      await asWorker(tx);
      return work(tx);
    });

  const insertKey = (
    tx: Tx,
    c: ClientFixture,
    over: { externalId?: string; tenantId?: string; connectionId?: string; phone?: string } = {},
  ) =>
    tx.execute<{ id: string }>(
      `insert into crm_record_key (tenant_id, connection_id, connector, module, external_id,
         raw_record_id, email, phone, domain, company_name, person_name, match_text, match_hash)
       values ('${over.tenantId ?? c.tenantId}', '${over.connectionId ?? c.connectionId}',
         'zoho_crm', 'Leads', '${over.externalId ?? "5725767000000411001"}', '${c.rawRecordId}',
         'jane@acme.example', '${over.phone ?? "+15125550177"}', 'acme.example', 'acme',
         'jane doe', 'jane doe | acme', '${H1}')
       returning id`,
    );

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0071_operator_audit_rows" });
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds the three tables with forced row-level security, as the Sales pack's", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; owner: string; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        obj_description(c.oid, 'pg_class') as owner,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c where c.relname in ('crm_record_key', 'crm_match', 'crm_alias')
      order by c.relname`;
    expect(rows).toEqual(
      [...TABLES].sort().map((relname) => ({
        relname,
        rls: true,
        forced: true,
        owner: "pack:sales",
        policies: 1,
      })),
    );
  });

  it("lets the runtime read and write keys and aliases, only add decisions, and delete nothing", async () => {
    const can = async (table: string, privilege: string) =>
      (
        await t.db.$client<{ ok: boolean }[]>`
          select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
      )[0]?.ok;
    for (const table of ["crm_record_key", "crm_alias"]) {
      expect(await can(table, "SELECT"), table).toBe(true);
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "UPDATE"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
    }
    expect(await can("crm_match", "INSERT")).toBe(true);
    expect(await can("crm_match", "UPDATE")).toBe(false);
    expect(await can("crm_match", "DELETE")).toBe(false);
  });

  it("has the trigram index on the match text and searches by it", async () => {
    const [index] = await t.db.$client<{ def: string }[]>`
      select indexdef as def from pg_indexes where indexname = 'crm_record_key_match_text_trgm_idx'`;
    expect(index?.def).toContain("gin_trgm_ops");
    const found = await asClient(A, async (tx) => {
      await insertKey(tx, A);
      return tx.execute<{ external_id: string; sim: number }>(
        `select external_id, similarity(match_text, 'jane do | acme corp') as sim
         from crm_record_key where match_text % 'jane do | acme corp'`,
      );
    });
    expect([...found].map((r) => r.external_id)).toEqual(["5725767000000411001"]);
  });

  it("shows a client only its own keys, refuses writing another's and deleting any", async () => {
    await asClient(B, (tx) => insertKey(tx, B, { externalId: "5725767000000999001" }));
    const seen = await asClient(A, (tx) =>
      tx.execute<{ tenant_id: string }>("select tenant_id::text from crm_record_key"),
    );
    expect(new Set([...seen].map((r) => r.tenant_id))).toEqual(new Set([A.tenantId]));
    expect(
      await errorCode(
        asClient(A, (tx) =>
          insertKey(tx, B, { externalId: "1", tenantId: B.tenantId, connectionId: B.connectionId }),
        ),
      ),
    ).toBe("42501");
    expect(await errorCode(asClient(A, (tx) => tx.execute("delete from crm_record_key")))).toBe(
      "42501",
    );
    // Another client's rows aren't there to change: an update touches none of them.
    const updated = await asClient(A, (tx) =>
      tx.execute(
        "update crm_record_key set match_text = 'x' where external_id = '5725767000000999001'",
      ),
    );
    expect(updated.count).toBe(0);
  });

  it("keeps a key pointing at its own client's connection and raw record", async () => {
    // Written past RLS (as the superuser): only the composite keys stand in the way.
    expect(
      await errorCode(
        t.db.$client.unsafe(
          `insert into crm_record_key (tenant_id, connection_id, connector, module, external_id,
             raw_record_id, match_text, match_hash)
           values ('${A.tenantId}', '${B.connectionId}', 'zoho_crm', 'Leads', '7', '${A.rawRecordId}',
             'x', '${H1}')`,
        ),
      ),
    ).toBe("23503");
    expect(
      await errorCode(
        t.db.$client.unsafe(
          `insert into crm_record_key (tenant_id, connection_id, connector, module, external_id,
             raw_record_id, match_text, match_hash)
           values ('${A.tenantId}', '${A.connectionId}', 'zoho_crm', 'Leads', '8', '${B.rawRecordId}',
             'x', '${H1}')`,
        ),
      ),
    ).toBe("23503");
  });

  it("keeps one key per record, phones in E.164 and an embedding with what it was made from", async () => {
    expect(await errorCode(asClient(A, (tx) => insertKey(tx, A)))).toBe("23505");
    expect(
      await errorCode(asClient(A, (tx) => insertKey(tx, A, { externalId: "9", phone: "512-555" }))),
    ).toBe("23514");
    const set = (sql: string) =>
      errorCode(
        asClient(A, (tx) =>
          tx.execute(`update crm_record_key set ${sql} where external_id = '5725767000000411001'`),
        ),
      );
    // An embedding needs the hash of its text and its model.
    expect(await set(`embedding = '${vector(1)}'`)).toBe("23514");
    expect(
      await set(
        `embedding = '${vector(1)}', embedded_hash = '${H1}', embedding_model = 'openai:text-embedding-3-large'`,
      ),
    ).toBeUndefined();
    // Re-embedded when its match text changes: a new text, a new hash.
    expect(await set(`match_text = 'jane doe | acme inc', match_hash = '${H2}'`)).toBeUndefined();
    const [row] = await t.db.$client<{ due: boolean }[]>`
      select embedded_hash <> match_hash as due from crm_record_key
      where external_id = '5725767000000411001'`;
    expect(row?.due).toBe(true);
  });

  describe("decisions and aliases", () => {
    let keyId = "";
    const batch = "0193a6c2-0000-7000-8000-000000000001";

    beforeAll(async () => {
      const [k] = await t.db.$client<{ id: string }[]>`
        select id from crm_record_key where tenant_id = ${A.tenantId}
          and external_id = '5725767000000411001'`;
      keyId = k?.id ?? "";
    });

    const decide = (
      tx: Tx,
      values: {
        decision: string;
        method: string;
        record?: boolean;
        agent?: boolean;
        user?: boolean;
        row?: number;
      },
    ) =>
      tx.execute<{ id: string }>(
        `insert into crm_match (tenant_id, batch_id, run_id, step, row_index, keys, decision, method,
           record_key_id, connection_id, module, external_id, score, sources, agent_version_id,
           decided_by_user_id)
         values ('${A.tenantId}', '${batch}', '${A.runId}', 'match', ${values.row ?? 0},
           '{"email": "jane@acme.example"}', '${values.decision}', '${values.method}',
           ${values.record ? `'${keyId}', '${A.connectionId}', 'Leads', '5725767000000411001'` : "null, null, null, null"},
           0.95, '["${A.rawRecordId}"]',
           ${values.agent ? `'${A.agentVersionId}'` : "null"},
           ${values.user ? `'${A.userId}'` : "null"})
         returning id`,
      );

    it("records the agent's decision, then a person's after it, and never changes either", async () => {
      const first = await asClient(A, (tx) =>
        decide(tx, { decision: "unsure", method: "model", agent: true }),
      );
      const second = await asClient(A, (tx) =>
        decide(tx, { decision: "matched", method: "human", record: true, user: true }),
      );
      expect([...first][0]?.id).toBeTruthy();
      expect([...second][0]?.id).toBeTruthy();
      expect(
        await errorCode(asClient(A, (tx) => tx.execute("update crm_match set score = 1"))),
      ).toBe("42501");
      // Not even the owner changes or deletes one: the history trigger refuses.
      expect(await errorCode(t.db.$client`update crm_match set score = 1`)).toBe("23001");
      expect(await errorCode(t.db.$client`delete from crm_match`)).toBe("23001");
    });

    it("holds a decision to its shape: a match names its record, a person's names the person", async () => {
      // matched without a record; unsure with one
      expect(
        await errorCode(
          asClient(A, (tx) => decide(tx, { decision: "matched", method: "key", agent: true })),
        ),
      ).toBe("23514");
      expect(
        await errorCode(
          asClient(A, (tx) =>
            decide(tx, { decision: "unsure", method: "text", record: true, agent: true }),
          ),
        ),
      ).toBe("23514");
      // a person's decision without the person; an agent's with both
      expect(
        await errorCode(
          asClient(A, (tx) => decide(tx, { decision: "none", method: "human", agent: true })),
        ),
      ).toBe("23514");
      expect(
        await errorCode(
          asClient(A, (tx) =>
            decide(tx, { decision: "none", method: "model", agent: true, user: true }),
          ),
        ),
      ).toBe("23514");
      expect(
        await errorCode(
          asClient(A, (tx) => decide(tx, { decision: "maybe", method: "model", agent: true })),
        ),
      ).toBe("23514");
    });

    it("keeps one alias per values in a module, replaced by a later answer, and never another client's", async () => {
      const [match] = await t.db.$client<{ id: string }[]>`
        select id from crm_match where tenant_id = ${A.tenantId} and method = 'human' limit 1`;
      const alias = (tx: Tx, tenantId = A.tenantId) =>
        tx.execute(
          `insert into crm_alias (tenant_id, connection_id, module, key_hash, keys, record_key_id,
             external_id, match_id, created_by_user_id)
           values ('${tenantId}', '${A.connectionId}', 'Leads', '${H1}',
             '{"email": "jane@acme.example"}', '${keyId}', '5725767000000411001', '${match?.id}',
             '${A.userId}')
           on conflict (tenant_id, connection_id, module, key_hash)
           do update set updated_at = now()`,
        );
      expect(await errorCode(asClient(A, (tx) => alias(tx)))).toBeUndefined();
      expect(await errorCode(asClient(A, (tx) => alias(tx)))).toBeUndefined();
      const [n] = await t.db.$client<{ n: number }[]>`
        select count(*)::int as n from crm_alias where tenant_id = ${A.tenantId}`;
      expect(n?.n).toBe(1);
      expect(await errorCode(asClient(A, (tx) => alias(tx, B.tenantId)))).toBe("42501");
      expect(await errorCode(asClient(A, (tx) => tx.execute("delete from crm_alias")))).toBe(
        "42501",
      );
      const seenByB = await asClient(B, (tx) =>
        tx.execute<{ n: number }>("select count(*)::int as n from crm_alias"),
      );
      expect([...seenByB][0]?.n).toBe(0);
    });
  });
});
