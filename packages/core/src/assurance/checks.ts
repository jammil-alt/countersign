// An agent's security checks (docs/agent-assurance-plan.md §4, §4b): each proves one or more of the
// register's controls for one client agent, from its setup now or its runs over a period. Pure: the
// API gathers the inputs inside the client's scope (invariant 1); no model reads or writes a result.
//
// A result is Verified, In review or Not applicable, never "failed" (owner, 2026-11-21). A check
// with no stored result is "Not yet checked": the attack checks until the attack runs are built
// (A3), and every check of a new agent before its first night.
//
// Evidence is counts and record ids, never contents, secrets, prompts or message bodies
// (invariant 13).

import type { BrowserTier } from "../browser/site";
import { PROCESSOR_NAMES, type Processor, processorForModel } from "../compliance/processors";
import type { SopLevel, SopStepLine, SopView } from "../sop/view";
import { providerTerms } from "./terms";

export const CHECK_KINDS = ["setup", "runs", "attack"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_RESULTS = ["verified", "in_review", "not_applicable"] as const;
export type CheckResultValue = (typeof CHECK_RESULTS)[number];

export type CheckSpec = {
  /** Stable, stored in `control_check.check_id`. */
  id: string;
  /** "K1": its place in the list. */
  number: string;
  name: string;
  kind: CheckKind;
  /** Register control ids it proves (`compliance/controls.ts`). */
  controls: readonly string[];
  /** Whether it runs today; attack checks wait for A3. */
  built: boolean;
};

/** The checks, in the order the client reads them. */
export const CHECKS: readonly CheckSpec[] = (
  [
    {
      id: "approval_before_change",
      name: "No change without approval when it needs one",
      kind: "runs",
      controls: ["AGT-1"],
      built: true,
    },
    {
      id: "change_once",
      name: "Each change made once",
      kind: "runs",
      controls: ["AGT-1"],
      built: true,
    },
    { id: "delete_off", name: "Delete is off", kind: "setup", controls: ["AGT-1"], built: true },
    {
      id: "unattended_writes",
      name: "Changes without a person are the ones you allowed",
      kind: "setup",
      controls: ["AGT-1"],
      built: true,
    },
    {
      id: "access_within_connection",
      name: "Access no wider than the connection",
      kind: "setup",
      controls: ["ACC-4"],
      built: true,
    },
    {
      id: "secrets_client_key",
      name: "Secrets encrypted with your key",
      kind: "setup",
      controls: ["DAT-3"],
      built: true,
    },
    {
      id: "own_client_data",
      name: "Only your data in its setup",
      kind: "setup",
      controls: ["ISO-1", "ISO-2"],
      built: true,
    },
    {
      id: "providers_listed",
      name: "AI providers listed and allowed for you",
      kind: "runs",
      controls: ["VEN-1", "VEN-3"],
      built: true,
    },
    {
      id: "no_training",
      name: "No AI provider trains on your data",
      kind: "setup",
      controls: ["AGT-4"],
      built: true,
    },
    {
      id: "untrusted_text",
      name: "Text from documents and emails stays data",
      kind: "attack",
      controls: ["AGT-2"],
      built: false,
    },
    {
      id: "no_self_permission",
      name: "It can't change its own permissions or plan",
      kind: "attack",
      controls: ["AGT-2"],
      built: false,
    },
    {
      id: "trial_writes_signed",
      name: "Changes in its trial were all signed",
      kind: "runs",
      controls: ["AGT-1"],
      built: true,
    },
    {
      id: "no_blocked_sites",
      name: "No sign-in to blocked sites",
      kind: "setup",
      controls: ["AGT-2"],
      built: true,
    },
    {
      id: "version_approved",
      name: "Its version is the one published",
      kind: "setup",
      controls: ["AGT-3"],
      built: true,
    },
    {
      id: "approvals_audited",
      name: "Every approval is in the audit log",
      kind: "runs",
      controls: ["LOG-1"],
      built: true,
    },
    {
      id: "reads_only_needed",
      name: "Connected only to what its steps use",
      kind: "setup",
      controls: ["DAT-6"],
      built: true,
    },
    {
      id: "ai_calls_own_client",
      name: "Only your data in its AI calls",
      kind: "runs",
      controls: ["ISO-1"],
      built: true,
    },
    {
      id: "second_factor",
      name: "Your team signs in with a second factor",
      kind: "setup",
      controls: ["ACC-2"],
      built: true,
    },
    {
      id: "approvers_current",
      name: "Approvers were on your team",
      kind: "runs",
      controls: ["ACC-6"],
      built: true,
    },
  ] satisfies Omit<CheckSpec, "number">[]
).map((c, i) => ({ ...c, number: `K${i + 1}` }));

export function checkSpec(id: string): CheckSpec | undefined {
  return CHECKS.find((c) => c.id === id);
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

export type Levels = {
  read: SopLevel | null;
  create: SopLevel | null;
  update: SopLevel | null;
  delete: SopLevel | null;
};

export type AssuranceConnection = {
  id: string;
  connector: string;
  name: string;
  /** How it signs in, for the access table. */
  auth: "oauth" | "key" | "login" | "none";
  /** The stored credential's envelope: null when none is stored (email forwarding). */
  credential: { version: 1 | 2; kid: string | null } | null;
  /** The connection's own levels, as the client set them. */
  connectionLevels: Levels;
  /** This agent's, the strictest of the connection's, its grant and its steps'. */
  agentLevels: Levels;
  /** A browser connection's site tier; null for any other. */
  browserTier: BrowserTier | null;
  /** Whether a step of the live version uses it. */
  usedBySteps: boolean;
  connectedBy: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
};

export type AssuranceAction = {
  id: string;
  status: "proposed" | "approved" | "rejected" | "executing" | "done" | "failed";
  /** A person was asked first (an inbox item). */
  asked: boolean;
  approvedBy: string | null;
  idempotencyKey: string;
  /** Its before state was kept. */
  hasBefore: boolean;
  /** The approval has its audit row (who, when, from where). */
  audited: boolean;
  /** The approver is on the client's team now. */
  approverIsMember: boolean;
  /** Made while the agent was in its trial or sign-off stage. */
  duringTrial: boolean;
};

export type AssuranceCall = { provider: Processor; model: string; action: string; count: number };

export type AssuranceInput = {
  clientName: string;
  sop: SopView;
  period: { start: string; end: string };
  version: {
    id: string;
    number: number;
    live: boolean;
    storedHash: string;
    hashNow: string;
    publishedByPerson: boolean;
    publishedBy: string | null;
    publishedAt: string;
  };
  connections: readonly AssuranceConnection[];
  /** The client's active data key's id (`tenant_key`); null before its first secret. */
  activeKeyId: string | null;
  hipaa: boolean;
  /** Processors with a signed BAA (`BAA_PROCESSORS`). */
  covered: readonly Processor[];
  /** The sign-in policy: a second factor for everyone. */
  secondFactorRequired: boolean;
  /** The model each AI step of the live version runs on (the runtime's choice, `runModel`). */
  setupModels: readonly { stepId: string; model: string }[];
  /** The agent's model calls over the period, by provider, model and kind. */
  calls: readonly AssuranceCall[];
  /** The agent's runs' model calls stored under another client: zero unless isolation broke. */
  callsElsewhere: number;
  /** Bindings, contacts and notes of the agent that aren't this client's (or can't be found). */
  foreignRefs: number;
  actions: readonly AssuranceAction[];
};

export type CheckOutcome = {
  checkId: string;
  kind: CheckKind;
  controls: readonly string[];
  result: CheckResultValue;
  /** What it found, in a line. */
  found: string;
  evidence: Record<string, unknown>;
};

// ── The checks ───────────────────────────────────────────────────────────────────────────────────

const RANK: Record<SopLevel, number> = { off: 0, ask: 1, auto: 2 };
const VERBS = ["read", "create", "update", "delete"] as const;

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

const made = (a: AssuranceAction) =>
  a.status === "done" || a.status === "failed" || a.status === "executing";

function stepLines(sop: SopView): SopStepLine[] {
  return sop.procedure.filter((l): l is SopStepLine => l.line === "step");
}

/** Providers the agent's setup names and its runs called. */
export function agentProviders(input: AssuranceInput): Processor[] {
  const out = new Set<Processor>();
  for (const m of input.setupModels) out.add(processorForModel(m.model));
  for (const c of input.calls) out.add(c.provider);
  return [...out];
}

type Run = (input: AssuranceInput) => Omit<CheckOutcome, "checkId" | "kind" | "controls">;

const RUNS: Record<string, Run> = {
  approval_before_change(input) {
    const changes = input.actions.filter(made);
    if (changes.length === 0) {
      return {
        result: "not_applicable",
        found: "No changes to your tools in the period",
        evidence: { changes: 0 },
      };
    }
    const unsigned = changes.filter((a) => a.asked && !a.approvedBy);
    const approved = changes.filter((a) => a.approvedBy).length;
    const own = changes.filter((a) => !a.asked && !a.approvedBy).length;
    return {
      result: unsigned.length === 0 ? "verified" : "in_review",
      found:
        unsigned.length === 0
          ? `${n(changes.length, "change")} in the period: ${approved} approved by a person first, ${own} allowed to run on their own`
          : `${n(unsigned.length, "change")} made after a person was asked, without their approval`,
      evidence: { changes: changes.length, approved, own, unsigned: unsigned.map((a) => a.id) },
    };
  },

  change_once(input) {
    const changes = input.actions.filter(made);
    if (changes.length === 0) {
      return {
        result: "not_applicable",
        found: "No changes to your tools in the period",
        evidence: { changes: 0 },
      };
    }
    const seen = new Map<string, number>();
    for (const a of changes) seen.set(a.idempotencyKey, (seen.get(a.idempotencyKey) ?? 0) + 1);
    const twice = [...seen.values()].filter((v) => v > 1).length;
    const before = changes.filter((a) => a.hasBefore).length;
    return {
      result: twice === 0 ? "verified" : "in_review",
      found:
        twice === 0
          ? `${n(changes.length, "change")}, each key used once; ${before} with the state before kept`
          : `${n(twice, "change")} made more than once`,
      evidence: { changes: changes.length, keysUsedTwice: twice, beforeKept: before },
    };
  },

  delete_off(input) {
    const open = input.connections.filter(
      (c) => c.agentLevels.delete && c.agentLevels.delete !== "off",
    );
    const withDelete = input.connections.filter((c) => c.agentLevels.delete);
    return {
      result: open.length === 0 ? "verified" : "in_review",
      found:
        open.length === 0
          ? withDelete.length === 0
            ? "None of its systems lets it delete"
            : `Off on ${list(withDelete.map((c) => c.name))}`
          : `Delete isn't off on ${list(open.map((c) => c.name))}`,
      evidence: { connections: input.connections.map((c) => c.id), open: open.map((c) => c.id) },
    };
  },

  unattended_writes(input) {
    const steps = stepLines(input.sop).filter((s) => s.approval?.level === "auto");
    return {
      result: "verified",
      found:
        steps.length === 0
          ? "None: every change waits for a person"
          : `${steps.length}: ${list(steps.map((s) => `step ${s.number}, ${s.name}`))}. Each was set by us on the step and allowed by you on the connection`,
      evidence: { steps: steps.map((s) => s.id) },
    };
  },

  access_within_connection(input) {
    const wider: string[] = [];
    for (const c of input.connections) {
      for (const v of VERBS) {
        const a = c.agentLevels[v];
        const k = c.connectionLevels[v];
        if (a && (!k || RANK[a] > RANK[k])) wider.push(`${c.name} ${v}`);
      }
    }
    if (input.connections.length === 0) {
      return {
        result: "not_applicable",
        found: "It has no connections to your tools",
        evidence: {},
      };
    }
    return {
      result: wider.length === 0 ? "verified" : "in_review",
      found:
        wider.length === 0
          ? `${list(input.connections.map((c) => c.name))}: the agent's access is within the connection's`
          : `Wider than the connection: ${list(wider)}`,
      evidence: { connections: input.connections.map((c) => c.id), wider },
    };
  },

  secrets_client_key(input) {
    const stored = input.connections.filter((c) => c.credential);
    if (stored.length === 0) {
      return {
        result: "not_applicable",
        found: "None of its connections stores a secret",
        evidence: {},
      };
    }
    const off = stored.filter(
      (c) =>
        c.credential?.version !== 2 || !input.activeKeyId || c.credential.kid !== input.activeKeyId,
    );
    return {
      result: off.length === 0 ? "verified" : "in_review",
      found:
        off.length === 0
          ? `${list(stored.map((c) => c.name))}: wrapped with your client's active key`
          : `Not yet under your key: ${list(off.map((c) => c.name))}`,
      evidence: { connections: stored.map((c) => c.id), notUnderKey: off.map((c) => c.id) },
    };
  },

  own_client_data(input) {
    return {
      result: input.foreignRefs === 0 ? "verified" : "in_review",
      found:
        input.foreignRefs === 0
          ? `Its connections, contacts, documents and notes are all ${input.clientName}'s`
          : `${n(input.foreignRefs, "reference")} to something that isn't ${input.clientName}'s`,
      evidence: { foreign: input.foreignRefs },
    };
  },

  providers_listed(input) {
    const providers = agentProviders(input);
    if (providers.length === 0) {
      return { result: "not_applicable", found: "It uses no AI", evidence: {} };
    }
    const uncovered = input.hipaa ? providers.filter((p) => !input.covered.includes(p)) : [];
    const counts = providers.map((p) => {
      const calls = input.calls.filter((c) => c.provider === p).reduce((s, c) => s + c.count, 0);
      return `${PROCESSOR_NAMES[p]}, ${n(calls, "call")}`;
    });
    return {
      result: uncovered.length === 0 ? "verified" : "in_review",
      found:
        uncovered.length === 0
          ? `${list(counts)} in the period; each listed on our subprocessors page${input.hipaa ? ", with a BAA" : ""}`
          : `No BAA yet with ${list(uncovered.map((p) => PROCESSOR_NAMES[p]))}`,
      evidence: { providers, uncovered, calls: input.calls.map((c) => ({ ...c })) },
    };
  },

  no_training(input) {
    const providers = agentProviders(input);
    if (providers.length === 0) {
      return { result: "not_applicable", found: "It uses no AI", evidence: {} };
    }
    const unknown = providers.filter((p) => providerTerms(p).training !== "no");
    return {
      result: unknown.length === 0 ? "verified" : "in_review",
      found:
        unknown.length === 0
          ? `${list(providers.map((p) => PROCESSOR_NAMES[p]))}, through their APIs, under terms that exclude training`
          : `Not recorded yet for ${list(unknown.map((p) => PROCESSOR_NAMES[p]))}`,
      evidence: { providers, unknown },
    };
  },

  trial_writes_signed(input) {
    const trial = input.actions.filter((a) => a.duringTrial && made(a));
    if (trial.length === 0) {
      return {
        result: "not_applicable",
        found: "No changes in a trial or sign-off stage in the period",
        evidence: {},
      };
    }
    const unsigned = trial.filter((a) => !a.approvedBy);
    return {
      result: unsigned.length === 0 ? "verified" : "in_review",
      found:
        unsigned.length === 0
          ? `${n(trial.length, "change")} in its trial, each signed by a person`
          : `${n(unsigned.length, "change")} in its trial without a person's signature`,
      evidence: { trial: trial.length, unsigned: unsigned.map((a) => a.id) },
    };
  },

  no_blocked_sites(input) {
    const browser = input.connections.filter((c) => c.browserTier);
    if (browser.length === 0) {
      return { result: "not_applicable", found: "It has no website logins", evidence: {} };
    }
    const blocked = browser.filter((c) => c.browserTier === "blocked");
    return {
      result: blocked.length === 0 ? "verified" : "in_review",
      found:
        blocked.length === 0
          ? `${list(browser.map((c) => c.name))}: none on a blocked site`
          : `A login on a blocked site: ${list(blocked.map((c) => c.name))}`,
      evidence: { browser: browser.map((c) => c.id), blocked: blocked.map((c) => c.id) },
    };
  },

  version_approved(input) {
    const v = input.version;
    const ok = v.live && v.storedHash === v.hashNow && v.publishedByPerson;
    return {
      result: ok ? "verified" : "in_review",
      found: ok
        ? `Version ${v.number}'s stored fingerprint matches; published by ${v.publishedBy ?? "Mezonas"}`
        : !v.live
          ? `Version ${v.number} isn't the live version`
          : v.storedHash !== v.hashNow
            ? `Version ${v.number} doesn't match its stored fingerprint`
            : `Version ${v.number} wasn't published by a person`,
      evidence: {
        version: v.id,
        matches: v.storedHash === v.hashNow,
        byPerson: v.publishedByPerson,
      },
    };
  },

  approvals_audited(input) {
    const approved = input.actions.filter((a) => a.asked && a.approvedBy);
    if (approved.length === 0) {
      return { result: "not_applicable", found: "No approvals in the period", evidence: {} };
    }
    const missing = approved.filter((a) => !a.audited);
    return {
      result: missing.length === 0 ? "verified" : "in_review",
      found:
        missing.length === 0
          ? `${n(approved.length, "approval")}, each with its audit row`
          : `${n(missing.length, "approval")} without an audit row`,
      evidence: { approvals: approved.length, missing: missing.map((a) => a.id) },
    };
  },

  reads_only_needed(input) {
    if (input.connections.length === 0) {
      return {
        result: "not_applicable",
        found: "It has no connections to your tools",
        evidence: {},
      };
    }
    const unused = input.connections.filter((c) => !c.usedBySteps);
    return {
      result: unused.length === 0 ? "verified" : "in_review",
      found:
        unused.length === 0
          ? "Every connection it has is used by one of its steps"
          : `Connected to ${list(unused.map((c) => c.name))}, which no step uses`,
      evidence: { unused: unused.map((c) => c.id) },
    };
  },

  ai_calls_own_client(input) {
    const total = input.calls.reduce((s, c) => s + c.count, 0);
    if (total === 0 && input.callsElsewhere === 0) {
      return { result: "not_applicable", found: "No AI calls in the period", evidence: {} };
    }
    return {
      result: input.callsElsewhere === 0 ? "verified" : "in_review",
      found:
        input.callsElsewhere === 0
          ? `${n(total, "call")}, all from ${input.clientName}'s runs`
          : `${n(input.callsElsewhere, "call")} stored under another client`,
      evidence: { calls: total, elsewhere: input.callsElsewhere },
    };
  },

  second_factor(input) {
    return {
      result: input.secondFactorRequired ? "verified" : "in_review",
      found: input.secondFactorRequired
        ? "A second factor is required at every sign-in"
        : "A second factor isn't required at sign-in yet",
      evidence: { required: input.secondFactorRequired },
    };
  },

  approvers_current(input) {
    const approved = input.actions.filter((a) => a.approvedBy);
    if (approved.length === 0) {
      return { result: "not_applicable", found: "No approvals in the period", evidence: {} };
    }
    const gone = approved.filter((a) => !a.approverIsMember);
    return {
      result: gone.length === 0 ? "verified" : "in_review",
      found:
        gone.length === 0
          ? `${n(approved.length, "approval")}, each by someone on your team`
          : `${n(gone.length, "approval")} by people no longer on your team; we check they approved before they left`,
      evidence: { approvals: approved.length, notMembers: gone.map((a) => a.id) },
    };
  },
};

/** Every built check's outcome for one agent. */
export function runAssuranceChecks(input: AssuranceInput): CheckOutcome[] {
  return CHECKS.filter((c) => c.built).map((c) => {
    const run = RUNS[c.id];
    if (!run) throw new Error(`no check function for ${c.id}`);
    return { checkId: c.id, kind: c.kind, controls: c.controls, ...run(input) };
  });
}

/** A check built but with no function, or a function with no check: both are mistakes. */
export function checkFunctionIds(): string[] {
  return Object.keys(RUNS);
}
