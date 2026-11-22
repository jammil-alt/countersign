import { describe, expect, it } from "vitest";
import { FORBIDDEN_PORTAL_FIELD } from "../api/contract";
import { CONTROLS } from "../compliance/controls";
import { sopView } from "../sop/build";
import { input as sopInput } from "../sop/fixtures.test-helper";
import { assuranceView, levelsWords, type StoredResult } from "./build";
import {
  type AssuranceAction,
  type AssuranceInput,
  CHECKS,
  checkFunctionIds,
  runAssuranceChecks,
} from "./checks";
import { agentCoverage, checkedControls, INHERITED_CONTROLS, notApplicable } from "./coverage";
import {
  PROVIDER_TERMS,
  providerKeeps,
  providerTerms,
  termsConfirmed,
  trainingWords,
} from "./terms";
import { AssuranceView } from "./view";

// Agent assurance (docs/agent-assurance-plan.md): the checks on "Bills in" at Harbor Millwork, the
// same setup the SOP's tests read.

const KEY = "0199a000-0000-7000-8000-0000000000k1";
const BEN = "0199a000-0000-7000-8000-00000000000b";

const action = (over: Partial<AssuranceAction> = {}): AssuranceAction => ({
  id: `a-${Math.random().toString(16).slice(2, 8)}`,
  status: "done",
  asked: true,
  approvedBy: BEN,
  idempotencyKey: `k-${Math.random()}`,
  hasBefore: true,
  audited: true,
  approverIsMember: true,
  duringTrial: false,
  ...over,
});

function input(over: Partial<AssuranceInput> = {}): AssuranceInput {
  const sop = sopView(sopInput());
  return {
    clientName: "Harbor Millwork",
    sop,
    period: { start: "2026-10-22T00:00:00.000Z", end: "2026-11-21T00:00:00.000Z" },
    version: {
      id: "v7",
      number: 7,
      live: true,
      storedHash: "h",
      hashNow: "h",
      publishedByPerson: true,
      publishedBy: "Mezonas",
      publishedAt: "2026-11-12T00:00:00.000Z",
    },
    connections: [
      {
        id: "0199a000-0000-7000-8000-0000000000c1",
        connector: "qbo",
        name: "QuickBooks Online",
        auth: "oauth",
        credential: { version: 2, kid: KEY },
        connectionLevels: { read: "auto", create: "ask", update: "auto", delete: "off" },
        agentLevels: { read: "auto", create: "ask", update: "auto", delete: "off" },
        browserTier: null,
        usedBySteps: true,
        connectedBy: "Ada Ruiz",
        connectedAt: "2026-11-04T00:00:00.000Z",
        lastUsedAt: "2026-11-21T00:00:00.000Z",
      },
    ],
    activeKeyId: KEY,
    hipaa: false,
    covered: [],
    secondFactorRequired: true,
    setupModels: [
      { stepId: "read", model: "claude-sonnet-5-5" },
      { stepId: "match", model: "claude-haiku-5-5" },
    ],
    calls: [
      { provider: "anthropic", model: "claude-sonnet-5-5", action: "agent_turn", count: 400 },
      { provider: "openai", model: "openai:text-embedding-3-large", action: "embed", count: 12 },
    ],
    callsElsewhere: 0,
    foreignRefs: 0,
    actions: [action(), action({ asked: false, approvedBy: null })],
    ...over,
  };
}

const result = (outs: ReturnType<typeof runAssuranceChecks>, id: string) =>
  outs.find((o) => o.checkId === id);

/** Runs `fn` as if every provider page had been read on the page itself (the well-kept world). */
function withTermsConfirmed<T>(fn: () => T): T {
  const saved = { ...PROVIDER_TERMS };
  try {
    for (const [p, t] of Object.entries(PROVIDER_TERMS)) {
      if (t)
        PROVIDER_TERMS[p as keyof typeof PROVIDER_TERMS] = {
          ...t,
          sources: t.sources.map((x) => ({ ...x, read: "page" as const })),
        };
    }
    return fn();
  } finally {
    Object.assign(PROVIDER_TERMS, saved);
  }
}

