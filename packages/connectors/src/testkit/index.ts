import { DecimalString, type JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type RawRecordInput,
} from "../connector";

/**
 * "testkit": a connector over an in-memory system, for the runtime's, executor's and API's tests
 * (and the Sandbox client). One read tool and one external update tool with a before snapshot,
 * shaped like the real ones (QBO's SyncToken, stale-token refusal, idempotent writes).
 */
export const TESTKIT_CONNECTOR_ID = "testkit";
export const TESTKIT_QUERY_TOOL = "testkit.record.query";
export const TESTKIT_UPDATE_TOOL = "testkit.record.update";

export const TestkitRecord = z.object({
  id: z.string().min(1),
  name: z.string(),
  amount: DecimalString,
  /** Bumped on every write, like QBO's SyncToken. */
  syncToken: z.string(),
});
export type TestkitRecord = z.infer<typeof TestkitRecord>;

export class StaleRecordError extends Error {
  // Wave 5 review: the fake provider turned the write down; nothing was written (`writeNotMade`).
  readonly notWritten = true;
  constructor(readonly recordId: string) {
    super(`record ${recordId} changed since it was read`);
    this.name = "StaleRecordError";
  }
}

/** A record the fake provider can't find: it says no, and writes nothing (`writeNotMade`). */
function notFoundError(id: string): Error {
  return Object.assign(new Error(`record ${id} not found`), { notWritten: true });
}

/**
 * The fake external system: records per connection (each client's connection is its own
 * "company"), plus the writes it executed by idempotency key, so a retried write returns the
 * first result instead of writing twice.
 */
/**
 * The records every connection starts with in a deployed Sandbox (staging), so a workflow there
 * has something to find and change. Tests pass none and seed their own.
 */
export const TESTKIT_SAMPLE_RECORDS: readonly Omit<TestkitRecord, "syncToken">[] = [
  { id: "R-1001", name: "Baltic birch 3/4in 5x5", amount: "64.0000" },
  { id: "R-1002", name: "White oak 4/4 FAS", amount: "8.7500" },
  { id: "R-1003", name: "Euro hinge 110 degree", amount: "3.2000" },
];

export class TestkitBackend {
  private readonly records = new Map<string, Map<string, TestkitRecord>>();
  /** Copied into each connection's "company" the first time it is used. */
  private readonly samples: readonly Omit<TestkitRecord, "syncToken">[];

  constructor(options: { samples?: readonly Omit<TestkitRecord, "syncToken">[] } = {}) {
    this.samples = options.samples ?? [];
  }
  private readonly executed = new Map<string, { connectionId: string; result: TestkitRecord }>();
  /** Every write that changed a record, in order (for assertions). */
  readonly writes: { connectionId: string; idempotencyKey: string; record: TestkitRecord }[] = [];

  seed(connectionId: string, records: Omit<TestkitRecord, "syncToken">[]): this {
    const map = this.company(connectionId);
    for (const r of records) map.set(r.id, { ...r, syncToken: "0" });
    return this;
  }

  company(connectionId: string): Map<string, TestkitRecord> {
    let map = this.records.get(connectionId);
    if (!map) {
      map = new Map(this.samples.map((r) => [r.id, { ...r, syncToken: "0" }]));
      this.records.set(connectionId, map);
    }
    return map;
  }

  get(connectionId: string, id: string): TestkitRecord | null {
    const r = this.company(connectionId).get(id);
    return r ? { ...r } : null;
  }

