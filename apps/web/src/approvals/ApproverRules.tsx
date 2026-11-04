// "Who approves" (docs/plan.md §1.20): a client's approver rules, in order, the first that fits
// wins. One editor for both surfaces, like the matrix: the operator adds, edits, reorders and
// removes rules and tries a sample change; the client admin can only make them stricter (a
// stricter approver on a rule, or a new rule naming the admin or one person), checked here with
// core's clientTighteningProblems as the server checks it; a client user only reads them.
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
  uuidv7,
  type WriteVerb,
} from "@countersign/core";
import { useMemo, useState } from "react";
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

const VERB_LABEL: Record<WriteVerb, string> = {
  create: "Creates",
  update: "Updates",
  delete: "Deletes",
};

// ── Labels ───────────────────────────────────────────────────────────────────────────────────────

function personName(people: readonly ApproverPerson[], id: string): string {
  const p = people.find((x) => x.id === id);
  return p ? (p.name ?? p.email) : "Someone who left";
}

export function approverLabel(
  target: ApproverTarget,
  people: readonly ApproverPerson[],
  editor: RulesEditor,
): string {
  const portal = editor !== "operator";
  switch (target.kind) {
    case "client_admin":
      return portal ? "Your admin" : "Client admin";
    case "role":
      if (target.role === "client_admin") return portal ? "Your admin" : "Client admin";
      return portal ? "Anyone on your team" : "Anyone in the client";
    case "user":
      return personName(people, target.userId);
    case "operator":
      return portal ? "We approve for you" : "Operator, for the client";
  }
}

