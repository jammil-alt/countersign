// A throwaway database whose client acts as cs_worker (RLS and grants as in the Worker), two
// clients with their upload connections, an in-memory object store, and a model client that
// replays fixtures/llm (LLM_MODE=record re-records them with ANTHROPIC_API_KEY).

import { ContentStore, ensureUploadConnection, MemoryObjectStore } from "@countersign/connectors";
import { createDb, type Db, type Tx, tenant, withTenant } from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import {
  anthropicTransport,
  createLlmClient,
  type LlmClient,
  type LlmTransport,
  parseLlmMode,
  withRecording,
} from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import type { DocumentsDeps } from "./extract";

export interface Client {
  tenantId: string;
  uploadConnectionId: string;
}

export interface Harness {
  t: TestDatabase;
  db: Db;
  objects: MemoryObjectStore;
  content: ContentStore;
  A: Client;
  B: Client;
  deps(llm?: LlmClient): DocumentsDeps;
  as<T>(c: Client, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function workerUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
}

/** The golden model client: replay (tests never call the live model), or record with a key. */
export function goldenLlm(): LlmClient {
  const mode = parseLlmMode(process.env.LLM_MODE, "replay") === "record" ? "record" : "replay";
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const live: LlmTransport | null = key ? anthropicTransport({ apiKey: key }) : null;
  return createLlmClient({ transport: withRecording(live, { mode, store: fileFixtureStore() }) });
}

export async function createHarness(): Promise<Harness | null> {
  const t = await createTestDatabase();
  if (!t) return null;
  const db = createDb(workerUrl(t.url), { max: 4 });
  const client = async (name: string): Promise<Client> => {
    const [row] = await t.db.insert(tenant).values({ name }).returning();
    if (!row) throw new Error("no tenant");
    const conn = await withTenant(db, row.id, (tx) => ensureUploadConnection(tx, row.id));
    return { tenantId: row.id, uploadConnectionId: conn.id };
  };
  const A = await client("Hollis Millwork");
  const B = await client("Other shop");
  const objects = new MemoryObjectStore();
  const content = new ContentStore(objects);
  return {
    t,
    db,
    objects,
    content,
    A,
    B,
    deps: (llm) => ({ db, content, llm: llm ?? goldenLlm() }),
    as: (c, fn) => withTenant(db, c.tenantId, fn),
    async close() {
      await db.$client.end();
      await t.drop();
    },
  };
}