  query(
    connectionId: string,
    filter: { ids?: string[] | undefined; nameContains?: string | undefined },
  ): TestkitRecord[] {
    const needle = filter.nameContains?.toLowerCase();
    return [...this.company(connectionId).values()]
      .filter((r) => !filter.ids || filter.ids.includes(r.id))
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  update(
    connectionId: string,
    idempotencyKey: string,
    change: {
      id: string;
      syncToken?: string | undefined;
      name?: string | undefined;
      amount?: string | undefined;
    },
  ): TestkitRecord {
    const done = this.executed.get(idempotencyKey);
    if (done) {
      if (done.connectionId !== connectionId) throw new Error("idempotency key reused elsewhere");
      return { ...done.result };
    }
    const current = this.company(connectionId).get(change.id);
    if (!current) throw notFoundError(change.id);
    if (change.syncToken !== undefined && change.syncToken !== current.syncToken) {
      throw new StaleRecordError(change.id);
    }
    const next: TestkitRecord = {
      ...current,
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.amount === undefined ? {} : { amount: change.amount }),
      syncToken: String(Number(current.syncToken) + 1),
    };
    this.company(connectionId).set(next.id, next);
    this.executed.set(idempotencyKey, { connectionId, result: next });
    this.writes.push({ connectionId, idempotencyKey, record: { ...next } });
    return { ...next };
  }
}

const QueryInput = z.object({
  ids: z.array(z.string().min(1)).optional(),
  nameContains: z.string().min(1).optional(),
});
const QueryOutput = z.object({ records: z.array(TestkitRecord) });

const UpdateInput = z
  .object({
    id: z.string().min(1),
    /** The token the agent read; a write against a changed record is refused. */
    syncToken: z.string().optional(),
    name: z.string().min(1).optional(),
    amount: DecimalString.optional(),
  })
  .refine((v) => v.name !== undefined || v.amount !== undefined, {
    message: "change at least one of name, amount",
  });
const UpdateOutput = z.object({ record: TestkitRecord });

/** The testkit connector over a backend (a fresh one per test keeps tests independent). */
export function createTestkitConnector(
  backend: TestkitBackend = new TestkitBackend(),
): Connector & {
  backend: TestkitBackend;
} {
  const connector = defineConnector({
    id: TESTKIT_CONNECTOR_ID,
    name: "Testkit",
    description: "An in-memory system for tests and the Sandbox client. Never a real client tool.",
    icon: "flask",
    auth: "none",
    // Never offered to a real client (core's `connectorShown`).
    testOnly: true,
    entities: ["Record"],
    // v0.12 W2-A: record types for the matrix (docs/plan.md §1.44).
    permissionEntities: [{ id: "record", label: "Records", verbs: ["read", "update"] }],
    tools: [
      defineReadTool({
        id: TESTKIT_QUERY_TOOL,
        entity: "record",
        description: "Find records by id or by part of their name.",
        summary: "Found {{records.length}} records",
        input: QueryInput,
        output: QueryOutput,
        async run(input, ctx) {
          return { records: backend.query(ctx.connection.id, input) };
        },
      }),
      defineWriteTool({
        id: TESTKIT_UPDATE_TOOL,
        entity: "record",
        description: "Change a record's name or amount.",
        verb: "update",
        // R5: the before state is written back with this tool, if the record hasn't changed since.
        undo: { kind: "restore" },
        summary: "Updated record {{record.id}}",
        // The testkit's company keeps US dollars.
        amount: { path: "amount", currency: "USD" },
        input: UpdateInput,
        output: UpdateOutput,
        beforeSchema: TestkitRecord,
        async before(input, ctx) {
          return backend.get(ctx.connection.id, input.id);
        },
        async run(input, ctx, before) {
          if (!before) throw notFoundError(input.id);
          ctx.logger.info("updating record", { recordId: input.id });
          return { record: backend.update(ctx.connection.id, ctx.idempotencyKey, input) };
        },
      }),
    ],
    async *sync(ctx) {
      for (const r of backend.query(ctx.connection.id, {})) {
        const record: RawRecordInput = {
          entityType: "Record",
          externalId: r.id,
          externalVersion: r.syncToken,
          payload: r as unknown as JsonObject,
        };
        yield record;
      }
    },
  });
  return Object.assign(connector, { backend });
}
