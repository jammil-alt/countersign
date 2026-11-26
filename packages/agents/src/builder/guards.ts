// The Builder's shared guard helpers (ARCHITECTURE §9.6, CLAUDE.md invariants 3 and 8). The step
// model's guards (`./step-model/guards`) use them: the agent's own rules (`guardDefinition`), the
// approval a new step starts with and the one an answer may not loosen (`DEFAULT_APPROVAL`,
// `holdApproval`), and the reference rewriting the guards and the conversation share.

import {
  type AgentBundle,
  canonicalJson,
  isPlainObject,
  NEW_AGENT_OVERSIGHT,
  OversightSettings,
  processes,
  STEP_PURPOSE_MAX,
} from "@countersign/core";

type ApprovalCheck = processes.ApprovalCheck;

/**
 * `text.replace(/\{\{([^}]*)\}\}/g, (_, inner) => fn(inner))` without the regular expression,
 * which is quadratic on a long run of `{{` with no `}}` (CodeQL js/polynomial-redos). Same
 * matches: from each `{{`, the inner text runs to the first `}`, which must start `}}`.
 */
export function replaceTemplates(text: string, fn: (inner: string) => string): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("{{");
  while (at !== -1) {
    const close = text.indexOf("}", at + 2);
    if (close === -1) break;
    if (text.charCodeAt(close + 1) === 125) {
      out += text.slice(from, at) + fn(text.slice(at + 2, close));
      from = close + 2;
      at = text.indexOf("{{", from);
    } else {
      // Every `{{` before this `}` meets the same lone `}`, so none of them can match.
      at = text.indexOf("{{", close + 1);
    }
  }
  return out + text.slice(from);
}

/** Rewrites `steps.<old>` inside every `{{…}}` of every string under `value`. */
export function rewriteRefs(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    // v0.17: `loop.previous.<id>` names a step inside a repeat, as `steps.<id>` does.
    const ref = /(^|[^A-Za-z0-9_.])(steps|loop\.previous)\.([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    return replaceTemplates(
      value,
      (inner) =>
        `{{${inner.replace(ref, (m, pre: string, root: string, id: string) => {
          const to = map.get(id);
          return to ? `${pre}${root}.${to}` : m;
        })}}}`,
    );
  }
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, map));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteRefs(v, map)]));
  }
  return value;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** A new step's approval: on, the default approver, stopping when nobody answers (invariant 8). */
// DECISION: as the workflow builder's `createStep`: a Builder step that writes to a client's tool
// or reaches people starts with an explicit approval check, so the draft says what it does.
export const DEFAULT_APPROVAL: ApprovalCheck = {
  required: "required",
  mode: "in_turn",
  ifNoAnswer: "stop",
  onReject: "stop",
};

/**
 * The answer's approval with every loosening the operator's (`prior`) didn't have taken out: a
 * switched-off approval, a `when`, going ahead when nobody answers (the approval's own or an
 * approver's deadline). What the operator had, on that same step, stays.
 */
export function holdApproval(
  answer: ApprovalCheck,
  prior: ApprovalCheck | undefined,
): ApprovalCheck {
  const tight = processes.tightenedApproval(answer);
  const out: ApprovalCheck = { ...answer };
  if (answer.required === "not_required" && prior?.required !== "not_required") {
    out.required = "required";
  }
  if (answer.when !== undefined && !same(answer.when, prior?.when)) delete out.when;
  if (!same(answer.ifNoAnswer, prior?.ifNoAnswer)) out.ifNoAnswer = tight.ifNoAnswer;
  if (answer.approvers) {
    out.approvers = answer.approvers.map((a, i) =>
      same(a, prior?.approvers?.[i]) ? a : (tight.approvers?.[i] ?? a),
    );
  }
  return out;
}

/** The bundle-level rules a revision's or a draft's source decides (`guardDefinition`). */
type DefinitionSource = { definition: AgentBundle["definition"] } | null | undefined;

/**
 * The agent's own rules, whatever the model answered (shared by the step-model guards):
 * functional kind; the mode of the operator's version (`suggest_only` for a new agent); budgets and
 * memory as the operator set them; oversight as the operator set it, or on failures for a new
 * agent. Returns a copy.
 */
