// Template updates and promotion, the data side (ARCHITECTURE §9.3, docs/plan.md §1.2 "Updates
// and promotion"). Both are core's three-way merge over whole bundles:
// - update:    base = the client's base template version, ours = the client's live version,
//              theirs = the template's live version → a client draft (author_type 'merge');
// - promotion: base = the client's base template version, ours = the template's live version,
//              theirs = the client version with client-specific values stripped → a template
//              draft (author_type 'promote').
// Neither publishes: the operator reviews, test-runs and publishes as usual. No update is applied
// automatically (DECISION in plan §1.2).

import {
  type AnyAgentBundle,
  type AnyStep,
  canonicalJson,
  cloneJson,
  eachBundleStep,
  holdsProcess,
  isPlainObject,
  type MergeResult,
  mergeBundles,
  parseSkillRef,
  processes,
  type Resolution,
  readManual,
  type SkillDefinition,
  selectChanges,
  validateBundle,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { aliasedTable, and, eq, inArray } from "drizzle-orm";
import { AgentsError } from "../errors";
import {
  type AgentRow,
  type AgentVersionRow,
  createVersion,
  getAgent,
  getVersion,
  type RegistryContext,
  resolveVersion,
} from "./agents";
import { convertLookup, skillContext } from "./skills";

export interface UpdateInfo {
  linked: boolean;
  /** The client live version's base template version. */
  base: AgentVersionRow | null;
  /** The template's live version. */
  templateLive: AgentVersionRow | null;
  /** Template versions published since the base (by version number). */
  behind: number;
  available: boolean;
  releaseNote: string | null;
}

async function clientAgent(tx: Tx, agentId: string): Promise<AgentRow> {
  const row = await getAgent(tx, agentId);
  if (row.kind !== "client")
    throw new AgentsError("not_a_client_agent", `${row.slug} is a template`);
  return row;
}

async function templateLive(tx: Tx, row: AgentRow): Promise<AgentVersionRow | null> {
  if (!row.templateId) return null;
  const template = await getAgent(tx, row.templateId);
  return template.liveVersionId ? getVersion(tx, template.liveVersionId) : null;
}

/**
 * "Update available": a linked client agent whose live version's base template version is older
 * than the template's live version (operator sessions: templates are visible only there).
 */
export async function updateInfo(tx: Tx, input: { agentId: string }): Promise<UpdateInfo> {
  const row = await clientAgent(tx, input.agentId);
  const live = row.liveVersionId ? await getVersion(tx, row.liveVersionId) : null;
  const base = live?.basedOnTemplateVersionId
    ? await getVersion(tx, live.basedOnTemplateVersionId)
    : null;
  const tLive = await templateLive(tx, row);
  const behind = base && tLive ? Math.max(0, tLive.version - base.version) : 0;
  return {
    linked: row.linked,
    base,
    templateLive: tLive,
    behind,
    available: row.linked && behind > 0,
    releaseNote: tLive?.releaseNote ?? null,
  };
}

/**
 * `updateInfo`'s `behind` for many client agents in one query: for each linked agent whose
 * template has moved on since its live version's base, how many versions. Agents with no update
 * (up to date, detached, no live version or no base) are left out.
 */
// DECISION: the command center shows "N versions behind" for its whole agents table; asking
// updateInfo per agent was four queries each, loading whole bundles for two numbers (§1.84).
export async function versionsBehind(
  tx: Tx,
  agentIds: readonly string[],
): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();
  const live = aliasedTable(agentVersion, "live");
  const base = aliasedTable(agentVersion, "base");
  const template = aliasedTable(agent, "template");
  const templateLive = aliasedTable(agentVersion, "template_live");
  const rows = await tx
    .select({ id: agent.id, base: base.version, latest: templateLive.version })
    .from(agent)
    .innerJoin(live, eq(live.id, agent.liveVersionId))
    .innerJoin(base, eq(base.id, live.basedOnTemplateVersionId))
    .innerJoin(template, eq(template.id, agent.templateId))
    .innerJoin(templateLive, eq(templateLive.id, template.liveVersionId))
    .where(and(inArray(agent.id, [...agentIds]), eq(agent.kind, "client"), eq(agent.linked, true)));
  return new Map(
    rows.filter((r) => r.latest > r.base).map((r) => [r.id, r.latest - r.base] as const),
  );
}

