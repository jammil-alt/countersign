// The agent pages' routes against a real database as cs_worker (ARCHITECTURE §14 "Agents",
// "Lineage", "Operation"): a version's diff against its parent, a client agent's customizations
// against its base template version, a template's "Used by" with versions behind and conflicts,
// the skills an agent may use, the activation check with its reasons, and retiring. Client roles
// get 403 on every one of them, and an operator never sees a client they don't serve.

import { createSkill, publishSkill } from "@countersign/agents";
import { type AgentBundle, cloneJson, isToolWrapper } from "@countersign/core";
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
    // Skill model (2026-11-10): new operator skills are AI skills (agent mode retired).
    mode: "task",
    model: { id: "claude-haiku-5-5" },
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

const stepWorkflow = (steps: unknown[]) => ({
  schemaVersion: 5,
  triggers: [{ id: "t1", on: { type: "manual", input: { type: "object", properties: {} } } }],
  outputs: [{ id: "o1", name: "Done", kind: "nothing" }],
  steps: [...steps, { id: "e1", kind: "end", name: "Done", outputs: ["o1"], status: "succeeded" }],
});
const rulesStep = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "do",
  name: "Pick the account",
  doneBy: "rules",
  input: { vendor: "{{trigger.vendor}}" },
  rules: {
    rows: [{ id: "r1", when: { match: "all", rules: [] }, set: { account: "Materials" } }],
  },
  output: [{ name: "account", type: "text", required: true }],
  ...over,
});

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
      // The platform's built-in skills (docs.*) are offered everywhere; the rest is the operator's.
      const builtin = (skills: { source: string; id: string }[]) =>
        skills.filter((s) => s.source === "builtin").map((s) => s.id);
      const own = (skills: { source: string }[]) => skills.filter((s) => s.source !== "builtin");
      // Skill model (2026-11-10): a skill that only wraps a tool (a connector read, docs.extract)
      // is no longer offered, unless the agent already lists it; a process uses the tool directly.
      const offered = builtin(j(forTemplate.json).skills);
      expect(offered.length).toBeGreaterThan(0);
      for (const id of ["docs.extract", "docs.find-support", "testkit.record.query"]) {
        expect(offered).not.toContain(id);
      }
      for (const id of offered) {
        const def = H.platform.catalog.get(id);
        expect(def && isToolWrapper(def), id).toBe(false);
      }
      expect(own(j(forTemplate.json).skills)).toEqual([
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
      expect(own(j(forA.json).skills)).toEqual([
        expect.objectContaining({
          id: "custom:price-watch",
          name: "Price watch for A",
          source: "client",
        }),
      ]);
    });

    it("serves the Uses picker's actions by connector and by area, with each one's kind", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/action-catalog`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const groups = j(res.json).groups as {
        type: string;
        id: string;
        name: string;
        actions: { id: string; kind: string }[];
      }[];
      // Connectors first, then areas.
      const types = groups.map((g) => g.type);
      expect(types).toEqual([...types].sort((a, b) => (a === b ? 0 : a === "connector" ? -1 : 1)));
      const testkit = groups.find((g) => g.id === "testkit");
      expect(testkit?.type).toBe("connector");
      expect(testkit?.actions.find((a) => a.id === "testkit.record.update")?.kind).toBe("change");
      expect(testkit?.actions.find((a) => a.id === "testkit.record.query")?.kind).toBe("get");
      // Our own records sit under an area; the platform's own and the engines are not offered.
      expect(groups.find((g) => g.type === "area")).toBeDefined();
      const ids = groups.flatMap((g) => g.actions.map((a) => a.id));
      expect(ids).not.toContain("comms.reach_out");
      expect(ids.some((id) => id.startsWith("health."))).toBe(false);
    });

    it("gives the builder every skill with its schemas, every tool and the connectors", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/builder-catalog`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const catalog = j(res.json);
      const custom = catalog.skills.filter((s: { source: string }) => s.source !== "builtin");
      expect(custom).toEqual([
        expect.objectContaining({
          ref: "custom:price-watch",
          source: "client",
          version: 1,
          definition: expect.objectContaining({
            id: "custom:price-watch",
            name: "Price watch for A",
            mode: "task",
            input: { type: "object" },
            output: { type: "object" },
          }),
        }),
      ]);
      // Skill model (2026-11-10): the wrapper is gone from the catalog; its tool is a step tool.
      expect(
        catalog.skills.find((s: { ref: string }) => s.ref === "testkit.record.query"),
      ).toBeUndefined();
      expect(catalog.stepTools).toContain("testkit.record.query");
      // Prompts stay with the skill: the builder never needs them.
      expect(custom[0].definition.instructions).toBeUndefined();
      const update = catalog.tools.find((t: { id: string }) => t.id === "testkit.record.update");
      expect(update).toMatchObject({
        sideEffect: "external",
        connector: "testkit",
        verb: "update",
      });
      expect(catalog.tools.map((t: { id: string }) => t.id)).toContain("inbox.create");
      expect(catalog.connectors).toEqual([
        expect.objectContaining({ id: "upload" }),
        expect.objectContaining({ id: "testkit" }),
        expect.objectContaining({ id: "hackernews" }),
        expect.objectContaining({ id: "website" }),
        expect.objectContaining({ id: "linkedin" }),
      ]);

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
        testRun: null,
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

  describe("steps written in themselves", () => {
    // Stream F: Suggest's backend. The model is the Builder's (scripted in the package's own
    // tests); here the route's own checks: nothing flagged needs no model call, a missing step is
    // a 404 and a workflow that doesn't read is a 422.
    it("answers Suggest on a step that isn't flagged without asking the model", async () => {
      const workflow = stepWorkflow([rulesStep("s1")]);
      const path = `/api/ops/agents/${agentA}/suggest`;
      const ok = await H.call(OPERATOR, "POST", path, { workflow, stepId: "s1", how: "resolve" });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(j(ok.json)).toMatchObject({
        applied: false,
        summary: "Nothing is flagged on this step.",
        step: { id: "s1", name: "Pick the account" },
      });
      const missing = await H.call(OPERATOR, "POST", path, {
        workflow,
        stepId: "nope",
        how: "tell",
        text: "x",
      });
      expect(missing.status).toBe(404);
      const bad = await H.call(OPERATOR, "POST", path, {
        workflow: { schemaVersion: 4 },
        stepId: "s1",
        how: "resolve",
      });
      expect(bad.status).toBe(422);
    });

    it("stores the rules written in a step as the agent's own skill, kept out of the library", async () => {
      const path = `/api/ops/agents/${agentA}/step-skills`;
      const workflow = stepWorkflow([rulesStep("0190a1b2-c3d4")]);
      const first = await H.call(OPERATOR, "POST", path, { workflow });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(j(first.json).skills).toEqual([
        { stepId: "0190a1b2-c3d4", ref: "custom:step-0190a1b2-c3d4", version: 1, changed: true },
      ]);
      const again = await H.call(OPERATOR, "POST", path, { workflow });
      expect(j(again.json).skills[0]).toMatchObject({ version: 1, changed: false });

      // It isn't a skill to pick: not in the library, not in the Uses picker's skills.
      const library = await H.call(OPERATOR, "GET", "/api/ops/skills");
      expect(JSON.stringify(j(library.json).skills)).not.toContain("step-0190a1b2-c3d4");
      const catalog = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/builder-catalog`);
      expect(JSON.stringify(j(catalog.json).skills)).not.toContain("step-0190a1b2-c3d4");
      const uses = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/skills`);
      expect(JSON.stringify(j(uses.json).skills)).not.toContain("step-0190a1b2-c3d4");
    });

    it("saves a step as a skill this client's or shared; the library and the picker list it", async () => {
      const path = `/api/ops/agents/${agentA}/save-as-skill`;
      const workflow = stepWorkflow([rulesStep("n2")]);
      const body = {
        workflow,
        stepId: "n2",
        name: "Pick the account",
        description: "Sets the account from the vendor.",
      };
      const mine = await H.call(OPERATOR, "POST", path, { ...body, scope: "client" });
      expect(mine.status, JSON.stringify(mine.json)).toBe(200);
      expect(j(mine.json).skill).toMatchObject({
        ref: "custom:pick-the-account",
        scope: "client",
      });
      expect(j(mine.json).step).toMatchObject({
        id: "n2",
        uses: { type: "skill", skill: "custom:pick-the-account" },
      });
      expect(j(mine.json).step.rules).toBeUndefined();

      const library = await H.call(OPERATOR, "GET", "/api/ops/skills");
      expect(
        j(library.json).skills.find((x: { ref: string }) => x.ref === "custom:pick-the-account"),
      ).toMatchObject({ source: "client" });
      const picker = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentA}/builder-catalog`);
      expect(
        j(picker.json).skills.find((x: { ref: string }) => x.ref === "custom:pick-the-account"),
      ).toBeDefined();

      const shared = await H.call(OPERATOR, "POST", path, {
        ...body,
        name: "Pick the account, shared",
        scope: "shared",
      });
      expect(j(shared.json).skill).toMatchObject({ scope: "shared" });

      // Not a Do step by rules or AI, or nothing written: refused in words.
      const person = await H.call(OPERATOR, "POST", path, {
        ...body,
        workflow: stepWorkflow([rulesStep("n2", { doneBy: "person" })]),
        scope: "client",
      });
      expect(person.status).toBe(422);
      expect(j(person.json).error?.message ?? JSON.stringify(person.json)).toMatch(
        /rules or by AI/,
      );
    });

    it("saves nothing as a client's skill from a template", async () => {
      const path = `/api/ops/templates/${templateId}`;
      expect(path).toBeTruthy();
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/save-as-skill`, {
        workflow: stepWorkflow([rulesStep("t1s")]),
        stepId: "t1s",
        name: "Template skill",
        description: "From a template.",
        scope: "client",
      });
      expect(res.status).toBe(422);
    });

    it("refuses client roles on all three", async () => {
      const workflow = stepWorkflow([rulesStep("s1")]);
      const calls: [string, unknown][] = [
        [`/api/ops/agents/${agentA}/step-skills`, { workflow }],
        [
          `/api/ops/agents/${agentA}/save-as-skill`,
          { workflow, stepId: "s1", name: "N", description: "D", scope: "client" },
        ],
        [`/api/ops/agents/${agentA}/suggest`, { workflow, stepId: "s1", how: "resolve" }],
      ];
      for (const [path, body] of calls) {
        for (const who of [admin("a"), user("a")]) {
          const res = await H.call(who, "POST", path, body, {
            "x-countersign-client": H.A.tenantId,
          });
          expect(res.status, `${who} ${path}`).toBe(403);
        }
        const other = await H.call(OTHER_OPERATOR, "POST", path, body);
        expect(other.status, `other operator ${path}`).toBe(404);
      }
    });
  });

  describe("access", () => {
    it("refuses client roles and hides clients the operator does not serve", async () => {
      const paths: [string, string][] = [
        ["POST", `/api/ops/agents/${agentA}/retire`],
        ["GET", `/api/ops/agents/${agentA}/activation`],
        ["GET", `/api/ops/agents/${agentA}/skills`],
        ["GET", `/api/ops/agents/${agentA}/builder-catalog`],
        ["GET", `/api/ops/agents/${agentA}/action-catalog`],
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
