// The Builder in a build (docs/plan.md §1.108) against scripted model answers: each phase changes
// only its own record, the catalog goes only where it is needed, the conversation reaches the model
// as alternating turns with the build's state on the latest words, and test cases come from the
// plan's generated datasets.
import { createLlmClient, FakeModel, type LlmRequest } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import type { BuilderContext } from "../builder/context";
import {
  BUILD_CASES_TOOL,
  BUILD_TURN_TOOL,
  type BuildTurnInput,
  buildTurn,
  makeTestCases,
} from "./turn";

const ctx: BuilderContext = {
  tools: [],
  skills: [],
  connectors: [{ id: "gmail", name: "Gmail" }],
  packs: [],
  events: [],
  templates: [],
  client: null,
  agentSlugs: [],
} as unknown as BuilderContext;

const base: BuildTurnInput = {
  phase: "intake",
  kind: "agent",
  title: "Invoice intake reviewer",
  clientName: "Harbor Millwork",
  brief: {},
  fitgap: { rows: [], needsTrue: [], setup: [] },
  testPlan: { datasets: [] },
  items: [],
  facts: [],
  history: [],
  words: "I want an agent that reviews vendor invoices against their contracts.",
  ctx,
};

function lastUser(req: LlmRequest | undefined): string {
  const m = req?.messages[req.messages.length - 1];
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
}

describe("buildTurn", () => {
  it("fills the brief in intake, and drops a fit-gap it wasn't asked for", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: BUILD_TURN_TOOL,
          input: {
            text: "Got it. Where do the invoices arrive today?",
            chips: ["A shared mailbox", "Uploads"],
            brief: { goal: { text: "Check invoices against contracts", state: "confirmed" } },
            fitgap: {
              rows: [{ id: "x", need: "y", verdict: "native", how: "" }],
              needsTrue: [],
              setup: [],
            },
            items: [],
          },
        },
      },
    ]);
    const out = await buildTurn(base, { llm: createLlmClient({ transport: model }) });
    expect(out.answer.text).toBe("Got it. Where do the invoices arrive today?");
    expect(out.answer.chips).toEqual(["A shared mailbox", "Uploads"]);
    expect(out.answer.brief?.goal?.text).toBe("Check invoices against contracts");
    expect(out.answer.fitgap).toBeUndefined();
    // Intake reads no catalog; the build's state rides with the operator's words.
    const req = model.requests[0];
    expect(lastUser(req)).not.toContain("<catalog>");
    expect(lastUser(req)).toContain("Harbor Millwork");
    expect(lastUser(req)).toContain("I want an agent");
    expect(JSON.stringify(req?.system)).toContain("Phase: intake");
  });

  it("writes the fit-gap with the catalog, and keeps alternating turns", async () => {
    const fitgap = {
      rows: [
        { id: "read", need: "Read invoice PDFs", verdict: "native", how: "Read the invoice" },
        {
          id: "pay",
          need: "Pay the vendor",
          verdict: "not_possible",
          how: "Agents never move money",
        },
      ],
      needsTrue: [{ id: "qbo", text: "The client connects QuickBooks" }],
    };
    const model = new FakeModel([
      {
        toolUse: {
          name: BUILD_TURN_TOOL,
          input: {
            text: "One we do as is, one we can't.",
            fitgap,
            items: [{ title: "Connect QuickBooks", kind: "precondition", owner: "client" }],
          },
        },
      },
    ]);
    const out = await buildTurn(
      {
        ...base,
        phase: "fitgap",
        words: null,
        history: [
          { role: "builder", text: "an opener with no operator words before it" },
          { role: "operator", text: "Forwarded to ap@ as PDFs." },
          { role: "operator", text: "Contracts are in Drive." },
          { role: "builder", text: "Added both." },
        ],
      },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(out.answer.fitgap?.rows.map((r) => r.verdict)).toEqual(["native", "not_possible"]);
    expect(out.answer.fitgap?.needsTrue[0]?.done).toBe(false);
    expect(out.answer.items).toEqual([
      { title: "Connect QuickBooks", kind: "precondition", owner: "client" },
    ]);
    const req = model.requests[0];
    expect(lastUser(req)).toContain("<catalog>");
    expect(lastUser(req)).toContain("Check it against the catalog");
    expect(req?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // A build for one client asks for what needs to be true.
    expect(JSON.stringify(req?.system)).toContain("This build is for one client");
  });

  it("asks a template for its client intake form, not what needs to be true", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: BUILD_TURN_TOOL,
          input: {
            text: "Here's the form.",
            fitgap: {
              rows: [{ id: "read", need: "Read PDFs", verdict: "native", how: "Read document" }],
              setup: [{ id: "ap", label: "Your AP address", kind: "answer", hint: "ap@" }],
            },
          },
        },
      },
    ]);
    const out = await buildTurn(
      { ...base, clientName: null, phase: "fitgap", words: null },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(out.answer.fitgap?.setup).toEqual([
      { id: "ap", label: "Your AP address", kind: "answer", hint: "ap@" },
    ]);
    expect(JSON.stringify(model.requests[0]?.system)).toContain("client intake form");
  });
});

describe("makeTestCases", () => {
  it("makes cases from the generated datasets only", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: BUILD_CASES_TOOL,
          input: {
            cases: [
              {
                name: "Invoice over contract price",
                dataset: "invoices",
                input: { workflow: "main", payload: { invoice: "INV-1" } },
                expected: { compare: { overPrice: true } },
              },
            ],
          },
        },
      },
    ]);
    const out = await makeTestCases(
      {
        kind: "template",
        target: "workflow main, trigger manual",
        testPlan: {
          datasets: [
            {
              id: "invoices",
              name: "Invoices",
              count: 3,
              covers: "1 over price",
              source: "generate",
            },
            { id: "real", name: "Real invoices", count: 4, covers: "theirs", source: "upload" },
          ],
        },
      },
      { llm: createLlmClient({ transport: model }) },
    );
    expect(out.cases).toHaveLength(1);
    expect(out.cases[0]?.required).toBe(true);
    const sent = lastUser(model.requests[0]);
    expect(sent).toContain('"invoices"');
    expect(sent).not.toContain("Real invoices");
  });
});