export interface MergePreview {
  base: AgentVersionRow;
  ours: AgentVersionRow;
  theirs: AgentVersionRow;
  result: MergeResult<AnyAgentBundle>;
}

/**
 * R9 (docs/plan.md §1.86, §9): how a merge reads stored v3 workflows as v4 when the template's
 * versions hold processes and the client's (or its base) don't, with the registries as they are.
 */
export function lineageReadOptions(ctx: Pick<RegistryContext, "catalog" | "tools">): {
  lookup: processes.ConvertLookup;
} {
  return { lookup: convertLookup(ctx.catalog, ctx.tools) };
}

/** The merged result of applying the template's live version to a client agent, with conflicts. */
export async function previewUpdate(
  tx: Tx,
  input: {
    agentId: string;
    resolutions?: readonly Resolution[];
    /**
     * R9: the registries, for a template whose live version holds v4 processes while the client
     * agent's are v3 workflows (the merged draft is then all v4). Without it, such a merge throws.
     */
    ctx?: Pick<RegistryContext, "catalog" | "tools">;
  },
): Promise<MergePreview> {
  const row = await clientAgent(tx, input.agentId);
  if (!row.linked) throw new AgentsError("not_linked", `${row.slug} is detached from its template`);
  const info = await updateInfo(tx, { agentId: row.id });
  const ours = await resolveVersion(tx, { agentId: row.id });
  if (!info.base || !info.templateLive) {
    throw new AgentsError("no_update", `${row.slug} has no template version to update from`);
  }
  if (!info.available) throw new AgentsError("no_update", `${row.slug} is up to date`);
  const result = mergeBundles(
    info.base.bundle,
    ours.bundle,
    info.templateLive.bundle,
    input.resolutions ?? [],
    input.ctx ? lineageReadOptions(input.ctx) : {},
  );
  return { base: info.base, ours, theirs: info.templateLive, result };
}

async function requireMergeable(
  tx: Tx,
  tenantId: string | null,
  result: MergeResult<AnyAgentBundle>,
  ctx: RegistryContext,
): Promise<void> {
  if (!result.clean) {
    throw new AgentsError(
      "merge_conflicts",
      `${result.conflicts.length} conflicts are unresolved`,
      result.conflicts,
    );
  }
  const { skills } = await skillContext(tx, {
    tenantId,
    bundle: result.bundle,
    catalog: ctx.catalog,
  });
  // R9: a merge with a template's v4 version is all v4, validated as such (an all-v3 one exactly
  // as before).
  const validate = holdsProcess(result.bundle) ? processes.validateAnyBundle : validateBundle;
  const valid = validate(result.bundle, {
    skills,
    tools: ctx.tools.specs(),
    models: knownModelIds(),
    ...(ctx.events ? { events: ctx.events } : {}),
  });
  if (!valid.valid) {
    throw new AgentsError("invalid_bundle", "the merged bundle does not validate", valid.errors);
  }
}

/**
 * Saves the update as a client draft (author_type 'merge', based on the template's live version).
 * Every conflict must be resolved and the merged bundle must validate.
 */
export async function createUpdateDraft(
  tx: Tx,
  input: {
    agentId: string;
    resolutions?: readonly Resolution[];
    actorId?: string | null;
    changeNote?: string | null;
    ctx: RegistryContext;
  },
): Promise<{ version: AgentVersionRow; preview: MergePreview }> {
  const preview = await previewUpdate(tx, input);
  const row = await getAgent(tx, input.agentId);
  await requireMergeable(tx, row.tenantId, preview.result, input.ctx);
  const version = await createVersion(tx, {
    agentId: row.id,
    bundle: preview.result.bundle,
    parentVersionId: preview.ours.id,
    // A three-way merge onto the live version, as before STATE-7 (its own preview shows it).
    fromOlder: true,
    authorType: "merge",
    authorId: input.actorId ?? null,
    changeNote: input.changeNote ?? `Update from template v${preview.theirs.version}`,
    basedOnTemplateVersionId: preview.theirs.id,
    mergedFromVersionIds: [preview.theirs.id],
  });
  return { version, preview };
}

// ── Promotion ────────────────────────────────────────────────────────────────────────────────────

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Whether a value names one of the client's records: a uuid anywhere outside `{{…}}` references
 * (which may name step ids, generated as uuids, and are not client data).
 */
