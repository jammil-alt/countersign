// The SOP's section 14 and the back office's Security tab, made by code (docs/agent-assurance-plan.md
// §3–§5): the architecture drawn from the agent's setup, every check with its latest stored result,
// every register control in its state, what the agent pulls and keeps and where, what goes to AI
// and how it is protected, and access to each tool.
//
// DECISION (§5): one builder for both audiences. The client's view leaves out the evidence and
// the issue, and says only "In review since <date>" for a check in review (owner, 2026-11-21).

import { PROCESSOR_NAMES, processorForModel } from "../compliance/processors";
import type { SopLevel, SopStepLine } from "../sop/view";
import {
  type AssuranceConnection,
  type AssuranceInput,
  agentProviders,
  CHECKS,
  type CheckResultValue,
  type Levels,
} from "./checks";
import { agentCoverage, controlRefs } from "./coverage";
import { providerKeeps, providerTerms } from "./terms";
import type { ArchBox, ArchFlow, Architecture, AssuranceCheckRow, AssuranceView } from "./view";

/** A check's latest stored result (`control_check`), and since when it has been in review. */
export type StoredResult = {
  checkId: string;
  result: CheckResultValue;
  found: string;
  evidence: Record<string, unknown>;
  checkedAt: string;
  issueId: string | null;
  inReviewSince: string | null;
};

const LEVEL_WORDS: Record<SopLevel, string> = { auto: "on its own", ask: "ask first", off: "off" };
const VERB_WORDS = { read: "Read", create: "Create", update: "Update", delete: "Delete" } as const;

/** "Read on its own · Create ask first · Delete off". */
export function levelsWords(l: Levels): string {
  const parts = (Object.keys(VERB_WORDS) as (keyof Levels)[])
    .filter((v) => l[v])
    .map((v) => `${VERB_WORDS[v]} ${LEVEL_WORDS[l[v] as SopLevel]}`);
  return parts.length > 0 ? parts.join(" · ") : "Receive only";
}

const SIGNS_IN: Record<AssuranceConnection["auth"], string> = {
  oauth: "OAuth: you signed in to it for us",
  key: "A key you made for us",
  login: "A login you entered in the vault",
  none: "Nothing to sign in to",
};

const KEPT_WHILE = "While you're a client; deleted within 30 days after you leave";
const YOUR_TEAM = "Your team; Mezonas operators who serve you";

