// Skill model (2026-11-10): the hidden AI split into Deterministic and AI skills, and writes moved
// to write steps (docs/plan.md §1.86 "Skill model"). Without a database: every new built-in is
// labelled, none writes, and the "Process a vendor invoice" pattern validates against the
// platform's registries. With one: the pattern runs end to end on a golden invoice, the two AI
// skills on HAND-WRITTEN replays (fixtures/llm), the deterministic ones with no model, and every
// change is a write step. Rebuild the Match the unmatched answer after changing its prompt:
//   WRITE_SKILL_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/api exec vitest run src/skill-splits.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, ensureUploadConnection } from "@countersign/connectors";
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  isToolWrapper,
  newSkillVersionProblems,
  processes,
  skillKind,
  toolLookup,
} from "@countersign/core";
import {
  agent,
  docExtraction,
  document,
  stepRun,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import {
  fakeMessage,
  type LlmRequest,
  type LlmTransport,
  ReplayMissError,
  withRecording,
} from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { categorizeSteps, leftoverSteps } from "@countersign/pack-bookkeeping";
import { forumReplySteps, socialPostSteps, weeklyReportSteps } from "@countersign/pack-marketing";
import {
  catalogItem,
  itemMatch,
  parseLine,
  readQuoteSteps,
  reviewMergeSteps,
  VENDOR_INVOICE_SKILLS,
  VENDOR_INVOICE_WRITES,
  vendorInvoiceProcess,
} from "@countersign/pack-materials";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, FakeWorkflowStep, OPERATOR } from "./api.test-helper";
import { createPlatform, deploymentConnectors } from "./platform";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const lookup = toolLookup(platform.tools.specs());

/** The split's new built-ins and their kinds. */
const SPLIT = {
  "docs.read-document": "ai",
  "docs.check-totals": "deterministic",
  "materials.lookup-existing": "deterministic",
  "materials.match-unmatched": "ai",
  "materials.check-matches": "deterministic",
  "materials.compare-prices": "deterministic",
} as const;

describe("the split skills on the platform", () => {
  it("labels each one by its kind, keeps it in the Library, and none writes", () => {
    for (const [id, kind] of Object.entries(SPLIT)) {
      const def = platform.catalog.get(id);
      expect(def, id).toBeDefined();
      if (!def) continue;
      expect(skillKind(def, lookup), id).toBe(kind);
      expect(isToolWrapper(def), id).toBe(false);
      expect(newSkillVersionProblems(def, lookup), id).toEqual([]);
    }
  });

  it("the old built-ins stay registered, unchanged in what they are", () => {
    for (const id of ["docs.extract", "docs.read", "materials.match-lines"]) {
      const def = platform.catalog.get(id);
      expect(def && skillKind(def, lookup), id).toBe("ai");
    }
  });

  it("Save to records steps are internal writes; the pattern validates", () => {
    for (const tool of [
      "docs.reading.record",
      "materials.matches.record",
      "materials.prices.record",
    ]) {
      expect(platform.tools.get(tool)?.spec.sideEffect, tool).toBe("internal");
    }
    const result = processes.validateAnyBundle(AnyAgentBundle.parse(clerkBundle()), {
      skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
      tools: platform.tools.specs(),
      events: platform.events.byType(),
    });
    expect(result.errors).toEqual([]);
  });
});

function clerkBundle(): AnyAgentBundleInput {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Invoice clerk", role: "reads invoices", mission: "know what we buy" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
      instructions: "Read vendor invoices and match their lines.",
      skills: VENDOR_INVOICE_SKILLS.map((skill) => ({ skill })),
      extraTools: [...VENDOR_INVOICE_WRITES],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "1.00" },
      memory: { enabled: false },
    },
    workflows: [
      { slug: "invoice", name: "Process a vendor invoice", workflow: vendorInvoiceProcess() },
    ],
  } as unknown as AnyAgentBundleInput;
}

/** A pattern as a process of its own: a manual trigger with the ids it needs, then its steps. */
function patternBundle(name: string, steps: processes.Step[]): AnyAgentBundleInput {
  const skills = new Set<string>();
  const tools = new Set<string>();
  processes.walkSteps({ schemaVersion: 4, triggers: [], steps } as never, ({ step }) => {
    if (step.kind === "skill") skills.add(step.skill);
    if ((step.kind === "write" || step.kind === "read") && step.tool) tools.add(step.tool);
  });
  const bundle = clerkBundle() as J;
  bundle.definition.skills = [...skills].map((skill) => ({ skill }));
  bundle.definition.extraTools = [...tools];
  bundle.workflows = [
    {
      slug: "pattern",
      name,
      workflow: {
        schemaVersion: 4,
        triggers: [
          {
            id: "trg-pattern",
            on: {
              type: "manual",
              input: {
                type: "object",
                properties: {
                  ...Object.fromEntries(
                    ["documentId", "quoteRequestId", "reconciliationId", "reportId"].map((k) => [
                      k,
                      { type: "string", format: "uuid" },
                    ]),
                  ),
                  bankTxnIds: { type: "array", items: { type: "string", format: "uuid" } },
                },
              },
            },
          },
        ],
        steps,
      },
    },
  ];
  return bundle;
}

