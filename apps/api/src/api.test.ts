// The back office and portal routes against a real database as cs_worker: sessions, operator flows
// (clients, templates, versions, fork, publish, rollback, validation), client isolation through the
// API, and the permission matrix (operators loosen, clients only tighten).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

describe.skipIf(!h)("API", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let templateV1 = "";
  let clientAgentId = "";

  beforeAll(async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
      releaseNote: "First",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    templateId = j(created.json).agent.id;
    templateV1 = j(created.json).version.id;
    const published = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${templateV1}/publish`,
    );
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const forked = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    expect(forked.status, JSON.stringify(forked.json)).toBe(200);
    clientAgentId = j(forked.json).agent.id;
  });

  describe("session", () => {
    it("answers who is signed in, with their clients", async () => {
      const op = await H.call(OPERATOR, "GET", "/api/session");
      expect(op.status).toBe(200);
      expect(j(op.json).operator).toBe(true);
      expect(
        j(op.json)
          .tenants.map((t: { id: string }) => t.id)
          .sort(),
      ).toEqual([H.A.tenantId, H.B.tenantId].sort());
      const client = await H.call(admin("a"), "GET", "/api/session");
      expect(j(client.json)).toMatchObject({ operator: false, activeTenantId: H.A.tenantId });
    });

    it("refuses no session, an unknown user and a client that is not the user's", async () => {
      expect((await H.call(null, "GET", "/api/session")).status).toBe(401);
      expect((await H.call("nobody@example.com", "GET", "/api/session")).status).toBe(401);
      const other = await H.call(admin("a"), "GET", "/api/session", undefined, {
        "x-countersign-client": H.B.tenantId,
      });
      expect(other.status).toBe(403);
    });

    it("signs in with the dev adapter by setting a cookie", async () => {
      const res = await H.call(null, "POST", "/api/auth/dev/sign-in", { email: admin("a") });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("cs_dev_user=");
      expect(
        (await H.call(null, "POST", "/api/auth/dev/sign-in", { email: "x@example.com" })).status,
      ).toBe(404);
    });

    it("lists the seeded users for the dev sign-in screen, and only with the dev adapter", async () => {
      const res = await H.call(null, "GET", "/api/auth/dev/users");
      expect(res.status).toBe(200);
      const users = j(res.json).users as { email: string; operator: boolean; tenants: unknown[] }[];
      expect(users.find((u) => u.email === OPERATOR)).toMatchObject({ operator: true });
      expect(users.find((u) => u.email === admin("a"))).toMatchObject({
        operator: false,
        tenants: [{ id: H.A.tenantId, name: "Client A", role: "client_admin" }],
      });
      const workos = await H.app.request(
        "/api/auth/dev/users",
        {},
        { ...H.env, ENVIRONMENT: "production", AUTH_PROVIDER: "dev" },
        { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never,
      );
      expect(workos.status).not.toBe(200);
    });

    it("tells the sign-in page which sign-in to show, and sends WorkOS failures back to it", async () => {
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
      const as = (env: Record<string, string>) => (path: string) =>
        H.app.request(path, {}, { ...H.env, ...env }, ctx);

      const dev = await H.call(null, "GET", "/api/auth/provider");
      expect(dev.json).toEqual({ provider: "dev", message: null });

      const workos = as({
        ENVIRONMENT: "staging",
        AUTH_PROVIDER: "workos",
        WORKOS_CLIENT_ID: "client_test",
        WORKOS_API_KEY: "sk_test_key",
        WORKOS_COOKIE_PASSWORD: "x".repeat(64),
        APP_ORIGIN: "https://staging.mezonas.test",
      });
      expect(await (await workos("/api/auth/provider")).json()).toEqual({
        provider: "workos",
        message: null,
      });
      const start = await workos("/api/auth/sign-in?return_to=/ops/clients");
      expect(start.status).toBe(302);
      expect(start.headers.get("location")).toMatch(/^https:\/\/api\.workos\.com\//);
      // A callback that can't be verified goes back to the sign-in page with a code, not JSON.
      const callback = await workos("/api/auth/callback?code=c&state=s");
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/sign-in?error=unauthenticated");
      const offsite = await workos("/api/auth/sign-in?return_to=https://evil.example");
      expect(offsite.headers.get("location")).toBe("/sign-in?error=forbidden");

      const broken = as({ ENVIRONMENT: "staging", AUTH_PROVIDER: "workos", WORKOS_CLIENT_ID: "" });
      const unavailable = (await (await broken("/api/auth/provider")).json()) as {
        provider: string;
      };
      expect(unavailable.provider).toBe("unavailable");
      const refused = await broken("/api/auth/sign-in");
      expect(refused.status).toBe(302);
      expect(refused.headers.get("location")).toBe("/sign-in?error=misconfigured");
    });
  });

  describe("clients", () => {
    it("lists only the clients the operator serves", async () => {
      const res = await H.call(OPERATOR, "GET", "/api/ops/clients");
      const ids = j(res.json).clients.map((c: { id: string }) => c.id);
      expect(ids.sort()).toEqual([H.A.tenantId, H.B.tenantId].sort());
      const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/clients");
      expect(j(other.json).clients.map((c: { id: string }) => c.id)).toEqual([H.C.tenantId]);
    });

    it("creates a client the creating operator then serves", async () => {
      const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
        name: "New client",
        timezone: "America/Chicago",
        connectorsOffered: ["testkit"],
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const id = j(res.json).client.id;
      const detail = await H.call(OPERATOR, "GET", `/api/ops/clients/${id}`);
      expect(detail.status).toBe(200);
      expect(j(detail.json).client.settings).toEqual({ connectors_offered: ["testkit"] });
      expect(j(detail.json).members).toEqual([
        expect.objectContaining({ email: OPERATOR, role: "operator" }),
      ]);
      // Another operator doesn't serve it.
      expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${id}`)).status).toBe(404);
      const bad = await H.call(OPERATOR, "POST", "/api/ops/clients", {
        name: "x",
        connectorsOffered: ["nope"],
      });
      expect(bad.status).toBe(422);
    });

    it("hides a client the operator does not serve", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.C.tenantId}`);
      expect(res.status).toBe(404);
      const narrowed = await H.call(OPERATOR, "GET", `/api/ops/clients?client=${H.C.tenantId}`);
      expect(narrowed.status).toBe(403);
    });
  });

  describe("templates and client agents", () => {
    it("lists templates and the client's agents with lineage", async () => {
      const templates = await H.call(OPERATOR, "GET", "/api/ops/templates");
      expect(j(templates.json).templates.map((t: { slug: string }) => t.slug)).toContain(
        "records-clerk",
      );
      const agents = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/agents`);
      expect(j(agents.json).agents).toEqual([
        expect.objectContaining({ id: clientAgentId, templateId, runStatus: "draft" }),
      ]);
      const detail = await H.call(OPERATOR, "GET", `/api/ops/agents/${clientAgentId}`);
      expect(detail.status).toBe(200);
      expect(j(detail.json).versions).toHaveLength(1);
      expect(j(detail.json).latest.basedOnTemplateVersionId).toBe(templateV1);
      expect(j(detail.json).update).toMatchObject({ available: false, behind: 0 });
    });

    it("saves drafts, refuses no-ops, publishes and rolls back", async () => {
      const v2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
        bundle: testBundle("Records clerk v2"),
        changeNote: "Renamed",
      });
      expect(v2.status, JSON.stringify(v2.json)).toBe(200);
      expect(j(v2.json).errors).toEqual([]);
      const again = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
        bundle: testBundle("Records clerk v2"),
      });
      expect(again.status).toBe(409);
      const vid = j(v2.json).version.id;
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${templateId}/versions/${vid}/publish`,
      );
      expect(j(pub.json).version).toMatchObject({ version: 2, status: "live" });
      // The template's publish changed no client agent (invariant 11).
      const detail = await H.call(OPERATOR, "GET", `/api/ops/agents/${clientAgentId}`);
      expect(j(detail.json).versions).toHaveLength(1);
      const back = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/rollback`, {
        versionId: templateV1,
      });
      expect(j(back.json).version).toMatchObject({ version: 3, status: "live" });
      const one = await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/versions/${vid}`);
      expect(j(one.json).version.bundle.definition.identity.name).toBe("Records clerk v2");
    });

    it("refuses an invalid bundle and a fork into a client the operator does not serve", async () => {
      const bad = await H.call(OPERATOR, "POST", "/api/ops/templates", {
        slug: "broken",
        bundle: { schemaVersion: 1 },
      });
      expect(bad.status).toBe(422);
      const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
        clientId: H.C.tenantId,
        slug: "nope",
      });
      expect(fork.status).toBe(404);
    });

    it("publishes a client agent against its bindings, and shows template updates", async () => {
      const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${clientAgentId}/operation`, {
        bindings: { testkit: H.A.connectionId },
      });
      expect(j(bound.json).agent.bindings).toEqual({ testkit: H.A.connectionId });
      const detail = await H.call(OPERATOR, "GET", `/api/ops/agents/${clientAgentId}`);
      const v1 = j(detail.json).latest.id;
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${clientAgentId}/versions/${v1}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      const after = await H.call(OPERATOR, "GET", `/api/ops/agents/${clientAgentId}`);
      // Based on template v1; the template has published v2 and v3 since.
      expect(j(after.json).update).toMatchObject({ available: true, behind: 2 });
    });

    it("copies a client agent to another client without its bindings", async () => {
      const copy = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
        slug: "records-copy",
        copyFrom: clientAgentId,
      });
      expect(copy.status, JSON.stringify(copy.json)).toBe(200);
      expect(j(copy.json).agent).toMatchObject({ tenantId: H.B.tenantId, bindings: {} });
      // A binding to another client's connection is refused.
      const cross = await H.call(
        OPERATOR,
        "PATCH",
        `/api/ops/agents/${j(copy.json).agent.id}/operation`,
        {
          bindings: { testkit: H.A.connectionId },
        },
      );
      expect(cross.status).toBe(409);
    });

    it("validates a workflow the way the builder does", async () => {
      const wf = testBundle().workflows[0]?.workflow;
      const ok = await H.call(OPERATOR, "POST", "/api/ops/workflows/validate", {
        workflow: wf,
        agentId: templateId,
      });
      expect(j(ok.json)).toEqual({ valid: true, errors: [] });
      const bad = await H.call(OPERATOR, "POST", "/api/ops/workflows/validate", {
        workflow: { ...wf, steps: [{ id: "x", name: "x", kind: "action", tool: "nope.tool" }] },
      });
      expect(j(bad.json).valid).toBe(false);
      expect(j(bad.json).errors.map((e: { code: string }) => e.code)).toContain("unknown_tool");
      const events = await H.call(OPERATOR, "GET", "/api/ops/catalog/events");
      expect(j(events.json).events.map((e: { type: string }) => e.type)).toContain(
        "inbox.resolved",
      );
    });

    // v0.13 W2-H (docs/plan.md §1.53): the models a step may name, checked the way the builder does.
    it("lists the models a step may run on and refuses one it doesn't know", async () => {
      const models = await H.call(OPERATOR, "GET", "/api/ops/models");
      expect(models.status).toBe(200);
      const ids = j(models.json).models.map((m: { id: string }) => m.id);
      expect(ids).toContain("claude-haiku-5-5");
      expect(j(models.json).models[0]).toMatchObject({ label: "Fast (Haiku)" });
      expect((await H.call(admin("a"), "GET", "/api/ops/models")).status).toBe(403);

      const wf = testBundle().workflows[0]?.workflow;
      if (!wf) throw new Error("no workflow");
      // An agent-mode built-in skill step, overridden to another model.
      const withModel = (skill: string, id: string) => ({
        ...wf,
        steps: [
          {
            id: "triage",
            name: "Triage",
            kind: "skill",
            skill,
            input: { event: "run.failed", facts: {} },
            model: { id },
          },
        ],
      });
      const validate = async (skill: string, id: string) =>
        j(
          (
            await H.call(OPERATOR, "POST", "/api/ops/workflows/validate", {
              workflow: withModel(skill, id),
            })
          ).json,
        );
      expect(await validate("supervisor.triage", "claude-haiku-5-5")).toEqual({
        valid: true,
        errors: [],
      });
      const codesOf = async (skill: string, id: string) =>
        (await validate(skill, id)).errors.map((e: { code: string }) => e.code);
      expect(await codesOf("supervisor.triage", "claude-nonesuch")).toEqual(["unknown_model"]);
      expect(await codesOf("supervisor.daily-check", "claude-haiku-5-5")).toContain(
        "model_not_allowed",
      );
    });
  });

  describe("connections and permissions", () => {
    it("lets the client admin tighten but never loosen", async () => {
      const path = `/api/connections/${H.A.connectionId}/permissions`;
      const tighten = await H.call(admin("a"), "PATCH", path, { update: "off" });
      expect(tighten.status, JSON.stringify(tighten.json)).toBe(200);
      expect(j(tighten.json).connection.connection.permissions.update).toBe("off");
      const loosen = await H.call(admin("a"), "PATCH", path, { update: "approval" });
      expect(loosen.status).toBe(403);
      expect(j(loosen.json).error.code).toBe("loosening");
      expect((await H.call(user("a"), "PATCH", path, { update: "off" })).status).toBe(403);
      // Another client's connection is not there for this client.
      const other = await H.call(
        admin("a"),
        "PATCH",
        `/api/connections/${H.B.connectionId}/permissions`,
        {
          update: "off",
        },
      );
      expect(other.status).toBe(404);
    });

    it("lets the operator loosen, logged, but never turn delete on", async () => {
      const path = `/api/ops/connections/${H.A.connectionId}`;
      const res = await H.call(OPERATOR, "PATCH", path, { permissions: { update: "approval" } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).connection.permissions.update).toBe("approval");
      expect(j(res.json).connection).not.toHaveProperty("credentialsEncrypted");
      const del = await H.call(OPERATOR, "PATCH", path, { permissions: { delete: "auto" } });
      expect(del.status).toBe(422);
      const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`);
      expect(j(list.json).connections).toHaveLength(1);
    });

    it("shows the client its offered tools, what agents may do and who uses them", async () => {
      const res = await H.call(user("a"), "GET", "/api/connections");
      expect(res.status).toBe(200);
      // Upload is built in and listed first; the offered tool follows.
      const [upload, testkit] = j(res.json).connections;
      expect(upload).toMatchObject({ connector: "upload" });
      expect(testkit).toMatchObject({ connector: "testkit", name: "Testkit" });
      expect(testkit.connection.usedBy).toEqual([{ id: clientAgentId, name: "Record keeping" }]);
      expect(testkit.connection.access.map((a: { access: string }) => a.access)).toEqual([
        "runs",
        "asks_first",
      ]);
    });
  });

  describe("client isolation through the API", () => {
    it("never shows one client's records to another", async () => {
      const conn = await H.call(admin("b"), "GET", "/api/connections");
      const ids = j(conn.json).connections.map(
        (c: { connection: { id: string } | null }) => c.connection?.id,
      );
      // Upload (built in, not used yet: no connection) and B's own testkit connection.
      expect(ids).toEqual([undefined, H.B.connectionId]);
      // A's agent is not a service of B.
      const overview = await H.call(admin("b"), "GET", "/api/overview");
      expect(j(overview.json).client.id).toBe(H.B.tenantId);
      expect(j(overview.json).services.map((s: { id: string }) => s.id)).not.toContain(
        clientAgentId,
      );
      // An operator of C can't read A's agent or runs.
      expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/agents/${clientAgentId}`)).status).toBe(
        404,
      );
      const runs = await H.call(OTHER_OPERATOR, "GET", "/api/ops/runs");
      expect(j(runs.json).runs).toEqual([]);
    });
  });
});
