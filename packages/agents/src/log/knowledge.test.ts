// `knowledge.search` through the agent runtime: a client agent's built-in skill finds the client's
// FAQs and its own memory notes with their sources, never another client's knowledge; the tool's
// input and output are checked by its Zod schemas.

import { agent, withTenant } from "@countersign/db";
import { createKnowledgeEntry } from "@countersign/documents";
import { withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { runAgent } from "../runtime/run-agent";
import {
  KNOWLEDGE_SKILLS,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
  knowledgeSearch,
} from "../tools/knowledge";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createDbPorts } from "./ports";
import { createRun } from "./run-log";

describe("knowledge.search schemas", () => {
  it("checks input: a query is required, the limit is bounded and defaults to 5", () => {
    expect(KnowledgeSearchInput.parse({ query: " hours " })).toEqual({ query: "hours", limit: 5 });
    expect(KnowledgeSearchInput.safeParse({ query: "" }).success).toBe(false);
    expect(KnowledgeSearchInput.safeParse({ query: "x", limit: 21 }).success).toBe(false);
    expect(KnowledgeSearchInput.safeParse({ query: "x".repeat(501) }).success).toBe(false);
  });

  it("checks output: every result cites at least one record", () => {
    const ok = {
      query: "q",
      count: 1,
      results: [{ kind: "faq", id: "e", title: "t", excerpt: "x", score: 0.1, sources: ["e"] }],
      sources: ["e"],
    };
    expect(KnowledgeSearchOutput.safeParse(ok).success).toBe(true);
    const bad = { ...ok, results: [{ ...ok.results[0], sources: [] }] };
    expect(KnowledgeSearchOutput.safeParse(bad).success).toBe(false);
    expect(knowledgeSearch.spec).toMatchObject({ sideEffect: "none", verb: "read" });
  });
});

const harness = await createHarness();
afterAll(() => harness?.close());

describe.skipIf(!harness)("knowledge.search in the runtime", () => {
  const h = harness as Harness;
  const catalog = new SkillCatalog(KNOWLEDGE_SKILLS, h.tools);
  const ports = createDbPorts(h.db);
  const transport = withRecording(null, { mode: "replay", store: fileFixtureStore() });
  const deps = () => ({ ports, tools: h.tools, catalog, transport });
  let agentId = "";
  let versionId = "";
  let faq = { id: "", versionId: "" };

  beforeAll(async () => {
    const bundle = makeBundle({
      skills: [{ skill: "knowledge.search", settings: {} }],
      workflows: [],
    });
    const ctx = { tools: h.tools, catalog };
    const tv = await h.ops(async (tx) => {
      const t = await createTemplate(tx, { slug: "front-desk", bundle });
      return publish(tx, { agentId: t.agent.id, versionId: t.version.id, ctx });
    });
    const forked = await h.ops(async (tx) => {
      const f = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "front-desk",
        templateVersionId: tv.id,
      });
      await publish(tx, { agentId: f.agent.id, versionId: f.version.id, ctx });
      await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, f.agent.id));
      return f;
    });
    agentId = forked.agent.id;
    versionId = forked.version.id;
    const author = { id: null, role: "operator" as const };
    faq = await withTenant(h.db, h.A.tenantId, (tx) =>
      createKnowledgeEntry(tx, h.A.tenantId, {
        kind: "faq",
        title: "Delivery days",
        body: "We deliver on Tuesdays and Thursdays. Rush delivery costs extra.",
        author,
      }),
    );
    await withTenant(h.db, h.B.tenantId, (tx) =>
      createKnowledgeEntry(tx, h.B.tenantId, {
        kind: "faq",
        title: "Delivery on weekends",
        body: "Client B delivers on Saturdays.",
        author,
      }),
    );
    await ports.platform.writeMemory(h.A.tenantId, {
      agentId,
      note: "Hollis wants us to deliver before 10am.",
      scope: "agent",
    });
  });

  async function search(input: unknown) {
    const r = await withTenant(h.db, h.A.tenantId, (tx) =>
      createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "manual", mode: "live" }),
    );
    return runAgent(deps(), {
      tenantId: h.A.tenantId,
      agentVersionId: versionId,
      skill: "knowledge.search",
      input,
      runId: r.id,
      stepId: "step-search",
    });
  }

  it("finds the client's FAQ and the agent's own note, with sources, and nothing of client B", async () => {
    const result = await search({ query: "When do you deliver?" });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    const out = KnowledgeSearchOutput.parse(result.output);
    expect(out.results.map((r) => r.kind).sort()).toEqual(["faq", "memory"]);
    const hit = out.results.find((r) => r.kind === "faq");
    expect(hit?.sources).toEqual([faq.id, faq.versionId]);
    expect(out.results.map((r) => r.title)).not.toContain("Delivery on weekends");
    expect(result.sources).toEqual(expect.arrayContaining([faq.id, faq.versionId]));
    expect(result.summary).toBe("Looked up 2 things we know about: When do you deliver?");
  });

  it("refuses input its schema rejects", async () => {
    const result = await search({ query: "" });
    expect(result.status).toBe("failed");
  });
});