describe("the replacement patterns", () => {
  const PATTERNS: Record<string, processes.Step[]> = {
    "Read a vendor's quote": readQuoteSteps({
      quoteRequestId: "{{trigger.quoteRequestId}}",
      documentId: "{{trigger.documentId}}",
    }),
    "Find duplicate catalog items": reviewMergeSteps(),
    "Categorize bank transactions": categorizeSteps("{{trigger.bankTxnIds}}"),
    "Explain what a reconciliation left": leftoverSteps("{{trigger.reconciliationId}}"),
    "The weekly site report": weeklyReportSteps(),
    "A forum reply": forumReplySteps({
      id: "41000000",
      url: "https://news.ycombinator.com/item?id=41000000",
      title: "Ask HN: approval workflows",
    }),
    "A LinkedIn post": socialPostSteps("{{trigger.reportId}}"),
  };

  for (const [name, steps] of Object.entries(PATTERNS)) {
    it(`${name}: validates, every model skill writes nothing, every change a write step`, () => {
      const result = processes.validateAnyBundle(AnyAgentBundle.parse(patternBundle(name, steps)), {
        skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
        tools: platform.tools.specs(),
        events: platform.events.byType(),
      });
      expect(result.errors).toEqual([]);
      processes.walkSteps({ schemaVersion: 4, triggers: [], steps } as never, ({ step }) => {
        if (step.kind !== "skill") return;
        const def = platform.catalog.get(step.skill);
        expect(def, step.skill).toBeDefined();
        if (def) expect(newSkillVersionProblems(def, lookup), step.skill).toEqual([]);
      });
    });
  }

  it("every AI replacement is a task skill on a priced model, with no tools that write", () => {
    const replacements = [
      "materials.read-quote-document",
      "materials.choose-merges",
      "bookkeeping.propose-accounts",
      "bookkeeping.suggest-matches",
      "bookkeeping.read-statement-document",
      "marketing.write-report",
      "marketing.write-titles",
      "marketing.write-article",
      "marketing.write-forum-reply",
      "marketing.write-post",
    ];
    for (const id of replacements) {
      const def = platform.catalog.get(id);
      expect(def?.mode, id).toBe("task");
      expect(def && skillKind(def, lookup), id).toBe("ai");
      expect(def && newSkillVersionProblems(def, lookup), id).toEqual([]);
    }
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

const WRITE = process.env.WRITE_SKILL_FIXTURES === "1";
const INVOICE = resolve(DEFAULT_FIXTURE_DIR, "../invoices/northline-20418.pdf");
// The ids the model's requests carry, fixed so the recorded answers replay.
const DOCUMENT_ID = "0193f000-0000-7000-8000-000000020418";
const ITEMS = [
  { id: "0193f000-0000-7000-8000-0000000c0001", text: 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB' },
  { id: "0193f000-0000-7000-8000-0000000c0002", text: 'MAPLE PLYWOOD 3/4" 4X8 PREFINISHED' },
  { id: "0193f000-0000-7000-8000-0000000c0003", text: 'MDF 5/8" 49X97' },
  { id: "0193f000-0000-7000-8000-0000000c0004", text: 'MELAMINE 3/4" 4X8' },
  { id: "0193f000-0000-7000-8000-0000000c0005", text: 'MELAMINE 3/4" 4X8 BLACK' },
  { id: "0193f000-0000-7000-8000-0000000c0006", text: "HARDBOARD 4X8" },
];

/**
 * Replay; writing, a miss on Match the unmatched is answered by hand (each open line matched to
 * its first candidate at 0.95, else unsure) and stored marked hand-written.
 */
function transportFor(): LlmTransport {
  const store = fileFixtureStore();
  const replay = withRecording(null, { mode: "replay", store });
  const writer = withRecording(
    {
      async create(request: LlmRequest) {
        // The task input follows its first blank line, as JSON.
        const first = request.messages[0]?.content;
        const block = Array.isArray(first) ? first.find((b) => b.type === "text") : undefined;
        const text = block && "text" in block ? block.text : "";
        const input = JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as {
          input: { lines: { lineNo: number; candidates: { catalogItemId: string }[] }[] };
        };
        const answers = input.input.lines.map((l) => ({
          lineNo: l.lineNo,
          decision: l.candidates[0] ? "matched" : "unsure",
          catalogItemId: l.candidates[0]?.catalogItemId ?? null,
          confidence: 0.95,
          hingeAttribute: null,
        }));
        return fakeMessage(
          request.model,
          [
            {
              type: "tool_use",
              id: "toolu_handwritten_match_unmatched",
              name: "finish",
              input: { answers },
              caller: { type: "direct" },
            } as never,
          ],
          "tool_use",
          { input: 900, output: 60 * answers.length + 40 },
        );
      },
    },
    {
      mode: "record",
      store: {
        read: store.read,
        write: (call) => store.write({ ...call, handWritten: true } as typeof call),
      },
    },
  );
  return {
    async create(request, options) {
      try {
        return await replay.create(request, options);
      } catch (error) {
        if (WRITE && error instanceof ReplayMissError) return writer.create(request, options);
        throw error;
      }
    },
  };
}

describe.skipIf(!h)("Process a vendor invoice, split", () => {
  const H = h as ApiHarness;

  it("reads, checks, matches, vetoes and records the golden invoice, every change a write step", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/materials/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const tenantId = H.A.tenantId;
    const content = new ContentStore(H.objects);
    // The vendor's bill, its document (the golden invoice) and a small catalog.
    const [v] = await H.t.db
      .insert(vendor)
      .values({
        tenantId,
        name: "Northline Panel Supply",
        normalizedName: "northline panel supply",
      })
      .returning();
    const [bill] = await H.t.db
      .insert(transaction)
      .values({
        tenantId,
        kind: "bill",
        connector: "upload",
        vendorId: v?.id ?? null,
        total: "9742.35",
        externalId: "northline-20418",
      })
      .returning();
    await withTenant(H.db, tenantId, async (tx) => {
      const conn = await ensureUploadConnection(tx, tenantId);
      const stored = await storeDocument(tx, content, {
        tenantId,
        source: "upload",
        connectionId: conn.id,
        bytes: new Uint8Array(readFileSync(INVOICE)),
        filename: "northline-20418.pdf",
        mimeType: "application/pdf",
      });
      await tx
        .update(document)
        .set({ id: DOCUMENT_ID, transactionId: bill?.id ?? null })
        .where(eq(document.id, stored.document.id));
    });
    for (const item of ITEMS) {
      const p = parseLine(item.text);
      await H.t.db.insert(catalogItem).values({
        id: item.id,
        tenantId,
        category: p.category,
        canonicalName: item.text,
        attributes: p.attributes,
        standardUom: p.standardUom,
      } as never);
    }

    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug: "invoice-clerk",
      bundle: AnyAgentBundle.parse(clerkBundle()),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = (created.json as J).agent.id as string;
    const versionId = (created.json as J).version.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "invoice",
      input: { documentId: DOCUMENT_ID },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get((res.json as J).runId);
    if (!params) throw new Error("not started");
    await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: transportFor(),
        instances: H.instances,
        documents: { content },
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    const step = (id: string) => steps.find((s) => s.nodeId === id);
    const out = (id: string): J => step(id)?.output ?? {};
    const failed = steps.filter((s) => s.status === "failed");
    expect(failed.map((s) => `${s.nodeId}: ${JSON.stringify(s.output)}`)).toEqual([]);

    // Read document (AI) answered the golden reading; Check totals (no model) found it adds up.
    expect(step("read")?.status).toBe("succeeded");
    expect(out("totals").totalsMatch).toBe(true);
    // Save to records: the reading is the document's extraction, made by the skill.
    const [x] = await H.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, DOCUMENT_ID));
    expect(x?.model).toBe("docs.read-document");

    // Look up existing settled what the rules could; the rest went to the model, then the check.
    const looked = out("lookup");
    // Two lines left open (a candidate states less, or lacks a required attribute).
    expect(looked.open.map((l: J) => l.lineNo)).toEqual([5, 6]);
    // Match the unmatched (AI, one model call) answered both; nothing was recorded by it.
    expect(step("match")?.status).toBe("succeeded");
    expect(out("match").answers).toHaveLength(2);
    expect(looked.lines).toHaveLength(6);
    const baltic = looked.lines.find((l: J) => l.lineNo === 1);
    expect(baltic).toMatchObject({
      decision: "matched",
      method: "rules",
      catalogItemId: ITEMS[0]?.id,
    });
    const checked = out("check");
    expect(checked).toMatchObject({ total: 6, matched: 4, newItems: 2, needsReview: 0 });
    // Line 5 matched the plain melamine sheet, never the black one (its face differs).
    expect(checked.lines.find((l: J) => l.lineNo === 5)).toMatchObject({
      decision: "matched",
      method: "llm",
      catalogItemId: ITEMS[3]?.id,
    });
    // Save to records ran as a write step, after the check.
    expect(out("save-open").recorded).toBe(6);
    // Every line has a decision on record, by this agent version.
    const matches = await H.t.db
      .select()
      .from(itemMatch)
      .where(and(eq(itemMatch.tenantId, tenantId)));
    expect(matches.length).toBeGreaterThanOrEqual(6);
    expect(matches.every((m) => m.agentVersionId === versionId)).toBe(true);
    // No decision contradicts the hard rules: a matched line's item agrees on every key attribute.
    for (const line of checked.lines as J[]) {
      if (line.decision !== "matched") continue;
      const cand = (line.candidates as J[]).find((c) => c.catalogItemId === line.catalogItemId);
      if (cand) expect(cand.vetoed, line.lineNo).toBe(false);
    }
  });
});
