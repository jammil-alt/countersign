// The Materials pack through the platform: registered tools, skills and events, and a client
// agent's workflow running `materials.match-lines` on its own invoice lines, with the step's
// skill settings (the threshold) reaching the tool and the agent version recorded on each
// decision. The pack's own tests cover matching in depth (packs/materials).

import { createHash, randomBytes } from "node:crypto";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  docExtraction,
  docLine,
  document,
  stepRun,
  tenantPack,
  transaction,
  vendor,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { catalogItem, itemMatch } from "@countersign/pack-materials";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, FakeWorkflowStep, OPERATOR } from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

function matcherBundle(documentId: string, threshold: number): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Line matcher", role: "matches lines", mission: "know what we buy" },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Match invoice lines to the catalog.",
      skills: [{ skill: "materials.match-lines", settings: { match_confidence_auto: threshold } }],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "match",
              name: "Match the lines",
              kind: "skill",
              skill: "materials.match-lines",
              input: { documentId },
              client: { visible: true, label: "Matched the invoice lines" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("the Materials pack on the platform", () => {
  const H = h as ApiHarness;

  async function invoice(tenantId: string, vendorName: string, lines: string[]) {
    const [v] = await H.t.db
      .insert(vendor)
      .values({ tenantId, name: vendorName, normalizedName: vendorName.toLowerCase() })
      .onConflictDoNothing()
      .returning();
    const vendorId =
      v?.id ??
      (
        await H.t.db
          .select()
          .from(vendor)
          .where(
            and(eq(vendor.tenantId, tenantId), eq(vendor.normalizedName, vendorName.toLowerCase())),
          )
      )[0]?.id;
    const ref = randomBytes(6).toString("hex");
    const [tx] = await H.t.db
      .insert(transaction)
      .values({
        tenantId,
        kind: "bill",
        connector: "upload",
        vendorId,
        total: "100",
        externalId: ref,
      })
      .returning();
    const sha = createHash("sha256").update(ref).digest("hex");
    const [d] = await H.t.db
      .insert(document)
      .values({
        tenantId,
        transactionId: tx?.id ?? null,
        source: "upload",
        storageKey: `tenants/${tenantId}/content/${sha.slice(0, 2)}/${sha}`,
        mimeType: "application/pdf",
        filename: `${ref}.pdf`,
        sizeBytes: 10,
        sha256: sha,
      })
      .returning();
    const [ex] = await H.t.db
      .insert(docExtraction)
      .values({
        tenantId,
        documentId: d?.id as string,
        model: "test-model",
        header: { vendorName },
        subtotal: "100",
        total: "100",
        linesSum: "100",
        totalsMatch: true,
      })
      .returning();
    await H.t.db.insert(docLine).values(
      lines.map((rawDescription, i) => ({
        tenantId,
        extractionId: ex?.id as string,
        lineNo: i + 1,
        rawDescription,
        qty: "1",
        unitPrice: "50",
        extPrice: "50",
      })),
    );
    return d?.id as string;
  }

  async function runMatcher(slug: string, documentId: string, threshold: number) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle: matcherBundle(documentId, threshold),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id as string;
    const versionId = j(created.json).version.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const result = await executeRun(
      { db: H.db, platform: H.platform, transport: new FakeModel(), instances: H.instances },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result).toEqual({ status: "succeeded" });
    const [step] = await H.t.db
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, params.runId), eq(stepRun.nodeId, "match")));
    return { output: j(step?.output), summary: step?.summary, versionId };
  }

  it("registers the pack's tools, skills and events; events show only where it is enabled", () => {
    for (const tool of [
      "materials.catalog.search",
      "materials.catalog.create_item",
      "materials.match_line",
      "materials.match_lines",
      "materials.catalog.duplicates",
    ]) {
      expect(H.platform.tools.get(tool)?.spec.source, tool).toBe("materials");
    }
    expect(H.platform.catalog.get("materials.match-lines")?.requiresPacks).toEqual(["materials"]);
    const types = (packs: string[]) => H.platform.events.list(packs).map((e) => e.type);
    expect(types(["materials"])).toContain("materials.line.matched");
    expect(types([])).not.toContain("materials.line.matched");
  });

  it("runs a client agent's match-lines step on its invoice, recording its version", async () => {
    await H.t.db
      .insert(tenantPack)
      .values({ tenantId: H.A.tenantId, pack: "materials", version: "0.1.0" });
    const first = await invoice(H.A.tenantId, "Northline Plywood", [
      "3/4 BB/BB BALTIC BIRCH 5X5",
      "1/2 BB/BB BALTIC BIRCH 5X5",
    ]);
    const run1 = await runMatcher("line-matcher", first, 0.9);
    expect(run1.output).toMatchObject({ total: 2, newItems: 2, needsReview: 0 });
    expect(run1.summary).toBe("Matched 0 of 2 lines; 0 to review");

    const second = await invoice(H.A.tenantId, "Keystone Lumber", [
      "BALTIC BIRCH PLYWOOD 18MM BB/BB 60X60",
    ]);
    const run2 = await runMatcher("line-matcher-2", second, 0.9);
    expect(run2.output).toMatchObject({ total: 1, matched: 1, needsReview: 0 });
    expect(run2.output.lines[0].method).toBe("rules");

    const items = await H.t.db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, H.A.tenantId));
    expect(items).toHaveLength(2);
    const decisions = await H.t.db
      .select()
      .from(itemMatch)
      .where(eq(itemMatch.tenantId, H.A.tenantId));
    expect(decisions.map((d) => d.agentVersionId).sort()).toEqual(
      [run1.versionId, run1.versionId, run2.versionId].sort(),
    );
    // Nothing reached another client.
    const others = await H.t.db
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.tenantId, H.B.tenantId));
    expect(others).toEqual([]);
  });

  it("takes the threshold from the agent's skill settings", async () => {
    const doc = await invoice(H.A.tenantId, "Cedar Ridge Supply", [
      'BIRCH BALTIC 3/4" 1525X1525MM BB/BB',
    ]);
    // The rules are 0.97 sure; this agent wants 0.99, so a person reviews it.
    const run = await runMatcher("strict-matcher", doc, 0.99);
    expect(run.output).toMatchObject({ total: 1, matched: 0, needsReview: 1 });
    expect(run.output.belowThreshold).toHaveLength(1);
  });
});
