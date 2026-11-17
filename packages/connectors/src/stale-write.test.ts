// Audit 3.8: a write is refused, before anything is sent, when the record's version marker (a
// sync token, revision, updated or modified time, etag) moved since the change was proposed,
// whatever the connector itself checks. Shown with the testkit, which checks only a token the
// agent supplies.

import { DEFAULT_PERMISSIONS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { NotWrittenError, type WriteContext } from "./connector";
import { memoryCredentials } from "./credentials-accessor";
import { captureBefore, executeWrite, recordChangedSince } from "./invoke";
import { memoryLogger } from "./logger";
import { createTestkitConnector, TESTKIT_UPDATE_TOOL, TestkitBackend } from "./testkit";

const tenant = "0190f0c8-0000-7000-8000-000000000001";

function setup() {
  const backend = new TestkitBackend().seed("conn-a", [
    { id: "r1", name: "Plywood order", amount: "120.0000" },
  ]);
  const connector = createTestkitConnector(backend);
  const ctx = (key: string, proposedBefore?: unknown): WriteContext => ({
    tenantId: tenant,
    connection: {
      id: "conn-a",
      tenantId: tenant,
      connector: "testkit",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials(),
    logger: memoryLogger(),
    now: () => new Date("2026-11-03T12:00:00Z"),
    idempotencyKey: key,
    ...(proposedBefore === undefined ? {} : { proposedBefore }),
  });
  return { backend, connector, ctx };
}

describe("the platform's stale-write check", () => {
  const input = { id: "r1", amount: "130.0000" };

  it("refuses a write whose record changed since it was proposed, and sends nothing", async () => {
    const { backend, connector, ctx } = setup();
    const proposed = await captureBefore(connector, TESTKIT_UPDATE_TOOL, input, ctx("k0"));
    // Someone else changes the record while the change waits for approval.
    backend.update("conn-a", "someone-else", { id: "r1", name: "Plywood order (2)" });
    const err = await executeWrite(
      connector,
      TESTKIT_UPDATE_TOOL,
      input,
      ctx("k1", proposed.before),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotWrittenError);
    expect((err as Error).message).toMatch(/changed since this change was proposed/);
    expect(backend.writes.map((w) => w.idempotencyKey)).toEqual(["someone-else"]);
  });

  it("writes when the record is as proposed, or when no proposal is given", async () => {
    const { backend, connector, ctx } = setup();
    const proposed = await captureBefore(connector, TESTKIT_UPDATE_TOOL, input, ctx("k0"));
    await executeWrite(connector, TESTKIT_UPDATE_TOOL, input, ctx("k1", proposed.before));
    await executeWrite(connector, TESTKIT_UPDATE_TOOL, { ...input, amount: "1.0000" }, ctx("k2"));
    expect(backend.writes.map((w) => w.idempotencyKey)).toEqual(["k1", "k2"]);
  });

  it("leaves a taken-over try to the connector, as its earlier try may have written", async () => {
    const { backend, connector, ctx } = setup();
    const proposed = await captureBefore(connector, TESTKIT_UPDATE_TOOL, input, ctx("k0"));
    await executeWrite(connector, TESTKIT_UPDATE_TOOL, input, ctx("k1", proposed.before));
    // The same action again under its key: the testkit answers with what it wrote.
    const again = await executeWrite(
      connector,
      TESTKIT_UPDATE_TOOL,
      input,
      ctx("k1", proposed.before),
      { recheck: false },
    );
    expect(again.output).toMatchObject({ record: { amount: "130.0000" } });
    expect(backend.writes).toHaveLength(1);
  });

  it("reads the version markers it knows, on the same record only", () => {
    for (const marker of [
      "syncToken",
      "revision",
      "updatedAt",
      "updatedTime",
      "modifiedTime",
      "etag",
    ]) {
      expect(recordChangedSince({ id: "1", [marker]: "a" }, { id: "1", [marker]: "b" })).toBe(
        marker,
      );
      expect(recordChangedSince({ id: "1", [marker]: "a" }, { id: "1", [marker]: "a" })).toBeNull();
    }
    expect(recordChangedSince({ itemId: 5, revision: 3 }, { itemId: 5, revision: 4 })).toBe(
      "revision",
    );
    // A marker the input carries is the tool's to check (QuickBooks' syncToken, HubSpot's
    // expectedUpdatedAt).
    expect(
      recordChangedSince({ syncToken: "1" }, { syncToken: "2" }, { syncToken: "1" }),
    ).toBeNull();
    expect(
      recordChangedSince({ updatedAt: "a" }, { updatedAt: "b" }, { expectedUpdatedAt: "a" }),
    ).toBeNull();
    expect(recordChangedSince({ updatedAt: "a" }, { updatedAt: "b" }, { id: "1" })).toBe(
      "updatedAt",
    );
    // Not comparable: no marker, a marker gone, another record, nothing proposed.
    expect(recordChangedSince({ values: [["a"]] }, { values: [["b"]] })).toBeNull();
    expect(recordChangedSince({ updatedAt: "a" }, { updatedAt: null })).toBeNull();
    expect(recordChangedSince({ id: "1", updatedAt: "a" }, { id: "2", updatedAt: "b" })).toBeNull();
    expect(recordChangedSince(undefined, { updatedAt: "b" })).toBeNull();
    expect(recordChangedSince(null, { updatedAt: "b" })).toBeNull();
  });
});
