// What a step reads of governance (docs/builder-plan.md §8), in order: the Mezonas guardrails, then
// the client's confirmed charter (its own words: it may add rules, never loosen ours), then the
// policies whose tags match what the step does, ours before the client's. Pure, so the runtime,
// its tests and any preview read the same text.
//
// The order is fixed (guardrails, charter, our policies in their list order, the client's by id),
// so the same step of the same client sends the same prefix every time and the model's prompt
// cache keeps it.

import { MEZONAS_GUARDRAILS } from "./guardrails";
import { STANDARD_POLICIES } from "./policies";
import type { GovernanceTag } from "./tags";

/** What a step does, as far as governance cares; worked out by the runtime from its tools. */
export interface StepGovernanceProfile {
  /** It proposes changes to a client's tool (an external write tool is offered). */
  writes: boolean;
  /** One of its writes carries an amount (a tool declares `amount`). */
  money: boolean;
  /** It writes to people (a send tool naming a recipient, a reach-out, a conversation). */
  contacts: boolean;
  /** It reads or changes a client's tool, its documents or a website. */
  connected: boolean;
  /** The business areas it works in: the agent's process area and its tools' areas. */
  areas: readonly string[];
  /** An AI (task) skill: the guardrails only, so it stays lean and the same in any agent. */
  lean?: boolean;
}

/** The client's confirmed charter: the latest version a client admin confirmed. */
export interface ClientCharter {
  entryId: string;
  version: number;
  title: string;
  body: string;
}

/** One of the client's tagged policies, as currently saved. */
export interface ClientPolicy {
  entryId: string;
  version: number;
  title: string;
  body: string;
  tags: readonly string[];
}

export interface ClientGovernance {
  charter: ClientCharter | null;
  policies: readonly ClientPolicy[];
}

/** One document a step read: what a run records so a replay knows what it saw. */
export interface GovernanceRead {
  tier: "guardrails" | "charter" | "policy";
  source: "mezonas" | "client";
  id: string;
  version: string;
}

/** The tags a step reads by. Every step reads its areas'. */
// DECISION: writing into tools for any external write; money only when a write carries an amount
// (the tool's `amount`, the same field approver rules read); contacting people and people and
// roles for a step that writes to people; security and data handling for a step that reaches a
// client's tool, documents or a site. A step that only thinks over its input reads its areas'.
export function stepTags(p: StepGovernanceProfile): GovernanceTag[] {
  const tags = new Set<string>();
  if (p.writes) tags.add("writing-into-tools");
  if (p.money) tags.add("money");
  if (p.contacts) {
    tags.add("contacting-people");
    tags.add("people-and-roles");
  }
  if (p.connected || p.writes) {
    tags.add("security");
    tags.add("data-handling");
  }
  for (const a of p.areas) tags.add(a);
  return [...tags].sort() as GovernanceTag[];
}

export const CHARTER_HEADING = "## The client's charter, in their own words";
export const CHARTER_PREFACE =
  "The client wrote and confirmed this about their business. Follow it: it may add rules or tighten ours. Where it seems to loosen a guardrail above, the guardrail wins.";
export const POLICIES_HEADING = "## Policies for this step";
/** Before the client's own policies: like the charter, they may only add rules (invariant 9). */
export const CLIENT_POLICIES_PREFACE =
  "The client wrote the policies marked (the client's). Follow them: they may add rules or tighten ours. Where one seems to loosen a guardrail or a Mezonas policy, ours wins.";

export interface ComposedGovernance {
  /** The text that starts the system prompt. */
  text: string;
  /** What it holds, in order. */
  read: GovernanceRead[];
}

export function composeGovernance(
  profile: StepGovernanceProfile,
  client: ClientGovernance | null,
): ComposedGovernance {
  const read: GovernanceRead[] = [
    {
      tier: "guardrails",
      source: "mezonas",
      id: MEZONAS_GUARDRAILS.id,
      version: MEZONAS_GUARDRAILS.version,
    },
  ];
  const parts = [MEZONAS_GUARDRAILS.text];
  if (profile.lean) return { text: parts.join("\n\n"), read };

  const charter = client?.charter ?? null;
  if (charter) {
    parts.push(`${CHARTER_HEADING}\n${CHARTER_PREFACE}\n\n${charter.body}`);
    read.push({
      tier: "charter",
      source: "client",
      id: charter.entryId,
      version: String(charter.version),
    });
  }

  const tags = new Set<string>(stepTags(profile));
  const ours = STANDARD_POLICIES.filter((p) => p.tags.some((t) => tags.has(t)));
  const theirs = [...(client?.policies ?? [])]
    .filter((p) => p.tags.some((t) => tags.has(t)))
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  if (ours.length + theirs.length > 0) {
    const sections = [
      ...ours.map((p) => `### ${p.title} (Mezonas)\n${p.text}`),
      ...theirs.map((p) => `### ${p.title} (the client's)\n${p.body}`),
    ];
    // DECISION: the preface only when the client has a policy here, so a step without one sends
    // the same prefix as before.
    const preface = theirs.length > 0 ? `${CLIENT_POLICIES_PREFACE}\n\n` : "";
    parts.push(`${POLICIES_HEADING}\n${preface}${sections.join("\n\n")}`);
    for (const p of ours) {
      read.push({ tier: "policy", source: "mezonas", id: p.id, version: p.version });
    }
    for (const p of theirs) {
      read.push({ tier: "policy", source: "client", id: p.entryId, version: String(p.version) });
    }
  }
  return { text: parts.join("\n\n"), read };
}
