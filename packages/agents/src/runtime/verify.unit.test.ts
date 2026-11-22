// Round 4 D (docs/plan.md §1.211): the verifier before a write, through the gate, on a recorded
// answer (LLM_MODE=replay, a hand-written fixture in fixtures/llm). The run's source says the
// invoice is $1,250.00; the agent proposes $125.00 (a seeded wrong answer). The verifier, which
// never sees the proposal, works out $1,250.00 from the source: the write goes to a person with
// both answers, though the gate alone would have let it go ahead. The same recorded answer agrees
// with a right proposal (the request carries no proposal, so it is the same request).

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { describe, expect, it } from "vitest";
import type { ModelCallInput } from "../log/model-calls";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";
import type { VerifySources } from "./ports";

const SOURCES: VerifySources = {
  trigger: { documentId: "d0c00000-0000-4000-8000-000000000001", kind: "invoice" },
  steps: [],
  subjects: [
    {
      id: "5b000000-0000-4000-8000-000000000001",
      kind: "document",
      label: "Northline Panel Supply",
      number: "20418",
      amount: "1250.0000",
      currency: "USD",
      recordId: "d0c00000-0000-4000-8000-000000000001",
    },
  ],
  documents: [
    {
      documentId: "d0c00000-0000-4000-8000-000000000001",
      filename: "northline-20418.pdf",
      reading: {
        header: { vendorName: "Northline Panel Supply", invoiceNumber: "20418" },
        currency: "USD",
        subtotal: "1250.0000",
        tax: null,
        total: "1250.0000",
      },
    },
  ],
};

/** What the recorded verifier answers: the record and the amount the source shows. */
const SEEDED_ANSWER = {
  id: "msg_handwritten_verify_northline-20418",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    {
      type: "tool_use",
      id: "toolu_handwritten_verify_northline-20418",
      name: "finish",
      input: {
        derivable: true,
        input: { amount: "1250.00" },
        note: "The invoice from Northline Panel Supply (20418) totals 1,250.00 USD; the record's id isn't in the sources.",
        sources: ["d0c00000-0000-4000-8000-000000000001"],
      },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 90 },
};

// `VERIFY_SEED=1` writes the fixture once (no API key: the answer above, marked hand-written);
// every other run replays it, and a changed prompt fails as a replay miss.
function transport(): LlmTransport {
  const seeding = process.env.VERIFY_SEED === "1";
  const inner: LlmTransport | null = seeding
    ? { create: async () => structuredClone(SEEDED_ANSWER) as never }
    : null;
  const store = fileFixtureStore();
  return withRecording(inner, {
    mode: seeding ? "record" : "replay",
    store: seeding
      ? { read: store.read, write: (c) => store.write({ ...c, handWritten: true }) }
      : store,
  });
}

function harness(opts: {
  verify?: "writes" | "off";
  sources?: VerifySources;
  mode?: "live" | "test";
  thresholds?: { currency: string; approveFrom: string }[];
}) {
  const proposed: {
    status: string;
    inbox: { assigneeRole: string | null; payload: Record<string, unknown> } | null;
  }[] = [];
  const calls: ModelCallInput[] = [];
  const conn = {
    id: "c1",
    tenantId: "t1",
    connector: "testkit",
    status: "connected" as const,
    externalAccountId: null,
    config: {},
    permissions: { read: "auto", create: "auto", update: "auto", delete: "off" },
  };
  const deps = {
    tools: new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: new ConnectorRegistry([createTestkitConnector()]),
    }),
    transport: transport(),
    ports: {
      log: {
        startToolCall: async () => "tc1",
        finishToolCall: async () => {},
        addUsage: async () => {},
      },
      modelCalls: { record: async (_t: string, c: ModelCallInput) => void calls.push(c) },
      verify: { sources: async () => opts.sources ?? SOURCES },
      store: {
        connection: async () => conn,
        grant: async () => null,
        agentStage: async () => "live",
        agentHold: async () => false,
        run: async () => ({ mode: opts.mode ?? "live", agentId: "a1" }),
        approvalRouting: async () => ({
          revision: 0,
          rules: [],
          clientDefault: null,
          members: new Set(),
          thresholds: opts.thresholds ?? [],
        }),
      },
      actions: {
        byKey: async () => null,
        propose: async (_t: string, p: (typeof proposed)[number]) => {
          proposed.push(p);
          return { action: { id: "act1", status: p.status, inboxItemId: "in1", before: null } };
        },
        get: async () => null,
        claim: async () => ({
          action: { id: "act1", status: "proposed", runId: "r1", tool: TESTKIT_UPDATE_TOOL },
          claimed: false,
        }),
      },
    },
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: "t1",
    runId: "01900000-0000-7000-8000-000000000001",
    stepRunId: "01900000-0000-7000-8000-000000000002",
    stepId: "book",
    mode: opts.mode ?? "live",
    literalInput: {},
    // Everything the gate reads says "go ahead on its own" (invariant 8 allows auto here).
    approval: { required: "not_required" },
    agent: {
      agentId: "a1",
      agentVersionId: "v1",
      bindings: { testkit: "c1" },
      bundle: {
        definition: {
          identity: { name: "Bookkeeper", role: "books bills", mission: "Keep the books right." },
          model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
          instructions: "Book each vendor invoice for its total.",
          permissions: { mode: "act" },
          ...(opts.verify ? { oversight: { review: "failures", verify: opts.verify } } : {}),
        },
      },
    },
    externalIndex: { next: 0 },
  } as unknown as StepContext;
  const write = (amount: string) =>
    callTool(deps, step, { toolId: TESTKIT_UPDATE_TOOL, input: { id: "R-1", amount } });
  return { write, proposed, calls };
}