function steps(input: AssuranceInput): SopStepLine[] {
  return input.sop.procedure.filter((l): l is SopStepLine => l.line === "step");
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

// ── The architecture ─────────────────────────────────────────────────────────────────────────────

export function agentArchitecture(input: AssuranceInput): Architecture {
  const boxes: ArchBox[] = [];
  const flows: ArchFlow[] = [];
  const lines = steps(input);
  const sopControlsFor = (stepNumbers: readonly string[]) =>
    input.sop.controls
      .filter((c) => c.allSteps || c.steps.some((s) => stepNumbers.includes(s)))
      .map((c) => c.id);

  // Your business: each connected system, then your people.
  for (const sys of input.sop.systems.filter((s) => s.connected)) {
    const conn = input.connections.find((c) => c.id === sys.key || c.name === sys.name);
    boxes.push({
      key: `system:${sys.key}`,
      zone: "business",
      title: sys.name,
      lines: [
        ...(sys.account ? [sys.account] : []),
        ...(conn ? [SIGNS_IN[conn.auth]] : []),
        levelsWords({ read: sys.read, create: sys.create, update: sys.update, delete: sys.delete }),
      ],
      person: false,
    });
    const verbs = (["read", "create", "update", "delete"] as const).filter(
      (v) => sys[v] && sys[v] !== "off",
    );
    const writes = verbs.some((v) => v !== "read");
    flows.push({
      from: writes ? "mezonas:run" : `system:${sys.key}`,
      to: writes ? `system:${sys.key}` : "mezonas:run",
      label: verbs.length > 0 ? verbs.join(", ") : "receives",
      refs: [...sopControlsFor(sys.steps), ...(writes ? ["AGT-1"] : [])],
      ai: false,
    });
  }
  const approvers: string[] = [];
  for (const s of lines) {
    for (const a of s.approval?.approvers ?? []) {
      const line = `${a.party.name} approves${a.condition ? ` ${a.condition}` : ""}`;
      if (a.party.kind === "person" && !approvers.includes(line)) approvers.push(line);
    }
  }
  // People by name only: roles ("Your admin"), Mezonas and its lead aren't the client's people.
  const people = input.sop.roles.filter((r) => r.party.kind === "person" && r.party.key !== "lead");
  if (approvers.length > 0 || people.length > 0) {
    boxes.push({
      key: "business:people",
      zone: "business",
      title: "Your people",
      lines: [
        ...(approvers.length > 0
          ? approvers
          : [...new Set(people.map((r) => r.party.name))].slice(0, 4)),
        ...(input.secondFactorRequired ? ["Sign in with a second factor"] : []),
      ],
      person: true,
    });
    if (approvers.length > 0) {
      flows.push({
        from: "mezonas:run",
        to: "business:people",
        label: "approval cards",
        refs: input.sop.controls.filter((c) => c.key.startsWith("approval:")).map((c) => c.id),
        ai: false,
      });
    }
  }

  // Mezonas.
  boxes.push({
    key: "mezonas:run",
    zone: "mezonas",
    title: "The run",
    lines: [
      "Cloudflare Workers and Workflows",
      "The permission gate decides every call to your tools",
      "Each change made once, with the state before it",
    ],
    person: false,
  });
  boxes.push({
    key: "mezonas:records",
    zone: "mezonas",
    title: "Your records",
    lines: ["Postgres, walled off to your client"],
    person: false,
  });
  if (input.connections.some((c) => c.credential)) {
    boxes.push({
      key: "mezonas:vault",
      zone: "mezonas",
      title: "The vault",
      lines: ["Secrets under your own key"],
      person: false,
    });
    flows.push({
      from: "mezonas:vault",
      to: "mezonas:run",
      label: "one step at a time",
      refs: ["DAT-3"],
      ai: false,
    });
  }
  boxes.push({
    key: "mezonas:documents",
    zone: "mezonas",
    title: "Documents",
    lines: ["R2, encrypted"],
    person: false,
  });
  boxes.push({
    key: "mezonas:audit",
    zone: "mezonas",
    title: "Audit log",
    lines: ["Kept 6 years"],
    person: false,
  });
  flows.push({
    from: "mezonas:run",
    to: "mezonas:records",
    label: "saves",
    refs: ["ISO-1"],
    ai: false,
  });

  // AI providers.
  for (const p of agentProviders(input)) {
    const models = input.setupModels
      .filter((m) => processorForModel(m.model) === p)
      .map((m) => {
        const s = lines.find((l) => l.id === m.stepId);
        return s ? `${s.model ?? m.model} (step ${s.number})` : m.model;
      });
    const calls = input.calls.filter((c) => c.provider === p && /embed/.test(c.action));
    const t = providerTerms(p);
    boxes.push({
      key: `ai:${p}`,
      zone: "ai",
      title: PROCESSOR_NAMES[p],
      lines: [
        ...[...new Set(models)],
        ...(calls.length > 0 ? ["Embeddings for search by meaning"] : []),
        t.training === "no"
          ? "TLS · no training (API terms)"
          : "TLS · training terms not recorded yet",
        input.hipaa
          ? input.covered.includes(p)
            ? "BAA signed"
            : "No BAA yet"
          : "BAA: not needed (HIPAA mode off)",
      ],
      person: false,
    });
    flows.push({
      from: "mezonas:run",
      to: `ai:${p}`,
      label:
        calls.length > 0 && models.length === 0
          ? "names to search, as data"
          : "your documents' text, as data",
      refs: ["VEN-1", "AGT-2"],
      ai: true,
    });
  }

  const zones = [
    { key: "business" as const, title: "Your business" },
    { key: "mezonas" as const, title: "Mezonas" },
    ...(boxes.some((b) => b.zone === "ai") ? [{ key: "ai" as const, title: "AI providers" }] : []),
  ];
  return { zones, boxes, flows };
}

// ── Data, AI and access ─────────────────────────────────────────────────────────────────────────

function dataRows(input: AssuranceInput): AssuranceView["data"] {
  const rows: AssuranceView["data"] = input.sop.data.map((d) => ({
    data: d.record,
    fields: null,
    from: /read/i.test(d.agentDoes) ? d.livesIn : "Its own work",
    keptWhere: d.livesIn,
    keptFor: d.kept || KEPT_WHILE,
    whoSees: YOUR_TEAM,
    gap: false,
  }));
  rows.push({
    data: "Each run's step results",
    fields: null,
    from: "The run",
    keptWhere: "Your records, with the run's history",
    keptFor: KEPT_WHILE,
    whoSees: "Your team sees summaries; operators who serve you see the run",
    gap: false,
  });
  if (input.calls.length > 0 || input.setupModels.length > 0) {
    rows.push({
      data: "AI requests and answers",
      fields: null,
      from: "The run",
      keptWhere: "Your documents' store (R2)",
      keptFor: KEPT_WHILE,
      whoSees: "Mezonas operators who serve you",
      gap: false,
    });
  }
  return rows;
}

function aiRows(input: AssuranceInput): AssuranceView["ai"] {
  const lines = steps(input);
  const rows: AssuranceView["ai"] = [];
  const protection = (p: ReturnType<typeof processorForModel>) =>
    `TLS 1.2 or later; never your secrets or another client's data; ${
      providerTerms(p).training === "no" ? "no training" : "training terms not recorded yet"
    }`;
  for (const m of input.setupModels) {
    const s = lines.find((l) => l.id === m.stepId);
    const p = processorForModel(m.model);
    rows.push({
      use: s ? `Step ${s.number}, ${s.name}` : "A step",
      provider: PROCESSOR_NAMES[p],
      model: s?.model ?? m.model,
      sent:
        s?.method === "rules_then_ai"
          ? "Only what the rules can't place, as data"
          : "The step's input, as data",
      protection: protection(p),
      providerKeeps: providerKeeps(p),
    });
  }
  const embeds = new Map<string, (typeof input.calls)[number]>();
  for (const c of input.calls.filter((c) => /embed/.test(c.action)))
    embeds.set(`${c.provider}:${c.model}`, c);
  for (const c of embeds.values()) {
    rows.push({
      use: "Search by meaning",
      provider: PROCESSOR_NAMES[c.provider],
      model: c.model.replace(/^[a-z]+:/, ""),
      sent: "Item and record names only",
      protection: protection(c.provider),
      providerKeeps: providerKeeps(c.provider),
    });
  }
  return rows;
}

function accessRows(input: AssuranceInput): AssuranceView["access"] {
  const rows: AssuranceView["access"] = input.connections.map((c) => ({
    tool: c.name,
    detail:
      [
        c.connectedBy
          ? `Connected by ${c.connectedBy}${c.connectedAt ? `, ${shortDate(c.connectedAt)}` : ""}`
          : null,
        c.lastUsedAt ? `last used ${shortDate(c.lastUsedAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
    signsIn: SIGNS_IN[c.auth],
    credential: c.credential
      ? "In the vault, encrypted with your key, given to one step at a time; never shown or sent to AI. Disconnecting deletes it"
      : "None",
    agentMay: `${levelsWords(c.agentLevels)} (the stricter of your setting and its access)`,
    whoChanges: "Your admins; our changes only as you allow",
    person: false,
  }));
  const people = [
    ...new Set(
      steps(input).flatMap((s) =>
        (s.approval?.approvers ?? [])
          .filter((a) => a.party.kind === "person")
          .map((a) => a.party.name),
      ),
    ),
  ];
  if (people.length > 0) {
    rows.push({
      tool: "Your people",
      detail: people.join(", "),
      signsIn: input.secondFactorRequired
        ? "Their own sign-in, with a second factor"
        : "Their own sign-in",
      credential: "None kept by us",
      agentMay: "Approve and answer as the SOP says",
      whoChanges: "Your admins, on Team",
      person: true,
    });
  }
  return rows;
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────────

export function assuranceView(
  input: AssuranceInput,
  stored: readonly StoredResult[],
  opts: { audience: "client" | "ops"; asOf: string; agent: { id: string; name: string } },
): AssuranceView {
  const latest = new Map(stored.map((r) => [r.checkId, r]));
  const checks: AssuranceCheckRow[] = CHECKS.map((c) => {
    const r = latest.get(c.id);
    const refs = controlRefs(c.controls, input.hipaa);
    const base = {
      id: c.id,
      number: c.number,
      name: c.name,
      kind: c.kind,
      controls: [...c.controls],
      soc2: refs.soc2,
      hipaa: refs.hipaa,
    };
    if (!r) {
      return {
        ...base,
        result: "not_checked" as const,
        found: c.built ? "Checked tonight" : "Comes with the attack runs",
        since: null,
        checkedAt: null,
        ...(opts.audience === "ops" ? { evidence: {}, issueId: null } : {}),
      };
    }
    const review = r.result === "in_review";
    return {
      ...base,
      result: r.result,
      found: review && opts.audience === "client" ? "" : r.found,
      since: review ? r.inReviewSince : null,
      checkedAt: r.checkedAt,
      ...(opts.audience === "ops" ? { evidence: r.evidence, issueId: r.issueId } : {}),
    };
  });
  const count = (v: AssuranceCheckRow["result"]) => checks.filter((c) => c.result === v).length;
  const times = stored.map((r) => r.checkedAt).sort();
  return {
    agent: opts.agent,
    client: input.clientName,
    asOf: opts.asOf,
    period: input.period,
    hipaa: input.hipaa,
    version: input.version.number,
    architecture: agentArchitecture(input),
    counts: {
      checks: checks.length,
      verified: count("verified"),
      inReview: count("in_review"),
      notChecked: count("not_checked"),
      notApplicable: count("not_applicable"),
    },
    lastChecked: times.at(-1) ?? null,
    checks,
    coverage: agentCoverage(input.hipaa).map((c) => ({
      ...c,
      soc2: [...c.soc2],
      hipaa: [...c.hipaa],
    })),
    data: dataRows(input),
    ai: aiRows(input),
    access: accessRows(input),
  };
}
