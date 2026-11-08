// P-4: the inspector's fields for a `comms.converse` step (ARCHITECTURE §10.12; plan §1.66): who
// (a role the agent declares, or a contact from the trigger or an earlier step), the channel, the
// goal and what to find out (the result's fields, which later steps read), whether to confirm it,
// what the first message says, a WhatsApp template for someone who hasn't written in a day, the
// records it is about, and the limits. The goal and the first message are written here, never
// from a template: they become instructions. Consent, hours and who may be reached on which
// channel are the person's and the agent's People settings, not here.
import {
  type AgentBundle,
  CONVERSE_CAPS,
  CONVERSE_DEFAULTS,
  isTemplate,
  type PathOption,
  type Step,
} from "@countersign/core";
import { TextArea } from "../../ui/forms";
import { Button } from "../../ui/primitives";
import { type FieldErrors, Row, SmallInput, SmallSelect, TemplateInput } from "./fields";

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

export function ConverseFields({
  step,
  bundle,
  paths,
  fieldErrors,
  set,
}: {
  step: Extract<Step, { kind: "skill" }>;
  bundle: AgentBundle;
  paths: readonly PathOption[];
  fieldErrors: FieldErrors;
  set(key: string, fn: (s: Step) => Step): void;
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
  const update = (key: string, patch: Input) =>
    set(key, (s) => ({ ...s, input: { ...record((s as typeof step).input), ...patch } }) as Step);
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
        <div className="flex flex-col gap-2" data-testid="builder-converse-fields">
          {fields.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows have no id of their own, and keying by name would lose focus while it is typed.
            <div key={i} className="flex items-center gap-2">
              <SmallInput
                aria-label="Field name"
                data-testid={`builder-converse-field-${i}`}
                value={f.name}
                onChange={(e) =>
                  setFields(
                    fields.map((x, k) =>
                      k === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x,
                    ),
                  )
                }
              />
              <SmallSelect
                aria-label="Field type"
                value={f.type}
                onChange={(e) =>
                  setFields(fields.map((x, k) => (k === i ? { ...x, type: e.target.value } : x)))
                }
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SmallSelect>
              <label className="flex items-center gap-1 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) =>
                    setFields(
                      fields.map((x, k) => (k === i ? { ...x, required: e.target.checked } : x)),
                    )
                  }
                />
                Needed
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFields(fields.filter((_, k) => k !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          {fields.length < CONVERSE_CAPS.resultFields ? (
            <Button
              size="sm"
              className="self-start"
              data-testid="builder-converse-add-field"
              onClick={() =>
                setFields([
                  ...fields,
                  { name: `field${fields.length + 1}`, type: "string", required: true },
                ])
              }
            >
              Add a field
            </Button>
          ) : null}
        </div>
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
