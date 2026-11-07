// "Who approves" (docs/plan.md §1.20): a client's approver rules, in order, the first that fits
// wins. One editor for both surfaces, like the matrix: the operator adds, edits, reorders and
// removes rules and tries a sample change; the client admin can only make them stricter (a
// stricter approver on a rule, or a new rule naming the admin or one person), checked here with
// core's clientTighteningProblems as the server checks it; a client user only reads them.
// What the portal shows comes from its message files (docs/plan.md §1.18); the operator's own words
// (back office only: the fallback chain, the history's sides, reordering, Try it) stay English.
import {
  type ApproverConnectorOption,
  type ApproverMatch,
  type ApproverPerson,
  type ApproverRule,
  type ApproverRuleChange,
  type ApproverRuleInput,
  type ApproverTarget,
  approverStrictness,
  CurrencyCode,
  clientTighteningProblems,
  DecimalString,
  deepEqual,
  routeApproval,
  type TighteningProblem,
  uuidv7,
  type WriteVerb,
} from "@countersign/core";
import { useMemo, useState } from "react";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, Card, ErrorNotice, Tag } from "../ui/primitives";

export type RulesEditor = "operator" | "client_admin" | "viewer";

/** A rule as the editor holds it: always with an id (new ones get a uuid v7 here). */
export type DraftRule = ApproverRuleInput & { id: string };

export interface RulesView {
  revision: number;
  rules: ApproverRule[];
  people: ApproverPerson[];
  connectors: ApproverConnectorOption[];
  agents: { id: string; name: string; approver?: string | null }[];
  changes: ApproverRuleChange[];
  /** The client's default approver (back office only). */
  clientDefault?: string | null;
}

const VERB_LABEL: Record<WriteVerb, PlainKey> = {
  create: "approvers.verb.create",
  update: "approvers.verb.update",
  delete: "approvers.verb.delete",
};

/** Why the client admin can't save a draft, by core's problem code. */
const PROBLEM: Record<TighteningProblem["code"], PlainKey> = {
  removed: "approvers.problem.removed",
  reordered: "approvers.problem.reordered",
  match_changed: "approvers.problem.match_changed",
  looser: "approvers.problem.looser",
  to_operator: "approvers.problem.to_operator",
  new_rule_too_loose: "approvers.problem.new_rule_too_loose",
};

// ── Labels ───────────────────────────────────────────────────────────────────────────────────────

function personName(people: readonly ApproverPerson[], id: string, { t }: Pick<I18n, "t">): string {
  const p = people.find((x) => x.id === id);
  return p ? (p.name ?? p.email) : t("approvers.who.left");
}

export function approverLabel(
  target: ApproverTarget,
  people: readonly ApproverPerson[],
  editor: RulesEditor,
  { t }: Pick<I18n, "t"> = EN,
): string {
  const portal = editor !== "operator";
  switch (target.kind) {
    case "client_admin":
      return portal ? t("approvers.who.admin") : "Client admin";
    case "role":
      if (target.role === "client_admin") return portal ? t("approvers.who.admin") : "Client admin";
      return portal ? t("approvers.who.team") : "Anyone in the client";
    case "user":
      return personName(people, target.userId, { t });
    case "operator":
      return portal ? t("approvers.who.us") : "Operator, for the client";
  }
}

/** The most a tool's short label runs to before it is cut at a word. */
const TOOL_LABEL_MAX = 60;

/**
 * A write tool's short name for a choice list: its description up to the first colon, full stop or
 * bracket ("Itemize a QuickBooks bill: replace lines …" → "Itemize a QuickBooks bill"). The whole
 * description shows under the field once the tool is chosen.
 */