describe("the verifier before a write (replayed)", () => {
  it("catches a seeded wrong amount and sends it to a person with both answers", async () => {
    const h = harness({ verify: "writes" });
    expect(await h.write("125.00")).toMatchObject({ status: "awaiting_approval" });
    const [p] = h.proposed;
    expect(p?.status).toBe("proposed");
    expect(p?.inbox?.assigneeRole).toBe("client_admin");
    expect(p?.inbox?.payload.verification).toEqual({
      outcome: "disagreed",
      checked: 1,
      differences: [{ path: "amount", proposed: "125.00", derived: "1250.00" }],
      reason: null,
      sources: ["d0c00000-0000-4000-8000-000000000001"],
    });
    // The check is one model call, counted as a check (no note or model on the card).
    expect(h.calls.map((c) => c.action)).toEqual(["check"]);
    expect(JSON.stringify(p?.inbox?.payload)).not.toContain("claude");
  });

  it("lets a write it agrees with go on as the gate allowed", async () => {
    const h = harness({ verify: "writes" });
    await h.write("1250.00");
    expect(h.proposed[0]?.status).toBe("approved");
  });

  it("sends a write it can't work out to the operator, with no model call when nothing was read", async () => {
    const h = harness({
      verify: "writes",
      sources: { trigger: {}, steps: [], subjects: [], documents: [] },
    });
    await h.write("125.00");
    expect(h.proposed[0]?.status).toBe("proposed");
    expect(h.proposed[0]?.inbox?.assigneeRole).toBe("operator");
    expect(h.proposed[0]?.inbox?.payload.verification).toMatchObject({
      outcome: "cannot_verify",
      reason: "no_sources",
    });
    expect(h.calls).toEqual([]);
  });

  it("checks a test run's write too, which still never writes", async () => {
    const h = harness({ verify: "writes", mode: "test" });
    await h.write("125.00");
    expect(h.proposed[0]).toMatchObject({ status: "proposed", inbox: null });
    expect(h.calls.map((c) => c.action)).toEqual(["check"]);
  });

  it("leaves an agent without `verify` exactly as before (no call)", async () => {
    for (const verify of [undefined, "off"] as const) {
      const h = harness(verify ? { verify } : {});
      await h.write("125.00");
      expect(h.proposed[0]?.status).toBe("approved");
      expect(h.calls).toEqual([]);
    }
  });
});

describe("the client's dollar thresholds", () => {
  const thresholds = [{ currency: "USD", approveFrom: "500.00" }];

  it("makes a write at or over one wait for a person, and says which", async () => {
    const h = harness({ thresholds });
    await h.write("500.00");
    expect(h.proposed[0]?.status).toBe("proposed");
    expect(h.proposed[0]?.inbox?.payload.threshold).toEqual(thresholds[0]);
  });

  it("changes nothing below it", async () => {
    const h = harness({ thresholds });
    await h.write("499.99");
    expect(h.proposed[0]?.status).toBe("approved");
  });
});
