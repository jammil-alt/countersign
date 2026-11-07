// Access, phase 1 through the API (docs/plan.md §1.26): the client admin enters an API-key
// connector's credentials (stored as v2 under the client's own key, never returned anywhere), the
// operator sets grants up to the connection's matrix, the client admin only tightens or revokes,
// the portal shows the vault without secrets or agent bundles, and nothing crosses clients.

import {
  CredentialCipher,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  generateEncryptionKey,
  tenantKeysInDb,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import {
  agent,
  agentChange,
  connection,
  connectionChange,
  tenant,
  tenantKey,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { vaultUpkeep } from "./vault/upkeep";

const ENCRYPTION_KEY = generateEncryptionKey();
const PASSWORD = "pw-very-secret-4471";

const acme = defineConnector({
  id: "acme",
  name: "Acme supplies",
  description: "A supplier's API",
  icon: "acme",
  auth: "api_key",
  entities: [],
  credentialFields: [
    { name: "username", label: "Username", secret: false },
    { name: "password", label: "Password", secret: true, hint: "From Acme's settings" },
  ],
  tools: [
    defineReadTool({
      id: "acme.price.get",
      description: "Read a price",
      input: z.object({}),
      output: z.object({ price: z.string() }),
      run: async () => ({ price: "1.00" }),
    }),
    defineWriteTool({
      id: "acme.order.create",
      description: "Place an order",
      verb: "create",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      beforeSchema: z.object({}),
      before: async () => null,
      run: async () => ({ id: "o1" }),
    }),
  ],
});

const h = await createApiHarness({ connectors: () => [acme], env: { ENCRYPTION_KEY } });
afterAll(() => h?.close());

describe.skipIf(!h)("access: the vault, write-only secrets and grants", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  let agentA = "";
  let agentB = "";
  let acmeA = "";

  async function bound(tenantId: string, slug: string, bindings: Record<string, string>) {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug,
        name: `${slug} agent`,
        serviceName: `${slug} service`,
        bindings,
        runStatus: "active",
      })
      .returning();
    if (!a) throw new Error("no agent");
    return a.id;
  }

  beforeAll(async () => {
    for (const c of [H.A, H.B]) {
      await H.t.db
        .update(tenant)
        .set({ settings: { connectors_offered: ["testkit", "acme"] } })
        .where(eq(tenant.id, c.tenantId));
    }
    agentA = await bound(H.A.tenantId, "buyer", { testkit: H.A.connectionId });
    agentB = await bound(H.B.tenantId, "buyer", { testkit: H.B.connectionId });
  });

  /** Every response body these people can read about A, as text. */
  async function everythingReadable(): Promise<string> {
    const bodies: unknown[] = [];
    const get = async (who: string, path: string, headers: Record<string, string> = {}) => {
      const res = await call(who, "GET", path, undefined, headers);
      bodies.push(res.json);
    };
    for (const who of [admin("a"), user("a")]) {
      await get(who, routes.portalAccess.path);
      await get(who, routes.portalConnections.path);
    }
    await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}`);
    await get(OPERATOR, `/api/ops/agents/${agentA}/grants`);
    await get(OPERATOR, `/api/ops/clients/${H.A.tenantId}/connections`);
    return JSON.stringify(bodies);
  }

  it("shows an offered API-key connector as one to set up, with its fields", async () => {
    const res = await call(admin("a"), "GET", routes.portalAccess.path);
    expect(res.status).toBe(200);
    const view = routes.portalAccess.response.parse(res.json);
    expect(view.canEdit).toBe(true);
    expect(view.setup.map((s) => s.connector)).toEqual(["acme"]);
    // A client user sees the vault, but sets nothing up.
    const asUser = routes.portalAccess.response.parse(
      (await call(user("a"), "GET", routes.portalAccess.path)).json,
    );
    expect(asUser.canEdit).toBe(false);
    expect(asUser.setup).toEqual([]);
  });

  it("the client admin enters the credentials; they are stored under the client's own key and never returned", async () => {
    const path = "/api/connections/acme/credentials";
    expect(
      (await call(admin("a"), "PUT", path, { values: { username: "agent@a.example.com" } })).status,
    ).toBe(422);
    expect(
      (
        await call(admin("a"), "PUT", path, {
          values: { username: "x", password: "y", extra: "z" },
        })
      ).status,
    ).toBe(422);
    const res = await call(admin("a"), "PUT", path, {
      values: { username: "agent@a.example.com", password: PASSWORD },
    });
    expect(res.status).toBe(200);
    const { item } = routes.portalSetCredentials.response.parse(res.json);
    acmeA = item.connectionId;
    expect(item).toMatchObject({ kind: "api_key", status: "connected", credentialForm: true });
    expect(item.secret.set).toBe(true);
    expect(item.secret.fields).toEqual([
      expect.objectContaining({ name: "username", set: true, value: "agent@a.example.com" }),
      expect.objectContaining({ name: "password", set: true, value: null, secret: true }),
    ]);
    expect(JSON.stringify(res.json)).not.toContain(PASSWORD);

    // Stored as a v2 envelope under A's own key; B has no key.
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, acmeA));
    expect(row?.credentialsEncrypted).toMatchObject({ v: 2 });
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const keys = await H.t.db.select().from(tenantKey);
    expect(keys.map((k) => k.tenantId)).toEqual([H.A.tenantId]);
    const vault = (await CredentialCipher.create({ current: ENCRYPTION_KEY })).forClients(
      tenantKeysInDb(H.db),
    );
    expect(
      await vault.decrypt(row?.credentialsEncrypted, {
        tenantId: H.A.tenantId,
        connectionId: acmeA,
      }),
    ).toEqual({ username: "agent@a.example.com", password: PASSWORD });
    // The change log names the fields, never their values.
    const log = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, acmeA));
    expect(log.at(-1)?.change).toMatchObject({
      kind: "credentials",
      fields: ["username", "password"],
    });
    expect(JSON.stringify(log)).not.toContain(PASSWORD);

    // Bind the agent to it, then look everywhere either side can read.
    await H.t.db
      .update(agent)
      .set({ bindings: { testkit: H.A.connectionId, acme: acmeA } })
      .where(eq(agent.id, agentA));
    expect(await everythingReadable()).not.toContain(PASSWORD);
  });

  it("only the client admin sets credentials: not a client user, not the operator", async () => {
    const path = "/api/connections/acme/credentials";
    const body = { values: { username: "u", password: "p" } };
    expect((await call(user("a"), "PUT", path, body)).status).toBe(403);
    expect(
      (await call(OPERATOR, "PUT", path, body, { "x-countersign-client": H.A.tenantId })).status,
    ).toBe(403);
    // And no back-office route takes a connection's credentials at all.
    for (const [name, r] of Object.entries(routes)) {
      if (!r.path.startsWith("/api/ops/")) continue;
      expect(r.path, name).not.toMatch(/credential|secret|password/i);
    }
  });

  it("the operator sets a grant up to the connection's matrix, logged", async () => {
    const path = `/api/ops/agents/${agentA}/grants/${acmeA}`;
    // The matrix has create at approval: auto is beyond it.
    const beyond = await call(OPERATOR, "PUT", path, { limits: { verbs: { create: "auto" } } });
    expect(beyond.status).toBe(422);
    expect((beyond.json as { error: { code: string } }).error.code).toBe("beyond_matrix");
    const badTool = await call(OPERATOR, "PUT", path, {
      limits: { tools: ["testkit.record.query"] },
    });
    expect(badTool.status).toBe(422);
    const res = await call(OPERATOR, "PUT", path, { limits: { verbs: { create: "off" } } });
    expect(res.status).toBe(200);
    const { grant } = routes.opsSetAgentGrant.response.parse(res.json);
    expect(grant.access.effective).toMatchObject({ read: "auto", create: "off" });
    expect(grant.secretSet).toBe(true);
    // The operator may loosen its own grant again (to the matrix).
    expect(
      (await call(OPERATOR, "PUT", path, { limits: { verbs: { create: "approval" } } })).status,
    ).toBe(200);
    // An agent not bound to the connection (here, another client's agent): refused.
    expect(
      (await call(OPERATOR, "PUT", `/api/ops/agents/${agentB}/grants/${acmeA}`, { limits: {} }))
        .status,
    ).toBe(409);
    const changes = await H.t.db.select().from(agentChange).where(eq(agentChange.agentId, agentA));
    const grants = changes.filter((c) => (c.change as { kind?: string }).kind === "grant");
    expect(grants.map((c) => (c.change as { after: unknown }).after)).toEqual([
      { verbs: { create: "off" } },
      { verbs: { create: "approval" } },
    ]);
    const list = routes.opsAgentGrants.response.parse(
      (await call(OPERATOR, "GET", `/api/ops/agents/${agentA}/grants`)).json,
    );
    expect(list.grants.map((g) => g.connector).sort()).toEqual(["acme", "testkit"]);
  });

  it("the client admin can tighten and revoke, never loosen", async () => {
    const path = `/api/access/agents/${agentA}/connections/${acmeA}`;
    // Tighten: create from approval (the grant) to off, and only the price tool.
    const tight = await call(admin("a"), "PUT", path, {
      limits: { verbs: { create: "off" }, tools: ["acme.price.get"] },
    });
    expect(tight.status).toBe(200);
    const { item } = routes.portalSetGrant.response.parse(tight.json);
    const mine = item.agents.find((x) => x.agentId === agentA);
    expect(mine).toMatchObject({
      name: "buyer service",
      tools: ["acme.price.get"],
      revoked: false,
    });
    expect(mine?.effective.create).toBe("off");
    // Loosen: back to approval, or all tools: 403, as the matrix does.
    for (const limits of [
      { verbs: { create: "approval" }, tools: ["acme.price.get"] },
      { verbs: { create: "off" } },
      { verbs: { create: "off" }, tools: ["acme.price.get", "acme.order.create"] },
    ]) {
      const res = await call(admin("a"), "PUT", path, { limits });
      expect(res.status, JSON.stringify(limits)).toBe(403);
      expect((res.json as { error: { code: string } }).error.code).toBe("loosening");
    }
    // A client user can't change anything.
    expect(
      (await call(user("a"), "PUT", path, { limits: { verbs: { read: "off" } } })).status,
    ).toBe(403);
    // Revoke: every verb off.
    const revoked = await call(admin("a"), "PUT", path, {
      limits: {
        verbs: { read: "off", create: "off", update: "off", delete: "off" },
        tools: ["acme.price.get"],
      },
    });
    expect(revoked.status).toBe(200);
    const after = routes.portalSetGrant.response.parse(revoked.json);
    expect(after.item.agents.find((x) => x.agentId === agentA)?.revoked).toBe(true);
    const logged = await H.t.db
      .select()
      .from(agentChange)
      .where(and(eq(agentChange.agentId, agentA)));
    expect(logged.some((c) => (c.change as { by?: string }).by === "client")).toBe(true);
  });

  it("names each account as the client knows it, never by its id in the tool", async () => {
    // QA round 1: a QuickBooks realm id is not a name; the company name the connector set is.
    const [was] = await H.t.db.select().from(connection).where(eq(connection.id, acmeA));
    await H.t.db
      .update(connection)
      .set({ externalAccountId: "9341455130122716", config: {} })
      .where(eq(connection.id, acmeA));
    const named = async () =>
      routes.portalAccess.response
        .parse((await call(admin("a"), "GET", routes.portalAccess.path)).json)
        .items.find((i) => i.connectionId === acmeA);
    expect((await named())?.accountName).toBeNull();
    await H.t.db
      .update(connection)
      .set({ config: { accountName: "Harbor Millwork" } })
      .where(eq(connection.id, acmeA));
    expect((await named())?.accountName).toBe("Harbor Millwork");
    await H.t.db
      .update(connection)
      .set({ externalAccountId: was?.externalAccountId ?? null, config: was?.config ?? {} })
      .where(eq(connection.id, acmeA));
  });

  it("keeps clients apart: B can't see or change A's vault or grants", async () => {
    const res = await call(admin("b"), "GET", routes.portalAccess.path);
    const view = routes.portalAccess.response.parse(res.json);
    expect(view.items.some((i) => i.connectionId === acmeA)).toBe(false);
    expect(
      (
        await call(admin("b"), "PUT", `/api/access/agents/${agentA}/connections/${acmeA}`, {
          limits: { verbs: { read: "off" } },
        })
      ).status,
    ).toBe(404);
    // The other operator doesn't serve A.
    expect(
      (await call("other-operator@example.com", "GET", `/api/ops/agents/${agentA}/grants`)).status,
    ).toBe(404);
  });

  it("the portal's vault carries no agent bundle, instructions, prompts or cost", async () => {
    const text = JSON.stringify((await call(admin("a"), "GET", routes.portalAccess.path)).json);
    for (const word of ["bundle", "instructions", "prompt", "costUsd", "definition"]) {
      expect(text).not.toContain(`"${word}"`);
    }
  });

  it("disconnecting drops the credentials and what the vault said about them", async () => {
    expect((await call(admin("a"), "DELETE", `/api/connections/${acmeA}`)).status).toBe(200);
    const view = routes.portalAccess.response.parse(
      (await call(admin("a"), "GET", routes.portalAccess.path)).json,
    );
    const item = view.items.find((i) => i.connectionId === acmeA);
    expect(item?.secret.set).toBe(false);
    expect(item?.secret.fields.every((f) => !f.set && f.value === null)).toBe(true);
  });

  it("the hourly upkeep re-encrypts v1 rows as v2 under each client's key", async () => {
    const master = await CredentialCipher.create({ current: ENCRYPTION_KEY });
    const binding = { tenantId: H.B.tenantId, connectionId: H.B.connectionId };
    await H.t.db
      .update(connection)
      .set({ credentialsEncrypted: await master.encryptV1({ token: "t-1" }, binding) })
      .where(eq(connection.id, H.B.connectionId));
    const result = await vaultUpkeep(H.db, master);
    expect(result).toMatchObject({ reencrypted: 1, failed: 0 });
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, H.B.connectionId));
    expect(row?.credentialsEncrypted).toMatchObject({ v: 2 });
    const vault = master.forClients(tenantKeysInDb(H.db));
    expect(await vault.decrypt(row?.credentialsEncrypted, binding)).toEqual({ token: "t-1" });
    expect((await vaultUpkeep(H.db, master)).reencrypted).toBe(0);
  });
});
