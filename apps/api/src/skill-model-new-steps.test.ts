// Skill model (2026-11-10; docs/plan.md §1.86 "Skill model", the review of `skills/fix`): which
// steps count as new, through the API. A first version is new work (every step new) unless it is a
// fork, which is checked against the template version it copies; a seeded or pack template's first
// version is installed from code and is not. Only a published version counts as already there: a
// draft saved on a draft, and a rollback to a version never published, are checked against the
// live version. The Builder is offered what the palette offers for a new step: no skill that
// writes or of a retired kind, no tool the splits replaced.

import { createClientAgent, createTemplate, publish } from "@countersign/agents";
import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { agent, agentVersion, withOperator } from "@countersign/db";
import { seed } from "@countersign/db/seed";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

/** A step reading a vendor's quote with `materials.read-quote`, a task skill that writes. */
const READ_QUOTE_STEP = {
  id: "read-quote",
  kind: "skill",
  name: "Read the vendor's quote",
  skill: "materials.read-quote",
  input: { quoteRequestId: "{{trigger.quoteRequestId}}", text: "{{trigger.text}}" },
};

/** A Save to records-free change on the testkit, approval on: nothing new-step checks refuse. */
const NOTE_STEP = {
  id: "note",
  kind: "write",
  name: "Note it on the record",
  tool: TESTKIT_UPDATE_TOOL,
  input: { id: "r1", name: "Quote read" },
  checks: { approval: { required: "required" } },
};

/** A v4 agent with one manual process of `steps`, listing `skills`. */
function bundleOf(steps: unknown[], skills: string[] = []) {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Quote reader", role: "Purchasing", mission: "Read vendors' quotes" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
      instructions: "Read quotes as data.",
      skills: skills.map((skill) => ({ skill, settings: {} })),
      extraTools: [TESTKIT_UPDATE_TOOL],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "read",
        name: "Read a quote",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t", on: { type: "manual", input: {} } }],
          steps,
        },
      },
    ],
  };
}

const plain = () => bundleOf([NOTE_STEP]);
const withReadQuote = () => bundleOf([READ_QUOTE_STEP, NOTE_STEP], ["materials.read-quote"]);

/** The error codes of a refusal (`error.details`) or of a saved draft (`errors`). */
const codes = (json: unknown): string[] =>
  ((j(json).error?.details ?? j(json).errors ?? []) as { code: string }[]).map((e) => e.code);

/** The catalog the Builder's model was shown (`<catalog>…</catalog>`). */
function catalogOf(req: LlmRequest | undefined): {
  skills: { id: string }[];
  tools: { id: string }[];
} {
  const text = JSON.stringify(req ?? {});
  const start = text.indexOf("<catalog>\\n") + "<catalog>\\n".length;
  const end = text.indexOf("\\n</catalog>");
  return JSON.parse(JSON.parse(`"${text.slice(start, end)}"`));
}