export function guardDefinition<D extends AgentBundle["definition"]>(
  input: D,
  sources: { operatorSource: DefinitionSource; source: DefinitionSource },
  note: (text: string) => void,
): D {
  const { operatorSource, source } = sources;
  const def = structuredClone(input);
  if (def.kind !== "functional") {
    def.kind = "functional";
    note("The Builder makes functional agents; platform agents are seeded.");
  }
  const mode = operatorSource ? operatorSource.definition.permissions.mode : "suggest_only";
  if (def.permissions.mode !== mode) {
    note(
      mode === "suggest_only"
        ? "It suggests only: every change it wants to make waits for a person. Only you can change that."
        : "Its mode stays as it was: the Builder doesn't change what an agent may do.",
    );
    def.permissions = { ...def.permissions, mode };
  }
  const budgetSource = operatorSource ?? source;
  if (budgetSource) {
    // What an agent may spend and remember is the operator's to set.
    def.budgets = budgetSource.definition.budgets;
    def.memory = budgetSource.definition.memory;
  }
  // v0.13 W2-I / v0.12 W3-A: oversight is the operator's on an existing agent; a new agent from
  // the Builder reviews its failed steps at least (ARCHITECTURE §10.11).
  if (operatorSource) {
    if (operatorSource.definition.oversight === undefined) delete def.oversight;
    else def.oversight = operatorSource.definition.oversight;
  } else if (def.oversight === undefined || def.oversight.review === "off") {
    if (def.oversight?.review === "off") {
      note("It reviews its failed steps: new agents start with oversight on failures.");
    }
    def.oversight = OversightSettings.parse(NEW_AGENT_OVERSIGHT);
  }
  // Step model §10f: what an agent may read, create and change in our own records (its grants and
  // data sets) is the operator's, as its mode is: a draft keeps the operator's version's exactly,
  // and a new agent from the Builder is granted nothing (invariant 9).
  const data = operatorSource?.definition.data;
  if (JSON.stringify(def.data ?? null) !== JSON.stringify(data ?? null)) {
    note("Its data sets stay as you set them: the Builder doesn't change what an agent may reach.");
  }
  if (data === undefined) delete def.data;
  else def.data = structuredClone(data);
  return def;
}

/**
 * A step's purpose as its SOP shows it (staging, 2026-11-25): plain words, at most
 * `STEP_PURPOSE_MAX`. The model's answer is checked with short ids; a `{{steps.s6…}}` written in a
 * purpose then grows by an id's length per mention as the ids are put back, and the bundle failed
 * to parse after the model had answered. A reference means nothing in prose, so it is taken out;
 * a purpose still too long is cut at its last sentence or word that fits. Null when nothing is left.
 */
// DECISION: cut, not sent back to repair: the purpose is one line of the SOP, the operator edits
// it in the step panel, and a repair round would cost the turn a second model call.
export function plainPurpose(text: string): string | null {
  const plain = replaceTemplates(text, () => "")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!plain) return null;
  if (plain.length <= STEP_PURPOSE_MAX) return plain;
  const room = plain.slice(0, STEP_PURPOSE_MAX);
  const sentence = room.lastIndexOf(". ");
  if (sentence >= STEP_PURPOSE_MAX / 2) return room.slice(0, sentence + 1);
  const word = room.slice(0, STEP_PURPOSE_MAX - 1).lastIndexOf(" ");
  return `${room.slice(0, word > 0 ? word : STEP_PURPOSE_MAX - 1).replace(/[\s,;:]+$/, "")}…`;
}

/** Every step's purpose made plain (`plainPurpose`), anywhere in a workflow's steps. */
export function plainPurposes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainPurposes);
  if (!isPlainObject(value)) return value;
  const isStep = typeof value.id === "string" && typeof value.kind === "string";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isStep && k === "purpose" && typeof v === "string") {
      const purpose = plainPurpose(v);
      if (purpose) out[k] = purpose;
    } else if (k !== "input") {
      out[k] = plainPurposes(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
