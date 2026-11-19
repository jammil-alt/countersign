// B6 (docs/builder-plan.md §8; §10 question 3, owner 2026-11-19): we draft the client's charter
// from what onboarding learned, and the client admin confirms it in the portal. The facts are the
// client's own: its file's current `theirs` facts (docs/plan.md §1.149; never an `ours` fact, which
// stays the operator's, invariant 11) and its `about` entries. They go to the model as data
// (invariant 9). The draft is saved as the charter's next version, not confirmed, so agents keep
// reading the last confirmed one (or none) until the client admin confirms it.
//
// DECISION: no feature of its own in core's compliance list: the only vendor is the model's
// (Anthropic, Mezonas' key), and the call goes through `clientModels`, which refuses it for a client
// in HIPAA mode until that vendor is covered, as the Builder's and Reggie's calls are.

import {
  CHARTER_DRAFT_SYSTEM,
  CHARTER_DRAFT_TOOL,
  CHARTER_TITLE,
  CharterDraft,
  type CharterFacts,
  charterBody,
  charterDraftPrompt,
} from "@countersign/core";
import { type Tx, tenant } from "@countersign/db";
import {
  charterEntry,
  createKnowledgeEntry,
  editKnowledgeEntry,
  type KnowledgeEntryView,
  listKnowledgeEntries,
  nextMeta,
} from "@countersign/documents";
import { DEFAULT_MODELS, type LlmClient } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { HttpError } from "../http";
import { fileOfClient, theirFactsOf } from "../onboarding/files";

/** The most facts a draft reads: the charter is short, and so is what it rests on. */
const FACTS_MAX = 80;

/** What the draft is made from: the client's name, its own current facts and its `about` entries. */
export async function charterFacts(tx: Tx, tenantId: string): Promise<CharterFacts> {
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const file = await fileOfClient(tx, tenantId);
  const facts = file ? await theirFactsOf(tx, file.id) : [];
  const about = await listKnowledgeEntries(tx, tenantId, { kind: "about" });
  return {
    clientName: client?.name ?? "the client",
    facts: facts.slice(-FACTS_MAX).map((f) => ({ section: f.section, text: f.text })),
    about: about.slice(0, FACTS_MAX).map((a) => ({ title: a.title, body: a.body })),
  };
}

/** Asks the model for a charter. Outside any transaction: the call is slow. */
export async function draftCharter(llm: LlmClient, facts: CharterFacts) {
  if (facts.facts.length === 0 && facts.about.length === 0) {
    throw new HttpError(
      409,
      "no_facts",
      "There is nothing from onboarding to draft from yet: no facts the client shared and nothing about the business.",
    );
  }
  const out = await llm.callTool({
    model: DEFAULT_MODELS.reasoning,
    system: CHARTER_DRAFT_SYSTEM,
    messages: [{ role: "user", content: charterDraftPrompt(facts) }],
    tool: {
      name: CHARTER_DRAFT_TOOL,
      description:
        "The client's charter: who the business is, how it speaks, what matters, what it never does.",
      schema: CharterDraft,
    },
    // DECISION: room for the model's thinking before four short parts; a cut-off answer is an
    // error (callTool), never a half charter saved.
    maxTokens: 3000,
    label: "charter_draft",
  });
  return { body: charterBody(out.value), record: out.record };
}

/**
 * Saves a drafted charter as the client's charter entry: a new one, or the next version of the one
 * it has, not confirmed (the confirmation is the client admin's).
 */
export async function saveCharterDraft(
  tx: Tx,
  tenantId: string,
  body: string,
  author: { id: string; role: "operator" },
): Promise<KnowledgeEntryView> {
  const current = await charterEntry(tx, tenantId);
  if (!current) {
    return createKnowledgeEntry(tx, tenantId, {
      kind: "policy",
      title: CHARTER_TITLE,
      body,
      meta: { tier: "charter" },
      author,
    });
  }
  return editKnowledgeEntry(tx, tenantId, current.id, {
    title: current.title,
    body,
    meta: nextMeta(current.meta, {}),
    baseVersion: current.version,
    author,
  });
}
