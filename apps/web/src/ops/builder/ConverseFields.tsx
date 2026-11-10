// P-4: the inspector's fields for a `comms.converse` step (ARCHITECTURE §10.12; plan §1.66): who
// (a role the agent declares, or a contact from the trigger or an earlier step), the channel, the
// goal and what to find out (the result's fields, which later steps read), whether to confirm it,
// what the first message says, a WhatsApp template for someone who hasn't written in a day, the
// records it is about, and the limits. The goal and the first message are written here, never
// from a template: they become instructions. Consent, hours and who may be reached on which
// channel are the person's and the agent's People settings, not here.
// R7/R8: the v4 `conversation` step (ARCHITECTURE §10.14 "Conversations as a step") is edited by
// `ConversationFields` below, with the same field rows; stored `comms.converse` steps keep this
// form, as they keep running as skill steps.
import {
  type AgentBundle,
  CONVERSE_CAPS,
  CONVERSE_DEFAULTS,
  isTemplate,
  type PathOption,
  processes,
} from "@countersign/core";
import { useState } from "react";
import { TextArea } from "../../ui/forms";
import { Button } from "../../ui/primitives";
import { DeadlineEditor, ListInput } from "./deadline";
import { type FieldErrors, Row, SmallInput, SmallSelect, TemplateInput } from "./fields";
import type { People } from "./people";

type Input = Record<string, unknown>;

function record(v: unknown): Input {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {};
}

const CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "sms", label: "Text message" },
  { value: "email", label: "Email" },
] as const;

/** The field types the editor offers, as JSON Schema. */
const FIELD_TYPES = [
  { value: "string", label: "Text", schema: { type: "string" } },
  { value: "number", label: "Number", schema: { type: "number" } },
  { value: "boolean", label: "Yes or no", schema: { type: "boolean" } },
  { value: "list", label: "List of text", schema: { type: "array", items: { type: "string" } } },
  {
    value: "items",
    label: "List of items and quantities",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, qty: { type: "number" } },
        required: ["name", "qty"],
      },
    },
  },
] as const;

function fieldType(schema: unknown): string {
  const s = record(schema);
  if (s.type === "array") {
    const items = record(s.items);
    return items.type === "object" ? "items" : "list";
  }
  return typeof s.type === "string" ? s.type : "string";
}

interface ResultField {
  name: string;
  type: string;
  required: boolean;
}

function fieldsOf(result: unknown): ResultField[] {
  const r = record(result);
  const props = record(r.properties);
  const required = Array.isArray(r.required) ? (r.required as string[]) : [];
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: fieldType(schema),
    required: required.includes(name),
  }));
}

