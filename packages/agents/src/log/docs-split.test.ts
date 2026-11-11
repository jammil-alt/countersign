// Skill model (2026-11-10): the golden invoices (fixtures/invoices) through the split chain,
//   Read document (AI)  →  Check totals (deterministic)  →  Save to records: record the reading,
// judged by the same tolerance as `docs.extract`'s golden test (header exact; qty and prices within
// $0.01; descriptions ≥ 0.9 similar). The model's answers are HAND-WRITTEN replays (no API key
// here), each the invoice's `*.expected.json`, as `docs.extract`'s are; rebuild them after a change
// to the skill's instructions, schema or the task prompt:
//   WRITE_SKILL_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/agents exec vitest run src/log/docs-split.test.ts
// then delete the files whose hashes no longer appear. Re-record with a key: LLM_MODE=record.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, ensureUploadConnection, MemoryObjectStore } from "@countersign/connectors";
import type { InvoiceExtraction } from "@countersign/core";
import { agent, docExtraction, docLine, document, modelCall } from "@countersign/db";
import { goldenProblems, storeDocument } from "@countersign/documents";
import { fakeMessage, type LlmTransport, withRecording } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, fork, publish } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { FINISH_TOOL, runAgent } from "../runtime/run-agent";
import { DOCS_SKILLS } from "../tools/docs";
import {
  CHECK_TOTALS_SKILL,
  DOCS_SPLIT_SKILLS,
  docsReadingRecord,
  READ_DOCUMENT_SKILL,
} from "../tools/docs-split";
import type { ToolInvocation } from "../tools/types";
import {
  createHarness,
  type Harness,
  makeBundle,
  undeclaredModelCall,
} from "./harness.test-helper";
import { dbModelCalls } from "./model-calls";
import { createDbPorts } from "./ports";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

const INVOICES = resolve(DEFAULT_FIXTURE_DIR, "../invoices");
const GOLDEN = [
  { stem: "northline-20418", file: "northline-20418.pdf", mimeType: "application/pdf" },
  { stem: "cedar-ridge-7731", file: "cedar-ridge-7731.png", mimeType: "image/png" },
  { stem: "keystone-55102", file: "keystone-55102.pdf", mimeType: "application/pdf" },
] as const;
const WRITE = process.env.WRITE_SKILL_FIXTURES === "1";
const FIXED_IDS: Record<string, string> = {
  "northline-20418": "0193f000-0000-7000-8000-000000020418",
  "cedar-ridge-7731": "0193f000-0000-7000-8000-000000007731",
  "keystone-55102": "0193f000-0000-7000-8000-000000055102",
};

const expectedOf = (stem: string) =>
  JSON.parse(readFileSync(resolve(INVOICES, `${stem}.expected.json`), "utf8")) as InvoiceExtraction;

/**
 * Replay; or, writing, a model that finishes with the invoice's expected reading (found by the
 * document id in the request's input JSON), stored marked hand-written.
 */
