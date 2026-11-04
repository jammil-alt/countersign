// The agent pages' routes against a real database as cs_worker (ARCHITECTURE §14 "Agents",
// "Lineage", "Operation"): a version's diff against its parent, a client agent's customizations
// against its base template version, a template's "Used by" with versions behind and conflicts,
// the skills an agent may use, the activation check with its reasons, and retiring. Client roles
// get 403 on every one of them, and an operator never sees a client they don't serve.

import { createSkill, publishSkill } from "@countersign/agents";
import { type AgentBundle, cloneJson } from "@countersign/core";
import { run } from "@countersign/db";
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

function withInstructions(bundle: AgentBundle, instructions: string): AgentBundle {
  const b = cloneJson(bundle);
  b.definition.instructions = instructions;
  return b;
}

function skillDef(slug: string, name: string) {
  return {
    schemaVersion: 1,
    id: `custom:${slug}`,
    name,
    description: `${name}, written by the operator`,
    category: "custom",
    mode: "agent",
    instructions: "Do the thing.",
    tools: [],
    input: { type: "object" },
    output: { type: "object" },
    settings: [
      { key: "threshold_pct", label: "Threshold %", type: "number", default: 5 },
      {
        key: "vendors",
        label: "Vendors",
        type: "string",
        default: "",
        clientSpecific: true,
      },
    ],
  };
}