// DECISION: templates refer to records only through {{refs}}, so any literal uuid in a client
// version's step inputs or settings is treated as the client's record or connection id and is not
// promoted (ARCHITECTURE §9.3 "Client-specific values ... are left out").
export function holdsRecordId(value: unknown): boolean {
  if (typeof value === "string") return UUID_IN_TEXT.test(value.replace(/\{\{[^{}]*\}\}/g, ""));
  if (Array.isArray(value)) return value.some(holdsRecordId);
  if (isPlainObject(value)) return Object.values(value).some(holdsRecordId);
  return false;
}

// The lookbehind lets a match start only where a run of address characters starts, so a long run
// with no "@" is read once, not once per character (CodeQL: polynomial regular expression).
const EMAIL_IN_TEXT =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){0,10}\.[A-Za-z]{2,}/g;
// Review of 5.10: a phone number in E.164 (+15551230000), or written with its area code in
// brackets ((555) 123-4567) or after a leading 1 (+1 555 123 4567, 1-555-123-4567), anywhere;
// a plain 555-123-4567 only in free text, since an input's 400-100-2000 is a part or account
// number as often as a phone number.
const PHONE =
  /\+[1-9]\d{7,14}(?!\d)|(?<!\w)(?:\+?1[\s.-]?)?\(\d{3}\)\s?\d{3}[\s.-]\d{4}(?![\w-])|(?<![\w+])\+?1[\s.-]\d{3}[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;
const PHONE_IN_TEXT = new RegExp(
  `${PHONE.source}|(?<![\\w.-])\\d{3}[\\s.-]\\d{3}[\\s.-]\\d{4}(?![\\w-])`,
  "g",
);
const REF = /\{\{[^{}]*\}\}/g;

/**
 * Whether a value holds one of the client's literals outside `{{refs}}`: a record id (as
 * `holdsRecordId`), an email address or a phone number (E.164).
 */
export function holdsClientLiteral(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.replace(REF, "");
    return (
      UUID_IN_TEXT.test(text) ||
      new RegExp(EMAIL_IN_TEXT.source).test(text) ||
      new RegExp(PHONE.source).test(text)
    );
  }
  if (Array.isArray(value)) return value.some(holdsClientLiteral);
  if (isPlainObject(value)) return Object.values(value).some(holdsClientLiteral);
  return false;
}

type Bag = Record<string, unknown>;

/** Replaces client-specific keys of `bag` with the base's value for the key, or drops them. */
function scrub(bag: Bag | undefined, base: Bag | undefined, clientSpecific: Set<string>): void {
  if (!bag) return;
  for (const key of Object.keys(bag)) {
    if (!clientSpecific.has(key) && !holdsClientLiteral(bag[key])) continue;
    if (base && Object.hasOwn(base, key)) bag[key] = cloneJson(base[key]);
    else delete bag[key];
  }
}

// ── People, contacts and addresses (invariant 11) ───────────────────────────────────────────

/** The role a required person field falls back to: the client admin, as a non-member does. */
const DEFAULT_WHO = "client_admin";
/** An unset webhook: it names no client's hook, so it starts nothing until the operator picks one. */
export const UNSET_HOOK_ID = "00000000-0000-0000-0000-000000000000";
/**
 * Review of 5.10: a conversation's contact when the client's was written out: a People role the
 * agent declares none of, so the conversation is refused (nothing is sent) until the operator
 * binds a role or names someone.
 */
export const UNSET_CONTACT_ROLE = "contact-to-choose";
/** What an email address, phone number or record id in free text becomes. */
const REDACTED = "[removed]";
/** Free text a person or the operator wrote, where a record id is client data (not an id field). */
const FREE_TEXT_KEYS = new Set([
  "instructions",
  "addInstructions",
  "mission",
  "name",
  "title",
  "description",
  "message",
  "goal",
  "need",
  "describe",
  "label",
]);

type RulesLike = { match?: unknown; rules: { field?: unknown; op?: unknown; value?: unknown }[] };

/** A `Rules` value (`{ match, rules: [{ field, op, value }] }`). */
function isRules(v: unknown): v is RulesLike {
  return isPlainObject(v) && Array.isArray(v.rules) && v.rules.every(isPlainObject);
}

const rulesHoldLiteral = (r: RulesLike) => r.rules.some((x) => holdsClientLiteral(x.value));

/** A rule that never holds: its field in an empty list. */
const neverRule = (field: unknown) => ({ field, op: "in", value: [] });
/** A rule that always holds: its field equal to itself. */
const alwaysRule = (field: unknown) => ({ field, op: "=", value: field });

