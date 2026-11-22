// builder-plan.md B0 and B1 through the API: try a build's draft on a real example in the POC test
// (a Sandbox document for a template, an input for a skill), run once as a test that writes
// nothing; keep it (a required case, its result the expected answer) or discard it. A try waiting
// to be kept is not a case and its run is not the latest run; a kept one is what the gate counts.
// A failing case says why, on the build and to the Builder.

import type { BuildDetail } from "@countersign/core";
import {
  build,
  docExtraction,
  document,
  externalAction,
  tenant,
  testCase,
  transaction,
  vendor,
} from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";
import { MemoryTestSuiteJobs } from "./testbench/instances";
import { executeSuite, type SuiteParams } from "./testbench/suite";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const jobs = new MemoryTestSuiteJobs();
const model = new FakeModel();
const h = await createApiHarness({ llm: model, testSuites: jobs });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const skillDef = {
  schemaVersion: 1,
  id: "custom:same-item-try",
  name: "Same item",
  description: "Says whether two descriptions name the same item",
  category: "matching",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Compare the two descriptions.",
  tools: [],
  input: {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
  },
  output: {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  },
};

const says = (verdict: string): FakeTurn => ({ toolUse: { name: "finish", input: { verdict } } });

describe.skipIf(!h)("trying a build's draft on real examples (builder-plan.md B1)", () => {
  const H = h as ApiHarness;
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as BuildDetail;
  };
  const runLatest = async (transport: FakeModel = new FakeModel()) => {
    const params = jobs.started.at(-1) as SuiteParams;
    await executeSuite({ db: H.db, platform: H.platform, transport }, params, {
      do: (_name, fn) => fn(),
    });
    return params;
  };

  let templateId = "";
  let templateBuild = "";
  let docId = "";

  beforeAll(async () => {
    // Client B is the Sandbox: a shared template case runs there.
    await H.t.db
      .update(tenant)
      .set({
        settings: { connectors_offered: ["testkit"], approvals: { undoSeconds: 0 }, sandbox: true },
      })
      .where(eq(tenant.id, H.B.tenantId));
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "try-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    templateId = j(created.json).agent.id;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "agent", title: "Try clerk", phase: "poc", agentId: templateId })
      .returning();
    templateBuild = row?.id as string;
    // A document uploaded to the Sandbox (as the back office's quiet upload stores one).
    const [doc] = await H.t.db
      .insert(document)
      .values({
        tenantId: H.B.tenantId,
        source: "upload",
        storageKey: "try/invoice-1042.pdf",
        mimeType: "application/pdf",
        filename: "invoice-1042.pdf",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      })
      .returning();
    docId = doc?.id as string;
  });

  it("tries a template on a Sandbox document, keeps the result, and the gate counts it", async () => {
    let b = await ok("GET", `/api/ops/builds/${templateBuild}`);
    expect(b.poc).toMatchObject({ mode: "suite", cases: 0, tries: [] });
    expect(b.poc?.trySandbox).toEqual({ id: H.B.tenantId, name: "Client B" });

    // A document of another client is refused; a client role never reaches the route.
    const [elsewhere] = await H.t.db
      .insert(document)
      .values({
        tenantId: H.A.tenantId,
        source: "upload",
        storageKey: "try/a.pdf",
        mimeType: "application/pdf",
        filename: "a.pdf",
        sizeBytes: 10,
        sha256: "b".repeat(64),
      })
      .returning();
    const refused = await H.call(OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries`, {
      documentId: elsewhere?.id,
    });
    expect(refused.status).toBe(404);
    expect(
      (
        await H.call(admin("b"), "POST", `/api/ops/builds/${templateBuild}/tries`, {
          documentId: docId,
        })
      ).status,
    ).toBe(403);

    b = await ok("POST", `/api/ops/builds/${templateBuild}/tries`, { documentId: docId });
    const params = jobs.started.at(-1) as SuiteParams;
    expect(params).toMatchObject({ partial: true, runTenantId: H.B.tenantId });
    expect(params.caseIds).toHaveLength(1);
    expect(b.poc?.tries).toMatchObject([
      { name: "Try: invoice-1042.pdf", status: "running", current: true },
    ]);
    // A try is not a case yet, and its run is not the latest run.
    expect(b.poc).toMatchObject({ cases: 0, latest: null, passed: false });
    const [made] = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.id, params.caseIds[0] as string));
    expect(made).toMatchObject({
      required: false,
      tenantId: null,
      input: {
        workflow: "fix-record",
        payload: { documentId: docId, filename: "invoice-1042.pdf", source: "upload" },
      },
    });

    await runLatest();
    b = await ok("GET", `/api/ops/builds/${templateBuild}`);
    const [tried] = b.poc?.tries ?? [];
    expect(tried).toMatchObject({ status: "done", why: null, current: true });
    // What the agent would do: every step's output, the write proposed and never made.
    expect(tried?.output).toHaveProperty("update");
    expect(H.backend.get(H.B.connectionId, "r1")?.amount).toBe("20.00");
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.tenantId, H.B.tenantId));
    expect(actions.every((a) => a.status !== "done" && a.status !== "executing")).toBe(true);

    // Right, keep it: a required case whose expected answer is that result.
    b = await ok("POST", `/api/ops/builds/${templateBuild}/tries/${tried?.caseId}`, {
      decide: "keep",
    });
    expect(b.poc).toMatchObject({ cases: 1, required: 1, tries: [] });
    const [kept] = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.id, tried?.caseId as string));
    expect(kept).toMatchObject({
      name: "invoice-1042.pdf",
      required: true,
      sourceRef: `kept:${templateBuild}`,
    });
    // What the try's own run made (the proposed write's id) differs on every run: left out.
    const output = tried?.output as { update: Record<string, unknown> };
    expect(output.update.actionId).toBeTruthy();
    const expected = kept?.expected as { update: Record<string, unknown> };
    expect(expected.update).not.toHaveProperty("actionId");
    expect(expected.update).toMatchObject({ wouldHaveDone: true });
    // Kept once only.
    expect(
      (
        await H.call(OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries/${tried?.caseId}`, {
          decide: "keep",
        })
      ).status,
    ).toBe(404);

    // The build's test run runs the kept case; it passes on the same version: the gate opens.
    b = await ok("POST", `/api/ops/builds/${templateBuild}/run-tests`);
    const full = await runLatest();
    expect(full.partial).toBeUndefined();
    expect(full.caseIds).toEqual([tried?.caseId]);
    b = await ok("GET", `/api/ops/builds/${templateBuild}`);
    expect(b.poc?.failures, JSON.stringify(b.poc?.failures)).toEqual([]);
    expect(b.poc).toMatchObject({ passed: true, detail: "Every required case passes." });
    expect(b.poc?.latest).toMatchObject({ total: 1, passed: 1 });

    // A later try doesn't hide that run, and a try waiting to be kept never runs with the cases.
    b = await ok("POST", `/api/ops/builds/${templateBuild}/tries`, {
      input: { note: "by hand" },
    });
    expect(b.poc).toMatchObject({ passed: true, latest: { id: b.poc?.latest?.id } });
    const second = b.poc?.tries[0];
    expect(second).toMatchObject({ name: "Try: your input", status: "running" });
    const run = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "template",
      targetId: templateId,
      versionId: b.draft?.versionId,
    });
    expect(run.status).toBe(200);
    expect((jobs.started.at(-1) as SuiteParams).caseIds).toEqual([tried?.caseId]);
    // Discarded: archived, gone from the build.
    b = await ok("POST", `/api/ops/builds/${templateBuild}/tries/${second?.caseId}`, {
      decide: "discard",
    });
    expect(b.poc?.tries).toEqual([]);
    const [gone] = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.id, second?.caseId as string));
    expect(gone?.archivedAt).toBeTruthy();
  });

  it("runs where the Sandbox is, and takes one example at a time", async () => {
    // A template's build is everyone's, but its document is the Sandbox's: an operator who
    // doesn't serve the Sandbox can't try it there.
    const res = await H.call(OTHER_OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries`, {
      documentId: docId,
    });
    expect(res.status).toBe(409);
    expect(j(res.json).error.code).toBe("no_sandbox");
    const both = await H.call(OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries`, {
      documentId: docId,
      input: {},
    });
    expect(both.status).toBe(400);
  });

  it("tries a skill on an input, keeps it, and says why it fails to the page and the Builder", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", { definition: skillDef });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const skillId = j(created.json).skill.id as string;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "skill", title: "Same item", phase: "poc", skillId })
      .returning();
    const id = row?.id as string;

    // A skill is tried on an input, not a document.
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/tries`, { documentId: docId })).status,
    ).toBe(422);
    let b = await ok("POST", `/api/ops/builds/${id}/tries`, {
      input: { a: "Oak board 2x4", b: "Oak bd 2x4" },
    });
    // A skill's try document goes to the Sandbox too (docs/open.md G3).
    expect(b.poc?.trySandbox).toEqual({ id: H.B.tenantId, name: "Client B" });
    await runLatest(new FakeModel([says("same")]));
    b = await ok("GET", `/api/ops/builds/${id}`);
    const tried = b.poc?.tries[0];
    expect(tried).toMatchObject({ status: "done", output: { verdict: "same" } });

    // Wrong is said in the conversation: the Builder is told what the try did.
    model.push({
      toolUse: {
        name: "submit_build_turn",
        input: { text: "I'd change the rule.", chips: [], items: [] },
      },
    });
    await ok("POST", `/api/ops/builds/${id}/turns`, {
      text: "About “Try: your input”: these are the same board.",
    });
    const told = JSON.stringify(model.requests.at(-1)?.messages);
    expect(told).toContain('Tried \\"Try: your input\\", not kept yet');
    expect(told).toContain("verdict");

    b = await ok("POST", `/api/ops/builds/${id}/tries/${tried?.caseId}`, { decide: "keep" });
    expect(b.poc).toMatchObject({ cases: 1, required: 1 });

    // The model now says otherwise: the case fails, and says why, here and to the Builder.
    await ok("POST", `/api/ops/builds/${id}/run-tests`);
    await runLatest(new FakeModel([says("different")]));
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.poc?.failures).toEqual([
      expect.objectContaining({
        name: "your input",
        status: "fail",
        why: 'verdict: expected "same", got "different"',
      }),
    ]);
    model.push({
      toolUse: { name: "submit_build_turn", input: { text: "Looking.", chips: [], items: [] } },
    });
    await ok("POST", `/api/ops/builds/${id}/turns`, { text: "Why does it fail?" });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      'Test case \\"your input\\" fails: verdict: expected \\"same\\", got \\"different\\"',
    );
    // The skill's publish gate reads the full run only: a later try that passes doesn't open it.
    const on = await H.call(OPERATOR, "PUT", `/api/ops/skills/${skillId}/require-tests`, {
      required: true,
    });
    expect(on.status).toBe(200);
    b = await ok("POST", `/api/ops/builds/${id}/tries`, { input: { a: "Walnut", b: "Walnut" } });
    await runLatest(new FakeModel([says("same")]));
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.poc?.tries[0]).toMatchObject({ status: "done" });
    expect(b.poc).toMatchObject({
      passed: false,
      failures: [expect.objectContaining({ name: "your input" })],
    });
    const version = j(created.json).version.id as string;
    const publish = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${version}/publish`,
    );
    expect(publish.status).toBe(422);
    expect(j(publish.json).error).toMatchObject({
      code: "tests_failing",
      details: { failing: [tried?.caseId] },
    });
    const required = await H.t.db
      .select()
      .from(testCase)
      .where(and(eq(testCase.targetId, skillId), eq(testCase.required, true)));
    expect(required).toHaveLength(1);
  });

  // docs/open.md G3: a template tried on one of the Sandbox's records, as its event would carry it.
  it("tries a template on a Sandbox record, and only on the Sandbox's", async () => {
    const [v] = await H.t.db
      .insert(vendor)
      .values({
        tenantId: H.B.tenantId,
        name: "Northline Panel",
        normalizedName: "northline panel",
      })
      .returning();
    const [t] = await H.t.db
      .insert(transaction)
      .values({
        tenantId: H.B.tenantId,
        kind: "bill",
        connector: "qbo",
        externalId: "try-bill-1",
        vendorId: v?.id,
        txnDate: "2026-11-02",
        total: "1250.0000",
        currency: "USD",
      })
      .returning();
    const [elsewhere] = await H.t.db
      .insert(transaction)
      .values({
        tenantId: H.A.tenantId,
        kind: "bill",
        connector: "qbo",
        externalId: "try-bill-a",
        total: "10.0000",
      })
      .returning();
    const notHere = await H.call(OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries`, {
      record: { kind: "transaction", id: elsewhere?.id },
    });
    expect(notHere.status).toBe(404);
    const noSuch = await H.call(OPERATOR, "POST", `/api/ops/builds/${templateBuild}/tries`, {
      record: { kind: "receivable", id: elsewhere?.id },
    });
    expect(noSuch.status).toBe(404);

    const b = await ok("POST", `/api/ops/builds/${templateBuild}/tries`, {
      record: { kind: "transaction", id: t?.id },
    });
    expect(b.poc?.tries[0]).toMatchObject({
      name: "Try: bill from Northline Panel, 1250.0000 USD",
      status: "running",
    });
    const params = jobs.started.at(-1) as SuiteParams;
    expect(params).toMatchObject({ partial: true, runTenantId: H.B.tenantId });
    const [made] = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.id, params.caseIds[0] as string));
    expect(made).toMatchObject({
      tenantId: null,
      required: false,
      input: {
        // No workflow starts on a new bill here: the one started by hand gets it.
        workflow: "fix-record",
        payload: {
          transactionId: t?.id,
          source: "qbo",
          vendorId: v?.id,
          total: { amount: "1250.0000", currency: "USD" },
          txnDate: "2026-11-02",
        },
      },
    });
    await ok("POST", `/api/ops/builds/${templateBuild}/tries/${made?.id}`, { decide: "discard" });
  });

  // docs/open.md G3: a skill tried on a Sandbox document, on the bench: the document as it is now
  // answers the skill's read, and nothing is written.
  it("tries a skill on a Sandbox document through a fixture made from it", async () => {
    const def = {
      ...skillDef,
      id: "custom:invoice-vendor-try",
      name: "Invoice vendor",
      description: "Says who sent an invoice",
      instructions: "Read the document and say who sent it.",
      tools: ["docs.get"],
      input: {
        type: "object",
        properties: { documentId: { type: "string" } },
        required: ["documentId"],
      },
    };
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", { definition: def });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const skillId = j(created.json).skill.id as string;
    const [row] = await H.t.db
      .insert(build)
      .values({ kind: "skill", title: "Invoice vendor", phase: "poc", skillId })
      .returning();
    const id = row?.id as string;

    // Not read yet: refused rather than tried without its reading.
    const unread = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/tries`, {
      documentId: docId,
    });
    expect(unread.status).toBe(409);
    expect(j(unread.json).error.code).toBe("not_read");

    const [x] = await H.t.db
      .insert(docExtraction)
      .values({
        tenantId: H.B.tenantId,
        documentId: docId,
        model: "replay",
        header: { vendorName: "Northline Panel Supply", invoiceNumber: "1042" },
        currency: "USD",
        subtotal: "12.0000",
        total: "12.0000",
        linesSum: "12.0000",
        totalsMatch: true,
      })
      .returning();
    // A record is given to a skill in its input, as JSON.
    const record = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/tries`, {
      record: { kind: "transaction", id: docId },
    });
    expect(record.status).toBe(422);

    let b = await ok("POST", `/api/ops/builds/${id}/tries`, { documentId: docId });
    expect(b.poc?.tries[0]).toMatchObject({ name: "Try: invoice-1042.pdf", status: "running" });
    const params = jobs.started.at(-1) as SuiteParams;
    const [made] = await H.t.db
      .select()
      .from(testCase)
      .where(eq(testCase.id, params.caseIds[0] as string));
    expect(made?.input).toEqual({ documentId: docId });
    expect(made?.fixtures).toEqual([
      {
        tool: "docs.get",
        input: { documentId: docId },
        output: expect.objectContaining({
          id: docId,
          filename: "invoice-1042.pdf",
          url: null,
          extraction: expect.objectContaining({
            id: x?.id,
            header: { vendorName: "Northline Panel Supply", invoiceNumber: "1042" },
          }),
          sources: [docId, x?.id],
        }),
      },
    ]);

    // The bench runs it on that fixture, as a test: what it would answer, nothing written.
    await runLatest(new FakeModel([says("Northline Panel Supply")]));
    b = await ok("GET", `/api/ops/builds/${id}`);
    expect(b.poc?.tries[0]).toMatchObject({
      status: "done",
      output: { verdict: "Northline Panel Supply" },
    });
    b = await ok("POST", `/api/ops/builds/${id}/tries/${made?.id}`, { decide: "keep" });
    expect(b.poc).toMatchObject({ cases: 1, required: 1 });
  });
});
