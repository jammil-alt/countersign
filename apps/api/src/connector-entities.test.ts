// v0.12 W2-A (docs/plan.md §1.44, M21) against a real database as cs_worker: per-entity
// permissions on the portal's and the back office's matrix routes (a client tightens per entity
// and never loosens; the old editor keeps entity levels), and the connectors catalog (status,
// errors, default access, who is waiting to connect), with the default access applied when a
// client's connection is first made.

import { createWebhookConnector } from "@countersign/connectors";
import { CONNECTOR_STATUS_VALUES } from "@countersign/core";
import { CONNECTOR_STATUSES, connection } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { deploymentConnectors } from "./platform";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness({ connectors: () => [createWebhookConnector()] });
afterAll(() => h?.close());

describe("the catalog's statuses", () => {
  it("are the database's", () => {
    expect([...CONNECTOR_STATUS_VALUES]).toEqual([...CONNECTOR_STATUSES]);
  });
});

describe.skipIf(!h)("per-entity permissions on the matrix routes", () => {
  const H = h as ApiHarness;
  const portal = () => `/api/connections/${H.A.connectionId}/permissions`;
  const ops = () => `/api/ops/connections/${H.A.connectionId}`;

  it("shows the connector's entities and each tool's entity on the portal", async () => {
    const res = await H.call(admin("a"), "GET", "/api/connections");
    expect(res.status).toBe(200);
    const testkit = j(res.json).connections.find(
      (c: { connector: string }) => c.connector === "testkit",
    );
    expect(testkit.permissionEntities).toEqual([
      { id: "record", label: "Records", verbs: ["read", "update"] },
    ]);
    expect(testkit.connection.access).toContainEqual(
      expect.objectContaining({ toolId: "testkit.record.update", entity: "record" }),
    );
    expect(forbiddenKeys(res.json)).toEqual([]);
  });

  it("lets the client admin tighten an entity, and keeps it when the old editor sends verbs", async () => {
    const tightened = await H.call(admin("a"), "PATCH", portal(), {
      entities: { record: { update: "off" } },
    });
    expect(tightened.status, JSON.stringify(tightened.json)).toBe(200);
    expect(j(tightened.json).connection.connection.permissions.entities).toEqual({
      record: { update: "off" },
    });
    expect(
      j(tightened.json).connection.connection.access.find(
        (a: { toolId: string }) => a.toolId === "testkit.record.update",
      ),
    ).toMatchObject({ level: "off", access: "not_allowed" });
    const verbs = await H.call(admin("a"), "PATCH", portal(), { create: "off" });
    expect(verbs.status).toBe(200);
    expect(j(verbs.json).connection.connection.permissions).toMatchObject({
      create: "off",
      entities: { record: { update: "off" } },
    });
  });

  it("refuses a client loosening an entity with 403 loosening", async () => {
    for (const entities of [{}, { record: { update: "approval" } }, { record: {} }]) {
      const res = await H.call(admin("a"), "PATCH", portal(), { entities });
      expect(res.status, JSON.stringify(entities)).toBe(403);
      expect(j(res.json).error.code).toBe("loosening");
    }
    // Client users don't edit at all.
    const asUser = await H.call(user("a"), "PATCH", portal(), {
      entities: { record: { update: "off", read: "off" } },
    });
    expect(asUser.status).toBe(403);
  });

  it("refuses entities the connector doesn't have, and keys an object has built in", async () => {
    const unknown = await H.call(admin("a"), "PATCH", portal(), {
      entities: { record: { update: "off" }, truck: { read: "off" } },
    });
    expect(unknown.status).toBe(422);
    expect(j(unknown.json).error.code).toBe("invalid_entities");
    const withKey = (key: string) =>
      H.call(
        admin("a"),
        "PATCH",
        portal(),
        JSON.parse(`{"entities": {"${key}": {"read": "off"}, "record": {"update": "off"}}}`),
      );
    for (const key of ["constructor", "prototype", "toString"]) {
      const res = await withKey(key);
      expect(res.status, key).toBeGreaterThanOrEqual(400);
      expect(res.status, key).toBeLessThan(500);
    }
    // `__proto__` never becomes a key: the body's validation leaves it out.
    expect((await withKey("__proto__")).status).toBe(200);
    const [row] = await H.t.db
      .select({ permissions: connection.permissions })
      .from(connection)
      .where(eq(connection.id, H.A.connectionId));
    expect(row?.permissions.entities).toEqual({ record: { update: "off" } });
    expect(Object.keys(row?.permissions.entities ?? {})).toEqual(["record"]);
  });

  it("lets the operator loosen an entity, never delete", async () => {
    const del = await H.call(OPERATOR, "PATCH", ops(), {
      permissions: { entities: { record: { delete: "auto" } } },
    });
    expect(del.status).toBe(422);
    expect(j(del.json).error.code).toBe("delete_not_off");
    const res = await H.call(OPERATOR, "PATCH", ops(), {
      permissions: { create: "approval", entities: {} },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).connection.permissions.entities).toBeUndefined();
  });
});

