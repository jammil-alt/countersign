// docs/plan.md §1.212: saving an approved or corrected change as a case, running it, and the
// scorecard. A client's agent forked from the invoice review sent a review to AP after the client
// approved it (as proposed), and another after a correction (another mailbox). Each is saved in one
// click as the client's case of the template; the suite runs them as test runs in that client (with
// its agent's AP mailbox): the approved one makes its write, the corrected one doesn't (the agent
// still sends to AP), and the scorecard says so. Operators only; once per item.

import { type AgentBundle, WRITES_KEY } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  externalAction,
  inboxItem,
  run,
  stepRun,
  testCase,
} from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { doAction, doTell, OPERATOR, testBundle, v5Workflow } from "../api.test-helper";
import { MemoryTestSuiteJobs } from "../testbench/instances";
import {
  executeSuite,
  runTemplateTest,
  type SuiteParams,
  withParameters,
} from "../testbench/suite";
import {
  createEvalHarness,
  goldenRunDeps,
  liveBundle,
  liveVersion,
  loadDatasets,
  seedGoldenClient,
} from "./golden.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const jobs = new MemoryTestSuiteJobs();
const h = await createEvalHarness({ testSuites: jobs });
afterAll(() => h?.close());

/**
 * The invoice review, as a template's live version: the review notes, then the hand-off that
 * sends them to AP (a write that waits for a signature) or tells the operator no mailbox is set.
 * DECISION (step model J): the packs ship no template yet (docs/step-model-plan.md §12, R0), so
 * the test installs the part of the old Vendor contracts template it is about.
 */
function vendorContractsBundle(): AgentBundle {
  const base = testBundle("Vendor contracts");
  return {
    ...base,
    definition: {
      ...base.definition,
      skills: [{ skill: "materials.invoice-review", settings: {} }],
      extraTools: [],
      oversight: { review: "failures", verify: "writes" },
    },
    workflows: [
      {
        slug: "invoice-review",
        name: "When an invoice comes in",
        enabled: true,
        workflow: v5Workflow(
          [
            {
              id: "notes",
              name: "Review notes for AP",
              kind: "do",
              doneBy: "rules",
              uses: { type: "skill", skill: "materials.invoice-review" },
              input: { documentId: "{{trigger.documentId}}", findings: [] },
            },
            {
              id: "ap-set",
              name: "Hand off the review",
              kind: "fork",
              paths: [
                {
                  id: "ap-send-path",
                  name: "Send it",
                  when: {
                    match: "all",
                    rules: [{ field: "{{steps.notes.output.send}}", op: "=", value: true }],
                  },
                  steps: [
                    doAction(
                      "send-ap",
                      "Send the invoice and its review",
                      "email.send",
                      {
                        to: "{{steps.notes.output.to}}",
                        subject: "{{steps.notes.output.subject}}",
                        body: "{{steps.notes.output.body}}",
                        attachments: "{{steps.notes.output.attachments}}",
                      },
                      { client: { visible: true, label: "Sent the invoice and its review" } },
                    ),
                  ],
                },
              ],
              otherwise: {
                id: "ap-none",
                steps: [
                  doTell(
                    "tell-no-ap",
                    "Tell the operator when no mailbox is set",
                    "Invoice {{steps.notes.output.invoiceNumber}}: {{steps.notes.output.reason}}",
                    { client: { visible: false } },
                  ),
                ],
              },
            },
          ],
          {
            triggers: [
              {
                id: "trg-invoice",
                on: {
                  type: "manual",
                  input: { type: "object", properties: { documentId: { type: "string" } } },
                },
              },
            ],
          },
        ),
      },
    ],
  } as unknown as AgentBundle;
}

const AP = "ap@golden-millwork.example";
const PRICING = "pricing@golden-millwork.example";