describe("the checks (docs/agent-assurance-plan.md §4)", () => {
  it("has one function per built check, and every check proves register controls", () => {
    expect(checkFunctionIds().sort()).toEqual(
      CHECKS.filter((c) => c.built)
        .map((c) => c.id)
        .sort(),
    );
    const ids = new Set(CONTROLS.map((c) => c.id));
    for (const c of CHECKS) for (const ctl of c.controls) expect(ids.has(ctl), ctl).toBe(true);
    expect(CHECKS.map((c) => c.number)).toEqual(CHECKS.map((_, i) => `K${i + 1}`));
  });

  it("verifies a well set-up agent, and never says failed", () => {
    const outs = withTermsConfirmed(() => runAssuranceChecks(input()));
    for (const o of outs)
      expect(["verified", "not_applicable"], `${o.checkId}: ${o.found}`).toContain(o.result);
    expect(result(outs, "approval_before_change")?.found).toBe(
      "2 changes in the period: 1 approved by a person first, 1 allowed to run on their own",
    );
    expect(result(outs, "unattended_writes")?.found).toContain("step 6, Attach the PDF");
    expect(result(outs, "no_blocked_sites")?.result).toBe("not_applicable");
    expect(result(outs, "providers_listed")?.found).toContain("Anthropic, 400 calls");
    expect(result(outs, "providers_listed")?.found).toContain("OpenAI, 12 calls");
  });

  it("puts in review what doesn't hold, with the record ids and nothing else", () => {
    const unsigned = action({ approvedBy: null });
    const outs = withTermsConfirmed(() =>
      runAssuranceChecks(
        input({
          actions: [unsigned, action({ audited: false }), action({ approverIsMember: false })],
          connections: [
            {
              ...(input().connections[0] as AssuranceInput["connections"][number]),
              credential: { version: 1, kid: null },
              agentLevels: { read: "auto", create: "ask", update: "auto", delete: "ask" },
              usedBySteps: false,
            },
          ],
          secondFactorRequired: false,
          version: { ...input().version, hashNow: "other" },
          hipaa: true,
          covered: ["anthropic"],
        }),
      ),
    );
    const review = outs.filter((o) => o.result === "in_review").map((o) => o.checkId);
    expect(review.sort()).toEqual(
      [
        "access_within_connection",
        "approval_before_change",
        "approvals_audited",
        "approvers_current",
        "delete_off",
        "providers_listed",
        "reads_only_needed",
        "second_factor",
        "secrets_client_key",
        "version_approved",
      ].sort(),
    );
    expect(result(outs, "approval_before_change")?.evidence.unsigned).toEqual([unsigned.id]);
    expect(result(outs, "providers_listed")?.found).toBe("No BAA yet with OpenAI");
  });

  it("is in review for a provider whose training terms aren't recorded", () => {
    const outs = runAssuranceChecks(
      input({
        calls: [
          { provider: "xai", model: "xai:grok-4.7", action: "agent_turn", count: 3 },
          { provider: "anthropic_web", model: "web", action: "agent_turn", count: 1 },
        ],
      }),
    );
    expect(result(outs, "no_training")?.result).toBe("in_review");
    expect(result(outs, "no_training")?.found).toBe(
      "Not recorded yet for Anthropic web search and fetch",
    );
  });

  it("records each model provider's terms from its own pages (§1.231.1)", () => {
    for (const p of ["anthropic", "openai", "xai", "google"] as const) {
      expect(providerTerms(p).training, p).toBe("no");
      expect(providerTerms(p).retention, p).toBeTruthy();
    }
    // OpenAI's page doesn't say where a project without data residency is processed.
    expect(providerTerms("openai").region).toBeNull();
    expect(providerKeeps("openai")).toMatch(
      /up to 30 days.*Where: not recorded yet\. Not yet confirmed on the provider's own page\.$/,
    );
    // Each entry cites its pages, with the day checked and how each was read.
    for (const p of ["anthropic", "openai", "xai", "google"] as const) {
      expect(providerTerms(p).sources.length, p).toBeGreaterThan(0);
      for (const s of providerTerms(p).sources) {
        expect(s.url, p).toMatch(/^https:\/\//);
        expect(s.checked, p).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      // Read from search results until someone reads the pages themselves.
      expect(termsConfirmed(p), p).toBe(false);
    }
    expect(providerTerms("twilio").sources).toEqual([]);
    expect(providerKeeps("xai")).toMatch(/^Requests and responses kept 30 days/);
    expect(providerKeeps("twilio")).toBe("Not recorded yet");
    const outs = runAssuranceChecks(
      input({
        calls: [
          { provider: "xai", model: "xai:grok-4.7", action: "agent_turn", count: 3 },
          { provider: "google", model: "google:gemini-3.1-pro", action: "agent_turn", count: 1 },
        ],
      }),
    );
    // Read only from search results: never verified, always "to be confirmed".
    expect(result(outs, "no_training")?.result).toBe("in_review");
    expect(result(outs, "no_training")?.found).toMatch(
      /^To be confirmed on the provider's own page for .*xAI and Google/,
    );
    expect(trainingWords("xai")).toBe("no training, to be confirmed on the provider's own page");
    expect(trainingWords("twilio")).toBe("training terms not recorded yet");
  });

  it("verifies training terms only once every page is read on the page itself", () => {
    const saved = PROVIDER_TERMS.xai;
    if (!saved) throw new Error("xai terms missing");
    try {
      PROVIDER_TERMS.xai = {
        ...saved,
        sources: saved.sources.map((s) => ({ ...s, read: "page" as const })),
      };
      expect(termsConfirmed("xai")).toBe(true);
      expect(trainingWords("xai")).toBe("no training");
      expect(providerKeeps("xai")).not.toMatch(/Not yet confirmed/);
      const one = () =>
        runAssuranceChecks(
          input({
            calls: [{ provider: "xai", model: "xai:grok-4.7", action: "agent_turn", count: 1 }],
          }),
        );
      // Only xAI is confirmed here; the agent's other providers keep the check in review.
      expect(result(one(), "no_training")?.result).toBe("in_review");
      expect(result(one(), "no_training")?.found).not.toMatch(/xAI/);
      expect(result(withTermsConfirmed(one), "no_training")?.result).toBe("verified");
    } finally {
      PROVIDER_TERMS.xai = saved;
    }
  });
});

describe("every control accounted for (§4a)", () => {
  it("places every register control in exactly one state", () => {
    const placed = new Set([
      ...checkedControls(),
      ...INHERITED_CONTROLS,
      ...notApplicable(false).map((x) => x.id),
    ]);
    for (const c of CONTROLS) expect(placed.has(c.id), `${c.id} isn't placed`).toBe(true);
    const states = agentCoverage(false);
    expect(states).toHaveLength(CONTROLS.length);
    expect(
      states
        .filter((s) => s.state === "checked")
        .map((s) => s.id)
        .sort(),
    ).toEqual(checkedControls().sort());
    expect(states.find((s) => s.id === "VEN-4")?.state).toBe("not_applicable");
    expect(agentCoverage(true).find((s) => s.id === "VEN-4")?.state).toBe("inherited");
    expect(states.every((s) => s.hipaa.length === 0)).toBe(true);
  });
});

describe("the view (§5)", () => {
  const stored = (over: Partial<StoredResult> = {}): StoredResult => ({
    checkId: "delete_off",
    result: "verified",
    found: "Off on QuickBooks Online",
    evidence: { connections: ["c1"] },
    checkedAt: "2026-11-21T03:00:00.000Z",
    issueId: null,
    inReviewSince: null,
    ...over,
  });

  it("shows the client a check in review without what it found, and us everything", () => {
    const rows = [
      stored(),
      stored({
        checkId: "providers_listed",
        result: "in_review",
        found: "3 calls to OpenAI",
        evidence: { calls: 3 },
        issueId: "i1",
        inReviewSince: "2026-11-21T03:00:00.000Z",
      }),
    ];
    const opts = { asOf: "2026-11-21T09:00:00.000Z", agent: { id: "a1", name: "Bills in" } };
    const client = assuranceView(input(), rows, { ...opts, audience: "client" });
    expect(AssuranceView.parse(client)).toBeTruthy();
    const review = client.checks.find((c) => c.id === "providers_listed");
    expect(review).toMatchObject({
      result: "in_review",
      found: "",
      since: "2026-11-21T03:00:00.000Z",
    });
    expect(review).not.toHaveProperty("evidence");
    expect(client.checks.find((c) => c.id === "untrusted_text")?.result).toBe("not_checked");
    expect(client.counts).toMatchObject({
      verified: 1,
      inReview: 1,
      notChecked: CHECKS.length - 2,
    });
    expect(JSON.stringify(client)).not.toMatch(FORBIDDEN_PORTAL_FIELD);
    expect(JSON.stringify(client)).not.toContain("SECRET INSTRUCTIONS");

    const ops = assuranceView(input(), rows, { ...opts, audience: "ops" });
    expect(ops.checks.find((c) => c.id === "providers_listed")).toMatchObject({
      found: "3 calls to OpenAI",
      evidence: { calls: 3 },
      issueId: "i1",
    });
  });

  it("draws the architecture from the setup: its systems, people, AI providers and flows", () => {
    const v = assuranceView(input(), [], {
      audience: "client",
      asOf: "x",
      agent: { id: "a", name: "Bills in" },
    });
    const titles = v.architecture.boxes.map((b) => `${b.zone}:${b.title}`);
    expect(titles).toContain("business:QuickBooks Online");
    expect(titles).toContain("ai:Anthropic");
    expect(titles).toContain("ai:OpenAI");
    expect(titles).toContain("mezonas:The vault");
    expect(v.architecture.flows.filter((f) => f.ai)).toHaveLength(2);
    expect(v.ai.map((r) => `${r.use} · ${r.provider}`)).toEqual([
      "Step 1, Read the bill · Anthropic",
      "Step 3, Match each line · Anthropic",
      "Search by meaning · OpenAI",
    ]);
    expect(v.ai[0]?.providerKeeps).toMatch(/within 30 days.*Where: Any available geography/);
    // What the client sees never presents a term read only from a search result as confirmed.
    for (const r of v.ai) {
      expect(r.providerKeeps).toMatch(/Not yet confirmed on the provider's own page\.$/);
      expect(r.protection).toMatch(/no training, to be confirmed on the provider's own page$/);
    }
    for (const b of v.architecture.boxes.filter((b) => b.zone === "ai")) {
      expect(b.lines).toContain("TLS · no training, to be confirmed on the provider's own page");
    }
    expect(v.checks.find((c) => c.id === "no_training")?.result).not.toBe("verified");
    expect(v.access[0]).toMatchObject({
      tool: "QuickBooks Online",
      signsIn: "OAuth: you signed in to it for us",
    });
    expect(v.checks.every((c) => c.hipaa.length === 0)).toBe(true);
    expect(v.checks.find((c) => c.id === "delete_off")?.soc2).toEqual(["CC8.1", "PI1.3"]);
  });

  it("says each level in words", () => {
    expect(levelsWords({ read: "auto", create: "ask", update: null, delete: "off" })).toBe(
      "Read on its own · Create ask first · Delete off",
    );
    expect(levelsWords({ read: null, create: null, update: null, delete: null })).toBe(
      "Receive only",
    );
  });
});