/**
 * A person named by user or contact id, email address or phone number (one client's), rather than
 * by a role (`client_admin`, `lead`, a People role such as `accountant`) or a reference.
 */
// DECISION: by the literal's shape, not "anything but a known role": a People role name is the
// template's, and a bare name resolves to no one (an unknown approver goes to the client admin).
function namesPerson(value: unknown): boolean {
  return typeof value === "string" && holdsClientLiteral(value);
}

/** Keys whose values are tool inputs, settings or skill customizations: scrubbed as bags. */
const BAG_KEYS = new Set(["input", "payload", "settings", "customize", "show", "reshape"]);
/** Keys under which a `when` gates a check: the approval, a confer, a notice (and its urgency). */
const CHECK_KEYS = new Set(["checks", "approvals", "notify"]);

/**
 * Resets the person and contact fields of one step, trigger or definition part (`node`) to the
 * template's (`base`, the same part of the base version, walked in step) or to an unset value
 * that still validates: an approver with no `who` (the default approver), the client admin for a
 * required person, no listed contacts (a message trigger then matches the roles it names), an
 * unset webhook. Nested steps (`steps`) are visited on their own, and bags are scrubbed apart.
 */
// DECISION: unset rather than dropped, so step and path ids, and every check, stay as they were
// (invariant 3), approval stays on (invariant 8), and the operator sets the people in the client.
// Review of 5.10 (invariant 8): rules that name the client's records never loosen anything.
// - A check's condition (`checks.*.when`, an approval override's, a notice's, a reviewer's) is
//   dropped, so the check applies on every run; a condition only ever narrows a check.
// - An if path's `when` takes the base's where the base has that path; else it is never
//   rewritten to stand (a path that never holds sends every run past a sign-off it holds): it is
//   reported (`PromotionProblem`), and promotion and copy refuse until the operator sets it.
// - A repeat's `until` takes the base's, else one that always holds: the body runs once.
// - A trigger's `filter` takes the base's, else each rule naming a record becomes one that never
//   holds (its field in an empty list). Rules are a flat `all` or `any` of positive comparisons
//   (no negation, no nesting), so a rule that never holds only ever makes the filter hold on
//   fewer deliveries: the trigger starts fewer runs, never more.
// DECISION: a path is refused rather than guessed (taken always, or never): either could skip
// what the operator built into one branch; only the operator can say which records it means.

/** A path whose rule names one client's records, with no template value to take its place. */
export interface PromotionProblem {
  stepId: string;
  pathId: string;
  /** Where in the step, as a validation error names it (`paths.0.when`). */
  field: string;
  message: string;
}

interface ScrubScope {
  inCheck: boolean;
  /** The step being scrubbed and what it holds that can't be carried. */
  step?: { id: string; name: string } | undefined;
  problems?: PromotionProblem[] | undefined;
  /** The index of the path being scrubbed in its step's `paths`. */
  pathIndex?: number | undefined;
}

/** The base's item of the same id in a list of identified items (paths, approvers by index). */
function baseItem(base: unknown, item: unknown, i: number): unknown {
  if (!Array.isArray(base)) return undefined;
  if (isPlainObject(item) && typeof item.id === "string") {
    return base.find((b) => isPlainObject(b) && b.id === item.id);
  }
  return base[i];
}

