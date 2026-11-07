// Upload (with email forwarding) is a built-in source: nothing syncs and no agent binds it, so its
// connection card said "never synced" and "No agent uses it" while it started the Bill clerk. Its
// last activity is its last document, and the agents it serves are those whose live version starts
// on a document event.

import { AgentBundle } from "@countersign/core";
import { agent, agentVersion, connection, document } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { startsOnDocuments } from "./routes/built-in-sources";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

/** testBundle, started by an invoice that has been read instead of by hand. */
function documentBundle(): AgentBundle {
  const b = testBundle("Bill clerk");
  const wf = b.workflows[0];
  if (!wf) throw new Error("no workflow");
  return AgentBundle.parse({
    ...b,
    workflows: [
      {
        ...wf,
        workflow: {
          ...wf.workflow,
          trigger: { id: "trg-read", on: { type: "event", event: "document.extracted" } },
        },
      },
    ],
  });
}

describe("startsOnDocuments", () => {
  it("is a workflow started by a document event", () => {
    expect(startsOnDocuments(documentBundle())).toBe(true);
    expect(startsOnDocuments(testBundle())).toBe(false);
  });
});

describe.skipIf(!h)("built-in sources on the connections lists", () => {
  const H = h as ApiHarness;

  it("report their last document and the agents their documents start", async () => {
    const tenantId = H.A.tenantId;
    const [upload] = await H.t.db
      .insert(connection)
      .values({ tenantId, connector: "upload", status: "connected" })
      .returning();
    if (!upload) throw new Error("no upload connection");
    const [clerk] = await H.t.db
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug: "bill-clerk",
        name: "Bill clerk",
        runStatus: "active",
      })
      .returning();
    if (!clerk) throw new Error("no agent");
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: clerk.id,
        version: 1,
        bundle: documentBundle(),
        bundleHash: "1".repeat(64),
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await H.t.db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, clerk.id));

    // Before any document: no activity, but the clerk already uses it.
    const before = await H.call(OPERATOR, "GET", `/api/ops/clients/${tenantId}/connections`);
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    const empty = j(before.json).connections.find((c: { id: string }) => c.id === upload.id);
    expect(empty.lastActivityAt).toBeNull();
    expect(j(before.json).usedBy[upload.id]).toEqual([{ id: clerk.id, name: "Bill clerk" }]);

    const at = new Date("2026-11-05T12:41:00.000Z");
    await H.t.db.insert(document).values({
      tenantId,
      connectionId: upload.id,
      source: "upload",
      storageKey: `tenants/${tenantId}/documents/x`,
      mimeType: "application/pdf",
      filename: "northline-20418.pdf",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      receivedAt: at,
    });

    const ops = await H.call(OPERATOR, "GET", `/api/ops/clients/${tenantId}/connections`);
    const row = j(ops.json).connections.find((c: { id: string }) => c.id === upload.id);
    expect(row.lastActivityAt).toBe(at.toISOString());
    expect(row.lastSyncAt).toBeNull();
    // A connection that syncs keeps its sync time as its activity.
    const testkit = j(ops.json).connections.find((c: { id: string }) => c.id === H.A.connectionId);
    expect(testkit.lastActivityAt).toBe(testkit.lastSyncAt);
    expect(j(ops.json).usedBy[H.A.connectionId]).toEqual([]);

    // The portal's Accounts read the same.
    const portal = await H.call(admin("a"), "GET", "/api/connections");
    const mine = j(portal.json).connections.find(
      (c: { connector: string }) => c.connector === "upload",
    );
    expect(mine.connection.lastActivityAt).toBe(at.toISOString());
    expect(mine.connection.usedBy).toEqual([{ id: clerk.id, name: "Bill clerk" }]);
  });
});
