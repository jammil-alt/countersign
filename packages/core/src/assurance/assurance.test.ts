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
    const outs = runAssuranceChecks(input());
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
    const outs = runAssuranceChecks(
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
        calls: [{ provider: "xai", model: "xai:grok-4.7", action: "agent_turn", count: 3 }],
      }),
    );
    expect(result(outs, "no_training")?.result).toBe("in_review");
    expect(result(outs, "no_training")?.found).toBe("Not recorded yet for xAI");
  });
});

describe("no secret in its AI requests, and OAuth scopes (§1.231.2)", () => {
  const scan = {
    calls: 12,
    read: 12,
    missing: 0,
    secrets: 3,
    unreadable: 0,
    withSecret: [] as string[],
    secretShaped: [] as { id: string; kinds: string[] }[],
  };
  const grant = {
    id: "0199a000-0000-7000-8000-0000000000c1",
    name: "Gmail",
    granted: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
    beyond: [] as string[],
  };

  it("is not checked when the stored requests and grants weren't read (a view)", () => {
    const outs = runAssuranceChecks(input());
    expect(result(outs, "no_secret_to_model")).toBeUndefined();
    expect(result(outs, "oauth_scopes")).toBeUndefined();
  });

  it("verifies requests that hold no secret, and grants within what we ask", () => {
    const outs = runAssuranceChecks(input({ requestScan: scan, oauthGrants: [grant] }));
    expect(result(outs, "no_secret_to_model")).toMatchObject({
      result: "verified",
      found:
        "12 stored AI requests, none holding a stored secret or a key or token; 3 secrets looked for",
    });
    expect(result(outs, "oauth_scopes")).toMatchObject({
      result: "verified",
      found: "Gmail: granted only the scopes we ask for",
    });
  });

  it("puts in review a request with a secret, by call id only, and a grant beyond our ask", () => {
    const outs = runAssuranceChecks(
      input({
        requestScan: {
          ...scan,
          withSecret: ["m1"],
          secretShaped: [{ id: "m2", kinds: ["model_api_key"] }],
        },
        oauthGrants: [{ ...grant, beyond: ["gmail.readonly"] }],
      }),
    );
    const s = result(outs, "no_secret_to_model");
    expect(s?.result).toBe("in_review");
    expect(s?.evidence).toMatchObject({ withSecret: ["m1"], secretShaped: [{ id: "m2" }] });
    expect(result(outs, "oauth_scopes")).toMatchObject({
      result: "in_review",
      found: "Granted more than we ask for: Gmail (gmail.readonly)",
    });
  });

  it("is not applicable with no calls or no OAuth, and not yet checked when it can't read", () => {
    let outs = runAssuranceChecks(
      input({ requestScan: { ...scan, calls: 0, read: 0 }, oauthGrants: [] }),
    );
    expect(result(outs, "no_secret_to_model")?.result).toBe("not_applicable");
    expect(result(outs, "oauth_scopes")?.result).toBe("not_applicable");
    outs = runAssuranceChecks(
      input({
        requestScan: { ...scan, read: 0, missing: 12 },
        oauthGrants: [grant, { ...grant, id: "q", name: "QuickBooks Online", granted: null }],
      }),
    );
    expect(result(outs, "no_secret_to_model")).toBeUndefined();
    expect(result(outs, "oauth_scopes")).toBeUndefined();
    outs = runAssuranceChecks(input({ requestScan: { ...scan, unreadable: 1 } }));
    expect(result(outs, "no_secret_to_model")?.result).toBe("in_review");
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