function scrubPeople(node: unknown, base: unknown, scope: ScrubScope = { inCheck: false }): void {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) scrubPeople(v, baseItem(base, v, i), scope);
    return;
  }
  if (!isPlainObject(node)) return;
  const b = isPlainObject(base) ? base : undefined;
  const from = (key: string) => (b && Object.hasOwn(b, key) ? cloneJson(b[key]) : undefined);
  const inCheck = scope.inCheck;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === "steps") continue;
    if (key === "show" && isPlainObject(value)) {
      // What a reviewer or the agent is shown: a template object, scrubbed as an input is.
      scrub(value, isPlainObject(b?.show) ? b.show : undefined, new Set());
      continue;
    }
    if (BAG_KEYS.has(key)) continue;
    if (key === "paths" && Array.isArray(value)) {
      for (const [i, p] of value.entries()) {
        scrubPeople(p, baseItem(b?.paths, p, i), { ...scope, pathIndex: i });
      }
      continue;
    }
    if (isRules(value) && rulesHoldLiteral(value)) {
      if (inCheck && key === "when") {
        delete node[key];
        continue;
      }
      const kept = from(key);
      if (isRules(kept) && !rulesHoldLiteral(kept)) {
        node[key] = kept;
        continue;
      }
      const isPath =
        key === "when" && typeof node.id === "string" && Array.isArray(node.steps) && scope.step;
      if (isPath && scope.step) {
        const field = `paths.${scope.pathIndex ?? 0}.when`;
        scope.problems?.push({
          stepId: scope.step.id,
          pathId: node.id as string,
          field,
          message: `the path "${String(node.name ?? node.id)}" of the step "${scope.step.name}" chooses by one client's records: set its rule in the template before promoting or copying it`,
        });
      }
      // A repeat's condition (`until.rules`): one that always holds (a field equal to itself; an
      // empty rule list doesn't validate), so the body runs once.
      node[key] =
        key === "rules"
          ? { match: "all", rules: [alwaysRule(value.rules[0]?.field)] }
          : {
              ...value,
              rules: value.rules.map((r) => (holdsClientLiteral(r.value) ? neverRule(r.field) : r)),
            };
      continue;
    }
    switch (key) {
      case "who":
      case "approver":
        if (namesPerson(value)) {
          const kept = from(key);
          if (typeof kept === "string") node[key] = kept;
          else delete node[key];
        }
        continue;
      case "assignee":
      case "person":
        if (namesPerson(value)) {
          const kept = from(key);
          node[key] = typeof kept === "string" ? kept : DEFAULT_WHO;
        }
        continue;
      case "to":
        if (typeof value === "string" && namesPerson(value)) {
          const kept = from(key);
          // A v3 notify step's optional address goes; an escalation's required person resets.
          if (typeof kept === "string") node[key] = kept;
          else if ("kind" in node) delete node[key];
          else node[key] = DEFAULT_WHO;
        } else if (Array.isArray(value) && value.some(namesPerson)) {
          const kept = from(key);
          const roles = value.filter((v) => !namesPerson(v));
          node[key] = Array.isArray(kept) ? kept : roles.length ? roles : [DEFAULT_WHO];
        } else scrubPeople(value, b?.[key], scope);
        continue;
      case "tell":
        if (Array.isArray(value) && value.some(namesPerson)) {
          const kept = from(key);
          const roles = value.filter((v) => !namesPerson(v));
          if (Array.isArray(kept)) node[key] = kept;
          else if (roles.length) node[key] = roles;
          else delete node[key];
        }
        continue;
      case "contactIds":
        if (Array.isArray(value) && value.length) {
          const kept = from(key);
          if (Array.isArray(kept)) node[key] = kept;
          else delete node[key];
          // Review of 5.10: a filter that lists nobody can't be saved (`people_empty`): the
          // client admin may start it, until the operator lists the client's people again.
          const lists = ["relationships", "tags", "contactIds", "clientRoles"];
          if (!lists.some((k) => Array.isArray(node[k]) && (node[k] as unknown[]).length > 0)) {
            node.clientRoles = [DEFAULT_WHO];
          }
        }
        continue;
      case "hookId":
        if (typeof value === "string") {
          const kept = from(key);
          node[key] = typeof kept === "string" ? kept : UNSET_HOOK_ID;
        }
        continue;
      case "with":
        // A conversation's contact written out rather than referenced (a confer's `with` is its
        // list of reviewers, walked as any other part).
        if (typeof value === "string" && holdsClientLiteral(value)) {
          const kept = from(key);
          node[key] =
            typeof kept === "string" && !holdsClientLiteral(kept) ? kept : UNSET_CONTACT_ROLE;
        } else scrubPeople(value, b?.[key], scope);
        continue;
      default:
        scrubPeople(value, b?.[key], { ...scope, inCheck: inCheck || CHECK_KEYS.has(key) });
    }
  }
}

/**
 * Every email address and phone number left in a string (outside `{{refs}}`), removed, and in
 * free text (`FREE_TEXT_KEYS`) every record id too: ids elsewhere may be step ids (invariant 3).
 */