export function toolShortLabel(description: string): string {
  const cut = description.search(/[:.;(]/);
  const head = (cut > 0 ? description.slice(0, cut) : description).trim();
  if (head.length <= TOOL_LABEL_MAX) return head;
  const words = head.slice(0, TOOL_LABEL_MAX).replace(/\s+\S*$/, "");
  return `${words}…`;
}

export function matchLabel(
  match: ApproverMatch,
  view: Pick<RulesView, "connectors" | "agents">,
  { t }: Pick<I18n, "t"> = EN,
) {
  const parts: string[] = [];
  if (match.connector) {
    parts.push(view.connectors.find((c) => c.id === match.connector)?.name ?? match.connector);
  }
  if (match.tool) {
    // A tool's description is the connector's own (English) words.
    const tool = view.connectors.flatMap((c) => c.tools).find((x) => x.id === match.tool);
    parts.push(tool ? toolShortLabel(tool.description) : match.tool);
  }
  if (match.verb) parts.push(t(VERB_LABEL[match.verb]));
  if (match.amountOver) {
    // The amount as the rule holds it (a decimal string), never through a float.
    parts.push(
      t("approvers.over", {
        amount: match.amountOver.value,
        currency: match.amountOver.currency,
      }),
    );
  }
  if (match.agentId) {
    parts.push(view.agents.find((a) => a.id === match.agentId)?.name ?? t("approvers.serviceLeft"));
  }
  return parts.length === 0 ? t("approvers.anyChange") : parts.join(" · ");
}

// ── The editor ───────────────────────────────────────────────────────────────────────────────────

export function ApproverRules({
  view,
  editor,
  onSave,
}: {
  view: RulesView;
  editor: RulesEditor;
  /** Saves the whole ordered list; rejects with the API's error. */
  onSave?: (body: { revision: number; rules: DraftRule[]; reason: string }) => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState<DraftRule[]>(view.rules);
  const [form, setForm] = useState<{ index: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = editor !== "viewer" && onSave !== undefined;
  const dirty = !deepEqual(draft, view.rules);
  const problems = useMemo(
    () => (editor === "client_admin" ? clientTighteningProblems(view.rules, draft) : []),
    [editor, view.rules, draft],
  );
  const portal = editor !== "operator";

  function move(i: number, by: -1 | 1) {
    setDraft((d) => {
      const next = [...d];
      const [rule] = next.splice(i, 1);
      if (rule) next.splice(i + by, 0, rule);
      return next;
    });
  }

  async function save() {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    try {
      // No reason is asked (UI cleanup, decision 8): the change log names the change itself.
      await onSave({ revision: view.revision, rules: draft, reason: "" });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId="approver-rules" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="eyebrow text-ink-muted">{t("approvers.title")}</h3>
        <p className="text-sm text-ink-muted">
          {portal
            ? t("approvers.intro")
            : "The first rule that fits a change decides. If none fits, the step's or agent's approver, then the client's default, then the client admin."}
        </p>
      </div>
      {draft.length === 0 ? (
        <p className="px-4 py-4 text-ink-muted" data-testid="approver-rules-empty">
          {portal ? t("approvers.empty") : "No rules yet."}
        </p>
      ) : (
        <ol className="divide-y divide-line" data-testid="approver-rules-list">
          {draft.map((rule, i) => (
            <RuleRow
              key={rule.id}
              index={i}
              rule={rule}
              saved={view.rules.find((r) => r.id === rule.id) ?? null}
              view={view}
              editor={editable ? editor : "viewer"}
              last={i === draft.length - 1}
              problem={problemText(
                problems.find((p) => p.ruleId === rule.id),
                i18n,
              )}
              onMove={(by) => move(i, by)}
              onEdit={() => setForm({ index: i })}
              onRemove={() => setDraft((d) => d.filter((_, k) => k !== i))}
              onApprover={(approver) =>
                setDraft((d) => d.map((r, k) => (k === i ? { ...r, approver } : r)))
              }
            />
          ))}
        </ol>
      )}

      {editable && form ? (
        <RuleForm
          key={form.index ?? "new"}
          view={view}
          editor={editor}
          initial={form.index === null ? null : (draft[form.index] ?? null)}
          onCancel={() => setForm(null)}
          onDone={(rule, atTop) => {
            setDraft((d) => {
              if (form.index !== null) return d.map((r, k) => (k === form.index ? rule : r));
              return atTop ? [rule, ...d] : [...d, rule];
            });
            setForm(null);
          }}
        />
      ) : null}

      {editable && !form ? (
        <div className="border-t border-line px-4 py-3">
          <Button
            size="sm"
            data-testid="approver-rules-add"
            onClick={() => setForm({ index: null })}
          >
            {t("approvers.add")}
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="px-4 pt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      {editable && dirty ? (
        <div className="flex flex-wrap items-end justify-end gap-3 border-t border-line px-4 py-3">
          <div className="flex gap-2">
            <Button
              variant="ghost"
              data-testid="approver-rules-discard"
              disabled={busy}
              onClick={() => {
                setDraft(view.rules);
                setForm(null);
              }}
            >
              {t("matrix.discard")}
            </Button>
            <Button
              variant="primary"
              data-testid="approver-rules-save"
              disabled={busy || problems.length > 0}
              onClick={() => void save()}
            >
              {t("approvers.save")}
            </Button>
          </div>
          <p className="w-full text-sm text-ink-muted">
            {editor === "client_admin"
              ? t("approvers.tightenNote")
              : "New approvals follow the rules at once. Every change is logged."}
          </p>
        </div>
      ) : null}

      {editor === "operator" ? <TryIt view={view} rules={draft} /> : null}

      {view.changes.length > 0 ? (
        <ul
          className="flex flex-col gap-1 border-t border-line px-4 py-3 text-sm text-ink-muted"
          data-testid="approver-rules-history"
        >
          {view.changes.map((c) => (
            <li key={c.id}>
              {changeLine(c, editor, i18n)}{" "}
              {c.reason ? <span className="text-ink">{c.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** A tightening problem in the reader's words (core's message is the English fallback). */
function problemText(p: TighteningProblem | undefined, { t }: Pick<I18n, "t">): string | null {
  if (!p) return null;
  const key = PROBLEM[p.code];
  return key ? t(key) : p.message;
}

/** "We changed them on Nov 3, 2026:", "Ana changed them on …:": who changed the rules, and when. */
function changeLine(c: ApproverRuleChange, editor: RulesEditor, { t, fmt }: I18n): string {
  const date = fmt.date(c.createdAt);
  if (editor === "operator") {
    return `${c.side === "client" ? "The client" : "We"} changed them (${c.by ?? "someone"}) on ${date}:`;
  }
  return c.side === "operator"
    ? t("approvers.changedByUs", { date })
    : t("approvers.changedBy", { name: c.by ?? t("approvers.yourTeam"), date });
}

function RuleRow({
  index,
  rule,
  saved,
  view,
  editor,
  last,
  problem,
  onMove,
  onEdit,
  onRemove,
  onApprover,
}: {
  index: number;
  rule: DraftRule;
  saved: DraftRule | null;
  view: RulesView;
  editor: RulesEditor;
  last: boolean;
  problem: string | null;
  onMove: (by: -1 | 1) => void;
  onEdit: () => void;
  onRemove: () => void;
  onApprover: (approver: ApproverTarget) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const portal = editor !== "operator";
  const byClient = rule.setBy === "client" || (!rule.setBy && editor === "client_admin");
  const addedBy = byClient
    ? portal
      ? t("approvers.addedByYou")
      : "Added by the client"
    : t("approvers.setByUs");
  const isNew = saved === null;
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      data-testid={`approver-rule-${index}`}
    >
      <span className="figures w-6 text-ink-muted">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="text-ink" data-testid="approver-rule-match">
          {matchLabel(rule.match, view, i18n)}
        </p>
        <p className="text-sm text-ink-muted">
          {addedBy}
          {rule.note ? ` · ${rule.note}` : ""}
          {isNew ? ` · ${t("approvers.notSaved")}` : ""}
        </p>
        {problem ? (
          <p className="ds-error text-sm" data-testid="approver-rule-problem">
            {problem}
          </p>
        ) : null}
      </div>
      {editor === "client_admin" ? (
        <ClientApproverSelect
          index={index}
          value={rule.approver}
          floor={saved?.approver ?? null}
          people={view.people}
          onChange={onApprover}
        />
      ) : (
        <Tag tone="person" testId="approver-rule-approver">
          {approverLabel(rule.approver, view.people, editor, i18n)}
        </Tag>
      )}
      {editor === "operator" ? (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Move rule ${index + 1} up`}
            data-testid="approver-rule-up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Move rule ${index + 1} down`}
            data-testid="approver-rule-down"
            disabled={last}
            onClick={() => onMove(1)}
          >
            Down
          </Button>
          <Button size="sm" variant="ghost" data-testid="approver-rule-edit" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" data-testid="approver-rule-remove" onClick={onRemove}>
            Remove
          </Button>
        </div>
      ) : null}
      {editor === "client_admin" && isNew ? (
        <Button size="sm" variant="ghost" data-testid="approver-rule-remove" onClick={onRemove}>
          {t("approvers.remove")}
        </Button>
      ) : null}
    </li>
  );
}

/** Encodes an approver as one select value: `client_admin`, `role:client_user`, `user:<id>`, `operator`. */
function approverValue(t: ApproverTarget): string {
  switch (t.kind) {
    case "role":
      return `role:${t.role}`;
    case "user":
      return `user:${t.userId}`;
    default:
      return t.kind;
  }
}

function parseApprover(value: string): ApproverTarget {
  if (value.startsWith("user:")) return { kind: "user", userId: value.slice(5) };
  if (value === "role:client_user") return { kind: "role", role: "client_user" };
  if (value === "operator") return { kind: "operator" };
  return { kind: "client_admin" };
}

function approverOptions(
  people: readonly ApproverPerson[],
  editor: RulesEditor,
  floor: ApproverTarget | null,
  i18n: Pick<I18n, "t">,
) {
  const all: { value: string; label: string; target: ApproverTarget }[] = [
    { kind: "client_admin" } as const,
    { kind: "role", role: "client_user" } as const,
    ...people.map((p) => ({ kind: "user", userId: p.id }) as const),
    { kind: "operator" } as const,
  ].map((target) => ({
    value: approverValue(target),
    label: approverLabel(target, people, editor, i18n),
    target,
  }));
  if (editor !== "client_admin") return all;
  // The client admin: the same as saved, or stricter, never the operator.
  const min = floor ? approverStrictness(floor) : 2;
  return all.filter(
    (o) =>
      (floor && deepEqual(o.target, floor)) ||
      (o.target.kind !== "operator" && approverStrictness(o.target) >= min),
  );
}

function ClientApproverSelect({
  index,
  value,
  floor,
  people,
  onChange,
}: {
  index: number;
  value: ApproverTarget;
  floor: ApproverTarget | null;
  people: readonly ApproverPerson[];
  onChange: (t: ApproverTarget) => void;
}) {
  const i18n = useI18n();
  const options = approverOptions(people, "client_admin", floor, i18n);
  return (
    <Select
      aria-label={i18n.t("approvers.whoForRule", { n: index + 1 })}
      data-testid="approver-rule-approver-select"
      className="h-8 w-56 text-sm"
      value={approverValue(value)}
      onChange={(e) => onChange(parseApprover(e.target.value))}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

// ── Adding and editing a rule ────────────────────────────────────────────────────────────────────

interface MatchFields {
  connector: string;
  tool: string;
  verb: string;
  amount: string;
  currency: string;
  agentId: string;
}

function toFields(m: ApproverMatch | undefined): MatchFields {
  return {
    connector: m?.connector ?? "",
    tool: m?.tool ?? "",
    verb: m?.verb ?? "",
    amount: m?.amountOver?.value ?? "",
    currency: m?.amountOver?.currency ?? "USD",
    agentId: m?.agentId ?? "",
  };
}

/** The match the fields describe, or a problem to show. */
function toMatch(
  f: MatchFields,
  { t }: Pick<I18n, "t">,
): { match: ApproverMatch } | { problem: string } {
  const match: ApproverMatch = {};
  if (f.connector) match.connector = f.connector;
  if (f.tool) match.tool = f.tool;
  if (f.verb) match.verb = f.verb as WriteVerb;
  if (f.agentId) match.agentId = f.agentId;
  if (f.amount.trim()) {
    const value = f.amount.trim();
    const currency = f.currency.trim().toUpperCase();
    if (!DecimalString.safeParse(value).success) {
      return { problem: t("approvers.amountProblem") };
    }
    if (!CurrencyCode.safeParse(currency).success) {
      return { problem: t("approvers.currencyProblem") };
    }
    match.amountOver = { value, currency };
  }
  return { match };
}

function MatchInputs({
  view,
  fields,
  onChange,
  prefix,
}: {
  view: Pick<RulesView, "connectors" | "agents">;
  fields: MatchFields;
  onChange: (f: MatchFields) => void;
  prefix: string;
}) {
  const { t } = useI18n();
  const tools = view.connectors
    .filter((c) => !fields.connector || c.id === fields.connector)
    .flatMap((c) => c.tools);
  const set = (patch: Partial<MatchFields>) => onChange({ ...fields, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Field label={t("approvers.field.tool")}>
        <Select
          data-testid={`${prefix}-connector`}
          value={fields.connector}
          onChange={(e) => set({ connector: e.target.value, tool: "" })}
        >
          <option value="">{t("approvers.anyTool")}</option>
          {view.connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("approvers.field.change")}
        // Short names in the list; the chosen change's whole description under the field.
        hint={tools.find((x) => x.id === fields.tool)?.description}
        testId={`${prefix}-tool-field`}
      >
        <Select
          data-testid={`${prefix}-tool`}
          value={fields.tool}
          onChange={(e) => set({ tool: e.target.value })}
        >
          <option value="">{t("approvers.anyChange")}</option>
          {tools.map((x) => (
            <option key={x.id} value={x.id}>
              {toolShortLabel(x.description)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("approvers.field.kind")}>
        <Select
          data-testid={`${prefix}-verb`}
          value={fields.verb}
          onChange={(e) => set({ verb: e.target.value })}
        >
          <option value="">{t("approvers.verb.any")}</option>
          <option value="create">{t("approvers.verb.create")}</option>
          <option value="update">{t("approvers.verb.update")}</option>
          <option value="delete">{t("approvers.verb.delete")}</option>
        </Select>
      </Field>
      <Field label={t("approvers.field.amount")} hint={t("approvers.field.amountHelp")}>
        <TextInput
          data-testid={`${prefix}-amount`}
          inputMode="decimal"
          value={fields.amount}
          onChange={(e) => set({ amount: e.target.value })}
        />
      </Field>
      <Field label={t("approvers.field.currency")}>
        <TextInput
          data-testid={`${prefix}-currency`}
          maxLength={3}
          value={fields.currency}
          onChange={(e) => set({ currency: e.target.value })}
        />
      </Field>
      <Field label={t("approvers.field.service")}>
        <Select
          data-testid={`${prefix}-agent`}
          value={fields.agentId}
          onChange={(e) => set({ agentId: e.target.value })}
        >
          <option value="">{t("approvers.anyService")}</option>
          {view.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function RuleForm({
  view,
  editor,
  initial,
  onCancel,
  onDone,
}: {
  view: RulesView;
  editor: RulesEditor;
  initial: DraftRule | null;
  onCancel: () => void;
  onDone: (rule: DraftRule, atTop: boolean) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [fields, setFields] = useState<MatchFields>(toFields(initial?.match));
  const options = approverOptions(view.people, editor, null, i18n);
  const [approver, setApprover] = useState(
    initial ? approverValue(initial.approver) : (options[0]?.value ?? "client_admin"),
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [atTop, setAtTop] = useState(editor === "client_admin");
  const [problem, setProblem] = useState<string | null>(null);

  function done() {
    const out = toMatch(fields, i18n);
    if ("problem" in out) {
      setProblem(out.problem);
      return;
    }
    const trimmed = note.trim();
    const rule: DraftRule = {
      id: initial?.id ?? uuidv7(),
      match: out.match,
      approver: parseApprover(approver),
      ...(initial?.setBy ? { setBy: initial.setBy } : {}),
      ...(trimmed ? { note: trimmed } : {}),
    };
    onDone(rule, atTop);
  }

  return (
    <div
      className="border-t border-line bg-surface-subtle px-4 py-4"
      data-testid="approver-rule-form"
    >
      <MatchInputs view={view} fields={fields} onChange={setFields} prefix="approver-rule-form" />
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={t("approvers.title")}>
          <Select
            data-testid="approver-rule-form-approver"
            value={approver}
            onChange={(e) => setApprover(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("approvers.field.note")}>
          <TextInput
            data-testid="approver-rule-form-note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {initial === null ? (
          <Field label={t("approvers.field.where")}>
            <Select
              data-testid="approver-rule-form-where"
              value={atTop ? "top" : "end"}
              onChange={(e) => setAtTop(e.target.value === "top")}
            >
              <option value="top">{t("approvers.where.top")}</option>
              <option value="end">{t("approvers.where.end")}</option>
            </Select>
          </Field>
        ) : null}
      </div>
      {problem ? (
        <p className="ds-error mt-2 text-sm" data-testid="approver-rule-form-problem">
          {problem}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" data-testid="approver-rule-form-done" onClick={done}>
          {initial ? t("approvers.updateRule") : t("approvers.addRule")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

// ── Try it (back office) ─────────────────────────────────────────────────────────────────────────

const SOURCE_LABEL = {
  rule: "",
  step: "the step's approver",
  agent: "the agent's approver",
  client: "the client's default",
  default: "no rule fits, so the client admin",
} as const;

function TryIt({ view, rules }: { view: RulesView; rules: readonly DraftRule[] }) {
  const [fields, setFields] = useState<MatchFields>({ ...toFields(undefined), verb: "update" });
  // The back office: English, as everything here.
  const out = toMatch(fields, EN);
  let result: string;
  if ("problem" in out) {
    result = out.problem;
  } else {
    const tool = view.connectors
      .flatMap((c) => c.tools.map((t) => ({ ...t, connector: c.id })))
      .find((t) => t.id === fields.tool);
    const verb = (tool?.verb === "read" ? "update" : tool?.verb) ?? (fields.verb || "update");
    const agent = view.agents.find((a) => a.id === fields.agentId);
    const route = routeApproval({
      rules: rules.map((r) => ({ ...r, setBy: r.setBy ?? "operator" })),
      facts: {
        connector: tool?.connector ?? (fields.connector || ""),
        tool: tool?.id ?? "",
        verb: verb as WriteVerb,
        agentId: agent?.id ?? null,
        amount: out.match.amountOver ?? null,
      },
      agent: [agent?.approver ?? null],
      client: view.clientDefault ?? null,
      members: new Set(view.people.map((p) => p.id)),
    });
    const who = approverLabel(route.approver, view.people, "operator");
    const index = rules.findIndex((r) => r.id === route.ruleId);
    result =
      route.source === "rule"
        ? `${who}, by rule ${index + 1}.`
        : route.source === "default"
          ? `${who}: ${SOURCE_LABEL.default}.`
          : `${who}: no rule fits, so ${SOURCE_LABEL[route.source]}.`;
  }
  return (
    <div className="border-t border-line px-4 py-4" data-testid="approver-rules-try">
      <h4 className="eyebrow mb-3 text-ink-muted">Try it with a sample change</h4>
      <MatchInputs view={view} fields={fields} onChange={setFields} prefix="approver-try" />
      <p className="mt-3 text-ink" data-testid="approver-try-result">
        <Badge tone="person" className="mr-2">
          Would approve
        </Badge>
        {result}
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        Uses the rules above, saved or not. A step can name its own approver when no rule fits.
      </p>
    </div>
  );
}