function transportFor(stemOf: (requestText: string) => string | undefined): LlmTransport {
  const store = fileFixtureStore();
  if (!WRITE) return withRecording(null, { mode: "replay", store });
  return withRecording(
    {
      async create(request) {
        const stem = stemOf(JSON.stringify(request.messages));
        if (!stem) throw new Error("no golden invoice in this request");
        const inv = { stem };
        const expected = expectedOf(stem);
        const msg = fakeMessage(
          request.model,
          [
            {
              type: "tool_use",
              id: `toolu_handwritten_skill_${inv.stem}`,
              name: FINISH_TOOL,
              input: expected,
              caller: { type: "direct" },
            } as never,
          ],
          "tool_use",
          {
            input: 2400 * expected.header.pageCount + 1500,
            output: 90 * expected.lines.length + 400,
          },
        );
        return { ...msg, id: `msg_handwritten_skill_${inv.stem}` };
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
}

describe.skipIf(!harness)("Read document → Check totals → record the reading (golden)", () => {
  const h = harness as Harness;
  const content = new ContentStore(new MemoryObjectStore());
  const catalog = new SkillCatalog(DOCS_SKILLS, h.tools);
  const documents = new Map<string, string>();
  const transport = transportFor((text) => [...documents].find(([, id]) => text.includes(id))?.[0]);
  const ports = createDbPorts(h.db, {
    documents: { content, transport },
    modelCalls: dbModelCalls(h.db, { bodies: new MemoryObjectStore() }),
  });
  const deps = () => ({
    ports,
    tools: h.tools,
    catalog,
    transport,
    onUndeclaredModelCall: undeclaredModelCall,
  });
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const bundle = makeBundle({
      skills: [
        { skill: READ_DOCUMENT_SKILL, settings: {} },
        { skill: CHECK_TOTALS_SKILL, settings: {} },
      ],
      workflows: [],
    });
    const ctx = { tools: h.tools, catalog };
    const tv = await h.ops(async (tx) => {
      const t = await createTemplate(tx, { slug: "reader", bundle });
      return publish(tx, { agentId: t.agent.id, versionId: t.version.id, ctx });
    });
    const forked = await h.ops(async (tx) => {
      const f = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "reader",
        templateVersionId: tv.id,
      });
      await publish(tx, { agentId: f.agent.id, versionId: f.version.id, ctx });
      await tx.update(agent).set({ runStatus: "active" }).where(eq(agent.id, f.agent.id));
      return f;
    });
    agentId = forked.agent.id;
    versionId = forked.version.id;
    for (const inv of GOLDEN) {
      const id = await h.client(h.A, async (tx) => {
        const conn = await ensureUploadConnection(tx, h.A.tenantId);
        const stored = await storeDocument(tx, content, {
          tenantId: h.A.tenantId,
          source: "upload",
          connectionId: conn.id,
          bytes: new Uint8Array(readFileSync(resolve(INVOICES, inv.file))),
          filename: inv.file,
          mimeType: inv.mimeType,
        });
        // A fixed id: the model's request carries it (the input JSON), so the replay finds it.
        const fixed = FIXED_IDS[inv.stem] as string;
        await tx.update(document).set({ id: fixed }).where(eq(document.id, stored.document.id));
        return fixed;
      });
      documents.set(inv.stem, id);
    }
  });

  it("the split skills are an AI one and a deterministic one", () => {
    const [read, check] = DOCS_SPLIT_SKILLS;
    expect(read?.mode).toBe("task");
    expect(read?.model?.id).toBeTruthy();
    expect(check?.mode).toBe("tool");
    expect(check?.tools).toEqual([check?.handler]);
  });

  for (const inv of GOLDEN) {
    it(`${inv.stem}: reads within the golden tolerance, checks the totals, and records it`, async () => {
      const documentId = documents.get(inv.stem) as string;
      const r = await h.client(h.A, (tx) =>
        createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "manual", mode: "live" }),
      );
      // 1. Read document (AI): the file is attached to the model call; nothing is written.
      const read = await runAgent(deps(), {
        tenantId: h.A.tenantId,
        agentVersionId: versionId,
        skill: READ_DOCUMENT_SKILL,
        input: { documentId },
        runId: r.id,
        stepId: "read",
      });
      expect(read.status, read.status === "failed" ? read.error : "").toBe("succeeded");
      if (read.status !== "succeeded") return;
      const reading = read.output as InvoiceExtraction;
      expect(goldenProblems(reading, expectedOf(inv.stem))).toEqual([]);
      expect(read.modelCalls).toBe(1);
      const before = await h.client(h.A, (tx) =>
        tx.select().from(docExtraction).where(eq(docExtraction.documentId, documentId)),
      );
      expect(before).toHaveLength(0);
      // The step's model call carries the document as a block (its bytes left out of the body).
      const calls = await h.client(h.A, (tx) =>
        tx.select().from(modelCall).where(eq(modelCall.stepRunId, read.stepRunId)),
      );
      expect(calls).toHaveLength(1);

      // 2. Check totals (deterministic): the golden invoices add up.
      const check = await runAgent(deps(), {
        tenantId: h.A.tenantId,
        agentVersionId: versionId,
        skill: CHECK_TOTALS_SKILL,
        input: { reading },
        runId: r.id,
        stepId: "check",
      });
      expect(check.status).toBe("succeeded");
      if (check.status !== "succeeded") return;
      expect(check.modelCalls).toBe(0);
      expect(check.output).toMatchObject({ totalsMatch: true, problems: [] });

      // 3. Save to records: the reading becomes the document's extraction, with its lines.
      const saved = await docsReadingRecord.run({ documentId, reading, as: "invoice" }, {
        tenantId: h.A.tenantId,
        agentVersionId: versionId,
        mode: "live",
        documents: ports.documents,
      } as unknown as ToolInvocation);
      expect(saved).toMatchObject({ status: "extracted", totalsMatch: true });
      const [x] = await h.client(h.A, (tx) =>
        tx.select().from(docExtraction).where(eq(docExtraction.documentId, documentId)),
      );
      expect(x).toMatchObject({ model: READ_DOCUMENT_SKILL, agentVersionId: versionId });
      const lines = await h.client(h.A, (tx) =>
        tx
          .select()
          .from(docLine)
          .where(and(eq(docLine.tenantId, h.A.tenantId), eq(docLine.extractionId, x?.id ?? ""))),
      );
      expect(lines).toHaveLength(expectedOf(inv.stem).lines.length);
      const [doc] = await h.client(h.A, (tx) =>
        tx.select().from(document).where(eq(document.id, documentId)),
      );
      expect(doc?.status).toBe("extracted");
    });
  }

  it("Check totals catches totals that don't add up, and recording marks the document for review", async () => {
    const reading = { ...expectedOf("northline-20418"), total: "1.00" };
    const r = await h.client(h.A, (tx) =>
      createRun(tx, { tenantId: h.A.tenantId, agentId, workflowSlug: "manual", mode: "live" }),
    );
    const check = await runAgent(deps(), {
      tenantId: h.A.tenantId,
      agentVersionId: versionId,
      skill: CHECK_TOTALS_SKILL,
      input: { reading },
      runId: r.id,
      stepId: "check",
    });
    expect(check.status).toBe("succeeded");
    if (check.status !== "succeeded") return;
    expect(check.output).toMatchObject({ totalsMatch: false });
    const documentId = documents.get("northline-20418") as string;
    const saved = await ports.documents?.record?.(h.A.tenantId, {
      documentId,
      reading,
      readBy: READ_DOCUMENT_SKILL,
      agentVersionId: versionId,
      testRun: false,
      asQuote: false,
    });
    // The process routes it (an If step, then a person); recording raises no inbox item itself.
    expect(saved).toMatchObject({ status: "needs_review", totalsMatch: false });
  });

  it("another client's document can't be attached", async () => {
    const documentId = documents.get("cedar-ridge-7731") as string;
    await expect(ports.documents?.file?.(h.B.tenantId, documentId)).rejects.toThrow(/not found/);
  });
});