function redactAddresses(node: unknown, freeText = false): unknown {
  if (typeof node === "string") {
    const uuids = new RegExp(UUID_IN_TEXT.source, "gi");
    return node
      .split(/(\{\{[^{}]*\}\})/)
      .map((part, i) => {
        if (i % 2 === 1) return part;
        const out = part
          .replace(EMAIL_IN_TEXT, REDACTED)
          .replace(freeText ? PHONE_IN_TEXT : PHONE, REDACTED);
        return freeText ? out.replace(uuids, REDACTED) : out;
      })
      .join("");
  }
  if (Array.isArray(node)) return node.map((v) => redactAddresses(v, freeText));
  if (isPlainObject(node)) {
    for (const key of Object.keys(node)) {
      node[key] = redactAddresses(node[key], freeText || FREE_TEXT_KEYS.has(key));
    }
  }
  return node;
}

/**
 * Review of 5.10: a skill step's rule rows (`customize.rules`) that name the client's records
 * (in their condition or what they set): the base's row of the same id where it has one, else
 * left out. Edits of the skill's own rows are dropped the same way.
 */
function scrubRuleRows(customize: Bag | undefined, base: Bag | undefined): void {
  const rows = isPlainObject(customize?.rules) ? (customize.rules as Bag) : undefined;
  if (!customize || !rows) return;
  const baseRows = isPlainObject(base?.rules) ? (base.rules as Bag) : {};
  for (const list of ["add", "edit"] as const) {
    const items = rows[list];
    if (!Array.isArray(items)) continue;
    const theirs = Array.isArray(baseRows[list]) ? (baseRows[list] as unknown[]) : [];
    const kept = items.flatMap((row) => {
      if (!holdsClientLiteral(row)) return [row];
      const id = isPlainObject(row) ? row.id : undefined;
      const same = theirs.find((t) => isPlainObject(t) && id !== undefined && t.id === id);
      return same !== undefined && !holdsClientLiteral(same) ? [cloneJson(same)] : [];
    });
    if (kept.length > 0) rows[list] = kept;
    else delete rows[list];
  }
  if (Object.keys(rows).length === 0) delete customize.rules;
}

function triggersOf(w: AnyAgentBundle["workflows"][number]["workflow"]): Bag[] {
  const t = w as { trigger?: unknown; triggers?: unknown };
  const list = Array.isArray(t.triggers) ? t.triggers : t.trigger ? [t.trigger] : [];
  return list.filter(isPlainObject);
}

function stepsById(bundle: AnyAgentBundle): Map<string, AnyStep> {
  const out = new Map<string, AnyStep>();
  eachBundleStep(bundle, (step) => out.set(step.id, step));
  return out;
}

/**
 * A client version as it may go into a template: settings marked `clientSpecific` and literal
 * record ids are replaced by the base template's value where it has one (so promotion doesn't
 * delete them from the template), else removed. Bindings never are in a bundle. Wave 3b: a v4
 * process's steps the same way (a skill step's `customize.settings` too); the client and base
 * versions may be v3 and v4 apiece, and their steps line up by id (the converter keeps them).
 * Invariant 11: people and contacts named by id or address (approvers, assignees, people told,
 * escalations, reviewers, a message trigger's contacts), webhook hooks and skill parameter values
 * are reset to the base's or left unset, and email addresses and phone numbers left in free text
 * are removed. Step and path ids never change (invariant 3).
 */