describe.skipIf(!h)("new steps in a first version", () => {
  const H = h as ApiHarness;

  beforeEach(() => {
    model.requests.length = 0;
  });

  it("refuses a Builder-drafted client agent whose new step uses a skill that writes", async () => {
    const made = await withOperator(H.db, [H.A.tenantId], (tx) =>
      createClientAgent(tx, {
        tenantId: H.A.tenantId,
        slug: "builder-quote-reader",
        bundle: withReadQuote(),
        authorType: "builder",
        changeNote: "Drafted by the Builder",
      }),
    );
    const id = made.agent.id;
    const v = made.version.id;
    // What publish will say is said on the saved draft and refused for a test run.
    const page = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v}/test-run`, {
      workflow: "read",
    });
    expect(page.status, JSON.stringify(page.json)).toBe(422);
    expect(codes(page.json)).toContain("skill_retired");
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(422);
    expect(codes(pub.json)).toContain("skill_retired");
    expect(JSON.stringify(pub.json)).toContain("read-quote");
  });

  it("refuses the same in a template made in the back office, as its first version", async () => {
    const made = await withOperator(H.db, [], (tx) =>
      createTemplate(tx, {
        slug: "quote-reader-template",
        bundle: withReadQuote(),
        authorType: "builder",
      }),
    );
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${made.agent.id}/versions/${made.version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(422);
    expect(codes(pub.json)).toContain("skill_retired");
  });

  it("publishes a first version installed from code with the same step (installed)", async () => {
    const live = await withOperator(H.db, [], async (tx) => {
      const made = await createTemplate(tx, {
        slug: "quote-reader-from-code",
        bundle: withReadQuote(),
        authorType: "pack",
      });
      return publish(tx, {
        agentId: made.agent.id,
        versionId: made.version.id,
        installed: true,
        ctx: H.platform.ctx,
      });
    });
    expect(live.status).toBe("live");
  });

  it("publishes a fork of a template version whose step would be refused as new", async () => {
    const tpl = await withOperator(H.db, [], async (tx) => {
      const made = await createTemplate(tx, {
        slug: "quote-reader-stored",
        bundle: withReadQuote(),
        authorType: "pack",
      });
      await publish(tx, {
        agentId: made.agent.id,
        versionId: made.version.id,
        installed: true,
        ctx: H.platform.ctx,
      });
      return made;
    });
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl.agent.id}/fork`, {
      clientId: H.A.tenantId,
      slug: "quote-reader-fork",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const id = j(fork.json).agent.id as string;
    const v = j(fork.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v}/publish`);
    // Whatever else a client's publish asks for, the forked step is not new.
    expect(codes(pub.json)).not.toContain("skill_retired");
  });

  it("loads the seed, and a fork of a seeded template publishes", async () => {
    await seed(H.t.db);
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, "supervisor")));
    expect(tpl?.liveVersionId).toBeTruthy();
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: H.A.tenantId,
      slug: "supervisor-fork",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const id = j(fork.json).agent.id as string;
    const v = j(fork.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("leaves skills that write and the splits' hidden AI out of what the Builder is offered", async () => {
    model.push({
      toolUse: {
        name: "submit_draft",
        input: {
          summary: "It reads a vendor's quote and extracts the document.",
          gaps: [],
          slug: "builder-reader",
          startFromTemplate: null,
          bundle: bundleOf(
            [
              READ_QUOTE_STEP,
              {
                id: "extract",
                kind: "write",
                name: "Extract the quote document",
                tool: "docs.extract",
                input: { documentId: "{{trigger.documentId}}" },
              },
            ],
            ["materials.read-quote"],
          ),
        },
      },
    });
    const res = await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
      description: "Read vendors' quotes",
      clientId: H.A.tenantId,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const catalog = catalogOf(model.requests[0]);
    const skills = catalog.skills.map((s) => s.id);
    const tools = catalog.tools.map((t) => t.id);
    expect(skills).toContain("materials.read-quote-document");
    expect(skills).not.toContain("materials.read-quote");
    expect(skills).not.toContain("bookkeeping.read-statement");
    // No tool wrapper: the tool it wrapped is a step of its own.
    expect(skills).not.toContain("materials.open-request");
    expect(tools).toContain("docs.reading.record");
    for (const id of ["docs.extract", "docs.read", "materials.match_line"]) {
      expect(tools).not.toContain(id);
    }
    expect(tools.some((t) => t.startsWith("account."))).toBe(false);
    const out = j(res.json);
    const steps = out.bundle.workflows[0].workflow.steps as { skill?: string; tool?: string }[];
    expect(steps.some((s) => s.skill === "materials.read-quote")).toBe(false);
    expect(steps.some((s) => s.tool === "docs.extract")).toBe(false);
    expect(JSON.stringify(out.gaps)).toContain("materials.read-quote");
    expect(JSON.stringify(out.gaps)).toContain("docs.extract");
  });
});

describe.skipIf(!h)("new steps in a draft that was never published", () => {
  const H = h as ApiHarness;

  /** A template with `plain()` live as v1 and `withReadQuote()` saved on it as a v2 draft. */
  async function liveWithDraft(slug: string) {
    const made = await withOperator(H.db, [], async (tx) => {
      const m = await createTemplate(tx, { slug, bundle: plain() });
      await publish(tx, { agentId: m.agent.id, versionId: m.version.id, ctx: H.platform.ctx });
      return m;
    });
    const id = made.agent.id;
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: withReadQuote(),
      parentVersionId: made.version.id,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(codes(saved.json)).toContain("skill_retired");
    return { id, v1: made.version.id, v2: j(saved.json).version.id as string };
  }

  it("refuses a rollback to a draft that adds a step using a skill that writes", async () => {
    const { id, v2 } = await liveWithDraft("rollback-to-draft");
    const back = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/rollback`, {
      versionId: v2,
    });
    expect(back.status, JSON.stringify(back.json)).toBe(422);
    expect(codes(back.json)).toContain("skill_retired");
    const [row] = await H.t.db.select().from(agent).where(eq(agent.id, id));
    const live = await H.t.db.select().from(agentVersion).where(eq(agentVersion.agentId, id));
    expect(live.find((v) => v.id === row?.liveVersionId)?.version).toBe(1);
  });

  it("still restores a published version whose step a new one couldn't use", async () => {
    // v1 installed from code holds the step; v2 (published) drops it; rolling back restores it.
    const made = await withOperator(H.db, [], async (tx) => {
      const m = await createTemplate(tx, {
        slug: "rollback-to-published",
        bundle: withReadQuote(),
      });
      await publish(tx, {
        agentId: m.agent.id,
        versionId: m.version.id,
        installed: true,
        ctx: H.platform.ctx,
      });
      return m;
    });
    const id = made.agent.id;
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: plain(),
      parentVersionId: made.version.id,
    });
    const v2 = j(saved.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v2}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const back = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/rollback`, {
      versionId: made.version.id,
    });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
  });

  it("refuses a draft saved on a draft that added the step, at publish", async () => {
    const { id, v2 } = await liveWithDraft("draft-on-draft");
    const next = withReadQuote();
    next.definition.instructions = "Read quotes as data, carefully.";
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: next,
      parentVersionId: v2,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(codes(saved.json)).toContain("skill_retired");
    const v3 = j(saved.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v3}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(422);
    expect(codes(pub.json)).toContain("skill_retired");
  });
});