describe.skipIf(!h)("agent pages API", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let templateV1 = "";
  let agentA = "";
  let agentAv1 = "";
  let agentAv2 = "";

  beforeAll(async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    templateId = j(created.json).agent.id;
    templateV1 = j(created.json).version.id;
    await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions/${templateV1}/publish`);

    const forked = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    expect(forked.status, JSON.stringify(forked.json)).toBe(200);
    agentA = j(forked.json).agent.id;
    agentAv1 = j(forked.json).version.id;

    // Client A's customization: its own instructions.
    const v2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/versions`, {
      bundle: withInstructions(testBundle(), "For client A: change records only on Mondays."),
      changeNote: "Mondays only",
    });
    expect(v2.status, JSON.stringify(v2.json)).toBe(200);
    agentAv2 = j(v2.json).version.id;
  });

  describe("version diff", () => {
    it("compares a version with its parent, with labels to write sentences", async () => {
      const res = await H.call(
        OPERATOR,
        "GET",
        `/api/ops/agents/${agentA}/versions/${agentAv2}/diff`,
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).from).toMatchObject({ id: agentAv1, version: 1 });
      expect(j(res.json).to).toMatchObject({ id: agentAv2, version: 2 });
      expect(j(res.json).changes).toEqual([
        {
          kind: "changed",
          entity: "bundle",
          path: "bundle#/definition/instructions",
          before: "Change records only when asked.",
          after: "For client A: change records only on Mondays.",
        },
      ]);
      expect(j(res.json).labels).toMatchObject({
        "workflow:fix-record": "Fix a record",
        "step:update": "Update the record",
      });
    });

    it("answers no changes for a first version, and compares with any version of the agent", async () => {
      const first = await H.call(
        OPERATOR,
        "GET",
        `/api/ops/agents/${agentA}/versions/${agentAv1}/diff`,
      );
      expect(j(first.json)).toMatchObject({ from: null, changes: [] });
      const back = await H.call(
        OPERATOR,
        "GET",
        `/api/ops/agents/${agentA}/versions/${agentAv1}/diff?against=${agentAv2}`,
      );
      expect(j(back.json).changes).toHaveLength(1);
      // A version of another agent is not this agent's.
      const other = await H.call(
        OPERATOR,
        "GET",
        `/api/ops/agents/${agentA}/versions/${agentAv1}/diff?against=${templateV1}`,
      );
      expect(other.status).toBe(404);
    });
  });

  describe("customizations and used by", () => {
    it("shows what was changed for the client against its base template version", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/customizations`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).base).toMatchObject({ id: templateV1, agentId: templateId, version: 1 });
      // Not published yet: the latest version is compared.
      expect(j(res.json).version).toMatchObject({ id: agentAv2 });
      expect(j(res.json).changes.map((c: { path: string }) => c.path)).toEqual([
        "bundle#/definition/instructions",
      ]);
      const template = await H.call(
        OPERATOR,
        "GET",
        `/api/ops/agents/${templateId}/customizations`,
      );
      expect(template.status).toBe(422);
    });

    it("lists the template's client agents with base version, versions behind and conflicts", async () => {
      const before = await H.call(OPERATOR, "GET", `/api/ops/templates/${templateId}/used-by`);
      expect(before.status, JSON.stringify(before.json)).toBe(200);
      expect(j(before.json)).toMatchObject({
        templateLiveVersion: 1,
        agents: [
          {
            agent: { id: agentA, tenantId: H.A.tenantId },
            client: { id: H.A.tenantId, name: "Client A" },
            version: 2,
            baseVersion: 1,
            behind: 0,
            customizations: 1,
            conflicts: null,
          },
        ],
      });

      // Template v2 changes the same instructions differently: an update would conflict.
      const v2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
        bundle: withInstructions(testBundle(), "Change records when asked, and say why."),
        releaseNote: "Say why",
      });
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${templateId}/versions/${j(v2.json).version.id}/publish`,
      );
      const after = await H.call(OPERATOR, "GET", `/api/ops/templates/${templateId}/used-by`);
      expect(j(after.json).templateLiveVersion).toBe(2);
      expect(j(after.json).agents[0]).toMatchObject({ behind: 1, conflicts: 1 });

      // An operator who serves none of these clients sees no client agents.
      const other = await H.call(OTHER_OPERATOR, "GET", `/api/ops/templates/${templateId}/used-by`);
      expect(other.status).toBe(200);
      expect(j(other.json).agents).toEqual([]);
      const notTemplate = await H.call(OPERATOR, "GET", `/api/ops/templates/${agentA}/used-by`);
      expect(notTemplate.status).toBe(422);
    });
  });

  describe("skills", () => {
    it("offers shared skills everywhere and a client's own skills only to its agents", async () => {
      await H.t.db.transaction(async (tx) => {
        const shared = await createSkill(tx, {
          tenantId: null,
          definition: skillDef("price-watch", "Price watch"),
        });
        await publishSkill(tx, { skillId: shared.skill.id, versionId: shared.version.id });
        const own = await createSkill(tx, {
          tenantId: H.A.tenantId,
          definition: skillDef("price-watch", "Price watch for A"),
        });
        await publishSkill(tx, { skillId: own.skill.id, versionId: own.version.id });
        // A draft only (never published) is not offered.
        await createSkill(tx, { tenantId: null, definition: skillDef("draft-only", "Draft") });
      });

      const forTemplate = await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/skills`);
      expect(forTemplate.status, JSON.stringify(forTemplate.json)).toBe(200);
      expect(j(forTemplate.json).skills).toEqual([
        // Every connector read tool is a built-in tool-mode skill (platform.ts).
        expect.objectContaining({
          id: "testkit.record.query",
          source: "builtin",
          category: "Testkit",
        }),
        expect.objectContaining({
          id: "custom:price-watch",
          name: "Price watch",
          source: "shared",
          version: 1,
          settings: [
            expect.objectContaining({ key: "threshold_pct", type: "number", default: 5 }),
            expect.objectContaining({ key: "vendors", clientSpecific: true }),
          ],
        }),
      ]);
      // Client A's own skill of the same slug wins for A's agents.
      const forA = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/skills`);
      expect(j(forA.json).skills).toEqual([
        // Every connector read tool is a built-in tool-mode skill (platform.ts).
        expect.objectContaining({
          id: "testkit.record.query",
          source: "builtin",
          category: "Testkit",
        }),
        expect.objectContaining({
          id: "custom:price-watch",
          name: "Price watch for A",
          source: "client",
        }),
      ]);
    });

    it("gives the builder every skill with its schemas, every tool and the connectors", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/builder-catalog`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const catalog = j(res.json);
      expect(catalog.skills).toEqual([
        expect.objectContaining({
          ref: "testkit.record.query",
          source: "builtin",
          definition: expect.objectContaining({ mode: "tool", handler: "testkit.record.query" }),
        }),
        expect.objectContaining({
          ref: "custom:price-watch",
          source: "client",
          version: 1,
          definition: expect.objectContaining({
            id: "custom:price-watch",
            name: "Price watch for A",
            mode: "agent",
            input: { type: "object" },
            output: { type: "object" },
          }),
        }),
      ]);
      // Prompts stay with the skill: the builder never needs them.
      expect(catalog.skills[1].definition.instructions).toBeUndefined();
      const update = catalog.tools.find((t: { id: string }) => t.id === "testkit.record.update");
      expect(update).toMatchObject({
        sideEffect: "external",
        connector: "testkit",
        verb: "update",
      });
      expect(catalog.tools.map((t: { id: string }) => t.id)).toContain("inbox.create");
      expect(catalog.connectors).toEqual([expect.objectContaining({ id: "testkit" })]);

      // Triggers come from the event catalogue, now with each payload's schema.
      const events = await H.call(OPERATOR, "GET", "/api/ops/catalog/events");
      const received = j(events.json).events.find(
        (e: { type: string }) => e.type === "document.received",
      );
      expect(received.payload).toMatchObject({ type: "object" });
    });
  });

  describe("operation", () => {
    it("lists every reason a client agent can't be activated, then none", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/activation`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toEqual({
        ready: false,
        problems: ["it has no live version: publish one first"],
        requiredConnectors: ["testkit"],
      });

      await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentA}/operation`, {
        bindings: { testkit: H.A.connectionId },
      });
      await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/versions/${agentAv2}/publish`);
      const untested = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/activation`);
      expect(j(untested.json).problems).toEqual(["v2 has no passing test run on this client"]);

      await H.t.db.insert(run).values({
        tenantId: H.A.tenantId,
        agentId: agentA,
        agentVersionId: agentAv2,
        workflowSlug: "fix-record",
        mode: "test",
        status: "succeeded",
      });
      const ready = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/activation`);
      expect(j(ready.json)).toMatchObject({ ready: true, problems: [] });
      const activated = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/activate`);
      expect(j(activated.json).agent.runStatus).toBe("active");

      const template = await H.call(OPERATOR, "GET", `/api/ops/agents/${templateId}/activation`);
      expect(j(template.json)).toMatchObject({
        ready: false,
        problems: ["only client agents run"],
      });
    });

    it("retires a client agent, which then can't be activated; templates don't retire", async () => {
      const retired = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/retire`);
      expect(retired.status, JSON.stringify(retired.json)).toBe(200);
      expect(j(retired.json).agent.runStatus).toBe("retired");
      const check = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/activation`);
      expect(j(check.json).problems).toEqual(["the agent is retired"]);
      const again = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentA}/activate`);
      expect(again.status).toBe(409);
      expect((await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/retire`)).status).toBe(
        422,
      );
    });
  });

  describe("access", () => {
    it("refuses client roles and hides clients the operator does not serve", async () => {
      const paths: [string, string][] = [
        ["POST", `/api/ops/agents/${agentA}/retire`],
        ["GET", `/api/ops/agents/${agentA}/activation`],
        ["GET", `/api/ops/agents/${agentA}/skills`],
        ["GET", `/api/ops/agents/${agentA}/builder-catalog`],
        ["GET", `/api/ops/agents/${agentA}/versions/${agentAv2}/diff`],
        ["GET", `/api/ops/agents/${agentA}/customizations`],
        ["GET", `/api/ops/templates/${templateId}/used-by`],
      ];
      for (const [method, path] of paths) {
        for (const who of [admin("a"), user("a")]) {
          const res = await H.call(who, method, path, undefined, {
            "x-countersign-client": H.A.tenantId,
          });
          expect(res.status, `${who} ${method} ${path}`).toBe(403);
        }
        if (!path.includes("used-by")) {
          const other = await H.call(OTHER_OPERATOR, method, path);
          expect(other.status, `other operator ${method} ${path}`).toBe(404);
        }
      }
    });
  });
});
