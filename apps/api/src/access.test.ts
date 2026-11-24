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
import { allRoutes, type ConnectorStatus, routes } from "@countersign/core";
import {
  agent,
  agentChange,
  connection,
  connectionChange,
  connectorSetting,
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
    for (const [name, r] of Object.entries(allRoutes)) {
      if (!r.path.startsWith("/api/ops/")) continue;
      expect(r.path, name).not.toMatch(/credential|secret|password/i);
    }
  });

  it("the operator sets a grant up to the connection's matrix, logged", async () => {
    const path = `/api/ops/agents/${agentA}/grants/${acmeA}`;
    // Connectors C2/C4: the connection started with writes off; the client admin turns creating
    // on, asking first (their own change).
    const own = await call(admin("a"), "PUT", `/api/portal/connections/${acmeA}/access`, {
      permissions: { create: "approval" },
    });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
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

// Connectors C4 (docs/connectors-plan.md §3.1, §6): a live connector is on every client's
// Connectors list with its page, offered or not. Client C was never offered Acme; its page's
// "Enter key" needs Acme's form in `setup`, which listed offered connectors only.
describe.skipIf(!h)("access: the key form of a live connector we never offered", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const view = async (who: string) =>
    routes.portalAccess.response.parse((await call(who, "GET", routes.portalAccess.path)).json);
  const forms = async (who: string) => (await view(who)).setup.map((s) => s.connector);
  const acmeSetting = (values: { status: ConnectorStatus; clients: string[] | null }) =>
    H.t.db
      .insert(connectorSetting)
      .values({ connector: "acme", ...values })
      .onConflictDoUpdate({ target: connectorSetting.connector, set: values });
  const clearSetting = () =>
    H.t.db.delete(connectorSetting).where(eq(connectorSetting.connector, "acme"));

  it("lists it for the client admin, with its fields", async () => {
    const [c] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.C.tenantId));
    expect(c?.settings.connectors_offered).toEqual(["testkit"]);
    // The page is there, as the Connectors list says.
    const page = await call(admin("c"), "GET", "/api/portal/connectors/acme");
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect((await view(admin("c"))).setup).toEqual([
      {
        connector: "acme",
        name: "Acme supplies",
        description: "A supplier's API",
        fields: [
          { name: "username", label: "Username", secret: false },
          { name: "password", label: "Password", secret: true, hint: "From Acme's settings" },
        ],
      },
    ]);
    // A client user still sets nothing up.
    expect(await forms(user("c"))).toEqual([]);
  });

  it("leaves it out where the Connectors list does", async () => {
    const path = "/api/connections/acme/credentials";
    const body = { values: { username: "agent@c.example.com", password: PASSWORD } };
    try {
      // Built for client A alone: no other client sees it, offered (B) or not (C).
      await acmeSetting({ status: "live", clients: [H.A.tenantId] });
      expect(await forms(admin("c"))).toEqual([]);
      expect(await forms(admin("b"))).toEqual([]);
      expect((await call(admin("c"), "PUT", path, body)).status).toBe(404);
      // Not live yet: only a client we offered it to (B) may set it up.
      await acmeSetting({ status: "building", clients: null });
      expect(await forms(admin("c"))).toEqual([]);
      expect(await forms(admin("b"))).toEqual(["acme"]);
      // In beta it is on the list again.
      await acmeSetting({ status: "beta", clients: null });
      expect(await forms(admin("c"))).toEqual(["acme"]);
    } finally {
      await clearSetting();
    }
  });

  it("takes the key, and the form goes once the connector is connected", async () => {
    const res = await call(admin("c"), "PUT", "/api/connections/acme/credentials", {
      values: { username: "agent@c.example.com", password: PASSWORD },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { item } = routes.portalSetCredentials.response.parse(res.json);
    expect(item).toMatchObject({ connector: "acme", kind: "api_key", status: "connected" });
    const after = await view(admin("c"));
    expect(after.setup).toEqual([]);
    expect(after.items.map((i) => i.connector)).toContain("acme");
    expect(JSON.stringify(after)).not.toContain(PASSWORD);
    // Nothing of C's shows to another client.
    expect((await view(admin("b"))).items.some((i) => i.connectionId === item.connectionId)).toBe(
      false,
    );
  });
});