export function stripForPromotion<B extends AnyAgentBundle>(
  client: B,
  /** The base template version's bundle; null (no template) drops every such value. */
  base: AnyAgentBundle | null,
  skills: Record<string, Pick<SkillDefinition, "settings">>,
  /** Review of 5.10: what can't be carried (a path choosing by records), for the caller to refuse. */
  problems?: PromotionProblem[],
): B {
  // Same rule as core's stripClientSpecificSettings, but the base's value is kept where it has one.
  const out = cloneJson(client);
  const specificKeys = (ref: string) =>
    new Set(
      (skills[ref] ?? skills[parseSkillRef(ref).id])?.settings
        .filter((s) => s.clientSpecific)
        .map((s) => s.key) ?? [],
    );
  const baseSkills = new Map(
    (base?.definition.skills ?? []).map((s) => [parseSkillRef(s.skill).id, s]),
  );
  for (const s of out.definition.skills) {
    scrub(s.settings, baseSkills.get(parseSkillRef(s.skill).id)?.settings, specificKeys(s.skill));
  }
  const baseSteps = base ? stepsById(base) : new Map<string, AnyStep>();
  /** A step's settings wherever they live: v3's `settings`, v4's and `customize.settings`. */
  const settingsOf = (step: AnyStep | undefined): Bag | undefined => {
    if (step?.kind !== "skill") return undefined;
    const own = step.settings as Bag | undefined;
    const customized = (step as { customize?: { settings?: Bag } }).customize?.settings;
    return own || customized ? { ...customized, ...own } : undefined;
  };
  eachBundleStep(out, (step) => {
    const b = baseSteps.get(step.id);
    const bag = b as (AnyStep & Bag) | undefined;
    if (step.kind === "skill") {
      const keys = specificKeys(step.skill);
      scrub(step.settings as Bag | undefined, settingsOf(b), keys);
      const customize = (step as { customize?: { settings?: Bag } }).customize;
      scrub(customize?.settings, settingsOf(b), keys);
      scrubRuleRows(
        customize as Bag | undefined,
        (b as { customize?: Bag } | undefined)?.customize,
      );
    }
    const s = step as AnyStep & Bag;
    for (const field of ["input", "payload"] as const) {
      scrub(s[field] as Bag | undefined, bag?.[field] as Bag | undefined, new Set());
    }
    // Invariant 11: approvers, assignees, people told and contacts are the client's own.
    scrubPeople(step, b, {
      inCheck: false,
      step: { id: step.id, name: step.name },
      problems,
    });
  });
  // DECISION: a skill's parameter values are set per agent (core's skill model), so the client's
  // never travel: the base template's values are kept, or none (a parameter without a default
  // then asks the operator for one at publish).
  for (const s of out.definition.skills) {
    const kept = baseSkills.get(parseSkillRef(s.skill).id)?.parameters;
    if (kept) s.parameters = cloneJson(kept);
    else delete s.parameters;
  }
  eachBundleStep(out, (step) => {
    const customize = (step as { customize?: { parameters?: Bag } }).customize;
    if (!customize?.parameters) return;
    const kept = (baseSteps.get(step.id) as { customize?: { parameters?: Bag } } | undefined)
      ?.customize?.parameters;
    if (kept) customize.parameters = cloneJson(kept);
    else delete customize.parameters;
  });
  scrubPeople(out.definition.permissions, base?.definition.permissions);
  scrubManual(out.definition, base?.definition);
  for (const w of out.workflows) {
    const bw = base?.workflows.find((x) => x.slug === w.slug);
    const baseTriggers = bw ? triggersOf(bw.workflow) : [];
    for (const t of triggersOf(w.workflow)) {
      scrubPeople(
        t,
        baseTriggers.find((x) => x.id === t.id),
      );
    }
  }
  // What is left in free text (instructions, titles, messages): addresses removed.
  return redactAddresses(out) as B;
}

/**
 * B5 (docs/builder-plan.md §7): the manual's record of a setting changed on this copy (who changed
 * it, when, and the value chosen: a row with a `side`) is the client's own. Invariant 1: it never
 * travels in a promotion. Each such row is put back to the base template's row of the same id, or
 * left out when the base has none, so the merge changes nothing of the template's there. A manual
 * that no longer reads is the base's, or none.
 */
function scrubManual(def: { manual?: unknown }, base: { manual?: unknown } | undefined): void {
  if (def.manual === undefined) return;
  const baseManual = readManual(base?.manual);
  const manual = readManual(def.manual);
  if (!manual) {
    if (base?.manual !== undefined) def.manual = cloneJson(base.manual);
    else delete def.manual;
    return;
  }
  // Nothing changed on this copy: the manual stays as stored.
  if (!manual.decisions.some((d) => d.side !== undefined)) return;
  const baseRows = new Map((baseManual?.decisions ?? []).map((d) => [d.id, d]));
  def.manual = {
    ...manual,
    decisions: manual.decisions.flatMap((d) => {
      if (d.side === undefined) return [d];
      const b = baseRows.get(d.id);
      return b ? [cloneJson(b)] : [];
    }),
  };
}

/** The `when` of a path of a step, or undefined when the bundle has no such path. */
function pathWhen(bundle: AnyAgentBundle, p: Pick<PromotionProblem, "stepId" | "pathId">): unknown {
  let found: unknown;
  eachBundleStep(bundle, (step) => {
    if (step.id !== p.stepId) return;
    const paths = (step as { paths?: unknown }).paths;
    if (!Array.isArray(paths)) return;
    const path = paths.find((x) => isPlainObject(x) && x.id === p.pathId);
    if (isPlainObject(path)) found = path.when;
  });
  return found;
}

const deepEqualJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * Review of 5.10: refuses a promotion or a copy that would carry a path choosing by one client's
 * records, as a draft that doesn't validate (`invalid_bundle`), each naming its step and path.
 */
export function refuseProblems(problems: readonly PromotionProblem[]): void {
  if (problems.length === 0) return;
  throw new AgentsError(
    "invalid_bundle",
    problems.map((p) => p.message).join("; "),
    problems.map((p) => ({
      stepId: p.stepId,
      field: p.field,
      code: "client_specific_rule",
      message: p.message,
    })),
  );
}

export interface PromotionPreview extends MergePreview {
  /** The client version promoted (before stripping). */
  client: AgentVersionRow;
  /** The client version's bundle with client-specific values stripped (every change offered). */
  stripped: AnyAgentBundle;
  /** The "theirs" side merged: `stripped` with only the selected changes (all when none given). */
  selected: AnyAgentBundle;
  /** Review of 5.10: paths that choose by the client's records; a draft holding one is refused. */
  problems: PromotionProblem[];
}

/**
 * The template draft a promotion would make: base = the client's base template version, ours =
 * the template's live version, theirs = the client version (live by default), stripped. Needs an
 * operator session that serves the client.
 */
export async function previewPromotion(
  tx: Tx,
  input: {
    agentId: string;
    versionId?: string | null;
    /** Ids from core's `selectableBetween(base, stripped)`; omitted: every change. */
    changes?: readonly string[] | null;
    resolutions?: readonly Resolution[];
    ctx: RegistryContext;
  },
): Promise<PromotionPreview> {
  const row = await clientAgent(tx, input.agentId);
  const client = await resolveVersion(tx, { agentId: row.id, versionId: input.versionId ?? null });
  if (!row.templateId || !client.basedOnTemplateVersionId) {
    throw new AgentsError("not_linked", `${row.slug} has no template to promote into`);
  }
  const base = await getVersion(tx, client.basedOnTemplateVersionId);
  const ours = await templateLive(tx, row);
  if (!ours) throw new AgentsError("no_live_version", "the template has no live version");
  const { skills } = await skillContext(tx, {
    tenantId: row.tenantId,
    bundle: client.bundle,
    catalog: input.ctx.catalog,
  });
  const problems: PromotionProblem[] = [];
  const stripped = stripForPromotion(client.bundle, base.bundle, skills, problems);
  // R9: a client version and a template version may be v3 and v4 apiece.
  const read = lineageReadOptions(input.ctx);
  const selected = input.changes
    ? selectChanges(base.bundle, stripped, input.changes, read)
    : stripped;
  const result = mergeBundles(base.bundle, ours.bundle, selected, input.resolutions ?? [], read);
  // The "theirs" side is the stripped client bundle; report it against the client version row.
  return { base, ours, theirs: client, client, stripped, selected, result, problems };
}

/** Saves a promotion as a template draft (author_type 'promote'). */
export async function createPromotionDraft(
  tx: Tx,
  input: {
    agentId: string;
    versionId?: string | null;
    changes?: readonly string[] | null;
    resolutions?: readonly Resolution[];
    actorId?: string | null;
    changeNote?: string | null;
    releaseNote?: string | null;
    ctx: RegistryContext;
  },
): Promise<{ version: AgentVersionRow; preview: PromotionPreview }> {
  const preview = await previewPromotion(tx, input);
  refuseProblems(
    preview.problems.filter(
      (p) =>
        // Only a path the draft takes as the scrub left it (a change not selected leaves it out).
        pathWhen(preview.result.bundle, p) !== undefined &&
        deepEqualJson(pathWhen(preview.result.bundle, p), pathWhen(preview.stripped, p)),
    ),
  );
  await requireMergeable(tx, null, preview.result, input.ctx);
  const version = await createVersion(tx, {
    agentId: preview.ours.agentId,
    bundle: preview.result.bundle,
    parentVersionId: preview.ours.id,
    // A three-way merge onto the template's live version, as before STATE-7.
    fromOlder: true,
    authorType: "promote",
    authorId: input.actorId ?? null,
    changeNote: input.changeNote ?? `Promoted from a client's v${preview.client.version}`,
    releaseNote: input.releaseNote ?? null,
    mergedFromVersionIds: [preview.client.id],
  });
  return { version, preview };
}