describe.skipIf(!h)("saving an approved change as a case", () => {
  it("saves it once, runs it, and the scorecard counts it", async () => {
    if (!h) return;
    const H = h;
    const dataset = loadDatasets().find((d) => d.dataset.template === "vendor-contracts")?.dataset;
    const golden = dataset?.cases.find((c) => c.id === "pricing-issue-to-ap");
    if (!dataset || !golden) throw new Error("no golden case");
    // The client's world: the invoice, its contract (over the contract price) and the mailboxes.
    const ctx = await seedGoldenClient(H, dataset, golden);
    const tenantId = ctx.tenantId;
    const made = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "vendor-contracts",
      bundle: vendorContractsBundle(),
      releaseNote: "First",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const published = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(made.json).agent.id}/versions/${j(made.json).version.id}/publish`,
    );
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, "vendor-contracts")));
    if (!tpl) throw new Error("no template");
    const templateVersion = await liveVersion(H, "vendor-contracts");

    // The client's agent: the template's live bundle, with its AP mailbox (as its operator set it).
    const base = await liveBundle(H, "vendor-contracts");
    const bundle = {
      ...base,
      definition: {
        ...base.definition,
        skills: base.definition.skills.map((s) =>
          s.skill === "materials.invoice-review" ? { ...s, parameters: { ap_email: AP } } : s,
        ),
      },
    } as AgentBundle;
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug: "invoice-review",
        name: "Invoice review",
        templateId: tpl.id,
      })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle,
        bundleHash: "golden",
        status: "live",
        authorType: "operator",
        basedOnTemplateVersionId: templateVersion,
      })
      .returning();
    const [email] = await H.t.db
      .select({ id: connection.id })
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, "resend")));

    // What the agent sends: its own run's email (a test run in the client, with its AP mailbox).
    const once = await runTemplateTest(goldenRunDeps(H), {
      runTenantId: tenantId,
      versionId: templateVersion,
      actorId: null,
      workflow: "invoice-review",
      payload: { documentId: ctx.ids.invoice },
      adjust: withParameters({ "materials.invoice-review": { ap_email: AP } }),
    });
    const sent = once.steps.find((x) => x.nodeId === "send-ap")?.input as Record<string, unknown>;
    expect(sent).toMatchObject({ to: AP });

    /** A live run that proposed sending the review, and the client's decision on it. */
    async function pastRun(n: number, decision: "approve" | "reject", edited?: { to: string }) {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId,
          agentId: a?.id as string,
          agentVersionId: v?.id as string,
          workflowSlug: "invoice-review",
          mode: "live",
          trigger: { type: "event", payload: { documentId: ctx.ids.invoice } },
          status: "succeeded",
        })
        .returning();
      const proposed = sent;
      const [s] = await H.t.db
        .insert(stepRun)
        .values({
          tenantId,
          runId: r?.id as string,
          nodeId: "send-ap",
          nodeType: "write",
          input: proposed,
          status: "succeeded",
        })
        .returning();
      const [item] = await H.t.db
        .insert(inboxItem)
        .values({
          tenantId,
          kind: "approval",
          runId: r?.id as string,
          title: `Send invoice NPS-2001's review (${n})`,
          status: "resolved",
          resolution: { decision },
          resolvedAt: new Date(),
        })
        .returning();
      await H.t.db.insert(externalAction).values({
        tenantId,
        connectionId: email?.id as string,
        tool: "resend.send",
        runId: r?.id as string,
        stepRunId: s?.id as string,
        agentVersionId: v?.id as string,
        input: proposed,
        idempotencyKey: `${r?.id}:send-ap:0`,
        status: decision === "approve" ? "done" : "rejected",
        inboxItemId: item?.id as string,
        ...(edited ? { editedInput: { ...proposed, ...edited }, editedAt: new Date() } : {}),
      });
      return item?.id as string;
    }

    const approved = await pastRun(1, "approve");
    const corrected = await pastRun(2, "approve", { to: PRICING });
    const rejected = await pastRun(3, "reject");
    const save = (id: string, who = OPERATOR) =>
      H.call(who, "POST", `/api/ops/inbox/${id}/save-as-case`, {});

    // The client's people can't; a rejected change isn't a case.
    expect((await save(approved, ctx.admin)).status).toBe(403);
    const no = await save(rejected);
    expect(no.status, JSON.stringify(no.json)).toBe(422);
    expect(j(no.json).error.code).toBe("not_approved");

    const one = await save(approved);
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(j(one.json)).toMatchObject({
      created: true,
      case: {
        clientId: tenantId,
        targetKind: "template",
        targetId: tpl.id,
        source: "run",
        required: false,
        name: "Approved: Send invoice NPS-2001's review (1)",
        input: {
          workflow: "invoice-review",
          payload: { documentId: ctx.ids.invoice },
          parameters: { "materials.invoice-review": { ap_email: AP } },
        },
        expected: {
          [WRITES_KEY]: [{ step: "send-ap", expect: { tool: "email.send", input: { to: AP } } }],
          $writesScope: "named",
        },
      },
    });
    // One click, once.
    const again = await save(approved);
    expect(j(again.json)).toMatchObject({ created: false, case: { id: j(one.json).case.id } });
    const two = await save(corrected);
    expect(j(two.json).case.name).toMatch(/^Corrected: /);
    expect(j(two.json).case.expected[WRITES_KEY][0].expect.input.to).toBe(PRICING);
    const cases = await H.t.db.select().from(testCase).where(eq(testCase.tenantId, tenantId));
    expect(cases).toHaveLength(2);

    // The client's suite: each case as a test run in the client, with its agent's AP mailbox.
    const started = await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "template",
      targetId: tpl.id,
      versionId: templateVersion,
      clientId: tenantId,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const params = jobs.started.at(-1) as SuiteParams;
    await executeSuite(goldenRunDeps(H), params, { do: (_n, fn) => fn() });
    const res = j((await H.call(OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`)).json);
    const byName = new Map(res.results.map((r: { name: string }) => [r.name, r]));
    const ok = j(byName.get("Approved: Send invoice NPS-2001's review (1)"));
    const off = j(byName.get("Corrected: Send invoice NPS-2001's review (2)"));
    // The agent sends to AP, as approved: a pass. The correction asked for the pricing desk: a fail.
    expect(ok.status, JSON.stringify(ok.diff)).toBe("pass");
    expect(ok.diff.writes).toMatchObject({ exact: true });
    expect(off.status).toBe("fail");
    expect(off.diff.writes).toMatchObject({ exact: false, missing: ["send-ap"] });
    expect(res.suiteRun.metrics).toMatchObject({ writes: { cases: 2, exactRate: 0.5 } });
    expect(typeof res.suiteRun.metrics.msMedian).toBe("number");

    // The scorecard: the golden datasets' and this version's workflow from the client's suite.
    const card = j((await H.call(OPERATOR, "GET", "/api/ops/evals/scorecard")).json);
    expect(card.golden.map((g: { template: string }) => g.template)).toEqual([
      "bookkeeper",
      "vendor-contracts",
    ]);
    const row = card.rows.find((r: { suiteRunId: string }) => r.suiteRunId === params.suiteRunId);
    expect(row).toMatchObject({
      templateSlug: "vendor-contracts",
      workflow: "invoice-review",
      cases: 2,
      passed: 1,
      writeCases: 2,
      exactRate: 0.5,
      // §1.211: the template verifies its writes; this test records no answer for the check, so
      // the verifier couldn't work either one out, and the scorecard counts both so.
      verifierAgreement: 0,
      verification: { agreed: 0, disagreed: 0, cannotVerify: 2 },
    });
    expect((await H.call(ctx.admin, "GET", "/api/ops/evals/scorecard")).status).toBe(403);
  }, 120_000);
});
