// The reuse check (docs/plan.md §1.125): the deterministic search finds what might already do the
// work, and the judge, not the score, says use, extend or reject, naming what a reject lacks.
import { createLlmClient, FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import type { BuilderContext } from "../builder/context";
import {
  indexCatalog,
  judgeCandidates,
  mergeVerdicts,
  REUSE_JUDGE_TOOL,
  runReuseCheck,
  searchCatalog,
  words,
} from "./reuse";

const tool = (id: string, description: string, input: string[], output: string[]) => ({
  id,
  description,
  sideEffect: "read" as const,
  input: { type: "object", properties: Object.fromEntries(input.map((k) => [k, {}])) },
  output: { type: "object", properties: Object.fromEntries(output.map((k) => [k, {}])) },
});

const ctx = {
  tools: [
    tool(
      "qbo.aging_report",
      "QuickBooks accounts receivable aging: open invoices by customer in 30-day buckets.",
      ["asOf"],
      ["rows", "customer", "buckets"],
    ),
    tool(
      "qbo.invoice.list",
      "QuickBooks invoices: list a customer's invoices.",
      ["customer"],
      ["invoices"],
    ),
    tool(
      "gmail.send",
      "Send an email from the client's Gmail.",
      ["to", "subject", "body"],
      ["messageId"],
    ),
  ],
  skills: [],
  connectors: [{ id: "qbo", name: "QuickBooks Online" }],
  packs: [{ id: "bookkeeping", name: "Bookkeeping" }],
  events: [],
  templates: [],
  client: null,
  agentSlugs: [],
} as unknown as BuilderContext;

const index = indexCatalog(ctx, [
  {
    id: "r-open",
    number: 4,
    title: "QuickBooks report: profit and loss",
    summary: "Read the profit and loss report for a period.",
    inputs: ["start date", "end date"],
    outputs: ["income", "expenses", "net income"],
    open: true,
    shippedPartId: null,
  },
]);

describe("the search", () => {
  it("splits field names into words", () => {
    expect(words("netIncome due_date Invoices")).toEqual([
      "net",
      "income",
      "due",
      "date",
      "invoice",
    ]);
  });

  it("finds Reshape's one-value operations for a date offset", () => {
    const hits = searchCatalog(index, {
      query: "Add date offsets to Reshape data: run date minus days, months or years",
      kind: "extend_existing",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(8);
    expect(hits[0]?.partId).toBe("data.reshape#daysBetween");
  });

  it("puts an open request for a similar report among the candidates, for the judge to tell apart", () => {
    const hits = searchCatalog(index, {
      query: "QuickBooks report: balance sheet",
      outputs: ["assets", "liabilities", "equity"],
      kind: "new_tool",
    });
    expect(hits.map((h) => h.partId)).toContain("r-open");
  });

  // BUILDER_QA CONS-5: one stemmer for index and query.
  it.each([
    ["address", "addresses"],
    ["match", "matches"],
    ["tax", "taxes"],
    ["status", "statuses"],
    ["box", "boxes"],
    ["entry", "entries"],
    ["case", "cases"],
    ["invoice", "invoices"],
  ])("%s and %s are one word", (one, many) => {
    expect(words(many), `words("${one}") = ${JSON.stringify(words(one))}`).toEqual(words(one));
  });

  it("keeps letters outside English in a word", () => {
    expect(words("Café prices")).toEqual(["café", "price"]);
    expect(words("請求書")).toEqual(["請求書"]);
  });

  it("finds the part described in the singular for a request in the plural", () => {
    const parts = [
      {
        partType: "tool" as const,
        partId: "vendor.address_lookup",
        name: "vendor.address_lookup",
        description: "Looks up a vendor's remit-to address",
        inputs: ["vendorId"],
        outputs: ["address"],
      },
    ];
    const score = (query: string, outputs: string[]) =>
      searchCatalog(parts, { query, outputs })[0]?.score ?? 0;
    const singular = score("Look up a vendor remit-to address", ["address"]);
    const plural = score("Look up vendor remit-to addresses", ["addresses"]);
    expect(plural, `singular scores ${singular}`).toBe(singular);
  });
});

describe("the judge", () => {
  const found = searchCatalog(index, {
    query: "QuickBooks report: balance sheet",
    kind: "new_tool",
  });

  it("keeps each verdict with its reason and what a reject lacks", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: REUSE_JUDGE_TOOL,
          input: {
            verdicts: [
              {
                candidate: "r-open",
                relevant: true,
                verdict: "reject",
                reason: "It is the profit and loss report, a different report.",
                missing:
                  "No assets, liabilities or equity: it reads income and expenses for a period.",
              },
            ],
          },
        },
      },
    ]);
    const out = await judgeCandidates(
      {
        title: "QuickBooks report: balance sheet",
        kind: "new_tool",
        spec: { summary: "", inputs: [], outputs: [], rules: [] },
        candidates: found,
        ctx,
      },
      { llm: createLlmClient({ transport: model }) },
    );
    const open = out.candidates.find((c) => c.partId === "r-open");
    expect(open).toMatchObject({ verdict: "reject", judgedBy: "model", number: 4, open: true });
    expect(open?.missing).toMatch(/No assets/);
    // One the judge skipped stays unjudged, for the operator.
    expect(out.candidates.filter((c) => !c.verdict).length).toBe(found.length - 1);
    // The judge sees descriptions, inputs and outputs, not just names.
    const sent = JSON.stringify(model.requests[0]?.messages);
    expect(sent).toContain("income");
  });

  it("refuses a reject that doesn't say what's missing (the schema's minimum)", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: REUSE_JUDGE_TOOL,
          input: {
            verdicts: [
              {
                candidate: "r-open",
                relevant: true,
                verdict: "reject",
                reason: "Different report, not this one.",
                missing: "Different.",
              },
            ],
          },
        },
      },
    ]);
    await expect(
      judgeCandidates(
        {
          title: "x",
          kind: "new_tool",
          spec: { summary: "", inputs: [], outputs: [], rules: [] },
          candidates: found,
          ctx,
        },
        { llm: createLlmClient({ transport: model }) },
      ),
    ).rejects.toThrow(/could not be used/);
  });

  it("leaves the candidates unjudged with no model", async () => {
    const out = await runReuseCheck(
      {
        title: "QuickBooks report: balance sheet",
        kind: "new_tool",
        spec: {
          summary: "",
          inputs: [],
          outputs: [],
          rules: [],
          acceptance: [],
          parts: [],
          packages: [],
        },
        index,
        ctx: null,
      },
      { llm: null, now: new Date("2026-11-17T00:00:00Z") },
    );
    expect(out.check.unjudged).toBe(true);
    expect(out.check.candidates.every((c) => c.verdict === null)).toBe(true);
  });

  it("merges verdicts by candidate id", () => {
    const merged = mergeVerdicts(found.slice(0, 1), {
      verdicts: [
        {
          candidate: found[0]?.partId ?? "",
          relevant: false,
          verdict: "reject",
          reason: "It sends email; nothing to do with reports.",
          missing: "It reads no report at all: it only sends an email.",
        },
      ],
    });
    expect(merged[0]).toMatchObject({ relevant: false, verdict: "reject" });
  });
});