describe.skipIf(!h)("the connectors catalog", () => {
  const H = h as ApiHarness;

  it("is the operator's only", async () => {
    expect((await H.call(admin("a"), "GET", "/api/ops/connectors")).status).toBe(403);
    expect((await H.call(user("a"), "GET", "/api/ops/connectors")).status).toBe(403);
    expect(
      (await H.call(admin("a"), "PUT", "/api/ops/connectors/testkit", { status: "live" })).status,
    ).toBe(403);
  });

  it("lists every registered connector with its status, tools, entities, errors and default access", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const list = j(res.json).connectors;
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual([
      // The Marketing pack's connectors, registered on every platform (api.test-helper.ts).
      "hackernews",
      "linkedin",
      "testkit",
      "upload",
      "webhook",
      "website",
    ]);
    const testkit = list.find((c: { id: string }) => c.id === "testkit");
    // Nobody set a status: a connector clients can connect here reads as live (never "Not set").
    expect(testkit).toMatchObject({
      status: "live",
      statusSource: "deployment",
      testOnly: true,
      note: "",
      available: true,
      permissionEntities: [{ id: "record" }],
      errors: { toolCalls: 0, connections: 0 },
      defaultAccess: {
        source: "platform",
        matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
      },
    });
    expect(testkit.tools).toContainEqual(
      expect.objectContaining({ id: "testkit.record.update", entity: "record" }),
    );
  });

  it("shows who is waiting to connect: clients offered it with no connection", async () => {
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.B.tenantId}/connectors`, {
      offered: ["testkit", "webhook"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const res = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    const webhook = j(res.json).connectors.find((c: { id: string }) => c.id === "webhook");
    expect(webhook.waiting).toEqual([
      { clientId: H.B.tenantId, clientName: "Client B", offered: true, agents: [] },
    ]);
    // An operator who doesn't serve B doesn't see it.
    const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/connectors");
    const theirs = j(other.json).connectors.find((c: { id: string }) => c.id === "webhook");
    expect(theirs.waiting).toEqual([]);
  });

  it("sets the status, the note and a default access never looser than the platform's", async () => {
    const first = await H.call(OPERATOR, "PUT", "/api/ops/connectors/webhook", { note: "x" });
    expect(first.status).toBe(422);
    expect(j(first.json).error.code).toBe("status_required");
    const loose = await H.call(OPERATOR, "PUT", "/api/ops/connectors/webhook", {
      status: "beta",
      defaultPermissions: { read: "auto", create: "auto", update: "approval", delete: "off" },
    });
    expect(loose.status).toBe(422);
    expect(j(loose.json).error.code).toBe("invalid_default_access");
    const unknown = await H.call(OPERATOR, "PUT", "/api/ops/connectors/webhook", {
      status: "beta",
      defaultPermissions: {
        read: "auto",
        create: "approval",
        update: "approval",
        delete: "off",
        entities: { truck: { read: "off" } },
      },
    });
    expect(unknown.status).toBe(422);
    expect(
      (await H.call(OPERATOR, "PUT", "/api/ops/connectors/nope", { status: "beta" })).status,
    ).toBe(404);
    const res = await H.call(OPERATOR, "PUT", "/api/ops/connectors/webhook", {
      status: "beta",
      note: "Zapier only for now",
      defaultPermissions: {
        read: "auto",
        create: "approval",
        update: "approval",
        delete: "off",
        entities: { event: { create: "off" } },
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).connector).toMatchObject({
      id: "webhook",
      status: "beta",
      // The operator's status wins over the deployment's.
      statusSource: "operator",
      note: "Zapier only for now",
      defaultAccess: { source: "operator", matrix: { entities: { event: { create: "off" } } } },
    });
    expect(j(res.json).connector.updatedAt).toEqual(expect.any(String));
    // A status change alone keeps the default access and the note.
    const live = await H.call(OPERATOR, "PUT", "/api/ops/connectors/webhook", { status: "live" });
    expect(j(live.json).connector).toMatchObject({
      status: "live",
      note: "Zapier only for now",
      defaultAccess: { source: "operator" },
    });
  });

  it("applies the default access when a client's connection is first made, from the portal", async () => {
    const res = await H.call(admin("b"), "POST", "/api/connections/webhook/authorize");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [row] = await H.t.db
      .select({ permissions: connection.permissions })
      .from(connection)
      .where(and(eq(connection.tenantId, H.B.tenantId), eq(connection.connector, "webhook")));
    expect(row?.permissions).toEqual({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
      entities: { event: { create: "off" } },
    });
    // No longer waiting.
    const list = await H.call(OPERATOR, "GET", "/api/ops/connectors");
    const webhook = j(list.json).connectors.find((c: { id: string }) => c.id === "webhook");
    expect(webhook.waiting).toEqual([]);
    expect(webhook.clientsConnected).toBe(1);
    // The portal shows it without anything only the back office sees.
    const portal = await H.call(admin("b"), "GET", "/api/connections");
    expect(forbiddenKeys(portal.json)).toEqual([]);
  });
});

describe("every connector the platform registers", () => {
  it("declares an entity for every tool", () => {
    const all = deploymentConnectors({}, false);
    for (const c of all) {
      const ids = new Set((c.manifest.permissionEntities ?? []).map((e) => e.id));
      for (const t of c.manifest.tools) {
        const named = t.entity ? [t.entity] : Object.values(t.entityInput?.values ?? {});
        expect(named.length, `${t.id}`).toBeGreaterThan(0);
        for (const e of named) expect(ids.has(e), `${t.id}: ${e}`).toBe(true);
      }
    }
  });
});