function resultOf(fields: readonly ResultField[]): Input {
  const properties: Input = {};
  for (const f of fields) {
    properties[f.name] = FIELD_TYPES.find((t) => t.value === f.type)?.schema ?? { type: "string" };
  }
  const required = fields.filter((f) => f.required && f.name).map((f) => f.name);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/**
 * How the skill-input forms change a step of either schema (a v3 step or a v4 process step): the
 * change keeps whatever the step is and replaces its `input`.
 */
export type SetInput = (key: string, fn: <T extends object>(s: T) => T) => void;

/** A skill step's input with a patch over it. */
export function patchInput(set: SetInput, key: string, patch: Record<string, unknown>) {
  set(key, (s) => ({ ...s, input: { ...record((s as { input?: unknown }).input), ...patch } }));
}

/**
 * Rows of named, typed fields (what a conversation must find out): a name, a type from the given
 * options, needed or not, and remove; shared by the v3 `comms.converse` step and the v4
 * conversation step.
 */
export function FieldRows({
  fields,
  types,
  onChange,
  max,
  testPrefix,
}: {
  fields: readonly ResultField[];
  types: readonly { value: string; label: string }[];
  onChange(next: ResultField[]): void;
  max: number;
  testPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`${testPrefix}s`}>
      {fields.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows have no id of their own, and keying by name would lose focus while it is typed.
        <div key={i} className="flex items-center gap-2">
          <SmallInput
            aria-label="Field name"
            data-testid={`${testPrefix}-${i}`}
            value={f.name}
            onChange={(e) =>
              onChange(
                fields.map((x, k) =>
                  k === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x,
                ),
              )
            }
          />
          <SmallSelect
            aria-label="Field type"
            data-testid={`${testPrefix}-${i}-type`}
            value={f.type}
            onChange={(e) =>
              onChange(fields.map((x, k) => (k === i ? { ...x, type: e.target.value } : x)))
            }
          >
            {types.some((t) => t.value === f.type) ? null : (
              <option value={f.type}>{f.type}</option>
            )}
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </SmallSelect>
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={f.required}
              data-testid={`${testPrefix}-${i}-needed`}
              onChange={(e) =>
                onChange(fields.map((x, k) => (k === i ? { ...x, required: e.target.checked } : x)))
              }
            />
            Needed
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(fields.filter((_, k) => k !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      {fields.length < max ? (
        <Button
          size="sm"
          className="self-start"
          data-testid={`${testPrefix}-add`}
          onClick={() =>
            onChange([
              ...fields,
              {
                name: `field${fields.length + 1}`,
                type: types[0]?.value ?? "text",
                required: true,
              },
            ])
          }
        >
          Add a field
        </Button>
      ) : null}
    </div>
  );
}

export function ConverseFields({
  step,
  bundle,
  paths,
  fieldErrors,
  set,
}: {
  step: { input: Record<string, unknown> };
  bundle: Pick<AgentBundle, "people">;
  paths: readonly PathOption[];
  fieldErrors: FieldErrors;
  set: SetInput;
}) {
  const input = record(step.input);
  const to = record(input.to);
  const who = "role" in to ? "role" : "contact";
  const roles = bundle.people ?? [];
  const channel = typeof input.channel === "string" ? input.channel : "whatsapp";
  const goal = typeof input.goal === "string" ? input.goal : "";
  const opening = typeof input.opening === "string" ? input.opening : "";
  const fields = fieldsOf(input.result);
  const limits = record(input.limits);
  const template = record(input.whatsappTemplate);
  const about = Array.isArray(input.about) ? (input.about as unknown[]).map(String) : [];
  const update = (key: string, patch: Input) => patchInput(set, key, patch);
  const setFields = (next: ResultField[]) => update("result", { result: resultOf(next) });
  const setLimit = (k: string, v: unknown) =>
    update(`limits.${k}`, {
      limits: { ...limits, [k]: v === "" || v === undefined ? undefined : v },
    });

  return (
    <div className="flex flex-col gap-3" data-testid="builder-converse">
      <div className="grid grid-cols-2 gap-3">
        <Row label="Talk with" field="input.to" errors={fieldErrors}>
          <SmallSelect
            data-testid="builder-converse-who"
            value={who}
            onChange={(e) =>
              update("to", {
                to: e.target.value === "role" ? { role: roles[0]?.role ?? "" } : { contactId: "" },
              })
            }
          >
            <option value="contact">A person from the directory</option>
            <option value="role">Whoever fills a role</option>
          </SmallSelect>
        </Row>
        <Row label="On" field="input.channel" errors={fieldErrors}>
          <SmallSelect
            data-field="input.channel"
            data-testid="builder-converse-channel"
            value={channel}
            onChange={(e) => update("channel", { channel: e.target.value })}
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SmallSelect>
        </Row>
      </div>
      {who === "role" ? (
        <Row
          label="Role"
          field="input.to"
          errors={fieldErrors}
          hint="Who fills the role is set on the agent's People page."
        >
          <SmallSelect
            data-testid="builder-converse-role"
            value={typeof to.role === "string" ? to.role : ""}
            onChange={(e) => update("to", { to: { role: e.target.value } })}
          >
            <option value="">Choose a role</option>
            {roles.map((r) => (
              <option key={r.role} value={r.role}>
                {r.role}
              </option>
            ))}
          </SmallSelect>
        </Row>
      ) : (
        <Row
          label="Person"
          field="input.to.contactId"
          errors={fieldErrors}
          hint="Usually who sent the request, from the trigger."
        >
          <TemplateInput
            field="input.to.contactId"
            testId="builder-converse-contact"
            value={typeof to.contactId === "string" ? to.contactId : ""}
            paths={paths}
            onChange={(v) => update("to", { to: { contactId: v } })}
          />
        </Row>
      )}
      <Row
        label="Goal"
        field="input.goal"
        errors={fieldErrors}
        hint="Written here, not from a template: it tells the agent what to settle."
      >
        <TextArea
          rows={2}
          data-field="input.goal"
          data-testid="builder-converse-goal"
          value={goal}
          invalid={isTemplate(goal)}
          onChange={(e) => update("goal", { goal: e.target.value })}
        />
      </Row>
      <Row
        label="What to find out"
        field="input.result"
        errors={fieldErrors}
        hint="Later steps read these fields."
      >
        <FieldRows
          fields={fields}
          types={FIELD_TYPES}
          max={CONVERSE_CAPS.resultFields}
          testPrefix="builder-converse-field"
          onChange={setFields}
        />
      </Row>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={input.confirm !== false}
          onChange={(e) => update("confirm", { confirm: e.target.checked })}
          data-testid="builder-converse-confirm"
        />
        Ask them to confirm the answer before it counts
      </label>
      <Row
        label="First message"
        field="input.opening"
        errors={fieldErrors}
        hint="What it should say; the agent writes it in their language."
      >
        <TextArea
          rows={2}
          data-field="input.opening"
          data-testid="builder-converse-opening"
          value={opening}
          invalid={isTemplate(opening)}
          onChange={(e) => update("opening", { opening: e.target.value })}
        />
      </Row>
      {channel === "whatsapp" ? (
        <Row
          label="WhatsApp template"
          field="input.whatsappTemplate"
          errors={fieldErrors}
          hint="Approved by WhatsApp. Used when they haven't written in 24 hours; without one the conversation can't start then."
        >
          <SmallInput
            data-testid="builder-converse-template"
            placeholder="HX…"
            value={typeof template.id === "string" ? template.id : ""}
            onChange={(e) =>
              update("whatsappTemplate", {
                whatsappTemplate: e.target.value
                  ? { id: e.target.value, variables: record(template.variables) }
                  : undefined,
              })
            }
          />
        </Row>
      ) : null}
      <Row
        label="About"
        field="input.about"
        errors={fieldErrors}
        hint="The record it concerns: its sources."
      >
        <TemplateInput
          field="input.about"
          testId="builder-converse-about"
          value={about.join(", ")}
          paths={paths}
          onChange={(v) =>
            update("about", {
              about: v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            })
          }
        />
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Row label="Messages, at most" field="input.limits.maxMessages" errors={fieldErrors}>
          <SmallInput
            type="number"
            min={1}
            max={CONVERSE_CAPS.maxMessages}
            data-testid="builder-converse-max-messages"
            value={String(limits.maxMessages ?? CONVERSE_DEFAULTS.maxMessages)}
            onChange={(e) => setLimit("maxMessages", Number(e.target.value) || undefined)}
          />
        </Row>
        <Row label="Wait for each reply" field="input.limits.waitPerReply" errors={fieldErrors}>
          <SmallInput
            data-testid="builder-converse-wait"
            value={String(limits.waitPerReply ?? CONVERSE_DEFAULTS.waitPerReply)}
            onChange={(e) => setLimit("waitPerReply", e.target.value)}
          />
        </Row>
        <Row label="Finish within" field="input.limits.deadline" errors={fieldErrors}>
          <SmallInput
            data-testid="builder-converse-deadline"
            value={String(limits.deadline ?? CONVERSE_DEFAULTS.deadline)}
            onChange={(e) => setLimit("deadline", e.target.value)}
          />
        </Row>
        <Row label="Spend at most ($)" field="input.limits.maxCostUsd" errors={fieldErrors}>
          <SmallInput
            data-testid="builder-converse-cost"
            value={String(limits.maxCostUsd ?? CONVERSE_DEFAULTS.maxCostUsd)}
            onChange={(e) => setLimit("maxCostUsd", e.target.value)}
          />
        </Row>
      </div>
      <p className="text-sm text-ink-muted">
        At any limit, or if the agent can't get there, a person takes over with the conversation so
        far.
      </p>
    </div>
  );
}

// ── R7/R8: the v4 conversation step ─────────────────────────────────────────────────────────────

type ConversationStep = processes.ConversationStep;

const CONVERSATION_CHANNELS: { value: ConversationStep["channel"]; label: string }[] = [
  ...CHANNELS,
  { value: "call", label: "A phone call" },
];

/** `find`'s types in the builder's words (core's FIND_TYPES). */
const FIND_TYPE_LABEL: Record<string, string> = {
  text: "Text",
  number: "Number",
  integer: "Whole number",
  money: "Money",
  date: "Date",
  datetime: "Date and time",
  yes_no: "Yes or no",
  email: "Email address",
  phone: "Phone number",
};
const FIND_TYPES = Object.keys(processes.FIND_TYPES).map((value) => ({
  value,
  label: FIND_TYPE_LABEL[value] ?? value,
}));
const LIST_TYPES = FIND_TYPES.map((t) => ({
  value: `${t.value}[]`,
  label: `List of ${t.label.toLowerCase()}`,
}));

/** `find` as rows: `note: "text?"` is an optional text field named note. */
function findRows(find: Record<string, string>): ResultField[] {
  return Object.entries(find).map(([name, spec]) => {
    const optional = spec.trim().endsWith("?");
    return { name, type: optional ? spec.trim().slice(0, -1) : spec.trim(), required: !optional };
  });
}

function findOf(rows: readonly ResultField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.name) out[r.name] = r.required ? r.type : `${r.type}?`;
  return out;
}

/**
 * A conversation step's own fields: who it is with, the channel (a call too), the goal (fixed
 * text: it becomes instructions), what it may share, what it must find out (later steps read it),
 * how many messages, the deadline, and how its messages are approved: the first (the plan) waits
 * for a yes by default; later ones wait too, or go under the first yes while they stay on the
 * goal. Either loosening is offered only where a write may be loosened (`looseningBlocked`).
 */
export function ConversationFields({
  step,
  bundle,
  paths,
  fieldErrors,
  people,
  messagesBlocked,
  set,
}: {
  step: ConversationStep;
  bundle: Pick<AgentBundle, "people">;
  paths: readonly PathOption[];
  fieldErrors: FieldErrors;
  people: People;
  /** Why its messages can't go without a person's yes here; null when they may. */
  messagesBlocked: string | null;
  set(key: string, fn: (s: ConversationStep) => ConversationStep): void;
}) {
  const problems = processes.conversationProblems(step);
  const errors: FieldErrors = {
    at: (field) => [
      ...fieldErrors.at(field),
      ...problems.filter((p) => p.field === field).map((p) => p.message),
    ],
  };
  const update = (key: string, patch: Partial<ConversationStep>) =>
    set(key, (s) => ({ ...s, ...patch }));
  const roles = bundle.people ?? [];
  // The rows are kept while they are typed (a field being renamed has no name for a moment, and
  // `find` is keyed by name); `find` follows every change, and an outside change (undo) shows.
  const committed = JSON.stringify(step.find);
  const [rows, setRows] = useState(() => findRows(step.find));
  const [last, setLast] = useState(committed);
  if (committed !== last) {
    setLast(committed);
    if (JSON.stringify(findOf(rows)) !== committed) setRows(findRows(step.find));
  }
  const setFind = (next: ResultField[]) => {
    setRows(next);
    const find = findOf(next);
    setLast(JSON.stringify(find));
    update("find", { find });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="builder-conversation">
      <div className="grid grid-cols-2 gap-3">
        <Row
          label="Talk with"
          field="with"
          errors={errors}
          hint="A contact, usually from the trigger, or one of the agent's people."
        >
          <TemplateInput
            field="with"
            testId="builder-conversation-with"
            value={step.with}
            paths={paths}
            invalid={errors.at("with").length > 0}
            onChange={(v) => update("with", { with: v })}
          />
        </Row>
        <Row label="On" field="channel" errors={errors}>
          <SmallSelect
            data-field="channel"
            data-testid="builder-conversation-channel"
            value={step.channel}
            onChange={(e) =>
              update("channel", { channel: e.target.value as ConversationStep["channel"] })
            }
          >
            {CONVERSATION_CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SmallSelect>
        </Row>
      </div>
      {roles.length ? (
        <SmallSelect
          aria-label="Or one of the agent's people"
          data-testid="builder-conversation-role"
          value=""
          onChange={(e) => {
            if (e.target.value) update("with", { with: e.target.value });
          }}
        >
          <option value="">Or one of the agent's people…</option>
          {roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.role}
            </option>
          ))}
        </SmallSelect>
      ) : null}
      <Row
        label="Goal"
        field="goal"
        errors={errors}
        hint="Written here, not from a template: it tells the agent what to settle."
      >
        <TextArea
          rows={2}
          data-field="goal"
          data-testid="builder-conversation-goal"
          value={step.goal}
          invalid={errors.at("goal").length > 0}
          onChange={(e) => update("goal", { goal: e.target.value })}
        />
      </Row>
      <Row
        label="What to find out"
        field="find"
        errors={errors}
        hint="Later steps read these fields."
      >
        <FieldRows
          fields={rows}
          types={[...FIND_TYPES, ...LIST_TYPES]}
          max={CONVERSE_CAPS.resultFields}
          testPrefix="builder-conversation-find"
          onChange={setFind}
        />
      </Row>
      {rows.map((r) =>
        errors.at(`find.${r.name}`).map((m) => (
          <span key={`${r.name}:${m}`} className="text-xs text-risk">
            {m}
          </span>
        )),
      )}
      <Row
        label="It may share"
        field="mayShare"
        errors={errors}
        hint='What the agent may tell them, e.g. "the order number, the delivery date".'
      >
        <ListInput
          field="mayShare"
          testId="builder-conversation-share"
          value={step.mayShare}
          onChange={(mayShare) => update("mayShare", { mayShare: mayShare.slice(0, 20) })}
        />
      </Row>
      <Row
        label={step.channel === "call" ? "Turns in the call, at most" : "Messages, at most"}
        field="maxTurns"
        errors={errors}
      >
        <SmallInput
          type="number"
          min={1}
          max={20}
          data-field="maxTurns"
          data-testid="builder-conversation-turns"
          value={String(step.maxTurns)}
          onChange={(e) => update("maxTurns", { maxTurns: Number(e.target.value) || 1 })}
        />
      </Row>
      <section className="flex flex-col gap-2" data-testid="builder-conversation-messages">
        <span className="text-sm font-medium text-ink">Who signs its messages</span>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-slate"
            data-field="messages.first"
            data-testid="builder-conversation-first"
            checked={step.messages.first === "required"}
            disabled={step.messages.first === "required" && messagesBlocked !== null}
            onChange={(e) =>
              update("messages.first", {
                messages: {
                  ...step.messages,
                  first: e.target.checked ? "required" : "not_required",
                },
              })
            }
          />
          The first message (the plan) waits for a person's yes
        </label>
        <Row label="Later messages" field="messages.later" errors={errors}>
          <SmallSelect
            data-field="messages.later"
            data-testid="builder-conversation-later"
            value={step.messages.later}
            onChange={(e) =>
              update("messages.later", {
                messages: {
                  ...step.messages,
                  later: e.target.value as ConversationStep["messages"]["later"],
                },
              })
            }
          >
            <option value="required">Each waits for a person's yes</option>
            <option
              value="within_goal"
              disabled={messagesBlocked !== null && step.messages.later !== "within_goal"}
            >
              Go under the first yes while they stay on the goal
            </option>
          </SmallSelect>
        </Row>
        {messagesBlocked ? (
          <p className="text-xs text-ink-muted" data-testid="builder-conversation-messages-reason">
            Messages without a person's yes aren't available: {messagesBlocked}
          </p>
        ) : null}
      </section>
      <DeadlineEditor
        value={step.deadline}
        prefix="deadline"
        testId="builder-conversation-deadline"
        errors={errors}
        people={people}
        proceedBlocked={null}
        afterLabel="Finish within"
        onChange={(deadline, key) => update(key, { deadline })}
      />
      <p className="text-sm text-ink-muted">
        At any limit, or if the agent can't get there, a person takes over with the conversation so
        far.
      </p>
    </div>
  );
}
