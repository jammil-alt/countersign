// The inspector's fields for a `comms.reach-out` step (plan §1.25): who (a role the agent declares,
// or a contact), what it is about (record ids, may be templates), the purpose (fixed text written
// here: it becomes instructions, so it can't come from a template), the message (a fixed text per
// language, or written for each contact from the purpose and the record's data), urgency, whether
// a reply is expected and how long to wait. Who may be reached, on which channels and when is set
// on the agent's People page, not here.
import {
  type AgentBundle,
  CALL_LANGUAGES,
  isTemplate,
  type PathOption,
  REACH_PURPOSE_MAX,
  type Step,
  URGENCIES,
} from "@countersign/core";
import { TextArea } from "../../ui/forms";
import { type FieldErrors, Row, SmallInput, SmallSelect, TemplateInput } from "./fields";

const LANGUAGE_LABEL: Record<(typeof CALL_LANGUAGES)[number], string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  "pt-BR": "Portuguese (Brazil)",
  it: "Italian",
  de: "German",
};

const URGENCY_LABEL: Record<(typeof URGENCIES)[number], string> = {
  urgent: "Urgent: call, then text",
  normal: "Normal: their preferred order",
  fyi: "FYI: email only",
};

type Input = Record<string, unknown>;

function record(v: unknown): Input {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {};
}

export function ReachOutFields({
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
  const message = record(input.message);
  const template = record(message.template);
  const composed = message.compose === true;
  const roles = bundle.people ?? [];
  const purpose = typeof input.purpose === "string" ? input.purpose : "";
  const about = Array.isArray(input.about) ? (input.about as unknown[]).map(String) : [];
  const update = (key: string, patch: Input) =>
    set(key, (s) => ({ ...s, input: { ...record((s as typeof step).input), ...patch } }) as Step);

  return (
    <div className="flex flex-col gap-3" data-testid="builder-reach-out">
      <Row
        label="Reach"
        field="input.to"
        errors={fieldErrors}
        hint="Who fills the role is set on the agent's People page."
      >
        <SmallSelect
          data-field="input.to"
          data-testid="builder-reach-role"
          value={typeof to.role === "string" ? to.role : ""}
          onChange={(e) => update("to", { to: { role: e.target.value } })}
        >
          <option value="">Choose a role</option>
          {roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.role}
              {r.description ? ` · ${r.description}` : ""}
            </option>
          ))}
        </SmallSelect>
      </Row>
      {roles.length === 0 ? (
        <p className="text-sm text-ink-muted">
          This agent declares no roles yet. Add one to its people in the definition.
        </p>
      ) : null}
      <Row
        label="Purpose"
        field="input.purpose"
        errors={fieldErrors}
        hint="Written here, not from a template: it tells the agent why it is reaching out."
      >
        <SmallInput
          data-field="input.purpose"
          data-testid="builder-reach-purpose"
          value={purpose}
          maxLength={REACH_PURPOSE_MAX}
          invalid={isTemplate(purpose)}
          onChange={(e) => update("purpose", { purpose: e.target.value })}
        />
      </Row>
      <Row
        label="About"
        field="input.about"
        errors={fieldErrors}
        hint="The record it concerns: its sources."
      >
        <TemplateInput
          field="input.about"
          testId="builder-reach-about"
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
        <Row label="Urgency" field="input.urgency" errors={fieldErrors}>
          <SmallSelect
            data-testid="builder-reach-urgency"
            value={typeof input.urgency === "string" ? input.urgency : "normal"}
            onChange={(e) => update("urgency", { urgency: e.target.value })}
          >
            {URGENCIES.map((u) => (
              <option key={u} value={u}>
                {URGENCY_LABEL[u]}
              </option>
            ))}
          </SmallSelect>
        </Row>
        <Row label="Wait for a reply" field="input.timeout" errors={fieldErrors}>
          <SmallInput
            data-testid="builder-reach-timeout"
            value={typeof input.timeout === "string" ? input.timeout : "2 days"}
            disabled={input.expectReply === false}
            onChange={(e) => update("timeout", { timeout: e.target.value })}
          />
        </Row>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={input.expectReply !== false}
          onChange={(e) => update("expectReply", { expectReply: e.target.checked })}
          data-testid="builder-reach-expect-reply"
        />
        Expect a reply (the workflow waits, then forks on the outcome)
      </label>
      <Row label="Message" field="input.message" errors={fieldErrors}>
        <SmallSelect
          data-testid="builder-reach-message-kind"
          value={composed ? "compose" : "template"}
          onChange={(e) =>
            update("message", {
              message:
                e.target.value === "compose"
                  ? { compose: true }
                  : { template: { en: "", ...template } },
            })
          }
        >
          <option value="template">The same words, per language</option>
          <option value="compose">Written for each contact from the purpose and the record</option>
        </SmallSelect>
      </Row>
      {composed ? (
        <p className="text-sm text-ink-muted">
          Written in the contact's language. The record's data is used as data, never as
          instructions.
        </p>
      ) : (
        CALL_LANGUAGES.map((lang) => (
          <Row
            key={lang}
            label={LANGUAGE_LABEL[lang]}
            field={`input.message.template.${lang}`}
            errors={fieldErrors}
            hint={
              lang === "en" ? "Needed: used when there is no text in their language." : undefined
            }
          >
            <TextArea
              rows={2}
              data-testid={`builder-reach-message-${lang}`}
              value={typeof template[lang] === "string" ? (template[lang] as string) : ""}
              onChange={(e) => {
                const next = { ...template, [lang]: e.target.value };
                if (!e.target.value && lang !== "en") delete next[lang];
                update(`message:${lang}`, { message: { template: next } });
              }}
            />
          </Row>
        ))
      )}
    </div>
  );
}