export function matchLabel(match: ApproverMatch, view: Pick<RulesView, "connectors" | "agents">) {
  const parts: string[] = [];
  if (match.connector) {
    parts.push(view.connectors.find((c) => c.id === match.connector)?.name ?? match.connector);
  }
  if (match.tool) {
    const tool = view.connectors.flatMap((c) => c.tools).find((t) => t.id === match.tool);
    parts.push(tool?.description ?? match.tool);
  }
  if (match.verb) parts.push(VERB_LABEL[match.verb]);
  if (match.amountOver) {
    parts.push(`Over ${match.amountOver.value} ${match.amountOver.currency}`);
  }
  if (match.agentId) {
    parts.push(view.agents.find((a) => a.id === match.agentId)?.name ?? "A service that left");
  }
  return parts.length === 0 ? "Any change" : parts.join(" · ");
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
  const [draft, setDraft] = useState<DraftRule[]>(view.rules);
  const [form, setForm] = useState<{ index: number | null } | null>(null);
  const [reason, setReason] = useState("");
  const [reasonProblem, setReasonProblem] = useState<string | null>(null);
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
    const text = reason.trim();
    if (!text) {
      setReasonProblem("Say why, so the change log makes sense later.");
      return;
    }
    setBusy(true);
    setError(null);
    setReasonProblem(null);
    try {
      await onSave({ revision: view.revision, rules: draft, reason: text });
      setReason("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const fallback = portal
    ? "your admin approves, unless the service names someone"
    : "the step's or agent's approver, then the client's default, then the client admin";

  return (
    <Card testId="approver-rules" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="eyebrow text-ink-muted">Who approves</h3>
        <p className="text-sm text-ink-muted">
          The first rule that fits a change decides. If none fits, {fallback}.
        </p>
      </div>
      {draft.length === 0 ? (
        <p className="px-4 py-4 text-ink-muted" data-testid="approver-rules-empty">
          {portal ? "No rules yet. Your admin approves every change." : "No rules yet."}
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
              problem={problems.find((p) => p.ruleId === rule.id)?.message ?? null}
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
            Add a rule
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="px-4 pt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      {editable && dirty ? (
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line px-4 py-3">
          <Field
            label="Why this change?"
            error={reasonProblem ?? undefined}
            className="min-w-64 flex-1"
            testId="approver-rules-reason"
          >
            <TextInput
              data-testid="approver-rules-reason"
              value={reason}
              maxLength={500}
              invalid={!!reasonProblem}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
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
              Discard
            </Button>
            <Button
              variant="primary"
              data-testid="approver-rules-save"
              disabled={busy || problems.length > 0}
              onClick={() => void save()}
            >
              Save rules
            </Button>
          </div>
          <p className="w-full text-sm text-ink-muted">
            {editor === "client_admin"
              ? "You can make approvals stricter yourself. Only we can loosen them again."
              : "New approvals follow the rules at once. Changes are logged with your reason."}
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
              {changeAuthor(c, editor)} on {new Date(c.createdAt).toLocaleDateString()}:{" "}
              <span className="text-ink">{c.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function changeAuthor(c: ApproverRuleChange, editor: RulesEditor): string {
  if (editor === "operator") {
    return `${c.side === "client" ? "The client" : "We"} changed them (${c.by ?? "someone"})`;
  }
  return c.side === "operator" ? "We changed them" : `${c.by ?? "Your team"} changed them`;
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
  const portal = editor !== "operator";
  const byClient = rule.setBy === "client" || (!rule.setBy && editor === "client_admin");
  const addedBy = byClient ? (portal ? "Added by you" : "Added by the client") : "Set by us";
  const isNew = saved === null;
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      data-testid={`approver-rule-${index}`}
    >
      <span className="figures w-6 text-ink-muted">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="text-ink" data-testid="approver-rule-match">
          {matchLabel(rule.match, view)}
        </p>
        <p className="text-sm text-ink-muted">
          {addedBy}
          {rule.note ? ` · ${rule.note}` : ""}
          {isNew ? " · not saved yet" : ""}
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
          {approverLabel(rule.approver, view.people, editor)}
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
          Remove
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
) {
  const all: { value: string; label: string; target: ApproverTarget }[] = [
    { kind: "client_admin" } as const,
    { kind: "role", role: "client_user" } as const,
    ...people.map((p) => ({ kind: "user", userId: p.id }) as const),
    { kind: "operator" } as const,
  ].map((target) => ({
    value: approverValue(target),
    label: approverLabel(target, people, editor),
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
  const options = approverOptions(people, "client_admin", floor);
  return (
    <Select
      aria-label={`Who approves rule ${index + 1}`}
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
function toMatch(f: MatchFields): { match: ApproverMatch } | { problem: string } {
  const match: ApproverMatch = {};
  if (f.connector) match.connector = f.connector;
  if (f.tool) match.tool = f.tool;
  if (f.verb) match.verb = f.verb as WriteVerb;
  if (f.agentId) match.agentId = f.agentId;
  if (f.amount.trim()) {
    const value = f.amount.trim();
    const currency = f.currency.trim().toUpperCase();
    if (!DecimalString.safeParse(value).success) {
      return { problem: "Write the amount as a number, like 500 or 1250.50." };
    }
    if (!CurrencyCode.safeParse(currency).success) {
      return { problem: "Use a three-letter currency code, like USD." };
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
  const tools = view.connectors
    .filter((c) => !fields.connector || c.id === fields.connector)
    .flatMap((c) => c.tools);
  const set = (patch: Partial<MatchFields>) => onChange({ ...fields, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Field label="Tool">
        <Select
          data-testid={`${prefix}-connector`}
          value={fields.connector}
          onChange={(e) => set({ connector: e.target.value, tool: "" })}
        >
          <option value="">Any tool</option>
          {view.connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Change">
        <Select
          data-testid={`${prefix}-tool`}
          value={fields.tool}
          onChange={(e) => set({ tool: e.target.value })}
        >
          <option value="">Any change</option>
          {tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.description}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Kind">
        <Select
          data-testid={`${prefix}-verb`}
          value={fields.verb}
          onChange={(e) => set({ verb: e.target.value })}
        >
          <option value="">Creates or updates</option>
          <option value="create">Creates</option>
          <option value="update">Updates</option>
          <option value="delete">Deletes</option>
        </Select>
      </Field>
      <Field label="Amount over" hint="Leave empty for any amount. Only the same currency counts.">
        <TextInput
          data-testid={`${prefix}-amount`}
          inputMode="decimal"
          value={fields.amount}
          onChange={(e) => set({ amount: e.target.value })}
        />
      </Field>
      <Field label="Currency">
        <TextInput
          data-testid={`${prefix}-currency`}
          maxLength={3}
          value={fields.currency}
          onChange={(e) => set({ currency: e.target.value })}
        />
      </Field>
      <Field label="Service">
        <Select
          data-testid={`${prefix}-agent`}
          value={fields.agentId}
          onChange={(e) => set({ agentId: e.target.value })}
        >
          <option value="">Any service</option>
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
  const [fields, setFields] = useState<MatchFields>(toFields(initial?.match));
  const options = approverOptions(view.people, editor, null);
  const [approver, setApprover] = useState(
    initial ? approverValue(initial.approver) : (options[0]?.value ?? "client_admin"),
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [atTop, setAtTop] = useState(editor === "client_admin");
  const [problem, setProblem] = useState<string | null>(null);

  function done() {
    const out = toMatch(fields);
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
        <Field label="Who approves">
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
        <Field label="Note (optional)">
          <TextInput
            data-testid="approver-rule-form-note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {initial === null ? (
          <Field label="Where">
            <Select
              data-testid="approver-rule-form-where"
              value={atTop ? "top" : "end"}
              onChange={(e) => setAtTop(e.target.value === "top")}
            >
              <option value="top">First, before the other rules</option>
              <option value="end">Last, after the other rules</option>
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
          {initial ? "Update rule" : "Add rule"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
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
  const out = toMatch(fields);
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
